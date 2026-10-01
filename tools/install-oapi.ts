// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
/**
 * `npm run oapi:install`：按 tools.lock.json 装 oapi-codegen。
 *
 * 为什么要脚本而不是在 workflow 里写一行 `go install …@v2.8.0`：三条 workflow 各自抄过这个
 * 版本号，步骤名却写着"版本钉 tools.lock.json" —— 派生面与真源分叉时，CI 用的生成器与锁记的
 * 不是同一个，而产物的许可横幅与模板都可能跟着换（AGENTS.md 的"真源在哪"表把 workflow 里的
 * `go install` 明列为不许手抄的派生面）。`venv:bootstrap` 是同一条处置的先例。
 *
 * 前置：PATH 或 tools.lock.json 的 GOROOT 里要有 go（本脚本按 envWithGo 借，借不到就带指引退 1）。
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { isCliEntry } from './lib/cli.js';
import { envWithGo } from './lib/go-toolchain.js';

const MODULE_PATH = 'github.com/oapi-codegen/oapi-codegen/v2/cmd/oapi-codegen';

/** 锁里没有这项就报错：凭记忆补版本号等于把工具链换成一份需要人肉同步的第二真相。 */
export function oapiPin(lockJson: string): string {
  const lock = JSON.parse(lockJson) as { generators?: Record<string, string> };
  const v = lock.generators?.['oapi-codegen'];
  if (!v) {
    throw new Error('tools.lock.json 里没有 generators["oapi-codegen"] —— 按锁补版本号，不要凭记忆填。');
  }
  return v;
}

if (isCliEntry(import.meta.url, process.argv[1])) {
  let pin: string;
  try {
    pin = oapiPin(readFileSync('tools.lock.json', 'utf8'));
  } catch (e) {
    console.error((e as Error).message);
    process.exit(2);
  }
  const { env, borrowed } = envWithGo({ ...process.env, GOTOOLCHAIN: 'local' });
  if (borrowed) console.log(`按 tools.lock.json 前置 Go 工具链目录：${borrowed}`);
  const r = spawnSync('go', ['install', `${MODULE_PATH}@${pin}`], { env, stdio: 'inherit' });
  if (r.error) {
    console.error(
      `go 起不来（${(r.error as NodeJS.ErrnoException).code ?? 'UNKNOWN'}）—— PATH 与锁记 GOROOT 里都没有它。\n` +
        '  恢复动作：按 docs/getting-started/installation.md 第 3 步装 Go 工具链。',
    );
    process.exit(1);
  }
  if (r.status !== 0) {
    console.error(`go install ${MODULE_PATH}@${pin} 退 ${r.status}（版本取自 tools.lock.json，不许就地改写）`);
    process.exit(1);
  }
  console.log(`oapi-codegen ${pin} 已装（版本取自 tools.lock.json）`);
  process.exit(0);
}
