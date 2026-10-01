// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
/**
 * Go 工具链定位的单一出处。
 *
 * 为什么要有这个文件：Go 按 tools.lock.json → goInstall（notPersisted）**不写系统 PATH**，
 * 于是每个需要 go 的入口都得会"PATH 里没有就去锁记的 GOROOT 借"。这段逻辑此前只住在
 * `tools/run-go-test.ts` 里；出口闸 `tools/smoke-clients.ts` 也需要它，再抄一遍就是两份认知，
 * 而分叉的后果是"同一条链上 go 腿一条能跑、另一条喊缺工具"——这恰好是最容易被当成
 * 环境问题放过去的那类红。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

export const goExeName = () => (process.platform === 'win32' ? 'go.exe' : 'go');

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

/** 把 GOROOT/bin 前置进一份 env 副本；原 env 不改。 */
export function envWithGo(env: NodeJS.ProcessEnv = process.env): { env: NodeJS.ProcessEnv; borrowed: string | null } {
  const bin = gorootBinFromLock();
  if (!bin) return { env, borrowed: null };
  const probe = join(bin, goExeName());
  if (!existsSync(probe)) return { env, borrowed: null };
  const delimiter = process.platform === 'win32' ? ';' : ':';
  return { env: { ...env, PATH: `${bin}${delimiter}${env.PATH ?? ''}` }, borrowed: bin };
}
