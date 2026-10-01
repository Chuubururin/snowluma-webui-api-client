// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
/**
 * 契约门禁：客户端调用面 ⊆ 生产路由表。
 *
 * 这条断言存在的理由是它**曾经缺席**，而缺席的代价是整只 demo 客户端跑不起来：
 * 40d8492 把 start.ts 的路由来源从手写 `.ts` 换成生成 `.gen.ts`，声称「715 tests pass，零回归」。
 * 但六张面板的测试都直接 import 手写模块，生产装配点 `collectRoutes()` 全仓只有 demo-gates.test.ts
 * 走过一次、且只验门禁。生成表是上游路径的 1:1 镜像（`GET /status`），客户端调的是 demo 语义路径
 * （`GET /overview`）—— 两者交集为零，首屏就 404，而测试全绿。
 *
 * 判据只能建立在**生产真正装配的那张表**上，而不是建立在某张路由模块的导出上：
 * 所以这里 import 的是 start.ts 的 collectRoutes()，路径来自客户端源码的实际调用。
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectRoutes } from '../demo/server/start.js';
import { clientCallPaths, clientRequests } from './lib/client-call-paths.js';

/** 生产路由表的完整键（`METHOD path`），剥掉查询串 —— 路由器按 `${method} ${pathname}` 精确取键。 */
function registeredKeys(table: Record<string, unknown>): Set<string> {
  return new Set(Object.keys(table));
}

describe('客户端调用面 ↔ 生产路由表契约', () => {
  it('路由表来自生产装配点，且非空', () => {
    const keys = Object.keys(collectRoutes() as Record<string, unknown>);
    expect(keys.length).toBeGreaterThan(40);
  });

  /**
   * 比的是「方法+路径」而不是只比路径：demo 路由器用 `${method} ${pathname}` 做键，
   * 只比路径会放过一整类真实故障 —— 客户端用 GET 打 POST-only 的 `/backup-import`，
   * 路径门禁全绿而浏览器 404。这条与 e2e 里的反向自证配对，方法与路径同时才成立。
   */
  it('客户端每一条请求（方法+路径）都在生产路由表里注册', async () => {
    const reqs = (await clientRequests('demo/client')).filter((r) => !r.path.startsWith('http'));
    const registered = registeredKeys(collectRoutes() as Record<string, unknown>);
    const missing = reqs
      .map((r) => `${r.method} ${r.path.split('?')[0]}`)
      .filter((key) => !registered.has(key))
      .sort();
    // 报错时把差集原样列出：这条断言失败意味着某块面板在真实浏览器里整块打不开。
    expect(missing).toEqual([]);
  });

  it('调用面不是空集，且 GET/POST 两类都在（正则失效时上一条会假绿）', async () => {
    const paths = await clientCallPaths('demo/client');
    const reqs = await clientRequests('demo/client');
    expect(paths.size).toBeGreaterThanOrEqual(20);
    expect(paths.has('/overview')).toBe(true);
    expect(paths.has('/gate/state')).toBe(true);
    expect(reqs.some((r) => r.method === 'POST')).toBe(true);
  });

  /**
   * 门禁看得见的路由 ↔ 生产真正注册的路由，必须双向相等。
   *
   * 这条补的是 P0 的另一半。`check-ui-coverage.ts` 的 `tsFiles()` 排除了 `.gen.ts`
   * （5f61e0d 为了让门禁变绿而加的），于是它对生成路由完全失明：生产换成 `.gen.js` 之后，
   * 门禁评的是手写那张表（`GET /overview`），生产服务的是生成那张（`GET /status`），
   * 两边各自全绿、永远撞不上。把"门禁口径"钉在"生产口径"上，换来源就会红。
   */
  it('门禁可见路由 == 生产注册路由（生成面不得偷渡）', async () => {
    const prod = new Set(Object.keys(collectRoutes() as Record<string, unknown>));
    const analyzed = new Set<string>();
    const keysIn = async (file: string, skipGen = false) => {
      const src = await readFile(file, 'utf8');
      if (skipGen && file.endsWith('.gen.ts')) return;
      for (const m of src.matchAll(/'(GET|POST|PUT|DELETE) ([^']+)'/g)) analyzed.add(`${m[1]} ${m[2]}`);
    };
    for (const e of await readdir('demo/server/routes', { withFileTypes: true })) {
      if (e.isFile() && e.name.endsWith('.ts')) await keysIn(join('demo/server/routes', e.name), true);
    }
    await keysIn('demo/server/start.ts');

    const onlyGate = [...analyzed].filter((k) => !prod.has(k)).sort();
    const onlyProd = [...prod].filter((k) => !analyzed.has(k)).sort();
    expect({ onlyGate, onlyProd }).toEqual({ onlyGate: [], onlyProd: [] });
    expect(analyzed.size).toBeGreaterThan(40);
  });
});
