/* P3 回归：replaced 之后的链路文案不得被 close handler 冲成"连接中断"
 *
 * 问题链路（修复前）：
 *   replaced handler: setLink('warn', '房间被接管')
 *     → reconnectNow() → ws.close() → onclose → close handler
 *     → setLink('err', '连接中断')      ← 覆盖了"房间被接管"
 *   用户观感："网络坏了"，而实际是"房间被别人接管了、正在换连接"。
 *
 * 修复：replaced handler 只置一次性标记 replacedRecently，由 close handler
 *       据此显示"房间被接管，正在重连"。
 *
 * 断言：
 *   1) 触发 replaced 后，链路文案**不出现**"连接中断"
 *   2) 文案链路中**出现**"房间被接管"
 *   3) 本次断开仍能重连成功（state 回到 OPEN）—— 未因改文案破坏功能
 *   4) 无关的普通掉线仍显示"连接中断"（标记不残留、未误报）
 */
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c, e) => c ? (pass++, console.log('  \u2713 ' + n))
                          : (fail++, console.log('  \u2717 ' + n + (e ? '  ' + e : '')));

let puppeteer;
try { puppeteer = require('puppeteer-core'); }
catch {
  console.log('  \u26a0 SKIP: 未安装 puppeteer-core（开发依赖）');
  process.exit(0);
}
const CHROME = process.env.CHROME_PATH || '/usr/bin/chromium';
const BASE = process.env.BASE_URL || 'http://localhost:8080';

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new', protocolTimeout: 60000,
    args: ['--no-sandbox', '--use-fake-ui-for-media-stream',
           '--use-fake-device-for-media-stream',
           '--autoplay-policy=no-user-gesture-required'],
  });
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));

  // 在页面脚本执行前装上"链路文案历史"记录器。
  //
  // 为什么用 MutationObserver 不够：onclose 里 `emit('close')` 与
  // `emit('reconnecting')` 是**同一同步 tick 内**先后派发的，linkText.textContent
  // 在一个 tick 内被改写两次；MutationObserver 按微任务批量投递，
  // 只能看到该 tick 的**最终值**，中间那次（"房间被接管…"）会被吞掉。
  //
  // 所以改为直接劫持 `Node.prototype.textContent` 的 setter，记录**每一次**写入。
  // 这样才能验证"中间文案确实被设置过"。
  //
  // ⚠️ 不要改回 MutationObserver：它不会让测试报错，而是让测试**静默失效** ——
  //    MutationObserver 批量投递微任务，同 tick 的多次 set 只能看到最终值，
  //    于是 `__linkHistory` 里根本不会出现"房间被接管…"这一中间项。届时
  //    断言 1)（不出现"连接中断"）和 4)（无关掉线仍显示"连接中断"）仍会通过
  //    （因为它们看的是最终态），但断言 2) 会以"链路里压根没有这一项"的方式
  //    失败或——若连 2) 也被顺手放松——整个用例就退化成只测最终值的空壳，
  //    再也覆盖不到它本应覆盖的"中间文案不被覆盖"这一核心场景。
  //    必须劫持 setter 才能看到同 tick 的每一次写入。
  await page.evaluateOnNewDocument(() => {
    window.__linkHistory = [];
    const desc = Object.getOwnPropertyDescriptor(Node.prototype, 'textContent');
    Object.defineProperty(Node.prototype, 'textContent', {
      configurable: true,
      get() { return desc.get.call(this); },
      set(v) {
        // 只记录链路文案那个 span（id=linkText），避免噪声
        try {
          if (this && this.id === 'linkText') window.__linkHistory.push(String(v));
        } catch {}
        return desc.set.call(this, v);
      },
    });
  });

  await page.goto(`${BASE}/cast?debug=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__signal && window.__signal.state === 1, { timeout: 15000 });
  ok('初始信令已连接', true);

  // ---- 场景 1：手动派发 replaced。----
  //
  // 注意措辞，别理解成"等价于服务端发来该消息"：当前协议下服务端**永不主动发**
  // 这条消息（推导见 README「关于 replaced」的 0/5 结论、以及 replaced-guard-race.js）。
  // 这里直接 emit 是为了**独立于可达性**地验证 handler 本身：一旦它被触发
  // （无论是未来协议放开了强制接管，还是像本测试这样手动调用），内部的文案
  // 链路是否正确。
  //
  // 这个"现在不可能发生"的前提**不会**削弱本测试的价值——它要证明的是
  // **handler 的行为正确**，而不是"它能否被触发"；后者由 replaced-guard-race.js 覆盖。
  // 两者互补：一个测"触发后的表现"，一个测"当前触发不了"。
  await page.evaluate(() => {
    window.__linkHistory.length = 0;              // 清历史，只看本次
    window.__signal.emit('replaced', {});
  });
  await sleep(2500);

  const hist = await page.evaluate(() => window.__linkHistory);
  console.log('   文案历史 =', JSON.stringify(hist));

  ok('1) 文案链路中未出现"连接中断"（未被 close handler 冲成网络错误）',
     !hist.some(t => t.includes('连接中断')), JSON.stringify(hist));
  ok('2) 文案链路中出现"房间被接管"',
     hist.some(t => t.includes('房间被接管')), JSON.stringify(hist));
  // 补充：重连期间必须**始终**保持"房间被接管"语境。
  // 只检查"出现过含'房间被接管'的文案"是不够的 —— 对照组里
  // close handler 设了带前缀的文案、reconnecting 又设了裸的"重连中 (1)"，
  // 两者都在历史里，天真的 `some(includes('房间被接管') && includes('重连'))`
  // 会误判为通过。所以这里做**负面断言**：不得出现**裸的**"重连中 (n)"
  // （即不带"房间被接管"前缀的那条）。
  const bareReconnecting = hist.filter(t => /^重连中/.test(t));
  ok('2b) 重连期间未出现裸的"重连中 (n)"（语境保持，未被中性文案覆盖）',
     bareReconnecting.length === 0, JSON.stringify(bareReconnecting));

  const state1 = await page.evaluate(() => window.__signal.state);
  ok('3) replaced 后仍重连成功（state 回到 OPEN）', state1 === 1, `state=${state1}`);

  // ---- 场景 2：无关的普通掉线仍显示"连接中断"（标记不残留）----
  // 等 replaced 的一次性标记过期/被消费后，用 socket.close() 模拟真实掉线。
  await sleep(3500);   // 超过 3s 过期窗口，确保标记已清
  await page.evaluate(() => {
    window.__linkHistory.length = 0;
    // 直接关底层 socket，且**不**置 replaced 标记 → 应走"连接中断"分支。
    // 用 __signal.socket（?debug=1 下暴露）拿到裸 ws。
    const s = window.__signal.socket;
    if (s) s.close();
    else window.__signal.reconnectNow();   // 兜底
  });
  await sleep(1200);
  const hist2 = await page.evaluate(() => window.__linkHistory);
  console.log('   普通掉线文案历史 =', JSON.stringify(hist2));
  ok('4) 无关掉线仍显示"连接中断"（标记未残留误报）',
     hist2.some(t => t.includes('连接中断')), JSON.stringify(hist2));

  ok('页面无未捕获异常', errs.length === 0, errs.join(' | '));

  await browser.close();
  console.log(`\n通过 ${pass}/${pass + fail}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('异常:', e.message, e.stack); process.exit(1); });
