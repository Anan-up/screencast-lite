/* 中继降级链路：blob 定时器洪水 / addSourceBuffer 失败降级 / destroy 后无残留
 *
 * 覆盖三个缺陷（均属 viewer.js 的中继播放路径）：
 *
 * Bug A（scheduleBlobPlay 的 clearTimeout 重排洪水）：
 *   旧实现每个分片到达都 clearTimeout(blobTimer) 再 setTimeout(1000)。
 *   分片每 120ms 一个（host 端 MediaRecorder.start(120)），只要
 *   120ms < 1000ms，定时器永远到不了点 —— blobParts 无限堆积、
 *   videoEl.src 永不设置，用户面对"推流正常却永久黑屏"。
 *   修复：已有挂起定时器时直接返回；回调开头置 null 放行后续排程。
 *
 * Bug B（addSourceBuffer 失败不降级）：
 *   isTypeSupported=true 不保证 SourceBuffer 真能建出来。旧实现 catch 里
 *   只 emit relay-error：sourceBuffer 恒 null → flush() 永远早退 →
 *   queue 堆到 120 封顶 → 永久黑屏，没有回退路径。
 *   修复：catch 里降级 relay-blob，把 queue 里的已到达分片一并移交。
 *
 * Bug C（destroy 后 blob 定时器不得残留生效）：
 *   destroy() 必须 clearTimeout + 置 null。本节是**防护锁定**（现有行为
 *   正确，无 A/B）：若定时器在 destroy 后仍触发，会把过期 blob 塞进
 *   video 元素，与新会话的 P2P srcObject 互相干扰。
 *
 * 三个节都用「fake signal + 独立 video 元素」构造独立的 vx 实例，
 * 不干扰页面自身的传输层。依赖：puppeteer-core（开发依赖）。
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
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** 在页面里造一个独立的 vx（fake signal，收发只记录不外发） */
const MAKE_VX = `
  window.__makeVx = () => {
    const sent = [];
    const fakeSignal = { rtt: 5, send: (o) => sent.push(o) };
    const vx = window.Cast.createViewerTransport(fakeSignal);
    const video = document.createElement('video');
    vx.attachVideo(video);
    return { vx, video, sent };
  };
`;

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new', protocolTimeout: 60000,
    args: ['--no-sandbox', '--disable-setuid-sandbox',
           '--autoplay-policy=no-user-gesture-required'],
  });
  const page = await browser.newPage();
  await page.goto(`${BASE}/view?debug=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.Cast && !!window.Cast.createViewerTransport, { timeout: 15000 });
  await page.evaluate(MAKE_VX);

  // ================= Bug A：blob 定时器洪水 =================
  {
    const r = await page.evaluate(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const orig = MediaSource.isTypeSupported;
      MediaSource.isTypeSupported = () => false;      // 强制走 relay-blob
      const { vx, video } = window.__makeVx();
      vx.startRelayPlayback('video/webm;codecs=vp8');
      const mode0 = vx.mode;                          // 期望 relay-blob
      // 模拟 host 的分片节奏：120ms 一片，持续 2.5 秒（≈21 片）
      for (let i = 0; i < 21; i++) {
        vx.onRelayChunk(new ArrayBuffer(1024));
        await wait(120);
      }
      const src = video.src;                          // 喂片**期间**读：旧实现此刻必然为空
      MediaSource.isTypeSupported = orig;
      return { mode0, srcSet: src.startsWith('blob:'), srcLen: src.length };
    });
    ok('BugA 前置：mime 不支持时进入 relay-blob', r.mode0 === 'relay-blob', 'mode=' + r.mode0);
    ok('BugA 持续推流下 blob 定时器能到点（src 被设置）', r.srcSet,
       'video.src 长度=' + r.srcLen);
  }

  // ================= Bug B：addSourceBuffer 失败降级 =================
  {
    const r = await page.evaluate(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const orig = MediaSource.prototype.addSourceBuffer;
      MediaSource.prototype.addSourceBuffer = function () {
        throw new Error('stub: SourceBuffer 建不出来');
      };
      const { vx, video } = window.__makeVx();
      vx.startRelayPlayback('video/webm;codecs=vp8');
      const mode0 = vx.mode;                          // 期望 relay（isTypeSupported 真实通过）
      vx.onRelayChunk(new ArrayBuffer(1024));         // sourceopen 前到达的分片 → queue
      vx.onRelayChunk(new ArrayBuffer(1024));
      // 等 sourceopen（真实 MSE 异步触发）→ catch → 降级
      let mode1 = vx.mode;
      for (let i = 0; i < 20 && mode1 === 'relay'; i++) { await wait(150); mode1 = vx.mode; }
      // 降级后再喂一片：blob 定时器到点后应把（含移交分片的）内容播出来
      vx.onRelayChunk(new ArrayBuffer(1024));
      let srcSet = video.src.startsWith('blob:');
      for (let i = 0; i < 15 && !srcSet; i++) { await wait(150); srcSet = video.src.startsWith('blob:'); }
      MediaSource.prototype.addSourceBuffer = orig;
      return { mode0, mode1, srcSet };
    });
    ok('BugB 前置：isTypeSupported 通过时正常进入 relay', r.mode0 === 'relay', 'mode=' + r.mode0);
    ok('BugB addSourceBuffer 失败后自动降级 relay-blob', r.mode1 === 'relay-blob', 'mode=' + r.mode1);
    ok('BugB 降级后 blob 链路接手（queue 移交 + 可继续播放）', r.srcSet);
  }

  // ================= Bug C：destroy 后定时器不残留生效（防护锁定） =================
  {
    const r = await page.evaluate(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const orig = MediaSource.isTypeSupported;
      MediaSource.isTypeSupported = () => false;
      const { vx, video } = window.__makeVx();
      vx.startRelayPlayback('video/webm;codecs=vp8');
      vx.onRelayChunk(new ArrayBuffer(1024));         // 定时器已挂起（1000ms 后触发）
      await wait(200);                                // 定时器仍在挂起窗口内
      vx.destroy();                                   // 此刻必须把它取消
      await wait(1300);                               // 越过原定触发时刻
      MediaSource.isTypeSupported = orig;
      return { srcAfter: video.src || '', srcObject: video.srcObject };
    });
    ok('BugC destroy 后 blob 定时器不再触发（video.src 保持干净）', r.srcAfter === '',
       'src=' + r.srcAfter.slice(0, 40));
  }

  console.log(`\n通过 ${pass}/${pass + fail}`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error('测试异常：', e); process.exit(1); });
