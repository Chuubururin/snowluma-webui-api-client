// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
/**
 * Python 适配器测试腿的运行器：跑哪些文件由**目录本身**决定，不由 package.json 里手抄的文件名决定。
 *
 * 原形状是 `python a.py && python b.py && python c.py`。它的失效方式不是报错，而是沉默：
 * 第 4 个 `test_*.py` 落进目录后，这条链永远不跑它 —— 三语同形的判据少一条腿，而没有任何一面会红。
 * 这正是本仓反复抓的那类"声明了但不生效"。
 *
 * 用 stdlib 的 `unittest discover`（这些文件都是 `unittest.main()` 脚本）：不引入 pytest 这条新依赖，
 * 保持与原命令相同的解释器解析（`python`），且新增文件自动进腿。
 */
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { isCliEntry } from './lib/cli.js';

const PY_DIR = 'adapters/python';

/** 目录里现出的测试文件（这条清单只用于"发现了几个"的判据与打印，不作为运行参数）。 */
export function pyTestFiles(dir = PY_DIR): string[] {
  return readdirSync(dir)
    .filter((f) => /^test_.*\.py$/.test(f))
    .sort();
}

export function runPyTests(dir = PY_DIR): number {
  const files = pyTestFiles(dir);
  // 一个都没发现 = 设施故障，不是"通过"：目录改名或被清空会让这条腿永久静默绿。
  if (files.length === 0) {
    process.stdout.write(
      `✗ test:py-adapter 在 ${dir} 里没发现任何 test_*.py —— 这条腿没跑，不算通过。\n` +
        `  恢复动作：确认 ${dir} 仍在，且测试文件名以 test_ 开头。\n`,
    );
    return 1;
  }
  const r = spawnSync('python', ['-m', 'unittest', 'discover', '-s', dir, '-p', 'test_*.py'], { encoding: 'utf8' });
  const out = [r.stdout, r.stderr].filter(Boolean).join('\n');
  process.stdout.write(`${out.endsWith('\n') ? out : `${out}\n`}\n发现面：${dir} 下 ${files.length} 个测试文件（由目录决定，不是手抄）\n`);
  if (r.error) {
    process.stdout.write(`✗ 解释器起不来（${r.error.message}）。原命令用的也是 PATH 里的 python；装不上就按 docs/getting-started/installation.md 配解释器。\n`);
    return 1;
  }
  return r.status ?? 1;
}

if (isCliEntry(import.meta.url, process.argv[1])) {
  process.exit(runPyTests());
}
