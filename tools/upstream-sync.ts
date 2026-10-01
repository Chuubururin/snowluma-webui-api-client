// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
/**
 * 上游衔接判据引擎：给定候选 SHA，回答「锚点能不能零判断地推进」。
 * 判定与 I/O 分离（classify 纯、assess 注依赖）不是洁癖：分类语义是这条流水线
 * 唯一会被写坏的东西，它必须能在 fixture 上被逐条变异检验；而 fetch/GitHub API
 * 故障一律走异常出 exit 2 —— 设施坏了冒充判定，是工单最坏的假阳性来源。
 * 消费方：.github/workflows/upstream-sync.yml（薄编排）与本机 `npm run upstream:sync`。
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { setDefaultResultOrder } from 'node:dns';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse } from 'yaml';
import { isCliEntry } from './lib/cli.js';
import { buildAnchorFromDir, COMMIT_SHA } from './build-anchor.js';
import { ANCHOR_COMMIT_REMEDIATION, computeDrift, countExpectations } from './check-drift.js';
import { extractRoutes, type RouteOp } from './extract-routes.js';
import { UPSTREAM_FILES, UPSTREAM_REPO, localPathFor, type Anchor } from './lib/upstream.js';

export type MissingFile = { repoPath: string; status: number };

export type SyncVerdict =
  | { kind: 'no-change'; candidate: string }
  | { kind: 'path-broken'; candidate: string; missing: MissingFile[] }
  | { kind: 'count-drift'; candidate: string; lines: string[] }
  | {
      kind: 'operation-set-drift';
      candidate: string;
      upstreamOnly: string[];
      specOnly: string[];
      unclassified: string[];
    }
  | { kind: 'green-advance'; candidate: string; anchor: Anchor; changedFiles: string[] };

export interface SyncDeps {
  /** 把 candidate 的锚定文件写进 dest。404 收集返回（不提前终止——工单要一次看全）；
   *  非 200 非 404 抛异常 = 设施故障。 */
  fetchAll: (candidate: string, dest: string) => Promise<MissingFile[]>;
}

/**
 * 三层比较的顺序即判据（spec §判据）：先计数、再端点集合、最后才承认"仅哈希变"。
 * 计数在前是因为它便宜且诊断更准（点名是哪个 label 动了）；集合层专杀
 * "删一端点加一端点、总数恰好相抵"——只有键集合比对咬得动这一形。
 */
export function classify(
  current: Anchor,
  candidate: string,
  fresh: Anchor,
  freshOps: RouteOp[],
  specPaths: Record<string, unknown>,
): SyncVerdict {
  const countLines = countExpectations(current, fresh);
  if (countLines.length > 0) return { kind: 'count-drift', candidate, lines: countLines };
  const drift = computeDrift(freshOps, specPaths);
  if (drift.upstreamOnly.length + drift.specOnly.length + drift.unclassified.length > 0) {
    return {
      kind: 'operation-set-drift',
      candidate,
      upstreamOnly: drift.upstreamOnly,
      specOnly: drift.specOnly,
      unclassified: drift.unclassified,
    };
  }
  const byPath = new Map(current.files.map((f) => [f.repoPath, f.sha256]));
  const changedFiles = fresh.files
    .filter((f) => byPath.get(f.repoPath) !== f.sha256)
    .map((f) => f.repoPath)
    .sort();
  return { kind: 'green-advance', candidate, anchor: fresh, changedFiles };
}

export async function assess(
  current: Anchor,
  candidate: string,
  dir: string,
  deps: SyncDeps,
  specPaths: Record<string, unknown>,
): Promise<SyncVerdict> {
  const missing = await deps.fetchAll(candidate, dir);
  if (missing.length > 0) {
    return {
      kind: 'path-broken',
      candidate,
      missing: missing.sort((a, b) => a.repoPath.localeCompare(b.repoPath)),
    };
  }
  const fresh = await buildAnchorFromDir(candidate, dir);
  const ops = await extractRoutes(
    UPSTREAM_FILES.map((repoPath) => ({ repoPath, localPath: localPathFor(repoPath, dir) })),
  );
  return classify(current, candidate, fresh, ops, specPaths);
}

/** 锚点写入的唯一放行条件。CLI 与测试共用，不放行清单写在调用方。 */
export function planAnchorWrite(verdict: SyncVerdict): Anchor | null {
  return verdict.kind === 'green-advance' ? verdict.anchor : null;
}

// —— CLI ————————————————————————————————————————————————————————————

export const httpFetcher: SyncDeps['fetchAll'] = async (candidate, dest) => {
  const token = process.env['GITHUB_TOKEN'];
  const headers: Record<string, string> = { 'user-agent': 'snowluma-upstream-sync' };
  if (token) headers.authorization = `Bearer ${token}`; // 只从 env 进，绝不从命令行进
  const missing: MissingFile[] = [];
  for (const repoPath of UPSTREAM_FILES) {
    const url = `https://raw.githubusercontent.com/${UPSTREAM_REPO}/${candidate}/${repoPath}`;
    const res = await fetch(url, { headers });
    if (res.status === 404) {
      missing.push({ repoPath, status: 404 });
      continue;
    }
    if (!res.ok) throw new Error(`设施故障 ${res.status} ${url}`);
    const body = new Uint8Array(await res.arrayBuffer());
    const local = localPathFor(repoPath, dest);
    await mkdir(dirname(local), { recursive: true });
    await writeFile(local, body);
  }
  return missing;
};

export async function probeHeadSha(): Promise<string> {
  const token = process.env['GITHUB_TOKEN'];
  const headers: Record<string, string> = {
    'user-agent': 'snowluma-upstream-sync',
    accept: 'application/vnd.github+json',
  };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`https://api.github.com/repos/${UPSTREAM_REPO}/commits/main`, { headers });
  if (!res.ok) throw new Error(`探测上游 HEAD 失败 ${res.status}`);
  const sha = String(((await res.json()) as { sha?: unknown }).sha ?? '');
  if (!COMMIT_SHA.test(sha)) throw new Error(`上游 HEAD 不是 40 位 SHA：${JSON.stringify(sha)}`);
  return sha;
}

if (isCliEntry(import.meta.url, process.argv[1])) {
  // 与 fetch-upstream.ts 同源教训：本机 ECONNRESET 的根因是 IPv6 解析。
  setDefaultResultOrder('ipv4first');
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const jsonOut = flag('json');
  const commitAnchor = argv.includes('--commit-anchor');
  let verdict: SyncVerdict;
  let dir: string | null = null;
  try {
    const candidate = flag('candidate') ?? (await probeHeadSha());
    if (!COMMIT_SHA.test(candidate)) {
      console.error(
        `候选 SHA 不是 40 位小写十六进制：${JSON.stringify(candidate)}。` +
          '分支名/短 SHA 拒绝——与锚点写侧（build-anchor.ts parseCommitArg）同一契约。',
      );
      process.exit(2);
    }
    const current = JSON.parse(await readFile('spec/anchor.json', 'utf8')) as Anchor;
    if (!COMMIT_SHA.test(current.commit)) {
      console.error(ANCHOR_COMMIT_REMEDIATION);
      process.exit(1);
    }
    if (candidate === current.commit) {
      verdict = { kind: 'no-change', candidate };
    } else {
      dir = await mkdtemp(join(tmpdir(), 'snowluma-sync-'));
      const specDoc = parse(await readFile('spec/openapi.yaml', 'utf8')) as {
        paths?: Record<string, unknown>;
      };
      verdict = await assess(current, candidate, dir, { fetchAll: httpFetcher }, specDoc.paths ?? {});
      if (commitAnchor) {
        const anchor = planAnchorWrite(verdict);
        if (anchor === null) {
          console.error(`拒绝写锚点：判定是 ${verdict.kind} 而非 green-advance。红类走工单，锚点不动。`);
          process.exit(2);
        }
        await writeFile('spec/anchor.json', JSON.stringify(anchor, null, 2) + '\n');
      }
    }
  } catch (e) {
    // 设施故障单独一级退出码：workflow 据此"红 job 但不建 PR/issue"。
    console.error(`设施故障（不算分类，不许转成工单或 PR）：${(e as Error).message}`);
    if (dir) await rm(dir, { recursive: true, force: true });
    process.exit(2);
  }
  if (dir) await rm(dir, { recursive: true, force: true });
  const body = JSON.stringify(verdict, null, 2);
  if (jsonOut) await writeFile(jsonOut, body + '\n');
  console.log(body);
  console.log(`VERDICT_KIND=${verdict.kind}`);
  process.exit(0);
}
