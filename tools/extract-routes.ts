// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
import { readFile } from 'node:fs/promises';

export interface RouteOp {
  method: string;
  path: string;
  file: string;
  line: number;
}

export class NonLiteralRouteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NonLiteralRouteError';
  }
}

// 只匹配 `app.<verb>(`、`app.use(` 与 `app.route(`。\b 保证 someApp.get( 不匹配。
// route 是设计口径三种破坏正则形态之一（挂载子应用），命中即抛，见循环内的守卫 0。
const CALL = /\bapp\.(get|post|put|delete|patch|use|route)\s*\(/g;

function lineAt(src: string, index: number): number {
  return src.slice(0, index).split('\n').length;
}

export function extractRoutesFromSource(source: string, fileLabel: string): RouteOp[] {
  const ops: RouteOp[] = [];
  CALL.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CALL.exec(source))) {
    const method = m[1];
    const isRoute = method !== 'use' && method !== 'route';
    const rest = source.slice(m.index + m[0].length);
    const line = lineAt(source, m.index);
    const quote = rest[0];

    // 守卫 0（设计口径第三形）：app.route( 把整棵子路由挂在运行时值上，被挂载的操作对本正则不可见，
    // 命中即终止。不看第一个实参的形态——挂载点写不写字面量都不改变"子树不可见"这个事实。
    //
    // 明确**不做**：分类 app.use( 的第二个实参去抓 app.use('/x', subApp) 式挂载。真实上游
    // vendor/upstream/core/src/webui/server.ts:581 就是 `app.use('*', webuiSecurityHeaders)`——
    // 裸标识符传入的真中间件，与子应用在形状上无从区分，判定它等于在正确输入上中止抽取。
    // 同类假阳性已踩过一次（整文件拼接扫描误命中 foo(bar + baz)），守卫保持参数局部化。
    // 残余盲区登记于此而非掩盖：app.use 形态的挂载仍会漏，兜底是设计口径的 59/55 计数断言＋人工核对。
    if (method === 'route') {
      throw new NonLiteralRouteError(
        `${fileLabel}:${line} 检测到 app.route( 挂载形态，被挂载的操作正则抽取不可见，请改用 AST 方案`,
      );
    }

    // 守卫 1：第一个实参必须以引号开头
    if (quote !== "'" && quote !== '"') {
      if (isRoute) {
        throw new NonLiteralRouteError(
          `${fileLabel}:${line} 路由首参非字符串字面量，正则抽取不可靠，请改用 AST 方案`,
        );
      }
      continue;
    }

    const close = rest.indexOf(quote, 1);
    const path = rest.slice(1, close);

    // 守卫 2：闭合引号后首个非空白字符必须是 , 或 )，否则存在拼接
    const after = close === -1 ? '' : rest.slice(close + 1).trimStart()[0];
    if (after !== ',' && after !== ')') {
      if (isRoute) {
        throw new NonLiteralRouteError(
          `${fileLabel}:${line} 路由路径疑似字符串拼接（${path}），正则抽取不可靠，请改用 AST 方案`,
        );
      }
      continue;
    }

    if (!isRoute) continue;
    ops.push({ method: method.toUpperCase(), path, file: fileLabel, line });
  }
  return ops;
}

export function isApiOp(path: string): boolean {
  return path.startsWith('/api/');
}

export async function extractRoutes(
  files: { repoPath: string; localPath: string }[],
): Promise<RouteOp[]> {
  const ops: RouteOp[] = [];
  for (const f of files) {
    ops.push(...extractRoutesFromSource(await readFile(f.localPath, 'utf8'), f.repoPath));
  }
  return ops;
}
