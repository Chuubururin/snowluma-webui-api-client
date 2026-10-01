// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
/**
 * L4 的唯一入口（`npm run test:fixture`）。
 *
 * 为什么要一个小启动器而不是把 `SNOWLUMA_FIXTURE=1 vitest …` 写进 package.json：
 * npm 在 Windows 上用 cmd.exe 跑脚本，`FOO=1 cmd` 那种 POSIX 前缀当场就炸；本仓不引
 * cross-env（无新增依赖是设计口径的约束），所以在这里显式注入再拉起 vitest。
 * 只注入这一个变量：夹具会继承操作者环境里的其余部分
 * （除了 `tools/fixture.ts` 主动删掉的那两个会把门禁写成 false 的变量）。
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const vitestEntry = join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs');

const res = spawnSync(process.execPath, [vitestEntry, 'run', 'tools/demo-fixture.test.ts'], {
  cwd: repoRoot,
  env: { ...process.env, SNOWLUMA_FIXTURE: '1' },
  stdio: 'inherit',
});
process.exit(res.status ?? 1);
