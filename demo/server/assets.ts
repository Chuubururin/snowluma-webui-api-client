// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';

/**
 * 锚在源文件位置而不是 cwd：`join('demo','client')` 只在"从仓库根启动"时碰巧成立，
 * 换 cwd 起的服务端会把首页和客户端模块全 404 掉（实测非根目录启动返回 null）。
 */
const CLIENT_DIR = fileURLToPath(new URL('../client', import.meta.url));

/** 只允许 demo/client 下的 .ts，路径穿越直接拒——服务的是磁盘，不是猜谜。 */
export async function transpileClient(requestPath: string): Promise<string | null> {
  const rel = normalize(requestPath.replace(/^\/client\//, '')).replace(/^(\.\.[/\\])+/, '');
  if (rel.startsWith('..')) return null;
  const abs = join(CLIENT_DIR, rel);
  // brief 原式的矛盾：对外 URL 是 /client/app.js，而磁盘只存 .ts。这里把 .js 后缀映射回
  // .ts 源（浏览器端不存在 .js 源文件 ⇒ 下发的必然是剥过类型的 .ts，杜绝裸透传）。
  const absTs = abs.endsWith('.js') ? abs.slice(0, -3) + '.ts' : abs;
  if (extname(absTs) !== '.ts') return null;
  try {
    const src = await readFile(absTs, 'utf8');
    return transformSync(src, { loader: 'ts', target: 'es2022' }).code;
  } catch {
    return null;
  }
}

export async function renderIndex(): Promise<string | null> {
  try {
    return await readFile(join(CLIENT_DIR, 'index.html'), 'utf8');
  } catch {
    return null;
  }
}

/**
 * 样式表按原文下发：它没有类型要剥，而且不该过 esbuild —— 压缩会吃掉自定义属性与注释，
 * 而这份 CSS 的注释正是"为什么不是上游主题"的落点。守卫与上面同一条：只出 demo/client，只认 .css。
 */
export async function readClientCss(requestPath: string): Promise<string | null> {
  const rel = normalize(requestPath.replace(/^\/client\//, '')).replace(/^(\.\.[/\\])+/, '');
  if (rel.startsWith('..') || extname(rel) !== '.css') return null;
  try {
    return await readFile(join(CLIENT_DIR, rel), 'utf8');
  } catch {
    return null;
  }
}
