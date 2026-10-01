// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
import type { SpecIR } from './ir.js';

/**
 * demo 侧唯一的机械事实源。
 *
 * 判据（解耦计划设计口径）：只装能从 spec 与 SDK 导出集**零判断**推出的字段。
 * 聚合形状、错误降级、派生键、响应包装 —— 全是判断，留在手写路由里，本表不表达。
 */
export interface VocabularyEntry {
  operationId: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** 上游路径（含 /api 前缀），不是 demo 语义路径。 */
  path: string;
  isSSE: boolean;
  isGate: boolean;
  /** spec 显式 `security: []` ⇒ 登录前可读。 */
  anonymous: boolean;
}

export function emitVocabulary(spec: SpecIR, sdkExports: string[]): string {
  const ops = spec.operations;
  if (ops.length === 0) {
    throw new Error('emitVocabulary: spec operations=[]，空头表会让下游断言全部空真通过');
  }

  const specIds = ops.map((o) => o.operationId);
  // 重复 operationId 必须在 Set 去重之前抓住：两腿都是 Set 会让重复静默通过。
  const dupes = specIds.filter((id, i) => specIds.indexOf(id) !== i);
  if (dupes.length > 0) {
    throw new Error(`emitVocabulary: spec 里有重复 operationId [${[...new Set(dupes)].join(', ')}]`);
  }
  assertSameSet(specIds, sdkExports);

  // 字节序排序（与全仓教义一致）：localeCompare 跨机器可能因 locale 不同产生不同顺序，
  // gen:check 的 git diff 会因此变红。
  const sorted = [...ops].sort((a, b) => (a.operationId < b.operationId ? -1 : a.operationId > b.operationId ? 1 : 0));
  const lines: string[] = [];
  lines.push('// 由 npm run gen:demo 从 spec/openapi.yaml + generated/typescript/sdk.gen.ts 机械推出。');
  lines.push('// 上游加/删一条操作后本表即过期：gen:check 重新生成后 git diff 非空即红。');
  lines.push('');
  lines.push('export interface VocabularyEntry {');
  lines.push('  operationId: string;');
  lines.push("  method: 'GET' | 'POST' | 'PUT' | 'DELETE';");
  lines.push('  /** 上游路径（含 /api），非 demo 语义路径。 */');
  lines.push('  path: string;');
  lines.push('  isSSE: boolean;');
  lines.push('  isGate: boolean;');
  lines.push('  /** spec 显式 security: [] ⇒ 登录前可读。 */');
  lines.push('  anonymous: boolean;');
  lines.push('}');
  lines.push('');
  lines.push('export const VOCABULARY: Record<string, VocabularyEntry> = {');
  for (const o of sorted) {
    const entry =
      `{ operationId: '${o.operationId}', method: '${o.method.toUpperCase()}', ` +
      `path: '${o.path}', isSSE: ${o.isSSE}, isGate: ${o.isGate}, anonymous: ${o.securityOptional} }`;
    lines.push(`  ${o.operationId}: ${entry},`);
  }
  lines.push('};');
  lines.push('');
  lines.push(`export const OPERATION_IDS: string[] = [${ids(sorted.map((o) => o.operationId))}];`);
  lines.push(`export const SSE_OPERATIONS: string[] = [${ids(sorted.filter((o) => o.isSSE).map((o) => o.operationId))}];`);
  lines.push(`export const GATE_OPERATIONS: string[] = [${ids(sorted.filter((o) => o.isGate).map((o) => o.operationId))}];`);
  lines.push(`export const ANONYMOUS_OPERATIONS: string[] = [${ids(sorted.filter((o) => o.securityOptional).map((o) => o.operationId))}];`);
  lines.push('');
  return lines.join('\n');
}

function ids(list: string[]): string {
  return list.map((x) => `'${x}'`).join(', ');
}

/**
 * SDK 那一腿只能在这里核：`generated/` 被 gitignore，测试期读不到它，
 * 把门禁建在冷克隆里必红的东西上等于没有门禁。
 */
function assertSameSet(specIds: string[], sdkExports: string[]): void {
  const a = new Set(specIds);
  const b = new Set(sdkExports);
  const missing = [...a].filter((x) => !b.has(x));
  const extra = [...b].filter((x) => !a.has(x));
  if (missing.length || extra.length) {
    throw new Error(
      `emitVocabulary: spec 与 SDK 导出集不等 —— SDK 少一条 [${missing.join(', ')}]，多一条 [${extra.join(', ')}]`,
    );
  }
}
