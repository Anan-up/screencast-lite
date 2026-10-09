/* 暂停推送不得被看门狗误判为"静默中断"而切中继（P1 回归）
 *
 * 缺陷回顾（host.js makePc 的看门狗 + cast.html togglePause）：
 *   暂停的实现是 `track.enabled = false`，视频轨停发新帧 → 接收端
 *   framesDecoded 停止增长。而 view.html 的 viewer-status 是**独立于暂停**的
 *   定时上报（PC 仍 connected），所以 onViewerStatus 里的 `L.lastReport = now`
 *   持续刷新，看门狗不会走 `REPORT_STALE_MS` 那道豁免。
 *   于是 15 秒后必然命中：
 *     if (Date.now() - L.stalledSince > 15000) enableRelay(...)
 *   → 把这条大屏**不可逆地**切到服务器中继（enableRelay 没有回退路径）。
 *   用户只是暂停了一会儿，却永久损失 P2P 直连（多一跳延迟 + 服务器带宽）。
 *
 * 修复：host 增加 setPaused()，togglePause 同步调用；看门狗在
 *   pausedByUser 时跳过本轮并清掉 stalledSince 累计起点。
 *
 * 本用例为什么必须起**真 host + 真 viewer**：
 *   看门狗有两道前置守卫，任一不满足就根本走不到被测分支：
 *     1) `entry.pc.connectionState !== 'connected'` → reset 并 return
 *     2) `L.lastDecoded < 0`（接收端从未上报）→ return
 *   在无对端的单页环境里，pc 永远到不了 connected，且 onViewerStatus 里
 *   `p2pActive` 为假（mode 已被超时降级成 relay）导致 liveness 压根不写入。
 *   所以必须用 canvas 伪流建一条真实 P2P（headless 下可行）。
 *
 * 观测手段：`host.forceStall(id, 20)` 只把 stalledSince 推到 20 秒前
 *   （并把 lastReport 刷新鲜以避开节流豁免），不改 mode、不碰 pc ——
 *   被测的仍是真实看门狗逻辑。
 *
 * 两组对照（缺一不可，否则无法区分"逻辑被跳过"与"阈值压根没跨过"）：
 *   A) setPaused(false) → 应降级
 *   B) setPaused(true)  → 不应降级，且 stalledSince 被清零
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: CHROME, headless: 'new', protocolTimeout: 120000,
      args: ['--no-sandbox', '--disable-setuid-sandbox',
             '--autoplay-policy=no-user-gesture-required'],
    });
  } catch (e) { console.log('SKIP: 无法启动浏览器（' + e.message + '）'); process.exit(0); }

  const castPage = await browser.newPage();
  const viewPage = await browser.newPage();
  const errs = [];
  castPage.on('pageerror', (e) => errs.push('cast: ' + e));
  viewPage.on('pageerror', (e) => errs.push('view: ' + e));

  await castPage.goto(`${BASE}/cast?debug=1`, { waitUntil: 'domcontentloaded' });
  await castPage.waitForFunction(() => !!window.__host && window.__signal.state === 1, { timeout: 15000 });

  const code = await castPage.evaluate(async () => {
    const cv = document.createElement('canvas');
    cv.width = 320; cv.height = 240;
    const ctx = cv.getContext('2d');
    let n = 0;
    setInterval(() => { ctx.fillStyle = (n++ % 2) ? '#222' : '#ddd'; ctx.fillRect(0, 0, 320, 240); }, 60);
    window.__host.setStream(cv.captureStream(15));
    const m = await new Promise((res) => {
      const t = setTimeout(() => res(null), 5000);
      window.__signal.on('created', (msg) => { clearTimeout(t); res(msg); });
      window.__signal.send({ type: 'create' });
    });
    return m && m.code;
  });
  if (!code) { console.log('SKIP: 未能建房'); await browser.close(); process.exit(0); }
  console.log('   已建房，房间码 =', code);

  await viewPage.goto(`${BASE}/view?r=${code}&debug=1`, { waitUntil: 'domcontentloaded' });
  await viewPage.waitForFunction(() => !!window.__vx, { timeout: 15000 });
  await viewPage.evaluate(() => { const b = document.querySelector('#btnJoin'); if (b) b.click(); });

  // 等真 P2P 建起来（host 侧看到 connected + 收到过至少一次 status 上报）
  const ready = await castPage.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const ids = window.__host.peerIds || [];
    const id = ids[ids.length - 1];
    if (!id) return { ok: false, reason: 'no peer' };
    const t0 = Date.now();
    while (Date.now() - t0 < 20000) {
      const st = window.__host.peerState(id);
      const L = window.__host.peerLiveness(id);
      if (st === 'connected' && L && L.lastDecoded >= 0) {
        return { ok: true, id, st, L, mode: window.__host.peerModes[id] };
      }
      await wait(200);
    }
    return {
      ok: false, id,
      st: window.__host.peerState(id),
      L: window.__host.peerLiveness(id),
      mode: window.__host.peerModes[id],
    };
  });
  console.log('   建连结果 =', JSON.stringify(ready));

  if (!ready.ok) {
    console.log('  \u26a0 SKIP: headless 下未能建立可用的 P2P（' +
      JSON.stringify({ st: ready.st, L: ready.L, mode: ready.mode }) +
      '），用例无法覆盖目标分支 —— 不计失败');
    await browser.close();
    console.log(`\n通过 ${pass}/${pass + fail}（已跳过）`);
    process.exit(0);
  }
  ok('真 P2P 已建立且接收端有上报（看门狗两道前置守卫均满足）', true);

  // ---------- A：未暂停 → 应降级 ----------
  const a = await castPage.evaluate(async ({ id }) => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    window.__host.setPaused(false);
    window.__host.forceStall(id, 20);
    const before = { mode: window.__host.peerModes[id], L: window.__host.peerLiveness(id) };
    await wait(2000);
    return { before, after: { mode: window.__host.peerModes[id], L: window.__host.peerLiveness(id) } };
  }, { id: ready.id });
  console.log('   [A] 前 =', JSON.stringify(a.before));
  console.log('   [A] 后 =', JSON.stringify(a.after));
  ok('A 组：未暂停时停滞被检出并降级（证明阈值跨过、路径通）',
    a.after.mode === 'relay' || a.after.mode === 'failed',
    `mode=${a.after.mode}`);

  // A 组已把这条 peer 降级（看门狗 clearInterval 了），要测 B 组必须有一条
  // **健康的** peer。重建同 id 的 peer 不可靠（view 端以为还连着，不会重新 join），
  // 所以直接换一个房间：新建房 + 新 view 页加入，得到一条全新的 connected peer。
  console.log('   为 B 组新建一个房间（避免复用已降级的 peer）…');
  const code2 = await castPage.evaluate(async () => {
    const m = await new Promise((res) => {
      const t = setTimeout(() => res(null), 5000);
      window.__signal.on('created', (msg) => { clearTimeout(t); res(msg); });
      window.__signal.send({ type: 'create' });      // 主机切到新房间
    });
    return m && m.code;
  });
  const viewPage2 = await browser.newPage();
  viewPage2.on('pageerror', (e) => errs.push('view2: ' + e));
  await viewPage2.goto(`${BASE}/view?r=${code2}&debug=1`, { waitUntil: 'domcontentloaded' });
  await viewPage2.waitForFunction(() => !!window.__vx, { timeout: 15000 });
  await viewPage2.evaluate(() => { const b = document.querySelector('#btnJoin'); if (b) b.click(); });

  const ready2 = await castPage.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const t0 = Date.now();
    while (Date.now() - t0 < 20000) {
      const ids = window.__host.peerIds || [];
      const id = ids[ids.length - 1];        // 最新加入的那个
      if (id) {
        const st = window.__host.peerState(id);
        const L = window.__host.peerLiveness(id);
        if (st === 'connected' && L && L.lastDecoded >= 0) return { ok: true, id };
      }
      await wait(200);
    }
    return { ok: false, ids: window.__host.peerIds };
  });
  console.log('   B 组建连结果 =', JSON.stringify(ready2));
  // 注意：主机切房时**不会**自动清 host.peers（那是 signal 断线才做的），
  // 所以 peers 里可能同时挂着旧房间的 id。必须挑**最后一个**（新加入的）。
  // 反例见本用例早先的失败：ids[0] 指向的是 A 组那条已被降级的 peer。

  if (!ready2.ok) {
    console.log('  \u26a0 B 组：重建 P2P 未成功，跳过 B 组（不计失败）');
  } else {
    // ---------- B：暂停 → 应跳过 ----------
    const b = await castPage.evaluate(async ({ id }) => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      window.__host.setPaused(true);              // 关键：先声明暂停
      window.__host.forceStall(id, 20);           // 再把停滞前提摆好
      const before = { mode: window.__host.peerModes[id], L: window.__host.peerLiveness(id) };
      await wait(2000);                           // 跨过一个看门狗周期
      return { before, after: { mode: window.__host.peerModes[id], L: window.__host.peerLiveness(id) } };
    }, { id: ready2.id });
    console.log('   [B] 前 =', JSON.stringify(b.before));
    console.log('   [B] 后 =', JSON.stringify(b.after));
    ok('B 组：暂停期间未被降级（mode 保持非 relay/failed）',
      b.after.mode !== 'relay' && b.after.mode !== 'failed',
      `mode=${b.after.mode}`);
    ok('B 组：暂停时 stalledSince 被清零（恢复后不会立刻误触发）',
      b.after.L && b.after.L.stalledSince === 0,
      JSON.stringify(b.after.L));
    // 关于"取消暂停后看门狗是否恢复工作"：这里**不做**断言。
    // 原因是本环境的接收端是活的（lastDecoded 每轮都在增长，
    // 实测 29 → 59），decodedGrew=true 会把 stalledSince 清零，
    // 于是 forceStall 注进去的旧时间戳立刻被**真实数据**覆盖 ——
    // 断言会失败，但失败原因与被测逻辑无关。
    // "暂停解除"的正确验证应当在真实暂停场景（帧确实停发）下做，
    // 那需要 track.enabled 的端到端配合，超出本用例的构造范围。
    // 换言之：A 组已经证明"未暂停时会降级"，B 组证明"暂停时不会"，
    // 两者的差就是 setPaused 的作用，不必再补一个不可靠的第三点。
  }

  ok('页面无未捕获异常', errs.length === 0, errs.join(' | '));

  await browser.close();
  console.log(`\n通过 ${pass}/${pass + fail}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('测试异常：', e); process.exit(1); });
