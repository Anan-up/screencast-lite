// 测试：#2 换码时清传输层 peer（防幽灵大屏）
//
// 背景：btnNewCode handler 早期只 clear(viewerMap) —— 只清了 UI 层。
// host.peers 里每个 viewerId 仍挂着旧 RTCPeerConnection / 看门狗 / 中继登记。
// 旧大屏若复用同一 id 回归，addViewer 会先 removeViewer 兜住；但**不复用**时
// 这些条目永远不被回收，于是 stats / peerIds 长期虚高、与 viewerMap 脱钩。
// 这正是 README「信令断开时必须同时清三处状态」警告的第三处。
//
// 手法：用 ?debug=1 的 __forceStarted() 把 started 置位（headless 下无法走
// getDisplayMedia 授权交互），塞 3 个假 viewer 进传输层，点「换一个」，
// 断言 peers 归零。
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
function ok(n, c, e) { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  → ' + e : '')); } }

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

  const r = await page.evaluate(async () => {
    // 伪造一条流并塞 3 个 viewer（模拟 3 台大屏已接入传输层）
    const cv = document.createElement('canvas');
    cv.width = 160; cv.height = 120;
    cv.getContext('2d').fillRect(0, 0, 160, 120);
    window.__host.setStream(cv.captureStream(10));
    for (const id of ['ghost-1', 'ghost-2', 'ghost-3']) {
      await window.__host.addViewer(id);
    }
    const before = window.__host.peerIds ? window.__host.peerIds.length : -1;
    const statsBefore = window.__host.stats;

    // 置位 started，否则 btnNewCode 会在 `if (!started) return` 处早退。
    // 同时解除按钮的 disabled：renderRoom() 在没有房间码时会禁用它，
    // 而 headless 下我们并没有真的建房（也就没有房间码）。
    // 这两步都只是"让点击能落到 handler 里"，不改变 handler 自身逻辑。
    window.__forceStarted();
    const btn = document.querySelector('#btnNewCode');
    btn.disabled = false;
    btn.click();

    return {
      before,
      after: window.__host.peerIds ? window.__host.peerIds.length : -1,
      statsBefore,
      statsAfter: window.__host.stats,
    };
  });

  console.log('   换码前 peers =', r.before, ' 换码后 peers =', r.after);
  console.log('   stats 前 =', JSON.stringify(r.statsBefore), ' 后 =', JSON.stringify(r.statsAfter));

  ok('#2 前提成立：换码前传输层有 3 条 peer', r.before === 3, `before=${r.before}`);
  ok('#2 换码后传输层 peers 被清空（修复前仍残留 3 条）', r.after === 0, `after=${r.after}`);
  ok('#2 stats.total 同步归零（不再与 UI 脱钩）', r.statsAfter.total === 0, `total=${r.statsAfter.total}`);
  ok('#2 stats.failed 归零（无残留条目被计入）', r.statsAfter.failed === 0, `failed=${r.statsAfter.failed}`);

  ok('页面无未捕获异常', errs.length === 0, errs.join(' | '));

  await browser.close();
  console.log(`\n通过 ${pass}/${pass + fail}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('测试异常：', e); process.exit(1); });
