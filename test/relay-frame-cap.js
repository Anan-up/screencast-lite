/* 中继分片大小上限：超限帧必须被丢弃（放大攻击面回归）
 *
 * 缺陷回顾（server.js 二进制中继分支）：
 * ws 层 maxPayload=20MB 只是防内存炸裂的底线。正常分片来自
 * MediaRecorder.start(120)（120ms 一片），最高画质档（15Mbps）也只有
 * 约 225KB。没有独立长度校验时，恶意客户端可以往服务端推 20MB 的
 * "分片"，服务端会**原样转发**给房间内观看端 —— 放大攻击面 + 占满
 * 观看端带宽。
 *
 * 修复：host 的二进制帧 payload 超过 RELAY_FRAME_MAX(1MB) 直接丢弃
 * （不踢连接：编码器瞬时突发也可能超一点，踢掉误伤大于收益）。
 *
 * 本用例是协议层黑盒：真实 host+viewer 两条 ws 建房加入后，
 * host 发送 1) 一帧 1.2MB 的超限分片 → viewer 必须收不到；
 * 2) 一帧正常大小（8KB）的分片 → viewer 必须收到（服务没被误伤）。
 *
 * 依赖：ws（运行时依赖）。未安装时 SKIP 并以 0 退出。
 */
let WebSocket;
try { WebSocket = require('ws'); }
catch {
  console.log('  \u26a0 SKIP: 未安装 ws（运行时依赖）');
  process.exit(0);
}

const PORT = process.env.PORT || 8080;
const HOST = process.env.HOST || 'localhost';
const URL = `ws://${HOST}:${PORT}`;

let pass = 0, fail = 0;
function ok(n, c, e) { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  ' + e : '')); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function open() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    ws.inbox = [];
    ws.bin = [];
    ws.on('message', (buf, isBinary) => {
      if (isBinary) { ws.bin.push(buf); return; }
      try { ws.inbox.push(JSON.parse(buf.toString())); } catch {}
    });
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}
function waitMsg(ws, pred, timeout = 5000) {
  const hit = ws.inbox.find(pred);
  if (hit) return Promise.resolve(hit);
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { ws.off('message', on); reject(new Error('等待消息超时')); }, timeout);
    function on() {
      const m = ws.inbox.find(pred);
      if (m) { clearTimeout(t); ws.off('message', on); resolve(m); }
    }
    ws.on('message', on);
  });
}
/** 与 host.js#frame 同构：8 字节 viewerId（空格补齐）+ payload */
function frame(viewerId, payload) {
  const id = String(viewerId || '').slice(0, 8).padEnd(8, ' ');
  return Buffer.concat([Buffer.from(id, 'utf8'), payload]);
}

(async () => {
  const host = await open();
  host.send(JSON.stringify({ type: 'create', code: 'FC' + Math.random().toString(36).slice(2, 6).toUpperCase() }));
  const created = await waitMsg(host, (m) => m.type === 'created');

  const viewer = await open();
  viewer.send(JSON.stringify({ type: 'join', code: created.code }));
  await waitMsg(viewer, (m) => m.type === 'joined');
  const vid = viewer.inbox.find((m) => m.type === 'joined').viewerId;
  ok('建房 + 观看端加入成功', !!created.code && !!vid, `code=${created.code} vid=${vid}`);

  // 等主机侧 viewer-joined 落定
  await waitMsg(host, (m) => m.type === 'viewer-joined' && m.viewerId === vid);
  await sleep(200);

  // ---- 1. 超限帧（1.2MB）必须被丢弃 ----
  const bigPayload = Buffer.alloc(1200 * 1024, 7);
  const binBefore = viewer.bin.length;
  host.send(frame(vid, bigPayload), { binary: true });
  await sleep(800);
  const gotBig = viewer.bin.length > binBefore;
  ok('1.2MB 超限帧不被转发给观看端', !gotBig, `viewer 收到 ${viewer.bin.length - binBefore} 帧`);

  // ---- 2. 正常帧（8KB）必须照常转发（防误伤） ----
  const smallPayload = Buffer.alloc(8 * 1024, 3);
  const binBefore2 = viewer.bin.length;
  host.send(frame(vid, smallPayload), { binary: true });
  await sleep(800);
  const gotSmall = viewer.bin.length > binBefore2;
  ok('8KB 正常分片照常转发（无误伤）', gotSmall, `viewer 收到 ${viewer.bin.length - binBefore2} 帧`);

  // ---- 3. 服务在丢弃超限帧后仍然健康 ----
  host.send(frame(vid, bigPayload), { binary: true });
  await sleep(300);
  host.send(JSON.stringify({ type: 'ping' }));
  await waitMsg(host, (m) => m.type === 'pong', 3000).catch(() => {});
  ok('丢弃超限帧后信令链路仍正常', host.inbox.some((m) => m.type === 'pong'));

  console.log(`\n通过 ${pass}/${pass + fail}`);
  [host, viewer].forEach((w) => { try { w.close(); } catch {} });
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常：', e); process.exit(1); });
