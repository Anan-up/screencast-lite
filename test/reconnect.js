/* P0 复现：signal.close() 会让信令层永久失去重连能力
 *
 * 机理：
 *   close() → closedByUser = true
 *   ws.onclose → if (closedByUser) return;   ← 不再排程 connect()
 *   closedByUser 是单向的，connect() 里从不复位
 *
 * 因此 cast.html 的 replaced handler 里调 close() 之后，
 * 用户被永久踢下线，必须刷新页面。
 *
 * 断言：
 *   A) close() 后，即使等待远超退避上限（8s），也不会自动重连  → 复现缺陷
 *   B) reconnectNow() 后，会按退避重连（出现新 ws 且 state 回到 OPEN） → 修复有效
 *   C) close() 的"永久关闭"语义仍然保留（不误伤 beforeunload 场景）
 *
 * 依赖：本用例需要 Chromium + puppeteer-core（**开发依赖**，非运行依赖）。
 * 未安装时打印 SKIP 并以 0 退出，避免 `npm test` 对只装运行依赖的用户硬失败。
 * 需要跑它时：npm i -D puppeteer-core，并保证本机有 chromium。
 */
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c, e) => c ? (pass++, console.log('  \u2713 ' + n))
                          : (fail++, console.log('  \u2717 ' + n + (e ? '  ' + e : '')));

let puppeteer;
try {
  puppeteer = require('puppeteer-core');
} catch {
  console.log('  \u26a0 SKIP: 未安装 puppeteer-core（开发依赖），跳过本用例');
  console.log('         安装后可运行：npm i -D puppeteer-core');
  process.exit(0);
}
// 允许通过 CHROME_PATH 覆盖，默认走常见路径
const CHROME = process.env.CHROME_PATH || '/usr/bin/chromium';

const BASE = process.env.BASE_URL || 'http://localhost:8080';

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new', protocolTimeout: 60000,
    args: ['--no-sandbox', '--use-fake-ui-for-media-stream',
           '--use-fake-device-for-media-stream',
           '--autoplay-policy=no-user-gesture-required'],
  });

  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  await page.goto(`${BASE}/cast?debug=1`, { waitUntil: 'domcontentloaded' });

  // 等信令层就绪
  await page.waitForFunction(
    () => window.__signal && window.__signal.state === 1, { timeout: 15000 });
  ok('初始信令已连接 (state=1)', true);

  // ------ A) close() 后不再重连（复现 P0）------
  await page.evaluate(() => window.__signal.close());
  await sleep(600);
  const stateAfterClose = await page.evaluate(() => window.__signal.state);
  console.log('   close() 后立即 state =', stateAfterClose);

  // 等待超过最大退避（8s）+ 余量，正常应已重连
  await sleep(11000);
  const stateAfterWait = await page.evaluate(() => window.__signal.state);
  console.log('   close() 后等待 11s，state =', stateAfterWait);
  ok('A) 复现 P0：close() 后 11 秒仍为 CLOSED，永不重连',
     stateAfterWait === 3,
     `state=${stateAfterWait}（3=CLOSED，1=OPEN）`);

  // ------ B) reconnectNow() 能恢复（修复有效）------
  // 上一轮如果已修复，__signal 上会有 reconnectNow；否则这里失败
  const hasReconnectNow = await page.evaluate(
    () => typeof window.__signal.reconnectNow === 'function');
  ok('B0) signal 暴露了 reconnectNow()', hasReconnectNow);

  if (hasReconnectNow) {
    await page.evaluate(() => window.__signal.reconnectNow());
    // 注意本步骤走的是 **CLOSED(3) 分支**：上一步 A) 已经把 ws 推到 CLOSED，
    // 而 reconnectNow 对 CLOSED 是**立即 connect()**（没有退避延迟）。
    // （OPEN 分支才会 ws.close() → onclose → 首轮 600ms 退避；
    //   CLOSING 分支摘回调后也立即 connect，其正确性由 reconnect-closing.js 覆盖。）
    // 这里给 6 秒纯属余量，等的是 TCP 握手 + 'open' 事件，而非退避计时。
    let recovered = false;
    for (let i = 0; i < 60; i++) {
      const s = await page.evaluate(() => window.__signal.state);
      if (s === 1) { recovered = true; break; }
      await sleep(100);
    }
    ok('B) reconnectNow() 后自动重连成功 (state 回到 OPEN)', recovered);
  } else {
    ok('B) reconnectNow() 后自动重连成功 (state 回到 OPEN)', false,
       'reconnectNow 不存在，跳过');
  }

  // ------ C) close() 的永久关闭语义仍然保留 ------
  await page.evaluate(() => window.__signal.close());
  await sleep(4000);
  const stateAfterClose2 = await page.evaluate(() => window.__signal.state);
  ok('C) close() 仍保持永久关闭语义（beforeunload 场景不被误伤）',
     stateAfterClose2 === 3, `state=${stateAfterClose2}`);

  ok('页面无未捕获异常', errs.length === 0, errs.join(' | '));

  await browser.close();
  console.log(`\n通过 ${pass}/${pass + fail}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('异常:', e.message, e.stack); process.exit(1); });
