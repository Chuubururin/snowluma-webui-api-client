// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
// 裁定 R18（Go 批次实现批次）：校验器原先手抄的三样事实——匿名白名单、x-snowluma-destructive
// 必标集、uin path 参数的精确 pattern——从此处从锚定的 server.ts **文本**派生，一处改动
// 上游、校验器即抛错变红。三处上游锚点与记法差异（见各抽取函数注释）都是实测核对过的
// 映射，任何"抽取不到"一律 throw，绝不回退硬编码——静默回退等于把守卫变成装饰。
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { UPSTREAM_FILES, VENDOR_DIR, localPathFor } from './upstream.js';

// server.ts 的仓库内路径不做第二份字面量：从 UPSTREAM_FILES（tools/lib/upstream.ts 的
// 唯一真源）里筛出。锚定面里没有它时模块加载即抛错——三样派生集合全部失去锚点，
// 这本身就是该被看见的红。
export const SERVER_TS_REPO_PATH: string = (() => {
  const hit = (UPSTREAM_FILES as readonly string[]).find((p) => p.endsWith('webui/server.ts'));
  if (!hit) throw new Error('upstream-guards：UPSTREAM_FILES 里没有 webui/server.ts，三样派生集合失去锚点');
  return hit;
})();

export interface SpecGuards {
  /** 匿名豁免集：auth 中间件里 `if (reqPath === ...) return next();` 的散列字符串 */
  anonymousAllowed: ReadonlySet<string>;
  /** 必标 x-snowluma-destructive 集：处理器调用 invokeAction/invokeStream 的 POST 注册路径 */
  destructiveRequired: readonly string[];
  /** uin path 参数的精确 pattern（spec 侧 [0-9] 记法，从 UIN_REGEX 正则字面量规范化而来） */
  uinParamPattern: string;
  /** 改密闸豁免表：`MUST_CHANGE_ALLOWLIST` 的字面量（X1，N6 的 403 资格执法用） */
  mustChangeAllowlist: readonly string[];
  /** 同意闸豁免表：`CONSENT_ALLOWLIST` 的字面量（X1，同上） */
  consentAllowlist: readonly string[];
}

const fail = (what: string, detail: string): Error =>
  new Error(`upstream-guards：锚定 ${SERVER_TS_REPO_PATH} 派生失败（${what}）：${detail}。` +
    '不允许回退硬编码——上游结构变了就请你来看，这正是单源守卫的红法');

// 锚点：server.ts auth 中间件（app.use('/api/*')）里唯一的匿名豁免 if。
// 只认"reqPath === '<path>' 以 || 串接、紧跟 return next();"这一形。上游重构成 Set 或
// 助手函数时这里匹配不上、抛错变红，而不是静默沿用旧白名单。
function extractAnonymousAllowed(text: string): Set<string> {
  const stmt = text.match(/if \(((?:reqPath === '[^']+'(?: \|\| )?)+)\) return next\(\);/);
  if (!stmt) throw fail('匿名白名单', '找不到形如 if (reqPath === ... ) return next(); 的豁免语句');
  const paths = [...stmt[1].matchAll(/reqPath === '([^']+)'/g)].map((m) => m[1]);
  if (paths.length === 0) throw fail('匿名白名单', '豁免语句里没有 reqPath === 字面量');
  return new Set(paths);
}

// 锚点：app.post('<path>', ...) 注册中、处理器调用 invokeAction( / invokeStream( 的那些。
// 这就是裁定 R20 的"两道闸门"在上游的真身（:1293 与 :1312 的注释明写 Real side effects），
// /api/debug/upload 虽是同前缀 POST 但处理器不动作调用，故不在集内。
// 窗口取法：本注册到下一处顶层 app. 调用之间——实测本文件的处理器体内不再出现顶层 app.
// 调用（handlers 一律用 c. 对象）。上游若在该层重构（路由表抽离等），窗口假设失效即抛错。
function extractDestructiveRequired(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/app\.post\('([^']+)'/g)) {
    const rest = text.slice((m.index ?? 0) + m[0].length);
    const nextApp = rest.search(/\n\s*app\./);
    const window = nextApp === -1 ? rest : rest.slice(0, nextApp);
    if (/\binvokeAction\(|\binvokeStream\(/.test(window)) out.push(m[1]);
  }
  if (out.length === 0) throw fail('必标集', '没有任何 POST 注册的处理调用 invokeAction( / invokeStream(');
  return out;
}

// 锚点：const UIN_REGEX = /.../ ; 声明。记法差异在此显式处理：上游是正则字面量（\d 字符类），
// spec 侧的 pattern 字符串用 [0-9] 记法——语义等价（JS 非 /u 形态下 \d ≡ [0-9]），但形状
// 不同，抽取时规范化为 spec 记法，不假设两边同形。只认"锚 ^ + 单字符类（\d 或 [0-9]）+
// {lo,hi} + 锚 $"这一形；旗标、多选、其它量词一律抛错请人复核，不得静默猜测语义。
function extractUinParamPattern(text: string): string {
  const decl = text.match(/const UIN_REGEX = \/(?<body>.+)\/(?<flags>[a-z]*);/);
  if (!decl || !decl.groups) throw fail('uin 模式', '找不到 const UIN_REGEX = /.../ 声明');
  const { body, flags } = decl.groups;
  if (flags) throw fail('uin 模式', `UIN_REGEX 带旗标 /${flags}/，记法语义需人工复核`);
  const shape = body.match(/^\^(\\d|\[0-9\])\{(\d+),(\d+)\}\$$/);
  if (!shape) throw fail('uin 模式', `UIN_REGEX 记法 /${body}/ 超出派生器认识的形状（^（\\d|[0-9]）{lo,hi}$）`);
  return `^[0-9]{${shape[2]},${shape[3]}}$`;
}

// 锚点：`const MUST_CHANGE_ALLOWLIST = new Set([...])` 与
// `const CONSENT_ALLOWLIST = new Set([...])`（server.ts:206-216/:223-229）。
// 只认 `const NAME = new Set([` 开头、方括号内全是单引号字面量的形状；上游改记法
// （数组、Map、外部表）即匹配不上、抛错变红。注释行（`//`）先剥掉再取字面量，
// 避免注释里的示例路径混入集合。
function extractAllowlist(text: string, name: string): string[] {
  const decl = text.match(new RegExp(`const ${name} = new Set\\(\\[([\\s\\S]*?)\\]\\);`));
  if (!decl) throw fail('闸门表', `找不到 const ${name} = new Set([...]) 声明`);
  const paths = [...decl[1].replace(/\/\/[^\n]*/g, '').matchAll(/'([^']+)'/g)].map((m) => m[1]);
  if (paths.length === 0) throw fail('闸门表', `${name} 里没有字符串字面量`);
  return paths;
}

// 纯函数：给定 server.ts 全文，产出五样守卫值。抽取失败一律 throw，无默认值可退。
export function deriveSpecGuards(serverText: string): SpecGuards {
  return {
    anonymousAllowed: extractAnonymousAllowed(serverText),
    destructiveRequired: extractDestructiveRequired(serverText),
    uinParamPattern: extractUinParamPattern(serverText),
    mustChangeAllowlist: extractAllowlist(serverText, 'MUST_CHANGE_ALLOWLIST'),
    consentAllowlist: extractAllowlist(serverText, 'CONSENT_ALLOWLIST'),
  };
}

// 校验器的消费入口：经 localPathFor 读锚定缓存（VENDOR_DIR 是唯一字面量，路径不抄第二份）。
// 同步形态是因为 validateSpecDoc 是同步纯函数；async 变体给 CLI 预热用。
export function loadSpecGuardsSync(dir = VENDOR_DIR): SpecGuards {
  const local = localPathFor(SERVER_TS_REPO_PATH, dir);
  let text: string;
  try {
    text = readFileSync(local, 'utf8');
  } catch (e) {
    throw fail('读取', `缓存不可读 ${local}（${(e as NodeJS.ErrnoException).code ?? (e as Error).message}），请重新拉取上游`);
  }
  return deriveSpecGuards(text);
}

export async function loadSpecGuards(dir = VENDOR_DIR): Promise<SpecGuards> {
  const local = localPathFor(SERVER_TS_REPO_PATH, dir);
  let text: string;
  try {
    text = await readFile(local, 'utf8');
  } catch (e) {
    throw fail('读取', `缓存不可读 ${local}（${(e as NodeJS.ErrnoException).code ?? (e as Error).message}），请重新拉取上游`);
  }
  return deriveSpecGuards(text);
}
