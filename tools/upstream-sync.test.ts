// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
/**
 * 判据引擎的分类语义（docs/concepts/upstream-sync.md §判据的可执行形态）。
 * fixture 全走内存/临时目录：分类是唯一会被写坏的东西，它必须不依赖网络就能被逐条变异。
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildAnchorFromDir } from './build-anchor.js';
import { extractRoutes } from './extract-routes.js';
import { UPSTREAM_FILES, localPathFor } from './lib/upstream.js';
import { assess, classify, planAnchorWrite, type SyncDeps } from './upstream-sync.js';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const ROUTE_FILE = 'packages/core/src/webui/server.ts';
const MODEL_FILE = 'packages/webui/src/types.ts';

const dirs: string[] = [];
async function newDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'snowluma-sync-test-'));
  dirs.push(d);
  return d;
}
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

/** 把 47 份锚定文件铺满 dir；overrides 之外的都是无路由无模型的占位。 */
async function seed(dir: string, overrides: Record<string, string>): Promise<void> {
  for (const repoPath of UPSTREAM_FILES) {
    const local = localPathFor(repoPath, dir);
    await mkdir(dirname(local), { recursive: true });
    await writeFile(local, overrides[repoPath] ?? 'export {};');
  }
}

async function opsFrom(dir: string) {
  return extractRoutes(UPSTREAM_FILES.map((p) => ({ repoPath: p, localPath: localPathFor(p, dir) })));
}

/** 假 fetchAll：把 src 目录的字节原样搬进 dest——assess 的绿类全链路不碰网也走得通。 */
function fetcherFromDir(src: string): SyncDeps['fetchAll'] {
  return async (_candidate, dest) => {
    for (const repoPath of UPSTREAM_FILES) {
      const bytes = new Uint8Array(await readFile(localPathFor(repoPath, src)));
      const local = localPathFor(repoPath, dest);
      await mkdir(dirname(local), { recursive: true });
      await writeFile(local, bytes);
    }
    return [];
  };
}

async function fixture(seedSpec: Record<string, string>) {
  const dir = await newDir();
  await seed(dir, seedSpec);
  return { dir, anchor: await buildAnchorFromDir(SHA_A, dir) };
}

const SPEC_PATHS = { '/api/qq-list': { get: {} } };
const ROUTES_1 = 'const app = create();\napp.get(\'/api/qq-list\', h);\n';

describe('classify 的分类', () => {
  it('计数漂移点名"路由注册总数"，不落进 drift 层', async () => {
    const cur = await fixture({ [ROUTE_FILE]: ROUTES_1, [MODEL_FILE]: 'export interface A {}\n' });
    const dirB = await newDir();
    await seed(dirB, { [MODEL_FILE]: 'export interface A {}\n' }); // 路由没了：1→0
    const fresh = await buildAnchorFromDir(SHA_B, dirB);
    const v = classify(cur.anchor, SHA_B, fresh, await opsFrom(dirB), SPEC_PATHS);
    expect(v.kind).toBe('count-drift');
    if (v.kind === 'count-drift') expect(v.lines.join('\n')).toContain('路由注册总数');
  });

  it('总数不变但端点换名 → operation-set-drift（这条专杀计数相抵）', async () => {
    const cur = await fixture({ [ROUTE_FILE]: ROUTES_1 });
    const dirB = await newDir();
    await seed(dirB, { [ROUTE_FILE]: 'const app = create();\napp.get(\'/api/qq-other\', h);\n' });
    const fresh = await buildAnchorFromDir(SHA_B, dirB);
    const v = classify(cur.anchor, SHA_B, fresh, await opsFrom(dirB), SPEC_PATHS);
    expect(v.kind).toBe('operation-set-drift');
    if (v.kind === 'operation-set-drift') {
      expect(v.upstreamOnly.some((k) => k.includes('/api/qq-other'))).toBe(true);
      expect(v.specOnly.some((k) => k.includes('/api/qq-list'))).toBe(true);
    }
  });

  it('仅哈希变、计数与集合全稳 → green-advance，changedFiles 点名', async () => {
    const cur = await fixture({ [ROUTE_FILE]: ROUTES_1, [MODEL_FILE]: 'export interface A {}\n' });
    const dirB = await newDir();
    await seed(dirB, { [ROUTE_FILE]: ROUTES_1 + '// 注释变化\n', [MODEL_FILE]: 'export interface A {}\n' });
    const fresh = await buildAnchorFromDir(SHA_B, dirB);
    const v = classify(cur.anchor, SHA_B, fresh, await opsFrom(dirB), SPEC_PATHS);
    expect(v.kind).toBe('green-advance');
    if (v.kind === 'green-advance') expect(v.changedFiles).toEqual([ROUTE_FILE]);
  });

  it('字节完全相同也判 green（commit 标签推进是合法零判断）', async () => {
    const cur = await fixture({ [ROUTE_FILE]: ROUTES_1 });
    const v = classify(cur.anchor, SHA_B, cur.anchor, await opsFrom(cur.dir), SPEC_PATHS);
    expect(v.kind).toBe('green-advance');
    if (v.kind === 'green-advance') expect(v.changedFiles).toEqual([]);
  });
});

describe('assess 与锚点写入', () => {
  it('path-broken：404 全部收集并排序，不提前终止', async () => {
    const cur = await fixture({ [ROUTE_FILE]: ROUTES_1 });
    const deps: SyncDeps = {
      fetchAll: async () => [
        { repoPath: 'packages/webui/src/types.ts', status: 404 },
        { repoPath: 'packages/onebot/src/types.ts', status: 404 },
      ],
    };
    const v = await assess(cur.anchor, SHA_B, await newDir(), deps, SPEC_PATHS);
    expect(v.kind).toBe('path-broken');
    if (v.kind === 'path-broken')
      expect(v.missing.map((m) => m.repoPath)).toEqual([
        'packages/onebot/src/types.ts',
        'packages/webui/src/types.ts',
      ]);
  });

  it('green 从 fetchAll 全链路走通（真 buildAnchor/extractRoutes + 假 I/O）', async () => {
    const src = await newDir();
    await seed(src, { [ROUTE_FILE]: ROUTES_1 });
    const cur = await buildAnchorFromDir(SHA_A, src);
    const v = await assess(cur, SHA_B, await newDir(), { fetchAll: fetcherFromDir(src) }, SPEC_PATHS);
    expect(v.kind).toBe('green-advance');
  });

  it('planAnchorWrite 只对 green 放行，其余一律 null', () => {
    const fake = {
      upstreamRepo: '', commit: SHA_A, fetchedAt: '', files: [],
      expectedRouteRegistrations: 0, expectedApiOperations: 0, expectedModels: {},
    };
    expect(planAnchorWrite({ kind: 'no-change', candidate: SHA_A })).toBeNull();
    expect(planAnchorWrite({ kind: 'green-advance', candidate: SHA_B, anchor: fake, changedFiles: [] })).toBe(fake);
    expect(planAnchorWrite({ kind: 'count-drift', candidate: SHA_B, lines: ['x'] })).toBeNull();
    expect(planAnchorWrite({ kind: 'path-broken', candidate: SHA_B, missing: [] })).toBeNull();
    expect(planAnchorWrite({
      kind: 'operation-set-drift', candidate: SHA_B, upstreamOnly: [], specOnly: [], unclassified: [],
    })).toBeNull();
  });
});
