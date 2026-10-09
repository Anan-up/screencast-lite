/* host.stats 必须把 p2p-relay 归入 relay（与 updateModeTag 对齐）
 *
 * 缺陷回顾（host.js stats getter）：
 *     if (e.mode === 'relay') out.relay++;
 *     else if (...failed...) ...
 *     else if (...connecting/p2p-pending...) ...
 *     else out.p2p++;                      ← p2p-relay 落进这里
 * `p2p-relay`（经 TURN 中转的 P2P，由 detectPathAsync 精判返回）被算成
 * p2p，out.relay 恒 0。而 core.js#gradePath() 把它标为「TURN 中转」，
 * cast.html#updateModeTag() 也把它归入 hasRelay —— 那边的注释甚至写明
 * "早期它落进 else 分支被聚合成 P2P 直连，与单条链路的标签自相矛盾"。
 * updateModeTag 修了，stats 漏了，两处自相矛盾。
 *
 * 修复：`if (e.mode === 'relay' || e.mode === 'p2p-relay') out.relay++;`
 *
 * 构造方式（白盒）：p2p-relay 需要 TURN 环境才能自然出现，headless 下
 * 无法构造。但 getPeers() 是 host 的公开方法（返回内部 peers Map），
 * 直接注入两个假 entry 即可精确控制 mode。用后即删，不污染其他用例。
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
  await page.goto(`${BASE}/cast?debug=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__host, { timeout: 15000 });

  const r = await page.evaluate(() => {
    const peers = window.__host.getPeers();
    const before = window.__host.stats.total;
    peers.set('T1', { mode: 'p2p-relay', pc: null, relayActive: false });   // TURN 中转的 P2P
    peers.set('T2', { mode: 'p2p-host', pc: null, relayActive: false });    // 直连 P2P
    peers.set('T3', { mode: 'relay', pc: null, relayActive: true });        // 服务器中继
    const s = window.__host.stats;                                          // getter，实时求值
    peers.delete('T1'); peers.delete('T2'); peers.delete('T3');
    return { before, s };
  });

  ok('注入前 peers 为空（无串扰）', r.before === 0, 'total=' + r.before);
  ok('p2p-relay 归入 relay 计数', r.s.relay === 2, `relay=${r.s.relay}（期望 2：p2p-relay + relay）`);
  ok('p2p-host 归入 p2p 计数', r.s.p2p === 1, `p2p=${r.s.p2p}`);
  ok('total 恒等于 peers.size', r.s.total === 3, `total=${r.s.total}`);

  console.log(`\n通过 ${pass}/${pass + fail}`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error('测试异常：', e); process.exit(1); });
