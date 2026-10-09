/* 信令断开时，挂起中的 addViewer 不得留下僵尸 peer（防护锁定）
 *
 * 背景：评审报告声称存在如下脱钩窗口 ——
 *   T0  viewer-joined → viewerMap.set（UI +1）→ host.addViewer(V)：
 *       peers.set(V, entry_A) 后 await createOffer() 挂起
 *   T1  signal close → viewerMap.clear() + host.reset()（peers 清空）
 *   T2  addViewer 的 await 恢复 → "它会往 peers 里塞一个新 entry"（报告原文）
 *       → peers 里出现一条 UI 不知道的僵尸
 *
 * **核查结论：该场景不可达。** 关键事实与报告的前提相反：
 * addViewer 的 peers.set 发生在**第一个 await 之前**（同步段），
 * await 恢复后做的第一件事是 `if (stale()) return`，其中
 * `stale = () => peers.get(viewerId) !== entry`。T1 的 reset() 已经把
 * entry_A 从 peers 删掉，所以 T2 恢复时 stale() 为真 → 静默退出，
 * **不会**再插入任何东西 —— "塞新 entry"发生在挂起之前，而不是恢复之后。
 * 代际信息由 entry 的对象身份隐式携带，无需 cast.html 额外传"会话代际号"。
 *
 * 本用例把这条链路**确定性**地钉死（不靠时序运气）：
 * 劫持 RTCPeerConnection.prototype.createOffer 为一道"闸门"，
 * 在 close → reset() 完成之后才放行，然后断言 peers 里没有僵尸。
 * 现有防护下恒绿；若将来 stale() 被移除/改坏，本用例转红。
 *
 * 依赖：puppeteer-core（开发依赖）。
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
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new', protocolTimeout: 60000,
    args: ['--no-sandbox', '--disable-setuid-sandbox',
           '--autoplay-policy=no-user-gesture-required'],
  });

  // ---------- 1. 真 host 建房（canvas 伪流） ----------
  const hostPage = await browser.newPage();
  await hostPage.goto(`${BASE}/cast?debug=1`, { waitUntil: 'domcontentloaded' });
  await hostPage.waitForFunction(() => !!window.__host, { timeout: 15000 });

  // 劫持 createOffer 为闸门：armed 期间永不 resolve，直到手动放行
  await hostPage.evaluate(() => {
    const orig = RTCPeerConnection.prototype.createOffer;
    window.__gateArmed = false;
    window.__releaseGate = null;
    RTCPeerConnection.prototype.createOffer = function (...a) {
      if (!window.__gateArmed) return orig.apply(this, a);
      return new Promise((resolve) => { window.__releaseGate = () => resolve(orig.call(this, ...[]).catch(() => null)); });
    };
  });

  const code = await hostPage.evaluate(async () => {
    const cv = document.createElement('canvas');
    cv.width = 160; cv.height = 120;
    const ctx = cv.getContext('2d');
    let n = 0;
    setInterval(() => { ctx.fillStyle = (n++ % 2) ? '#222' : '#ddd'; ctx.fillRect(0, 0, 160, 120); }, 60);
    window.__host.setStream(cv.captureStream(15));
    window.__forceStarted && window.__forceStarted();
    await new Promise((res) => {
      const t = setInterval(() => { if (window.__signal.state === 1) { clearInterval(t); res(); } }, 50);
      setTimeout(() => { clearInterval(t); res(); }, 8000);
    });
    const code = 'GR' + Math.random().toString(36).slice(2, 5).toUpperCase();
    return await new Promise((res) => {
      window.__signal.on('created', (m) => res((m && m.code) || code));
      window.__signal.send({ type: 'create', code });
      setTimeout(() => res(code), 3000);
    });
  });
  ok('真 host 建房成功', !!code && code.length >= 4, String(code));

  // ---------- 2. viewer 加入，addViewer 挂在闸门上 ----------
  await hostPage.evaluate(() => { window.__gateArmed = true; });
  const viewPage = await browser.newPage();
  await viewPage.goto(`${BASE}/view?r=${code}&debug=1`, { waitUntil: 'domcontentloaded' });
  await viewPage.waitForFunction(() => !!window.__signal && window.__signal.state === 1, { timeout: 15000 });
  await wait(2000);   // viewer-joined → addViewer：peers.set 同步发生，await 挂起

  const inFlight = await hostPage.evaluate(() => window.__host.getPeers().size);
  ok('addViewer 已把 entry 写入 peers（await 前的同步段）', inFlight === 1, `size=${inFlight}`);

  // ---------- 3. 信令断开 → close handler 清两侧状态 ----------
  await hostPage.evaluate(() => { window.__signal.close(); });
  await wait(400);
  const afterClose = await hostPage.evaluate(() => ({
    peers: window.__host.getPeers().size,
    ids: window.__host.peerIds || [],
  }));
  ok('close 后 peers 已清空（reset 生效）', afterClose.peers === 0, `size=${afterClose.peers}`);

  // ---------- 4. 放行闸门 → 挂起的 addViewer 恢复 ----------
  await hostPage.evaluate(() => { try { window.__releaseGate && window.__releaseGate(); } catch {} });
  await wait(600);
  const afterGate = await hostPage.evaluate(() => ({
    peers: window.__host.getPeers().size,
    ids: window.__host.peerIds || [],
  }));
  ok('闸门放行后无僵尸 peer（stale() 让挂起链路静默退出）',
     afterGate.peers === 0 && afterGate.ids.length === 0,
     `size=${afterGate.peers} ids=${JSON.stringify(afterGate.ids)}`);

  console.log(`\n通过 ${pass}/${pass + fail}`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error('测试异常：', e); process.exit(1); });
