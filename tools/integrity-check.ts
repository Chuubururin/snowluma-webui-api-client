// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
/**
 * 派发简报末尾那道「git 状态 + 报告结构」完整性复核的单进程版。
 *
 * 取代的是这条六进程复合命令：
 *   cd "<worktree>" && git status --porcelain && echo "(clean if nothing above)"
 *     && git log --oneline -1 && wc -l <report> && grep -n "^## " <report>
 *
 * 换掉它的理由不是慢（六步实测共约 150ms，其中每步 ~20ms 是 Git Bash 在 Windows 上 fork
 * 进程的地板价，并行化省不下多少），而是那六份 shell 引号面里藏着一条**永久挂起**的路径：
 * 引号一旦在传递层被吃掉，`grep -n "^## " <file>` 里的 `## ` 退化成 shell 注释、**文件参数
 * 一并消失**，grep 转为读 stdin 并无限阻塞 —— 子会话的 stdin 常是一条开着的管道，于是没有
 * 任何超时会救它。本文件里所有外部调用都显式 `stdio[0] = 'ignore'`：进程结构上拿不到 stdin，
 * 少传参数只会立刻报错，不会挂着。报告解析走 `readFile`，一个进程都不 fork。
 *
 * 它必须能红。三道判据里任意一道不过即 exit 1 —— 一道不会红的检查比没有检查更糟。
 */
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** 永不许被 staging 的产物前缀（`.gitignore` 已挡住，这里是第二道，防 `git add -f`）。 */
const FORBIDDEN_STAGED = ['generated/', '.venv-gen/'];

/** 报告至少要有一段 `## ` 小标题，否则视为「没写过」而不是「写完了」。 */
const MIN_SECTIONS = 1;

const run = (file: string, args: string[]) =>
  new Promise<{ stdout: string; code: number }>((resolvePromise) => {
    // stdin: 'ignore' ⇒ 子进程的 0 号fd 直接是 /dev/null，不可能挂在那里等输入。
    // 用 spawn 而非 execFile：后者的 options 类型（ExecFileOptions）不接受 stdio，
    // 而"结构上拿不到 stdin"正是本文件存在的理由，不能让给类型检查。
    // --no-optional-locks 由调用方加：只读查询不去抢 index.lock。
    const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c: string) => {
      stdout += c;
    });
    child.on('error', () => resolvePromise({ stdout: '', code: 127 }));
    child.on('close', (code) => resolvePromise({ stdout, code: code ?? 1 }));
  });

const git = (args: string[]) => run('git', ['--no-optional-locks', ...args]);

const report = process.argv[2];
if (!report) {
  console.error('用法：tsx tools/integrity-check.ts <报告路径> [HEAD [段名 …]]');
  process.exit(2);
}
const expectHead = process.argv[3];
const requireSections = process.argv.slice(4);

// 四道互相独立，一次并发跑完（git 侧三道 + 报告读盘一道）。
const [status, staged, head, text] = await Promise.all([
  git(['status', '--porcelain']),
  git(['diff', '--cached', '--name-only']),
  git(['log', '--oneline', '-1']),
  readFile(report, 'utf8').then(
    (v) => v,
    (e: NodeJS.ErrnoException) => {
      console.error(`读不到报告 ${report}：${e.code ?? e.message}`);
      return null;
    },
  ),
]);

if (text === null) process.exit(1);

// git 本体故障（code 127 = spawn 失败）时三道判据全部静默判「干净」——
// 「必须能红」的检查自己哑火比没有检查更糟。任何一道 git 命令非零退出即整体失败。
const gitFails: string[] = [];
if (status.code !== 0) gitFails.push(`git status 退出码 ${status.code}`);
if (staged.code !== 0) gitFails.push(`git diff --cached 退出码 ${staged.code}`);
if (head.code !== 0) gitFails.push(`git log 退出码 ${head.code}`);
if (gitFails.length > 0) {
  console.error(`git 命令失败（${gitFails.join('；')}）—— 拒绝在 git 故障时报「干净」`);
  process.exit(1);
}

const lines = text.split(/\r?\n/);
// 行数按 `wc -l` 的语义数换行符：末字节是换行时 `split` 多出一个空尾元素，会把「96 行的报告」
// 报成 97 行 —— 这个数要能和 `wc -l` 对得上，否则复核的人先怀疑报告被改过。
const lineCount = text.endsWith('\n') ? lines.length - 1 : lines.length;
const sections = lines
  .map((l, i) => [i + 1, l] as const)
  .filter(([, l]) => l.startsWith('## '));

const fails: string[] = [];

if (status.stdout.trim() !== '') {
  fails.push(`工作区不干净：\n${status.stdout.replace(/^/gm, '    ')}`);
}

const stray = staged.stdout.split(/\r?\n/).filter((p) => FORBIDDEN_STAGED.some((f) => p.startsWith(f)));
if (stray.length > 0) {
  fails.push(`暂存区里有产物路径（应只在磁盘上）：\n    ${stray.join('\n    ')}`);
}

if (expectHead && !head.stdout.includes(expectHead)) {
  fails.push(`HEAD 不是期望的 ${expectHead}，实为：${head.stdout.trim()}`);
}

if (sections.length < MIN_SECTIONS) {
  fails.push(`报告没有任何 \`## \` 段 —— 视为未写，不算通过（共 ${lineCount} 行）`);
}
for (const want of requireSections) {
  if (!sections.some(([, l]) => l.includes(want))) fails.push(`报告缺少必需的段：${want}`);
}

console.log(`HEAD   ${head.stdout.trim()}`);
console.log(`报告   ${lineCount} 行 · ${sections.length} 段`);
for (const [n, l] of sections) console.log(`  ${n}:${l}`);

if (fails.length > 0) {
  console.error(`\n不通过 ${fails.length} 项：`);
  for (const f of fails) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('\n工作区干净 · 无产物入暂存 · 报告结构完整');
