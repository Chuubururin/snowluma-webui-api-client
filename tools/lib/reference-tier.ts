// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
/**
 * 参照系定级：`demo/parity.ts` 与 `demo/declinations.ts` 的 `webuiSource` 能不能在**本仓**被机器验证。
 *
 * - Tier A —— 引用落在 `UPSTREAM_FILES` 锚定面内，vendor/upstream 有 pinned 副本，
 *   于是"文件存在 + 该行 ±window 内出现所声称的符号"是可执行断言；SHA 不变则行号必然有效，
 *   SHA 一变即 anchorStale 红，强制人工重导（与 spec 里行号引用同一套保护）。
 * - Tier B —— 只能读仓外工作树。这类引用**只许作说明性出处，不得作豁免依据**：
 *   "这文件在缓存外"曾被当过放宽的许可证，那是本仓最省力也最贵的一类缺陷。
 *
 * 判定过程（实测，非推测）：本机 `snowluma-live` 工作树与锚定 commit
 * `1ef9a2c3…` 对 parity 将要引用的 16 份前端组件逐份比 sha256，**16/16 全等**，
 * 故这批文件已并入 `UPSTREAM_FILES`（31 → 47），引用整体升级为 Tier A。
 * 升级的连带账：anchor.files 31 → 47；expectedRouteRegistrations 与 expectedModels **不变**
 *（对 16 份干跑 extractRoutesFromSource 命中 0，且 .tsx 不过 isModelSource 谓词），
 * 所以两处写死的计数各自 +16 而不是重算——写死正是为了让"新增文件"这件事必须被人看见。
 */
import { access, readFile } from 'node:fs/promises';
import { UPSTREAM_FILES, VENDOR_DIR, localPathFor } from './upstream.js';

const ANCHORED = new Set<string>(UPSTREAM_FILES);
export type ReferenceTier = 'anchored' | 'unanchored';

/** 引用面的执法强度。判 'A' 的前提是前端组件已进 UPSTREAM_FILES 且 vendor 里有 pinned 副本。 */
export const REFERENCE_TIER: 'A' | 'B' = 'A';

export async function resolveUpstreamFile(
  repoPath: string,
): Promise<{ absPath: string; tier: ReferenceTier } | null> {
  if (!ANCHORED.has(repoPath)) return null;
  // 路径换算单源：这里与 vendoring 用同一个 localPathFor，两份布局认知不可能分叉
  const absPath = localPathFor(repoPath, VENDOR_DIR);
  try {
    await access(absPath);
  } catch {
    return null;
  }
  return { absPath, tier: 'anchored' };
}

/** 行号引用是否真的指向那个符号。窗口默认 ±5 行：本仓对"行号"的容忍上限，放宽它等于不检查。 */
export async function symbolNearLine(absPath: string, line: number, symbol: string, window = 5): Promise<boolean> {
  const lines = (await readFile(absPath, 'utf8')).split(/\r?\n/);
  const from = Math.max(0, line - 1 - window);
  const to = Math.min(lines.length, line + window);
  return lines.slice(from, to).some((l) => l.includes(symbol));
}
