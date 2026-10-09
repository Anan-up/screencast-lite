/* viewer.report() 未连接时不得发出无效报告（看门狗新鲜度守卫回归）
 *
 * 缺陷回顾（viewer.js#report）：
 * pc 尚未 connected（connecting/failed/…）时，report 仍会发送
 * `{ rtt: signal.rtt }`。主机 onViewerStatus 对这类报告**无条件**刷新
 * `L.lastReport` —— 看门狗的"报告新鲜度"守卫（REPORT_STALE_MS 豁免，
 * 防"后台节流导致报告停了"误杀）被无效报告喂成摆设。当前恰好被
 * `L.lastDecoded < 0` 的前置判定挡住而未产生实害，但那是判定顺序的
 * 巧合：一旦有人调整顺序，守卫即失效。
 *
 * 修复：`if (!pc || pc.connectionState !== 'connected') return out;`
 * —— 未连接时从源头不发。
 *
 * 构造方式（白盒）：fake signal + 全新 vx（不触碰页面自身传输层）。
 * mode='connecting'、pc=null 时调用 report()：
 *   修复后 —— 不发送（sent.length === 0）
 *   修复前 —— 发送一条 {rtt}（sent.length === 1）
 * 附带锁定：relay 模式下 report 同样静默（既有行为，防回归）。
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

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new', protocolTimeout: 60000,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const page = await browser.newPage();
  await page.goto(`${BASE}/view?debug=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.Cast && !!window.Cast.createViewerTransport, { timeout: 15000 });

  const r = await page.evaluate(async () => {
    const sent = [];
    const fakeSignal = { rtt: 7, send: (o) => sent.push(o) };
    const vx = window.Cast.createViewerTransport(fakeSignal);
    vx.attachVideo(document.createElement('video'));

    // 场景 1：connecting（pc=null）→ 不得发送
    await vx.report();
    const sentConnecting = sent.length;

    // 场景 2：relay/relay-blob → 既有静默行为，一并锁定
    const origITS = MediaSource.isTypeSupported;
    MediaSource.isTypeSupported = () => false;
    vx.startRelayPlayback('video/webm;codecs=vp8');
    const mode = vx.mode;
    const before = sent.length;          // 增量计量：上一场景的发送不得污染本条
    await vx.report();
    const sentRelay = sent.length - before;
    MediaSource.isTypeSupported = origITS;

    return { mode, sentConnecting, sentRelay };
  });

  ok('connecting 阶段不发送 viewer-status', r.sentConnecting === 0, `sent=${r.sentConnecting}`);
  ok('relay-blob 模式保持静默（既有行为锁定）', r.mode === 'relay-blob' && r.sentRelay === 0,
     `mode=${r.mode} sent=${r.sentRelay}`);

  console.log(`\n通过 ${pass}/${pass + fail}`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error('测试异常：', e); process.exit(1); });
