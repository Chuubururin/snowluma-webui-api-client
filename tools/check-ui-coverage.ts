// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
/**
 * UI 覆盖门（设计口径）：证明 demo 是「客户端」而不是「API 调用台」，并且把这句话拆成七条能各自变红的断言。
 *
 *  1. **归属**：spec 里每条 operationId 必须落进 `effective / write-only / not-surfaced` 恰好一个区，
 *     漏者与重复审者都是红（漏 = 没登记，重 = 两份清单在说反话）。
 *  2. **出处分层**：Tier A（锚定面内）的出处解不到文件即红；Tier B 只在"某条覆盖只由它支撑"时即红 ——
 *     未锚定的引用可以作说明，不可以作豁免。
 *  3. **控件名单不许发明**：每个控件名要么在 spec 词汇表里（属性名 / schema 名 / enum 值），
 *     要么真的出现在 demo 自己的代码（剥掉注释）里。两个都不是 = 名单上多了一个不存在的东西。
 *  4. **合并语义说到做到**：声明 `merge:'full'` 的边，承载代码里必须有整份合并；代码做了整份合并，
 *     承载它的边必须声明出来。
 *  5. **流行为要有单测**：effective 的四条流操作，各自的浏览器面 topic 记号必须能在测试语料里找到。
 *  6. **不许手写上游路径 / 禁用端点不许回归 / 只服务 harness 的操作不算控件 / 客户端从不请求的路由不算覆盖**。
 *  7. **`unwrap` 是全仓唯一的 4xx 折叠点**：非流 SDK 调用漏包 = 把那处 4xx 静默成 `{data: undefined}`；
 *     流操作反向执法 —— 它们的 200 是 `{stream}` 形态，经 unwrap 就是误抛。
 *
 * 判据层（`violationsV2`）与扫描层（`detect*` / `classifyOps`）分开：前者只吃一份报告，后者只吃注入的
 * 文本与表。这样每条断言都能在合成数据上被单独弄红，不必为了让测试变红去动真实仓库。
 */
import { readFile, readdir } from 'node:fs/promises';
import { transformSync } from 'esbuild';
import { parse } from 'yaml';
import { isCliEntry } from './lib/cli.js';
import { resolveUpstreamFile } from './lib/reference-tier.js';
import { UPSTREAM_FILES } from './lib/upstream.js';
import { PARITY, type ParityEdge } from '../demo/parity.js';
import { DECLINATIONS, type Declination } from '../demo/declinations.js';
import { SSE_OPERATIONS } from '../demo/vocabulary.gen.js';

const SPEC_PATH = 'spec/openapi.yaml';
const ROUTES_DIR = 'demo/server/routes';
const METHODS = ['get', 'post', 'put', 'delete', 'patch'] as const;

/** 只服务 `npm run verify:all` 的 sweep 端点：出现即说明有操作只剩 harness 覆盖。 */
const HARNESS_ROUTES = ['run-all', 'sse-sample', 'upgrade-edges'];

/** 已被「结构化表单 + 合并补丁」取代的原始直通端点，名字回归即判红。 */
const FORBIDDEN_ROUTES = [
  'api-panorama',
  'api-call',
  'ui-save',
  'system-settings-save',
  'storage-settings-save',
  'onebot-config-save',
  'notifications-config-save',
  'export-backup',
];

// 从词表读，不再手抄（解耦计划 C10）：上游加一条 SSE 端点时，这里不该需要有人记得改。
// 改前已逐字比对：手抄 4 条与词表 SSE_OPERATIONS 完全一致（streamDebugAction, streamDebugEvents,
// streamLogs, streamState），所以这一替换不改变任何判定，只是把"对"的来源换成机器而不是人。
const STREAM_OPS = SSE_OPERATIONS;

/**
 * 四条流的 op → 承载路由。为什么只能是显式表：这些调用不在任何路由块里，而在 `OPENERS` 这张
 * 数据表里（`streams.ts`），按"块内搜 `sdk.X(`"去认会把四条流全判成没人承载。
 * 表会腐，所以另有一条断言钉它：这里的每个路由键都必须真的存在于路由总表里。
 */
const EXPLICIT_ROUTE_OPS: Record<string, string[]> = {
  'GET /events': ['streamState', 'streamLogs', 'streamDebugEvents'],
  'POST /events/action': ['streamDebugAction'],
  'POST /process-action': ['loadProcess', 'unloadProcess', 'refreshProcess'],
};

/** 断言 5 的记号表：每条流面在测试语料里必须出现的最小串。导出供对账测试钉「词表↔记号表双向相等」。 */
export const STREAM_TEST_TOKEN: Record<string, string> = {
  streamState: '/events?topic=state',
  streamLogs: '/events?topic=logs',
  streamDebugEvents: '/events?topic=debug',
  streamDebugAction: '/events/action',
};

export interface CoverageReportV2 {
  totalOps: number;
  /** parity 里 `<路径>:<行>` 引用的总条数 / 其中落在锚定面（Tier A）的条数。 */
  sourcesTotal: number;
  sourcesAnchored: number;
  effective: string[];
  writeOnly: string[];
  notSurfaced: string[];
  unregistered: string[];
  unresolvableSources: string[];
  unknownControls: string[];
  mergeMismatches: string[];
  missingStreamTests: string[];
  forbiddenPathLiterals: string[];
  unwrappedSdkCalls: string[];
  forbiddenRoutes: string[];
  harnessOnly: string[];
  unreachableOps: string[];
}

/** 整份合并的可观测形状：显式的 `deepMerge(`，或同一条路由里"先读后写"（读回现网那一份再整份回传）。 */
const WHOLE_DOCUMENT_MERGE_MARK = 'deepMerge(';
const READ_METHODS = new Set(['get']);

// ────────────────────────────── 读入与切块 ──────────────────────────────

const strip = (text: string): string => transformSync(text, { loader: 'ts', target: 'es2022', format: 'esm' }).code;

async function* tsFiles(dir: string): AsyncGenerator<string> {
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    const p = dir + '/' + ent.name;
    if (ent.isDirectory()) yield* tsFiles(p);
    else if (p.endsWith('.ts') && !p.endsWith('.gen.ts')) yield p;
  }
}

const readTexts = async (dir: string): Promise<Record<string, string>> => {
  const out: Record<string, string> = {};
  for await (const f of tsFiles(dir)) out[f] = await readFile(f, 'utf8');
  return out;
};

function specOperationIds(spec: any): string[] {
  const ops: string[] = [];
  for (const item of Object.values(spec.paths ?? {})) {
    for (const [method, op] of Object.entries(item as Record<string, any>)) {
      if ((METHODS as readonly string[]).includes(method) && op?.operationId) ops.push(op.operationId);
    }
  }
  return ops;
}

/** operationId → HTTP method：判"这条路由是不是先读后写"要用。 */
function specOperationMethods(spec: any): Map<string, string> {
  const out = new Map<string, string>();
  for (const item of Object.values(spec.paths ?? {})) {
    for (const [method, op] of Object.entries(item as Record<string, any>)) {
      if ((METHODS as readonly string[]).includes(method) && op?.operationId) out.set(op.operationId, method);
    }
  }
  return out;
}

/** spec 词汇表：属性名 / schema 名 / enum 的字符串值。paths 必须一起走 —— 请求体 schema 多是内联的。 */
function specVocabulary(spec: any): Set<string> {
  const words = new Set<string>();
  for (const name of Object.keys(spec.components?.schemas ?? {})) words.add(name);
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const x of node) walk(x);
      return;
    }
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === 'properties' && v && typeof v === 'object') {
        for (const p of Object.keys(v as Record<string, unknown>)) words.add(p);
      }
      if (k === 'enum' && Array.isArray(v)) {
        for (const x of v as unknown[]) if (typeof x === 'string') words.add(x);
      }
      walk(v);
    }
  };
  walk(spec.components ?? {});
  walk(spec.paths ?? {});
  return words;
}

const ROUTE_KEY_RE = /^\s*'(GET|POST|PUT|DELETE|PATCH) (\/[a-z0-9/_-]+)':/gm;

/** 按路由键切块：从这一条键到下一条键之间（路由表的书写约定：键在行首）。 */
function routeBlocks(text: string): Map<string, string> {
  const marks: { key: string; at: number }[] = [];
  for (const m of text.matchAll(ROUTE_KEY_RE)) marks.push({ key: `${m[1]} ${m[2]}`, at: m.index });
  const out = new Map<string, string>();
  marks.forEach((mk, i) => {
    const block = text.slice(mk.at, i + 1 < marks.length ? marks[i + 1].at : text.length);
    out.set(mk.key, (out.get(mk.key) ?? '') + block);
  });
  return out;
}

/** 顶层函数体（列 0 的 `function NAME` 到列 0 的 `}`）：用来把"路由块调了辅助函数"那次转手接上。 */
function functionBodies(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of text.matchAll(/^(?:export )?(?:async )?function ([A-Za-z_]\w*)/gm)) {
    const start = m.index;
    const end = text.slice(start).search(/^\}/m);
    if (end > 0) out.set(m[1], text.slice(start, start + end + 1));
  }
  return out;
}

function opsIn(text: string, ops: readonly string[]): string[] {
  return ops.filter((o) => new RegExp('(^|[^A-Za-z0-9_$.])(sdk\\.)?' + o + '\\(').test(text));
}

/**
 * 块内直接调用 + 经同文件顶层函数转手的调用（递归到三层，够这一族的实际形状）。
 * `merged`：整份合并的显式标记（deepMerge），允许藏在被转手的辅助函数里。
 * `direct`：只看块内直接调用 —— "先读后写"要的是这条路由自己的形状，
 *   把转手进来的门禁重读（`stateResult → getAgreements`）也算进去会把登录误判成整份合并。
 */
function opsServedByBlock(
  block: string,
  bodies: Map<string, string>,
  ops: readonly string[],
): { ops: string[]; direct: string[]; merged: boolean } {
  const direct = opsIn(block, ops);
  const found = new Set<string>(direct);
  let merged = block.includes(WHOLE_DOCUMENT_MERGE_MARK);
  const pending: string[] = [block];
  for (let depth = 0; depth < 3 && pending.length; depth += 1) {
    const next: string[] = [];
    for (const chunk of pending) {
      for (const [name, body] of bodies) {
        if (!new RegExp('(^|[^A-Za-z0-9_$.])' + name + '\\(').test(chunk)) continue;
        for (const o of opsIn(body, ops)) found.add(o);
        if (body.includes(WHOLE_DOCUMENT_MERGE_MARK)) merged = true;
        next.push(body);
      }
    }
    pending.length = 0;
    pending.push(...next);
  }
  return { ops: [...found], direct, merged };
}

// ────────────────────────────── 判据层（纯函数，注入数据即可单独弄红） ──────────────────────────────

export interface Buckets {
  effective: string[];
  writeOnly: string[];
  notSurfaced: string[];
  unregistered: string[];
}

export function classifyOps(ops: readonly string[], parity: readonly ParityEdge[], decls: readonly Declination[]): Buckets {
  const effective = new Set<string>();
  const writeOnly = new Set<string>();
  for (const edge of parity) {
    for (const op of edge.ops) {
      if (edge.effect === 'effective') effective.add(op);
      else if (edge.effect === 'write-only') writeOnly.add(op);
    }
  }
  const known = new Set(ops);
  // not-surfaced 的 subject 必须是真实存在的 operationId：死条目被静默过滤等于没有守卫。
  // 例外：subject 含空格或非 ASCII 的是描述性文本（UI 元素/行为），不是 operationId，跳过检查。
  const notSurfacedDecls = decls.filter((d) => d.kind === 'not-surfaced');
  const isOpId = (s: string) => /^[a-zA-Z][a-zA-Z0-9]*$/.test(s);
  const deadSubjects = notSurfacedDecls
    .filter((d) => isOpId(d.subject) && !known.has(d.subject))
    .map((d) => `${d.id}→${d.subject}`);
  if (deadSubjects.length > 0) {
    throw new Error(
      `classifyOps: not-surfaced 条目的 subject 指向不存在的操作 [${deadSubjects.join(', ')}] —— ` +
        `与 parity 侧的对称断言缺失，死条目会被静默过滤`,
    );
  }
  const notSurfaced = notSurfacedDecls
    .filter((d) => isOpId(d.subject))
    .map((d) => d.subject)
    .filter((s) => !effective.has(s) && !writeOnly.has(s));
  const unregistered: string[] = [];
  for (const op of ops) {
    const inEff = effective.has(op);
    const inWrite = writeOnly.has(op);
    const inDecl = notSurfaced.includes(op);
    if (inEff && inWrite) {
      unregistered.push(`${op}（同一条 op 被两种 effect 各自申报）`);
      continue;
    }
    if (!inEff && !inWrite && !inDecl) unregistered.push(op);
  }
  return {
    effective: ops.filter((o) => effective.has(o)),
    writeOnly: ops.filter((o) => writeOnly.has(o)),
    notSurfaced,
    unregistered,
  };
}

/** 出处分层：`tier` 回报 'A'（锚定且读得到）/ 'B'（未锚定）/ 'X'（声称锚定但副本缺失）。 */
export async function detectSources(
  edges: readonly { panel: string; webui: string; ops: string[] }[],
  tier: (repoPath: string) => Promise<'A' | 'B' | 'X'>,
): Promise<string[]> {
  const out: string[] = [];
  const parsed = edges.map((edge) => {
    const m = /^(.+):(\d+)$/.exec(edge.webui);
    return { edge, path: m?.[1] ?? edge.webui, ok: Boolean(m) };
  });
  const tiers = new Map<string, 'A' | 'B' | 'X'>();
  for (const p of parsed) if (!tiers.has(p.path)) tiers.set(p.path, p.ok ? await tier(p.path) : 'A');
  for (const { edge, path, ok } of parsed) {
    if (!ok) {
      out.push(`${edge.panel} · ${edge.webui}（出处不是 <路径>:<行>）`);
      continue;
    }
    if (tiers.get(path) === 'X') {
      out.push(`${edge.panel} · ${edge.webui}（声称 Tier A 出处，但锚定副本读不到）`);
      continue;
    }
    if (tiers.get(path) !== 'B') continue;
    // Tier B 允许作说明；只有当某条 op 的覆盖**全部**压在这类出处上，才等于没有出处。
    const supporters = parsed.filter((x) => x.edge.ops.some((o) => edge.ops.includes(o)) && x.edge !== edge);
    const hasAnchorElsewhere = supporters.some((x) => tiers.get(x.path) !== 'B');
    for (const op of edge.ops) {
      const claimedOnlyHere = !supporters.some((x) => x.edge.ops.includes(op) && tiers.get(x.path) !== 'B');
      if (claimedOnlyHere && !hasAnchorElsewhere) out.push(`${edge.panel} · ${edge.webui}（${op} 的覆盖只由 Tier B 出处支撑）`);
    }
  }
  return [...new Set(out)];
}

export function detectControls(
  edges: readonly ParityEdge[],
  vocabulary: ReadonlySet<string>,
  files: Readonly<Record<string, string>>,
): string[] {
  // 注释不参与"这名字真存在"：否则在代码里写一句 `// appearance 以后再说` 就能自证。
  // 逐文件剥注释：整仓拼一起再剥会让同名顶层声明互相撞（esbuild 直接报 already declared）。
  const codeText = Object.values(files)
    .map((t) => strip(t))
    .join('\n');
  const out: string[] = [];
  for (const edge of edges) {
    for (const c of edge.controls) {
      if (vocabulary.has(c)) continue;
      if (codeText.includes(c)) continue;
      out.push(`${edge.panel} · ${c}`);
    }
  }
  return [...new Set(out)];
}

export function detectMerge(
  edges: readonly ParityEdge[],
  wholeDocumentMerge: ReadonlyMap<string, boolean>,
  servedOps: readonly string[],
): string[] {
  const out: string[] = [];
  const declaredFull = new Set<string>();
  for (const edge of edges) {
    if (!edge.merge) continue;
    for (const op of edge.ops) {
      const merged = wholeDocumentMerge.get(op);
      if (merged === undefined) continue;
      if (edge.merge === 'full' && merged === false) {
        out.push(`${edge.panel} · ${op}: 声明 merge=full，承载代码里没有整份合并（deepMerge 或先读后写）`);
      }
      if (edge.merge === 'partial' && merged === true) {
        out.push(`${edge.panel} · ${op}: 承载代码做了整份合并，声明却是 partial`);
      }
      if (edge.merge === 'full') declaredFull.add(op);
    }
  }
  for (const op of servedOps) {
    if (wholeDocumentMerge.get(op) !== true) continue;
    if (declaredFull.has(op)) continue;
    const edge = edges.find((x) => x.ops.includes(op));
    if (!edge || edge.merge) continue; // 声明过 partial 的在上一段已经报过，不重复记
    out.push(`${edge.panel} · ${op}: 承载代码做了整份合并，但这条边没有声明 merge`);
  }
  return [...new Set(out)];
}

export function detectStreamTests(effectiveStreamOps: readonly string[], corpus: Record<string, string>): string[] {
  const text = Object.values(corpus).join('\n');
  const out: string[] = [];
  for (const op of effectiveStreamOps) {
    const token = STREAM_TEST_TOKEN[op];
    if (token === undefined) continue;
    if (!text.includes(token)) out.push(`${op}（测试语料里没有 ${token} 这条面）`);
  }
  return out;
}

/** 剥掉行尾与整行注释后还剩 `/api/` 的行，就是真的手写了上游路径。 */
export function detectPathLiterals(files: Readonly<Record<string, string>>): string[] {
  const out: string[] = [];
  for (const [file, text] of Object.entries(files)) {
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const raw = lines[i];
      const t = raw.trim();
      if (t.startsWith('//') || t.startsWith('/*') || t.startsWith('*')) continue;
      const code = raw.replace(/\s+\/\/.*$/, '');
      if (code.includes('/api/')) out.push(`${file}:${i + 1}`);
    }
  }
  return out;
}

export function detectUnwrapped(files: Readonly<Record<string, string>>, ops: readonly string[]): string[] {
  const stream = new Set<string>(STREAM_OPS);
  const out: string[] = [];
  for (const [file, text] of Object.entries(files)) {
    const code = strip(text);
    for (const op of ops) {
      const re = new RegExp('(^|[^A-Za-z0-9_$.])(sdk\\.)?' + op + '\\(', 'g');
      let m: RegExpExecArray | null;
      while ((m = re.exec(code)) !== null) {
        const before = code.slice(0, m.index + m[0].length - op.length - 1);
        const wrapped = /unwrap(<[^>]*>)?\(\s*(await\s+)*(sdk\.)?$/.test(before);
        if (stream.has(op)) {
          if (wrapped) out.push(`${file} ${op}：流操作不许经 unwrap（200 是 {stream} 形态）`);
        } else if (!wrapped) {
          out.push(`${file} ${op}：非流 SDK 调用没被 unwrap 包裹（4xx 会静默成 {data:undefined}）`);
        }
      }
    }
  }
  return [...new Set(out)];
}

export interface RouteVerdict {
  forbiddenRoutes: string[];
  harnessOnly: string[];
  unreachableOps: string[];
}

export function detectRoutes(
  routeOps: ReadonlyMap<string, string[]>,
  uiPaths: ReadonlySet<string>,
  forbidden: readonly string[] = FORBIDDEN_ROUTES,
  harness: readonly string[] = HARNESS_ROUTES,
): RouteVerdict {
  const ui = new Set<string>();
  const harnessCovered = new Set<string>();
  const forbiddenPresent = new Set<string>();
  const served = new Set<string>();
  for (const [key, ops] of routeOps) {
    const path = key.split(' ')[1];
    const name = path.split('/').filter(Boolean).pop() ?? '';
    for (const op of ops) served.add(op);
    if (forbidden.includes(name) || forbidden.includes(path.slice(1))) {
      forbiddenPresent.add(name || path.slice(1));
      continue; // 禁用端点承载的操作永远不算控件覆盖，哪怕客户端真在请求它
    }
    if (harness.includes(name)) {
      for (const op of ops) harnessCovered.add(op);
      continue;
    }
    if (!uiPaths.has(path)) continue;
    for (const op of ops) ui.add(op);
  }
  return {
    forbiddenRoutes: [...forbiddenPresent],
    harnessOnly: [...harnessCovered].filter((o) => !ui.has(o)),
    unreachableOps: [...served].filter((o) => !ui.has(o) && !harnessCovered.has(o)),
  };
}

// ────────────────────────────── 真仓库装配 ──────────────────────────────

export async function buildReport(): Promise<CoverageReportV2> {
  const spec = parse(await readFile(SPEC_PATH, 'utf8')) as any;
  const ops = specOperationIds(spec);
  const methods = specOperationMethods(spec);
  const routeFiles = await readTexts(ROUTES_DIR);
  const clientFiles = await readTexts('demo/client');
  const serverOther = { 'demo/server/start.ts': await readFile('demo/server/start.ts', 'utf8') };

  const routeOps = new Map<string, string[]>();
  const wholeMerge = new Map<string, boolean>();
  const mixed: string[][] = [];
  for (const [file, text] of Object.entries({ ...routeFiles, ...serverOther })) {
    const bodies = functionBodies(text);
    for (const [key, block] of routeBlocks(text)) {
      const served = opsServedByBlock(block, bodies, ops);
      routeOps.set(key, [...new Set([...(routeOps.get(key) ?? []), ...served.ops])]);
      if (served.merged) for (const o of served.ops) wholeMerge.set(o, true);
      mixed.push(served.direct);
    }
  }
  for (const [key, list] of Object.entries(EXPLICIT_ROUTE_OPS)) {
    if (!routeOps.has(key)) throw new Error(`EXPLICIT_ROUTE_OPS 里的路由键不存在：${key}`);
    routeOps.set(key, [...new Set([...(routeOps.get(key) ?? []), ...list])]);
  }
  // "先读后写"也算整份合并：外观保存就是现读-改-整份回传，代码里没有 deepMerge，但形状一样。
  // 只看这条路由自己的直接调用（理由见 opsServedByBlock 的 `direct`）。
  for (const list of mixed) {
    const reads = list.filter((o) => READ_METHODS.has(methods.get(o) ?? 'get'));
    const writes = list.filter((o) => !READ_METHODS.has(methods.get(o) ?? 'get'));
    if (!reads.length || !writes.length) continue;
    for (const o of writes) wholeMerge.set(o, true);
  }
  for (const op of ops) if (!wholeMerge.has(op)) wholeMerge.set(op, false);

  const buckets = classifyOps(ops, PARITY, DECLINATIONS);
  const anchored = new Set<string>(UPSTREAM_FILES);
  // 按"不同的文件"计，不是按引用条数：同一个锚定文件被三条边各引一次，比例不该因此变淡。
  const citedFiles = PARITY.map((edge) => /^(.+):(\d+)$/.exec(edge.webui))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => m[1]);
  const citedUnique = [...new Set(citedFiles)];
  const sourcesAnchored = citedUnique.filter((p) => anchored.has(p)).length;
  const tier = async (repoPath: string): Promise<'A' | 'B' | 'X'> => {
    if (!anchored.has(repoPath)) return 'B';
    // resolveUpstreamFile 已经做过 access：null 只可能是"声称锚定但副本读不到"
    return (await resolveUpstreamFile(repoPath)) === null ? 'X' : 'A';
  };

  // 控件名单的"自己代码里真有"这一半：只看 demo/client 与 demo/server，注释由 detectControls 剥掉；
  // 名单本身（demo/parity.ts）与放弃清单不参与，否则写下去就等于自证。
  const ownCode = { ...clientFiles, ...routeFiles, ...serverOther };

  const testCorpus: Record<string, string> = {};
  for await (const f of tsFiles('tools')) {
    if (f.endsWith('.test.ts')) testCorpus[f] = await readFile(f, 'utf8');
  }

  const streamEffective = STREAM_OPS.filter((o) => buckets.effective.includes(o));
  const pathsRequested = new Set<string>();
  for (const text of Object.values(clientFiles)) {
    // 只取引号后的路径段，遇 `?` 或闭合引号即止：`'/onebot-config?uin=' + x` 与 `'/events?topic=' + t`
    // 都是客户端真在请求的那条路由，按整串字面量比对会把带参的路径全判成"客户端从不请求"。
    // 反引号也算：`/probe-login?pid=${…}` 是模板字面量，漏了它这条操作会被判成没有控件。
    for (const m of text.matchAll(/['`](\/[a-z0-9/_-]+)/g)) pathsRequested.add(m[1]);
  }
  const routes = detectRoutes(routeOps, pathsRequested);

  return {
    totalOps: ops.length,
    sourcesTotal: citedUnique.length,
    sourcesAnchored,
    ...buckets,
    unresolvableSources: await detectSources(PARITY, tier),
    unknownControls: detectControls(PARITY, specVocabulary(spec), ownCode),
    mergeMismatches: detectMerge(PARITY, wholeMerge, [...routeOps.values()].flat()),
    missingStreamTests: detectStreamTests(streamEffective, testCorpus),
    forbiddenPathLiterals: detectPathLiterals({ ...clientFiles, ...routeFiles, ...serverOther }),
    unwrappedSdkCalls: detectUnwrapped(routeFiles, ops),
    forbiddenRoutes: routes.forbiddenRoutes,
    harnessOnly: routes.harnessOnly,
    unreachableOps: routes.unreachableOps,
  };
}

/** 七条判语；每条最多贡献一行，空数组即通过。 */
export function violationsV2(r: CoverageReportV2): string[] {
  const dup = [...r.effective, ...r.writeOnly, ...r.notSurfaced].filter(
    (op, i, all) => all.indexOf(op) !== i,
  );
  const fails: string[] = [];
  if (r.unregistered.length || dup.length) {
    fails.push(`归属不完整或重复审（断言 1）：${[...new Set([...r.unregistered, ...dup])].join(', ')}`);
  }
  if (r.unresolvableSources.length) fails.push(`出处解不到或只靠 Tier B 支撑（断言 2）：${r.unresolvableSources.join('; ')}`);
  if (r.unknownControls.length) fails.push(`控件名既不在 spec 也不在自己代码里（断言 3）：${r.unknownControls.join('; ')}`);
  if (r.mergeMismatches.length) fails.push(`合并语义声明与实现不符（断言 4）：${r.mergeMismatches.join('; ')}`);
  if (r.missingStreamTests.length) fails.push(`effective 的流行为没有对应单测（断言 5）：${r.missingStreamTests.join('; ')}`);
  if (r.forbiddenPathLiterals.length) fails.push(`手写上游路径（断言 6）：${r.forbiddenPathLiterals.join(', ')}`);
  if (r.forbiddenRoutes.length) fails.push(`原始直通/调用台端点回归（断言 6）：${r.forbiddenRoutes.join(', ')}`);
  if (r.harnessOnly.length) fails.push(`仅由 sweep harness 覆盖，用户控件缺失（断言 6）：${r.harnessOnly.join(', ')}`);
  if (r.unreachableOps.length) fails.push(`客户端从不请求其路由，覆盖主张不成立（断言 6）：${r.unreachableOps.join(', ')}`);
  if (r.unwrappedSdkCalls.length) fails.push(`非流 SDK 调用绕过 unwrap ⇒ 4xx 被静默（断言 7）：${r.unwrappedSdkCalls.join('; ')}`);
  return fails;
}

export function markdownReport(r: CoverageReportV2): string {
  const byPanel = new Map<string, ParityEdge[]>();
  for (const edge of PARITY) byPanel.set(edge.panel, [...(byPanel.get(edge.panel) ?? []), edge]);
  const lines: string[] = [
    '# UI 覆盖报告',
    '',
    `spec 操作 ${r.totalOps} 条 · effective ${r.effective.length} · write-only ${r.writeOnly.length} · not-surfaced ${r.notSurfaced.length} · 未登记 ${r.unregistered.length}`,
    `出处引用 ${r.sourcesTotal} 份文件 · Tier A（锚定面内）${r.sourcesAnchored} 份`,
    '',
    '## 面板 × 操作',
    '',
    '| 面板 | 控件 | 操作 | effect | merge | 出处 |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const [panel, edges] of byPanel) {
    for (const e of edges) {
      lines.push(
        `| ${panel} | ${e.controls.join(', ')} | ${e.ops.join(', ')} | ${e.effect} | ${e.merge ?? '—'} | ${e.webui} |`,
      );
    }
  }
  lines.push('', '## 放弃清单', '');
  for (const d of DECLINATIONS) lines.push(`- **${d.id}**（${d.kind}）· ${d.subject} —— ${d.reason}`);
  lines.push('', '## 七条断言', '');
  const rows: [string, string[]][] = [
    ['1 归属缺失/重复审', r.unregistered],
    ['2 出处解不到 / Tier B 单独支撑', r.unresolvableSources],
    ['3 控件名无出处', r.unknownControls],
    ['4 合并语义不符', r.mergeMismatches],
    ['5 流行为缺单测', r.missingStreamTests],
    ['6 手写路径 / 禁用端点 / harness 独占 / 不可达', [
      ...r.forbiddenPathLiterals,
      ...r.forbiddenRoutes.map((x) => '禁用端点：' + x),
      ...r.harnessOnly.map((x) => 'harness 独占：' + x),
      ...r.unreachableOps.map((x) => '不可达：' + x),
    ]],
    ['7 非流调用绕过 unwrap', r.unwrappedSdkCalls],
  ];
  for (const [name, list] of rows) lines.push(`- ${name}：${list.length ? list.join('; ') : '0'}`);
  return lines.join('\n') + '\n';
}

if (isCliEntry(import.meta.url, process.argv[1])) {
  const report = await buildReport();
  if (process.argv.includes('--report')) {
    console.log(markdownReport(report));
    if (violationsV2(report).length) process.exit(1);
  } else {
    console.log(
      `spec 操作 ${report.totalOps} · effective ${report.effective.length} · write-only ${report.writeOnly.length} · not-surfaced ${report.notSurfaced.length} · 未登记 ${report.unregistered.length} · 出处 Tier A ${report.sourcesAnchored}/${report.sourcesTotal}`,
    );
    const fails = violationsV2(report);
    if (fails.length) {
      console.error(`\n不通过 ${fails.length} 项：`);
      for (const f of fails) console.error(`  - ${f}`);
      process.exit(1);
    }
    console.log('七条断言全绿：每条操作都有归属、每个控件名都有出处、每条 4xx 都过 unwrap。');
  }
}
