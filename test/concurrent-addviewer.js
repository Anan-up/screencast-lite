/* 并发 addViewer 的误降级 —— 主机会把健康大屏误推到中继（P0 回归）
 *
 * 缺陷回顾：
 *   host.addViewer 是 async，但 cast.html 的调用点**不 await**
 *     signal.on('viewer-joined', (m) => { ...; host.addViewer(m.viewerId); ... });
 *   同一 viewerId 短时间被调用两次会并发，第二条把第一条刚放的 entry 顶掉：
 *
 *     T0  addViewer#1: peers.set(V1, entry_A); await pc_A.createOffer() 挂起
 *     T1  addViewer#2: peers.has(V1) → removeViewer(V1)（close 掉 pc_A）
 *                      peers.set(V1, entry_B); await pc_B.createOffer() 挂起
 *     T2  addViewer#1 恢复: pc_A.setLocalDescription() ← pc_A 已 close，抛错
 *         → catch → enableRelay(V1) 里 peers.get(V1) 拿到 **entry_B**
 *         → 把本该 P2P 直连的健康新连接误切到服务器中继
 *
 * 触发源（README「已知冗余」）：优雅重连时服务端补发一条 viewer-joined
 * （rejoined: true），大屏收到 host-return 后主动 doJoin 又触发第二条。
 * 两条真并发取决于 createOffer 与信令往返谁快 —— 不能靠时序侥幸。
 *
 * 本用例怎么做到**确定性**复现（不靠赌 createOffer 比信令慢）：
 *   1. 装一个 host 的"探针"：createHostTransport 已被 cast.html 构造好，
 *      但它此刻 stream 为 null（没走 getDisplayMedia），peers 恒空。
 *      为了让 addViewer 真正建 pc，我们通过 __host 注入一条 canvas 伪流。
 *   2. 包一层 RTCPeerConnection，使**第一次** createOffer() 返回一个
 *      永不 resolve 的 promise（受测试控制的闸门），第二次正常 resolve。
 *      这样 addViewer#1 必然停在 await 上，addViewer#2 必然插到它前面执行完。
 *   3. 放闸，让 addViewer#1 的后续（setLocalDescription 抛错 → catch）执行。
 *
 * 断言：最终 peers.get('v1').mode !== 'relay'（不得被误降级），
 *       且最终 entry.pc === 第二条创建的 pc（未被第一条的 catch 关掉）。
 *
 * 对照组（A/B）：把 addViewer 里的 stale() 校验去掉，mode 必然变成 'relay'。
 *
 * 依赖：puppeteer-core（开发依赖）。未安装时 SKIP 并以 0 退出。
 */
let puppeteer;
try { puppeteer = require('puppeteer-core'); }
catch {
  console.log('  \u26a0 SKIP: 未安装 puppeteer-core（开发依赖）');
  process.exit(0);
}
const CHROME = process.env.CHROME_PATH || '/usr/bin/chromium';
const BASE = process.env.BASE_URL || 'http://localhost:8080';

let pass = 0, fail = 0;
function ok(n, c, e) { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  ' + e : '')); } }

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new', protocolTimeout: 60000,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));

  await page.goto(`${BASE}/cast?debug=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__host, { timeout: 15000 });
  ok('调试把手 __host 已就绪', true);

  // 页面内构造并发场景。整段在 page.evaluate 里跑，保持对 RTCPeerConnection
  // 的劫持窗口不被 Puppeteer 的往返打断。
  const r = await page.evaluate(async () => {
    const host = window.__host;
    const wait = (ms) => new Promise((res) => setTimeout(res, ms));

    // ---- 0. 注入一条真实流 ----
    // 必须注入：addViewer → makePc 只在 `stream` 非空时才 addTrack。若没有轨道，
    // createOffer 产出的是**无 m-line** 的 offer，setLocalDescription 会直接抛
    // OperationError（与并发无关的假失败）。canvas.captureStream() 既能提供
    // 真实 video 轨道，又不需要 getDisplayMedia 的系统授权交互。
    const cv = document.createElement('canvas');
    cv.width = 160; cv.height = 120;
    const ctx = cv.getContext('2d');
    let n = 0;
    setInterval(() => { ctx.fillStyle = (n++ % 2) ? '#222' : '#ddd'; ctx.fillRect(0, 0, 160, 120); }, 60);
    host.setStream(cv.captureStream(15));

    // ---- 1. 劫持 RTCPeerConnection，控制第 1 次 createOffer 永不 resolve ----
    const RealPC = window.RTCPeerConnection;
    const pcs = [];              // 按创建顺序记录所有 pc 实例
    let releaseFirst = null;     // 第一道闸门的放行函数
    let offerCalls = 0;

    window.RTCPeerConnection = function (...args) {
      const pc = new RealPC(...args);
      pcs.push(pc);
      const realCreateOffer = pc.createOffer.bind(pc);
      pc.createOffer = function (...a) {
        offerCalls++;
        if (offerCalls === 1) {
          // 第一道闸门：挂起，直到测试显式放行
          return new Promise((res, rej) => {
            releaseFirst = () => realCreateOffer(...a).then(res, rej);
          });
        }
        return realCreateOffer(...a);
      };
      // 记录 close 调用，便于断言"健康 entry 的 pc 未被误关"
      const realClose = pc.close.bind(pc);
      pc.close = function () { pc.__closed = true; return realClose(); };
      return pc;
    };
    window.RTCPeerConnection.prototype = RealPC.prototype;

    // ---- 2. 连发两次 addViewer（不 await，模拟 cast.html 的真实调用方式） ----
    const p1 = host.addViewer('v1');   // 会停在第一道闸门上
    await wait(50);                    // 确保 #1 已经 set 好 entry_A 并挂起
    const p2 = host.addViewer('v1');   // 顶掉 entry_A，建 entry_B

    // 等 #2 走完（它的 createOffer 是第 2 次，不受闸门限制）
    await wait(200);

    // 此刻快照：entry_B 应当是当前 peers 里的那个
    const mid = {
      offerCalls,
      pcCount: pcs.length,
      modes: host.peerModes,
      pcClosed: pcs.map((p) => !!p.__closed),
    };

    // ---- 3. 放闸，让 #1 的弃子链路继续走完（这是触发缺陷的关键窗口） ----
    if (releaseFirst) releaseFirst();
    await Promise.allSettled([p1, p2]);
    await wait(300);

    const fin = {
      offerCalls,
      pcCount: pcs.length,
      modes: host.peerModes,                       // { v1: 'connecting' | 'relay' | ... }
      pcClosed: pcs.map((p) => !!p.__closed),      // [旧代, 新代]
    };

    // 还原，避免影响页面后续行为
    window.RTCPeerConnection = RealPC;
    return { mid, fin };
  });

  console.log('   并发中快照 =', JSON.stringify(r.mid));
  console.log('   最终状态   =', JSON.stringify(r.fin));

  const finMode = r.fin.modes && r.fin.modes.v1;
  const midMode = r.mid.modes && r.mid.modes.v1;

  ok('确实触发了并发（两次 addViewer 各建一个 pc）',
    r.mid.pcCount === 2 && r.mid.offerCalls === 2,
    JSON.stringify(r.mid));

  // 核心断言：健康的新连接**不得**被误推到中继
  ok('最终 mode 不是 relay（健康大屏未被误降级）',
    finMode !== 'relay' && finMode !== 'failed',
    `mode=${finMode}`);

  // 旧代 pc 应被 close（removeViewer 干的），新代 pc 必须仍存活。
  // 这是"代际校验生效"最直接的证据：弃子链路的 catch 没有碰新代。
  ok('旧代 pc 已关闭、新代 pc 未被误关',
    r.fin.pcClosed[0] === true && r.fin.pcClosed[1] === false,
    JSON.stringify(r.fin.pcClosed));

  ok('页面无未捕获异常', errs.length === 0, errs.join(' | '));

  await browser.close();
  console.log(`\n通过 ${pass}/${pass + fail}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('测试异常：', e); process.exit(1); });
