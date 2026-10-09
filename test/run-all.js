/* 测试总入口：自行拉起 server → 等端口就绪 → 依次跑全部用例 → 收尾杀进程。
 *
 * 为什么需要它：
 *   各用例都硬编码连 localhost:8080，而 `npm test` 不会启动 server ——
 *   用户照 README 执行第一条就会 ECONNREFUSED。这里把"起服务"内聚进来，
 *   使 `npm test` 成为**单命令可跑**的入口，不依赖用户另开终端。
 *
 * 端口策略：默认用一个与被测目标错开的端口（TEST_PORT，默认 8080）：
 *   - 若 8080 已被占用（用户自己 npm start 了），**复用它、不再重复起服务**，
 *     避免"端口被占 → 起不来 → 测试全红"的假失败；
 *   - 若 8080 空闲，则自己起一个，用完杀掉。
 *
 * 退出码：任一条用例失败即把退出码设为非 0，便于 CI 判定。
 */
const { spawn, spawnSync } = require('child_process');
const net = require('net');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.TEST_PORT || 8080);
const BASE_URL = `http://localhost:${PORT}`;
const BASE_WS = `ws://localhost:${PORT}`;

// 用例顺序：协议层（快、无浏览器依赖）在前，浏览器用例在后
const SUITES = [
  ['replaced-guard.js', '协议层：非 host 连接转发 + replaced 守卫根因'],
  ['replaced-guard-race.js', '协议层：replaced 不可达性 + 白盒 A/B'],
  ['crossroom.js', '协议层：跨房间切换时旧房间引用必须清干净'],
  ['viewer-status-id.js', '协议层：viewer-status 的 viewerId 不得被 payload 覆盖'],
  ['url-malformed.js', '协议层：畸形 URL 不得打死服务（GET /% → 400 且存活）'],
  ['relay-frame-cap.js', '协议层：中继分片大小上限（超限丢弃 + 防误伤）'],
  ['static-hygiene.js', '静态：未使用的解构变量 + 注释契约（无浏览器依赖）'],
  ['reconnect.js', '浏览器：close()/reconnectNow() 语义'],
  ['reconnect-closing.js', '浏览器：CLOSING 窗口不产生孤儿连接'],
  ['replaced-ux.js', '浏览器：replaced 后的链路文案不被误报成网络错误'],
  ['quality-injection.js', '浏览器：新大屏拿到用户当前选择的画质'],
  ['newcode-cleanup.js', '浏览器：换码时清空传输层 peer（防幽灵大屏）'],
  ['viewer-teardown.js', '浏览器：主机结束后接收端彻底销毁传输层'],
  ['concurrent-addviewer.js', '浏览器：并发 addViewer 不得把健康大屏误推中继'],
  ['answer-seq.js', '浏览器：过期 answer 按世代号拒绝（不塞进新 pc）'],
  ['unload-no-leave.js', '浏览器：卸载期间不得发 leave（保护优雅重连窗口）'],
  ['pause-watchdog.js', '浏览器：暂停推送不得被看门狗误判为静默中断'],
  ['stale-cond.js', '浏览器：画面冻结判定的时间窗/基准语义'],
  ['relay-nochurn.js', '浏览器：中继模式下不因抖动空转重建 P2P'],
  ['selfheal.js', '浏览器：撤销本次重建后必须重新排程（防永久冻结）'],
  ['rejoin-schedule.js', '浏览器：host-return 抢占挂起定时器 + leave 清零'],
  ['join-failed-backoff.js', '浏览器：join-failed 走退避（非 RTT 洪水）+ force 抢占计数'],
  ['server-restart-rejoin.js', '浏览器：服务器重启后大屏自动重新加入（P2.5）'],
  ['relay-degrade.js', '浏览器：blob 定时器洪水 / addSourceBuffer 降级 / destroy 残留'],
  ['host-stats-classify.js', '浏览器：stats 把 p2p-relay 归入 relay（与 updateModeTag 对齐）'],
  ['report-gating.js', '浏览器：未连接时 viewer.report() 不发无效报告'],
  ['turn-urls-split.js', '浏览器：buildIceServers 归一化 turn.urls（逗号分隔容错）'],
  ['addviewer-vs-reset.js', '浏览器：信令断开时挂起中的 addViewer 不留僵尸 peer（防护锁定）'],
];

const sleep = ms => new Promise(r => setTimeout(r, ms));
// 提前声明：下面的 server.on('exit') 回调会引用它。
// 用 `let` 而声明在末尾会形成 TDZ —— 回调若在声明前触发会抛 ReferenceError。
let shuttingDown = false;

/** 探测端口是否已被监听 */
function isPortOpen(port) {
  return new Promise(resolve => {
    const s = net.connect({ port, host: '127.0.0.1' });
    const done = ok => { try { s.destroy(); } catch {} resolve(ok); };
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
    s.setTimeout(600, () => done(false));
  });
}

async function waitForPort(port, timeoutMs = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await isPortOpen(port)) return true;
    await sleep(150);
  }
  return false;
}

(async () => {
  let server = null;
  let startedHere = false;

  if (await isPortOpen(PORT)) {
    console.log(`\n[i] 端口 ${PORT} 已有服务在监听 —— 直接复用，不重复启动\n`);
  } else {
    console.log(`\n[i] 端口 ${PORT} 空闲 —— 启动临时服务（退出时自动清理）\n`);
    server = spawn('node', ['server/server.js'], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    startedHere = true;
    // 把服务端日志转发到本进程（便于失败时排查），但前缀一下避免混淆
    server.stdout.on('data', d => process.stdout.write('[server] ' + d));
    server.stderr.on('data', d => process.stderr.write('[server] ' + d));
    server.on('exit', (code, sig) => {
      if (!shuttingDown) console.log(`[server] 已退出 code=${code} sig=${sig}`);
    });

    if (!await waitForPort(PORT)) {
      console.error(`\n[!] 服务未能在超时内监听 ${PORT}，放弃\n`);
      try { server.kill(); } catch {}
      process.exit(1);
    }
    console.log(`[i] 服务就绪：${BASE_URL}\n`);
  }

  let failed = 0;
  let skipped = 0;
  const env = { ...process.env, BASE_URL, BASE_WS, TEST_PORT: String(PORT) };

  for (const [file, desc] of SUITES) {
    console.log('═'.repeat(64));
    console.log(`▶ ${file}  —  ${desc}`);
    console.log('═'.repeat(64));
    // 用 path.resolve 显式绑定到 ROOT，而非 path.join('test', file) 的相对路径：
    // 后者依赖 cwd 解析，若将来本文件被挪位或 ROOT 计算方式改变，
    // 相对路径会静默指向错误位置（spawnSync 只报 ENOENT，不易定位）。
    // 这里捕获子进程 stdout（而非 inherit），是为了能在汇总里把"主动 SKIP"
    // 与"真正通过"区分开——否则缺少可选依赖（puppeteer-core）时 19 个浏览器
    // 用例会被静默计为"通过"，让 CI 误以为全绿（这正是 Round B 要杜绝的"跳过即算过"）。
    const r = spawnSync('node', [path.resolve(ROOT, 'test', file)], {
      cwd: ROOT, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    });
    process.stdout.write(r.stdout || '');
    process.stderr.write(r.stderr || '');
    // 浏览器套件在 require('puppeteer-core') 失败时打印 "⚠ SKIP:" 并以 0 退出：
    // 这是为"只装运行依赖的环境"保留的便利，不应被误报成"已验证通过"。
    const isSkip = /SKIP:/.test(r.stdout || '');
    if (r.status !== 0) {
      failed++;
      console.log(`\n✗ ${file} 未通过（exit=${r.status}）\n`);
    } else if (isSkip) {
      skipped++;
      console.log(`\n⊘ ${file} 跳过（缺少可选依赖，未实际执行）\n`);
    } else {
      console.log(`\n✓ ${file} 通过\n`);
    }
  }

  // 收尾
  if (startedHere && server) {
    shuttingDown = true;
    try { server.kill('SIGTERM'); } catch {}
    await sleep(300);
    try { server.kill('SIGKILL'); } catch {}
  }

  console.log('═'.repeat(64));
  const realPass = SUITES.length - failed - skipped;
  if (failed) {
    console.log(`结果：${realPass}/${SUITES.length} 个用例文件通过，${failed} 个失败，${skipped} 个跳过（缺少可选依赖）`);
  } else if (skipped) {
    console.log(`结果：${realPass}/${SUITES.length} 个用例文件通过，${skipped} 个跳过（缺少可选依赖，未实际执行）`);
  } else {
    console.log(`结果：全部 ${SUITES.length} 个用例文件通过`);
  }
  console.log('═'.repeat(64));
  process.exit(failed ? 1 : 0);
})().catch(e => {
  console.error('run-all 异常：', e);
  process.exit(1);
});
