/* buildIceServers 必须归一化 turn.urls（兼容逗号分隔串）
 *
 * 缺陷回顾（core.js#buildIceServers）：
 *     list.push({ urls: turn.urls, ... });
 * RTCIceServer.urls 接受字符串或字符串**数组**，但不会自动拆逗号。
 * 服务端 makeTurnCredential 原样透传 TURN_URL 环境变量 —— 运维若按
 * coturn 惯用写法配置 `turn:a?transport=udp,turn:b?transport=tcp`，
 * 整串会被当成**一个**字面 URL，ICE 直接失败（无法建立任何连接）。
 *
 * 修复：统一归一化为数组（split(',') + trim + 滤空），数组原样保留。
 *
 * 构造方式（白盒）：buildIceServers 是 Cast 的公开 API，直接以四种
 * 形态调用并断言产出的 urls 形状。无需浏览器媒体能力。
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
  await page.waitForFunction(() => !!window.Cast && !!window.Cast.buildIceServers, { timeout: 15000 });

  const r = await page.evaluate(() => {
    const B = window.Cast.buildIceServers;
    const turnOf = (urls) => {
      const list = B({ urls, username: 'u', credential: 'c' });
      return list[list.length - 1];          // TURN 追加在 STUN 之后
    };
    return {
      single: turnOf('turn:host:3478'),
      comma: turnOf('turn:a?transport=udp, turn:b?transport=tcp ,'),
      array: turnOf(['turn:x:3478', 'turns:y:5349']),
      emptyPart: turnOf('turn:a:3478,,turn:b:3478'),
    };
  });

  ok('单值字符串 → 单元素数组', JSON.stringify(r.single.urls) === '["turn:host:3478"]' && r.single.username === 'u',
     JSON.stringify(r.single.urls));
  ok('逗号分隔串被拆分（含空段与空格容错）',
     JSON.stringify(r.comma.urls) === '["turn:a?transport=udp","turn:b?transport=tcp"]',
     JSON.stringify(r.comma.urls));
  ok('数组形态原样保留', JSON.stringify(r.array.urls) === '["turn:x:3478","turns:y:5349"]',
     JSON.stringify(r.array.urls));
  ok('空段被滤除', JSON.stringify(r.emptyPart.urls) === '["turn:a:3478","turn:b:3478"]',
     JSON.stringify(r.emptyPart.urls));

  console.log(`\n通过 ${pass}/${pass + fail}`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error('测试异常：', e); process.exit(1); });
