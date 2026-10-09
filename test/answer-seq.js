/* 过期 answer 的世代号拒绝（P0 回归）
 *
 * 缺陷回顾（host.js#onAnswer）：
 *   优雅重连路径下同一 viewerId 会连发两次 addViewer，第二代把第一代的
 *   entry/pc 顶掉。旧代 offer 的 answer 若晚到，onAnswer 里 `entry.pc`
 *   拿到的已是**新代 pc**，旧 answer 会被塞给它：
 *     - pc 若在 'have-local-offer'，setRemoteDescription(旧 answer) 把它推进
 *       到 'stable'（静默成功、状态错乱）；
 *     - 随后真 answer 到达，setRemoteDescription 抛 InvalidStateError（被
 *       catch 吞掉）→ 这条大屏永久卡在协商中（实际会被判 P2P 失败切中继）。
 *
 *   用户曾建议"快照 const target = entry.pc"——但那防不住：target 拿到的
 *   就是**新** pc，旧 answer 仍作用在它身上。必须靠 offer/answer 世代号
 *   在入口处按序拒绝：addViewer 给每个 entry 编 seq，offer 带 seq、answer
 *   回显 seq，onAnswer 拒绝 seq 不匹配的过期 answer。
 *
 * 本用例白盒构造（不赌真实网络时序）：
 *   1. 注入 canvas 伪流，让 addViewer 能真正建 pc；
 *   2. 劫持 RTCPeerConnection 包装 setRemoteDescription，记录"被调用了几次"
 *      （不真正执行，避免依赖有效 SDP）；
 *   3. 连调两次 addViewer('v1') → entry.seq 递增到 2；
 *   4. 用 seq=1 调 onAnswer（过期）→ 应被拒绝（setRemoteDescription 零调用）；
 *   5. 用 seq=2 调 onAnswer（当前代）→ 应被接受（调用一次）。
 *
 * A/B：把 onAnswer 里的 `entry.seq !== seq` 校验去掉，第 4 步的过期 answer
 *   会穿透（setRemoteDescription 被调用），本用例转红。
 */
let puppeteer;
try { puppeteer = require('puppeteer-core'); }
catch {
  console.log('  ⚠ SKIP: 未安装 puppeteer-core（开发依赖）');
  process.exit(0);
}
const CHROME = process.env.CHROME_PATH || '/usr/bin/chromium';
const BASE = process.env.BASE_URL || 'http://localhost:8080';

let pass = 0, fail = 0;
function ok(n, c, e) { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  → ' + e : '')); } }

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

  const r = await page.evaluate(async () => {
    const host = window.__host;
    const wait = (ms) => new Promise((res) => setTimeout(res, ms));

    // 注入真实流，让 addViewer 能 addTrack + createOffer
    const cv = document.createElement('canvas');
    cv.width = 160; cv.height = 120;
    const ctx = cv.getContext('2d');
    let n = 0;
    setInterval(() => { ctx.fillStyle = (n++ % 2) ? '#222' : '#ddd'; ctx.fillRect(0, 0, 160, 120); }, 60);
    host.setStream(cv.captureStream(15));

    // 劫持 RTCPeerConnection，只对 setRemoteDescription 计数（不真正执行）；
    // 同时劫持 RTCSessionDescription —— 否则 `new RTCSessionDescription('FAKE…')`
    // 会在调 setRemoteDescription 之前就抛 SyntaxError，计数恒为 0。
    const RealPC = window.RTCPeerConnection;
    let srCalls = 0;
    window.RTCPeerConnection = function (...args) {
      const pc = new RealPC(...args);
      pc.setRemoteDescription = function () { srCalls++; return Promise.resolve(); };
      return pc;
    };
    window.RTCPeerConnection.prototype = RealPC.prototype;
    window.RTCSessionDescription = function (d) { return d; };

    // 连调两次：第一次 seq=1，第二次 seq=2（第二次 removeViewer 顶掉第一次）
    await host.addViewer('v1');
    await host.addViewer('v1');

    // 过期 seq 应被拒绝
    srCalls = 0;
    await host.onAnswer('v1', 'FAKE_SDP_STALE', 1);
    const staleCalls = srCalls;

    // 当前代 seq 应被接受
    await host.onAnswer('v1', 'FAKE_SDP_CURRENT', 2);
    const currentCalls = srCalls;

    window.RTCPeerConnection = RealPC;
    return { staleCalls, currentCalls };
  });

  ok('过期 seq 的 answer 被拒绝（setRemoteDescription 零调用）',
    r.staleCalls === 0, `calls=${r.staleCalls}`);
  ok('当前代 seq 的 answer 被接受（setRemoteDescription 调用一次）',
    r.currentCalls === 1, `calls=${r.currentCalls}`);
  ok('页面无未捕获异常', errs.length === 0, errs.join(' | '));

  await browser.close();
  console.log(`\n通过 ${pass}/${pass + fail}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('测试异常：', e); process.exit(1); });
