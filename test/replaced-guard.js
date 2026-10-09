/* P1 回归：被 replaced 的旧 host 不得把消息/二进制帧转发给新 host
 *
 * 缺陷机理：
 *   create(reused) 时服务端把旧 host 标为 role='replaced' 并 close()。
 *   但 close 是异步的，旧 ws 在握手期间仍可能收到浏览器发来的消息。
 *   原实现只靠改 role，而信令转发的分支结构是：
 *     if (ws.role === 'host') { ...定向给观看端... } else { 转发给 room.host }
 *   `role === 'host'` 为 false 后，旧 host **掉进了 else 分支**，
 *   被当成观看端，它的 offer/answer/ice/viewer-status 会转发给
 *   此时已是新 ws 的 room.host —— 新主机收到一堆 viewerId=undefined 的信令。
 *   二进制帧同理：旧 host 的残留分片会被当作"观看端→主机"转发给新 host。
 *
 * 为什么不用「纯刷新路径」构造：
 *   发送端刷新时，浏览器先发 host-away → 旧 ws 断开 → 服务端进入 15s 宽限，
 *   期间 room.host 被置空。新 ws 同码 create 时 `room.host` 已是 null，
 *   压根不会进入 `room.host.readyState === OPEN` 那条 replaced 分支。
 *   所以纯刷新路径**永远走不到 replaced**，也就无法用它验证守卫。
 *
 * ---- 本文件实际验证什么（与实现严格一致）----
 *
 *   `replaced` 分支本身在当前协议下**不可达**（详见 test/replaced-guard-race.js
 *   的推导与其 `hit=null` 处理）。因此本文件**不**试图去构造那个角色，改为
 *   验证"缺陷根因"与"未误伤"两端，二者都是真实可达的：
 *
 *   第 1 组（对照组）：缺陷根因成立
 *       用两个 ws 复刻 else 分支的处境——
 *         - host ws：正常 create（占住 room.host）
 *         - viewer ws：join 成为观看端（role='viewer'、roomCode=code，
 *                      且 room.host 指向 OPEN 的 host）
 *       验证该连接发出的 offer / 二进制帧**确实会被转发给 host**。
 *       这正是"role 非 host 的连接会落进 else 分支"的机理；
 *       被 replaced 的旧 host 若要作祟，走的也是同一条路。
 *
 *   第 2 组（不变量）：同码被占用时会换码
 *       验证 room.host 仍 OPEN 时，另一个 ws 同码 create 会**换码**而非静默接管。
 *       这佐证 replaced 分支需要"旧 ws 半开"这一窄竞态，故当前不可达。
 *
 *   第 3 组（未误伤）：正常观看端全流程完好
 *
 *   关于"守卫逻辑本身"的正反两向验证（白盒 A/B），在
 *   test/replaced-guard-race.js 第 3 组完成——那里本地复刻了服务端的转发分支，
 *   摘掉守卫即泄漏、装回即全拦。
 *
 * 断言（本文件）：
 *   1) 对照组：viewer 身份的消息**会**被转发给 host（证明 else 分支确实在转发）
 *   2) 对照组：viewer 身份的二进制帧**会**被转发给 host
 *   3) 不变量：同码被占用时新 ws 换码
 *   4) 修复未误伤：正常观看端仍可加入、其信令/二进制仍正常转发
 */
const WebSocket = require('ws');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c, e) => c ? (pass++, console.log('  \u2713 ' + n))
                          : (fail++, console.log('  \u2717 ' + n + (e ? '  ' + e : '')));

const BASE_WS = process.env.BASE_WS || 'ws://localhost:8080';
const BASE_URL = process.env.BASE_URL || 'http://localhost:8080';
const connect = () => new Promise((res, rej) => {
  const ws = new WebSocket(BASE_WS);
  ws.inbox = []; ws.binary = [];
  ws.on('message', (d, isBin) => {
    if (isBin) { ws.binary.push(Buffer.from(d)); return; }
    try { ws.inbox.push(JSON.parse(d.toString())); } catch {}
  });
  ws.on('open', () => res(ws));
  ws.on('error', rej);
});
const send = (ws, o) => ws.send(JSON.stringify(o));
const waitFrom = async (ws, cursor, pred, ms = 3000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    for (let i = cursor; i < ws.inbox.length; i++) if (pred(ws.inbox[i])) return ws.inbox[i];
    await sleep(60);
  }
  return null;
};

(async () => {
  // ================= 第 1 组：对照组（证明 else 分支确实会转发） =================
  // 这组用**修复前**观察到的行为做基线：一个 role='viewer' 的连接，
  // 其 offer/ice/二进制都会落到 host 手里。replaced 守卫要拦的正是同一条路径。
  console.log('\n【对照】viewer 身份的消息会转发给 host（修复前 replaced 的处境）');

  const host1 = await connect();
  let c = host1.inbox.length;
  send(host1, { type: 'create', lanOrigin: BASE_URL });
  const created1 = await waitFrom(host1, c, m => m.type === 'created');
  ok('\u2460 host1 建房成功', created1 && /^[A-Z0-9]{4}$/.test(created1.code), created1 && created1.code);
  const code1 = created1.code;

  const ghost = await connect();
  let cg = ghost.inbox.length;
  send(ghost, { type: 'join', code: code1 });
  const joinedG = await waitFrom(ghost, cg, m => m.type === 'joined');
  ok('\u2461 ghost 以 viewer 身份加入', !!joinedG, joinedG && joinedG.code);

  // 对照组核心：viewer 的 offer 会到达 host1
  let ch = host1.inbox.length;
  send(ghost, { type: 'offer', sdp: { type: 'offer', sdp: 'FAKE' } });
  const ctrlOffer = await waitFrom(host1, ch, m => m.type === 'offer', 1500);
  ok('对照组 A：viewer 的 offer 确实转发给 host（证明 else 分支在转发）',
     !!ctrlOffer, ctrlOffer && JSON.stringify(ctrlOffer));

  // 对照组核心：viewer 的二进制会到达 host1
  let chb = host1.binary.length;
  const gFrame = Buffer.from('ghost-binary');
  ghost.send(gFrame, { binary: true });
  const ctrlBin = await (async () => {
    const t0 = Date.now();
    while (Date.now() - t0 < 1500) { if (host1.binary.length > chb) return true; await sleep(60); }
    return false;
  })();
  ok('对照组 B：viewer 的二进制帧确实转发给 host（证明 else 分支在转发）',
     ctrlBin, `before=${chb} after=${host1.binary.length}`);

  ghost.close();
  await sleep(150);

  // ================= 第 2 组：同码被占用时换码（不变量） =================
  // 这一组**不**验证 replaced 拦截（那不可达），只验证：
  //   room.host 仍 OPEN 时，另一个 ws 同码 create 会被换成新码，而非静默接管。
  // 由它反推：replaced 分支要求 `room.host.readyState === OPEN`，
  // 而"同码被复用"又要求该 host 不是 OPEN —— 两者互斥，故 replaced 不可达。
  //
  // 注：尝试用 pause() 伪造"服务端视角的半开"是徒劳的——pause 只作用于
  // 本地事件派发，服务端看到的 ws.readyState 仍是 OPEN，于是 reusable 判断
  // 依旧为假、依旧换码，走不到 replaced。这也是 probe 里 0/5 的原因之一。

  console.log('\n【不变量】同码被占用时换码（佐证 replaced 不可达）');

  const host2 = await connect();
  c = host2.inbox.length;
  send(host2, { type: 'create', lanOrigin: BASE_URL });
  const created2 = await waitFrom(host2, c, m => m.type === 'created');
  ok('\u2462 host2 建房成功', created2 && /^[A-Z0-9]{4}$/.test(created2.code), created2 && created2.code);
  const code2 = created2.code;

  // 用一个持久观看来保持房间活跃
  const keeper = await connect();
  let ck = keeper.inbox.length;
  send(keeper, { type: 'join', code: code2 });
  const joinedK = await waitFrom(keeper, ck, m => m.type === 'joined');
  ok('\u2463 保持端加入', !!joinedK, joinedK && joinedK.code);

  // ---- 关键：让另一个 ws 在 room.host 仍 OPEN 时同码 create ----
  // 预期：服务端 reusable 判断里 `existing.host.readyState === OPEN` 成立
  // → 判定为"被他人占用"→ 换码（不会走 replaced）。
  // 这正是 replaced 不可达的实证：存活 host 占位时会换码，不会发生"接管"。
  const oldish = await connect();
  let co = oldish.inbox.length;
  send(oldish, { type: 'create', code: code2, lanOrigin: BASE_URL });
  const createdOld = await waitFrom(oldish, co, m => m.type === 'created');
  // 由于 room.host 仍 OPEN 且 !== oldish，服务端会换码 → 不复用
  const swapped = createdOld && createdOld.code !== code2;
  ok('\u2464 同码被占用时新 ws 换码（佐证"存活 host 占位时不发生接管"）',
     swapped, createdOld && `code=${createdOld.code} reused=${createdOld.reused}`);

  oldish.close();

  // ================= 第 3 组：修复未误伤 =================
  console.log('\n【未误伤】正常观看端流程完好');

  const viewer = await connect();
  let cv = viewer.inbox.length;
  // 游标必须在 send **之前**取：viewer-joined 与 joined 几乎同时发出，
  // joined 先到达我方（viewer），等它回来再取 host2 的游标就已经晚了，
  // viewer-joined 早已进入 host2.inbox，会被当成"历史消息"漏掉。
  const c2 = host2.inbox.length;
  send(viewer, { type: 'join', code: code2 });
  const joined = await waitFrom(viewer, cv, m => m.type === 'joined');
  ok('\u2465 正常观看端仍可加入', !!joined, joined && joined.code);

  const vjoined = await waitFrom(host2, c2, m => m.type === 'viewer-joined');
  ok('\u2466 观看端的 viewer-joined 仍能到达 host（未误伤）',
     !!vjoined && !!vjoined.viewerId, vjoined && vjoined.viewerId);

  const c3 = host2.inbox.length;
  send(viewer, { type: 'offer', sdp: { type: 'offer', sdp: 'REAL' } });
  await sleep(600);
  const relayed = host2.inbox.slice(c3).filter(m => m.type === 'offer');
  ok('\u2467 观看端的 offer 正常转发给 host（未误伤）', relayed.length === 1,
     JSON.stringify(relayed.map(m => `${m.type}:${m.viewerId}`)));

  const b2 = host2.binary.length;
  viewer.send(Buffer.from('hello-from-viewer'), { binary: true });
  const vbin = await (async () => {
    const t0 = Date.now();
    while (Date.now() - t0 < 1500) { if (host2.binary.length > b2) return true; await sleep(60); }
    return false;
  })();
  ok('\u2468 观看端的二进制帧正常转发给 host（未误伤）',
     vbin, `before=${b2} after=${host2.binary.length}`);

  host1.close(); host2.close(); keeper.close(); viewer.close();
  await sleep(200);
  console.log(`\n通过 ${pass}/${pass + fail}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('异常:', e.message, e.stack); process.exit(1); });
