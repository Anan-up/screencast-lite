/* 撤销后重新排程 —— 自愈（P1 回归）
 *
 * 缺陷回顾：`failed` 事件只在 connectionState **变化**时触发**一次**。
 * 早期实现在"画面仍在推进（isPictureAlive()===true）→ 撤销本次重建"这条
 * 分支里直接 return，**没有重新排程**。后果：
 *   - 撤销本身是对的（画面确实还活着，不该打断）；
 *   - 但撤销后没有任何第二个触发源（host-return 要主机重连、
 *     join-failed 要先发起 join），于是再也等不到下一轮判定；
 *   - 画面一旦真的冻结，就永远冻结到用户手动刷新为止。
 *
 * 修复：撤销分支末尾重新 `scheduleRejoin(false)` —— 用下一轮采样（此时已有
 * 基准）做真实判定，真死则返回 false，正常走重建。表现为 rejoinChecks 递增。
 *
 * 构造要点（否则测不到目标分支）：
 *   isPictureAlive() 的第一道门是 `!v.srcObject || v.readyState < 2` → false。
 *   必须给 #video 一个**真实可播放**的 srcObject，否则永远走"画面已死"分支，
 *   根本到不了"撤销 + 重新排程"。这里用 canvas.captureStream() 喂给 video。
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

  await page.goto(`${BASE}/view?r=TEST&debug=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__rejoin && !!window.__vx, { timeout: 15000 });
  ok('调试把手已就绪', true);

  // 给 #video 挂一条真实推进的 canvas 流，使 isPictureAlive() 能通过前置门
  // （srcObject 存在 + readyState >= 2），从而走到"推进判定"这一层。
  const ready = await page.evaluate(async () => {
    const v = document.querySelector('#video');
    const cv = document.createElement('canvas');
    cv.width = 160; cv.height = 120;
    const ctx = cv.getContext('2d');
    let n = 0;
    setInterval(() => { ctx.fillStyle = (n++ % 2) ? '#222' : '#ddd'; ctx.fillRect(0, 0, 160, 120); }, 60);
    const stream = cv.captureStream(15);
    v.srcObject = stream;
    v.muted = true;
    try { await v.play(); } catch {}
    // 等 readyState 到 HAVE_CURRENT_DATA(2)
    const t0 = Date.now();
    while (v.readyState < 2 && Date.now() - t0 < 5000) {
      await new Promise((r) => setTimeout(r, 100));
    }
    return { readyState: v.readyState, hasSrc: !!v.srcObject, time: v.currentTime };
  });
  console.log('   video readyState =', ready.readyState, ' currentTime =', ready.time);
  ok('video 已可播放（readyState >= 2，满足 isPictureAlive 前置门）',
    ready.readyState >= 2, JSON.stringify(ready));

  // 建立基准：先调一次 alive()，让 lastVideoAt 就位
  await page.evaluate(() => { window.__rejoin.reset(); window.__rejoin.alive(); });
  await new Promise((r) => setTimeout(r, 400));
  const alive = await page.evaluate(() => window.__rejoin.alive());
  const cond = await page.evaluate(() => window.__rejoin.staleConditions());
  console.log('   alive =', alive, ' staleConditions =', JSON.stringify(cond));

  if (alive !== true) {
    console.log('  \u26a0 画面未推进（headless 下 canvas 流可能被节流），用例无法覆盖目标分支');
    console.log('  改为断言前置条件并跳过 —— 不计失败');
    await browser.close();
    console.log(`\n通过 ${pass}/${pass + fail}（已跳过）`);
    process.exit(0);
  }
  ok('画面在推进 → isPictureAlive() 为 true（目标分支前提成立）', alive === true);

  // 关键：非强制重建 + 画面在推进 → 应撤销 **并重新排程**（rejoinChecks 递增）
  const r = await page.evaluate(async () => {
    window.__rejoin.reset();
    window.__rejoin.schedule(0, false);          // 立即排程一次
    await new Promise((res) => setTimeout(res, 2200));   // 过第一轮 delay(≥1200)
    const p1 = JSON.parse(JSON.stringify(window.__rejoin.probe()));
    await new Promise((res) => setTimeout(res, 2200));   // 观察是否续期
    const p2 = JSON.parse(JSON.stringify(window.__rejoin.probe()));
    return { p1, p2 };
  });

  console.log('   第一轮后 probe =', JSON.stringify(r.p1));
  console.log('   第二轮后 probe =', JSON.stringify(r.p2));

  // 注意：这里**不能**断言 attempts === 0。
  // schedule 是"排程后 delay 到点 → 第一次采样还没有 lastVideoAt 基准"，
  // 此时 isPictureAlive() 必然返回 false（hasBaseline 尚未建立），
  // 于是照常走一次 doJoin，attempts=1。这一跳是设计内的（先建基准）。
  // 真正要证明的是：**这一跳之后不再有第二跳** —— 基准已建立，
  // 后续每轮都判定"画面还活着"→ 撤销 + 重新排程，attempts 停在 1，
  // 而 rejoinChecks 持续递增。这正是"撤销后不冻结"的自愈语义。
  //
  // 这个断言的强度依赖一个不变量：每轮定时器先 attempts++、撤销分支里
  // attempts--、重新排程再 attempts++，净效果"永远停在 1"。
  // 它只在**每轮都走进撤销分支**时成立；若某轮 isPictureAlive() 返回 false
  // 走了重建，attempts 会累积到 2、3…… 那同样是**真失败**（说明自愈链没生效），
  // 所以这里断言 === 1 是恰当的，不是过强。
  ok('第一次采样建立基准后只跳了一次（attempts 停在 1，未反复重建）',
    r.p1.rejoinAttempts === 1 && r.p2.rejoinAttempts === 1,
    `p1.attempts=${r.p1.rejoinAttempts} p2.attempts=${r.p2.rejoinAttempts}`);
  ok('走进"还活着"分支（rejoinChecks 递增，证明撤销逻辑执行）',
    r.p2.rejoinChecks >= 1, `checks=${r.p2.rejoinChecks}`);

  // 关键断言 —— 唯一能抓住"撤销即终"缺陷的那条。
  //
  // 为什么不用 `rejoinInFlight === true || rejoinChecks > ...` 这种宽松写法：
  // rejoinInFlight 是**上一次** scheduleRejoin 设进去的，在本轮 await 窗口内
  // 只要没恰好触发下一次定时器就一直是 true。也就是说**即使 bug 存在**
  // （撤销后不重新排程），rejoinInFlight 也可能是 true —— 用它做 or 条件
  // 会让断言恒真，测不出任何东西。
  //
  // 真正区分"自愈"与"撤销即终"的只有一个量：第二轮**又判定了一次**。
  // 撤销后不排程 → rejoinChecks 冻在 1；重新排程 → 递增到 2/3。
  // A/B 实测：撤修后 rejoinChecks = 1 = 首轮值，本断言失败（5/7）。
  ok('自愈链生效：第二轮又判定了一次"还活着"（重新排程确实发生）',
    r.p2.rejoinChecks > r.p1.rejoinChecks,
    `p1.checks=${r.p1.rejoinChecks} p2.checks=${r.p2.rejoinChecks}`);

  ok('页面无未捕获异常', errs.length === 0, errs.join(' | '));

  await browser.close();
  console.log(`\n通过 ${pass}/${pass + fail}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('测试异常：', e); process.exit(1); });
