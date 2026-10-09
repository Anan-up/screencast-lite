// 测试：新加入的大屏是否拿到用户当前选择的画质（对应 host.js 硬编码 4Mbps 的修复）
//
// 手法：不真采集屏幕（headless 下不稳定），而是直接给 host 一条**伪造的
// MediaStream**（from canvas.captureStream，headless 下稳定可用），
// 然后调用 addViewer，读回 sender 的 maxBitrate/maxFramerate 做断言。
// 这样测的是 makePc → tuneSender 这条链，与真实投屏路径完全一致。
//
// 依赖：需要 Chromium + puppeteer-core（**开发依赖**）。未安装时打印 SKIP 并以
// 0 退出，**不会**让 npm test 硬失败（见 README「跑测试」）。
let puppeteer;
try { puppeteer = require('puppeteer-core'); }
catch {
  console.log('  \u26a0 SKIP: 未安装 puppeteer-core（开发依赖）');
  process.exit(0);
}

const BASE = process.env.BASE_URL || 'http://localhost:8080';
const CHROME = process.env.CHROME_PATH || '/usr/bin/chromium';

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}

(async () => {
  let browser;
  try { browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox'] }); }
  catch (e) { console.log('SKIP: 无法启动浏览器（' + e.message + '）'); process.exit(0); }

  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));

  await page.goto(`${BASE}/cast?debug=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__signal && window.__signal.state === 1, { timeout: 15000 });
  ok('初始信令已连接', true);

  // 用 canvas.captureStream 伪造一条视频流塞给 host（headless 下可控且稳定）
  const result = await page.evaluate(async () => {
    const cv = document.createElement('canvas');
    cv.width = 320; cv.height = 240;
    const ctx = cv.getContext('2d');
    let tick = 0;
    setInterval(() => { ctx.fillStyle = (tick++ % 2) ? '#000' : '#fff'; ctx.fillRect(0, 0, 320, 240); }, 100);
    const fake = cv.captureStream(30);

    window.__host.setStream(fake);

    async function bitrateForViewer() {
      const id = 'v-test';
      await window.__host.addViewer(id);
      const entry = window.__host.getPeers().get(id);
      if (!entry || !entry.pc) return null;
      const senders = entry.pc.getSenders().filter((s) => s.track && s.track.kind === 'video');
      if (!senders.length) return null;
      const p = senders[0].getParameters();
      return p.encodings && p.encodings[0]
        ? { bitrate: p.encodings[0].maxBitrate, fps: p.encodings[0].maxFramerate }
        : null;
    }

    const out = {};

    // ① 默认档（standard = 4Mbps / 30fps）
    window.__host.reset();
    document.querySelector('#selQuality').value = 'standard';
    document.querySelector('#selFps').value = '30';
    out.standard = await bitrateForViewer();

    // ② 切到「流畅」1.5Mbps / 15fps，再让**新**大屏加入 —— 关键用例
    window.__host.reset();
    document.querySelector('#selQuality').value = 'smooth';
    document.querySelector('#selFps').value = '15';
    out.smooth = await bitrateForViewer();

    // ③ 切到「超清」15Mbps / 60fps
    window.__host.reset();
    document.querySelector('#selQuality').value = 'ultra';
    document.querySelector('#selFps').value = '60';
    out.ultra = await bitrateForViewer();

    window.__host.reset();
    return out;
  });

  console.log('   实测各档位 =', JSON.stringify(result));

  ok('① 默认档新大屏拿到 4Mbps', result.standard && result.standard.bitrate === 4_000_000,
    JSON.stringify(result.standard));
  ok('② 选「流畅」后新加入的大屏拿到 1.5Mbps（修复前恒为 4Mbps）',
    result.smooth && result.smooth.bitrate === 1_500_000, JSON.stringify(result.smooth));
  ok('② fps 同步为 15（修复前恒为 30）',
    result.smooth && result.smooth.fps === 15, JSON.stringify(result.smooth));
  ok('③ 选「超清」后新大屏拿到 15Mbps',
    result.ultra && result.ultra.bitrate === 15_000_000, JSON.stringify(result.ultra));
  ok('③ fps 同步为 60',
    result.ultra && result.ultra.fps === 60, JSON.stringify(result.ultra));

  ok('页面无未捕获异常', errs.length === 0, errs.join(' | '));

  await browser.close();
  console.log(`\n通过 ${pass}/${pass + fail}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('测试异常：', e); process.exit(1); });
