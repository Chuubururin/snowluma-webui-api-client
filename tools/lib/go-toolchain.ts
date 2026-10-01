// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
/**
 * Go 工具链定位的单一出处。
 *
 * 为什么要有这个文件：Go 按 tools.lock.json → goInstall（notPersisted）**不写系统 PATH**，
 * 于是每个需要 go 的入口都得会"PATH 里没有就去锁记的 GOROOT 借"。这段逻辑此前只住在
 * `tools/run-go-test.ts` 里；出口闸 `tools/smoke-clients.ts` 也需要它，再抄一遍就是两份认知，
 * 而分叉的后果是"同一条链上 go 腿一条能跑、另一条喊缺工具"——这恰好是最容易被当成
 * 环境问题放过去的那类红。
 *
 * 两类落点要分开：`go` 本身在锁记的 GOROOT/bin，`go install` 出来的命令（oapi-codegen）
 * 在 <GOPATH>/bin。冷克隆实测过：只补前者时 `npm run generate` 的 Go 腿照样 ENOENT。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

export const goExeName = () => (process.platform === 'win32' ? 'go.exe' : 'go');

const PATH_DELIM = process.platform === 'win32' ? ';' : ':';

/**
 * Windows 的 process.env 里实际键名通常是 `Path`。硬塞一个大写 `PATH` 会得到两份
 * 大小写不同的副本，谁覆盖谁取决于运行时 —— 所以先按大小写无关地把原键名找出来。
 */
function pathKey(env: NodeJS.ProcessEnv): string {
  return Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
}

/** 锁里记的 <GOROOT>/bin；不存在或锁没记就 null（不猜路径）。 */
export function gorootBinFromLock(root: string = REPO_ROOT): string | null {
  let lock: { goInstall?: { env?: { GOROOT?: string } } };
  try {
    lock = JSON.parse(readFileSync(join(root, 'tools.lock.json'), 'utf8'));
  } catch {
    return null;
  }
  const goroot = lock.goInstall?.env?.GOROOT;
  if (!goroot) return null;
  const bin = join(goroot, 'bin');
  return existsSync(join(bin, goExeName())) ? bin : null;
}

/**
 * `go install` 出来的命令落 <GOPATH>/bin —— 本仓的 oapi-codegen 就在那里，
 * 而它**不在** GOROOT/bin 下，所以只补 GOROOT 的兜底对 generate 的 Go 腿不够。
 * 目录不存在返回 null：没装就是没装，提示里要说"去装"，不是"PATH 里没有"。
 */
export function gobinDir(env: NodeJS.ProcessEnv = process.env): string | null {
  const rootBin = gorootBinFromLock();
  const go = rootBin ? join(rootBin, goExeName()) : goExeName();
  const r = spawnSync(go, ['env', 'GOPATH'], { encoding: 'utf8', env });
  const fromGo = r.status === 0 ? r.stdout.trim() : '';
  const root = fromGo || env.GOPATH || join(homedir(), 'go');
  const dir = join(root, 'bin');
  return existsSync(dir) ? dir : null;
}

/** generate 的 Go 腿需要两条：GOROOT/bin 里有 go，<GOPATH>/bin 里有 oapi-codegen。 */
export function goToolchainDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  return [gorootBinFromLock(), gobinDir(env)].filter((d): d is string => d !== null);
}

/** 把 GOROOT/bin 前置进一份 env 副本；原 env 不改。 */
export function envWithGo(env: NodeJS.ProcessEnv = process.env): { env: NodeJS.ProcessEnv; borrowed: string | null } {
  const bin = gorootBinFromLock();
  if (!bin) return { env, borrowed: null };
  const key = pathKey(env);
  return { env: { ...env, [key]: [bin, env[key] ?? ''].filter(Boolean).join(PATH_DELIM) }, borrowed: bin };
}
