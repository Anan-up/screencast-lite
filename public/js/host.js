/* ============================================================
   极简投屏 · 发送端传输逻辑（主机侧）
   ============================================================ */

(function (global) {
  'use strict';
  const { createSignal, buildIceServers, detectPathAsync, tuneSender, emitter } = global.Cast;

  /**
   * 主机传输器
   * - 每个观看端各自一条 RTCPeerConnection（点对点独立协商）
   * - 某条连接 6 秒内未连通，自动切到 WebSocket 中继
   *
   * @param {object} signal 信令通道
   * @param {function} getParams 返回当前编码参数 { bitrate, fps } 的 getter。
   *   必须由调用方（cast.html）注入，因为画质/帧率是**用户选择**，只有
   *   cast.html 知道。早期版本把 4_000_000/30 硬编码在 makePc 里，导致
   *   用户选了「流畅 1.5 Mbps」后**新加入**的大屏仍按 4 Mbps 起流 ——
   *   retune() 只作用于已存在的 peer，晚到的大屏永远错过。
   */
  function createHostTransport(signal, getParams) {
    const bus = emitter({});
    const DEBUG = new URLSearchParams(location.search).has('debug');
    let stream = null;
    const peers = new Map();   // viewerId -> { pc, state, mode, relayActive, timer }
    let turnCfg = null;
    // offer 世代号：每次 addViewer 递增，随 offer 带给大屏、大屏在 answer 里回显。
    // 用于丢弃"过期 answer"——优雅重连路径下同一 viewerId 会触发两次 addViewer，
    // 旧代 offer 的 answer 若晚到，会被错塞进新一代 pc（状态机被推进到稳定态，
    // 后续真 answer 的 setRemoteDescription 抛 InvalidStateError，链路永久卡协商）。
    // 快照 `const target = entry.pc` 防不住这个：target 拿到的就是**新** pc，
    // 旧 answer 仍会作用在它身上。必须靠世代号在入口处按序拒绝。
    let offerSeq = 0;

    // 兜底：调用方未注入时退回默认档（与 QUALITY.standard 一致）。
    // 用函数包一层而不是存常量，是为了每次建连都读**当下**的用户选择。
    const readParams = (typeof getParams === 'function')
      ? getParams
      : () => ({ bitrate: 4_000_000, fps: 30 });

    const RELAY_FALLBACK_MS = 6500;
    const DISCONNECT_GRACE_MS = 3000;   // disconnected 是可恢复瞬时态，给宽限期

  /**
   * 给中继分片加上 8 字节 viewerId 前缀。
   * 服务端据此定向转发——否则会把某个观看端的分片广播给房间里所有人，
   * 导致非中继端队列无限堆积（内存泄漏）以及跨端分片串流。
   */
  const RELAY_ID_LEN = 8;
  const idEncoder = new TextEncoder();
  function frame(viewerId, buf) {
    const id = String(viewerId || '').slice(0, RELAY_ID_LEN).padEnd(RELAY_ID_LEN, ' ');
    const out = new Uint8Array(RELAY_ID_LEN + buf.byteLength);
    out.set(idEncoder.encode(id), 0);
    out.set(new Uint8Array(buf), RELAY_ID_LEN);
    return out.buffer;
  }

  // ---- 共享中继编码器 ----
  // 绝不能给每个中继观看端各建一个 MediaRecorder：8 块大屏同时降级就是
  // 8 个 VP8/VP9 编码器并行跑同一条 MediaStream，中低端笔记本 CPU 直接打爆。
  // 正确做法是只跑一个编码器，同一份 WebM 分片按 viewerId 加前缀后分别下发。
  let sharedRecorder = null;
  let sharedMime = null;
  const relayViewers = new Set();   // 当前处于中继态的 viewerId

  function ensureSharedRecorder() {
    if (sharedRecorder) return sharedMime;
    const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
      .find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t));
    if (!mime) { const e = new Error('unsupported-mime'); e.code = 'unsupported-mime'; throw e; }
    sharedMime = mime;
    // 用**引用比较**而不是模块级布尔标记来判定"这个回调属于当前活跃的
    // 编码器吗"。原因：MediaRecorder.stop() 是异步的，会再触发一次
    // ondataavailable 尾包。若用全局布尔，会出现这种串台：
    //   停 A（标记=true）→ 起 B（标记复位=false）→ A 的尾包姗姗来迟
    //   → 读到 false，被误发给 B 当前的 viewer 集合。跨编码器的分片
    //   时间戳对不上，接收端解码器直接报错。
    // 引用比较天然免疫：A 的尾包发现 sharedRecorder 已不是自己，直接短路。
    const thisRec = new MediaRecorder(stream, {
      mimeType: mime,
      videoBitsPerSecond: 2_500_000,
    });
    sharedRecorder = thisRec;
    thisRec.ondataavailable = (e) => {
      if (sharedRecorder !== thisRec) return;        // 已被替换/停用
      if (!e.data || e.data.size === 0) return;
      if (relayViewers.size === 0) return;
      e.data.arrayBuffer().then((buf) => {
        if (sharedRecorder !== thisRec) return;      // 异步等待期间已被替换
        // 同一份数据，按各中继端 viewerId 加不同前缀
        for (const vid of relayViewers) {
          if (peers.has(vid)) signal.sendBinary(frame(vid, buf));
        }
      });
    };
    thisRec.onerror = () => bus.emit('relay-error', { viewerId: null });
    thisRec.start(120);   // 每 120ms 一片，保证可用延迟
    return mime;
  }

  function stopSharedRecorderIfIdle() {
    if (relayViewers.size > 0 || !sharedRecorder) return;
    retireSharedRecorder();
  }

  /**
   * 停用共享编码器并丢弃引用。
   *
   * 顺序很关键：**先置 null 再 stop()**。stop() 是异步的，先置 null 后，
   * 旧 recorder 的尾包回调一进来就会命中 `sharedRecorder !== thisRec`
   * 而短路——无论此刻新的 recorder 是否已经建立，旧数据都发不出去。
   */
  function retireSharedRecorder() {
    if (!sharedRecorder) return;
    const rec = sharedRecorder;
    sharedRecorder = null;
    sharedMime = null;
    try { if (rec.state !== 'inactive') rec.stop(); } catch {}
  }

    function setStream(s) { stream = s; }

    // 发送端"暂停推送"开关（cast.html 的 togglePause 驱动）。
    //
    // 为什么看门狗需要知道：暂停的实现是 `track.enabled = false`，视频轨停发
    // 新帧，接收端 framesDecoded 停止增长。而 view.html 的 viewer-status 是
    // **独立于暂停**的定时上报（PC 仍然 connected），所以 lastReport 持续刷新、
    // 不会被 REPORT_STALE_MS 那道豁免拦住。于是 15 秒后看门狗必然判定
    // "接收端长时间未解码到画面"→ enableRelay 强制切中继，且中继**不可逆**。
    // 用户只是暂停了一会儿，却永久损失了 P2P 直连（延迟 + 服务器带宽）。
    //
    // 用显式开关而不是让 host 去读 track.enabled：后者要遍历所有轨道且语义
    // 含糊（某条 track 被别的路径停掉时会误判）。暂停是**明确的 UI 意图**，
    // 就由 UI 明确告诉传输层。
    let pausedByUser = false;
    function setPaused(p) { pausedByUser = !!p; }

    /**
     * 移除一个观看端并释放其全部资源。
     * 定义为闭包函数（而非 bus 上的方法），这样 destroy() 等内部调用
     * 不依赖 this，解构调用也不会失效。
     */
    function removeViewer(viewerId) {
      // 先把 relayViewers 的清理提到早退之前，且**无条件**执行。
      //
      // relayViewers 是独立于 peers 的 Set，两者理论上同步（enableRelay 以
      // peers.has 为前置，peers.delete 在此处是唯一删除点）。但一旦某条路径
      // 让它们不同步——例如 id 已在 relayViewers 而 peers 条目先被别处删掉——
      // 早退就会让那个 id 永远留在 relayViewers 里，于是
      // stopSharedRecorderIfIdle() 永远认为"还有中继端"，共享 MediaRecorder
      // 持续编码、持续泄漏（8 块屏场景下 CPU 白烧）。
      // 删除是幂等的，提前无条件执行零成本，把"不同步"这个隐患彻底消掉。
      relayViewers.delete(viewerId);
      stopSharedRecorderIfIdle();

      const entry = peers.get(viewerId);
      if (!entry) return;
      clearTimeout(entry.fallbackTimer);
      clearTimeout(entry.disconnectTimer);
      clearInterval(entry.watchdog);
      try { entry.pc && entry.pc.close(); } catch {}
      peers.delete(viewerId);
      bus.emit('peer-removed', { viewerId });
    }

    function makePc(viewerId) {
      const iceServers = buildIceServers(turnCfg);
      const pc = new RTCPeerConnection({
        iceServers,
        iceCandidatePoolSize: 2,
        bundlePolicy: 'max-bundle',
      });

      const entry = peers.get(viewerId);
      entry.pc = pc;

      // 代际守卫：`peers.get(viewerId) !== entry` 表示这条 pc 所属的 entry 已被
      // 并发的 addViewer 顶掉（见 addViewer 顶部注释的 T0-T3 时序）。
      // 与 addViewer 里的 stale() 是同一个判据，这里单独定义是因为 makePc
      // 里拿不到 addViewer 的闭包。
      //
      // 为什么这些回调也要防：下面每个回调都会**副作用地**改写 entry.mode 或
      // 调用 enableRelay。若 entry 已被替换，这些副作用会落到**新**一代的健康
      // 连接上——最典型的是"旧 pc 的 failed 把新 pc 切成中继"。
      //
      // 漏网概率确实比 addViewer 那条低（removeViewer 里的 pc.close() 会把
      // connectionState 推到 'closed' 而非 'failed'，而下面的分支只认 'failed'），
      // 但既然已经建立了"代际校验"的心智模型，就全处统一，不留例外。
      const stalePc = () => peers.get(viewerId) !== entry;

      // 添加轨道
      // 编码参数取**当前**用户选择（每次建连都重新读，晚到的大屏也能吃到正确档位）。
      if (stream) {
        const params = readParams() || {};
        for (const track of stream.getTracks()) {
          const sender = pc.addTrack(track, stream);
          if (track.kind === 'video') {
            tuneSender(sender, {
              bitrate: params.bitrate,
              fps: params.fps,
            });
          }
        }
      }

      pc.onicecandidate = (e) => {
        if (e.candidate) {
          signal.send({ type: 'ice', viewerId, candidate: e.candidate.toJSON() });
        }
      };

      pc.onconnectionstatechange = () => {
        if (stalePc()) return;   // 旧代 pc 的状态变化不得落到新 entry 上
        const st = pc.connectionState;
        bus.emit('peer-state', { viewerId, state: st, mode: entry.mode });
        if (st === 'connected') {
          clearTimeout(entry.fallbackTimer);
          // 从 disconnected 恢复：撤销待降级计时器
          clearTimeout(entry.disconnectTimer);
          entry.disconnectTimer = null;
          // 不要用 SDP 粗判：只要配置了 TURN，本地 SDP 必然含 `typ relay`，
          // 粗判会稳定返回一个错误答案（紧接着被异步精判覆盖，UI 先闪错再纠正）。
          // 这里先给中性态，等 getStats() 的真实候选对出来再定。
          if (entry.mode === 'connecting') {
            entry.mode = 'p2p-pending';
            bus.emit('peer-connected', { viewerId, mode: 'p2p-pending' });
          }
          detectPathAsync(pc).then((accurate) => {
            // 代际校验：getStats() 是异步的，回调返回时这条 entry 可能已被并发的
            // addViewer 顶掉（entry_A 被 removeViewer、peers 换成 entry_B）。
            // 若不加守卫，旧代 pc 的候选对判定结果会被贴到新代连接上
            // （bus.emit('peer-connected') 让 cast.html 把 viewerMap 的 mode 写成
            // 旧代值），UI 显示一条与实际不符的链路标签。与同函数
            // onconnectionstatechange / oniceconnectionstatechange 保持一致。
            if (stalePc()) return;
            if (accurate && entry.mode !== 'relay' && entry.mode !== 'failed') {
              entry.mode = accurate;
              bus.emit('peer-connected', { viewerId, mode: accurate });
            }
          });
        }
        // failed：确定不可恢复，立即降级
        if (st === 'failed') {
          clearTimeout(entry.fallbackTimer);
          clearTimeout(entry.disconnectTimer);
          entry.disconnectTimer = null;
          if (entry.mode !== 'relay' && entry.mode !== 'failed') {
            enableRelay(viewerId, 'P2P 失败');
          }
        }
        // disconnected：按规范是可恢复的瞬时态，Chrome 里通常几秒就回到 connected。
        // 立即降级等于把一次网络抖动升级成不可逆的中继切换，必须给宽限期。
        if (st === 'disconnected') {
          if (entry.mode !== 'relay' && entry.mode !== 'failed' && !entry.disconnectTimer) {
            entry.disconnectTimer = setTimeout(() => {
              entry.disconnectTimer = null;
              if (entry.mode !== 'relay' && entry.mode !== 'failed' &&
                  pc.connectionState === 'disconnected') {
                enableRelay(viewerId, 'P2P 连接中断');
              }
            }, DISCONNECT_GRACE_MS);
          }
        }
      };

      pc.oniceconnectionstatechange = () => {
        if (stalePc()) return;   // 同上：旧代不得触发降级
        // ICE 层 failed 可信度高，立即降级
        if (pc.iceConnectionState === 'failed' && entry.mode !== 'relay' && entry.mode !== 'failed') {
          enableRelay(viewerId, 'ICE 协商失败');
        }
      };

      // ---- 链路存活看门狗 ----
      // 设计要点：不能只看发送端 framesEncoded / bytesSent —— 采集静止桌面时
      // 编码器可能长时间不出任何数据，那样会把健康的低延迟 P2P 连接误判为失效。
      //
      // 权威信号来自接收端：它定期回报 stats.framesDecoded（真实解出的帧数）。
      // 只有在"接收端仍在回报、且连续多轮解码帧数不增长"时才判定链路真的死了。
      //
      // ⚠️ 两个必须同时成立的守卫，缺一不可：
      //   1) 静止画面下 framesDecoded 本来就不涨 → 阈值放宽到 15 秒；
      //   2) 观看端切到后台后被 Chrome/Safari 节流到分钟级 → **报告停止**。
      //      此时 decodedGrew 会永久定格在上一次取值。若恰好定格为 false，
      //      stalledSince 就会一路累积、15 秒后误杀健康 P2P。
      //      所以必须用 lastReport 判断"报告是否还在来"：报告停了就**跳过本轮，
      //      既不累计也不触发**（注意：是"没报告就不判"，不是"没报告就降级"）。
      // 真实掉线由 pc.connectionState / iceConnectionState 变更直接覆盖。
      const REPORT_STALE_MS = 30000;
      entry.liveness = {
        lastDecoded: -1,
        lastReport: 0,
        stalledSince: 0,
        // 必须显式初始化：onViewerStatus 会写它，但看门狗可能先于第一次
        // 回报读到它。留 undefined 会让 `if (L.decodedGrew)` 走进 else 分支，
        // 在毫无依据的情况下开始累计 stalledSince（当前该顺序恰好不会发生，
        // 但依赖"回调时序"是脆弱写法）。
        decodedGrew: false,
      };
      entry.watchdog = setInterval(() => {
        if (entry.mode === 'relay' || entry.mode === 'failed') {
          clearInterval(entry.watchdog);
          return;
        }
        if (!entry.pc || entry.pc.connectionState !== 'connected') {
          entry.liveness.stalledSince = 0;
          return;
        }
        const L = entry.liveness;

        // 用户主动暂停（见 setPaused）：解码帧数必然不增长，这是**预期行为**
        // 而非链路故障。跳过本轮并清掉累计起点 —— 若不清，暂停 15 秒后
        // 恢复推送时 stalledSince 已是个很旧的时刻，下一次判定会立刻触发。
        if (pausedByUser) {
          L.stalledSince = 0;
          return;
        }

        // 接收端还没回报过（刚连上），继续等待
        if (L.lastDecoded < 0) return;

        // 报告被节流 / 中断：无法判断是否停滞 —— 跳过本轮，不累计也不触发
        if (Date.now() - L.lastReport > REPORT_STALE_MS) {
          L.stalledSince = 0;
          return;
        }

        if (L.decodedGrew) {
          L.stalledSince = 0;                       // 接收端仍在解码 => 健康
        } else {
          if (!L.stalledSince) L.stalledSince = Date.now();
          // 静止画面下解码帧数也会停止增长，因此阈值放宽到 15 秒
          if (Date.now() - L.stalledSince > 15000) {
            // 代际校验：这个 interval 可能挂着时 entry 已被并发的 addViewer 顶掉。
            // 旧代的 watchdog 去 enableRelay 会误切新连接；而 clearInterval 用的
            // 是**旧** entry.watchdog，也清不掉新一代的定时器，会留下一个
            // 永远指向已废弃 entry 的 interval（每 1.5s 空转一次）。
            // 必须先清掉**自己**这个 interval，再判断是否还要降级。
            clearInterval(entry.watchdog);
            if (peers.get(viewerId) !== entry) return;
            enableRelay(viewerId, '接收端长时间未解码到画面');
          }
        }
      }, 1500);

      return pc;
    }

    /**
     * 开启这条观看端的中继：把画面经 WebSocket 二进制帧推给服务端。
     * 编码器是所有中继端共享的（见 ensureSharedRecorder），这里只登记成员。
     */
    async function enableRelay(viewerId, reason) {
      const entry = peers.get(viewerId);
      if (!entry || entry.mode === 'relay' || entry.mode === 'failed') return;

      // 先把 pc 拆掉：中继不再需要它
      clearInterval(entry.watchdog);
      clearTimeout(entry.fallbackTimer);
      clearTimeout(entry.disconnectTimer);
      entry.disconnectTimer = null;
      entry.relayReason = reason;
      try { entry.pc && entry.pc.close(); } catch {}
      entry.pc = null;

      // 失败时必须落到 'failed' 而不是停在 'relay'：
      // 停在 'relay' 会让发送端 UI 误标"服务器中转"（实际一个分片都没发），
      // 而且上面的 === 'relay' 判重会让这条链路再也没法重试。
      const fail = (r) => {
        entry.mode = 'failed';
        relayViewers.delete(viewerId);
        stopSharedRecorderIfIdle();
        bus.emit('peer-mode', { viewerId, mode: 'failed', reason: r });
        signal.send({ type: 'relay-failed', viewerId, reason: r });
        bus.emit('relay-unsupported', { viewerId, reason: r });
      };

      // stream 已失效（用户中途停止了采集）时也必须回信，否则观看端
      // 只知道 connectionState 变 failed，永远等不到 relay-begin，
      // 会一直卡在"直连失败，尝试切换链路…"
      if (!stream || stream.getVideoTracks().every((t) => t.readyState === 'ended')) {
        fail('stream-gone');
        return;
      }

      let mime;
      try {
        mime = ensureSharedRecorder();     // 共享编码器，只有第一个中继端会真正创建
      } catch (e) {
        fail('unsupported-mime');
        return;
      }

      entry.mode = 'relay';
      entry.relayActive = true;
      relayViewers.add(viewerId);
      bus.emit('peer-mode', { viewerId, mode: 'relay', reason });

      // 关键：必须先通知观看端准备中继播放（建立 MediaSource），
      // 否则后续二进制分片到达时接收端还没有可写的 SourceBuffer。
      signal.send({
        type: 'relay-begin',
        viewerId,
        mime,
        reason,
      });

      bus.emit('peer-relay-start', { viewerId, mime });
    }

    // 中继模式下接收观看端回传的控制指令（预留，当前协议尚未启用）

    // 用 Object.assign 逐项挂载，保留 emitter 的 on/emit 引用。
    // 注意不要写 `return bus.__proto__ = {...bus, ...}`：那会改写 bus 的原型
    // 并返回一个与 bus 不同的对象，两者状态虽因闭包共享 map 而碰巧一致，
    // 但任何挂在 bus 上的普通属性都会失同步，是极危险的写法。
    Object.assign(bus, {
      setStream,

      setPaused,

      setTurn(t) { turnCfg = t; },

      /** 新观看端加入 → 建立一条连接并发起 offer */
      async addViewer(viewerId) {
        // 已存在同 id：说明是"大屏主动重建连接"（服务端复用了原 viewerId）。
        // 此时旧 PeerConnection 已经废了，必须先把它的资源收干净再重建，
        // 否则直接 return 会让大屏永远等不到新的 offer（画面冻结）。
        if (peers.has(viewerId)) removeViewer(viewerId);
        const entry = { pc: null, mode: 'connecting', relayActive: false };
        entry.seq = ++offerSeq;   // 本代 offer 的世代号，onAnswer 据此丢弃过期 answer
        peers.set(viewerId, entry);

        const pc = makePc(viewerId);

        // ---- 代际校验（与 viewer.js#onOffer 完全对称的防护） ----
        //
        // 本函数是 **async**，但调用点是**不 await** 的（cast.html 里
        // `host.addViewer(m.viewerId)`）。同一个 viewerId 在极短时间内
        // 被调用两次就会并发，第二条会把第一条刚放进去的 entry 顶掉：
        //
        //   T0  addViewer#1: peers.set(V1, entry_A); await pc_A.createOffer() 挂起
        //   T1  addViewer#2: peers.has(V1) → removeViewer(V1)（close 掉 pc_A）
        //                    peers.set(V1, entry_B); await pc_B.createOffer() 挂起
        //   T2  addViewer#1 恢复: pc_A.setLocalDescription() ← pc_A 已 close，抛错
        //       → catch → enableRelay(V1) 里 peers.get(V1) 拿到的是 **entry_B**
        //       → 把本该 P2P 直连的健康新连接误切到服务器中继
        //   T3  addViewer#2 恢复: pc_B 也已被 T2 的 enableRelay 关闭 → 同样落 catch
        //
        // 触发源是 README「已知冗余」记录的优雅重连路径，**每次都会**产生两条
        // viewer-joined：服务端 createRoom 复用时补发一条（rejoined: true），
        // 大屏收到 host-return 后主动 doJoin 又触发一条。两条是否真正并发取决于
        // 本地 createOffer() 与那一圈信令往返谁快 —— 通常 createOffer 更快，
        // 但主机页面主线程忙碌时就会反转。所以必须防护，不能靠时序侥幸。
        //
        // 校验语义：`peers.get(viewerId) !== entry` 为真即表示"本代已被弃用"。
        // 弃子链路要**静默退出**，绝不 enableRelay —— 它抛的错不是真错误。
        const stale = () => peers.get(viewerId) !== entry;

        try {
          const offer = await pc.createOffer({
            offerToReceiveVideo: false,
            offerToReceiveAudio: false,
          });
          if (stale()) return;

          await pc.setLocalDescription(offer);
          if (stale()) return;

          signal.send({ type: 'offer', viewerId, sdp: pc.localDescription, seq: entry.seq });
        } catch (e) {
          // 弃子连接抛错不是真错误，不该触发降级（见上方 T2 步）。
          if (stale()) return;
          enableRelay(viewerId, '创建 offer 失败');
          return;
        }

        // 超时兜底：还没连上就走中继
        entry.fallbackTimer = setTimeout(() => {
          // 同样的代际校验：定时器可能挂着时 entry 已被替换。
          if (stale()) return;
          if (entry.mode !== 'relay' && entry.mode !== 'failed' && pc.connectionState !== 'connected') {
            enableRelay(viewerId, 'P2P 超时未连通');
          }
        }, RELAY_FALLBACK_MS);

        bus.emit('peer-created', { viewerId });
      },

      /** 处理观看端 answer */
      async onAnswer(viewerId, sdp, seq) {
        const entry = peers.get(viewerId);
        if (!entry || !entry.pc) return;
        // 世代号校验：answer 必须回显**当前代** offer 的 seq。优雅重连路径下
        // 同一 viewerId 会连发两次 addViewer，旧代 answer 可能晚到 —— 若不拒绝，
        // 它会把新一代 pc 从 'have-local-offer' 推进到 'stable'，后续真 answer 的
        // setRemoteDescription 抛 InvalidStateError（被 catch 吞掉），链路永久卡在
        // 协商中（大屏看似一直 connecting）。seq 缺省（老协议/服务端旧版本）时
        // 不回退拒绝，保持向后兼容。
        if (seq != null && entry.seq !== seq) return;
        try {
          await entry.pc.setRemoteDescription(new RTCSessionDescription(sdp));
        } catch (e) {
          console.warn('setRemoteDescription 失败', e);
        }
      },

      /** 处理观看端 ICE */
      async onIce(viewerId, candidate) {
        const entry = peers.get(viewerId);
        if (!entry || !entry.pc || !candidate) return;
        // ⚠️ 与 viewer.js#onIce **同源**的时序问题，此处同样**未解决**。
        //
        // 从 `peers.get(viewerId)` 到 `entry.pc.addIceCandidate(...)` 之间
        // **没有 await**（下述 await 在它之后），所以 entry.pc 就是"消息到达
        // 那一刻的 pc" —— 加不加中间变量快照，行为完全一致。快照在这里
        // 同样是**防御性的零行为变更**，不要误以为竞态已被处理。
        //
        // 真正未解决的时序：大屏离开后**极短时间内**（同一 viewerId）又回来
        // （用户网络抖动中手速快，或服务端 viewer-left 与 viewer-joined
        // 挤在同一个 TCP 段到达）：
        //   t2  addViewer 重建 → 旧 PC_A 被 close()、peers 换成 entry_B
        //   t3  PC_A 的**尾批**候选到达（close() 只取消后续生成，
        //       已在服务端排队/转发的候选不会被召回）
        //       → entry.pc 是 PC_B → 候选加到新 PC 上
        //
        // 影响：sdpMid/sdpMLineIndex 不匹配，Chrome 直接忽略或抛
        // OperationError（被下面的 catch 吞掉）。新 offer 会带来完整的新候选集，
        // 丢几条旧候选最坏只是"打洞稍慢"，不会崩、不会画面冻结 —— **可接受**。
        // 要彻底消除需协议层加世代号（host 发 ice 时带 gen，接收端只在
        // gen 匹配时加），成本是协议加字段 + 服务端透传，收益不成比例，故不做。
        try {
          await entry.pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch { /* 候选乱序 / 加到已废弃 PC 时忽略 */ }
      },

      /** 观看端状态回报：用于更新链路存活的权威依据 */
      onViewerStatus(payload) {
        const entry = peers.get(payload && payload.viewerId);
        // 只在 P2P 阶段维护 liveness。进入 relay/failed 后看门狗已被
        // clearInterval，继续写这些字段没有消费者，纯属多余状态更新
        // （也让 `entry.liveness` 的语义变得含糊："最后一次 P2P 判定"还是"当前状态"）。
        const p2pActive = entry && entry.mode !== 'relay' && entry.mode !== 'failed';
        if (p2pActive && entry.liveness) {
          const L = entry.liveness;
          const now = payload.framesDecoded;
          if (now != null) {
            L.decodedGrew = L.lastDecoded >= 0 && now > L.lastDecoded;
            L.lastDecoded = now;
          }
          // 无论这次是否带 framesDecoded，都算"报告还在来"
          L.lastReport = Date.now();
        }
        bus.emit('viewer-status', payload);
      },

      removeViewer,

      /**
       * 清空所有观看端连接，但保留已采集的 stream 与 turn 配置。
       *
       * 用于信令断线重连场景：服务端已 destroyRoom，房间里的大屏全部失联，
       * 传输层却仍持有这些 peer —— 不清理的话旧 viewerId 会永远挂在 peers 里，
       * 等旧大屏自动回归（复用同一房间码）时与新 id 叠加，统计长期虚高。
       *
       * 与 destroy() 的区别**不在于是否停流**（两者都不停本地媒体流，真正停流
       * 的是 cast.html#endSession 里对 stream.getTracks() 的那段独立清理），
       * 而在于对共享中继编码器的处置：
       *   - reset() 只逐条 removeViewer（幂等）+ stopSharedRecorderIfIdle()，
       *     空闲才停、sharedRecorder 引用保留，便于重连后复用；
       *   - destroy() 额外 peers.clear() + retireSharedRecorder()（强制停止并
       *     置空 sharedRecorder/sharedMime），是彻底的传输层销毁。
       */
      reset() {
        for (const id of [...peers.keys()]) removeViewer(id);
        relayViewers.clear();
        stopSharedRecorderIfIdle();
      },

      /** 更新所有连接的编码参数（画质切换用） */
      async retune(bitrate, fps) {
        for (const [, entry] of peers) {
          if (!entry.pc) continue;
          for (const sender of entry.pc.getSenders()) {
            if (sender.track && sender.track.kind === 'video') {
              await tuneSender(sender, { bitrate, fps });
            }
          }
        }
      },

      getPeers() { return peers; },

      destroy() {
        // 用闭包里的 removeViewer，而不是 this.removeViewer：
        // host 本身就是 bus，正常调用没问题，但一旦有人解构
        // `const { destroy } = host; destroy()`，this 就不是 bus 了，
        // 会静默失效。闭包引用没有这个隐患。
        for (const id of [...peers.keys()]) removeViewer(id);
        peers.clear();
        relayViewers.clear();
        retireSharedRecorder();
      },
    });

    // getter 不能用 Object.assign 挂载：那会把 getter 求值一次后按定值复制，
    // stats 将永远返回挂载瞬间的快照。必须用 defineProperties。
    Object.defineProperties(bus, {
      stats: {
        configurable: true,
        get() {
          const out = { total: peers.size, p2p: 0, relay: 0, connecting: 0, failed: 0 };
          for (const [, e] of peers) {
            // p2p-relay 是"经 TURN 中转的 P2P"：gradePath() 把它标为
            // 「TURN 中转」/ tone: warn，cast.html 的 updateModeTag() 也把它
            // 归入 hasRelay（那边修过同一个历史 bug，注释里写明"早期它落进
            // else 分支被聚合成 P2P 直连，与单条链路的标签自相矛盾"）。
            // 这里若也落进 else 被算成 p2p，与那两处自相矛盾。
            if (e.mode === 'relay' || e.mode === 'p2p-relay') out.relay++;
            else if (e.mode === 'failed') out.failed++;
            else if (e.mode === 'connecting' || e.mode === 'p2p-pending') out.connecting++;
            else out.p2p++;
          }
          return out;
        },
      },
      // 调试把手：当前在线大屏的 viewerId 列表。
      // 主要用于自动化测试断言"幽灵条目是否残留"——聚合计数无法区分
      // "1 台老设备"和"1 台幽灵"，必须看 id 集合。仅 ?debug=1 时有值。
      peerIds: {
        configurable: true,
        get() { return DEBUG ? [...peers.keys()] : null; },
      },
      // 调试把手：viewerId → mode 的只读映射。
      // 用途：并发 addViewer 的回归用例必须能读到**最终** mode，判断
      // 健康连接是否被误降级成 'relay'；stats 只有聚合计数，分不出是谁。
      // 返回的是**新对象**（每次 get 重建），调用方改它不影响内部 peers。
      peerModes: {
        configurable: true,
        get() {
          if (!DEBUG) return null;
          const out = {};
          for (const [id, e] of peers) out[id] = e.mode;
          return out;
        },
      },
    });

    // 方法型调试把手必须走 Object.assign —— 不能放进上面的 defineProperties：
    // defineProperties 只认描述符对象（get/set/value/...），直接写
    // `forceStall: (x) => ...` 会被当成一个"缺少 value/get 的描述符"而
    // **静默忽略**（不报错、属性不存在），是很容易踩的坑。
    if (DEBUG) {
      Object.assign(bus, {
        // 把某条 peer 的 liveness 直接置于"停滞"状态。
        //
        // 与 view.html 的 `__rejoin.forceStale()` 同构：看门狗的触发阈值是
        // 15 秒真实时间，端到端等它会让用例慢到不可用（而且"等了 17 秒没触发"
        // 无法区分"阈值没跨过"与"逻辑被跳过"）。把 stalledSince 推到 s 秒前，
        // 就能在 1.5 秒内观察到结果。
        //
        // ⚠️ 只改 liveness 的时间戳，**不改** mode、不碰 pc —— 这样被测的
        // 仍是真实的看门狗判定逻辑，而不是绕过它的假路径。
        forceStall(viewerId, secondsAgo) {
          const e = peers.get(viewerId);
          if (!e || !e.liveness) return false;
          const s = Math.max(1, secondsAgo || 20);
          e.liveness.lastReport = Date.now();      // 报告"新鲜"，避开节流豁免
          e.liveness.stalledSince = Date.now() - s * 1000;
          return true;
        },
        /** 读某条 peer 的 liveness（断言用） */
        peerLiveness(viewerId) {
          const e = peers.get(viewerId);
          if (!e || !e.liveness) return null;
          const L = e.liveness;
          return {
            lastDecoded: L.lastDecoded,
            lastReport: L.lastReport,
            stalledSince: L.stalledSince,
            decodedGrew: L.decodedGrew,
          };
        },
        /** 读某条 peer 的 pc.connectionState（断言用；等 connected 需要它） */
        peerState(viewerId) {
          const e = peers.get(viewerId);
          return e && e.pc ? e.pc.connectionState : null;
        },
      });
    }

    return bus;
  }

  global.Cast.createHostTransport = createHostTransport;
})(window);
