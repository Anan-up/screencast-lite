/* P1 回归：replaced 守卫的行为 + 可达性说明
 *
 * 调查结论（见 probe-replaced-reachable.js，0/5 命中）：
 *   服务端 create 分支里，(A) reusable 与 (C) replaced 对**同一个 host**
 *   的 readyState 判断互斥：
 *     (A) reusable:  existing.host.readyState !== OPEN  → 才复用同码
 *     (C) replaced:  room.host.readyState   ===  OPEN  → 才判被替换
 *   两者不可能同时为真；若 (A) 为假则换码，room 变成全新空房间，(C) 也假。
 *   ∴ replaced 通知与守卫在当前协议下是**防御性的、不可达的代码**。
 *
 * 那为什么还要保留并测试它？
 *   1) 它是「同码被他人占用」这一未来扩展的语义锚点。若哪天放开
 *      "允许强制接管同码房间"，(C) 会立刻变成热路径，守卫必须已经在那儿。
 *   2) 它的存在让 create 分支的意图自解释——读代码的人不必自己推导
 *      "role 改了为什么还不够"。
 *
 * 本文件因此做两件事：
 *   A) 黑盒验证**当前协议下不可达**（不变量回归：若有人改动 (A)/(C) 使其
 *      可达，或旧 host 开始收到 replaced 而不清状态，这里会失败）；
 *   B) 白盒验证**守卫逻辑本身正确**：用一个本地复刻的迷你转发器，
 *      把 replaced 守卫的两个分支（有守卫 / 无守卫）都跑一遍，
 *      证明"有守卫时消息被丢弃，无守卫时会泄漏"。
 *
 * 断言：
 *   1) 对照组：role 非 host 的连接，其消息会被转发（缺陷根因成立）
 *   2) 不可达性：可观测的时序下旧 host 都收不到 replaced（S5 因 terminate 后
 *     无法从外部观测，记 hit=null 并排除在断言外，不冒充证据）
 *   3) 白盒：无守卫 → 消息泄漏；有守卫 → 消息被拦（A/B 对照）
 *   4) 未误伤：正常观看端全流程完好
 */
const WebSocket = require('ws');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c, e) => c ? (pass++, console.log('  \u2713 ' + n))
                          : (fail++, console.log('  \u2717 ' + n + (e ? '  ' + e : '')));

const BASE_WS = process.env.BASE_WS || 'ws://localhost:8080';
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
const send = (ws, o) => { try { ws.send(JSON.stringify(o)); } catch {} };
const waitFrom = async (ws, cursor, pred, ms = 2000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    for (let i = cursor; i < ws.inbox.length; i++) if (pred(ws.inbox[i])) return ws.inbox[i];
    await sleep(50);
  }
  return null;
};
const mkRoom = async () => {
  const h = await connect();
  let c = h.inbox.length;
  send(h, { type: 'create' });
  const cr = await waitFrom(h, c, m => m.type === 'created', 2500);
  return { h, code: cr && cr.code };
};

(async () => {
  // ================= 1. 对照组：非 host 连接会被转发（缺陷根因） =================
  console.log('\n【对照】role 非 host 的连接，消息会落进 else 分支被转发');
  {
    const { h, code } = await mkRoom();
    const ghost = await connect();
    let cg = ghost.inbox.length;
    send(ghost, { type: 'join', code });
    await waitFrom(ghost, cg, m => m.type === 'joined', 2000);

    let ch = h.inbox.length;
    send(ghost, { type: 'offer', sdp: { type: 'offer', sdp: 'FAKE' } });
    const fwd = await waitFrom(h, ch, m => m.type === 'offer', 1500);
    ok('对照组 A：非 host 连接的 offer 确实转发给 host（根因成立）', !!fwd,
       fwd && JSON.stringify(fwd));

    const hb = h.binary.length;
    ghost.send(Buffer.from('ghost'), { binary: true });
    const fwdBin = await (async () => {
      const t0 = Date.now();
      while (Date.now() - t0 < 1500) { if (h.binary.length > hb) return true; await sleep(50); }
      return false;
    })();
    ok('对照组 B：非 host 连接的二进制帧确实转发给 host（根因成立）', fwdBin,
       `before=${hb} after=${h.binary.length}`);
    ghost.close(); h.close(); await sleep(150);
  }

  // ===== 2. 不可达性：可观测时序均命中不了 replaced（S5 不可观测，见其注释）=====
  console.log('\n【不变量】当前协议下 replaced 分支不可达');
  {
    const cases = [];

    // S1 旧 host 存活 + 新 ws 同码
    {
      const { h, code } = await mkRoom();
      const n = await connect();
      let cn = n.inbox.length;
      send(n, { type: 'create', code });
      const cr = await waitFrom(n, cn, m => m.type === 'created', 2000);
      const hit = h.inbox.some(m => m.type === 'replaced');
      cases.push({ n: 'S1', hit, code, got: cr && cr.code });
      h.close(); n.close(); await sleep(120);
    }
    // S3 host-away 后立即同码
    {
      const { h, code } = await mkRoom();
      send(h, { type: 'host-away' });
      const n = await connect();
      let cn = n.inbox.length;
      send(n, { type: 'create', code });
      const cr = await waitFrom(n, cn, m => m.type === 'created', 2000);
      const hit = h.inbox.some(m => m.type === 'replaced');
      cases.push({ n: 'S3', hit, code, got: cr && cr.code });
      h.close(); n.close(); await sleep(120);
    }
    // S4 半开
    {
      const { h, code } = await mkRoom();
      try { if (h._socket) h._socket.pause(); h.pause(); } catch {}
      const n = await connect();
      let cn = n.inbox.length;
      send(n, { type: 'create', code });
      const cr = await waitFrom(n, cn, m => m.type === 'created', 2000);
      try { if (h._socket) h._socket.resume(); h.resume(); } catch {}
      const hit = h.inbox.some(m => m.type === 'replaced');
      cases.push({ n: 'S4', hit, code, got: cr && cr.code });
      h.close(); n.close(); await sleep(120);
    }
    // S5 host-away + terminate 抢发
    {
      const { h, code } = await mkRoom();
      send(h, { type: 'host-away' });
      await sleep(50);
      try { h.terminate(); } catch {}
      const n = await connect();
      let cn = n.inbox.length;
      send(n, { type: 'create', code });
      const cr = await waitFrom(n, cn, m => m.type === 'created', 2000);
      // 注意：h 已 terminate()，此后它的 inbox **不再增长**，
      // 因此本用例**无法**从外部观测"旧 host 有没有收到 replaced"——
      // 写 hit:false 是错的，那会把"监听器已死、无从接收"混同于"服务端确实没发"。
      // 所以显式记 hit:null（不可观测），并在下面的断言里排除它。
      // 本用例真正验证的是：旧 ws 已断的情况下房间仍可被新 ws 复用（走优雅窗口分支）。
      cases.push({ n: 'S5', hit: null, code, got: cr && cr.code,
                   reused: cr && cr.reused, note: 'socket 已 terminate，观测不可能' });
      n.close(); await sleep(120);
    }
    // S6 leave 后同码
    {
      const { h, code } = await mkRoom();
      send(h, { type: 'leave' });
      await sleep(150);
      const n = await connect();
      let cn = n.inbox.length;
      send(n, { type: 'create', code });
      const cr = await waitFrom(n, cn, m => m.type === 'created', 2000);
      const hit = h.inbox.some(m => m.type === 'replaced');
      cases.push({ n: 'S6', hit, code, got: cr && cr.code });
      h.close(); n.close(); await sleep(120);
    }

    for (const c of cases) {
      const hitTxt = c.hit === null ? '不可观测' : String(c.hit);
      console.log(`   ${c.n}: 原码=${c.code} 新码=${c.got} ${c.got !== c.code ? '(换码)' : '(复用)'} replaced=${hitTxt}${c.note ? ' · ' + c.note : ''}`);
    }
    // 只统计**可观测**的用例：hit===null 表示"监听器已死、无从接收"，
    // 不能当作"服务端没发 replaced"的证据，必须排除，否则断言被稀释。
    const observable = cases.filter(c => c.hit !== null);
    const leaked = observable.filter(c => c.hit === true);
    ok(`协议不可达：可观测的 ${observable.length} 种时序下旧 host 均未收到 replaced`,
       leaked.length === 0,
       JSON.stringify({ observable: observable.map(c => c.n), leaked: leaked.map(c => c.n) }));
    ok('换码机制生效：占用中的同码不会被静默接管',
       cases.filter(c => c.got !== c.code).length >= 3,
       JSON.stringify(cases.map(c => `${c.n}:${c.got === c.code ? '复用' : '换码'}`)));
  }

  // ============ 3. 白盒：守卫逻辑本身正确（本地复刻转发器 A/B 对照） ============
  console.log('\n【白盒】守卫逻辑 A/B 对照（本地复刻服务端转发分支）');
  {
    // 精确复刻 server.js 的两处判断，只抽掉网络层
    function makeRelay(withGuard) {
      const delivered = [];
      const handler = (sender, msg) => {
        // --- handleSignal 入口 ---
        if (withGuard && sender.role === 'replaced') return;   // 守卫
        // --- offer/answer/ice/viewer-status 分支 ---
        if (sender.role === 'host') {
          delivered.push({ to: 'viewer', type: msg.type });
        } else {
          delivered.push({ to: 'host', type: msg.type, viewerId: sender.viewerId });
        }
      };
      const handlerBinary = (sender) => {
        // --- 二进制分支入口 ---
        if (withGuard && sender.role === 'replaced') return;   // 守卫
        if (sender.role === 'host') delivered.push({ to: 'viewer', type: 'bin' });
        else delivered.push({ to: 'host', type: 'bin' });
      };
      return { delivered, handler, handlerBinary };
    }

    const stale = () => ({ role: 'replaced', viewerId: undefined, roomCode: 'AAAA' });

    // A) 无守卫 → 泄漏
    {
      const r = makeRelay(false);
      const s = stale();
      r.handler(s, { type: 'offer' });
      r.handler(s, { type: 'ice' });
      r.handlerBinary(s);
      ok('白盒 A：无守卫时旧连接的消息泄漏给 host（复现缺陷）',
         r.delivered.length === 3 && r.delivered.every(d => d.to === 'host'),
         JSON.stringify(r.delivered));
      ok('白盒 A：泄漏消息的 viewerId 为 undefined（正是原先的错乱形态）',
         r.delivered[0].viewerId === undefined,
         JSON.stringify(r.delivered[0]));
    }

    // B) 有守卫 → 全拦
    {
      const r = makeRelay(true);
      const s = stale();
      r.handler(s, { type: 'offer' });
      r.handler(s, { type: 'answer' });
      r.handler(s, { type: 'ice' });
      r.handler(s, { type: 'viewer-status' });
      r.handlerBinary(s);
      ok('白盒 B：有守卫时旧连接的消息被全部拦下（修复生效）',
         r.delivered.length === 0, JSON.stringify(r.delivered));
    }

    // C) 守卫不误伤正常角色
    {
      const r = makeRelay(true);
      r.handler({ role: 'viewer', viewerId: 'v1' }, { type: 'offer' });
      r.handler({ role: 'host' }, { type: 'offer', viewerId: 'v1' });
      r.handlerBinary({ role: 'viewer', viewerId: 'v1' });
      ok('白盒 C：守卫对 viewer/host 角色零影响',
         r.delivered.length === 3 &&
         r.delivered[0].to === 'host' &&
         r.delivered[1].to === 'viewer' &&
         r.delivered[2].to === 'host',
         JSON.stringify(r.delivered));
    }
  }

  // ================= 4. 未误伤：正常观看端全流程 =================
  console.log('\n【未误伤】正常观看端流程完好');
  {
    const { h, code } = await mkRoom();
    const v = await connect();
    let cv = v.inbox.length;
    const cn = h.inbox.length;
    send(v, { type: 'join', code });
    const joined = await waitFrom(v, cv, m => m.type === 'joined');
    ok('正常观看端可加入', !!joined, joined && joined.code);

    const vj = await waitFrom(h, cn, m => m.type === 'viewer-joined');
    ok('viewer-joined 到达 host', !!vj && !!vj.viewerId, vj && vj.viewerId);

    const c1 = h.inbox.length;
    send(v, { type: 'offer', sdp: { type: 'offer', sdp: 'REAL' } });
    await sleep(600);
    ok('观看端 offer 正常转发', h.inbox.slice(c1).filter(m => m.type === 'offer').length === 1,
       JSON.stringify(h.inbox.slice(c1).map(m => m.type)));

    const b = h.binary.length;
    v.send(Buffer.from('viewer-bin'), { binary: true });
    const binOk = await (async () => {
      const t0 = Date.now();
      while (Date.now() - t0 < 1500) { if (h.binary.length > b) return true; await sleep(50); }
      return false;
    })();
    ok('观看端二进制帧正常转发', binOk, `before=${b} after=${h.binary.length}`);
    v.close(); h.close(); await sleep(150);
  }

  console.log(`\n通过 ${pass}/${pass + fail}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('异常:', e.message, e.stack); process.exit(1); });
