// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
import { readFile } from 'node:fs/promises';
import { isCliEntry } from './lib/cli.js';
import { parse } from 'yaml';
import { extractRoutes, isApiOp, type RouteOp } from './extract-routes.js';
import { buildAnchorFromDir, COMMIT_SHA } from './build-anchor.js';
import { normalizeParamForm, replayClassOf, tierKey } from './lib/tiers.js';
import { UPSTREAM_FILES, localPathFor, type Anchor } from './lib/upstream.js';

const METHODS = ['get', 'post', 'put', 'delete', 'patch'] as const;

export interface DriftReport {
  upstreamOnly: string[];
  specOnly: string[];
  unclassified: string[];
  /** computeDrift 返回的恒为 false，语义是"未评估"（纯函数无从知道哈希状态）；
   *  CLI 段必须以 { ...drift, anchorStale } 组合真值，不得改写纯函数的返回值
   *  ——那会让直接调用者把一个"未知"读成"不陈旧"。 */
  anchorStale: boolean;
}

export function specOpsFromPaths(paths: Record<string, unknown>): { method: string; path: string }[] {
  const out: { method: string; path: string }[] = [];
  for (const [path, item] of Object.entries(paths ?? {})) {
    const entry = (item ?? {}) as Record<string, unknown>;
    for (const method of METHODS) if (entry[method]) out.push({ method: method.toUpperCase(), path });
  }
  return out;
}

// 裁定 R19：上游侧的 path 是源码抽取来的 Express `:uin`，spec 侧按 OpenAPI 3.0 只能写 `{uin}`。
// 两侧形式不同**不是漂移**，所以进 tierKey 前一律过唯一真源 normalizeParamForm 归一，
// 否则 6 条含参端点会同时出现在 upstreamOnly 与 specOnly（双向假漂移＝教人忽略检查结果）。
// 报告键沿用 tierKey 的 "METHOD /path" 形式，两侧同形才可读；归一后的形式是 Express 的 `:x`
// （与 tiers.ts 的 55 条键、spec/fixtures 的上游侧书写一致）。
function asTierOp(op: { method: string; path: string }): RouteOp {
  return { ...op, path: normalizeParamForm(op.path), file: '', line: 0 };
}

const driftKey = (op: { method: string; path: string }): string => tierKey(asTierOp(op));

const isSpecOp = (v: unknown): v is { method: string; path: string } =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as { method?: unknown }).method === 'string' &&
  typeof (v as { path?: unknown }).path === 'string';

export function computeDrift(
  upstreamOps: { method: string; path: string }[],
  specPathsOrOps: Record<string, unknown> | { method: string; path: string }[],
): DriftReport {
  // 数组分支必须先过形状检查：联合类型无从区分"ops 列表"与"被 YAML 写坏成数组的 paths"，
  // 放过去会在 normalizeParamForm(undefined) 上炸成无文件名、无提示的裸 TypeError——
  // 而本工具的全部产出都是诊断，诊断工具自己崩成不可读的报错不可接受。
  // 选择"窄化形状"而不是"删掉数组分支"：ops 数组入参是零 spec 依赖的单测与 CLI 之外的
  // 直接调用方都要用的形态（见测试的反方向归一化用例），砍掉它只会把负担转嫁给调用方。
  if (Array.isArray(specPathsOrOps) && !specPathsOrOps.every(isSpecOp)) {
    throw new Error(
      '非法的 spec 侧入参：数组分支要求每一项都是 { method: string; path: string }；' +
        '若这是 spec 的 paths（被写成了数组，YAML 结构错误），请修正 spec 或改传 paths 映射本体。',
    );
  }
  const specOps = Array.isArray(specPathsOrOps)
    ? specPathsOrOps
    : specOpsFromPaths(specPathsOrOps);

  const upstreamKeys = new Set(upstreamOps.filter((o) => isApiOp(o.path)).map(driftKey));
  const specKeys = new Set(specOps.map(driftKey));

  const unclassified: string[] = [];
  for (const op of upstreamOps.filter((o) => isApiOp(o.path))) {
    try {
      // replayClassOf 只认归一化后的键：真实上游是 :x 形态（归一为恒等），
      // 但本函数的入参形态不做假设，喂 spec 形态也不能静默退化成"未归类"
      replayClassOf(asTierOp(op));
    } catch {
      unclassified.push(driftKey(op));
    }
  }

  // 三个数组必须排序后返回、unclassified 还要去重（brief Produces）：Set 的迭代序就是
  // 插入序，不去不排则输出随上游/ spec 的书写顺序抖动——客户端批次里一次纯粹的 spec 重排
  // 会整片显示为漂移差异；重复注册的 unclassified 还会重复成行、把阻断计数虚增
  // （upstreamOnly 经 Set 天然折叠，unclassified 必须同样折叠）。
  return {
    upstreamOnly: [...upstreamKeys].filter((k) => !specKeys.has(k)).sort(),
    specOnly: [...specKeys].filter((k) => !upstreamKeys.has(k)).sort(),
    unclassified: [...new Set(unclassified)].sort(),
    anchorStale: false, // 恒 false = "未评估"，见接口注释：CLI 用 { ...drift, anchorStale } 组合
  };
}

// anchor 的三个计数字段此前"只写不读"（见注的纠错）。本函数是它们的读者：
// 没有它，手改或过期的 spec/anchor.json 不会被任何检查发现。
export function countExpectations(anchor: Anchor, fresh: Anchor): string[] {
  const lines: string[] = [];
  // files.some 在空数组上恒 false（哈希比对会全绿）：被掏空 files 的 anchor
  // 必须在计数层就被抓住——锚定面不可能合法地为零。?. 兼容缺 files 的调用方。
  if ((anchor.files?.length ?? 0) === 0) lines.push('锚定文件集为空：anchor 被掏空或损坏，须重新生成');
  const scalars: [keyof Anchor, string][] = [
    ['expectedRouteRegistrations', '路由注册总数'],
    ['expectedApiOperations', 'API 操作数'],
  ];
  for (const [key, label] of scalars) {
    if (anchor[key] !== fresh[key]) {
      lines.push(`${label}：anchor=${String(anchor[key])} != 当前计算值=${String(fresh[key])}`);
    }
  }
  const paths = new Set([...Object.keys(anchor.expectedModels), ...Object.keys(fresh.expectedModels)]);
  for (const repoPath of [...paths].sort()) {
    const a = anchor.expectedModels[repoPath];
    const f = fresh.expectedModels[repoPath];
    if (a === f) continue;
    if (a === undefined) lines.push(`模型数：${repoPath} anchor 无此项，当前计算值=${f}（上游新增模型文件？）`);
    else if (f === undefined) lines.push(`模型数：${repoPath} anchor=${a}，当前计算值无此项（文件被移走或改名？）`);
    else lines.push(`模型数：${repoPath} anchor=${a} != 当前计算值=${f}`);
  }
  return lines;
}

// 裁定 R21（评审）：anchorStale 是**阻断**条件，不是观察项。
// 理由：anchor 的全部职责就是钉住"x-verification-status 声称验证过的那批上游字节"。
// 上游可以在 59/55/76/19 全部不变的前提下改动 handler 主体、内部改名或注释——此时
// 哈希比对为真、计数比对全通过、spec 覆盖无变化、漂移列表全空，于是这个工具会在
// 它自己刚打印过"缓存已过期"的同一轮里 exit 0，即**从它判定为过期的数据认证"无漂移"**。
// 唯一能发现锚点失效的检查如果不承担后果，就等于没有检查。
// 退出决策从 CLI 分支抽成导出的纯函数：本项目的 CLI 分支不做单测，只有在这里才钉得住
// （回退成"漂移列表非空才阻断"时 blocksExit 的 R21 用例即红）。
export function blocksExit(report: DriftReport): boolean {
  return (
    report.upstreamOnly.length + report.specOnly.length + report.unclassified.length > 0 ||
    report.anchorStale
  );
}

// —— 补救文案（终审 I2）———————————————————————————————————————————————
// 旧文案让操作员"重跑 npm run extract"。该脚本就是 build-anchor.ts，它**从不 fetch**
// （buildAnchorFromDir 只把 vendor 里现有字节重新哈希），并把 argv 传入的字符串当 commit 标签盖上。
// 照旧文案做的结果是：哈希与当前缓存必然相符、计数必然一致、anchor.commit 却成了无人核验的声称——
// 也就是工具自己建议了一步"把 R21 刚拦下的陈旧锚点重新合法化"的操作。
// 因此恢复动作的唯一真源改成"先按 anchor 记录的 SHA 重拉缓存，再以同一个 SHA 重建锚点"，
// 并从 CLI 里抽成导出的常量/纯函数（沿用 blocksExit 的做法：本项目的 CLI 分支不做单测）。
export const FETCH_RECOVERY =
  '先按 tools.lock.json → prerequisites.fetchCommand，以 spec/anchor.json 记录的那份 40 位 SHA 重新拉取 ' +
  'vendor/upstream/（fetchUpstream 走 raw.githubusercontent.com，只有这一步会真正核对上游内容）；' +
  '确认缓存属于该 SHA 后，再用 node_modules/.bin/tsx tools/build-anchor.ts <同一个 40 位 SHA> 重建 spec/anchor.json。' +
  '不要单跑 npm run extract：它就是 build-anchor.ts，从不联网，只把缓存里已有的字节重新哈希一遍——' +
  '哈希与计数会"必然相符"，而 commit 字段只是没人核验过的标签，等于用待认证的缓存认证缓存自己。';

/** 漂移非空时的补救提示：条数进消息，人工核对时才知道差异有多大。 */
export function driftRemediation(driftLineCount: number): string {
  return (
    `发现 ${driftLineCount} 条漂移。先判断差异来自 spec 还是上游：` +
    `若 spec 落后则直接更新 spec/openapi.yaml；若上游确实变化，${FETCH_RECOVERY}` +
    '（不得放宽检查或 skip 检查。）'
  );
}

export const STALE_CACHE_REMEDIATION = `vendor 缓存与 anchor 记录的哈希不一致：缓存已过期。${FETCH_RECOVERY}`;

export const COUNT_MISMATCH_REMEDIATION = `以上计数与 anchor 记录不符。${FETCH_RECOVERY}（不得为了让检查变绿而改期望值。）`;

// 终审 I2 的收口项：上面三条都假设 anchor.commit 是可信的 40 位 SHA，而锚点是 JSON 文件、
// 谁都能手改。缺了这道读侧检查，把 spec/anchor.json 的 commit 改回 "main" 就能让全部闸门
// 绿灯通过——写侧（build-anchor CLI）有契约、读侧没有，等于没有。
// 文案刻意不复用 FETCH_RECOVERY：它让人"按 anchor 记录的那份 SHA 重拉"，而本条的正是
// anchor 记录的 SHA 不可信，此时唯一诚实的起点是重新解析上游头并人工确认。
export const ANCHOR_COMMIT_REMEDIATION =
  'spec/anchor.json 的 commit 不是 40 位小写十六进制 SHA：这份锚点没有可信记录它认证的是哪份上游字节，' +
  '因此它的一切声称（含 x-verification-status）都无从对账。' +
  '先 `git ls-remote https://github.com/SnowLuma/SnowLuma main` 取回当前 40 位 SHA 并人工确认它是要采信的版本，' +
  '再以该 SHA 跑 tools.lock.json → prerequisites.fetchCommand 重拉 vendor/upstream/，' +
  '最后 `npm run extract -- <同一个 SHA>` 重建锚点。' +
  '不要单跑 npm run extract：它就是 build-anchor.ts，从不联网，只把缓存里已有的字节重新哈希一遍，' +
  '哈希与计数会"必然相符"而 commit 仍是无人核验的标签。';

if (isCliEntry(import.meta.url, process.argv[1])) {
  const anchor = JSON.parse(await readFile('spec/anchor.json', 'utf8')) as Anchor;

  // 终审 I2 收口项：形状检查必须在**用** anchor.commit 之前，而不是只在建锚点那侧。
  if (!COMMIT_SHA.test(anchor.commit)) {
    console.error(ANCHOR_COMMIT_REMEDIATION);
    process.exit(1);
  }

  // 设计口径：断言失败是期望行为，不是事故。人工核对差异后更新 anchor 与 spec，
  // 不得放宽断言或 skip 检查。
  // 注意顺序：先算 fresh，再比哈希，再比计数，最后才比 spec —— 前两类是
  // "缓存 vs anchor"，最后一类是"上游 vs spec"，把它们的失败混在一起会误导排查方向。
  const fresh = await buildAnchorFromDir(anchor.commit);
  // files.some 在空数组上恒 false：被掏空 files 的 anchor 会全绿通过。
  // 空文件集本身即 stale 信号（锚定面不可能合法地为零）。
  const anchorStale =
    anchor.files.length === 0 ||
    anchor.files.some((f) => fresh.files.find((g) => g.repoPath === f.repoPath)?.sha256 !== f.sha256);

  const countIssues = countExpectations(anchor, fresh);
  if (countIssues.length) {
    for (const line of countIssues) console.error(line);
    console.error(COUNT_MISMATCH_REMEDIATION);
    process.exit(1);
  }

  const ops = await extractRoutes(
    UPSTREAM_FILES.map((repoPath) => ({ repoPath, localPath: localPathFor(repoPath) })),
  );
  const doc = parse(await readFile('spec/openapi.yaml', 'utf8'));
  const drift = computeDrift(ops, doc.paths ?? {});
  // 组合而非改写：computeDrift 的 anchorStale 恒为 false（"未评估"），直接赋值
  // report.anchorStale = … 等于篡改纯函数的返回契约（见 DriftReport 注释与 brief Produces）。
  const report = { ...drift, anchorStale };

  console.log(JSON.stringify(report, null, 2));
  const driftLines = report.upstreamOnly.length + report.specOnly.length + report.unclassified.length;
  if (driftLines > 0) {
    // 设计口径：这里的失败是期望行为，不是事故——消息必须指向补救动作并禁止放宽检查。
    console.error(driftRemediation(driftLines));
  }
  if (anchorStale) {
    console.error(STALE_CACHE_REMEDIATION);
  }
  if (blocksExit(report)) process.exit(1);
}
