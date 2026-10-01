// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
/**
 * 用 `.venv-gen` 的解释器跑一条 Python 腿（`npm run probe:py-import` 的实现）。
 *
 * 为什么要占位脚本而不是在 package.json 里直接写路径：那条 npm 脚本此前是
 * `.venv-gen\Scripts\python.exe tools/gen/probe-import.py` —— 反斜杠 + `.exe` 是 Windows 专属，
 * POSIX runner 上这条腿根本不存在。路径的解释器目录名已由 `tools/gen/run.ts` 的 `VENV_BIN_DIR`
 * 按平台给出，这里复用它，不再另写一份。
 *
 * 找不到 venv 时**带指引退 1**，绝不静默跳过：静默 skip 会把"这条腿没跑"写成"这条腿过了"。
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isCliEntry } from './lib/cli.js';
import { venvPython } from './bootstrap-venv.js';

const py = venvPython();

if (isCliEntry(import.meta.url, process.argv[1])) {
  if (!existsSync(py)) {
    console.error(`${py} 不存在 —— 生成腿的 venv 还没引导。`);
    console.error('  恢复动作：npm run venv:bootstrap（版本按 tools.lock.json 钉，不要手工装别的版本）');
    console.error('  本脚本不静默跳过：跳过不是通过。');
    process.exit(1);
  }
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('用法：npm run probe:py-import（或 tsx tools/py-venv-run.ts <脚本.py> [参数…]）');
    process.exit(2);
  }
  const r = spawnSync(py, args, { stdio: 'inherit' });
  if (r.error) {
    console.error(`${py} 起不来：${r.error.message}`);
    process.exit(1);
  }
  process.exit(r.status ?? 1);
}
