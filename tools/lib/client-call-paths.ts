// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

/** 一次浏览器出网：HTTP 方法 + 路径。 */
export interface ClientRequest {
  method: 'GET' | 'POST';
  path: string;
}

/**
 * 扫描客户端源码，收集浏览器真正发出的请求（`call(...)` 走 GET，`post(...)` 走 POST，
 * 裸 `fetch(...)` 按第一个实参所在调用推断）。
 *
 * 方法必须一起收：demo 路由表按 `${method} ${pathname}` 精确匹配，只比路径会比出一个
 * 假世界 —— 客户端把 POST-only 的 `/backup-import` 当 GET 打，路径门禁全绿而浏览器 404。
 *
 * 只认字面量，模板串在 `${` 处截断（`/probe-login?pid=${…}` → `/probe-login?pid=`），
 * 查询串由调用方 `split('?')[0]` 剥。调用方必须自带"结果非空"断言：这里的正则一旦失配，
 * 下游会拿到空集，并把"所有路径都不存在"判成"没有路径需要存在"。
 */
export async function clientRequests(dir: string, acc: Set<string> = new Set()): Promise<ClientRequest[]> {
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name !== 'node_modules') await clientRequests(p, acc);
      continue;
    }
    if (!ent.name.endsWith('.ts')) continue;
    const src = await readFile(p, 'utf8');
    for (const m of src.matchAll(/\b(call|post)(?:<[A-Za-z0-9<>[\]{} ,.]*>)?\(\s*['"`]([^'"`$]+)/g)) {
      acc.add(`${m[1] === 'post' ? 'POST' : 'GET'} ${m[2]}`);
    }
    // 裸 fetch() 的方法写在第二个实参里，必须读出来：`/events/action` 是 POST-only，
    // 默认成 GET 会把一条正常工作的流调用报成 404。
    for (const m of src.matchAll(/\bfetch\(\s*['"`]([^'"`$]+)['"`]([\s\S]{0,220}?)\}/g)) {
      const method = /method\s*:\s*['"]POST['"]/.test(m[2]) ? 'POST' : 'GET';
      acc.add(`${method} ${m[1]}`);
    }
  }
  return [...acc].sort().map((line) => {
    const sp = line.indexOf(' ');
    return { method: line.slice(0, sp) as ClientRequest['method'], path: line.slice(sp + 1) };
  });
}

/** 只要路径集合（不比方法）的调用方用的便捷视图。 */
export async function clientCallPaths(dir: string): Promise<Set<string>> {
  return new Set((await clientRequests(dir)).map((r) => r.path));
}
