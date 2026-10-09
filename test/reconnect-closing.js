/* P1 回归：readyState 必须三分支处理，CLOSING(2) 不能与 CLOSED(3) 合并
 *
 * 缺陷机理（`dead = ws.readyState >= 2` 的写法）：
 *   CLOSING(2) 时 onclose **还没派发**（即将派发）。若此时直接 connect()：
 *     1) connect() 里 ws = new WebSocket(...) → 生成连接 A，模块级 ws 指向 A
 *     2) 几十 ms 后旧 socket 的 onclose 派发 → closedByUser 刚被复位为 false
 *        → 走到 setTimeout(connect, delay)
 *     3) delay 后再次 connect() → 生成连接 B，ws 改指 B
 *     ⇒ A 的引用被丢弃，但 A 的底层 socket 仍然 OPEN —— **孤儿连接**。
 *        它继续收服务端消息却无人处理；服务端也认为该浏览器有两条活跃 ws。
 *
 * 确定性触发手法：
 *   在同一同步 tick 内先 ws.close()（OPEN→CLOSING 是同步的），再调
 *   reconnectNow()。此时 readyState 必为 2 —— 精确命中 CLOSING 窗口。
 *
 * 断言：
 *   1) 命中 CLOSING：reconnectNow 被调用时 readyState === 2
 *   2) 不产生孤儿：重连完成后，底层 socket 的总数不异常增长
 *      （用服务端连接数 / 客户端计数双重观测）
 *   3) 最终 state 回到 OPEN（修复没有牺牲"能重连"）
 *   4) 顺序正确性：不出现"两条 ws 同时 OPEN"的重叠
 *
 * 观测手段：?_debug=1 下 core.js 暴露 __signal.socket。但我们还需要
 * 统计"底层一共创建过几条 ws"——用一个页面级钩子包裹 WebSocket 构造函数。
 */
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c, e) => c ? (pass++, console.log('  \u2713 ' + n))
                          : (fail++, console.log('  \u2717 ' + n + (e ? '  ' + e : '')));

let puppeteer;
try { puppeteer = require('puppeteer-core'); }
catch {
  console.log('  \u26a0 SKIP: 未安装 puppeteer-core（开发依赖）');
  process.exit(0);
}
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

  // 在页面脚本执行**之前**包裹 WebSocket，记录每一次实例化与 readyState 变迁。
  await page.evaluateOnNewDocument(() => {
    window.__wsLog = { created: [], closedAt: [] };
    const Orig = window.WebSocket;
    function Tracked(url, protos) {
      const w = new Orig(url, protos);
      const rec = { id: window.__wsLog.created.length, url: String(url), open: false, closed: false };
      window.__wsLog.created.push(rec);
      w.addEventListener('open', () => { rec.open = true; });
      w.addEventListener('close', () => { rec.closed = true; window.__wsLog.closedAt.push(rec.id); });
      return w;
    }
    Tracked.prototype = Orig.prototype;
    Tracked.OPEN = Orig.OPEN; Tracked.CLOSING = Orig.CLOSING; Tracked.CLOSED = Orig.CLOSED;
    Tracked.CONNECTING = Orig.CONNECTING;
    window.WebSocket = Tracked;
  });

  await page.goto(`${BASE}/cast?debug=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__signal && window.__signal.state === 1, { timeout: 15000 });
  ok('初始信令已连接', true);

  const createdBefore = await page.evaluate(() => window.__wsLog.created.length);

  // ---- 精确命中 CLOSING：同一 tick 内 close() 然后 reconnectNow() ----
  const hit = await page.evaluate(() => {
    const s = window.__signal;
    s.close();                 // OPEN → CLOSING（同步）
    const st = s.state;        // 期望 2
    s.reconnectNow();          // 在 CLOSING 窗口内调用（这是被检路径）
    return { stateAtCall: st };
  });
  console.log('   reconnectNow() 调用时 readyState =', hit.stateAtCall);
  ok('1) 确定性命中 CLOSING 窗口 (readyState===2)', hit.stateAtCall === 2,
     `state=${hit.stateAtCall}`);

  // 等到收敛
  let finalState = null;
  for (let i = 0; i < 80; i++) {
    finalState = await page.evaluate(() => window.__signal.state);
    if (finalState === 1) break;
    await sleep(100);
  }
  ok('3) 最终 state 回到 OPEN（修复未牺牲"能重连"）', finalState === 1,
     `state=${finalState}`);

  // 再稳一会儿，让可能存在的孤儿 onclose → connect() 也跑完
  await sleep(3000);

  const log = await page.evaluate(() => window.__wsLog);
  const createdAfter = log.created.length;
  const totalCreated = createdAfter - createdBefore;
  const openNow = log.created.filter(r => r.open && !r.closed).length;
  const orphanCandidates = log.created.filter(r => r.open && !r.closed);

  console.log('   重连期间新建 ws 数 =', totalCreated);
  console.log('   当前仍 open 且未 close 的 ws 数 =', openNow,
              JSON.stringify(orphanCandidates.map(r => r.id)));

  // 修复后：CLOSING 分支什么都不做，等旧 onclose 派发后走一次退避重连
  //         → 应只新建 1 条，且最终只有 1 条 OPEN。
  // 缺陷时：会在 CLOSING 抢先 connect() 建 A，旧 onclose 又建 B
  //         → 新建 2 条，且 A 成为孤儿（open 且永不 close）。
  ok('2) 未产生孤儿连接（当前仅有 1 条 OPEN 的 ws）', openNow === 1,
     `openNow=${openNow}, ids=${JSON.stringify(orphanCandidates.map(r => r.id))}`);

  // 断言"恰好一条"，而不是"不多于一条"（`<= 1`）：
  //   `<= 1` 允许 totalCreated === 0，即"重连成功却没有新建任何 ws"这一
  //   理论上的假想场景也能通过 —— 那意味着 reconnectNow 复用了原 socket。
  //   当前实现不可能（close() 之后 state 无法再回到 OPEN），但把断言收紧成
  //   `=== 1` 可以在将来有人误改成"复用旧 socket"时立刻报警。
  //   语义也更准确：CLOSING 分支应**恰好**新建一条新 ws。
  ok('4) CLOSING 分支恰好新建 1 条 ws（不多建、也未复用旧 socket）',
     totalCreated === 1, `totalCreated=${totalCreated}`);

  ok('页面无未捕获异常', errs.length === 0, errs.join(' | '));

  await browser.close();
  console.log(`\n通过 ${pass}/${pass + fail}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('异常:', e.message, e.stack); process.exit(1); });
