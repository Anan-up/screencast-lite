/* 静态卫生：未使用的解构变量 + 注释不撒谎（P3 回归）
 *
 * 缺陷回顾（cast.html 的 start()）：
 *     const { fps } = currentParams();
 *     stream = await captureScreen({
 *       fps: parseInt(el.selFps.value, 10),   // ← 用的是 el.selFps，不是解构出的 fps
 *       ...
 *     });
 * 功能无影响，但会**误导读者**：看起来 currentParams() 参与了帧率决策，
 * 实际上这一行没有任何作用。同类问题此前还出现过一次（togglePause 里的
 * vt/at），说明这是个会反复冒头的模式。
 *
 * 为什么不写成运行时用例：这是静态代码卫生问题，没有可观测的运行期行为。
 * 用正则 + 作用域窗口扫描反而更精确 —— 而且能在**没有浏览器**时运行。
 *
 * 检测策略（够用就好，不做完整 AST）：
 *   1. 找出 `<script>` 里的 `const { a, b } = ...` 形式解构
 *   2. 在**同一函数体内**（用后续 200 行近似）搜索标识符是否被使用
 *   3. 白名单：以 `_` 开头（约定俗成的占位）、以及出现在注释行里的不算
 *
 * 依赖：无（纯文件读取，恒可运行）。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
function ok(n, c, e) { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  ' + e : '')); } }

/** 抽取 HTML 内联 script（以及 .js 文件的全部内容） */
function scriptsOf(file) {
  const src = fs.readFileSync(file, 'utf8');
  if (file.endsWith('.js')) return [{ src, base: 0 }];
  const out = [];
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(src))) {
    // 计算这条 script 在原文件中的起始行号，便于报告行号
    const upto = src.slice(0, m.index + m[0].indexOf(m[1]));
    out.push({ src: m[1], base: upto.split('\n').length });
  }
  return out;
}

/** 去掉注释（避免"注释里提到过"被误判为"使用过"） */
function stripComments(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(Math.max(0, m.length - p1.length)));
}

const TARGETS = [
  'public/cast.html',
  'public/view.html',
  'public/js/host.js',
  'public/js/viewer.js',
  'public/js/core.js',
  'server/server.js',
];

let findings = [];
for (const rel of TARGETS) {
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) continue;
  for (const { src, base } of scriptsOf(file)) {
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // 只处理"整行只有一个解构声明"的形式，避免误判嵌套/多语句
      const m = line.match(/^\s*const\s*\{([^}]+)\}\s*=/);
      if (!m) continue;

      // ---- 收窄范围，只查"函数体内的临时解构" ----
      //
      // 排除项与理由：
      //   1) 缩进 < 4：这类是**模块顶层的库导入**（如
      //      `const { createSignal, buildIceServers } = global.Cast;`），
      //      它们的使用点散布在整个文件，200 行窗口根本不够，必然误报。
      //   2) 模块导入还有个更本质的区别：它不是"这次调用的临时产物"，
      //      而是"这个文件的能力清单"，本就允许部分未用（解构导入是常见风格）。
      //   3) `...rest` 是 rest 元素而非具名变量，跳过。
      const indent = line.match(/^\s*/)[0].length;
      if (indent < 4) continue;

      // 4) `const { a, b, ...rest } = o; return rest;` 是**排除式解构** ——
      //    a/b 被解构出来恰恰是为了**丢掉**它们，不是"忘了用"。
      //    这是合法惯用法（见 cast.html 的 omitId），必须整条跳过。
      if (/\.\.\.\s*\w+\s*$/.test(m[1].trim()) || m[1].includes('...')) continue;

      const names = m[1].split(',')
        .map((s) => s.split(':').pop().trim().split('=')[0].trim())
        .filter((s) => s && s !== '__proto__' && !s.startsWith('...'));

      // 作用域窗口：本条声明之后 200 行（近似函数体）
      const rest = stripComments(lines.slice(i + 1, i + 201).join('\n'));
      for (const nm of names) {
        if (!nm || nm.startsWith('_')) continue;
        const re = new RegExp('(^|[^\\w$.])' + nm.replace(/[$]/g, '\\$') + '($|[^\\w$])');
        if (!re.test(rest)) {
          findings.push({ file: rel, line: base + i, name: nm, text: line.trim() });
        }
      }
    }
  }
}

console.log('   扫描目标：' + TARGETS.length + ' 个文件的解构声明');

ok('未发现未使用的解构变量', findings.length === 0,
  findings.map((f) => `${f.file}:${f.line} 解构出 ${f.name} 但窗口内未使用 → ${f.text}`).join('  |  '));

// ---- 反向自检：确认检测器本身有效（否则"零发现"可能只是检测器坏了） ----
// 用一段合成的代码喂给同一套逻辑（缩进 ≥ 4，与真实函数体一致），必须报出 1 处。
const FAKE = `
function demo() {
    const { unused } = getOpts();
    const { used } = getOpts();
    console.log(used);
}
`;
{
  const lines = FAKE.split('\n');
  let hits = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*const\s*\{([^}]+)\}\s*=/);
    if (!m) continue;
    if (lines[i].match(/^\s*/)[0].length < 4) continue;   // 与主逻辑同一收窄规则
    const names = m[1].split(',').map((s) => s.trim()).filter((s) => s && !s.startsWith('...'));
    const rest = stripComments(lines.slice(i + 1).join('\n'));
    for (const nm of names) {
      const re = new RegExp('(^|[^\\w$.])' + nm + '($|[^\\w$])');
      if (!re.test(rest)) hits++;
    }
  }
  ok('反向自检：检测器能报出合成样例里那个未使用的解构（证明零发现不是假绿）',
    hits === 1, `hits=${hits}`);
}

// ---- 契约断言：那几处已修的历史问题不得复发 ----
//
// 为什么通用检测之外还要这几条硬断言：
//   通用检测用的是"标识符是否在窗口内出现过"，对**属性名同名**的情况会漏报。
//   典型就是 fps：`const { fps } = ...` 后面紧跟 `captureScreen({ fps: ... })`，
//   那个 `fps:` 是对象字面量的**键**，却被当成"使用过"匹配上了。
//   （A/B 实测：把死变量加回去，通用检测仍然报绿，只有下面这条会失败。）
//   所以对已知的具体问题做直接断言 —— 通用检测负责发现**新**问题，
//   契约断言负责守住**旧**问题。两者互补，不重复。
const castSrc = fs.readFileSync(path.join(ROOT, 'public/cast.html'), 'utf8');
ok('cast.html 的 start() 不再解构 fps（Bug 6 已修）',
  !/^\s*const\s*\{\s*fps\s*\}\s*=/m.test(castSrc), '仍存在 const { fps } = ...');

const viewSrc = fs.readFileSync(path.join(ROOT, 'public/view.html'), 'utf8');
ok('view.html 的 togglePause 不再解构 vt/at',
  !/^\s*const\s*\{\s*vt\s*,\s*at\s*\}\s*=/m.test(viewSrc), '仍存在 const { vt, at } = ...');

// ---- 契约断言：测试代码不得硬编码 node_modules 绝对路径 ----
//
// 缺陷回顾（join-failed-backoff.js 初版）：require 一个 /tmp 下的绝对路径，
// 在没有该目录的环境里抛 MODULE_NOT_FOUND，被 try/catch 兜住后 exit(0)——
// run-all 只看退出码，于是"唯一覆盖 P0 洪水缺陷的用例"在任何正常机器上
// 静默 SKIP 却仍报"通过"。这与 README 死引用、replaced 死代码同属
// "看起来有保护、实际没保护"的模式，所以用静态断言永久守住：
// 标准模块解析（裸包名）会从 test/ 逐级向上找 node_modules，
// 无论依赖装在仓库根还是别处都能命中，与其余用例行为一致。
//
// 注意本断言扫描 test/ 下全部 .js（含本文件自身）——正则里 require 后
// 的括号是转义写的，字面文本不含"require("连续串，不会自匹配。
{
  const testDir = path.join(ROOT, 'test');
  const bad = [];
  for (const f of fs.readdirSync(testDir).filter((f) => f.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(testDir, f), 'utf8');
    const m = src.match(/require\(\s*['"`]\/[^'"`]*node_modules\//);
    if (m) bad.push(`test/${f} → ${m[0]}`);
  }
  ok('test/*.js 均不硬编码 node_modules 绝对路径（防静默 SKIP）',
    bad.length === 0, bad.join('  |  '));

  // 反向自检：字符类 `['"`]` 必须同时认单引号、双引号、反引号（模板字符串）。
  // 曾有人提出"正则只匹配反引号外的引号，用模板字符串写 require 会漏报"——
  // 实测字符类已含反引号，三种写法都会被命中。这条断言把"三种引号都能被
  // 检出"锁成契约：将来若有人把字符类收窄成 `['"]`，反引号样例会转红，
  // 不会让"漏报"静默回归。
  //
  // 注意：样例必须运行时拼接，不能把"反引号 / 单引号 / 双引号包着绝对路径的
  // require 调用"直接写成源码字面量——上面的扫描把 test/*.js（含本文件）都
  // 算进去，写死的样例会与自身匹配，让第 5 条"零硬编码"假红。
  const REQ_RE = /require\(\s*['"`]\/[^'"`]*node_modules\//;
  const mk = (q) => 'require(' + q + '/tmp/node_modules/foo' + q + ')';
  const samples = [mk("'"), mk('"'), mk('`')];
  ok('反例自检：单/双/反引号的绝对路径 require 均能被检出',
    samples.every((s) => REQ_RE.test(s)),
    samples.filter((s) => !REQ_RE.test(s)).join(' | '));
}

console.log(`\n通过 ${pass}/${pass + fail}`);
process.exit(fail === 0 ? 0 : 1);
