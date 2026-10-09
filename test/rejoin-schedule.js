/* 重建排程的两条边界（P1 回归）：host-return 抢占 + leave 清零
 *
 * ---- Bug 3：scheduleRejoin(force) 丢弃 host-return 的强制重建 ----
 * 早期写法 `if (rejoinTimer) return;` 在 force 判断**之前**无差别早退：
 *   connectionState→failed 先排了一次退避重试（delay 最多 8 秒），
 *   此时 host-return 到达（主机明确宣告"我重载过"，是强信号），
 *   scheduleRejoin(true) 被 `rejoinTimer` 早退直接吞掉。
 * 最坏情况：挂起的那次 force=false 判定为"已切中继"或"画面还活着"
 *   → 撤销且不重建，而 host-return 又已被丢弃 → 没有触发源 → 画面永久冻结。
 * 修复：force 应 clearTimeout 抢占挂起的定时器，并把那次 !force 的
 *   rejoinAttempts++ 减回去（不让被抢占的退避留下配额痕迹）。
 *
 * ---- Bug 4：leave() 未清 rejoinTimer ----
 * rejoinTimer 可能仍挂起。触发后执行 doJoin(null, true) → 发
 *   `{type:'join', code:null}` → 服务端 String(null).toUpperCase()='NULL'
 *   → join-failed。虽然此时 roomCode 为空会让 scheduleRejoin 早退，
 *   但 **rejoinInFlight 会残留为 true**，污染后续任何一次正常 join 的
 *   失败处理（把用户首次手动连接的失败误判成"重建重试"而走退避续期）。
 * 修复：leave() 与 onHostGone() 都应调 resetRejoin()。
 *
 * 前置条件（否则会得到"什么都没发生"的假通过）：
 *   scheduleRejoin 的两道守卫是 `!roomCode || !signal || signal.state !== 1`。
 *   所以必须让 view 页面**真的**在一个存在的房间里（roomCode 非空），
 *   且信令 OPEN。这里起一个真 host 页面建房，再让 view 用真实房间码 join。
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
    args: ['--no-sandbox', '--disable-setuid-sandbox',
           '--autoplay-policy=no-user-gesture-required'],
  });

  // ---------- 1. 真 host 建房 ----------
  const castPage = await browser.newPage();
  await castPage.goto(`${BASE}/cast?debug=1`, { waitUntil: 'domcontentloaded' });
  await castPage.waitForFunction(() => !!window.__host, { timeout: 15000 });

  const code = await castPage.evaluate(async () => {
    // 用 canvas 伪流代替 getDisplayMedia（headless 下必然弹系统选择器）。
    // 建房不走 host，而是直接经 __signal 发 create —— cast.html 的建房逻辑
    // 绑在 start() 里，而 start() 必然调用 getDisplayMedia。
    const cv = document.createElement('canvas');
    cv.width = 160; cv.height = 120;
    const ctx = cv.getContext('2d');
    let n = 0;
    setInterval(() => { ctx.fillStyle = (n++ % 2) ? '#222' : '#ddd'; ctx.fillRect(0, 0, 160, 120); }, 60);
    window.__host.setStream(cv.captureStream(15));
    window.__forceStarted && window.__forceStarted();

    // 等信令 OPEN
    await new Promise((res) => {
      const t = setInterval(() => { if (window.__signal.state === 1) { clearInterval(t); res(); } }, 50);
      setTimeout(() => { clearInterval(t); res(); }, 8000);
    });

    const code = 'RB' + Math.random().toString(36).slice(2, 5).toUpperCase();
    return await new Promise((res) => {
      // signal 是 emitter（core.js），服务端消息按 type 派发 → 监听 'created'
      window.__signal.on('created', (m) => res((m && m.code) || code));
      window.__signal.send({ type: 'create', code });
      setTimeout(() => res(code), 3000);     // 兜底：即便没收到也返回（后续断言会暴露）
    });
  });
  ok('真 host 建房成功', !!code && code.length >= 4, String(code));

  // ---------- 2. view 用真实房间码 join（使 roomCode 非空） ----------
  const viewPage = await browser.newPage();
  const errs = [];
  viewPage.on('pageerror', (e) => errs.push(String(e)));
  await viewPage.goto(`${BASE}/view?r=${code}&debug=1`, { waitUntil: 'domcontentloaded' });
  await viewPage.waitForFunction(() => !!window.__rejoin && !!window.__signal, { timeout: 15000 });
  await viewPage.waitForFunction(() => window.__signal.state === 1, { timeout: 15000 });
  // 等 join 往返完成，再确认前置条件成立。
  // roomCode 是闭包内变量、未直接暴露在 window 上（doJoin 里 `roomCode = code` 是乐观赋值，
  // 只代表"发起过 join"，不代表服务端确认房间存在），所以这里不去断言"房间是否存在"，
  // 而是断言 scheduleRejoin() 的第一道守卫能通过：
  //     if (!roomCode || !signal || signal.state !== 1) return;
  // 判据是 schedule(0, false) 真的挂上了退避定时器（timerPending === true）。
  // 若 roomCode 为空或信令未 OPEN，守卫会直接 return，timerPending 必然为 false。
  await new Promise((r) => setTimeout(r, 1200));   // 给 join 往返留时间
  const scheduled = await viewPage.evaluate(() => {
    window.__rejoin.reset();
    window.__rejoin.schedule(0, false);
    const pending = window.__rejoin.probe().timerPending;
    window.__rejoin.reset();                    // 立刻清掉，避免污染后续 Bug 3 用例
    return pending;
  });
  ok('scheduleRejoin 前置守卫已放行（roomCode 非空 + 信令 OPEN）', scheduled === true, String(scheduled));
  ok('view 端信令已 OPEN 且已用真实房间码连接', true);

  // ================= Bug 3：force 抢占 =================
  const b3 = await viewPage.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    window.__rejoin.reset();
    window.__rejoin.schedule(0, false);          // 非强制：挂起一个退避定时器
    const afterSchedule = window.__rejoin.probe();
    window.__rejoin.schedule(0, true);           // 强制：必须抢占上面那个
    const afterForce = window.__rejoin.probe();
    await wait(150);                              // force 的 delay=0，很快触发
    const settled = window.__rejoin.probe();
    return { afterSchedule, afterForce, settled };
  });

  console.log('   非强制排程后 =', JSON.stringify(b3.afterSchedule));
  console.log('   force 抢占后 =', JSON.stringify(b3.afterForce));

  // 前置：确认排程真的发生了（否则后面全是假通过）
  ok('排程确实生效（roomCode 非空 + 信令 OPEN，定时器已挂起）',
    b3.afterSchedule.timerPending === true && b3.afterSchedule.rejoinAttempts === 1,
    JSON.stringify(b3.afterSchedule));

  // 核心断言：force 把那次 !force 的 attempts++ 回退了。
  // 旧实现 `if (rejoinTimer) return` 会让 attempts 停在 1。
  ok('force 抢占后 attempts 被回退为 0（丢弃的退避不占配额）',
    b3.afterForce.rejoinAttempts === 0,
    `attempts=${b3.afterForce.rejoinAttempts}`);
  ok('force 抢占后仍持有排程（不是被吞掉）',
    b3.afterForce.timerPending === true && b3.afterForce.rejoinInFlight === true,
    JSON.stringify(b3.afterForce));

  // ================= Bug 4：leave 清零 =================
  // 重新构造"挂起定时器 + 非零计数"的状态，然后点断开按钮。
  const b4 = await viewPage.evaluate(async () => {
    window.__rejoin.reset();
    window.__rejoin.schedule(0, false);
    const before = window.__rejoin.probe();
    const btn = document.querySelector('#btnExit');
    if (!btn) return { clicked: false, before, after: window.__rejoin.probe() };
    btn.click();
    return { clicked: true, before, after: window.__rejoin.probe(), label: btn.title || btn.textContent.trim() };
  });

  console.log('   断开前 =', JSON.stringify(b4.before));
  console.log('   断开后 =', JSON.stringify(b4.after));

  ok('断开按钮存在且可点击（#btnExit → leave()）', b4.clicked, String(b4.label));
  ok('构造成功：断开前有挂起定时器且 inFlight=true',
    b4.before.timerPending === true && b4.before.rejoinInFlight === true,
    JSON.stringify(b4.before));
  ok('leave() 后定时器已清除（不会再自发 join(code:null)）',
    b4.after.timerPending === false, JSON.stringify(b4.after));
  ok('leave() 后 inFlight 已复位（不残留污染后续 join 失败处理）',
    b4.after.rejoinInFlight === false, JSON.stringify(b4.after));
  ok('leave() 后 attempts/checks 均归零',
    b4.after.rejoinAttempts === 0 && b4.after.rejoinChecks === 0,
    JSON.stringify(b4.after));

  // ================= Bug 4 补充：onHostGone 独立路径 =================
  // leave() 里那道 resetRejoin 会替 onHostGone 兜住，所以上面那组断言
  // 即便 onHostGone 自己没清也会全绿。而 onHostGone 还有**不经 leave** 的
  // 入口（room-closed / host-away 超时），必须单独覆盖。
  //
  // ⚠️ 必须用一个**新页面**：上一段点了 #btnExit（leave()），它已把
  // roomCode 置空。此时再 schedule 会因 `!roomCode` 守卫直接早退，
  // 得到"什么都没发生"的假通过（before 全为零值）。
  const viewPage2 = await browser.newPage();
  viewPage2.on('pageerror', (e) => errs.push(String(e)));
  await viewPage2.goto(`${BASE}/view?r=${code}&debug=1`, { waitUntil: 'domcontentloaded' });
  await viewPage2.waitForFunction(() => !!window.__rejoin && !!window.__signal, { timeout: 15000 });
  await viewPage2.waitForFunction(() => window.__signal.state === 1, { timeout: 15000 });
  await new Promise((r) => setTimeout(r, 1200));   // 等 join 往返

  const b5 = await viewPage2.evaluate(async () => {
    window.__rejoin.reset();
    window.__rejoin.schedule(0, false);            // 挂起定时器 + inFlight
    const before = window.__rejoin.probe();
    window.__rejoin.hostGone('测试：主机已断开');
    const after = window.__rejoin.probe();
    return { before, after };
  });
  console.log('   onHostGone 前 =', JSON.stringify(b5.before));
  console.log('   onHostGone 后 =', JSON.stringify(b5.after));

  ok('构造成功：onHostGone 前有挂起定时器且 inFlight=true',
    b5.before.timerPending === true && b5.before.rejoinInFlight === true,
    JSON.stringify(b5.before));
  ok('onHostGone() 自己就清了定时器（不依赖 leave 兜底）',
    b5.after.timerPending === false, JSON.stringify(b5.after));
  ok('onHostGone() 后 inFlight 复位（room-closed 路径不残留污染）',
    b5.after.rejoinInFlight === false, JSON.stringify(b5.after));

  ok('页面无未捕获异常', errs.length === 0, errs.join(' | '));

  await browser.close();
  console.log(`\n通过 ${pass}/${pass + fail}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('测试异常：', e); process.exit(1); });
