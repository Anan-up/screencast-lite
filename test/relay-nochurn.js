/* 中继模式不震荡（P1 回归）
 *
 * 缺陷回顾：切中继是主机侧主动决策（pc failed → enableRelay → relay-begin）。
 * 若大屏此时重走 P2P，会让主机 removeViewer → relayViewers 清空 →
 * sharedRecorder.stop()，把刚建好的中继链路亲手拆掉；新 pc 大概率又失败、
 * 又切中继、又发 relay-begin —— 双方进入"切中继 → 大屏重建 P2P → 又失败"
 * 的震荡，用户看到画面每隔几十秒中断一次。
 *
 * 修复：scheduleRejoin 的**决策 1** —— mode 已是 relay/relay-blob 时，
 * 直接撤销本次 P2P 重建（尊重主机决策），不再往下走到"画面推进判定"。
 *
 * 本用例断言：处于 relay 模式时调用 scheduleRejoin(false)，vx.mode 必须
 * **保持 relay**。若撤掉决策 1，mode 会被翻成 p2p-host（或尝试重建）。
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
  await page.waitForFunction(() => !!window.__vx && !!window.__rejoin, { timeout: 15000 });
  ok('调试把手已就绪', true);

  // 让 vx 进入 relay 模式：直接走 startRelayPlayback（无需真实主机）。
  // MediaSource 在 headless Chromium 下可用，会进入 mode='relay'；
  // 若不可用则降到 'relay-blob' —— 两者都在决策 1 的判定集合里。
  const modeBefore = await page.evaluate(() => {
    window.__rejoin.reset();
    return window.__vx.startRelayPlayback('video/webm;codecs=vp8');
  });
  await new Promise((r) => setTimeout(r, 800));
  const mode0 = await page.evaluate(() => window.__vx.mode);
  console.log('   进入中继后 mode =', mode0);
  ok('已进入中继模式（relay 或 relay-blob）', mode0 === 'relay' || mode0 === 'relay-blob', `mode=${mode0}`);

  // 关键：调用 scheduleRejoin(false)，决策 1 应撤销重建
  await page.evaluate(() => {
    window.__rejoin.reset();
    window.__rejoin.schedule(0, false);   // force=false → 走完整决策链
  });
  await new Promise((r) => setTimeout(r, 2500));   // 等过 delay（≥1200ms）

  const mode1 = await page.evaluate(() => window.__vx.mode);
  const probe = await page.evaluate(() => window.__rejoin.probe());
  console.log('   调用 scheduleRejoin(false) 后 mode =', mode1, ' probe =', JSON.stringify(probe));

  ok('中继模式下 mode 保持不变（未翻成 p2p-host）',
    mode1 === mode0, `before=${mode0} after=${mode1}`);
  ok('重建未被启动（撤销了本次尝试）', probe.rejoinInFlight === false,
    `inFlight=${probe.rejoinInFlight}`);
  ok('尝试计数被回退（未消耗 REJOIN_MAX 配额）', probe.rejoinAttempts === 0,
    `attempts=${probe.rejoinAttempts}`);

  ok('页面无未捕获异常', errs.length === 0, errs.join(' | '));

  await browser.close();
  console.log(`\n通过 ${pass}/${pass + fail}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('测试异常：', e); process.exit(1); });
