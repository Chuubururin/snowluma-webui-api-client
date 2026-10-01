// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
/**
 * 样式表的两条不变量，方向相反，缺一条就挡不住这次的病：
 *  1. markup 写出去的每个类都必须有定义 —— 客户端从第一天起就在写 `class="tiles"`、`err`、`kv`，
 *     而仓里没有任何 CSS。那不是"暂时朴素"：那些类名在向读代码和读界面的人谎报"样式已就绪"。
 *  2. 样式表里的每个类都必须真被用到 —— 否则下一轮又会攒出一批没人认领的死规则。
 * 两条都机器判定。动态类位（`${tone}`、`class="' + (r.ok ? 'ok' : 'no') + '"`）静态扫描看不见取值，
 * 所以按处数执法：新增一处而没在这里登记取值，条数断言先红。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildHandler } from '../demo/server/index.js';
import { createUpstream } from '../demo/server/upstream.js';
import { fakeRes } from './helpers/demo-http.js';

const CLIENT_DIR = 'demo/client';
const CSS_FILE = join(CLIENT_DIR, 'styles.css');

/** spec 的 LogLevel 枚举（`common/src/logger.ts:155`）。级别格子按它逐个上色，故同源校验。 */
function logLevels(): string[] {
  const spec = readFileSync('spec/openapi.yaml', 'utf8');
  const m = /LogLevel:[\s\S]{0,200}?enum: \[([^\]]+)\]/.exec(spec);
  if (!m) throw new Error('spec 里找不到 LogLevel 枚举：这条测试的前提没了，得改测试或改 spec');
  return m[1].split(',').map((s) => s.trim());
}

const LV_CLASSES = logLevels().map((l) => `lv-${l}`);

/**
 * 动态类位登记的取值：
 *  · `active` —— 调试页动作目录里选中的那一条（`pages/debug.ts:129`）
 *  · `ok` / `err` —— 测试结果与动作层状态（`pages/debug.ts:200`、`pages/config.ts:360,421`）
 *  · `no` —— 强度规则里"还没满足"的那一项（`pages/gate.ts:185`）
 */
const DYNAMIC_CLASSES = ['active', 'ok', 'err', 'no', ...LV_CLASSES];
const DYNAMIC_SITE_COUNT = 6;

function clientSources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...clientSources(p));
    else if (/\.(ts|html)$/.test(name)) out.push(p);
  }
  return out;
}

/** 扫遍 markup：静态 `class="a b"` 直接取，带 `${}` 或拼接的算一个动态位、值走 DYNAMIC_CLASSES。 */
function scan(): { statics: Set<string>; dynamicSites: number } {
  const statics = new Set<string>();
  let dynamicSites = 0;
  // 兜底选择器 `[class^="lv-"]` 的引号里也有 `lv-`，但它不是 markup 写出的类；
  // 只剥注释就把这条规则当 markup 扫进来了，集合会被撑出一个不存在的类。
  const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const file of clientSources(CLIENT_DIR)) {
    for (const line of stripComments(readFileSync(file, 'utf8')).split('\n')) {
      // 不要求同行有闭合引号：拼接形态会跨行（`pages/logs.ts:105` 的 `class="lv-' +` 就是一例），
      // 要求闭合就会把那两处漏成"没有动态位"，动态清单也就跟着失真。
      for (const m of line.matchAll(/class="([^"]*)/g)) {
        const value = m[1];
        if (value.includes('${') || value.includes("'")) {
          dynamicSites++;
          continue;
        }
        for (const t of value.split(/\s+/)) if (t) statics.add(t);
      }
    }
  }
  return { statics, dynamicSites };
}

/** CSS 里被选择器引用的类名。先剥注释：注释里的中文句号和反引号示例不算选择器。 */
function declaredClasses(css: string): Set<string> {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const set = new Set<string>();
  for (const m of bare.matchAll(/\.([a-zA-Z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*)/g)) set.add(m[1]);
  return set;
}

const css = readFileSync(CSS_FILE, 'utf8');
const declared = declaredClasses(css);
const { statics, dynamicSites } = scan();
const used = new Set<string>([...statics, ...DYNAMIC_CLASSES]);

const req = (url: string) =>
  ({ method: 'GET', url, headers: {}, async *[Symbol.asyncIterator]() {} }) as never;

describe('客户端样式表 (L2)', () => {
  it('扫描器确实扫到了东西（否则下面两条会在空集上白跑）', () => {
    expect(statics.size).toBeGreaterThan(15);
    expect(dynamicSites).toBe(DYNAMIC_SITE_COUNT);
  });

  it('markup 写出去的每个类都有定义（不留悬空类名）', () => {
    const dangling = [...used].filter((c) => !declared.has(c)).sort();
    expect(dangling, `这些类出现在界面 markup 里但样式表没有定义：${dangling.join(', ')}`).toEqual([]);
  });

  it('样式表里没有没人认领的类（不攒死规则）', () => {
    const dead = [...declared].filter((c) => !used.has(c)).sort();
    expect(dead, `样式表定义了但没有任何 markup 用到：${dead.join(', ')}`).toEqual([]);
  });

  it('外壳靠 hidden 属性切屏，样式表不许把它顶开', () => {
    // #gate/#main 由 app.ts 的 .hidden 切换；给它们设 display 而没有 [hidden] 兜底，
    // 表现就是"门禁还没过，主界面已经露出来"（设计口径明令禁止的那一屏）。
    expect(css).toMatch(/\[hidden\][\s\S]{0,80}display:\s*none\s*!important/);
  });

  it('每字段的提示槽是常驻空 div，空槽必须不占位', () => {
    // `pages/settings.ts:89-90` 为每个字段渲染一个常空的 `.err`/`.ok` 槽，出错才填文案。
    // 给这两类加红边底色而不处理 :empty，设置页就是 18 条没有字的红条（真浏览器走查抓到）。
    expect(css).toMatch(/\.err:empty[\s\S]{0,60}display:\s*none/);
  });

  it('/client/styles.css 按 text/css 原文下发，且拒路径穿越', async () => {
    const handler = buildHandler({}, createUpstream('http://127.0.0.1:5099'));
    const cap = fakeRes();
    await handler(req('/client/styles.css'), cap.res);
    expect(cap.status).toBe(200);
    expect(cap.headers['content-type']).toBe('text/css; charset=utf-8');
    // 原文下发（不过 esbuild）：自定义属性与注释都得留着
    expect(cap.body!).toContain('--danger:');
    expect(cap.body!).toBe(css);

    const out = fakeRes();
    await handler(req('/client/../../spec/openapi.css'), out.res);
    expect(out.status).not.toBe(200);
  });

  it('首页真的挂了这张表（写了不生效 = 没写）', () => {
    expect(readFileSync(join(CLIENT_DIR, 'index.html'), 'utf8')).toMatch(/<link[^>]+href="\/client\/styles\.css"/);
  });
});
