// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
import { mkdir, writeFile } from 'node:fs/promises';
import { isCliEntry } from './lib/cli.js';
import { extractRoutes, isApiOp, type RouteOp } from './extract-routes.js';
import { extractModels, type ModelExport } from './extract-models.js';
import { isModelSource, localPathFor, UPSTREAM_FILES } from './lib/upstream.js';

export interface Inventory {
  routes: { key: string; method: string; path: string; file: string; line: number }[];
  models: { file: string; name: string }[];
}

const byDict = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function buildInventory(ops: RouteOp[], models: ModelExport[]): Inventory {
  return {
    routes: ops
      .filter((o) => isApiOp(o.path))
      .map((o) => ({ key: `${o.method} ${o.path}`, method: o.method, path: o.path, file: o.file, line: o.line }))
      .sort((x, y) => byDict(x.key, y.key)),
    models: models
      .map((m) => ({ file: m.file, name: m.name }))
      // 先 file 再 name；NUL 作分隔是为了让 ("a","bc") 与 ("ab","c") 不被拼成同一个键
      .sort((x, y) => byDict(`${x.file}\u0000${x.name}`, `${y.file}\u0000${y.name}`)),
  };
}

if (isCliEntry(import.meta.url, process.argv[1])) {
  const pairs = UPSTREAM_FILES.map((p) => ({ repoPath: p, localPath: localPathFor(p) }));
  // 模型侧先过 isModelSource：与 build-anchor 守同一个总体，否则 extracted/models.json 与
  // 锚点的 expectedModels 各数各的（把这条谓词收成导出就是为了不让它两处漂移）。
  const modelPairs = pairs.filter((p) => isModelSource(p.repoPath));
  const [ops, models] = await Promise.all([extractRoutes(pairs), extractModels(modelPairs)]);
  const inv = buildInventory(ops, models);
  // writeFile 不建父目录；extracted/ 本任务首次创建
  await mkdir('extracted', { recursive: true });
  await writeFile('extracted/routes.json', JSON.stringify(inv.routes, null, 2) + '\n');
  await writeFile('extracted/models.json', JSON.stringify(inv.models, null, 2) + '\n');
  console.log(`extracted/: ${inv.routes.length} routes, ${inv.models.length} models`);
}
