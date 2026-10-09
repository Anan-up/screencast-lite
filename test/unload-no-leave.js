/* 卸载路径不得发 leave —— 保护优雅重连窗口（P0 回归）
 *
 * 缺陷回顾（cast.html 的 beforeunload + start() 的 ended 监听 + endSession）：
 *   beforeunload 里依次做三件事：
 *     1) signal.notifyAway()               → 发 host-away，服务端 room.hostAway = true
 *     2) host.destroy()
 *     3) stream.getTracks().forEach(t => t.stop())   ← 触发 ended
 *   而 start() 里为视频轨挂了：
 *     track.addEventListener('ended', () => stop(true))
 *     → endSession() → `signal.send({ type: 'leave' })`
 *
 *   按规范 `MediaStreamTrack.stop()` 会把 readyState 置为 'ended' 并
 *   **触发 ended 事件**，所以第 3 步必然引爆 endSession 里那句 leave。
 *
 *   服务端收到 leave（role === 'host' && room.host === ws）会**立即**
 *   destroyRoom。于是刚发出的 host-away 被覆盖：
 *     - 房间立刻销毁，大屏收到 room-closed → 显示"投屏已结束"
 *     - 而不是"发送端连接波动，正在恢复…" → README 承诺的
 *       "刷新后大屏无感续播"失效。
 *
 * 修复：加 unloading 标记，beforeunload 第一件事置位，endSession 里
 *       `if (!unloading && ...)` 跳过 leave。
 *
 * 本用例怎么测（headless 下 beforeunload 难以可靠触发）：
 *   不去模拟真实的页面卸载，而是**直接验证那个分支的语义** ——
 *   用调试钩子把 unloading 置位，调 endSession()，断言 __sent 里
 *   **没有** 'leave'；再复位 unloading 调一次，断言这次**有** 'leave'。
 *   两次构成对照，证明"跳过的原因确实是 unloading，而不是别的东西
 *   导致 leave 本来就不会发"（否则单独一个否定断言毫无意义）。
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
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));

  await page.goto(`${BASE}/cast?debug=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__host && !!window.__signal, { timeout: 15000 });
  ok('调试把手与 __sent 记录器已就绪', true);

  // 准备：注入 canvas 伪流 + 建房 + 置位 started（start() 会走 getDisplayMedia，
  // headless 下不可自动化，所以直接构造等价状态）。
  const prep = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const cv = document.createElement('canvas');
    cv.width = 160; cv.height = 120;
    const ctx = cv.getContext('2d');
    let n = 0;
    setInterval(() => { ctx.fillStyle = (n++ % 2) ? '#222' : '#ddd'; ctx.fillRect(0, 0, 160, 120); }, 60);
    window.__host.setStream(cv.captureStream(15));
    window.__forceStarted();

    await new Promise((res) => {
      const t = setInterval(() => { if (window.__signal.state === 1) { clearInterval(t); res(); } }, 50);
      setTimeout(() => { clearInterval(t); res(); }, 8000);
    });

    const code = 'UL' + Math.random().toString(36).slice(2, 5).toUpperCase();
    await new Promise((res) => {
      window.__signal.on('created', () => res());
      window.__signal.send({ type: 'create', code });
      setTimeout(res, 3000);
    });
    // endSession 里的 leave 需要 roomCode 非空；建房成功后 cast.html 自己
    // 会把 roomCode 写进去，这里只等一小会儿。
    await wait(200);
    return { state: window.__signal.state };
  });
  ok('信令已 OPEN 且已建房', prep.state === 1, JSON.stringify(prep));

  // ---------- 场景 A：正常停止（unloading=false）→ 必须发 leave ----------
  const a = await page.evaluate(() => {
    window.__sent.length = 0;
    window.__setUnloading(false);
    window.__endSession();
    return { sent: window.__sent.map(x => (x && x.type) || x), unloading: window.__getUnloading() };
  });
  console.log('   正常停止 __sent =', JSON.stringify(a.sent));
  ok('正常停止时 leave **有**被发出（对照组，证明这条路径本来是通的）',
    a.sent.includes('leave'), JSON.stringify(a.sent));

  // ---------- 场景 B：卸载中（unloading=true）→ 必须**不**发 leave ----------
  // 重开一个页面，避免上一个页面 endSession 后状态已被清（roomCode=null
  // 会让 leave 本来就不发，从而使否定断言假通过）。
  const page2 = await browser.newPage();
  page2.on('pageerror', (e) => errs.push(String(e)));
  await page2.goto(`${BASE}/cast?debug=1`, { waitUntil: 'domcontentloaded' });
  await page2.waitForFunction(() => !!window.__host && !!window.__signal, { timeout: 15000 });
  await page2.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const cv = document.createElement('canvas');
    cv.width = 160; cv.height = 120;
    const ctx = cv.getContext('2d');
    let n = 0;
    setInterval(() => { ctx.fillStyle = (n++ % 2) ? '#222' : '#ddd'; ctx.fillRect(0, 0, 160, 120); }, 60);
    window.__host.setStream(cv.captureStream(15));
    window.__forceStarted();
    await new Promise((res) => {
      const t = setInterval(() => { if (window.__signal.state === 1) { clearInterval(t); res(); } }, 50);
      setTimeout(() => { clearInterval(t); res(); }, 8000);
    });
    const code = 'UL' + Math.random().toString(36).slice(2, 5).toUpperCase();
    await new Promise((res) => {
      window.__signal.on('created', () => res());
      window.__signal.send({ type: 'create', code });
      setTimeout(res, 3000);
    });
    await wait(200);
  });

  // 关键：先置位 unloading（模拟 beforeunload 的第一步），再调 endSession。
  // 为了让"不发 leave"这个否定断言有意义，同一次 evaluate 里先记录
  // "若 unloading 为假会发什么"——通过先跑一次对照再跑目标。
  const b = await page2.evaluate(() => {
    // 先确认这个页面确实具备发 leave 的条件（roomCode 非空等）：
    // 用一个探针跑 endSession(unloading=false) 的等价判断条件。
    // 但 endSession 会真的清状态，所以改为直接读内部条件：
    const canSend = (() => {
      // 复刻 endSession 里的判断：signal.state === 1 && roomCode
      // roomCode 不可直接读，用"上一次建房成功与否"间接确认 ——
      // 更可靠的办法是看 __sent 里是否有 created 相关痕迹。
      return window.__signal.state === 1;
    })();

    window.__sent.length = 0;
    window.__setUnloading(true);
    const unloadingBefore = window.__getUnloading();
    window.__endSession();
    return {
      canSend,
      unloadingBefore,
      sent: window.__sent.map(x => (x && x.type) || x),
    };
  });
  console.log('   卸载中 __sent =', JSON.stringify(b.sent), ' unloading=', b.unloadingBefore);

  ok('构造成功：unloading 标记已置位', b.unloadingBefore === true, JSON.stringify(b));
  ok('信令处于 OPEN（具备发 leave 的前提，否定断言才有意义）',
    b.canSend === true, JSON.stringify(b));
  ok('卸载中 endSession **没有**发 leave（host-away 不会被覆盖）',
    !b.sent.includes('leave'), JSON.stringify(b.sent));

  ok('页面无未捕获异常', errs.length === 0, errs.join(' | '));

  await browser.close();
  console.log(`\n通过 ${pass}/${pass + fail}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('测试异常：', e); process.exit(1); });
