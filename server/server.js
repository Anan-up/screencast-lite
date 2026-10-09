#!/usr/bin/env node
'use strict';

/**
 * 极简投屏 · 信令与中继服务
 *
 * 职责：
 *   1. 托管 public/ 下的前端静态页
 *   2. WebSocket 信令：房间码配对、SDP 交换、ICE 候选转发
 *   3. TURN 临时凭据下发（配置了 TURN_SECRET 时启用）
 *   4. P2P 打不通时，用 WebSocket 二进制帧做中继兜底（纯服务端中转模式）
 *
 * 启动：
 *   node server/server.js
 *   PORT=8080 TURN_URL=turn:1.2.3.4:3478 TURN_SECRET=xxx node server/server.js
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = parseInt(process.env.PORT || '8080', 10);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// ---------- TURN 配置（可选） ----------
const TURN_URL = process.env.TURN_URL || '';          // 例：turn:turn.example.com:3478
const TURN_SECRET = process.env.TURN_SECRET || '';    // coturn 的 static-auth-secret
const TURN_TTL = parseInt(process.env.TURN_TTL || '86400', 10);

/** 中继分片前缀长度：8 字节 viewerId（与前端 host.js 的 RELAY_ID_LEN 保持一致） */
const RELAY_ID_LEN = 8;
/**
 * 单个中继分片的上限。
 *
 * 正常分片来自 MediaRecorder.start(120)（120ms 一片），最高画质档
 * （15Mbps）下也只有约 225KB。ws 层的 maxPayload=20MB 只是防内存炸裂的
 * 底线，不能被当中继上限用：恶意客户端可以推 20MB 的"分片"，服务端
 * 会原样转发给观看端（放大攻击面 + 占满观看端带宽）。超限帧直接丢弃
 * ——不踢连接：编码器瞬时突发也可能超一点，踢掉误伤大于收益。
 */
const RELAY_FRAME_MAX = 1 * 1024 * 1024;

/**
 * 生成 coturn REST API 风格的临时凭据（RFC 5766 + coturn use-auth-secret）
 * username = <过期时间戳>:<随机串>，password = base64(HMAC-SHA1(secret, username))
 */
function makeTurnCredential() {
  if (!TURN_URL || !TURN_SECRET) return null;
  const username = `${Math.floor(Date.now() / 1000) + TURN_TTL}:screencast`;
  const hmac = crypto.createHmac('sha1', TURN_SECRET).update(username).digest('base64');
  return { urls: TURN_URL, username, credential: hmac, ttl: TURN_TTL };
}

// ---------- 静态文件服务 ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function serveStatic(req, res) {
  let urlPath;
  try {
    urlPath = decodeURIComponent(req.url.split('?')[0]);
  } catch {
    // 畸形转义（如 GET /%）会让 decodeURIComponent 抛 URIError。
    // 本函数在同步 HTTP handler 链里被直接调用，异常若不被接住就会
    // 变成未捕获异常打死整个进程 —— 实测一条 GET /% 即可让服务退出
    // （攻击前 /api/health 200 → 攻击后连接拒绝）。按 HTTP 语义回 400。
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Bad Request');
    return;
  }
  if (urlPath === '/' || urlPath === '/index.html') urlPath = '/index.html';
  if (urlPath === '/cast' || urlPath === '/cast/') urlPath = '/cast.html';
  if (urlPath === '/view' || urlPath === '/view/') urlPath = '/view.html';

  const filePath = path.join(PUBLIC_DIR, path.normalize(urlPath).replace(/^(\.\.[/\\])+/, ''));

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
    }).end(data);
  });
}

/** 让浏览器在局域网里也能用 getUserMedia / getDisplayMedia（非安全上下文豁免） */
function isLocalAddress(addr) {
  if (!addr) return false;
  const a = addr.replace(/^::ffff:/, '');
  return (
    a === '127.0.0.1' || a === '::1' || a === 'localhost' ||
    /^10\./.test(a) || /^192\.168\./.test(a) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(a) || /^169\.254\./.test(a)
  );
}

const server = http.createServer((req, res) => {
  // 让 localhost / 局域网 IP / .local 域名都被视为可信来源，
  // 否则 Chrome 会拒绝 HTTP 下的屏幕采集 API
  const origin = req.headers.origin || '';
  const reqHost = (req.headers.host || '').split(':')[0];
  if (isLocalAddress(reqHost)) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
  }

  if (req.url.startsWith('/api/config')) {
    const turn = makeTurnCredential();
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    }).end(JSON.stringify({
      turn,
      // 前端据此判断是否可以用屏幕采集（非 HTTPS 时需要局域网豁免）
      insecureOk: true,
    }));
    return;
  }

  if (req.url.startsWith('/api/health')) {
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(
      JSON.stringify({ ok: true, rooms: rooms.size, uptime: process.uptime() })
    );
    return;
  }

  serveStatic(req, res);
});

// ---------- 房间与信令 ----------
/** rooms: Map<code, { host: ws|null, viewers: Set<ws>, createdAt, relayMode }> */
const rooms = new Map();
const ROOM_TTL = 1000 * 60 * 60 * 6; // 6 小时无活动自动回收
const MAX_VIEWERS = 8;
// 主机信令抖动后的优雅重连窗口：窗口内房间不销毁，大屏保持"等待恢复"，
// 主机用同一房间码重连即无缝接回；超时才真正 destroyRoom。
const HOST_AWAY_GRACE_MS = 15000;

function genCode() {
  // 去掉易混淆字符 0/O/1/I，4 位房间码
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 4 }, () =>
      alphabet[crypto.randomInt(alphabet.length)]
    ).join('');
  } while (rooms.has(code));
  return code;
}

function getRoom(code) {
  let room = rooms.get(code);
  if (!room) {
    room = {
      host: null,
      viewers: new Set(),
      createdAt: Date.now(),
      lastActive: Date.now(),
      // 优雅重连状态：主机信令抖动时先标记 hostAway 并广播 host-away，
      // 随后 ws.on('close') 不立即销毁房间，而是在 HOST_AWAY_GRACE_MS 内
      // 等待主机用同一房间码重连（create 复用路径会清掉这两个字段）。
      hostAway: false,
      awaySince: 0,
      pendingDestroy: null,
    };
    rooms.set(code, room);
  }
  room.lastActive = Date.now();
  return room;
}

/** 清理房间上的优雅重连定时器与标记（复用/销毁时必须调用，避免残留定时器误杀新会话） */
function clearAwayState(room) {
  if (!room) return;
  if (room.pendingDestroy) { clearTimeout(room.pendingDestroy); room.pendingDestroy = null; }
  room.hostAway = false;
  room.awaySince = 0;
}

function send(ws, obj) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function broadcastToViewers(room, obj, except) {
  for (const v of room.viewers) if (v !== except) send(v, obj);
}

function destroyRoom(code, reason) {
  const room = rooms.get(code);
  if (!room) return;
  clearAwayState(room);
  broadcastToViewers(room, { type: 'room-closed', reason: reason || '主机关闭了投屏' });
  rooms.delete(code);
  // 房间没了，观看端 ws 上残留的 roomCode/role 必须一并清掉。
  // 否则观看端关闭时 `ws.on('close')` 里 `rooms.get(ws.roomCode)` 返回 undefined
  // 会**提前 return**，导致 viewer-left 永远不会发给主机；主机保留旧 viewerId
  // 就形成了"幽灵大屏"（README 里有完整机理）。在源头清干净，
  // 后续所有以 roomCode 为前置的判断都自然为假，不会再有半死状态。
  //
  // ⚠️ 这里是"房间销毁时清理 ws 角色"的**唯一权威写入点**。
  // 调用方不要再重复清理（handleSignal 的 leave 分支保留了幂等的重复清空，
  // 那是为了覆盖不销毁房间的 viewer 分支，属于有意的防御性冗余）。
  // 若将来在这里新增**非幂等**动作（例如写审计日志、计数上报），
  // 必须同步检查 leave 路径，否则会被执行两次。
  for (const v of room.viewers) {
    v.roomCode = null;
    v.role = null;
  }
  if (room.host) {
    room.host.roomCode = null;
    room.host.role = null;
  }
}

// 定期清理僵尸房间
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.lastActive > ROOM_TTL) destroyRoom(code, '房间超时');
  }
}, 60_000).unref();

const wss = new WebSocketServer({ server, maxPayload: 20 * 1024 * 1024 });

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.roomCode = null;
  ws.role = null;
  ws.on('pong', () => { ws.isAlive = true; });

  const remoteIp = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '')
    .toString().split(',')[0].trim().replace(/^::ffff:/, '');
  ws.remoteIp = remoteIp;

  ws.on('message', (data, isBinary) => {
    // ---- 二进制帧：中继转发通道 ----
    // 主机 -> 观看端的分片带 8 字节 viewerId 前缀，必须定向转发。
    // 若广播给全房间，处于 P2P 模式的观看端会不断堆积无人消费的分片（内存泄漏）。
    if (isBinary) {
      // 已被替换的旧连接：二进制帧同样要丢弃。
      // 否则旧的 host 会掉进下面的 else（观看端）分支，
      // 把它残留的分片转发给**新** host，造成中继数据串流。
      if (ws.role === 'replaced') return;
      const room = rooms.get(ws.roomCode);
      if (!room) return;
      if (ws.role === 'host') {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        if (buf.length <= RELAY_ID_LEN) return;
        if (buf.length > RELAY_FRAME_MAX) {
          console.warn(`[中继] 丢弃超限分片：${buf.length} 字节 > ${RELAY_FRAME_MAX}（来源 ${ws.remoteIp}）`);
          return;
        }
        const targetId = buf.subarray(0, RELAY_ID_LEN).toString('utf8').trim();
        const payload = buf.subarray(RELAY_ID_LEN);
        for (const v of room.viewers) {
          if (v.viewerId === targetId && v.readyState === v.OPEN) {
            v.send(payload, { binary: true });
            v.lastBytes = (v.lastBytes || 0) + payload.length;
            break;
          }
        }
      } else if (room.host && room.host.readyState === room.host.OPEN) {
        // 观看端 -> 主机：单播，无需前缀
        room.host.send(data, { binary: true });
      }
      return;
    }

    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    handleSignal(ws, msg);
  });

  ws.on('close', () => {
    const code = ws.roomCode;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;
    if (ws.role === 'host' && room.host === ws) {
      room.host = null;
      // 主机先前发过 host-away → 处于优雅重连窗口，先不销毁房间。
      // 房间保留（大屏仍挂着、房间码仍可复用），由定时器在窗口耗尽后收尾。
      // 这样大屏只看到一次"发送端连接波动，正在恢复…"，而不是"投屏已结束"。
      if (room.hostAway) {
        const remain = HOST_AWAY_GRACE_MS - (Date.now() - room.awaySince);
        if (remain > 0) {
          clearTimeout(room.pendingDestroy);
          room.pendingDestroy = setTimeout(() => {
            room.pendingDestroy = null;
            // 窗口内主机已回归（create 复用会清 hostAway 并重建 host）→ 不销毁
            if (room.host) { clearAwayState(room); return; }
            destroyRoom(code, '主机重连超时');
          }, remain);
          return;
        }
      }
      destroyRoom(code, '主机已断开');
    } else if (ws.role === 'viewer') {
      room.viewers.delete(ws);
      if (room.host) {
        send(room.host, { type: 'viewer-left', viewerId: ws.viewerId, ip: ws.remoteIp });
      }
      if (room.viewers.size === 0 && room.host) {
        send(room.host, { type: 'no-viewers' });
      }
    }
  });

  ws.on('error', () => { /* 忽略，close 会处理清理 */ });
});

function handleSignal(ws, msg) {
  const { type } = msg;

  // 已被替换的旧连接：忽略一切消息，安静地等 close 走完。
  //
  // 为什么不能只靠 `role = 'replaced'`：
  //   close() 是异步的，旧 ws 在握手期间仍可能收到浏览器发来的消息。
  //   进入下面的 switch 后，`if (ws.role === 'host')` 已为 false，
  //   于是 offer/answer/ice/viewer-status 会落进 else 分支被当作
  //   **观看端**的消息转发给 `room.host`——而此时 room.host 已经是新 ws。
  //   结果：新主机收到一堆 viewerId 为 undefined 的信令。
  //   当前不会崩（各 handler 都有 if (!entry) 守卫），但语义完全错乱。
  //   所以这里必须显式拒绝，而不是指望 role 变更能挡住转发。
  //
  // 注意：'replaced' 只由"同房间码被新 host 接管"这一条路径设置。
  // 若旧 ws 之后又想 create/join，会被直接丢弃——这是期望行为，
  // 它的浏览器端已经收到 replaced 提示，应由前端重新走流程。
  if (ws.role === 'replaced') return;

  switch (type) {
    // ---------- 主机创建房间 ----------
    case 'create': {
      const req = msg.code ? String(msg.code).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) : '';
      const existing = req ? rooms.get(req) : null;
      // 请求的码可复用当且仅当：房间不存在 / 占用者就是自己（重连、重开）/
      // 房间没有 host / 旧 host 的 ws 已经关了（TCP 半开时 close 事件可能延迟）
      //
      // 最后一条很关键：用户刷新发送端页面时，旧 ws 往往还处于半开状态没触发
      // close（要等心跳超时），此时 existing.host 是那个将死的 ws。
      // 若不判断 readyState，就会误判为"被他人占用"而 genCode() 换码，
      // 导致刷新后房间码变化、大屏需要重新输入。
      const reusable = !existing
        || existing.host === ws
        || !existing.host
        || existing.host.readyState !== existing.host.OPEN;
      const code = (req && reusable) ? req : genCode();

      // 若从旧房间切过来，先把旧房间作废，避免残留
      if (ws.roomCode && ws.roomCode !== code) {
        const old = rooms.get(ws.roomCode);
        if (old && old.host === ws) destroyRoom(ws.roomCode, '主机已切换到新房间');
      }

      ws.roomCode = code;
      ws.role = 'host';
      const room = getRoom(code);
      // 复用同一房间码 = 主机已回归。必须清掉优雅重连的标记与待销毁定时器：
      //  - 定时器不清 → 15 秒后它仍会触发，而此时房间里已有活跃 host，
      //    虽然定时器回调里有 `if (room.host) return` 兜底，但留着是隐患；
      //  - hostAway 不清 → 下一次信号抖动会带着旧的 awaySince 进入窗口，
      //    剩余时间计算错误（可能直接判为已超时而立即销毁）。
      clearAwayState(room);
      if (room.host && room.host !== ws && room.host.readyState === room.host.OPEN) {
        send(room.host, { type: 'replaced' });
        // 先解除旧 ws 的角色，再 close。这一手解决**两件事**：
        //
        //  1) 防误销毁。ws.on('close') 靠 `ws.role === 'host' && room.host === ws`
        //     判断是否销毁房间。第二个条件此刻已因 `room.host = ws` 而为 false，
        //     所以当前是安全的，但这份安全性依赖两次赋值之间的时序。
        //     改掉 role 相当于多上一道锁：即使将来 close 变为同步触发，
        //     也不会误销毁刚建好的房间。
        //
        //  2) 防消息错乱。旧 ws 在 close 握手期间仍可能收到消息，
        //     handleSignal 入口对 'replaced' 做了显式 return，
        //     使它既不被当作 host 处理、也不会落进 viewer 分支被转发。
        //     （仅靠 role 变更是不够的——`role === 'host'` 为假只会让它
        //      掉进 else 分支，反而被当成观看端转发出去。）
        room.host.role = 'replaced';
        room.host.close();
      }
      room.host = ws;
      const reusedNow = !!req && req === code;
      send(ws, {
        type: 'created',
        code,
        lanUrl: msg.lanOrigin || '',
        reused: reusedNow,
        turn: makeTurnCredential(),
      });
      // 复用房间时补发现有的观看端清单。
      //
      // 主机端 viewerMap 在信令断开时被清空过（为了消除幽灵条目），
      // 所以重连后它眼里是"空房间"。若房间其实还挂着大屏（优雅重连
      // 窗口内房间没销毁），主机必须知道有谁在等它，才能主动发起 offer。
      //
      // 否则恢复路径就只剩"大屏单边驱动"这一条：大屏收到 host-return
      // 后主动 join，服务端才发 viewer-joined。万一那条链路再出问题
      // （比如判定逻辑写错），主机会完全不知道有人在等，画面永久黑屏。
      // 这里补发后变成"服务端广播 + 大屏驱动"双保险。
      if (reusedNow) {
        for (const v of room.viewers) {
          if (v.readyState !== v.OPEN) continue;
          send(ws, {
            type: 'viewer-joined',
            viewerId: v.viewerId,
            ip: v.remoteIp,
            sameLan: isLocalAddress(v.remoteIp) && isLocalAddress(ws.remoteIp),
            rejoined: true,
          });
        }
      }
      console.log(`[房间] ${code} 已创建 · 主机 ${ws.remoteIp}${reusedNow ? ` · 补发 ${room.viewers.size} 台观看端` : ''}`);
      break;
    }

    // ---------- 观看端加入房间 ----------
    case 'join': {
      const code = String(msg.code || '').toUpperCase().trim();

      // 跨房间切换：这个 ws 之前挂在别的房间里，必须先把旧引用清干净。
      //
      // 真实场景：大屏用户手动输入了另一个房间码，或带着 ?r= 参数
      // 走到一个新房间。若不清理：
      //   - 旧房间的 viewers 里仍挂着本 ws，size 永不下降，
      //     旧主机的「大屏数」长期虚高，且 MAX_VIEWERS 名额被占死；
      //   - 旧主机会继续给本 ws 发 offer / viewer-status，
      //     大屏照常应答 → 一条 ws 同时挂在两个房间的 P2P 里，
      //     画面互相抢占，行为无法预测。
      //
      // 顺序很重要：必须在取 room（新房间）之前做，且必须重置 viewerId，
      // 否则跨房间复用同一个 id 会让旧主机的 removeViewer 误伤新房间的 peer。
      if (ws.role === 'viewer' && ws.roomCode && ws.roomCode !== code) {
        const oldRoom = rooms.get(ws.roomCode);
        if (oldRoom) {
          oldRoom.viewers.delete(ws);
          if (oldRoom.host && oldRoom.host.readyState === oldRoom.host.OPEN) {
            send(oldRoom.host, { type: 'viewer-left', viewerId: ws.viewerId, ip: ws.remoteIp });
          }
        }
        ws.viewerId = null;
      }

      const room = rooms.get(code);
      if (!room) {
        send(ws, { type: 'join-failed', reason: '房间不存在或已关闭' });
        return;
      }
      if (!room.host || room.host.readyState !== room.host.OPEN) {
        send(ws, { type: 'join-failed', reason: '主机尚未开始投屏' });
        return;
      }
      // 重复 join：同一个 ws 已经是本房间的观看端了。
      // 这发生在"主机优雅重连后大屏主动重建连接"的场景——房间没销毁，
      // 大屏的 ws 一直挂在 room.viewers 里，此时再来一次 join 若照常
      // 分配新 viewerId，主机会把它当成一个全新设备 addViewer，
      // 而旧 viewerId 对应的 peer 永远不会回收（幽灵大屏复现）。
      // 因此复用原 viewerId，并让主机按同一 id 重新走 offer 流程。
      const rejoining = (ws.role === 'viewer') && room.viewers.has(ws) && ws.viewerId;
      if (!rejoining && room.viewers.size >= MAX_VIEWERS) {
        send(ws, { type: 'join-failed', reason: `观看端已达上限（${MAX_VIEWERS}）` });
        return;
      }
      ws.roomCode = code;
      ws.role = 'viewer';
      if (!rejoining) ws.viewerId = crypto.randomUUID().slice(0, 8);
      room.viewers.add(ws);
      send(ws, {
        type: 'joined',
        code,
        viewerId: ws.viewerId,
        turn: makeTurnCredential(),
        rejoined: !!rejoining,
      });
      // 通知主机：有新观众，请发起 offer
      //  - 重连场景：主机会用同一 viewerId 重新建 peer（先 removeViewer 再 addViewer）
      send(room.host, {
        type: 'viewer-joined',
        viewerId: ws.viewerId,
        ip: ws.remoteIp,
        sameLan: isLocalAddress(ws.remoteIp) && isLocalAddress(room.host.remoteIp),
        rejoined: !!rejoining,
      });
      console.log(`[房间] ${code} 观看端${rejoining ? '重新加入' : '加入'} · ${ws.remoteIp}`);
      break;
    }

    // ---------- 信令转发（offer / answer / ice / relay-begin） ----------
    case 'offer':
    case 'answer':
    case 'ice':
    case 'relay-begin':
    case 'relay-failed': {
      const room = rooms.get(ws.roomCode);
      if (!room) return;
      if (ws.role === 'host') {
        const target = [...room.viewers].find((v) => v.viewerId === msg.viewerId);
        if (target) send(target, { ...msg, type: msg.type });
      } else {
        if (room.host) send(room.host, { ...msg, type: msg.type, viewerId: ws.viewerId });
      }
      break;
    }

    // ---------- 观看端告知主机会话状态 ----------
    case 'viewer-status': {
      const room = rooms.get(ws.roomCode);
      if (room && room.host) {
        // ⚠️ 展开顺序：payload 在前，viewerId 与 type 都**殿后**、由服务端锁定。
        //
        // viewerId 必须由服务端认定（ws.viewerId），绝不能被客户端 payload 里的
        // 同名字段覆盖。若写成 `{ type, viewerId: ws.viewerId, ...msg.payload }`，
        // payload 里带 viewerId 就会**静默顶掉**真实身份 —— 观看端可以伪造成
        // 另一台大屏去更新它的 liveness（主机侧 onViewerStatus 用 payload.viewerId
        // 直接查 peers），从而干扰看门狗判定、甚至把别人误切中继。
        //
        // type 同样必须锁定：若 type 在 payload 之前展开，观看端可在 payload 里
        // 塞 `type:'replaced'` / 'viewer-left' / 'host-away'，服务端展开后转发给
        // 主机，触发主机 core.js 的 bus.emit(type) 派发伪造事件：
        //   - 'replaced'    → cast.html 强制 reconnectNow()（被观众 DoS 踢下线）
        //   - 'viewer-left' → 伪造他人离场
        //   - 'host-away'   → 把主机推进优雅窗口
        // 与同文件 offer/answer/ice 分支 `...msg, type: msg.type` 的"type 殿后"
        // 写法保持一致。
        const { payload = {} } = msg;
        send(room.host, { ...payload, viewerId: ws.viewerId, type: 'viewer-status' });
      }
      break;
    }

    // ---------- 主机广播统计 ----------
    case 'stats': {
      const room = rooms.get(ws.roomCode);
      if (room) broadcastToViewers(room, { type: 'stats', payload: msg.payload });
      break;
    }

    // ---------- 主机临时离线（信令抖动，非终止） ----------
    // 只有标记还不够：紧接着 ws.on('close') 仍然会 destroyRoom 并广播
    // room-closed，那样 host-away 的提示会被"投屏已结束"立即覆盖，等于没做。
    // 所以这里同时打上 hostAway/awaySince，让 close 处理进入优雅等待窗口。
    case 'host-away': {
      const room = rooms.get(ws.roomCode);
      if (room && ws.role === 'host' && room.host === ws) {
        room.hostAway = true;
        room.awaySince = Date.now();
        broadcastToViewers(room, { type: 'host-away' });
      }
      break;
    }

    // ---------- 主机回归（优雅窗口内重连成功） ----------
    // 大屏收到 host-away 后 banner 会停在"正在恢复…"，必须有人把它撤掉。
    // 主机在 created(reused) 之后发这条消息，服务端转发给房间内所有大屏。
    case 'host-return': {
      const room = rooms.get(ws.roomCode);
      if (room && ws.role === 'host' && room.host === ws) {
        // 不在这里 clearAwayState：协议上 host-return 一定跟在
        // create(reused) 之后，而 create 已经清理过标记与定时器。
        // 重复清理虽然幂等，但会让人误以为 host-return 可能独立到达。
        broadcastToViewers(room, { type: 'host-return' });
      }
      break;
    }

    // ---------- 心跳 ----------
    case 'ping':
      send(ws, { type: 'pong', t: msg.t });
      break;

    // ---------- 主动退出 ----------
    case 'leave': {
      const code = ws.roomCode;
      const room = code ? rooms.get(code) : null;
      if (room) {
        if (ws.role === 'host' && room.host === ws) {
          // 主机主动关闭投屏：整个房间作废，通知所有观看端
          destroyRoom(code, '主机已停止投屏');
        } else if (ws.role === 'viewer') {
          room.viewers.delete(ws);
          if (room.host) send(room.host, { type: 'viewer-left', viewerId: ws.viewerId });
        }
      }
      // 清空角色，避免随后的 ws.on('close') 重复处理同一房间。
      //
      // 注意：host 分支上面的 destroyRoom() 已经清过一次（它会把房间内所有
      // ws 的 roomCode/role 一并置空，是"房间销毁"这件事的**唯一权威清理点**）。
      // 这里的重复清空针对的是 **viewer 分支**——那条路径只做了
      // `room.viewers.delete(ws)`，房间并未销毁，若不在这里清掉 roomCode，
      // 随后 close 会再次命中同一个房间并重复发一次 viewer-left。
      // 对 host 分支而言这两行是幂等的防御性冗余，不引起故障；
      // 保留它们是为了让两条分支的退出状态一致（函数出口处 ws 一律无角色）。
      ws.roomCode = null;
      ws.role = null;
      break;
    }

    default:
      break;
  }
}

// 心跳检测，剔除半开连接
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch { /* ignore */ }
  }
}, 30_000).unref();

// ---------- 启动 ----------
server.listen(PORT, HOST, () => {
  const nets = require('os').networkInterfaces();
  const lan = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) lan.push(net.address);
    }
  }
  console.log('');
  console.log('  ╭──────────────────────────────────────────────╮');
  console.log('  │  极简投屏 · 服务已启动                       │');
  console.log('  ╰──────────────────────────────────────────────╯');
  console.log('');
  console.log(`  本机控制台   http://localhost:${PORT}/cast`);
  console.log(`  本机大屏     http://localhost:${PORT}/view`);
  for (const ip of lan) {
    console.log(`  局域网大屏   http://${ip}:${PORT}/view`);
  }
  if (lan.length === 0) console.log('  （未检测到局域网 IP）');
  console.log('');
  if (TURN_URL) {
    console.log(`  TURN 中转    ${TURN_URL}（已启用，凭据动态签发）`);
  } else {
    console.log('  TURN 中转    未配置 —— 跨公网时若 P2P 失败将自动降级为 WebSocket 中继');
    console.log('               如需更稳的跨网中转，配置 TURN_URL / TURN_SECRET 后重启');
  }
  console.log('');
});

process.on('SIGINT', () => {
  console.log('\n正在关闭服务…');
  for (const ws of wss.clients) try { ws.close(1001, 'server shutdown'); } catch {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500);
});
