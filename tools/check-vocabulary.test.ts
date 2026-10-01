// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
/**
 * 词表完备性门禁（关掉解耦计划的 C10 / C11）。
 *
 * 三向相等里只核两向：spec 操作集 ↔ 词表键集。第三向（SDK 导出集）放在生成期，
 * 因为 `generated/` 被 gitignore，冷克隆里没有它 —— 门禁若去读它，全新检出必红，
 * 而"门禁在干净树上跑不起来"等于门禁不存在。SDK 那一腿由 `gen:check`（重新生成后
 * `git diff --exit-code demo/`）在 CI 里补上：SDK 变了而词表没变 ⇒ diff 非空 ⇒ 红。
 *
 * 只读入库文件：spec/openapi.yaml + demo/vocabulary.gen.ts + 手写路由与手写 parity。
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import {
  ANONYMOUS_OPERATIONS,
  GATE_OPERATIONS,
  OPERATION_IDS,
  SSE_OPERATIONS,
  VOCABULARY,
} from '../demo/vocabulary.gen.js';
import { PARITY } from '../demo/parity.js';

interface SpecOp {
  operationId: string;
  method: string;
  path: string;
}

async function specOperations(): Promise<SpecOp[]> {
  const doc = parse(await readFile('spec/openapi.yaml', 'utf8')) as {
    paths: Record<string, Record<string, { operationId?: string }>>;
  };
  const out: SpecOp[] = [];
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(item)) {
      // patch 显式不在词表口径内（与 validate-spec/drift 的 METHODS 含 patch 不同）：
      // 上游 WebUI 当前没有任何 PATCH 端点。spec 一旦加 patch，validate-spec 会报
      // UNCLASSIFIED_OP 而这里静默漏出——口径分歧以红的方式暴露，别静默对齐。
      if (!['get', 'post', 'put', 'delete'].includes(method)) continue;
      if (typeof op?.operationId !== 'string') continue;
      out.push({ operationId: op.operationId, method: method.toUpperCase(), path });
    }
  }
  return out;
}

/** 手写路由源码；`*.gen.ts` 不参与——拿生成产物里的 sdk.X( 去验词表是循环论证。 */
async function handwrittenRouteSources(): Promise<Record<string, string>> {
  const dir = 'demo/server/routes';
  const out: Record<string, string> = {};
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    if (ent.isFile() && ent.name.endsWith('.ts') && !ent.name.endsWith('.gen.ts')) {
      out[ent.name] = await readFile(join(dir, ent.name), 'utf8');
    }
  }
  return out;
}

describe('词表完备性（C10 / C11）', () => {
  it('词表非空，且条数与 spec 一致（防空头表静默通过）', async () => {
    const spec = await specOperations();
    expect(OPERATION_IDS.length).toBeGreaterThan(40);
    expect(OPERATION_IDS.length).toBe(spec.length);
  });

  /**
   * 同一份事实的两个视图必须重合。
   * 这条是被自己的变异检验逼出来的：删掉 VOCABULARY 里一个词条、保留 OPERATION_IDS 里同名一项，
   * 前面所有断言全部照绿 —— 因为集合相等比的是 OPERATION_IDS，而逐字校验只遍历 VOCABULARY。
   * 生成器一旦在两张表上出错（少发一行、排序去重不一致），没有这条就无人发现。
   */
  it('VOCABULARY 键集与 OPERATION_IDS 逐元素相等（两个视图不许分叉）', () => {
    const keys = Object.keys(VOCABULARY).sort();
    const list = [...OPERATION_IDS].sort();
    expect(keys.length, 'VOCABULARY 词条数 ≠ OPERATION_IDS 条数').toBe(list.length);
    expect(keys.filter((x) => !OPERATION_IDS.includes(x)), 'VOCABULARY 有而 OPERATION_IDS 没有').toEqual([]);
    expect(list.filter((x) => !keys.includes(x)), 'OPERATION_IDS 有而 VOCABULARY 没有').toEqual([]);
  });

  it('spec 操作集 ↔ 词表键集逐元素相等（双向）', async () => {
    const spec = await specOperations();
    const a = new Set(spec.map((o) => o.operationId));
    const b = new Set(OPERATION_IDS);
    expect([...a].filter((x) => !b.has(x)).sort(), 'spec 有而词表没有').toEqual([]);
    expect([...b].filter((x) => !a.has(x)).sort(), '词表有而 spec 没有（凭空发明）').toEqual([]);
  });

  it('每条词表成员的方法与上游路径都和 spec 逐字相同', async () => {
    const byId = new Map((await specOperations()).map((o) => [o.operationId, o]));
    const wrong: string[] = [];
    for (const [id, entry] of Object.entries(VOCABULARY)) {
      const src = byId.get(id);
      if (!src) continue; // 集合差由上一条断言负责
      if (entry.method !== src.method) wrong.push(`${id} 方法 ${entry.method} ≠ spec ${src.method}`);
      if (entry.path !== src.path) wrong.push(`${id} 路径 ${entry.path} ≠ spec ${src.path}`);
    }
    expect(wrong).toEqual([]);
  });

  it('SSE / 门禁 / 匿名三张子表都非空且 ⊆ 词表', () => {
    for (const [name, list] of [
      ['SSE_OPERATIONS', SSE_OPERATIONS],
      ['GATE_OPERATIONS', GATE_OPERATIONS],
      ['ANONYMOUS_OPERATIONS', ANONYMOUS_OPERATIONS],
    ] as const) {
      expect(list.length, `${name} 为空 ⇒ 该维度没有任何东西在被管`).toBeGreaterThan(0);
      expect(list.filter((x) => !OPERATION_IDS.includes(x)), `${name} 含不在词表里的操作`).toEqual([]);
    }
  });

  /**
   * 手写面不许发明不存在的操作（解耦计划 T4.4 的断言 8）。
   * `demo/parity.ts` 每条边手工列 `ops: string[]` —— 这正是 C10 的"机械事实靠手抄"。
   * 不生成它（哪条边覆盖哪些操作是判断），但抄错必须被机器抓到。
   */
  it('手写 parity 声明的每个 operationId 都在词表里（断言 8）', () => {
    // 非空守卫：PARITY 读空时 flatMap 得空集，"零违规"是假的。
    // 下限 20 = 实测条数（20 条边去重覆盖全部 55 个操作）；只许增不许减。
    expect(PARITY.length, 'PARITY 读不到预期条数 ⇒ import 路径或导出名变了').toBeGreaterThanOrEqual(20);
    const ghosts = [...new Set(PARITY.flatMap((e) => e.ops))].filter((x) => !OPERATION_IDS.includes(x)).sort();
    expect(ghosts, '手写 parity 里出现 spec 中不存在的操作').toEqual([]);
  });

  /**
   * 手写路由只许调词表里真存在的操作。
   * 这条买到的是 A 想靠"生成路由"换来的那一丁点保障 —— 而不必假装路由可生成。
   */
  it('手写路由里每个 sdk.X( 都命中词表', async () => {
    const files = await handwrittenRouteSources();
    const ghosts: string[] = [];
    let seen = 0;
    for (const [name, src] of Object.entries(files)) {
      for (const m of src.matchAll(/\bsdk\.([A-Za-z0-9_]+)\(/g)) {
        seen += 1;
        if (!OPERATION_IDS.includes(m[1])) ghosts.push(`${name} → sdk.${m[1]}(`);
      }
    }
    // 扫描本身必须真的扫到东西：正则或目录筛失效时，这条会退化成"零违规"的假绿。
    expect(seen, '一个 sdk.X( 都没扫到 ⇒ 正则或目录筛失效').toBeGreaterThan(40);
    expect(ghosts.sort()).toEqual([]);
  });
});
