// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
/**
 * 门禁 `test:go-adapter` 的启动器（`npm run test:go-adapter`）。
 *
 * 为什么需要一个小启动器而不是把 `cd adapters/go && go test ./...` 写进 package.json：
 * Go 工具链按 tools.lock.json 的 goInstall（notPersisted）不写系统 PATH —— 裸 `go` 在
 * 新终端里就是 ENOENT。定位与前置都由 tools/lib/go-toolchain.ts 给出（出口闸 smoke:clients
 * 用同一份，两边不许分叉）；本文件只留"借不到就带指引退 1，绝不静默 skip —— skip 不是通过"。
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { envWithGo } from './lib/go-toolchain.js';

const goDir = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'adapters', 'go');

const { env, borrowed } = envWithGo({ ...process.env, GOTOOLCHAIN: 'local' });
if (borrowed) console.log(`按 tools.lock.json 前置 Go 工具链目录：${borrowed}`);

// 执行的命令固定是字面量 `go`：借来的目录只进 env，不进命令行（拼路径进 argv 是注入面）。
const res = spawnSync('go', ['test', './...'], { cwd: goDir, env, stdio: 'inherit' });
if (res.error) {
  console.error(
    `go 起不来（${(res.error as NodeJS.ErrnoException).code ?? 'UNKNOWN'}）—— PATH 与 tools.lock.json 记录的 GOROOT 里都没有它。\n` +
      '  恢复动作：按 docs/getting-started/installation.md 第 3 步装 Go 工具链（版本取自 tools.lock.json）。',
  );
  process.exit(1);
}
process.exit(res.status ?? 1);
