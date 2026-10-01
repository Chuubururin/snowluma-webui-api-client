// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
/**
 * 按 spec/anchor.json 记录的 40 位 SHA 重拉 vendor/upstream/ 缓存。
 *
 * 这就是 tools.lock.json → prerequisites.fetchCommand 记载的恢复路径，从
 * 一次性 shell 字符串升格成脚本的理由：CI（.github/workflows/verify.yml）同一条命令
 * 要在 pwsh 里带重试跑，env 前缀 + tsx -e 的 cjs 求值坑（lock 的 notes 记过）不该在
 * 每个调用方重演一遍。fetchCommand 现在只指向这里。
 *
 * 重试上界 12、批级而非逐文件：fetchUpstream 对每个文件各发一次 fetch 且没有逐文件重试，
 * 任一条连接被重置就整批失败（lock 的 fetchCommandNotes，客户端批次实测）。
 * 本机 ECONNRESET 的根因是 IPv6 解析（同 notes）——CLI 里 setDefaultResultOrder('ipv4first')，
 * 不再要求调用方包 NODE_OPTIONS。
 *
 * 判据与 I/O 分居（fetch-upstream.test.ts 钉语义，本文件的 CLI 按仓库惯例不单测）：
 * 旧版是"import 即联网 + 在测试进程里 process.exit"，恢复路径本身从来没有一条用例。
 */
import { setDefaultResultOrder } from 'node:dns';
import { readFile } from 'node:fs/promises';
import { isCliEntry } from './lib/cli.js';
import { COMMIT_SHA } from './build-anchor.js';
import { ANCHOR_COMMIT_REMEDIATION } from './check-drift.js';
import { fetchUpstream, type CachedFile } from './lib/upstream.js';

export type { CachedFile };

export const MAX_ATTEMPTS = 12;
export const RETRY_BACKOFF_MS = 2000;

/**
 * 坏锚点不当 ref 用：把被写坏的 commit 传给 raw.githubusercontent.com 去"恢复"，
 * 恢复回来的任何东西都不值得被信任（check-drift 读侧执法的同一条理由）。
 */
export function parseAnchorCommit(raw: string): string {
  if (!COMMIT_SHA.test(raw)) {
    throw new Error(`anchor.commit 形状非法（收到 ${JSON.stringify(raw)}）。${ANCHOR_COMMIT_REMEDIATION}`);
  }
  return raw;
}

export const ALL_FAILED_GUIDANCE =
  '不得因此放宽 drift/ui-coverage 的锚定断言；按 lock → prerequisites.failureTriage 分流。';

export interface RetryFetchDeps {
  commit: string;
  fetch: (commit: string) => Promise<CachedFile[]>;
  sleep: (ms: number) => Promise<void>;
  maxAttempts?: number;
  onFailure?: (attempt: number, error: Error) => void;
}

export interface RetryFetchResult {
  files: CachedFile[];
  attempt: number;
}

/**
 * 批级重试的唯一出口语义：**要么带回非空文件集，要么抛错**。
 * 空批不算成功——"FETCHED 0 个文件"的 exit 0 会让下游三条读 vendor 的门禁
 * 在空目录上集体失明（同一形状的失效在 scanBanners、countExpectations 都登记过）。
 */
export async function retryFetch(d: RetryFetchDeps): Promise<RetryFetchResult> {
  const max = d.maxAttempts ?? MAX_ATTEMPTS;
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= max; attempt += 1) {
    try {
      const files = await d.fetch(d.commit);
      if (files.length === 0) {
        throw new Error('重拉返回 0 个文件：掏空的缓存面不算成功');
      }
      return { files, attempt };
    } catch (e) {
      lastError = e as Error;
      d.onFailure?.(attempt, lastError);
      if (attempt < max) await d.sleep(RETRY_BACKOFF_MS);
    }
  }
  throw new Error(
    `${max} 次重拉全部失败（第 ${max} 次仍在失败）—— 最后一条错误：${lastError?.message ?? '未知'}。` +
      ALL_FAILED_GUIDANCE,
  );
}

if (isCliEntry(import.meta.url, process.argv[1])) {
  setDefaultResultOrder('ipv4first');
  const anchor = JSON.parse(await readFile('spec/anchor.json', 'utf8')) as { commit: string };
  let commit: string;
  try {
    commit = parseAnchorCommit(anchor.commit);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
  try {
    const { files, attempt } = await retryFetch({
      commit,
      fetch: fetchUpstream,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      onFailure: (n, e) => console.error(`第 ${n}/${MAX_ATTEMPTS} 次重拉失败：${e.message}`),
    });
    console.log(`FETCHED ${commit}（第 ${attempt} 次尝试，${files.length} 个文件）`);
    for (const f of files) console.log(`  ${f.localPath} ${f.sha256.slice(0, 12)}`);
    process.exit(0);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
