// 测试：主机结束投屏后，接收端是否彻底销毁传输层（对应 view.html onHostGone 修复）
//
// 为什么要测：若只清 video 而不 destroy()，vx.mode 会停在 'p2p-host'，
// 之后 connectionState→failed 触发 scheduleRejoin(false) 时会错走"P2P 重建"
// 分支（决策 1 只认 === 'relay'），去为一个已经结束的会话空转重试。
//
// 手法：起真 host + 真 viewer（viewer 需先 join 才有模式），
// 然后让 host 关页 → 服务端 broadcast room-closed → viewer 的 onHostGone 被触发。
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
  // 关于启动参数（曾误留 --use-fake-ui-for-media-stream / --auto-select-desktop-capture-source）：
  //   --use-fake-ui-for-media-stream 只自动批准 getUserMedia 的权限弹窗，
  //   **不生效于** getDisplayMedia 的"选择要共享的屏幕"交互；
  //   而本案的流是 canvas.captureStream() 伪造的（见下），根本没有采集交互。
  //   两个参数在此用例中完全不影响行为，已删除，避免读者误以为本用例依赖真实采集。
  try { browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox'] }); }
  catch (e) { console.log('SKIP: 无法启动浏览器（' + e.message + '）'); process.exit(0); }

  const castPage = await browser.newPage();
  const viewPage = await browser.newPage();

  await castPage.goto(`${BASE}/cast?debug=1`, { waitUntil: 'domcontentloaded' });
  await castPage.waitForFunction(() => window.__signal && window.__signal.state === 1, { timeout: 15000 });

  // 伪造一条流并直接建房（绕过 getDisplayMedia 的授权交互，headless 下更稳）
  const code = await castPage.evaluate(async () => {
    const cv = document.createElement('canvas');
    cv.width = 320; cv.height = 240;
    cv.getContext('2d').fillRect(0, 0, 320, 240);
    window.__host.setStream(cv.captureStream(15));
    // 复用页面自身的建房逻辑
    const m = await new Promise((res) => {
      const t = setTimeout(() => res(null), 5000);
      window.__signal.on('created', (msg) => { clearTimeout(t); res(msg); });
      window.__signal.send({ type: 'create' });
    });
    return m && m.code;
  }).catch(() => null);

  if (!code) { console.log('SKIP: 未能建房'); await browser.close(); process.exit(0); }
  console.log('   已建房，房间码 =', code);

  await viewPage.goto(`${BASE}/view?r=${code}&debug=1`, { waitUntil: 'domcontentloaded' });
  // 注意：view.html 只暴露 __vx / __rejoin，**不**暴露 __signal（那是 cast.html 的把手）
  await viewPage.waitForFunction(() => !!window.__vx, { timeout: 15000 });
  // 走页面自身的 join 流程（读 URL 的 ?r= 自动预填房间码）
  await viewPage.evaluate(() => {
    const btn = document.querySelector('#btnJoin');
    if (btn) btn.click();
  });
  await new Promise((r) => setTimeout(r, 3000));

  // 让主机判定为已连接（伪造的 canvas 流在 headless 下能真正建起 P2P）
  //
  // ⚠️ 关键：把**旧 pc 实例**先存到 window 上再触发 teardown。
  // 因为 __vx 现在是 getter，`window.__vx.pc` 在 onHostGone 之后读到的
  // 是**新 vx** 的 pc（恒为 null）—— 那样断言"pc 为 null"其实什么都没证明，
  // 它只说明"新 vx 还没建 pc"。真正要测的是**旧实例被 destroy 关掉了**。
  const before = await viewPage.evaluate(() => {
    window.__oldPc = window.__vx.pc;          // 抓住旧实例的引用
    return { mode: window.__vx.mode, hasPc: !!window.__oldPc };
  });
  console.log('   结束前：mode =', before.mode, ' pc 存在 =', before.hasPc);

  // 触发 room-closed：主机发 leave
  await castPage.evaluate(() => window.__signal.send({ type: 'leave' }));
  await new Promise((r) => setTimeout(r, 1500));

  const after = await viewPage.evaluate(() => {
    const old = window.__oldPc;
    return {
      mode: window.__vx.mode,
      newPcIsNull: window.__vx.pc === null,
      // 旧实例的真实 state：close() 之后应为 'closed'
      oldPcState: old ? old.connectionState : '(无旧实例)',
      oldPcIsClosed: old ? old.connectionState === 'closed' : null,
    };
  });
  const afterVideo = await viewPage.evaluate(() => {
    const v = document.querySelector('#video');
    return { srcObject: !!v.srcObject, src: v.getAttribute('src') };
  });
  console.log('   结束后：mode =', after.mode, ' 新 pc =', after.newPcIsNull ? 'null' : '非 null',
    ' 旧 pc.connectionState =', after.oldPcState, ' video =', JSON.stringify(afterVideo));

  ok('收到 room-closed 后 mode 复位为 connecting（修复前停留 p2p-host）',
    after.mode === 'connecting', `mode=${after.mode}`);
  ok('旧 pc 实例的 connectionState 已成为 closed（真正测到 destroy）',
    after.oldPcIsClosed === true, `oldPcState=${after.oldPcState}`);
  ok('新 vx 尚未建立 pc（干净状态）', after.newPcIsNull === true);
  ok('video.srcObject 已清空', afterVideo.srcObject === false, JSON.stringify(afterVideo));
  ok('vx 已换成新的传输层实例（可继续接受新 offer）',
    await viewPage.evaluate(() => !!window.__vx && typeof window.__vx.onOffer === 'function'));

  await browser.close();
  console.log(`\n通过 ${pass}/${pass + fail}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('测试异常：', e); process.exit(1); });
