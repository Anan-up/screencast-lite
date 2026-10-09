/* ============================================================
   极简投屏 · 传输核心
   双模式：局域网/公网 P2P 直连优先 —— 打不通自动降级 WebSocket 中继
   ============================================================ */

(function (global) {
  'use strict';

  // ---------------- 工具 ----------------
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  const fmtTime = (s) => {
    s = Math.max(0, Math.floor(s || 0));
    const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), sec = s % 60;
    const p = (n) => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${p(m)}:${p(sec)}` : `${p(m)}:${p(sec)}`;
  };

  const fmtBytes = (b) => {
    if (!b) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB'];
    const i = Math.min(u.length - 1, Math.floor(Math.log(b) / Math.log(1024)));
    return (b / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1) + ' ' + u[i];
  };

  // ---------------- 连接质量评级 ----------------
  // 判定顺序：局域网/内网直连 > 跨网直连 > TURN 中转 > 服务器中转
  function gradePath(mode, stats) {
    if (mode === 'relay') {
      return { key: 'relay', label: '服务器中转', tone: 'warn', hint: 'P2P 未打通，画面经服务器转发' };
    }
    if (mode === 'relay-blob') {
      return { key: 'relay', label: '中转·兼容', tone: 'warn', hint: '中继兼容模式，延迟较高' };
    }
    if (mode === 'p2p-host') {
      return { key: 'lan', label: '局域网直连', tone: 'live', hint: '同一网络内点对点传输，延迟最低' };
    }
    if (mode === 'p2p-srflx' || mode === 'p2p-prflx') {
      // srflx 是经 STUN 反射的公网候选，属于跨网直连，不是局域网
      return { key: 'p2p', label: 'P2P 直连', tone: 'live', hint: '经公网打洞点对点直连' };
    }
    if (mode === 'p2p-relay') {
      return { key: 'turn', label: 'TURN 中转', tone: 'warn', hint: '经 TURN 服务器转发，跨网可用' };
    }
    if (mode === 'p2p-pending') {
      // 只是"已连通、尚未确定承载链路"，不要提前说成 P2P 直连 ——
      // 若最终判成 TURN，用户会先看到"P2P 直连"再跳成"TURN 中转"，观感很差
      return { key: 'p2p', label: '直连确认中', tone: 'live', hint: '已点对点连通，正在确认承载链路' };
    }
    if (mode === 'failed') {
      return { key: 'failed', label: '链路异常', tone: 'err', hint: '直连与中转均不可用，请刷新重试' };
    }
    return { key: 'unknown', label: '建立中', tone: '', hint: '正在协商最佳链路' };
  }

  // ---------------- 观察者辅助 ----------------
  function emitter(target) {
    const map = new Map();
    target.on = (ev, fn) => {
      if (!map.has(ev)) map.set(ev, new Set());
      map.get(ev).add(fn);
      return () => map.get(ev).delete(fn);
    };
    target.emit = (ev, ...args) => {
      const set = map.get(ev);
      if (set) for (const fn of [...set]) { try { fn(...args); } catch (e) { console.error(e); } }
    };
    return target;
  }

  // ---------------- 信令通道（带自动重连） ----------------
  function createSignal(url) {
    const bus = emitter({});
    const DEBUG = new URLSearchParams(location.search).has('debug');
    let ws = null;
    let retry = 0;
    let closedByUser = false;
    let pingTimer = null;
    let lastRtt = null;

    function connect() {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const full = url || `${proto}//${location.host}`;
      ws = new WebSocket(full);
      ws.binaryType = 'arraybuffer';

      ws.onopen = () => {
        retry = 0;
        bus.emit('open');
        clearInterval(pingTimer);
        pingTimer = setInterval(() => {
          if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'ping', t: Date.now() }));
        }, 5000);
      };

      ws.onmessage = (ev) => {
        if (typeof ev.data !== 'string') { bus.emit('binary', ev.data); return; }
        let msg; try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.type === 'pong') { lastRtt = Date.now() - msg.t; bus.emit('rtt', lastRtt); return; }
        bus.emit(msg.type, msg);
        bus.emit('*', msg);
      };

      ws.onclose = (ev) => {
        clearInterval(pingTimer);
        bus.emit('close', ev);
        if (closedByUser) return;
        // 指数退避，最高 8 秒
        const delay = Math.min(8000, 600 * Math.pow(1.6, retry++));
        setTimeout(connect, delay);
        bus.emit('reconnecting', { attempt: retry, delay });
      };

      ws.onerror = () => bus.emit('error');
    }

    connect();

    // 注意：必须用 defineProperties 而非 Object.assign。
    // Object.assign 会把 getter 求值后按"值"复制，导致 state/rtt 变成
    // 定格的快照（例如 state 永远是建连前的 0），后续判断全部失效。
    Object.defineProperties(bus, {
      send: {
        value(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); },
      },
      sendBinary: {
        value(buf) { if (ws && ws.readyState === 1) ws.send(buf); },
      },
      state: { get() { return ws ? ws.readyState : 3; } },
      // 调试把手：原始 socket。仅当页面带 ?debug=1 时才有值，
      // 正常使用时为 null，避免外部脚本拿到裸连接随意操作。
      socket: { get() { return DEBUG ? ws : null; } },
      rtt: { get() { return lastRtt; } },
      // 永久关闭：置 closedByUser 后 onclose 直接 return，不再重连。
      // 只用于**页面即将卸载**（beforeunload）这类"确实不该再重连"的场景。
      // 需要"断开当前连接并重连"时请用 reconnectNow()，不要用本方法。
      close: {
        value() { closedByUser = true; clearInterval(pingTimer); try { ws.close(); } catch {} },
      },
      // 主动断开当前 ws，让 onclose 走**正常的指数退避重连**路径，
      // 或在 socket 已不可救时立即换一条新的。
      //
      // 与 close() 的区别是本方法的唯一存在理由：
      //   close() 会把 closedByUser 置 true，而该标记在 connect() 里从不复位，
      //   于是 ws.onclose 开头 `if (closedByUser) return;` 直接短路，
      //   信令层**从此永久失联**，只能刷新页面。
      //   所以"想重连"时调用 close() 是错的。
      //
      // ---- 必须显式复位 closedByUser ----
      //   不能"假设它本来就是 false"：否则本方法的正确性会**依赖调用顺序**，
      //   只要此前有人（哪怕别处代码）调过一次 close()，残留的 true 就会让
      //   后续所有 reconnectNow() 静默失效（onclose 依旧 return），
      //   表现为"调了重连却连不上"，极难排查。复位后本方法自洽。
      //   复位必须发生在任何 ws.close() **之前**。
      //
      // ---- retry 也必须无条件复位 ----
      //   否则两条分支行为不一致：OPEN 分支走 ws.close() → onclose 里
      //   `600 * 1.6^retry` 会用**当前** retry 值。若此前已连续失败 5 次
      //   （retry=5），用户点"重连"却要等约 6.3 秒才开始，与"立刻重连"的
      //   语义不符。提到分支之前统一复位，两条路径都从 0 开始退避。
      //
      // ---- readyState 必须三分支，不能写成 `>= 2` ----
      //   WebSocket 的 onclose **只派发一次**，但 CLOSING(2) 与 CLOSED(3)
      //   在"onclose 是否已派发"上恰好相反：
      //
      //     OPEN(1)    → 主动 ws.close()，onclose 会正常派发并触发 connect()
      //     CLOSING(2) → onclose **尚未**派发、即将派发。此时若抢先 connect()，
      //                  会与随后的 onclose → connect() 撞车：
      //                    connect() 生成 A（ws 指向 A）
      //                    → 旧 socket 的 onclose 派发 → 退避后 connect() 生成 B
      //                    → ws 改指 B，A 无人引用但底层 socket 仍 OPEN
      //                  ⇒ **孤儿连接**：继续收消息却无人处理，
      //                    服务端也误以为该浏览器有两条活跃 ws。
      //                  所以这里先把旧 socket 的事件回调**摘除**，再立即 connect()——
      //                  既消除撞车，又满足"立刻换一条"的语义（若仍等 onclose，
      //                  用户会感觉"点了没反应"）。
      //     CLOSED(3)  → onclose 早已派发过，再 ws.close() 不产生新事件，
      //                  必须直接 connect()，否则永远等不到 onclose。
      //
      // 典型用途：收到服务端的 replaced（房间已被别处接管）后，
      // 本连接的 role 已被标为 'replaced'，服务端对它的一切消息静默丢弃，
      // 必须换一条新 ws 才能重新建房。见 cast.html 的 replaced handler。
      reconnectNow: {
        value() {
          closedByUser = false;
          clearInterval(pingTimer);
          retry = 0;

          if (ws && ws.readyState === 1) {          // OPEN
            try { ws.close(); } catch { /* ignore */ }
            return;                                  // 交给 onclose 走退避重连
          }
          if (ws && ws.readyState === 2) {           // CLOSING：摘回调，防撞车
            // 用局部变量持有旧 socket 再摘回调，而不是直接写 ws.onclose = null：
            //   1) 意图显式 —— "这条 socket 从此与我们无关"，不依赖
            //      "紧接着的 connect() 会把模块级 ws 覆盖掉"这一隐式事实；
            //   2) 抗重构 —— 若将来 connect() 改为"返回新 socket 而不赋值给 ws"，
            //      旧 socket 一旦丢掉 here 的最后一个引用即被 GC，
            //      不会因为残留的 ws 引用而泄漏（其回调此时已摘除）。
            const old = ws;
            try {
              old.onclose = null;
              old.onerror = null;
              old.onmessage = null;
              old.onopen = null;
            } catch { /* ignore */ }
          }
          // CLOSED(3) / CLOSING(2, 已摘回调) / 无 ws → 立即换一条
          connect();
        },
      },
      // 主机在"即将断开但连接尚可用"时调用，通知房间内大屏进入轻量等待态。
      // 服务端收到后会打上 hostAway 标记，使随后的 ws.on('close') 进入
      // HOST_AWAY_GRACE_MS 优雅窗口而非立即 destroyRoom。
      //
      // 注意：这是 **best-effort**。readyState === 1 才发得出去，而
      //  - beforeunload 场景下浏览器可能已把 ws 推到 CLOSING(2)，消息丢失；
      //  - 真实网络中断（拔网线/切网）时根本没有机会调用本方法。
      // 这两种情况下走的是"没有 hostAway 标记"的分支：服务端立即销毁房间，
      // 大屏收到 room-closed 进入待机并自动重试——功能正常，只是少了平滑过渡。
      notifyAway: {
        value() {
          try {
            if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'host-away' }));
          } catch { /* ignore */ }
        },
      },
      // 主机在优雅窗口内重连成功（复用了同一房间码）后调用，
      // 让服务端撤掉 hostAway 标记并通知大屏收起"正在恢复…"提示。
      // 不与 notifyAway 复用：语义相反，混用会让状态机难以推理。
      notifyReturn: {
        value() {
          try {
            if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'host-return' }));
          } catch { /* ignore */ }
        },
      },
    });
    return bus;
  }

  // ---------------- 配置拉取 ----------------
  async function fetchConfig() {
    try {
      const r = await fetch('/api/config', { cache: 'no-store' });
      if (!r.ok) throw new Error('config failed');
      return await r.json();
    } catch {
      return { turn: null };
    }
  }

  // 把服务端 TURN 凭据 + 公共 STUN 组装成 iceServers
  function buildIceServers(turn) {
    const list = [
      { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
      { urls: 'stun:stun.cloudflare.com:3478' },
    ];
    if (turn && turn.urls) {
      // urls 兼容三种形态：数组（规范允许）、单值字符串（本项目默认）、
      // 逗号分隔串（coturn 运维惯用写法，如 turn:a?transport=udp,turn:b?transport=tcp）。
      // RTCIceServer.urls 不会自动拆逗号串 —— 整串被当成**一个**字面 URL，
      // ICE 直接失败。这里统一归一化为数组。
      const raw = Array.isArray(turn.urls) ? turn.urls : String(turn.urls).split(',');
      const urls = raw.map((s) => s.trim()).filter(Boolean);
      if (urls.length) {
        list.push({
          urls,
          username: turn.username,
          credential: turn.credential,
        });
      }
    }
    return list;
  }

  // ---------------- 从真实候选对判断链路 ----------------
  /**
   * 精确判定：查询 getStats() 里 state=succeeded 且被 nominated 的候选对，
   * 取其 local/remote candidateType。这才是真正承载媒体流的链路类型。
   *
   * 说明：这里**不再**提供基于 SDP 的同步粗判。只要 buildIceServers() 带上了
   * TURN，本地 SDP 就必然包含 `typ relay` 候选（哪怕实际选中 host/srflx），
   * 粗判在配了 TURN 的环境下只会稳定给出错误答案。连接瞬间一律先用中性态
   * `p2p-pending`，等这里的异步结果出来再定。
   */
  async function detectPathAsync(pc) {
    if (!pc || pc.connectionState !== 'connected') return null;
    try {
      const stats = await pc.getStats();
      let pair = null;
      stats.forEach((r) => {
        if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.nominated) pair = r;
      });
      if (!pair) {
        // 某些实现不设 nominated，退而求其次取任一 succeeded 的 pair
        stats.forEach((r) => {
          if (!pair && r.type === 'candidate-pair' && r.state === 'succeeded') pair = r;
        });
      }
      if (!pair) return null;

      const l = pair.localCandidateId ? stats.get(pair.localCandidateId) : null;
      const rm = pair.remoteCandidateId ? stats.get(pair.remoteCandidateId) : null;
      const lt = l ? l.candidateType : null;
      const rt = rm ? rm.candidateType : null;

      // 任一端是 relay => 走 TURN 中转
      if (lt === 'relay' || rt === 'relay') return 'p2p-relay';
      // 任一端是 srflx/prflx => 经公网反射，属跨网直连（非局域网）
      if (lt === 'srflx' || rt === 'srflx' || lt === 'prflx' || rt === 'prflx') return 'p2p-srflx';
      return 'p2p-host';
    } catch {
      return null;
    }
  }

  // ---------------- 出站视频码率（中继模式需要压一点） ----------------
  async function tuneSender(sender, opts) {
    const params = sender.getParameters();
    if (!params.encodings || !params.encodings.length) params.encodings = [{}];
    params.encodings[0].maxBitrate = opts.bitrate;
    params.encodings[0].maxFramerate = opts.fps;
    try { await sender.setParameters(params); } catch { /* Safari 可能不支持 */ }
  }

  // ---------------- 屏幕采集 ----------------
  async function captureScreen(opts = {}) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      const err = new Error('UNSUPPORTED');
      err.code = 'UNSUPPORTED';
      throw err;
    }
    const constraints = {
      video: {
        frameRate: { ideal: opts.fps || 30, max: 60 },
        width: { ideal: opts.width || 1920 },
        height: { ideal: opts.height || 1080 },
        cursor: 'motion',
      },
      audio: false,
    };
    if (opts.systemAudio) {
      constraints.audio = {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      };
    }
    // displaySurface 偏向整个屏幕
    constraints.video.displaySurface = opts.surface || 'monitor';
    return navigator.mediaDevices.getDisplayMedia(constraints);
  }

  // ---------------- 屏幕采集支持性检查 ----------------
  // 只回答一个问题：这台浏览器**具备**投屏所需的两项能力吗？
  //   - getDisplayMedia（屏幕采集）
  //   - RTCPeerConnection（WebRTC）
  //
  // 为什么不在这里判"是否安全上下文（HTTPS / 局域网豁免）"：
  //   早期版本曾额外算一个 `secure` 字段（内联了一份局域网正则），但从未被
  //   任何调用点消费。而且那段正则与 server.js 的 isLocalAddress() 是**重复
  //   实现**，两处长期容易不同步。真正决定"能不能采集"的是浏览器的实际行为
  //   （getDisplayMedia 会直接抛错），不是我们的预判；服务端也已在
  //   /api/config 返回 insecureOk 供前端参考。故删去死字段，避免留下会腐化的
  //   第二份判定逻辑。
  function checkSupport() {
    const issues = [];
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      issues.push('当前浏览器不支持屏幕采集（getDisplayMedia）');
    }
    if (!window.RTCPeerConnection) {
      issues.push('当前浏览器不支持 WebRTC');
    }
    return { ok: issues.length === 0, issues };
  }

  // ---------------- 二维码（极简版，纯 canvas 绘制） ----------------
  // ---------------- 二维码（基于 qrcode-generator，MIT） ----------------
  // 手写 QR 编码器极易出错（纠错码、对齐图案、掩码、格式信息缺一不可），
  // 这里改用经过充分验证的 qrcode-generator（见 /js/qrcode.js，MIT 许可）。
  const QR = (function () {
    const gen = (typeof qrcode !== 'undefined') ? qrcode : null;

    /** 编码为二维矩阵 { matrix: [[0|1]], size } */
    function encode(text) {
      if (!gen) throw new Error('QR 库未加载');
      // typeNumber 0 = 自动选版本，纠错等级 M（容量与容错平衡）
      const code = gen(0, 'M');
      code.addData(String(text), 'Byte');
      code.make();
      const n = code.getModuleCount();
      const matrix = [];
      for (let r = 0; r < n; r++) {
        const row = [];
        for (let c = 0; c < n; c++) row.push(code.isDark(r, c) ? 1 : 0);
        matrix.push(row);
      }
      return { matrix, size: n };
    }

    /**
     * 渲染到 canvas。
     * @param {string} text 内容
     * @param {number} canvasSize 期望的像素边长（结果按整数倍缩放，不插值）
     */
    function toCanvas(text, canvasSize) {
      if (!gen) { console.warn('QR 库未加载'); return null; }
      try {
        const { matrix, size } = encode(text);
        const quiet = 4;                        // 规范要求 >= 4 模块静默区
        const total = size + quiet * 2;
        const px = Math.max(2, Math.floor(canvasSize / total));
        const cv = document.createElement('canvas');
        cv.width = cv.height = px * total;
        const ctx = cv.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, cv.width, cv.height);
        ctx.fillStyle = '#18181b';
        for (let r = 0; r < size; r++) {
          for (let c = 0; c < size; c++) {
            if (matrix[r][c]) {
              ctx.fillRect((c + quiet) * px, (r + quiet) * px, px, px);
            }
          }
        }
        return cv;
      } catch (e) {
        console.warn('QR 生成失败', e);
        return null;
      }
    }

    return { toCanvas, encode };
  })();

  // ---------------- 导出 ----------------
  global.Cast = {
    $, $$,
    fmtTime, fmtBytes,
    emitter,
    createSignal,
    fetchConfig,
    buildIceServers,
    detectPathAsync,
    gradePath,
    tuneSender,
    captureScreen,
    checkSupport,
    QR,
  };
})(window);
