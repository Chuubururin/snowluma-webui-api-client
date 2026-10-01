// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
/**
 * 归一化规则表的读取、校验与应用（设计口径：规则单源、实现三份、输出必检）。
 *
 * 规则表 `adapters/rules.json` 是三语言适配层共用的唯一规则真源；本模块是 TypeScript 侧的
 * 读取与应用实现。结构校验按 `adapters/rules.schema.json` 的契约手写（仓库不新增 ajv 依赖），
 * 任何校验失败都抛错——静默忽略规则等于让三份实现各说各话。
 *
 * 匹配语义：`match.path` 是 OpenAPI 模板形（`/api/config/{uin}`），`{x}` 匹配单个非 `/` 段；
 * `match.method` 大写。`op`：
 * - `unwrap`：当响应体含 `when.hasKey` 指定的键时，解包出 `unwrapKey` 指定的子对象
 *   （双形状端点，如 GET /api/config/{uin} 的 `{config}` 信封）。
 * - `rename`：把 `rename.from` 键改名为 `rename.to`（判别字段改名/别名），仅顶层。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface RuleMatch {
  path: string;
  method: string;
}

export interface Rule {
  id: string;
  match: RuleMatch;
  op: 'unwrap' | 'rename';
  when?: { hasKey?: string };
  unwrapKey?: string;
  rename?: { from: string; to: string };
}

export interface RulesTable {
  schemaVersion: string;
  rules: Rule[];
}

export class RulesError extends Error {}

/** 按 rules.schema.json 的契约做结构校验；任何不符即抛 RulesError。 */
export function validateRules(table: unknown): RulesTable {
  if (typeof table !== 'object' || table === null || Array.isArray(table)) {
    throw new RulesError('规则表必须是对象');
  }
  const t = table as Record<string, unknown>;
  if (typeof t.schemaVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(t.schemaVersion)) {
    throw new RulesError(`schemaVersion 必须是 x.y.z 字符串，实为 ${JSON.stringify(t.schemaVersion)}`);
  }
  if (!Array.isArray(t.rules)) throw new RulesError('rules 必须是数组');
  const seen = new Set<string>();
  for (const raw of t.rules) {
    if (typeof raw !== 'object' || raw === null) throw new RulesError('规则项必须是对象');
    const r = raw as Record<string, unknown>;
    if (typeof r.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(r.id)) {
      throw new RulesError(`规则 id 非法：${JSON.stringify(r.id)}`);
    }
    if (seen.has(r.id)) throw new RulesError(`规则 id 重复：${r.id}`);
    seen.add(r.id);
    const m = r.match as Record<string, unknown> | undefined;
    if (typeof m !== 'object' || m === null) throw new RulesError(`${r.id}: match 必须是对象`);
    if (typeof m.path !== 'string' || !m.path.startsWith('/')) throw new RulesError(`${r.id}: match.path 必须以 / 开头`);
    if (typeof m.method !== 'string' || !/^[A-Z]+$/.test(m.method)) throw new RulesError(`${r.id}: match.method 必须大写`);
    if (r.op !== 'unwrap' && r.op !== 'rename') throw new RulesError(`${r.id}: op 只能是 unwrap|rename，实为 ${JSON.stringify(r.op)}`);
    if (r.op === 'unwrap') {
      if (typeof r.unwrapKey !== 'string' || r.unwrapKey === '') throw new RulesError(`${r.id}: unwrap 需要 unwrapKey`);
      // when:null 与缺省同义（无条件解包）；when 只许是带非空字符串 hasKey 的对象，空对象非法。
      const hasKey = r.when != null ? (r.when as { hasKey?: unknown }).hasKey : undefined;
      if (r.when != null && (typeof r.when !== 'object' || typeof hasKey !== 'string' || hasKey === '')) {
        throw new RulesError(`${r.id}: when.hasKey 必须是非空字符串`);
      }
    }
    if (r.op === 'rename') {
      const rn = r.rename as Record<string, unknown> | undefined;
      if (
        typeof rn !== 'object' ||
        rn === null ||
        typeof rn.from !== 'string' ||
        rn.from === '' ||
        typeof rn.to !== 'string' ||
        rn.to === ''
      ) {
        throw new RulesError(`${r.id}: rename 需要非空的 {from,to}`);
      }
    }
    const allowed = ['id', 'match', 'op', 'when', 'unwrapKey', 'rename'];
    for (const k of Object.keys(r)) {
      if (!allowed.includes(k)) throw new RulesError(`${r.id}: 未知键 ${k}`);
    }
  }
  return table as RulesTable;
}

/** 默认从仓库的 adapters/rules.json 读取（本文件位于 adapters/typescript/ 下）。 */
export function loadRules(path?: string): RulesTable {
  const p = path ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'rules.json');
  return validateRules(JSON.parse(readFileSync(p, 'utf8')));
}

/** 模板路径 → 正则：`{x}` 匹配单个非 / 段（不含换行——路径段里没有换行），其余字符按字面转义。 */
function templateToRegex(template: string): RegExp {
  const source = template
    .split('/')
    .map((seg) => (seg.startsWith('{') && seg.endsWith('}') ? '[^/\\n]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('/');
  return new RegExp(`^${source}$`);
}

function matches(rule: Rule, method: string, path: string): boolean {
  if (rule.match.method !== method.toUpperCase()) return false;
  return templateToRegex(rule.match.path).test(path);
}

/**
 * 对**成功响应体**应用全部匹配规则（错误信封不归一化，走异常路径）。
 * 返回新对象；无匹配规则时原样返回入参引用。
 */
export function applyRules(rules: RulesTable, method: string, path: string, body: unknown): unknown {
  let out = body;
  for (const rule of rules.rules) {
    if (!matches(rule, method, path)) continue;
    if (typeof out !== 'object' || out === null || Array.isArray(out)) continue;
    const obj = out as Record<string, unknown>;
    if (rule.op === 'unwrap') {
      // hasOwn 而不是 in：in 沿原型链，"toString"/"__proto__" 会被误判命中（与 oneof/pointer 同一条仓规）。
      if (rule.when?.hasKey !== undefined && !Object.hasOwn(obj, rule.when.hasKey)) continue;
      const inner = obj[rule.unwrapKey as string];
      if (typeof inner !== 'object' || inner === null || Array.isArray(inner)) continue;
      out = { ...(inner as Record<string, unknown>) };
    } else if (rule.op === 'rename') {
      const { from, to } = rule.rename as { from: string; to: string };
      if (from === to) continue; // 改名到自己 = no-op，三语同形（Python 的 pop-再-写回正是这个结果）
      if (!Object.hasOwn(obj, from)) continue;
      out = { ...obj, [to]: obj[from] };
      delete (out as Record<string, unknown>)[from];
    }
  }
  return out;
}
