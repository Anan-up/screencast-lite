/**
 * 浏览器：服务器重启后大屏自动重新加入（P2.5 回归）
 *
 * 缺陷（修复前）：
 *   服务器进程被杀/重启时，观看端 ws 关闭 → view.html 的 close 处理器
 *   只换横幅、不清 joined → 信令层按退避自动重连成功后，open 处理器的
 *   `!joined` 守卫永远挡住重新 join。新服务器实例没有旧房间状态，
 *   room-closed 不可能补发；autoWait 只由 onHostGone 触发、host-return 也
 *   到不了没 join 过的观看端 —— 大屏成了新服务器上的"幽灵"。
 *
 *   严重程度按链路分档：
 *   - **中继模式**（本用例锁定）：没有 pc 可供 connectionState 走到 failed，
 *     因此什么都不会触发 scheduleRejoin —— 永久卡死在"连接中断"横幅。
 *   - P2P 模式：主机断线时 host.reset() 会关掉对端 pc，观看端 pc 最终
 *     failed → scheduleRejoin 兜底，**能**自愈，但依赖 ICE 数十秒才判定
 *     failed，恢复慢且横幅长时间误导。
 *
 * 修复：
 *   close 清 joined + 置 sessionSevered；open 对被切断过的会话销毁旧传输
 *   层（destroy 把 mode 复位为 connecting，否则退避链"决策 1"会把重 join
 *   误判成"已处于中继"而撤销）+ 置 rejoinInFlight（join-failed 走退避链）
 *   + 立即重新 doJoin。
 *
 * 为什么必须在杀服务前把会话**强制切到中继**：
 *   若停在 P2P，未修复构建也能经"pc failed → scheduleRejoin"缓慢自愈，
 *   A/B 只会红一条（close 清位），抓不住"永久卡死"这个真正的缺陷形态。
 *   切到中继后观看端无 pc，未修复构建没有任何 rejoin 触发源，出站 join
 *   恒为零 —— 断言确定性地转红。
 */
let puppeteer;
try {
  puppeteer = require('puppeteer-core');
} catch {
  console.log('  ⚠ SKIP: 未安装 puppeteer-core（开发依赖）');
  process.exit(0);
}

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CHROME = process.env.CHROME_PATH || '/usr/bin/chromium';

let pass = 0, fail = 0;
function ok(n, c, e) { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  → ' + e : '')); } }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function health(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 1200 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}
async function waitHealth(port, up, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if ((await health(port)) === up) return true;
    await wait(150);
  }
  return false;
}
async function pickPort() {
  for (let i = 0; i < 8; i++) {
    const p = 20000 + Math.floor(Math.random() * 20000);
    if (!(await health(p))) return p;
  }
  return null;
}
function startServer(port) {
  return spawn('node', [path.join('server', 'server.js')], {
    cwd: ROOT, env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'ignore', 'ignore'],
  });
}

(async () => {
  const PORT = await pickPort();
  if (!PORT) { console.log('SKIP: 找不到空闲端口'); process.exit(0); }
  const BASE = `http://127.0.0.1:${PORT}`;
  console.log('   私有服务端口 =', PORT);

  let server = startServer(PORT);
  if (!await waitHealth(PORT, true, 10000)) {
    try { server.kill('SIGKILL'); } catch {}
    console.log('SKIP: 私有服务未能启动'); process.exit(0);
  }

  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: CHROME, headless: 'new', protocolTimeout: 90000,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
  } catch (e) {
    try { server.kill('SIGKILL'); } catch {}
    console.log('SKIP: 无法启动浏览器（' + e.message + '）'); process.exit(0);
  }

  const errs = { cast: [], view: [] };
  try {
    const castPage = await browser.newPage();
    const viewPage = await browser.newPage();
    castPage.on('pageerror', (e) => errs.cast.push(e.message));
    viewPage.on('pageerror', (e) => errs.view.push(e.message));

    // ---------- 建房（真实 created/rememberCode 路径） ----------
    await castPage.goto(`${BASE}/cast?debug=1`, { waitUntil: 'domcontentloaded' });
    await castPage.waitForFunction(() => window.__signal && window.__signal.state === 1, { timeout: 15000 });

    const code = await castPage.evaluate(async () => {
      const cv = document.createElement('canvas');
      cv.width = 320; cv.height = 240;
      const ctx = cv.getContext('2d');
      let n = 0;
      // 动画流：看门狗需要 framesDecoded 持续推进（lastDecoded ≥ 0）才会
      // 判定"曾有解码"，forceStall 才生效；静态流拿不到这个前提。
      setInterval(() => { ctx.fillStyle = (n++ % 2) ? '#222' : '#ddd'; ctx.fillRect(0, 0, 320, 240); }, 60);
      window.__host.setStream(cv.captureStream(15));
      window.__forceStarted();          // 关键：重连后 ensureRoom 才会重建房间
      const m = await new Promise((res) => {
        const t = setTimeout(() => res(null), 5000);
        window.__signal.on('created', (msg) => { clearTimeout(t); res(msg); });
        window.__signal.send({ type: 'create' });
      });
      return m && m.code;
    }).catch(() => null);

    if (!code) { console.log('SKIP: 未能建房'); await browser.close(); try { server.kill('SIGKILL'); } catch {} process.exit(0); }
    ok('① 建房成功（房间码 ' + code + '）', true);

    // ---------- 大屏加入 + 等 P2P 真正建立 ----------
    await viewPage.goto(`${BASE}/view?r=${code}&debug=1`, { waitUntil: 'domcontentloaded' });
    await viewPage.waitForFunction(() => !!window.__vx && !!window.__signal, { timeout: 15000 });
    await viewPage.evaluate(() => { document.querySelector('#btnJoin').click(); });
    await viewPage.waitForFunction(() => window.__joined === true, { timeout: 15000 });
    ok('② 大屏成功加入（__joined === true）', true);

    const p2p = await castPage.evaluate(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const t0 = Date.now();
      while (Date.now() - t0 < 20000) {
        const ids = window.__host.peerIds || [];
        const id = ids[ids.length - 1];
        if (id) {
          const st = window.__host.peerState(id);
          const L = window.__host.peerLiveness(id);
          if (st === 'connected' && L && L.lastDecoded >= 0) return { ok: true, id };
        }
        await wait(200);
      }
      return { ok: false };
    });
    if (!p2p.ok) {
      console.log('  ⚠ SKIP: headless 下未能建立可用的 P2P（看门狗前提不满足），不计失败');
      await browser.close(); try { server.kill('SIGKILL'); } catch {}
      console.log(`\n通过 ${pass}/${pass + fail}（已跳过）`); process.exit(0);
    }
    ok('③ 真 P2P 已建立且接收端有解码上报', true);

    // ---------- 强制切到中继（本用例的关键前置：让观看端无 pc 可 failed） ----------
    await castPage.evaluate((id) => window.__host.forceStall(id, 20), p2p.id);
    const relaid = await viewPage.waitForFunction(
      () => window.__vx.mode === 'relay' || window.__vx.mode === 'relay-blob',
      { timeout: 10000 },
    ).then(() => true).catch(() => false);
    if (!relaid) {
      console.log('  ⚠ SKIP: 未能切到中继模式（headless 下看门狗未触发 relay），不计失败');
      await browser.close(); try { server.kill('SIGKILL'); } catch {}
      console.log(`\n通过 ${pass}/${pass + fail}（已跳过）`); process.exit(0);
    }
    ok('④ 已切到中继模式（观看端无 pc，杜绝 pc-failed 兜底）', true);

    const before = await viewPage.evaluate(() => ({
      joins: window.__joinLog ? window.__joinLog.length : 0,
      mode: window.__vx.mode,
      pc: window.__vx.pc,
    }));
    console.log('   重启前：joins=' + before.joins + ' mode=' + before.mode + ' hasPc=' + !!before.pc);

    // ---------- 杀服务（SIGKILL：无任何优雅收尾） ----------
    server.kill('SIGKILL');
    const down = await waitHealth(PORT, false, 5000);
    ok('⑤ 服务已死（/api/health 不可达）', down);

    // close 与 reconnecting 同一 tick 先后派发，"连接中断"被"重连中(N)"覆盖
    const bannerShown = await viewPage.waitForFunction(
      () => /连接中断|重连中/.test(document.querySelector('#bannerText').textContent),
      { timeout: 5000 },
    ).then(() => true).catch(() => false);
    const bannerAtDown = await viewPage.evaluate(() => document.querySelector('#bannerText').textContent);
    ok('⑥ 断连横幅出现（连接中断/重连中）', bannerShown, 'banner=' + JSON.stringify(bannerAtDown));

    const cleared = await viewPage.waitForFunction(
      () => window.__joined === false, { timeout: 8000 },
    ).then(() => true).catch(() => false);
    ok('⑦ close 清位 joined（未修复构建此处红：残留 true）', cleared,
       cleared ? '' : '__joined 仍为 true');

    // ---------- 重启服务（全新实例） ----------
    await wait(600);
    server = startServer(PORT);
    const up = await waitHealth(PORT, true, 10000);
    ok('⑧ 服务已重启（新实例）', up);

    // 主机侧重连 + ensureRoom 同码重建
    let hostCode = null;
    const hostTimeline = [];
    const hostT0 = Date.now();
    while (Date.now() - hostT0 < 25000) {
      try {
        const s = await castPage.evaluate(() => ({
          state: window.__signal ? window.__signal.state : -1,
          code: (document.querySelector('#roomCode') || {}).textContent || null,
        }));
        hostTimeline.push(`${s.state}:${s.code}`);
        if (s.state === 1 && s.code === code) { hostCode = s.code; break; }
      } catch (e) { hostTimeline.push('ERR:' + e.message); }
      await wait(500);
    }
    ok('⑨ 主机重连并同码重建房间', hostCode === code,
       'hostCode=' + hostCode + ' 时间线=' + hostTimeline.join(','));

    // ---------- 大屏自愈（A/B 的确定性断言） ----------
    const reconnected = await viewPage.waitForFunction(
      () => window.__signal && window.__signal.state === 1, { timeout: 20000 },
    ).then(() => true).catch(() => false);
    ok('⑩ 大屏信令重连成功（open 已派发）', reconnected);

    await wait(600);
    const afterOpen = await viewPage.evaluate(() => ({
      joins: window.__joinLog ? window.__joinLog.length : 0,
    }));
    ok('⑪ open 后立即重新 join（未修复构建此处红：joinLog 零增长）',
       afterOpen.joins > before.joins, `joins ${before.joins} → ${afterOpen.joins}`);

    // 最终自愈的判定必须同时看"重新 join 过"与"joined 为真"——单看 joined
    // 在未修复构建里恒为 true（close 从未清位），是假绿。
    const healed = await viewPage.waitForFunction(
      (n) => window.__joined === true
            && window.__joinLog && window.__joinLog.length > n,
      { timeout: 25000 }, before.joins,
    ).then(() => true).catch(() => false);
    const finalJoins = await viewPage.evaluate(() => window.__joinLog ? window.__joinLog.length : 0);
    ok('⑫ 大屏重新加入新服务器（__joined true 且 joinLog 增长）',
       healed && finalJoins > before.joins,
       `finalJoins=${finalJoins} before=${before.joins}`);

    if (healed) {
      const banner = await viewPage.evaluate(() => document.querySelector('#bannerText').textContent);
      ok('⑬ 横幅脱离"连接中断/重连中"（未修复构建卡死此处）',
         !banner.includes('连接中断') && !banner.includes('重连中'),
         'banner=' + JSON.stringify(banner));
      const mode = await viewPage.evaluate(() => window.__vx.mode);
      console.log('   自愈后 mode=' + mode);
    } else {
      ok('⑬ 横幅脱离"连接中断/重连中"', false, '未自愈，跳过');
    }

    ok('⑭ 两页均无未捕获异常', errs.cast.length === 0 && errs.view.length === 0,
       ['cast:' + errs.cast.join('|'), 'view:' + errs.view.join('|')].join(' ; '));

    console.log(`\n通过 ${pass}/${pass + fail}`);
  } finally {
    try { await browser.close(); } catch {}
    try { server.kill('SIGKILL'); } catch {}
  }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常：', e); process.exit(1); });
