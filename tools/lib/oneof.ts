// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
import { resolveLocalPointer } from './pointer.js';

type Rec = Record<string, any>;

export interface UnionOverlap {
  /** oneOf 所在位置的指针路径，直接可定位 */
  at: string;
  /** 冲突的两支：能解析到 components 名就用名字，否则用分支下标 */
  a: string;
  b: string;
  /** 同时满足两支的具体实例（JSON 串），报出来的依据就是它 */
  witness: string;
}

const isRecord = (v: unknown): v is Rec =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

// 本模块能正确求值的验证类关键字。子树里出现集合外的验证类关键字 ⇒ 该支判"不可判" ⇒ 整对跳过。
// 方向是刻意的：只允许漏报（少一条红），不允许误报（把合法 spec 判死）。
// 补入 nullable / minimum / maximum（spec 有正面需求：AccountDatabaseMigration 的
// `number | null` 与 StateFrameDropped 的 `count >= 1`）。其余数值/字符串约束
// （exclusiveMinimum / exclusiveMaximum / multipleOf / format / pattern 等）**刻意不扩** ——
// 它们留在这里就是为了"不可判 ⇒ 闭嘴"，扩一个关键字就是多一处"求值写错就说谎"的地方。
const EVALUABLE = new Set([
  'type', 'required', 'properties', 'items', 'additionalProperties', '$ref', 'enum',
  'nullable', 'minimum', 'maximum',
]);

// 真正参与校验的关键字。不在这里也不在 EVALUABLE 里的（description / title / example / x-*）
// 是装饰性关键字，忽略它们不影响"这个实例满足这支吗"的答案。
const VALIDATING = new Set<string>(EVALUABLE);
for (const k of [
  'allOf', 'anyOf', 'oneOf', 'not', 'pattern', 'patternProperties', 'format',
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
  'minLength', 'maxLength', 'minItems', 'maxItems', 'uniqueItems',
  'minProperties', 'maxProperties', 'const', 'nullable', 'discriminator',
]) {
  VALIDATING.add(k);
}

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

// 键名一律走自有属性判定，不用 `in`：YAML 解析出的是带 Object.prototype 的普通对象，
// 于是 required/额外键里出现 toString、constructor 这类原型成员时 `k in o` 恒真 ——
// 那会让本模块"举出"一个其实不满足分支的 witness，即校验器说谎（误报方向，明令禁止）。
const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

function resolveSchema(doc: unknown, node: unknown): unknown {
  if (!isRecord(node)) return node;
  const ref = node.$ref;
  if (typeof ref !== 'string' || !ref.startsWith('#')) return node;
  return resolveLocalPointer(doc, ref).value;
}

/** 该分支子树里是否有本模块不求值的验证类关键字 —— 有就整对判不可判。 */
function inconclusive(schema: unknown, doc: unknown, seen: Set<unknown>): boolean {
  const node = resolveSchema(doc, schema);
  if (typeof node === 'boolean') return false;
  if (!isRecord(node)) return true;
  if (seen.has(node)) return false; // 已在栈上：首轮已核过整棵子树
  seen.add(node);
  for (const [k, v] of Object.entries(node)) {
    if (!VALIDATING.has(k)) continue;
    if (!EVALUABLE.has(k)) return true;
    if (k === 'properties') {
      if (!isRecord(v)) return true; // properties 写成非对象：求值不了
      for (const sub of Object.values(v)) if (inconclusive(sub, doc, seen)) return true;
    } else if (k === 'items') {
      if (inconclusive(v, doc, seen)) return true; // 数组形态（tuple）会在此判不可判
    } else if (k === 'additionalProperties') {
      if (typeof v === 'boolean') continue;
      if (inconclusive(v, doc, seen)) return true;
    }
  }
  return false;
}

type Verdict = 'pass' | 'fail' | 'unknown';

// fail > unknown > pass：一对分支里只要有一处 fail 就是"不匹配"，没 fail 但有 unknown 就是不可判。
function worse(a: Verdict, b: Verdict): Verdict {
  if (a === 'fail' || b === 'fail') return 'fail';
  if (a === 'unknown' || b === 'unknown') return 'unknown';
  return 'pass';
}

function typeOk(v: unknown, t: string): boolean {
  switch (t) {
    case 'object': return isRecord(v);
    case 'array': return Array.isArray(v);
    case 'string': return typeof v === 'string';
    case 'boolean': return typeof v === 'boolean';
    case 'number': return typeof v === 'number' && Number.isFinite(v);
    case 'integer': return typeof v === 'number' && Number.isInteger(v);
    case 'null': return v === null;
    default: return true; // 认不出的 type 值不当约束用（保守方向：不据此判负）
  }
}

function matches(instance: unknown, schema: unknown, doc: unknown, seen: ReadonlySet<unknown>): Verdict {
  const node = resolveSchema(doc, schema);
  if (node === true || node === undefined) return 'pass';
  if (node === false) return 'fail';
  if (!isRecord(node)) return 'unknown';
  if (seen.has(node)) return 'unknown'; // 递归 schema：不下注
  const next = new Set(seen);
  next.add(node);
  let rank: Verdict = 'pass';
  if (Array.isArray(node.enum) && !node.enum.some((v: unknown) => sameJson(v, instance))) return 'fail';
  // 3.0.3 的 `number | null` 写法是 `type: number, nullable: true` —— null 只在显式
  // nullable: true 时放行；没有它，"类型写漏"不该被当成两支都能接受（见 typeOk 的 'null' case）。
  if (
    typeof node.type === 'string' &&
    !(instance === null && node.nullable === true) &&
    !typeOk(instance, node.type)
  ) return 'fail';
  // 数值上下界只对数值实例求值；非数值（含 null）交给上面的 type 判定去管。
  if (typeof node.minimum === 'number' && typeof instance === 'number' && instance < node.minimum) return 'fail';
  if (typeof node.maximum === 'number' && typeof instance === 'number' && instance > node.maximum) return 'fail';
  if (Array.isArray(node.required)) {
    if (!isRecord(instance)) return 'fail';
    for (const k of node.required) if (!has(instance, k)) return 'fail';
  }
  const props: Rec | undefined = isRecord(node.properties) ? node.properties : undefined;
  if (props && isRecord(instance)) {
    for (const [k, sub] of Object.entries(props)) {
      if (!has(instance, k)) continue;
      rank = worse(rank, matches(instance[k], sub, doc, next));
    }
  }
  const ap = node.additionalProperties;
  if (isRecord(instance) && (ap === false || isRecord(ap))) {
    for (const k of Object.keys(instance)) {
      if (props && has(props, k)) continue;
      rank = worse(rank, ap === false ? 'fail' : matches(instance[k], ap, doc, next));
    }
  }
  if (Array.isArray(instance) && node.items !== undefined) {
    for (const el of instance) rank = worse(rank, matches(el, node.items, doc, next));
  }
  return rank;
}

const SKIP = Symbol('skip');

/** 造一个"确实满足该支"的样本：required 全填，withOptional 时把声明过的可选键也填满
 *  （超集实例才撞得上开放分支）。造不出来就返回 SKIP，让上层闭嘴。 */
function sample(schema: unknown, doc: unknown, withOptional: boolean, depth: number): unknown {
  if (depth > 3) return SKIP;
  const node = resolveSchema(doc, schema);
  if (!isRecord(node)) return SKIP;
  if (Array.isArray(node.enum) && node.enum.length > 0) return node.enum[0];
  const t: string | undefined = typeof node.type === 'string'
    ? node.type
    : isRecord(node.properties) || Array.isArray(node.required) ? 'object' : undefined;
  if (t === 'string') return 'x';
  if (t === 'boolean') return true;
  if (t === 'integer' || t === 'number') {
    // 样本必须落在自己的界内，否则连自证（witnessOf 的 matches(inst, from)）都过不了，
    // 真重叠就会被静默漏掉。有 minimum 取 minimum，否则取 1；
    // 若 maximum 比这还小，造不出满足自己边界的样本 ⇒ SKIP（不拿它去指控别人）。
    const v = typeof node.minimum === 'number' ? node.minimum : 1;
    if (typeof node.maximum === 'number' && v > node.maximum) return SKIP;
    return v;
  }
  if (t === 'array') {
    const el = sample(node.items, doc, withOptional, depth + 1);
    return el === SKIP ? [] : [el];
  }
  if (t === 'object') {
    const props: Rec = isRecord(node.properties) ? node.properties : {};
    const required: string[] = Array.isArray(node.required) ? node.required.map(String) : [];
    // required 里有未声明的属性 ⇒ 该填什么无从得知 ⇒ 放弃（不猜）
    for (const k of required) if (!has(props, k)) return SKIP;
    const keys = withOptional ? Object.keys(props) : required;
    const out: Rec = {};
    for (const k of keys) {
      const v = sample(props[k], doc, withOptional, depth + 1);
      if (v === SKIP) { if (required.includes(k)) return SKIP; continue; }
      out[k] = v;
    }
    return out;
  }
  return SKIP;
}

interface Branch {
  label: string;
  node: unknown;
}

function witnessOf(from: Branch, into: Branch, doc: unknown): string | undefined {
  for (const withOptional of [false, true]) {
    const inst = sample(from.node, doc, withOptional, 0);
    if (inst === SKIP) continue;
    // 自证：连自己都不满足的样本不可信（实现有 bug 时不拿它去指控 spec）
    if (matches(inst, from.node, doc, new Set()) !== 'pass') continue;
    if (matches(inst, into.node, doc, new Set()) === 'pass') return JSON.stringify(inst);
  }
  return undefined;
}

function collectOneOf(root: unknown): { at: string; branches: Branch[] }[] {
  const found: { at: string; branches: Branch[] }[] = [];
  const stack = new WeakSet<object>();
  // 栈而非已访问集：YAML 锚点造成的共享子图（DAG）要照常扫，只有回到栈上才算循环
  // ——与 validate-spec.ts 的 scanDocument 同一个理由。
  const walk = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      if (stack.has(node)) return;
      stack.add(node);
      node.forEach((el, i) => walk(el, `${path}[${i}]`));
      stack.delete(node);
      return;
    }
    if (!isRecord(node)) return;
    if (stack.has(node)) return;
    stack.add(node);
    for (const [k, v] of Object.entries(node)) {
      if (k === 'oneOf' && Array.isArray(v)) {
        found.push({
          at: `${path}.oneOf`,
          branches: v.map((b, i) => ({
            label: isRecord(b) && typeof b.$ref === 'string' ? (b.$ref.split('/').pop() ?? `#${i}`) : `#${i}`,
            node: b,
          })),
        });
      }
      walk(v, `${path}.${k}`);
    }
    stack.delete(node);
  };
  walk(root, 'spec');
  return found;
}

/** 找出全档所有"存在一个实例同时满足两支"的 oneOf。返回空数组只表示没举出证，
 *  不表示没有重叠 —— 不可判的分支对被静默跳过，这是本函数唯一的失败方向。 */
export function findUnionOverlaps(doc: unknown): UnionOverlap[] {
  const out: UnionOverlap[] = [];
  for (const u of collectOneOf(doc)) {
    if (u.branches.length < 2) continue;
    const resolved: (Branch & { skip: boolean })[] = u.branches.map((b) => {
      const node = resolveSchema(doc, b.node);
      return { ...b, node, skip: node === undefined || inconclusive(node, doc, new Set()) };
    });
    for (let i = 0; i < resolved.length; i++) {
      for (let j = i + 1; j < resolved.length; j++) {
        const a = resolved[i];
        const b = resolved[j];
        if (a.skip || b.skip) continue;
        const witness = witnessOf(a, b, doc) ?? witnessOf(b, a, doc);
        if (witness) out.push({ at: u.at, a: a.label, b: b.label, witness });
      }
    }
  }
  return out;
}
