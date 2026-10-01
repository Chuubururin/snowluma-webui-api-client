// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
import { describe, expect, it } from 'vitest';
import { buildInventory } from './inventory.js';
import type { RouteOp } from './extract-routes.js';
import type { ModelExport } from './extract-models.js';

const op = (method: string, path: string, line: number): RouteOp => ({ method, path, file: 'x.ts', line });

describe('buildInventory', () => {
  it('按 METHOD /path 字典序输出，与输入顺序无关（否则一次上游文件重排就整片变红）', () => {
    // 路径必须带 /api/ 前缀：isApiOp 是 buildInventory 的滤网，/a 会被正确滤掉（brief 原稿此处自相矛盾，以代码为准改测试）
    const a = buildInventory([op('GET', '/api/b', 2), op('GET', '/api/a', 1)], []);
    const b = buildInventory([op('GET', '/api/a', 1), op('GET', '/api/b', 2)], []);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.routes.map((r) => r.key)).toEqual(['GET /api/a', 'GET /api/b']);
  });

  it('每条都带 file 与 line —— 撰写 spec 的人要能一步跳回源码，不能只给个键', () => {
    const inv = buildInventory([op('POST', '/api/login', 669)], []);
    expect(inv.routes[0]).toEqual({ key: 'POST /api/login', method: 'POST', path: '/api/login', file: 'x.ts', line: 669 });
  });

  it('模型条目同样排序并带 name', () => {
    // ModelExport 的四个字段（name/kind/file/line）都是必填，样本必须给全 —— 少一个就是 TS2352
    const me = (name: string, file: string): ModelExport => ({ name, kind: 'interface', file, line: 1 });
    const inv = buildInventory([], [me('Zed', 'a.ts'), me('Abe', 'a.ts')]);
    expect(inv.models.map((m) => m.name)).toEqual(['Abe', 'Zed']);
  });

  it('非 /api/ 路径必须被 isApiOp 挡在清单外（删掉那行 filter 这条就要红，而不是静默变 59 条）', () => {
    expect(buildInventory([op('GET', '/health', 1), op('GET', '/avatar/123', 2)], []).routes).toEqual([]);
    expect(buildInventory([op('GET', '/api/health', 3)], []).routes.map((r) => r.key)).toEqual(['GET /api/health']);
  });

  it('落盘的模型清单按文件分组后必须与 anchor.expectedModels 逐键相等（不靠人跑 CLI 用眼睛比）', async () => {
    // 钉住 inventory.ts CLI 分支里对 isModelSource 的消费：换成 `() => true` 会混入
    // packages/core/src/webui/server.ts 等非模型源文件，byFile 立即与锚点不符。
    // 锚点两侧是 packages/webui/src/types.ts（领域模型，76 个导出）与
    // packages/webui/src/lib/api/types.ts（客户端 API 类型，19 个导出）。
    const fs = await import('node:fs/promises');
    const models = JSON.parse(await fs.readFile('extracted/models.json', 'utf8')) as { file: string }[];
    const anchor = JSON.parse(await fs.readFile('spec/anchor.json', 'utf8')) as { expectedModels: Record<string, number> };
    const byFile: Record<string, number> = {};
    for (const m of models) byFile[m.file] = (byFile[m.file] ?? 0) + 1;
    expect(byFile).toEqual(anchor.expectedModels);
  });
});
