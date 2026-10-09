[English](README.md) | [简体中文](README_Simplified_Chinese.md) | [繁體中文](README_Classical_Chinese.md)

# 极简投屏 · Screencast Lite

把一个网页的画面，实时投到另一个网页。**纯白极简风格**，局域网 P2P 直连优先，不行自动降级服务器中转。

## 快速开始

```bash
cd screencast
npm install          # 运行依赖仅 ws（WebSocket 服务端）
node server/server.js
```

> **用 pnpm？** 仓库里的 `pnpm-lock.yaml` 同时锁定了运行依赖 `ws` 与开发依赖
> `puppeteer-core`（后者供浏览器用例使用，非必需），因此
> `pnpm install --frozen-lockfile` 与 `pnpm install` 都可直接用。
> 若只想装运行依赖、跳过 `puppeteer-core`，用 `pnpm install --prod` 即可。
>
> **用 npm？** 完全忽略 `pnpm-lock.yaml`：`npm install` 只装
> `dependencies` 里的 `ws`，`npm i -D puppeteer-core` 才装测试用浏览器驱动。

启动后终端会打印可用地址：

```
本机控制台   http://localhost:8080/cast
本机大屏     http://localhost:8080/view
局域网大屏   http://192.168.x.x:8080/view
```

**用法**：要投屏的电脑打开 `/cast` → 点「选择屏幕并开始投屏」→ 大屏设备打开 `/view` → 输入 4 位房间码（或直接扫二维码）。

## 技术栈

| 环节 | 方案 |
|---|---|
| 屏幕采集 | `getDisplayMedia()` — 可选整个屏幕 / 单个窗口 / 浏览器标签页 |
| 点对点传输 | **WebRTC** `RTCPeerConnection` — 局域网内直连，延迟最低 |
| 信令通道 | **WebSocket** — 房间码配对、SDP/ICE 交换、断线自动重连 |
| NAT 穿透 | **STUN**（Google / Cloudflare 公共节点）+ 可选 **TURN** |
| 自动选路 | P2P 直连优先 → 打不通自动降级 **服务器中转** |

## 双模式链路

```
                    ┌─ 局域网 P2P 直连（优先，延迟最低）
发送端 ──── 协商 ────┤
                    └─ 服务器中转（P2P 不通时自动降级）
```

### 直连模式（默认）

同一局域网内两端直接点对点传视频流，不经过服务器。发送端页面会显示「**P2P 直连**」或「**局域网直连**」。

### 中转模式（自动兜底）

三种情况下会自动切到中转，**无需手动操作**：

1. **P2P 协商超时** — 6.5 秒内没连上
2. **ICE 协商失败** — `connectionState` 变为 `failed`（立即切，不等待）
3. **画面静默中断** — 连接看似正常但已不出帧（关键兜底，见下）

`connectionState` 变成 `disconnected` 时**不会**立即降级 —— 它是可恢复的瞬时状态，给 3 秒宽限期，期间恢复则继续走 P2P。只有 3 秒后仍是 `disconnected` 才切中转。

中转模式下，发送端用 `MediaRecorder` 把画面编成 WebM 分片，经 WebSocket 二进制帧经服务器转发，接收端用 `MediaSource` 边收边播（自动追帧压低延迟）。

> **中继模式的 HUD**：这条链路没有 `RTCPeerConnection`，`getStats()` 拿不到任何数据。所以分辨率与帧率改为从 `<video>` 元素本地采集（`videoWidth/videoHeight`、`getVideoPlaybackQuality().totalVideoFrames` 差分）；**RTT 无从观测，恒显示「—」** —— 中转本来就没有可测的链路往返时延，这是诚实的结果而非缺失。

> **多屏共享编码器**：无论接了几块大屏，中转只用**一个** `MediaRecorder`。分片按 8 字节 `viewerId` 前缀在服务端定向转发到对应大屏 —— 8 块屏也只跑一份 VP8/VP9 编码，不会出现 8 个编码器同时烧 CPU 的情况。

### 大屏与发送端的断线行为

分两条路径，取决于主机是「**临时离开**」还是「**真的结束**」。

**路径 A：临时离开（刷新页面 / 信令抖动）—— 优雅重连**

发送端在断开前发一条 `host-away`，服务端据此**不立即销毁房间**，进入 15 秒优雅窗口：

```
发送端 ws 断开
   │
   ├─ 有 host-away 标记 → 房间保留 15s，大屏横幅「发送端连接波动，正在恢复…」
   │      ├─ 窗口内主机用同码重连 → 广播 host-return → 大屏「已恢复」，无感续播
   │      └─ 超时仍未回来 → destroyRoom('主机重连超时') → 大屏回待机
   │
   └─ 无标记（拔网线、切网络等来不及通知）→ 立即 destroyRoom → 大屏回待机并自动重试
```

**关键**：房间保留 ≠ 连接还活着。主机重载后旧 `RTCPeerConnection` 已废，而它的 `connectionState` 可能长时间停在 `connected`（对端消失后 ICE 要数十秒才判失败）。这时 `vx.mode` 仍显示 `p2p-host` 看着一切正常，但 `video.currentTime` 早已定格。

所以大屏拿到「要不要重建」这个决定时，**按信号强度分路径**，而不是一刀切：

| 触发信号 | 强度 | 处置 |
|---|---|---|
| `host-return` | **强**（主机明确告知它刚 `create(reused)` 过，旧 pc 一定已废） | `scheduleRejoin(true)` —— 延迟 0、**无条件**重建，不做任何健康判定 |
| 已处于 `relay` / `relay-blob` | **反向信号**（主机主动切过来的） | 直接撤销，**绝不**重建 P2P |
| `connectionState → failed` | 弱（可能只是瞬时抖动） | `scheduleRejoin(false)` —— 退避延迟，再用 `isPictureAlive()` 二次确认 |

**为什么中继模式必须单独拦一道**：切中继是主机侧的主动决定（`pc failed → enableRelay → relay-begin`）。若大屏此时重走 P2P，主机会 `removeViewer → relayViewers 清空 → sharedRecorder.stop()`，把刚建好的中继链路**亲手拆掉**；然后新 pc 大概率又失败、又切中继、又发 `relay-begin` —— 双方进入「切中继 → 大屏重建 P2P → 又失败 → 又切中继」的震荡，用户看到画面每隔几十秒中断一次。

这道判断必须放在**调用方**（`scheduleRejoin`），不能塞进 `isPictureAlive()`。后者的语义是「P2P 画面是否在动」，而中继模式下画面当然在动（只是数据源不是 WebRTC）。让它返回 `false` 等于撒谎，调用方会据此把中继链路推翻——这是典型的**语义污染**。

`host-return` 路径上同样**绝不能**调用 `isPictureAlive()`：它首次调用没有基准，会走「乐观返回 true」分支（避免刚建连就被误判停滞），恰好把重建 return 掉 —— 而 `host-return` 正是基准从未建立过的冷启动场景，结果就是**画面永冻**。

`isPictureAlive()` 返回 `true` 有两种含义，调用方必须能区分：

- **有基准且 `currentTime` 在增长** → 真的健康，撤销本次动作、等下一轮；
- **首次采样 / 距上次超过 30 秒，无基准** → 只是「无从判断」的乐观值，**不代表**确认健康，同样要撤销。

`false` 的判据也有两条阈值，构造测试时别踩错（都在 `isPictureAlive` 内）：

| 条件 | 结论 |
|---|---|
| `now - lastVideoAt > 30000` | 归为「无基准」→ 乐观返回 `true` |
| `now - lastVideoAt >= 6000` | 确认为停滞（`moving = false`） |

**撤销 ≠ 放弃：必须重新排程。** 两种情况撤销时都要完整回滚（`rejoinAttempts` 回退、`rejoinInFlight` 清零），**然后立刻 `scheduleRejoin(false)` 排下一轮**：

- 不清 `rejoinInFlight` → 留下假的「重建进行中」状态，后续任意一次 `join-failed` 都会命中 `if (rejoinInFlight) → scheduleRejoin(true)` 被静默升级成强制重建，「要不要重建」的判断被旁路；
- 不重新排程 → **`failed` 事件只会在 `connectionState` 变化时触发一次**，撤销后就再没有第二个触发源（`host-return` 要主机重连、`join-failed` 要先发起 join，而没 join 就不会有 `join-failed`）——画面会**永久冻结到用户手动刷新**。下一轮采样已有基准，若画面真死则返回 `false`，正常走重建。

限流用两个**独立**计数器，语义不同、不要混用：

| 计数器 | 含义 | 上限 |
|---|---|---|
| `rejoinAttempts` | **实际发起**重建的次数（会扰动主机侧 peer/relay 状态） | `REJOIN_MAX = 12` |
| `rejoinChecks` | **判定后撤销**的次数（零成本本地判断，防误判死循环） | `REJOIN_CHECKS_MAX = 20` |

强制路径（`host-return`）**不计入** `REJOIN_MAX`：它的 `delay=0`，若也计数，主机还在重载时 12 次几乎瞬时打满，会提前 `onHostGone` 把大屏踢回待机。它的限流由 `join-failed → 退避重试` 这条链自己负责——该分支调的是 `scheduleRejoin(false)`（1200ms 起步、线性增长、计入 `REJOIN_MAX`）。**历史上这里曾误用 `scheduleRejoin(true)`**：`delay=0` 导致 join-failed 一回来下一 tick 就立即再 join，形成只被网络 RTT 节流的洪水（本地实测 4 秒近 3 万次 join），且全程不消耗任何配额。回归证据见 `test/join-failed-backoff.js`。

大屏重建时服务端**复用原 viewerId**（而非分配新的），否则主机会把同一台设备当成新设备 `addViewer`，旧 peer 永不回收 —— 幽灵大屏会复现。同理，主机 `create(reused)` 成功后服务端会**补发当前房间内的观看端清单**（`viewer-joined` 带 `rejoined: true`），确保「大屏先 join、主机后 create」这个竞态下主机也知道有大屏在等。

> **已知冗余（刻意保留）**：优雅重连时，同一个大屏可能触发**两次** offer 往返。
>
> 触发链路有两条，都指向同一台大屏：
>
> | 来源 | 路径 |
> |---|---|
> | 服务端补发 | `created(reused)` → 服务端广播 `viewer-joined` → 主机 `addViewer` → 发 offer |
> | 大屏驱动 | `host-return` → 大屏 `resetRejoin()` + `scheduleRejoin(true)` → `doJoin` → 服务端再发 `viewer-joined` → 主机**再**发一次 offer |
>
> 主机收到第二个 `viewer-joined` 时走 `addViewer`，而 `addViewer` 开头有 `if (peers.has(viewerId)) removeViewer(viewerId)`，会把刚建好的第一个 `RTCPeerConnection` 拆掉重来（`viewerId` 相同，不会产生幽灵 peer，只是白做一次 PC 构建 + offer/answer）。代价是重连**慢约 1 秒**，**不引发错误**。
>
> 之所以不修：这两条链路互为**保险**。只留服务端补发，则万一补发逻辑出错（例如某个竞态下 `room.viewers` 里还没有大屏），主机就完全不知道有人在等，画面永久黑屏；只留大屏驱动，则主机重启后要先等大屏自己发现（依赖 `host-return` 到达）。两者都留，任意一条生效即可恢复。用一个"是否已发过 offer"的去重标记消除冗余，会给这条恢复路径引入新的状态依赖，风险大于 1 秒的收益 —— 因此**保持现状并在文档中注明**。

**跨房间切换**：观看端 `join` 到**另一个**房间码时，服务端会先把旧房间的引用清干净（`viewers.delete` + 通知旧主机 `viewer-left` + 重置 `viewerId`）。不清理的后果是旧房间的 `viewers.size` 永不下降（名额占死）、旧主机继续给这个 ws 发 `offer` / `viewer-status`，大屏照常应答 → **一条 ws 同时挂在两个房间的 P2P 里**。

**关于 `replaced`（当前协议下不可达，保留作防御）**：服务端 `create` 分支里有两处对 host `readyState` 的判断，它们对**同一个 host** 恰好互斥：

| 判断 | 条件 | 作用 |
|---|---|---|
| `reusable` | `existing.host.readyState !== OPEN` | **才**允许复用请求的房间码 |
| `replaced` 分支 | `room.host.readyState === OPEN` | **才**认为旧 host 被强行接管、发 `replaced` 并 `close()` |

若旧 host 存活（`OPEN`）→ `reusable` 为假 → `genCode()` 换码 → 新房间是空的，`replaced` 分支首条件即假；若旧 host 已死 → `reusable` 为真 → `room.host` 那个已死的 ws 不满足 `=== OPEN` → `replaced` 分支仍为假。**两者不可能同时成立**，实测 5 种时序（存活 / `host-away` / 半开 `pause` / 半开+`terminate` / `leave`）命中率 **0/5**。

也就是说，`role = 'replaced'` 的赋值、`replaced` 通知、以及 `handleSignal` / 二进制分支里的两处 `if (ws.role === 'replaced') return` **都是防御性死代码**。保留它们的原因：

1. **意图自解释**：读代码的人不必自己推导"为什么改了 `role` 还不够"。若只改 `role` 而删掉守卫，一旦将来有人放开"允许强制接管同码房间"，旧连接会立刻掉进 `handleSignal` 的 `else`（观看端）分支，把 `viewerId: undefined` 的信令转发给新 host —— 守卫必须在那个时刻**已经**在那儿。
2. **未来扩展的语义锚点**：强制接管（"我要顶掉别人占用的房间码"）是一个合理需求，届时 `replaced` 会立刻变成热路径。
3. **零成本**：两次判断都在消息入口，无 IO、无状态。

**发送端（`cast.html`）的 `replaced` handler 刻意做成最小实现**——只置标记 + 弹提示 + 调 `reconnectNow()`，**不**做本地状态清理：

```js
signal.on('replaced', () => {
  // 置位"本次断开源于房间被接管"，让随后 close / reconnecting handler
  // 显示正确的文案，而不是误导性的"连接中断"。
  replacedRecently = true;
  clearTimeout(replacedFlagTimer);
  replacedFlagTimer = setTimeout(() => { replacedRecently = false; }, 3000);
  toast('此房间已在别处重新创建，正在重新连接…');
  try { signal.reconnectNow(); } catch {}
});
```

三点理由：

- **不重复清理**：`reconnectNow()` 会立刻触发 `onclose` → `signal.on('close')` 那条 handler，而清 `roomCode` / `viewerMap` / `host.peers` 的职责**唯一**归属那里。在这个 handler 里再清一遍属于"两次清同一份状态"——今天各操作恰好幂等才没出错，但只要 `close` handler 将来加入任何非幂等动作（例如补发某条信令），就会变成重复执行。
- **绝不用 `close()`**：早期版本这里写的是 `signal.close()`，会置 `closedByUser = true` 使信令层**永久失联**，把用户踢下线且无法恢复——比"什么都不做"更糟。详见上一节的 `close()` / `reconnectNow()` 对照表。
- **在这里调 `setLink` 无效**：`reconnectNow()` 同步触发 `onclose` → `close` handler，那里的 `setLink` 会把这里刚设的文案立刻覆盖掉，等于白设。所以文案**不在**此 handler 里设，而是靠 `replacedRecently` 标记让 `close` / `reconnecting` 两个 handler 自己选对措辞。

> **为什么标记要活过 `close` handler？** `onclose` 里 `emit('close')` 之后**同一同步 tick 内**紧跟着 `emit('reconnecting')`。若在 `close` handler 里就把标记清掉，紧随其后的 `reconnecting` handler 会显示中性的"重连中 (1)"，把"房间被接管"覆盖掉——用户根本来不及看见（`MutationObserver` 也观测不到该中间值）。因此标记**不**在 `close` 里清，而是一路活到 `open`（重连成功 = 语境结束）才清；另加 3 秒自动过期兜底，防"异常路径下标记残留、被之后一次无关掉线误消费成假接管提示"。

对应的回归测试已随项目提供（`test/` 目录）。**单命令即可跑完全部用例**：

```bash
npm test          # 内部由 test/run-all.js 负责拉起 server → 跑完 → 清理
```

`test/run-all.js` 的端口策略：若 `8080` 已被占用（例如你正开着 `npm start`），**直接复用**已有服务；若空闲则自己起一个临时服务、跑完自动杀掉。因此无论你开没开服务，`npm test` 都能直接跑——不会出现"忘了先起 server → 全部 ECONNREFUSED"。

| 文件 | 形态 | 证明什么 |
|---|---|---|
| `test/replaced-guard.js` | 协议层黑盒（真实 ws 连服务端） | **对照组**：以 viewer 身份 join 的连接，其 `offer` / 二进制帧**确实会**被转发给 host —— 这正是"非 host 连接会落进 `else` 分支"的缺陷根因；**不变量**：同码被占用时新 ws 换码（佐证"存活 host 占位时不发生接管"） |
| `test/replaced-guard-race.js` | 协议层黑盒 + 本地白盒复刻 | **不变量**：可观测时序下旧 host 均收不到 `replaced`（S5 因 `terminate()` 后无法从外部观测，记 `hit=null` 并**排除在断言外**，不冒充证据）；**A/B 对照**：把守卫从"本地复刻的转发器"里摘掉后，5 条消息立刻泄漏（含 `viewerId: undefined` 的错乱形态），装回守卫则全拦 |
| `test/reconnect.js` | 浏览器（puppeteer） | **P0**：`close()` 后 11s 仍为 CLOSED（永不重连）；`reconnectNow()` 后回到 OPEN；`close()` 的永久关闭语义不被误伤 |
| `test/reconnect-closing.js` | 浏览器（puppeteer） | **P1**：在同一 tick 内 `close()` + `reconnectNow()` **确定性命中 CLOSING 窗口**，验证不产生孤儿连接（撤修则观测到 `openNow=2`，两条 ws 同时 OPEN） |
| `test/replaced-ux.js` | 浏览器（puppeteer，劫持 `textContent` setter） | **UX**：房间被接管后的链路文案应为 `房间被接管，正在重连` → `…(n)` → `服务已连接`，**不得**中途冒出一条裸的"连接中断"（会被误读为网络故障）；普通掉线仍显示"连接中断"（标记不残留误报） |
| `test/quality-injection.js` | 浏览器（puppeteer，canvas 伪流） | **回归**：新加入的大屏拿到的 `maxBitrate/maxFramerate` 必须等于**当前**用户选择（三档验 1.5M / 4M / 15M）。撤修后三档全部塌回 4M/30（3/7）——证明它抓得住"硬编码"这个缺陷 |
| `test/newcode-cleanup.js` | 浏览器（puppeteer，`__forceStarted` 钩子） | **回归**：点「换一个」后传输层 `peers` 必须清空、`stats.total` 归零。撤修后残留 3 条（4/6）——正是"UI 归零但传输层不归零"的脱钩缺陷 |
| `test/viewer-teardown.js` | 浏览器（puppeteer，真 host+viewer 双页） | **回归**：主机结束投屏（`room-closed`）后，接收端 `vx.mode` 复位为 `connecting`，且**旧 pc 实例**的 `connectionState === 'closed'`（断言直接盯住 `window.__oldPc`，不是"新 vx 的 pc 为 null"这种空断言）。撤修后 mode 停在 `p2p-host`、旧 pc 仍 `connected` |
| `test/concurrent-addviewer.js` | 浏览器（puppeteer，劫持 `RTCPeerConnection.createOffer` 设闸门） | **P0 回归**：并发 `addViewer`（同一 viewerId 连发两次，优雅重连路径下**每次都会**发生）时，第一条的弃子链路不得把第二条的健康连接误切中继。用例用一道"第一次 createOffer 永不 resolve"的闸门**确定性**制造并发，不靠赌时序。撤修后 `mode` 变 `relay`、新代 pc 被误关（3/5）——精确复现报告描述的 T2–T3 时序 |
| `test/answer-seq.js` | 浏览器（puppeteer，白盒 `__host.onAnswer` + 劫持 `setRemoteDescription` 计数） | **P0 回归**：优雅重连的双 offer 往返下，旧代 offer 的 answer 可能晚到并被打到**新代 pc** 上（`have-local-offer`→`stable`，随后真 answer 抛 `InvalidStateError`，链路永久卡协商）。修复用 offer/answer **世代号**关联：`addViewer` 给 entry 编 `seq`、offer 带 seq、answer 回显 seq，`onAnswer` 拒绝 `entry.seq !== seq` 的过期 answer。**A/B**：摘掉 seq 校验 → 2/4（过期 answer 穿透，`setRemoteDescription` 被调用） |
| `test/viewer-status-id.js` | 协议层黑盒（真实 host+viewer ws） | **安全回归**：`viewer-status` 转发时 `viewerId` **和 `type`** 都必须由服务端认定，**不得**被 `msg.payload` 里的同名字段覆盖。viewerId 伪造可污染**另一台**大屏的 liveness（顺着看门狗把别人不可逆地切中继）；type 伪造可伪装消息类型（`replaced`→强制主机重连 DoS、`viewer-left`→踢人、`host-away`→推进优雅窗口）。**A/B**：把 `type` 放回 payload 之前 → 7/9（主机收到 `{"type":"replaced",…}` 两条断言转红） |
| `test/static-hygiene.js` | 静态扫描（无浏览器依赖，恒可运行） | **卫生**：扫描 6 个文件的解构声明，报出"解构了但从未使用"的变量；附带**反向自检**（合成样例必须被报出，证明"零发现"不是检测器坏了），`const { fps }` / `const { vt, at }` 两条历史问题的契约断言，以及 **`test/*.js` 不得硬编码 node_modules 绝对路径**（某用例曾 require `/tmp` 下的绝对路径，在没有该目录的环境里被 try/catch 兜住后 exit(0)，run-all 只看退出码 → 唯一覆盖 P0 洪水缺陷的用例静默 SKIP 却报"通过"） |
| `test/crossroom.js` | 协议层黑盒（三条真实 ws：host A / host B / viewer） | **回归**：同一条 viewer ws 从房间 A 切到 B 时，旧房间引用必须清干净——老 host 收到 `viewer-left`、`viewerId` 被重新分配（不复用会让旧 host 的 `removeViewer` 误伤新房间 peer）、且关闭时只有 B 收到通知。撤修后老 host 收不到 `viewer-left`（9/10） |
| `test/stale-cond.js` | 浏览器（puppeteer，`__rejoin.forceStale*` 钩子） | **白盒**：`forceStale` 需 `withinWindow` 与 `advanced` **同时**为假才判定"冻结"；用 `forceStaleDrift()` 反例证明旧实现把"仍在推进"误判为冻结。8/8 |
| `test/relay-nochurn.js` | 浏览器（puppeteer，`__vx.startRelayPlayback()`） | **回归**：已切中继后 `scheduleRejoin(false)` 必须撤销重建——`mode` 保持 `relay`、`rejoinInFlight` 为假、`rejoinAttempts` 停在 0。撤修后 `mode` 翻成 `connecting`、`attempts=1`（3/6），即"切中继→重建 P2P→又失败"的震荡 |
| `test/selfheal.js` | 浏览器（puppeteer，canvas `captureStream` 喂 `#video`） | **回归**：判定"画面还活着"而撤销本次重建后**必须重新排程**。撤修则 `rejoinChecks` 冻在 1、`lastVideoTime` 停止更新（5/7），正是"撤销即终 → 画面永久冻结到手动刷新"的缺陷。7/7 |
| `test/unload-no-leave.js` | 浏览器（puppeteer，`__sent` 出站打点） | **P0 回归**：`beforeunload` 里 `track.stop()` 会触发 `ended` → `endSession()` → 发 `leave`，把刚发出的 `host-away` 顶掉、房间立即销毁（README 承诺的"刷新后大屏无感续播"失效）。用例用 `unloading` 钩子构造两组对照：正常停止 `__sent=["leave"]`，卸载中 `__sent=[]`。撤修后卸载中仍发出 leave（6/7） |
| `test/pause-watchdog.js` | 浏览器（puppeteer，真 host+viewer 双页 + `forceStall`） | **P1 回归**：暂停推送时接收端 `framesDecoded` 停增，而 `viewer-status` 仍定时上报，看门狗 15 秒后会把这条大屏**不可逆地**切中继。A/B 两组对照（`setPaused(false)` 应降级 / `setPaused(true)` 不降级）。撤修后 B 组 `mode` 变 `relay`（3/5） |
| `test/rejoin-schedule.js` | 浏览器（puppeteer，真 host 建房 + 两个 view 页） | **P1 回归**：①`host-return` 的 `scheduleRejoin(true)` 必须抢占挂起的退避定时器（旧代码 `if (rejoinTimer) return` 会把它吞掉 → 画面永久冻结）；②`leave()` 与 `onHostGone()` 各自都要清 `rejoinTimer`/`rejoinInFlight`。**两处分别 A/B**：只撤 `onHostGone` 那处 → 12/14。另有前置守卫自检（`scheduleRejoin` 的首道 `if (!roomCode \|\| !signal \|\| signal.state !== 1) return` 必须放行）：A/B 里 `__signal.close()` 破坏前置条件 → 该断言转红、连带下游用例降为 11/15 |
| `test/join-failed-backoff.js` | 浏览器（puppeteer，真 host 建房 + host-away 优雅窗口 + `__joinLog` 出站打点） | **P0 回归**：host-away 优雅窗口内 `room.host=null`，大屏重建发出的 join 必收 `join-failed`；旧代码在该分支调 `scheduleRejoin(true)`（delay=0、不计配额、不进限流）→ "join-failed → 立即 join"的 RTT 洪水（本地实测 **4 秒 29,773 次**）。修复后走 `scheduleRejoin(false)` 退避。断言：4s 窗口 join ≤5、`rejoinAttempts>0`（配额被消耗）、`rejoinInFlight` 保持 true（退避链不断）。附带 **force 抢占 force 定时器不得多减 `rejoinAttempts`**（`rejoinTimerFromForce` 来源标记）的撞车用例。**分别 A/B**：撤 Bug 1 修复 → 29,773 次（5/8）；撤 Bug 2 修复 → `before=2 after=0`（7/8） |
| `test/server-restart-rejoin.js` | 浏览器（puppeteer，私有端口起独立服务 + 真 host+viewer 双页 + `SIGKILL` 杀服务再重启） | **P2.5 回归**：服务器进程被杀/重启时，观看端 ws 关闭 → close 处理器只换横幅不清 `joined` → 信令重连后 open 的 `!joined` 守卫挡住重新 join，大屏成为新服务器上的"幽灵"（新实例无旧房间状态，`room-closed` 不可能补发）。**关键前置**：杀服务前用 `__host.forceStall` 把会话强制切到中继（观看端无 pc 可 failed），否则 P2P 模式下旧代码经 `pc failed → scheduleRejoin` 也能缓慢自愈、A/B 抓不住"永久卡死"这个缺陷形态。修复后 close 清 `joined` 并置 `sessionSevered`，open 对被切断过的会话销毁旧传输层（`destroy` 把 mode 复位为 `connecting`，否则退避链"决策 1"把重 join 误判成"已处于中继"而撤销）+ 置 `rejoinInFlight`（join-failed 走退避链）+ 立即重 join。**A/B**：撤修复 → 10/14（⑦ `joined` 残留 true、⑪ `__joinLog` 零增长、⑫ 未重新加入、⑬ 横幅卡死 4 处红） |
| `test/url-malformed.js` | 协议层黑盒（真实 HTTP 请求服务端） | **P1 回归**：`GET /%`（含未转义 `%`）旧代码在 `serveStatic` 的 `decodeURIComponent` 抛**未捕获** `URIError` → 进程退出（DoS）。修复后用 try/catch 包住解码、返回 400 且不死。断言：返回 400 且服务端进程随后仍存活。**A/B**：撤 Bug 2 修复 → 服务端退出（1/4，其余断言因服务已死而连带失败） |
| `test/relay-frame-cap.js` | 协议层黑盒（真实 host ws 发二进制分片） | **P1 回归**：中继分片超过 `RELAY_FRAME_MAX`（1MB）必须被服务端**丢弃**，且不得误伤 ≤1MB 的合法分片（15Mbps/120ms 下最大合法分片约 225KB）。`frame()` 用 8 字节空格补齐的 `viewerId` 前缀模拟真实帧头。**A/B**：撤 Bug 8 修复 → 超限分片被转发（3/4，一条断言因大帧成功到达而红） |
| `test/relay-degrade.js` | 浏览器（puppeteer，劫持 `MediaSource` + 伪造 signal 喂 vx） | **P1 回归**：①Bug 1 中继 blob 播放的 `scheduleBlobPlay` 不得用 `clearTimeout` 后重排（分片到达快于 1s → 定时器永饿死 → 永久黑屏）；②Bug 4 `addSourceBuffer` 失败必须降级为 `relay-blob`（移交已到分片）；③Bug 6 `destroy()` 必须清 `blobTimer`。**分别 A/B**：撤 Bug 1 → 黑屏不恢复（5/6）；撤 Bug 4 → 卡死不降级（5/6） |
| `test/host-stats-classify.js` | 浏览器（puppeteer，白盒 `getPeers()`） | **P1 回归**：`cast.html` 的 stats 把 `p2p-relay` 错误归为 `p2p`；修复后 `e.mode==='relay' \|\| e.mode==='p2p-relay'` 才计入 `relay`（与 `updateModeTag` 对齐）。**A/B**：撤 Bug 3 修复 → `p2p-relay` 仍算 `p2p`（2/4） |
| `test/report-gating.js` | 浏览器（puppeteer，`__sent` 出站打点） | **P1 回归**：未连接（非 `connected`）时 `viewer.report()` 不得发出 `viewer-status`（空 payload 会污染看门狗 freshness 守卫）。用 delta 计数（断言 `sent.length - before`），避免累计计数在 A/B 下因"本就该发的无效报告"误红。**A/B**：撤 Bug 9 修复 → 未连接仍上报（1/2） |
| `test/turn-urls-split.js` | 浏览器（puppeteer，白盒 `Cast.buildIceServers`） | **P1 回归**：`turn.urls` 为逗号分隔字符串（`turn:a,turn:b`）必须拆成多条目；旧代码整串塞进 `rtcConfig.iceServers[].urls`（既非 string 也非 array 的逗号串）→ 该 TURN 失效。**A/B**：撤 Bug 7 修复 → 逗号串不被拆（1/4） |
| `test/addviewer-vs-reset.js` | 浏览器（puppeteer，劫持 `RTCPeerConnection.createOffer` 闸门 + `__signal.close()`） | **防护锁定**：Bug 5 报告断言 `cast.html` 的 `viewerMap` 与 `host.peers` 存在"短暂脱钩窗口"会留僵尸 peer；实测该窗口**不可达**（`insert-before-await` + `delete-on-reset` 使僵尸不可达），故本用例不是"撤修复转红"，而是**证明撤销路径安全**——断连瞬间挂起的 `addViewer` 在重连后不产生孤儿 peer（4/4 恒绿，作为防御性不变契约） |

> `replaced` 相关的两个测试最早只存在于开发用的临时目录，未随项目发布，导致本文档的引用一度指向不存在的文件。现已纳入 `test/` 并接入 `npm test`。它们是"为什么保留 `replaced` 死代码"这一论证的证据链，缺了它们 0/5 与 A/B 结论就无法被复核。
>
> 上表**全部 28 个用例文件**均在仓库 `test/` 目录内，并由 `test/run-all.js` 的 `SUITES` 统一调度；此前的"开发期用例"（`stale-cond` / `relay-nochurn` / `selfheal` / `crossroom`）已全部补为正式文件，不再是死引用。

**普通大屏发的信令仍会被正常转发**（守卫只针对已死/被替换的连接）：`offer`/`answer`/`ice`/`viewer-status` 全部照常，二进制中继帧同样走 `room.host.send`。任何"加了守卫导致正常流程变慢/中断"的回归都会在这两个测试的"未误伤"分组里暴露。

**路径 B：真正结束（点击停止 / 换房间码）**

发送端发 `leave`，服务端立即 `destroyRoom` 并广播 `room-closed`，大屏回到待机。

| 场景 | 发送端 | 大屏 |
|---|---|---|
| 刷新页面 / 信令抖动 | 发 `host-away`，清空 `roomCode` + 观看列表 + 传输层所有 peer，自动重连并**复用原房间码**，随后发 `host-return` | 横幅「连接波动，正在恢复…」（常驻），收到 `host-return` 后变「已恢复」并自动淡出；若 15 秒超时才回待机 |
| 主动停止 / 换房间码 | 发 `leave`，作废房间 | 立即收到 `room-closed`，回待机 |

**两级恢复机制的分工**（两者目标相同、手段相反，必须划清边界）：

| 症状 | 判定方 | 处置 |
|---|---|---|
| 画面停滞但**主机还在**（P2P 静默劣化） | 主机侧看门狗（15 秒无解码增长） | 降级为服务器中转 |
| **主机消失** —— 收到 `host-return`（强信号） | 大屏侧 | 立即重建，跳过健康判定 |
| **主机消失** —— 连接 `failed`（弱信号） | 大屏侧 | 退避后用 `currentTime` 二次确认，再重建 |

大屏**不做**周期性的画面停滞检测 —— 否则画面一停就重连、重连后 P2P 又通，主机侧永远等不到降级时机，中继兜底会失效。

发送端信令断开时必须**同时清三处状态**，否则会留下幽灵大屏：

- `roomCode` 不清 → 重连后 `ensureRoom()` 直接返回，房间永远建不回来；
- `viewerMap`（UI 层）不清 → 重连后的空房间里旧 viewerId 仍显示为一块大屏，还会污染链路标签聚合；
- `host.peers`（传输层）不清 → 旧 `RTCPeerConnection` 永不回收。大屏自动接回时会以**新** viewerId 加入，新旧叠加导致统计长期虚高。

三者里传输层最容易被漏掉：只清 UI 时页面看着正常（计数归零），但 `peers` 里始终挂着旧条目。

#### 信令层的 `close()` 与 `reconnectNow()`：一字之差，结果相反

信令层（`public/js/core.js`）对"断开当前 ws"提供了两个方法，语义**完全相反**，混用会造成"用户被永久踢下线"：

| 方法 | 行为 | 适用场景 |
|---|---|---|
| `close()` | 置 `closedByUser = true`，此后 `ws.onclose` **直接 return**，信令层**永不重连** | 仅限页面即将卸载（`beforeunload`）——此时确实不该再重连 |
| `reconnectNow()` | 断开当前 ws 并走**正常指数退避重连** | 需要"换一条新 ws 继续用"的一切场景 |

**为什么 `close()` 不能用于"想重连"**：`closedByUser` 是单向标记，`connect()` 里从不复位。一旦调用，此后任何断开都不会再触发重连，页面永久卡在「连接中断」，只能刷新。

`reconnectNow()` 内部有三处处理，**每一处都不可省**，缺任一都会静默失效：

**1. 无条件复位 `closedByUser = false` 和 `retry = 0`**

- 不复位 `closedByUser` → 本方法的正确性**依赖调用顺序**：只要此前有人（哪怕是别处代码）调过一次 `close()`，残留的 `true` 就会让后续所有 `reconnectNow()` 都短路。复位后本方法自洽：无论此前发生过什么，调用它就一定会重连。
- 不复位 `retry` → 两条分支行为不一致。`OPEN` 分支走 `ws.close()` 后，`onclose` 里 `600 * 1.6^retry` 会用**当前** retry 值；若此前已连续失败 5 次（`retry=5`），用户点"重连"却要等约 6.3 秒才开始，与"立刻重连"的语义不符。所以把 `retry = 0` 提到分支之前，两条路径都从 0 起算。

**2. `readyState` 必须三分支，不能写成 `>= 2`**

WebSocket 的 `onclose` **只派发一次**，但 `CLOSING(2)` 与 `CLOSED(3)` 在"`onclose` 是否已派发"上恰好相反：

| readyState | 含义 | onclose 是否已派发 | 正确处置 |
|---|---|---|---|
| `1` OPEN | 正常 | 否 | 主动 `ws.close()`，交给 `onclose` 走退避重连 |
| `2` CLOSING | 正在关闭（握手期间） | **否，即将派发** | **摘除旧 socket 的事件回调**，再立即 `connect()` |
| `3` CLOSED | 已关闭 | 是 | 直接 `connect()`——再 `ws.close()` 不产生新事件 |

把 `2` 和 `3` 合并成 `>= 2`（早期实现即如此）会导致 **CLOSING 时抢先生的 ws 变成孤儿连接**：

```
在 CLOSING 窗口直接 connect()
  → connect() 生成 A，模块级 ws 指向 A
  → 几十 ms 后旧 socket 的 onclose 派发（closedByUser 刚被复位为 false）
  → 走 setTimeout(connect, delay) → 再次 connect() 生成 B，ws 改指 B
  ⇒ A 无人引用，但底层 socket 仍 OPEN —— 继续收服务端消息却无人处理，
    服务端也误以为该浏览器有两条活跃 ws
```

为什么 CLOSING 选择"摘回调 + 立即重连"而不是"什么都不做、等 onclose"：后者虽然也不会产生孤儿，但用户要等几十到几百毫秒才恢复。`reconnectNow()` 的语义就是"我要立刻换一条"，所以摘掉旧回调消除撞车风险、同时立刻建新连接。

**3. 三个分支的边界必须由 `readyState` 精确判定**，不能靠 `>=` 之类的范围比较——`CLOSING` 与 `CLOSED` 的处置是**相反**的，把它们归为一类就是本 bug 的成因。

各处的 A/B 对照验证：

| 缺陷 | 撤掉对应修复后的表现 | 测试 |
|---|---|---|
| 不复位 `closedByUser` | 调 `reconnectNow()` 后仍连不上 | `test/reconnect.js` `5/6` |
| 只有复位、无死连接分支 | 同上（CLOSED 时 `onclose` 不再派发） | `test/reconnect.js` `5/6` |
| `readyState >= 2`（CLOSING 误判） | 重连后**两条 ws 同时 OPEN**，其中一条是孤儿 | `test/reconnect-closing.js` `4/6`，观测到 `openNow=2` |


> **降级不可逆**：`enableRelay()` 成功后才把模式置为 `relay`；若初始化失败则置为 `failed`（而不是停留在 `relay`），这样发送端不会误显示「服务器中转」，同时保留重试机会。

### 关于「静默中断」检测

WebRTC 有个坑：网络悄悄断掉时，`connectionState` 可能长时间停留在 `connected`，光看状态判断不出链路已死。所以这里额外加了**帧级存活看门狗**。

判定依据是**接收端回报的 `framesDecoded`**（真实解出的帧数），而不是发送端的 `framesEncoded`。原因很实在：

- 采集**静止桌面**时编码器可能长时间零输出，用发送端指标会把健康的低延迟 P2P 误判为失效；
- 观看端多半挂在一边当显示器，页面进了后台会被 Chrome/Safari 把定时器**节流到分钟级**，"多久没收到回报"同样不能作为失效依据。

因此只有在「接收端连续 15 秒解码帧数零增长」时才降级，且真实掉线由 `connectionState` / `iceConnectionState` 变更直接覆盖。

**回报本身也会被节流**，所以「多久没收到回报」只用来**跳过**本轮判定，绝不用来**触发**降级：

- 若距上次回报超过 30 秒，说明接收端回报被节流或已中断，此时无法判断画面对端是否真在解码 → 本轮直接跳过，既不累计停滞时长也不降级；
- 只有在回报持续正常到达、且 `framesDecoded` 连续 15 秒不增长时，才认定静默中断。

否则会出现一个隐蔽的假阳性：后台标签页里定时器被节流 → 回报停止 → `decodedGrew` 冻结在最后一次的 `false` → 停滞计时一直累加 → 15 秒后把一个**本来健康的 P2P 连接**降级成中转。

### 链路类型的判定

**不使用**基于 SDP 的粗判。只要 `buildIceServers()` 里带了 TURN，本地 SDP 就必然包含 `typ relay` 候选（哪怕实际走的是 host/srflx），粗判在配了 TURN 的环境下只会稳定给出错误答案。

正确做法是连接瞬间先给中性态 `p2p-pending`，随后异步查询 `getStats()` 里 `state=succeeded && nominated` 的候选对，读取其 local/remote `candidateType` 得出真实链路：`host` → 局域网直连，`srflx`/`prflx` → P2P 直连，`relay` → TURN 中转。

## 配置 TURN（跨公网更稳）

不给 TURN 也能用（靠 STUN + 中转兜底）。但如果两端都在严格 NAT / 企业防火墙后面，配一个 TURN 会稳很多：

```bash
PORT=8080 \
TURN_URL=turn:your-server.com:3478 \
TURN_SECRET=your_coturn_static_auth_secret \
node server/server.js
```

服务端会用 coturn 的 REST API 方式**动态签发临时凭据**（HMAC-SHA1，默认 24 小时有效），不会把长期密码暴露给前端。

部署 coturn 参考：

```bash
# Ubuntu
sudo apt install coturn
# /etc/turnserver.conf
listening-port=3478
fingerprint
use-auth-secret
static-auth-secret=your_coturn_static_auth_secret
realm=your-server.com
```

## 大屏操作

| 操作 | 说明 |
|---|---|
| 鼠标移到画面 | 唤出悬浮控制条（3 秒后自动隐藏） |
| `F` 或双击画面 | 全屏切换 |
| `B` | 黑屏保护（画面隐藏但连接保持，适合临时遮挡） |
| `S` | 缩放模式切换（完整显示 ↔ 铺满裁切） |
| `Esc` | 退出黑屏 |
| 点画面 | 恢复播放（浏览器拦截自动播放时） |

## 发送端功能

- **画质档位**：流畅 1.5M / 标准 4M / 高清 8M / 超清 15M
- **帧率**：15 / 30 / 60 fps
- **系统声音**：可选是否采集（需在开始投屏前设置）
- **暂停**：临时停推，画面定格
- **换房间码**：作废旧房间，生成新码
- **实时统计**：分辨率 / 帧率 / 码率 / 时长 / 每块大屏的链路与延迟

## 安全性

- 房间码 4 位，字符集剔除易混字符（`0/O/1/I`），由 `crypto.randomInt` 生成
- 单房间最多 8 块大屏
- 房间 6 小时无活动自动回收
- 发送端停止投屏 / 关闭页面时立即作废房间，大屏同步收到通知

## 浏览器要求

需要支持 `getDisplayMedia` + `MediaRecorder` + `MediaSource` 的现代浏览器（Chrome / Edge / Firefox 较新版本）。

> **HTTP 环境提示**：浏览器通常只在 HTTPS 或 `localhost` 下开放屏幕采集。本项目默认放行局域网私有网段（`10.x` / `192.168.x` / `172.16-31.x` / `*.local`），所以局域网内用 `http://192.168.x.x:8080` 直接访问即可。公网部署请务必上 HTTPS。

## 项目结构

```
screencast/
├── server/
│   └── server.js          # 静态托管 + WebSocket 信令 + 房间管理 + 二进制中继 + TURN 凭据
├── public/
│   ├── index.html         # 首页导航
│   ├── cast.html          # 发送端控制台
│   ├── view.html          # 接收端大屏
│   ├── style.css          # 全局样式（纯白极简）
│   └── js/
│       ├── core.js        # 公共层：信令封装 / ICE 配置 / 链路判定 / 二维码
│       ├── host.js        # 发送端传输层：多观看端连接 + 看门狗 + 中继推流
│       ├── viewer.js      # 接收端传输层：P2P 播放 + MediaSource 中继播放
│       └── qrcode.js      # 二维码生成（第三方库，本地内置，无外链）
├── test/
│   ├── run-all.js             # 测试总入口：拉起 server → 依次跑用例 → 清理
│   ├── replaced-guard.js      # 协议层：非 host 连接转发 + replaced 根因
│   ├── replaced-guard-race.js # 协议层：不可达性 + 白盒 A/B
│   ├── crossroom.js           # 协议层：跨房间切换时旧房间引用清理
│   ├── reconnect.js           # 浏览器：close()/reconnectNow() 语义
│   ├── reconnect-closing.js   # 浏览器：CLOSING 窗口不产生孤儿连接
│   ├── replaced-ux.js         # 浏览器：replaced 后的链路文案
│   ├── quality-injection.js   # 浏览器：新大屏拿到用户当前选择的画质
│   ├── newcode-cleanup.js     # 浏览器：换码时清空传输层 peer
│   ├── viewer-teardown.js     # 浏览器：主机结束后接收端销毁传输层
│   ├── concurrent-addviewer.js # 浏览器：并发 addViewer 不得误推中继
│   ├── answer-seq.js         # 浏览器：过期 answer 按世代号拒绝
│   ├── stale-cond.js          # 浏览器：画面冻结判定的时间窗/基准语义
│   ├── relay-nochurn.js       # 浏览器：中继模式下不空转重建 P2P
│   ├── selfheal.js            # 浏览器：撤销重建后必须重新排程
│   ├── viewer-status-id.js    # 协议层：viewerId / type 不得被 payload 覆盖
│   ├── unload-no-leave.js     # 浏览器：卸载期间不得发 leave
│   ├── pause-watchdog.js      # 浏览器：暂停不得被误判为静默中断
│   ├── rejoin-schedule.js     # 浏览器：host-return 抢占 + leave 清零
│   ├── join-failed-backoff.js # 浏览器：join-failed 退避限速 + force 抢占计数
│   ├── server-restart-rejoin.js # 浏览器：服务器重启后大屏自动重新加入（P2.5）
│   ├── url-malformed.js       # 协议层：畸形 URL 不打死服务（GET /% → 400）
│   ├── relay-frame-cap.js     # 协议层：中继分片 1MB 上限（超限丢弃）
│   ├── relay-degrade.js       # 浏览器：blob 定时器洪水 / addSourceBuffer 降级
│   ├── host-stats-classify.js # 浏览器：stats 把 p2p-relay 归入 relay
│   ├── report-gating.js       # 浏览器：未连接时不发无效 viewer-status
│   ├── turn-urls-split.js     # 浏览器：buildIceServers 归一化 TURN 地址
│   ├── addviewer-vs-reset.js  # 浏览器：断开时挂起 addViewer 不留僵尸（防护锁定）
│   └── static-hygiene.js      # 静态：未使用解构变量 + 注释契约
├── package.json
├── pnpm-lock.yaml         # 依赖锁定（仅 ws；用 npm 安装时可忽略）
└── README.md
```

`test/` 下每个用例文件的形态与断言见 [跑测试](#跑测试) 一节；`npm test` 即全量入口。

## HTTP 接口

| 路径 | 说明 |
|---|---|
| `GET /api/config` | 获取 ICE 配置（含动态 TURN 凭据） |
| `GET /api/health` | 健康检查，返回房间数与运行时长 |
| `GET /cast` | 发送端页面 |
| `GET /view` | 接收端页面（支持 `?r=ABCD` 预填房间码） |

## 调试与自动化测试

两端页面都支持 `?debug=1`，它只做一件事：把内部状态挂到 `window` 上供自动化脚本读取。生产使用不加这个参数完全无副作用。

| 页面 | 全局对象 | 用途 |
|---|---|---|
| 发送端 `/cast?debug=1` | `window.__signal` | 信令实例（含 `.socket`，可强制断开以模拟掉线） |
| | `window.__host` | 传输层实例（含 `peerIds` 当前 peer id 列表、`peerModes` id→mode 映射、`peerState(id)` pc 连接状态、`peerLiveness(id)` 看门狗输入、`forceStall(id, s)` 把停滞时间戳推旧、`setPaused(bool)` 暂停开关） |
| | `window.__sent` | 出站信令痕迹（`[{type, t}]`），用于断言"某条消息**没有**被发出" |
| | `window.__endSession` / `__setUnloading` | 直接驱动会话结束路径，复现卸载期间的行为 |
| | `window.__forceStarted` | 把 `started` 置位，使自动化能触达 `if (!started) return` 守卫后的分支（如「换一个」按钮）——headless 下无法走 `getDisplayMedia` 的系统选择器 |
| 大屏 `/view?r=CODE&debug=1` | `window.__signal` | 信令实例（**实现为 getter**，重连时会换实例），用于等 OPEN 与读 rtt |
| | `window.__vx` | 接收端传输层（`mode` / `localStats()` / `report()`）。**实现为 getter**：`vx` 在运行期会被整体替换（`relay-begin` / `onHostGone`），一次性赋值会让测试盯着已销毁的旧实例 |
| | `window.__rejoin` | 重建流程的内部把手（见下） |
| | `window.__joinLog` | `doJoin` 出站时间戳数组，用于断言 join-failed 链路的重试速率（`signal.send` 是 `defineProperties` 写的、不可外包，只能在发送点打点） |

`window.__rejoin` 提供以下方法，用来构造端到端无法自然出现的场景：

```js
__rejoin.schedule(t0, force)  // 把基准复位成"无基准"，再按 force 触发一次重建
__rejoin.reset()              // 清空重建退避状态（attempts / inFlight / timer）
__rejoin.alive()              // 直接调用 isPictureAlive()
__rejoin.fresh()              // 上次 alive() 是否返回"无从判断"的乐观值
__rejoin.probe()              // 读取 { lastVideoTime, lastVideoAt, rejoinAttempts, rejoinChecks,
                              //        rejoinInFlight, timerPending }
__rejoin.hostGone(reason)     // 直接触发 onHostGone（覆盖不经 leave() 的独立入口）
__rejoin.forceStale(secs)     // 把基准改成"画面停滞"（lastVideoTime=当前值、lastVideoAt 推后）
__rejoin.staleConditions()    // 逐条暴露停滞判定的两个子条件（用于独立断言）
```

**为什么需要它**：`isPictureAlive()` 的「首次调用乐观返回 true」分支只能在**从未建立过基准**时触发，但这个前提在端到端里几乎无法自然构造 —— 主机刷新必然先让大屏的 `pc` 进入 `failed`，那条路径已经建立了基准，把缺陷掩盖了。`__rejoin.schedule(t0, force)` 直接操纵基准状态，让这个分支可以被确定性地复现和断言。

### 跑测试

```bash
npm test
```

由 `test/run-all.js` 编排：自动（或复用）启动信令服务 → 依次跑 `test/` 下全部用例 → 收尾清理。端口可用 `TEST_PORT` 覆盖（默认 `8080`）。

浏览器用例（共 21 个，含 `reconnect.js` / `rejoin-schedule.js` / `join-failed-backoff.js` / `server-restart-rejoin.js` / `relay-degrade.js` 等）需要 **Chromium + `puppeteer-core`**（开发依赖）。未安装 `puppeteer-core` 时这些用例会打印 `SKIP` 并以 0 退出，**不会**让 `npm test` 硬失败——只装运行依赖的用户仍能跑协议层与静态用例。为避免"跳过被误报成通过"，`run-all.js` 会区分 `SKIP` 与 `PASS`：汇总行会明确写出"X/28 通过，Y 个跳过"，且只在出现**真正失败**时才以非 0 退出。需要完整跑时：

```bash
npm i -D puppeteer-core      # 或全局可用后设置 CHROME_PATH 指向 chromium
CHROME_PATH=/usr/bin/chromium npm test
```

## 项目截图

![project-screenshot](project_screenshot.png)

## 许可证

[MIT](LICENSE)
