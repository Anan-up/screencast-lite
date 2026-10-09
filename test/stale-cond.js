/* forceStale 的双条件必须**同时**成立（P1 回归）
 *
 * 缺陷回顾：早期 forceStale 的实现把 lastVideoTime 置成 -1e9，于是
 * `t > lastVideoTime + 0.05`（t = video.currentTime）**恒为 true** ——
 * 停滞判定退化成了"只看时间条件"，推进条件形同虚设。
 * 结果：测试断言 `isPictureAlive() === false` 会"碰巧"通过，
 * 掩盖了推进条件从未被真正验证这一事实。
 *
 * 本用例的断言方式（关键）：
 *   不能只断言最终结果 false（任一子条件为假都能得到 false）。
 *   必须**独立**断言 staleConditions() 返回的两个条件**同时**为假，
 *   并用 forceStaleDrift() 反例证明旧写法下 advanced 恒真。
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

  await page.goto(`${BASE}/view?r=TEST&debug=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__rejoin, { timeout: 15000 });
  ok('调试把手 __rejoin 已就绪', true);

  // ---- 1) 正常构造停滞：两个子条件必须同时为假 ----
  const cond = await page.evaluate(() => {
    window.__rejoin.forceStale(10);      // lastVideoTime = 当前值、lastVideoAt 推后 10s
    return window.__rejoin.staleConditions();
  });
  console.log('   staleConditions =', JSON.stringify(cond));

  ok('时间条件 withinWindow 为假（已超出新鲜窗口）', cond.withinWindow === false);
  ok('推进条件 advanced 为假（currentTime 未推进）', cond.advanced === false);
  ok('有基准 hasBaseline 为真（否则会走"无从判断"的乐观分支）', cond.hasBaseline === true);

  // ---- 2) 最终判定确实为 false ----
  const alive = await page.evaluate(() => window.__rejoin.alive());
  ok('isPictureAlive() 判定为 false（确认停滞）', alive === false, `alive=${alive}`);

  // ---- 3) 反例：旧实现（lastVideoTime = -1e9）下 advanced 恒真 ----
  const drift = await page.evaluate(() => {
    window.__rejoin.forceStale(10);
    window.__rejoin.forceStaleDrift();   // 复刻旧写法：lastVideoTime = -1e9
    return window.__rejoin.staleConditions();
  });
  console.log('   旧写法下 staleConditions =', JSON.stringify(drift));

  ok('反例成立：旧写法下 advanced 恒为真（推进条件形同虚设）', drift.advanced === true,
    `advanced=${drift.advanced}`);
  ok('反例说明：此时只剩时间条件在起作用（withinWindow 仍为假）',
    drift.withinWindow === false);

  ok('页面无未捕获异常', errs.length === 0, errs.join(' | '));

  await browser.close();
  console.log(`\n通过 ${pass}/${pass + fail}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('测试异常：', e); process.exit(1); });
