/* 跨房间切换 —— 旧房间引用必须清干净（P1 回归）
 *
 * 缺陷回顾：
 * 同一个 ws 先 join 房间 A，之后又 join 房间 B（用户手输另一个房间码，
 * 或带 ?r= 参数走到新房间）。早期实现在 join 分支里**没有**清理旧房间：
 *   - oldRoom.viewers 里仍挂着本 ws → size 永不下降；
 *     旧主机的「大屏数」长期虚高，MAX_VIEWERS 名额被永久占死；
 *   - 旧主机会继续发 offer / viewer-status，大屏照常应答 →
 *     一条 ws 同时挂在两个房间的 P2P 里，画面互相抢占。
 *
 * 修复：join 分支开头（**取新房间之前**）做跨房间清理：
 *   - oldRoom.viewers.delete(ws)
 *   - 通知旧主机 viewer-left
 *   - ws.viewerId = null（否则跨房间复用同一 id 会让旧主机的
 *     removeViewer 误伤新房间的 peer）
 *
 * 本用例不启动浏览器、不建 RTCPeerConnection —— 完全在信令层验证，
 * 因此是**纯 WS 假设**，比 puppeteer 用例稳定得多。
 *
 * 依赖：ws（运行时依赖，非开发依赖）。未安装时 SKIP 并以 0 退出。
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

/** 打开一条 ws，把收到的所有消息 push 进 inbox（含 type 归类） */
function open() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    ws.inbox = [];
    ws.on('message', (buf) => {
      try { ws.inbox.push(JSON.parse(buf.toString())); } catch {}
    });
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}
/** 等 inbox 里出现满足条件的消息（先扫历史，再等新消息） */
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
const code = () => 'CR' + Math.random().toString(36).slice(2, 6).toUpperCase();

(async () => {
  const A = code(), B = code();
  const hostA = await open();
  const hostB = await open();
  const viewer = await open();

  // ---- 建立房间 A 和 B ----
  hostA.send(JSON.stringify({ type: 'create', code: A }));
  const hostAReady = await waitMsg(hostA, (m) => m.type === 'created');
  ok('房主 A 建房成功', hostAReady.code === A, JSON.stringify(hostAReady));
  hostB.send(JSON.stringify({ type: 'create', code: B }));
  await waitMsg(hostB, (m) => m.type === 'created');
  ok('房主 B 建房成功', true);

  // ---- 观看端加入房间 A ----
  viewer.send(JSON.stringify({ type: 'join', code: A }));
  const joinedA = await waitMsg(viewer, (m) => m.type === 'joined');
  ok('观看端加入房间 A', joinedA.code === A, JSON.stringify(joinedA));
  const vidA = joinedA.viewerId;
  const joinedEvt = await waitMsg(hostA, (m) => m.type === 'viewer-joined');
  ok('房主 A 收到 viewer-joined', joinedEvt.viewerId === vidA, JSON.stringify(joinedEvt));

  // ---- 关键：同一条 ws 切换到房间 B ----
  viewer.inbox.length = 0;
  hostA.inbox.length = 0;
  viewer.send(JSON.stringify({ type: 'join', code: B }));
  const joinedB = await waitMsg(viewer, (m) => m.type === 'joined');
  ok('观看端切换到房间 B（joined.code === B）', joinedB.code === B, JSON.stringify(joinedB));

  // 断言 1：旧主机 A 必须收到 viewer-left（证明 oldRoom.viewers.delete 执行了）
  let leftA = null;
  try { leftA = await waitMsg(hostA, (m) => m.type === 'viewer-left', 3000); } catch {}
  ok('房主 A 收到 viewer-left（旧房间引用已清）',
    !!leftA && leftA.viewerId === vidA, JSON.stringify(leftA));

  // 断言 2：viewerId 必须重置（否则旧主机 removeViewer 会误伤新房间 peer）
  ok('切换后 viewerId 已重新分配（不复用旧 id）',
    joinedB.viewerId && joinedB.viewerId !== vidA,
    `old=${vidA} new=${joinedB.viewerId}`);

  // 断言 3：新主机 B 收到 viewer-joined，且 id 与 joinedB 一致
  const joinedEvtB = await waitMsg(hostB, (m) => m.type === 'viewer-joined');
  ok('房主 B 收到 viewer-joined', joinedEvtB.viewerId === joinedB.viewerId,
    JSON.stringify(joinedEvtB));

  // 断言 4（活性/无半死状态）：关闭观看端 → 只有 B 收到 viewer-left，A 不再收到
  hostA.inbox.length = 0;
  viewer.close();
  let leftB = null;
  try { leftB = await waitMsg(hostB, (m) => m.type === 'viewer-left', 3000); } catch {}
  await sleep(400);
  ok('房主 B 收到 viewer-left（关闭归一）',
    !!leftB && leftB.viewerId === joinedB.viewerId, JSON.stringify(leftB));
  ok('房主 A 不再收到任何 viewer-left（无重复通知）',
    !hostA.inbox.some((m) => m.type === 'viewer-left'),
    JSON.stringify(hostA.inbox));

  hostA.close(); hostB.close();
  await sleep(200);
  console.log(`\n通过 ${pass}/${pass + fail}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('测试异常：', e); process.exit(1); });
