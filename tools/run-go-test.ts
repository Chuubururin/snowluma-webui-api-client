// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
/**
 * 门禁 `test:go-adapter` 的启动器（`npm run test:go-adapter`）。
 *
 * 为什么需要一个小启动器而不是把 `cd adapters/go && go test ./...` 写进 package.json：
 * Go 工具链按 tools.lock.json 的 goInstall（notPersisted）不写系统 PATH —— 裸 `go` 在
 * 新终端里就是 ENOENT。本启动器只把 tools.lock.json 记录的 <GOROOT>/bin 前置进子进程
 * PATH，然后执行字面量 `go`；两边都落空就带指引退出 1，不静默 skip —— skip 不是通过。
 */
import { spawnSync } from 'node:child_process';
import { join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gorootBinFromLock } from './lib/go-toolchain.js';

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const goDir = join(repoRoot, 'adapters', 'go');

/** 执行 go test，返回退出码。 */
function runGoTest(extraPath?: string): number {
  const env = { ...process.env, GOTOOLCHAIN: 'local' };
  if (extraPath) env.PATH = `${extraPath}${delimiter}${env.PATH ?? ''}`;
  const res = spawnSync('go', ['test', './...'], { cwd: goDir, env, stdio: 'inherit' });
  return res.status ?? 1;
}

// 执行的命令固定是 `go`；这里只做"能不能找到它"的探测，路径本身不进命令行。
const probe = spawnSync('go', ['version'], { encoding: 'utf8' });
if (probe.status !== 0) {
  // PATH 里没有 go → 按 tools.lock.json → goInstall.env.GOROOT 借它的 bin。
  // 定位逻辑在 tools/lib/go-toolchain.ts（出口闸 smoke:clients 用同一份，两边不许分叉）。
  const gorootBin = gorootBinFromLock(repoRoot);
  if (!gorootBin) {
    console.error('go 起不来（ENOENT）—— PATH 与 tools.lock.json 记录的 GOROOT 里都没有 go。');
    console.error('  按 tools.lock.json → goInstall 装好工具链，或把 <GOROOT>/bin 加进 PATH 后重跑。');
    process.exit(1);
  }
  console.error(`go 不在 PATH，改用 tools.lock.json 记录的 ${gorootBin}`);
  process.exit(runGoTest(gorootBin));
}
process.exit(runGoTest());
