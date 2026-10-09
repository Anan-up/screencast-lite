/* ============================================================
   极简投屏 · 接收端传输逻辑（观看侧）
   ============================================================ */

(function (global) {
  'use strict';
  const { createSignal, buildIceServers, detectPathAsync, emitter } = global.Cast;

  /**
   * 观看端传输器
   * - 收到 offer → 应答 answer，走标准 P2P
   * - 若主机侧判定 P2P 不通，会收到 relay-begin，此时改走 MediaSource 播放 WebM 分片
   */
  function createViewerTransport(signal) {
    const bus = emitter({});
    let pc = null;
    let turnCfg = null;
    let mode = 'connecting';

    // ---- 中继播放：把 WebM 分片喂进 MediaSource ----
    let mediaSource = null;
    let sourceBuffer = null;
    let queue = [];
    let videoEl = null;
    let mimeType = null;
    let currentUrl = null;   // 当前 video 元素持有的 ObjectURL，切换/销毁时需释放

    // 降级模式（relay-blob）的分片攒存buffer。
    // 声明必须放在 onRelayChunk 之前 —— 虽然函数体是惰性求值、TDZ 侥幸不会触发，
    // 但依赖"调用时机晚于声明"本身就是脆弱写法。
    let blobParts = [];
    let blobTimer = null;

    // 中继模式本地帧率统计的采样基准（见 localStats）
    let lastQualityFrames = null;
    let lastQualityAt = 0;

    function startRelayPlayback(mime) {
      if (!videoEl) return;
      mimeType = mime || 'video/webm;codecs=vp8';
      if (!('MediaSource' in window) || !MediaSource.isTypeSupported(mimeType)) {
        // 回退：把分片攒成 Blob 后整体播放（延迟较高但总比黑屏好）。
        // 注意：MediaSource 支持与否由浏览器/编解码器能力决定，运行期不会变化，
        // 所以这里一旦降到 relay-blob 就没有、也不需要"升级回 relay"的路径。
        //
        // 清空 queue：正常流程下走到这里 queue 应该是空的（MediaSource 从未建过），
        // 但存在一条会留下残渣的路径：
        //   - 某些实现下 isTypeSupported 可能在 'relay' 已跑过一轮后翻脸返回 false。
        // 不清的话这些分片既不会被消费（blob 分支只认 blobParts），
        // 又会一直占着内存，且下次真正切到 blob 时可能混入不同 mime 的数据。
        //
        // 注：早期这里还列过一条 `relay-begin 与 relay-mime 是两条独立消息，
        // 若 host 因竞态重发` —— 那在**当前协议下不存在**：服务端转发白名单
        // 不含 relay-mime，host 也从不单独发它（mime 只随 relay-begin 带过来）。
        // 本函数确实会被重复调用（relay-begin handler 每次都会重建 vx 再调它），
        // 但清空 queue 的理由是上面那条，与"两条消息"无关。
        queue = [];
        blobParts = [];
        mode = 'relay-blob';
        bus.emit('relay-mode', { mode, degraded: true });
        return;
      }
      mediaSource = new MediaSource();
      if (currentUrl) { try { URL.revokeObjectURL(currentUrl); } catch {} }
      currentUrl = URL.createObjectURL(mediaSource);
      videoEl.src = currentUrl;
      mediaSource.addEventListener('sourceopen', () => {
        try {
          sourceBuffer = mediaSource.addSourceBuffer(mimeType);
          sourceBuffer.mode = 'sequence';
          sourceBuffer.addEventListener('updateend', flush);
          flush();
        } catch (e) {
          // addSourceBuffer 失败：isTypeSupported 通过并不保证 SourceBuffer
          // 真能建出来（编解码器被运行时禁用、MSE 实例状态异常等）。
          // 若只报错不处理：sourceBuffer 恒 null → flush() 永远早退 →
          // queue 堆到 120 封顶，用户面对"两条横幅 + 永久黑屏"。
          // 出路与 isTypeSupported=false 相同：降级 relay-blob 接手。
          // 注意把 relay 期间已到达的分片（在 queue 里）一并移交，不丢数据。
          mediaSource = null;
          sourceBuffer = null;
          blobParts = queue;
          queue = [];
          mode = 'relay-blob';
          bus.emit('relay-error', e);
          // 再发一次 relay-mode(degraded)：startRelayPlayback 已经发过
          // degraded=false，view.html 据此走过 goLive；这里补发保证
          // "日志/横幅能反映降级事实"，也让 goLive 幂等地再走一次。
          bus.emit('relay-mode', { mode, degraded: true });
          scheduleBlobPlay();
        }
      });
      mode = 'relay';
      bus.emit('relay-mode', { mode, degraded: false });
    }

    function flush() {
      if (!sourceBuffer || sourceBuffer.updating || queue.length === 0) return;

      // 先取队首但不出队：appendBuffer 抛 QuotaExceededError 时
      // 必须把这个分片保留在队列里，否则会持续丢帧导致花屏 / 时间戳断裂
      const buf = queue[0];
      let appended = false;
      try {
        sourceBuffer.appendBuffer(buf);
        appended = true;
      } catch (e) {
        // 缓冲区满：清掉已播放的部分，本分片留待下一次 updateend 重试
        try {
          if (sourceBuffer.buffered.length) {
            const now = videoEl.currentTime;
            if (now > 2) sourceBuffer.remove(0, now - 2);
          }
        } catch {}
      }
      if (appended) queue.shift();

      // 队列过长说明消费跟不上（接收端卡顿），丢最旧的以免无限增长
      if (queue.length > 120) queue.splice(0, queue.length - 120);

      // 追赶：让播放头贴近最新数据，压低延迟
      try {
        if (mediaSource && mediaSource.buffered.length) {
          const end = mediaSource.buffered.end(mediaSource.buffered.length - 1);
          if (end - videoEl.currentTime > 1.4) {
            videoEl.currentTime = end - 0.25;
          }
        }
      } catch {}
    }

    function onRelayChunk(buf) {
      // 不在中继模式时直接丢弃：否则分片会在 queue 里无限堆积（内存泄漏）。
      // 正常流程下服务端已按 viewerId 定向转发，这里再兜一层防御。
      if (mode !== 'relay' && mode !== 'relay-blob') return;

      if (mode === 'relay-blob') {
        blobParts.push(buf);
        scheduleBlobPlay();
        return;
      }
      queue.push(buf);
      flush();
    }

    // 降级模式：攒 1 秒分片合成一个可播放 Blob
    function scheduleBlobPlay() {
      // ⚠️ 已有挂起定时器时直接返回，绝不能 clearTimeout 后重排。
      //
      // 分片每 120ms 到达一个（host 端 MediaRecorder.start(120)），旧实现
      // "每次都 clearTimeout(blobTimer) 再 setTimeout(1000)"意味着：只要
      // 分片间隔（120ms）< 定时延迟（1000ms），定时器就**永远到不了点**
      // —— blobParts 无限堆积、videoEl.src 永不设置，用户看到的是
      // "推流正常却永久黑屏"，直到发送端停下来超过 1 秒。
      if (blobTimer) return;
      blobTimer = setTimeout(() => {
        blobTimer = null;   // 先清引用：既放行后续分片重新排程，也让 destroy 后不留悬空 id
        if (!videoEl || blobParts.length === 0) return;
        const blob = new Blob(blobParts, { type: mimeType || 'video/webm' });
        blobParts = [];
        const url = URL.createObjectURL(blob);
        const prev = currentUrl;
        currentUrl = url;
        videoEl.src = url;
        videoEl.play().catch(() => {});
        if (prev) setTimeout(() => { try { URL.revokeObjectURL(prev); } catch {} }, 3000);
      }, 1000);
    }

    // 用 Object.assign 挂载方法与普通属性。
    // ⚠️ 绝不能把 getter 放进 Object.assign：它会把 getter **求值一次**后按定值复制，
    // 结果 mode/pc 被永久冻结在挂载瞬间的取值（mode 永远停在 'connecting'）。
    // 这正是 core.js 里 createSignal 踩过的同一个坑，必须用 defineProperties。
    Object.assign(bus, {
      attachVideo(el) { videoEl = el; },

      setTurn(t) { turnCfg = t; },

      /** 收到主机 offer */
      async onOffer(sdp, viewerId, seq) {
        // 中继模式下主机不会发 offer，这里必然是新 P2P 尝试
        if (pc) { try { pc.close(); } catch {} }
        // 显式置 null 再建新 PC。
        //
        // 说清楚它**不是**什么（避免重蹈上一版注释的覆辙）：
        //   从这一行到下文的 `pc = p`，中间只有 `new RTCPeerConnection(...)`
        //   一次**同步**调用。JS 单线程模型保证这段区间内没有其他任务能插入，
        //   所以不存在"onIce 在窗口内看到 null 而早退"这回事 —— 它既不会让谁
        //   看到 null，也不构成对 t3 时序（旧候选加到新 PC）的防护。
        //
        // 保留它的真实原因只有一条：**异常路径**。若 `new RTCPeerConnection`
        // 抛错（例如构造参数非法 / 资源耗尽），pc 保持 null 比继续指向那个
        // 已 close() 的旧实例更诚实 —— 后续 onIce/report/connectionState 回调
        // 都会因此早退，而不是去操作一个已废弃的对象。
        // 代价为零（一次赋值），收益是失败态更干净。
        pc = null;

        // 复位 mode：onOffer 是**独立于 destroy() 的路径**（主机重新 addViewer
        // 后直接发 offer，大屏不会经过 destroy）。若不复位，旧会话残留的
        // 'p2p-host'/'relay'/'relay-blob' 会：
        //   - 让新 PC 连通时 `if (mode === 'connecting')` 为假 → 不发 p2p-pending，
        //     HUD 标签停在旧值直到 detectPathAsync 返回；
        //   - 更糟：残留 'relay'/'relay-blob' 会让 detectPathAsync 回调里的
        //     `mode !== 'relay'` 判定为假而**不更新**，且 view.html 的
        //     scheduleRejoin "决策 1"（中继模式下撤销 P2P 重建）据此撤销本该
        //     执行的重建 —— 中继→重连 P2P 的路径被永久卡在 'relay'。
        mode = 'connecting';

        // ⚠️ 必须用**局部** p 而不是直接赋给模块级 pc。
        //
        // 这是一条重入路径：两次 offer 到达时（README「已知冗余」记录的双 offer
        // 往返就是典型触发源），第二次调用会 close 掉第一次正在协商的 A 并让
        // `pc` 指向 B。此时 A 那条链路的 await 恢复后，若代码里写的是 `pc.xxx`，
        // 操作的其实是 **B** —— createAnswer/setLocalDescription 被应用到
        // remoteDescription 尚未设置的 B 上，抛 InvalidStateError，
        // 且 A 的 answer 永远发不出去（大屏卡在 connecting）。
        // 用局部 p + 每个 await 后校验 `pc === p`，可让被打断的那条安静退出。
        const p = new RTCPeerConnection({
          iceServers: buildIceServers(turnCfg),
          bundlePolicy: 'max-bundle',
        });
        pc = p;

        p.ontrack = (e) => {
          bus.emit('track', e.streams[0] || new MediaStream([e.track]));
        };

        p.onicecandidate = (e) => {
          if (e.candidate) signal.send({ type: 'ice', candidate: e.candidate.toJSON() });
        };

        p.onconnectionstatechange = () => {
          // destroy() 里会 pc = null 并 close()。虽然浏览器实际行为多是
          // close 后不再派发事件，但规范没保证，这里加守卫避免 TypeError。
          if (!pc) return;
          // 已被更新的 offer 顶替：本连接是弃子，其状态不反映当前链路，
          // 继续上报会让 UI 在两条连接间来回抖动。
          if (pc !== p) return;
          bus.emit('state', p.connectionState);
          if (p.connectionState === 'connected') {
            // 与主机侧一致：不用 SDP 粗判（配了 TURN 时必然误报 relay），
            // 先给中性态，等真实候选对判定结果
            if (mode === 'connecting') {
              mode = 'p2p-pending';
              bus.emit('connected', { mode });
            }
            detectPathAsync(p).then((accurate) => {
              // 异步精判回来时可能已被顶替/切中继，需重新校验
              if (pc !== p) return;
              if (accurate && mode !== 'relay' && mode !== 'relay-blob') {
                mode = accurate;
                bus.emit('connected', { mode: accurate });
              }
            });
          } else if (p.connectionState === 'failed') {
            bus.emit('failed');
          }
        };

        try {
          await p.setRemoteDescription(new RTCSessionDescription(sdp));
          if (pc !== p) return;                    // 已被后到的 offer 顶替，弃子退出
          const answer = await p.createAnswer();
          if (pc !== p) return;
          await p.setLocalDescription(answer);
          if (pc !== p) return;
          signal.send({ type: 'answer', sdp: p.localDescription, viewerId, seq });
        } catch (e) {
          // 弃子连接抛出的错不是真错误，不该上报
          if (pc === p) bus.emit('error', e);
        }
      },

      async onIce(candidate) {
        if (!pc || !candidate) return;
        // 快照当前 PC 引用。
        //
        // ⚠️ 必须说清楚这个快照**能**和**不能**防什么，否则容易误以为竞态已解决：
        //
        //   能防：本函数内部 `await` 期间 pc 被替换 —— await 在快照之后，
        //         快照后 target 恒定，替换影响不到它。
        //   **不能**防：消息**到达之前** pc 已被新 offer 替换。
        //         因为 `signal.on('ice', (m) => vx.onIce(m.candidate))` 是
        //         同步入口，从消息到达、到 `const target = pc` 之间没有任何
        //         await，target 拿到的就是"到达那一刻的 pc" —— 这与不加快照
        //         的行为完全一致（改动前 `pc.addIceCandidate` 读的也是同一时刻
        //         的 pc）。换句话说，快照在这里是**防御性的零行为变更**，
        //         而不是对下述时序的修复。
        //
        // 真正未解决的时序（README「已知冗余」的双 offer 往返）：
        //   t2  offer #2 到达 → onOffer 关闭 PC_A、pc = PC_B
        //   t3  PC_A 的**尾批**候选到达（close() 只取消后续生成，
        //       已在网络上/已由服务端转发的候选不会消失）→ target = PC_B → 加错
        // 要彻底消除 t3，需要协议层带世代号（host 在 ice 消息里带 gen，
        // viewer 仅在 gen === 当前世代时才加），成本是协议加一个字段 +
        // 服务端透传。当前**不做**，理由见下面的代价评估。
        //
        // 代价评估（为何可接受）：加错的候选因 sdpMid/sdpMLineIndex 不匹配，
        // Chrome 会直接忽略或抛 OperationError（被 catch 吞掉）；而新 offer
        // 会带来**完整的新候选集**，丢几条旧候选不会导致连接失败。
        // 最坏情况是"打洞稍慢"，不会崩、不会画面冻结。
        const target = pc;
        try { await target.addIceCandidate(new RTCIceCandidate(candidate)); } catch {}
      },

      onRelayChunk,

      startRelayPlayback,

      /**
       * 中继模式下的本地统计。
       *
       * 中继走的是「WebM 分片 → MediaSource」这条纯播放路径，没有 RTCPeerConnection，
       * 因此拿不到 getStats() 的 rtt/framesPerSecond。但分辨率与帧率是可以从
       * <video> 元素本身推出来的：
       *   - 分辨率：videoWidth/videoHeight（解码后的实际画面尺寸）
       *   - 帧率：getVideoPlaybackQuality().totalVideoFrames 在两次采样间的差分
       *
       * RTT 无从获取（分片转发不产生往返时延测量），恒为 null —— HUD 显示「—」。
       * 这是诚实的：中继模式下本来就没有可观测的链路 RTT。
       */
      localStats() {
        const out = { res: null, fps: null, rtt: null, local: true };
        if (!videoEl) return out;
        const w = videoEl.videoWidth, h = videoEl.videoHeight;
        if (w && h) out.res = `${w}×${h}`;

        // 帧率差分：只在能拿到 totalVideoFrames 时计算（Chromium/Firefox 支持，
        // 老 Safari 没有该方法 → 退回用 currentTime 推进速率粗略估算）。
        const now = Date.now();
        if (typeof videoEl.getVideoPlaybackQuality === 'function') {
          const q = videoEl.getVideoPlaybackQuality();
          const total = q.totalVideoFrames;
          if (lastQualityFrames != null && now > lastQualityAt) {
            const dt = (now - lastQualityAt) / 1000;
            const df = total - lastQualityFrames;
            // 负数说明播放被重置（seek/重载），丢弃这一次采样
            if (df >= 0 && dt > 0.2) out.fps = Math.round(df / dt);
          }
          lastQualityFrames = total;
          lastQualityAt = now;
        }
        return out;
      },

      /** 采集本端连接质量，回报给主机 */
      async report() {
        const out = {};
        // 中继模式下没有 pc，主机也不需要 framesDecoded 做存活判定
        // （看门狗在 enableRelay 时已被清掉）。直接跳过，省掉每 2 秒一次的信令。
        // HUD 改用 localStats() 本地渲染，见 view.html#startStats。
        if (mode === 'relay' || mode === 'relay-blob') return out;
        // 未连接（connecting/failed/…）时不发：此时的 payload 只有信号层
        // rtt，而主机的 onViewerStatus 会无条件刷新 L.lastReport —— 等于用
        // 无效报告把看门狗的"报告新鲜度"守卫（REPORT_STALE_MS 豁免）喂成
        // 摆设。今天恰好被 `L.lastDecoded < 0` 的前置判定挡住而未产生实害，
        // 但那是**判定顺序的巧合**，不是设计；从源头不发才是正解。
        if (!pc || pc.connectionState !== 'connected') return out;
        try {
          const stats = await pc.getStats();
          let rtt = null, jitter = null, fps = null, w = 0, h = 0, lost = 0, recv = 0;
          let framesDecoded = null;
          stats.forEach((r) => {
            if (r.type === 'inbound-rtp' && r.kind === 'video') {
              fps = r.framesPerSecond;
              w = r.frameWidth; h = r.frameHeight;
              lost = r.packetsLost; recv = r.packetsReceived;
              // 接收端解码帧数：判定链路真实存活最可靠的指标
              if (r.framesDecoded != null) framesDecoded = r.framesDecoded;
            }
            if (r.type === 'candidate-pair' && r.state === 'succeeded') {
              rtt = r.currentRoundTripTime != null ? r.currentRoundTripTime * 1000 : null;
            }
            if (r.type === 'remote-inbound-rtp' && r.kind === 'video') {
              jitter = r.jitter;
            }
          });
          const lossPct = (recv + lost) > 0 ? (lost / (recv + lost)) * 100 : 0;
          out.rtt = rtt != null ? Math.round(rtt) : null;
          out.jitter = jitter != null ? +(jitter * 1000).toFixed(1) : null;
          out.fps = fps != null ? Math.round(fps) : null;
          out.res = w && h ? `${w}×${h}` : null;
          out.loss = +lossPct.toFixed(2);
          out.framesDecoded = framesDecoded;
        } catch {}
        // 注意：这里**不再**用 `signal.rtt` 兜底。
        //
        // signal.rtt 是信令 WebSocket 的 ping/pong 往返，与媒体链路 RTT 是两码事：
        // 信令永远走中继服务器，媒体则可能走 P2P/TURN。公网下两者能差一个数量级。
        // 刚连上时 getStats 还没有 succeeded 的 candidate-pair，若此刻用 signal.rtt
        // 冒充，HUD 的"延迟"与主机 stats 都会短暂显示一个错误值，误导用户判断链路。
        // 宁可诚实显示「—」，等真实 candidate-pair 出来再填（通常 1~2 秒内）。
        signal.send({ type: 'viewer-status', payload: out });
        return out;
      },

      destroy() {
        clearTimeout(blobTimer);
        blobTimer = null;   // 清掉悬空 id；也保证本实例的"已排程"状态不留残迹
        try { sourceBuffer && mediaSource && mediaSource.readyState === 'open' && mediaSource.endOfStream(); } catch {}
        try { pc && pc.close(); } catch {}
        pc = null;
        // 释放 ObjectURL，避免长时间运行反复切换链路时泄漏
        if (currentUrl) { try { URL.revokeObjectURL(currentUrl); } catch {} currentUrl = null; }
        if (videoEl) { try { videoEl.removeAttribute('src'); videoEl.srcObject = null; } catch {} }
        mediaSource = null;
        sourceBuffer = null;
        queue = [];
        blobParts = [];
        // mode 必须一并复位。否则 destroy 后它仍停留在 'p2p-host'，
        // 调用方据此判断"连接还在"（如断线重建前的自恢复检查）就会误判，
        // 从而跳过本该执行的重建流程。
        mode = 'connecting';
        // fps 采样基准同步复位：置空的视频元素一旦被复用，
        // 若沿用上一轮的 totalVideoFrames，localStats() 首帧会算出
        // 一个跨连接的错误读数（HUD 闪一下错值），要等下一次采样才自愈。
        lastQualityFrames = null;
        lastQualityAt = 0;
      },
    });

    // getter 必须用 defineProperties 挂载（原因见上方注释），否则会被冻结成定值
    Object.defineProperties(bus, {
      mode: { get() { return mode; }, configurable: true },
      pc: { get() { return pc; }, configurable: true },
    });

    return bus;
  }

  global.Cast.createViewerTransport = createViewerTransport;
})(window);
