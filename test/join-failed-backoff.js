/**
 * 浏览器：join-failed → 退避重试（而非 delay=0 洪水）+ force 抢占的计数回退
 *
 * 背景（Bug 1）：
 *   host-away 优雅窗口内，服务端 room.host 被置 null（旧 ws 已 close），
 *   大屏因 pc failed / 强制重建发出 join 时必收到 join-failed '主机尚未开始投屏'。
 *   旧代码在该分支调 scheduleRejoin(true)：delay=0、不消耗 rejoinAttempts、
 *   不进 REJOIN_MAX —— "join-failed → 下一 tick 立即 join → join-failed → …"
 *   的无限快速重试，唯一节流只剩网络 RTT（局域网下每秒数百次）。
 *   修复后走 scheduleRejoin(false)：1200ms 起退避、计入 REJOIN_MAX。
 *
 *   本用例直接构造该场景（host 发 host-away 后整页关闭 → room.host=null、
 *   房间保留 ≤15s），统计固定窗口内 doJoin 的出站次数（__joinLog）。
 *   A/B：把 handler 改回 scheduleRejoin(true) 后，窗口内 join 数从 ≤5 涨到 ≥50。
 *
 * 背景（Bug 2）：
 *   scheduleRejoin(force) 抢占挂起定时器时无条件 rejoinAttempts--，
 *   但 force 分支创建的定时器并没有 ++ —— 同一 tick 连续两次 force
 *   （host-return 与 join-failed 撞车）会多减一次，REJOIN_MAX 限流失效。
 *   修复后用 rejoinTimerFromForce 标记来源，只回退 !force 留下的 ++。
 *   A/B：摘掉标记判断后，本用例的 attempts 从 before-1 变成 before-2。
 */
let puppeteer;
try {
  puppeteer = require('puppeteer-core');
} catch {
  console.log('  ⚠ SKIP: 未安装 puppeteer-core（开发依赖）');
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
           '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
           '--autoplay-policy=no-user-gesture-required'],
  });

  // ---------- 1. 真 host 建房（canvas 伪流） ----------
  const hostPage = await browser.newPage();
  await hostPage.goto(`${BASE}/cast?debug=1`, { waitUntil: 'domcontentloaded' });
  await hostPage.waitForFunction(() => !!window.__host, { timeout: 15000 });
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
    const code = 'JB' + Math.random().toString(36).slice(2, 5).toUpperCase();
    return await new Promise((res) => {
      window.__signal.on('created', (m) => res((m && m.code) || code));
      window.__signal.send({ type: 'create', code });
      setTimeout(() => res(code), 3000);
    });
  });
  ok('真 host 建房成功', !!code && code.length >= 4, String(code));

  // ---------- 2. view join 成功（joined=true 是后续分支的前提） ----------
  const viewPage = await browser.newPage();
  const errs = [];
  viewPage.on('pageerror', (e) => errs.push(String(e)));
  await viewPage.goto(`${BASE}/view?r=${code}&debug=1`, { waitUntil: 'domcontentloaded' });
  await viewPage.waitForFunction(() => !!window.__rejoin && !!window.__signal && !!window.__joinLog, { timeout: 15000 });
  await viewPage.waitForFunction(() => window.__signal.state === 1, { timeout: 15000 });
  await wait(1500);
  const joinBase = await viewPage.evaluate(() => window.__joinLog.length);
  ok('view 初次 join 已发出（joinLog 有记录）', joinBase >= 1, 'joinLog=' + joinBase);

  // ---------- 3. 构造"host-away 优雅窗口 + room.host=null" ----------
  // notifyAway 先于关页：服务端标记 hostAway；整页关闭后 ws close，
  // close 处理器把 room.host 置 null 并保留房间 ≤15s（HOST_AWAY_GRACE_MS）。
  // 此后 view 的每次 join 都稳定收到 join-failed '主机尚未开始投屏'。
  await hostPage.evaluate(() => { window.__signal.notifyAway(); });
  await wait(250);                    // 确保 host-away 先于 close 到达服务端
  await hostPage.close();
  await wait(300);                    // 等服务端 close 处理落地（room.host=null）

  // ---------- 4. Bug 1：统计退避窗口内的 join 出站次数 ----------
  const win = await viewPage.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const R = window.__rejoin;
    R.reset();
    const log0 = window.__joinLog.length;
    const t0 = Date.now();
    R.schedule(0, true);              // 强制重建 → doJoin → 必收 join-failed → 链启动
    await wait(4000);                 // 观测窗：退避路径应只有 2~3 次 join
    const p = R.probe();
    return {
      joins: window.__joinLog.length - log0,
      attempts: p.rejoinAttempts,
      inFlight: p.rejoinInFlight,
      elapsed: Date.now() - t0,
    };
  });
  console.log('   4s 窗口 =', JSON.stringify(win));
  // 退避路径：t=0 join → failed → T1(1200) 首判无基准撤销重排 → T2(1200) join
  // → failed → T3(2400) → 窗口结束时 join 共 2~3 次。
  // 旧实现（force 洪水）：RTT 节流，窗口内几十到几百次。阈值 5 足够分离。
  ok('4s 窗口内 join 次数 ≤5（退避限速，非 RTT 洪水）', win.joins >= 1 && win.joins <= 5, 'joins=' + win.joins);
  // 退避路径必须消耗配额：attempts 因真实排程递增（否则说明走了 force 旁路）
  ok('重建计入配额（rejoinAttempts > 0）', win.attempts >= 1, 'attempts=' + win.attempts);
  // 链条保持存活：rejoinInFlight 不能被错误清零（清零会让下一条 join-failed
  // 跌进 showJoinError 分支、重试链彻底断掉——这是对原始处方的关键修正）
  ok('退避链存活（rejoinInFlight === true）', win.inFlight === true, 'inFlight=' + win.inFlight);

  // ---------- 5. Bug 2：同一 tick 连续两次 force，不得多减 attempts ----------
  const bug2 = await viewPage.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const R = window.__rejoin;
    R.reset();
    // 先让链条自然积累到 attempts >= 2 且挂着 !force 定时器：
    // schedule(false) → attempts=1 → 首判无基准撤销（--回 0）并重排（++回 1）
    // → 二判画面已死 → doJoin → join-failed → 再排 → attempts=2, timerPending
    R.schedule(0, false);
    const t0 = Date.now();
    let p;
    while (Date.now() - t0 < 8000) {
      p = R.probe();
      if (p.rejoinAttempts >= 2 && p.timerPending) break;
      await wait(100);
    }
    const before = R.probe().rejoinAttempts;
    // 撞车构造：同一 tick 内连续两次 force。
    // 第 1 次抢占 !force 定时器 → 应 -1（回退它留下的 ++）；
    // 第 2 次抢占的是 force 定时器 → 不应再 -1（它没有 ++ 过）。
    R.schedule(0, true);
    R.schedule(0, true);
    const after = R.probe().rejoinAttempts;
    R.reset();                        // 清掉刚挂上的 force 定时器，避免干扰收尾
    return { before, after, expect: Math.max(0, before - 1) };
  });
  console.log('   Bug2 计数 =', JSON.stringify(bug2));
  ok('构造成功：抢占前 attempts ≥ 2', bug2.before >= 2, 'before=' + bug2.before);
  ok('force 抢占 force 定时器不多减计数', bug2.after === bug2.expect,
     `before=${bug2.before} after=${bug2.after} expect=${bug2.expect}`);

  ok('页面无未捕获异常', errs.length === 0, errs.join(' | '));

  console.log(`\n通过 ${pass}/${pass + fail}`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error('测试异常：', e); process.exit(1); });
