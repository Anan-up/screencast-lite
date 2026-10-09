/* viewer-status 的 viewerId 不得被 payload 覆盖（安全回归）
 *
 * 缺陷回顾（server.js handleSignal / case 'viewer-status'）：
 * 早期写的是
 *     send(room.host, { type: 'viewer-status', viewerId: ws.viewerId, ...msg.payload });
 * `...msg.payload` 在 viewerId **之后**展开，payload 里若带同名字段就会
 * **静默顶掉**服务端认定的真实身份。后果不是"显示错"这么轻：
 *   - 主机侧 onViewerStatus 直接拿 payload.viewerId 去查 peers
 *     （见 host.js `peers.get(payload && payload.viewerId)`），
 *     于是 A 大屏可以伪造 framesDecoded 去污染 **B 大屏** 的 liveness；
 *   - 顺着看门狗逻辑，攻击者可以让 B 被误判"静默中断"而**不可逆地切到中继**
 *     （enableRelay 没有回退路径），或反过来让 B 的停滞永远不被发现。
 *
 * 修复：viewerId 必须**最后**展开（与同文件 offer/answer/ice 分支顺序一致）。
 * 另修 P0：type 字段同样必须殿后锁定 —— 否则 payload 里塞 `type:'replaced'`
 * 可伪装消息类型，让主机被观众强制重连（DoS）/ 伪造 viewer-left / 伪造
 * host-away（详见 server.js case 'viewer-status' 注释）。
 *
 * 本用例是纯协议层黑盒：两条真实 ws（host + viewer），viewer 发一条
 * 携带伪 viewerId / 伪 type 的 viewer-status，断言 host 收到的 viewerId 是
 * 服务端认定的那个（ws.viewerId）、type 恒为 viewer-status，而不是伪造值。
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
    ws.on('message', (buf) => { try { ws.inbox.push(JSON.parse(buf.toString())); } catch {} });
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
const code = () => 'VS' + Math.random().toString(36).slice(2, 6).toUpperCase();

(async () => {
  const C = code();
  const host = await open();
  const viewer = await open();

  host.send(JSON.stringify({ type: 'create', code: C }));
  await waitMsg(host, (m) => m.type === 'created');
  viewer.send(JSON.stringify({ type: 'join', code: C }));
  const joined = await waitMsg(viewer, (m) => m.type === 'joined');
  const realId = joined.viewerId;
  ok('观看端加入成功，拿到服务端分配的 viewerId', !!realId, JSON.stringify(joined));
  await waitMsg(host, (m) => m.type === 'viewer-joined');

  // ---- 核心攻击场景：payload 里带一个伪造的 viewerId ----
  host.inbox.length = 0;
  const FORGED = 'forged9';
  viewer.send(JSON.stringify({
    type: 'viewer-status',
    payload: { viewerId: FORGED, framesDecoded: 99999, rtt: 1 },
  }));

  let got = null;
  try { got = await waitMsg(host, (m) => m.type === 'viewer-status', 3000); } catch {}

  ok('主机收到了 viewer-status 转发', !!got, JSON.stringify(got));
  ok('转发时 viewerId 是服务端认定的真实 id（伪造值被拒绝）',
    got && got.viewerId === realId,
    `期望 ${realId}，实得 ${got && got.viewerId}`);
  ok('伪造的 viewerId 没有出现在转发结果里',
    !got || got.viewerId !== FORGED,
    `forged=${FORGED} got=${got && got.viewerId}`);
  ok('payload 的其余字段仍正常透传（framesDecoded/rtt）',
    got && got.framesDecoded === 99999 && got.rtt === 1,
    JSON.stringify(got));

  // ---- 对照：不带 viewerId 的正常上报也必须正确 ----
  host.inbox.length = 0;
  viewer.send(JSON.stringify({ type: 'viewer-status', payload: { framesDecoded: 42 } }));
  let got2 = null;
  try { got2 = await waitMsg(host, (m) => m.type === 'viewer-status', 3000); } catch {}
  ok('正常上报（payload 无 viewerId）仍带上真实 id',
    got2 && got2.viewerId === realId && got2.framesDecoded === 42,
    JSON.stringify(got2));

  // ---- 边界：payload 为 null-ish 时不得崩、不得把 viewerId 丢掉 ----
  host.inbox.length = 0;
  viewer.send(JSON.stringify({ type: 'viewer-status', payload: {} }));
  let got3 = null;
  try { got3 = await waitMsg(host, (m) => m.type === 'viewer-status', 3000); } catch {}
  ok('空 payload 时 viewerId 仍在',
    got3 && got3.viewerId === realId, JSON.stringify(got3));

  // ---- P0：type 字段同样不得被 payload 覆盖（消息类型伪装）----
  // 若服务端把 type 放在 payload 之前展开，观看端可在 payload 里塞
  // `type:'replaced'` / 'viewer-left' / 'host-away'，转发给主机的消息类型被
  // 替换 → 主机 core.js bus.emit(type) 派发伪造事件（replaced → 强制重连 DoS 等）。
  host.inbox.length = 0;
  viewer.send(JSON.stringify({ type: 'viewer-status', payload: { type: 'replaced' } }));
  let got4 = null;
  try { got4 = await waitMsg(host, (m) => m.type === 'viewer-status', 3000); } catch {}
  ok('伪造 type 未生效：主机收到的仍是 viewer-status（而非 replaced）',
    !!got4 && got4.type === 'viewer-status',
    `期望 type=viewer-status，实得 ${got4 && JSON.stringify(got4)}`);
  ok('主机未收到伪造的 replaced 事件',
    !host.inbox.some((m) => m.type === 'replaced'),
    JSON.stringify(host.inbox));

  host.close(); viewer.close();
  await sleep(200);
  console.log(`\n通过 ${pass}/${pass + fail}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('测试异常：', e); process.exit(1); });
