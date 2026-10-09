/* 畸形 URL 不得打死服务（DoS 回归）
 *
 * 缺陷回顾（server.js#serveStatic）：
 *     let urlPath = decodeURIComponent(req.url.split('?')[0]);
 * `decodeURIComponent('/%')` 抛 URIError: URI malformed。这个异常在同步
 * HTTP handler 链里被直接调用、没有任何 try/catch，Node 不会替你接 ——
 * 它变成未捕获异常，进程直接退出。任何能访问端口的人发一条 GET /%
 * 即可停服（实测：攻击前 /api/health 200 → 攻击后连接拒绝）。
 *
 * 修复：try/catch 包住，畸形则回 400。
 *
 * 本用例是协议层黑盒：真实 HTTP 请求打到共享服务器上，
 * 断言 1) 畸形 URL 得到 400；2) 服务在攻击后仍然存活。
 *
 * 依赖：无（Node 内置 http）。恒可运行。
 */
const http = require('http');

const PORT = process.env.PORT || 8080;
const HOST = process.env.HOST || 'localhost';

let pass = 0, fail = 0;
function ok(n, c, e) { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  ' + e : '')); } }

function get(path) {
  return new Promise((resolve) => {
    const req = http.get({ host: HOST, port: PORT, path }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode }));
    });
    req.on('error', (e) => resolve({ status: 0, err: String(e.code || e) }));
    req.setTimeout(3000, () => { req.destroy(); resolve({ status: 0, err: 'TIMEOUT' }); });
  });
}

(async () => {
  const before = await get('/api/health');
  ok('攻击前服务健康（/api/health → 200）', before.status === 200, `status=${before.status} ${before.err || ''}`);

  const attack = await get('/%');
  ok('畸形 URL 得到 400（而非连接崩溃）', attack.status === 400,
     `status=${attack.status} ${attack.err || ''}`);

  await new Promise((r) => setTimeout(r, 300));
  const after = await get('/api/health');
  ok('攻击后服务仍存活（这是本用例的核心）', after.status === 200, `status=${after.status} ${after.err || ''}`);

  // 顺带覆盖两种常见的畸形形态
  const attack2 = await get('/view%2');
  const after2 = await get('/api/health');
  ok('第二种畸形（截断转义）也不致命', attack2.status === 400 && after2.status === 200,
     `attack=${attack2.status} health=${after2.status}`);

  console.log(`\n通过 ${pass}/${pass + fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常：', e); process.exit(1); });
