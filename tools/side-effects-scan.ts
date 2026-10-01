// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
import { readFile } from 'node:fs/promises';
import { isCliEntry } from './lib/cli.js';
import { REPLAY_CLASS_BY_OP, type ReplayClass, type SideEffectLabel } from './lib/tiers.js';
import { localPathFor, VENDOR_DIR } from './lib/upstream.js';

// 词表真源在 lib/tiers.ts 的 SIDE_EFFECT_LABELS（裁定 R18 的同一处理，见那里的注释）：
// 本表的 label 由该类型约束，新增/改名必须两边同步，且 side-effects-scan.test.ts 用
// CHECKER_LABELS 与 SIDE_EFFECT_LABELS 逐位相等钉住顺序——只保证"是同一集合"的话，
// 一次重排就会让设计口径的表格与扫描器输出的次序对不上。
const CHECKERS: { label: SideEffectLabel; re: RegExp }[] = [
  { label: 'persist', re: /\bpersist[A-Z]\w*\(|persist\w*\(/ },
  { label: 'save', re: /\bsave[A-Z]\w*\(|saveConfig\(|writeRuntimeConfig\(/ },
  { label: 'clear', re: /\.clear\(\)/ },
  { label: 'delete-or-write-fs', re: /\b(unlink|rm|writeFile|appendFile|mkdir)\w*Sync?\(|deleteCookie\(/ },
  { label: 'cookie', re: /\bset[A-Z]\w*Cookie\(|setCookie\(/ },
  { label: 'external-fetch', re: /\bfetch\(\s*['"`]https?:/ },
  { label: 'mutate-map', re: /\.\s*set\(\s*[^,]+,\s*\{/ },
];

/** CHECKERS 的标签序列，导出只为让"与词表逐位相等"这条测试可写。 */
export const CHECKER_LABELS: readonly SideEffectLabel[] = CHECKERS.map((c) => c.label);

export function detectWrites(handlerBody: string): SideEffectLabel[] {
  const hits = new Set<SideEffectLabel>();
  for (const c of CHECKERS) if (c.re.test(handlerBody)) hits.add(c.label);
  return [...hits];
}

// 跳过 `'...'` / `"..."` / `` `...` `` 字面量，返回结束引号的下标（未闭合则返回串尾）。
function skipLiteral(src: string, open: number, quote: string): number {
  for (let j = open + 1; j < src.length; j += 1) {
    if (src[j] === '\\') { j += 1; continue; } // 转义引号不结束字面量
    if (src[j] === quote) return j;
  }
  return src.length;
}

export function extractHandler(source: string, method: string, path: string): string {
  // method 必须进匹配：同一 path 可被两种方法注册（GET/POST /api/logs/level 即是），
  // 只按 path 找会取到另一方法的处理器。path 里的 `:uin`/`:pid` 按源码原样出现，
  // 但正则元字符仍须转义。
  const needle = new RegExp(`\\bapp\\.${method.toLowerCase()}\\(\\s*['"\`]${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"\`]`);
  const m = needle.exec(source);
  if (!m) return '';
  const start = source.indexOf('(', m.index);
  let depth = 0;
  // 括号配平必须跳过字符串/模板/注释内容：上游注释里就写着 "(for example …)" 和
  // "(e.g. a future headless mode)"，一旦某处的括号不成对（`const tip = '重试 (1 次'`），
  // 朴素计数会提前收尾——被截掉的后半段正是副作用所在，检出结果会**静默变成无副作用**。
  // 这与设计口径对抽取器的要求同一种失效模式（静默漏抽），此处按同一要求防住。
  // 残余盲区（当前语料实测不存在，故不额外处理）：处理器体内的正则字面量含不成对括号
  // （`/\\(/`）或模板串 `${}` 里再嵌反引号，都会让这里的词法判断出错。
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "'" || ch === '"' || ch === '`') { i = skipLiteral(source, i, ch); continue; }
    if (ch === '/' && source[i + 1] === '/') { const eol = source.indexOf('\n', i); i = eol === -1 ? source.length : eol; continue; }
    if (ch === '/' && source[i + 1] === '*') { const end = source.indexOf('*/', i + 2); i = end === -1 ? source.length : end + 1; continue; }
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return source.slice(m.index, i + 1);
    }
  }
  return source.slice(m.index);
}

/** 扫描输出的取值：词表标签，或"处理器没抽到"这条哨兵（它不是词表成员，故独立union）。 */
export type ScanLabel = SideEffectLabel | 'handler-not-found';

export interface HandlerEvidence {
  opKey: string;
  handlerBody: string;
  writes: ScanLabel[];
}

// 抽取 + 打标的完整证据链：handlerBody 一并带出，人工核对（Step 5）必须看得到被扫的到底是哪段源码。
// 找不到处理器时 handlerBody 为空串、writes 只有 handler-not-found——抽取本身出错时不得静默通过。
export async function collectEvidence(classes: ReplayClass[]): Promise<HandlerEvidence[]> {
  const sources = await Promise.all(
    ['packages/core/src/webui/server.ts', 'packages/core/src/webui/storage-routes.ts'].map((p) =>
      readFile(localPathFor(p, VENDOR_DIR), 'utf8'),
    ),
  );
  const rows: HandlerEvidence[] = [];
  for (const [key, cls] of Object.entries(REPLAY_CLASS_BY_OP)) {
    if (!classes.includes(cls)) continue;
    const [method, path] = [key.slice(0, key.indexOf(' ')), key.slice(key.indexOf(' ') + 1)];
    const body = sources.map((s) => extractHandler(s, method, path)).find((b) => b) ?? '';
    rows.push({ opKey: key, handlerBody: body, writes: body ? detectWrites(body) : ['handler-not-found'] });
  }
  return rows;
}

export async function scan(classes: ReplayClass[]): Promise<{ opKey: string; writes: ScanLabel[] }[]> {
  return (await collectEvidence(classes)).map(({ opKey, writes }) => ({ opKey, writes }));
}

if (isCliEntry(import.meta.url, process.argv[1])) {
  const rows = await scan(['t1', 't2']);
  // 全集逐行打印（含零标记者）：本工具的全部价值是"保证 32 条无一遗漏"，
  // 只印检出项的话，输出看不出扫过谁——漏抽一条与一条真无副作用长得一样。
  for (const r of rows) console.log(r.opKey, '→', r.writes.length ? r.writes.join(', ') : '(无标记)');
  console.log(`扫描 ${rows.length} 个 T1/T2 操作，${rows.filter((r) => r.writes.length).length} 个检出副作用`);
}
