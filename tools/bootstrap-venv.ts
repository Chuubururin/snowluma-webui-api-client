// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
/**
 * `npm run venv:bootstrap`：建 `.venv-gen` 并按 tools.lock.json 装钉版本的 Python 生成器。
 *
 * 为什么要脚本而不是在 workflow 里手写两行：此前 Windows 的两条 workflow 各自写死了
 * `.venv-gen\Scripts\python -m pip install "openapi-python-client==0.29.1"` ——
 * 一个反斜杠路径（POSIX 上不存在）加一个版本号（真源本该是 tools.lock.json）。
 * 三份抄本迟早分叉，而分叉的表现是"CI 用的生成器版本与锁里记的不是同一个"，
 * 那正是本仓最不愿意见到的那类静默不一致。
 *
 * 为什么必须走 venv 而不是系统 python：openapi-python-client 的 post_hook（补许可头）
 * 经 shell 执行，venv 的 Scripts/bin 不在子进程 PATH 上时 ruff 与 hook 会**静默跳过**、
 * exit 仍是 0，头部消失而生成"成功"。tools/gen/run.ts 负责执行时的 PATH 前置，
 * 本脚本负责把解释器和包准备好；两边都以 VENV_BIN_DIR 为唯一路径出处。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isCliEntry } from './lib/cli.js';
import { VENV_BIN_DIR } from './gen/run.js';

const VENV_DIR = '.venv-gen';
const PY_EXE = process.platform === 'win32' ? 'python.exe' : 'python';

/** venv 里的解释器路径；Windows 与 POSIX 只差一个目录名，由 VENV_BIN_DIR 单源给出。 */
export function venvPython(): string {
  return join(VENV_BIN_DIR, PY_EXE);
}

function fail(msg: string, hint: string): never {
  console.error(`${msg}\n  ${hint}`);
  process.exit(1);
}

/**
 * 系统解释器名。`python` 在 Linux（含 Ubuntu/Debian 默认装法）下常常不存在，只有 `python3`
 * —— 实测 WSL Ubuntu 就是这一形。CI 的 ubuntu runner 因为带 setup-python 才有 `python`。
 * 两个名字都试，都找不到就带指引退 1：不去猜第三个名字，也不静默退回到别的解释器。
 */
export function systemPython(): string | null {
  for (const candidate of ['python', 'python3']) {
    const r = spawnSync(candidate, ['-c', 'import sys; sys.stdout.write("ok")'], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.includes('ok')) return candidate;
  }
  return null;
}

export function pinnedVersion(): string {
  const lock = JSON.parse(readFileSync('tools.lock.json', 'utf8')) as {
    generators?: Record<string, string>;
  };
  const v = lock.generators?.['openapi-python-client'];
  // 锁里缺这项就报错拒跑：凭记忆补版本号是这类项目最容易悄悄换掉工具链的动作。
  if (!v) fail('tools.lock.json 里没有 generators["openapi-python-client"]', '按锁补版本号，不要凭记忆填。');
  return v;
}

if (isCliEntry(import.meta.url, process.argv[1])) {
  const version = pinnedVersion();

  if (!existsSync(VENV_BIN_DIR)) {
    const host = systemPython();
    if (!host) fail('找不到系统 python（python 与 python3 都试过）', '装一个 Python 3.12+，见 docs/getting-started/installation.md 前置表。');
    const mk = spawnSync(host, ['-m', 'venv', VENV_DIR], { stdio: 'inherit' });
    if (mk.status !== 0) fail(`${host} -m venv ${VENV_DIR} 退 ${mk.status}`, '系统 python 缺 venv 模块（Debian/Ubuntu 需 python3-venv 包）。');
  }
  const py = venvPython();
  if (!existsSync(py)) fail(`${py} 不存在`, `${VENV_DIR} 建坏了一半：删掉该目录后重跑 npm run venv:bootstrap。`);

  const pip = spawnSync(py, ['-m', 'pip', 'install', `openapi-python-client==${version}`], { stdio: 'inherit' });
  if (pip.status !== 0) fail(`pip install openapi-python-client==${version} 退 ${pip.status}`, '网络或镜像源问题；不要改用系统 python 绕过 venv。');
  console.log(`${VENV_DIR} 就绪：openapi-python-client==${version}（版本来自 tools.lock.json）`);
  process.exit(0);
}
