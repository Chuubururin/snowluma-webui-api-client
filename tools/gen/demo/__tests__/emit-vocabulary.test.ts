// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { emitVocabulary } from '../emit-vocabulary.js';
import { withBanner, BANNER, AUTO_GEN_MARKER } from '../emit.js';
import type { SpecIR, OperationIR } from '../ir.js';

function op(over: Partial<OperationIR>): OperationIR {
  return {
    operationId: 'x',
    method: 'get',
    path: '/api/x',
    tags: [],
    summary: '',
    isSSE: false,
    queryParams: [],
    pathParams: [],
    isGate: false,
    securityOptional: false,
    ...over,
  } as OperationIR;
}

function spec(ops: OperationIR[]): SpecIR {
  return { operations: ops, schemas: {} };
}

const TWO = spec([
  op({ operationId: 'getStatus', path: '/api/status' }),
  op({ operationId: 'streamLogs', path: '/api/logs/stream', isSSE: true }),
]);
const SDK2 = ['getStatus', 'streamLogs'];

describe('emitVocabulary', () => {
  it('落盘后的头两行是许可横幅与不可手改标记，且各只出现一次', () => {
    // 横幅归 withBanner 一家所有；发射器自己也加一次就会在产物里出现两份。
    const src = withBanner(emitVocabulary(TWO, SDK2));
    expect(src.split('\n')[0]).toBe(BANNER);
    expect(src.split('\n')[1]).toBe(AUTO_GEN_MARKER);
    expect(src.split(BANNER).length - 1).toBe(1);
    expect(src.split(AUTO_GEN_MARKER).length - 1).toBe(1);
  });

  it('emit.ts 的 BANNER 与 tools.lock.json 的 banner 互为镜像（跨面钉，防自指断言盲区）', async () => {
    // 上面那条是自指的：BANNER 常量与产物一起改错，它照样全绿。真源在 lock
    // （tools/gen/run.test.ts 已把 run.ts BANNER ↔ lock 钉住）；这条把 emit.ts
    // 接进同一真源——口径改写必须一次改三层，漏一层即红。
    const lock = JSON.parse(await readFile('tools.lock.json', 'utf8')) as { banner: string };
    expect(BANNER).toBe(`// ${lock.banner}`);
  });

  it('每条操作都带方法/路径/SSE/门禁/匿名五个机械字段', () => {
    const src = emitVocabulary(TWO, SDK2);
    expect(src).toContain(
      "getStatus: { operationId: 'getStatus', method: 'GET', path: '/api/status', isSSE: false, isGate: false, anonymous: false }",
    );
    expect(src).toContain(
      "streamLogs: { operationId: 'streamLogs', method: 'GET', path: '/api/logs/stream', isSSE: true, isGate: false, anonymous: false }",
    );
  });

  it('三张子表各自只含成员，不是全量', () => {
    const src = emitVocabulary(
      spec([
        op({ operationId: 'streamLogs', isSSE: true }),
        op({ operationId: 'login', isGate: true }),
        op({ operationId: 'getPublicUiAppearance', securityOptional: true }),
      ]),
      ['streamLogs', 'login', 'getPublicUiAppearance'],
    );
    // 实现发的是 `X: string[] = [...]`：保留显式标注，因为下游有
    // `const STREAM_OPS = SSE_OPERATIONS` 这种别名，readonly 元组会引入无谓的类型摩擦。
    expect(src).toContain("export const SSE_OPERATIONS: string[] = ['streamLogs']");
    expect(src).toContain("export const GATE_OPERATIONS: string[] = ['login']");
    expect(src).toContain("export const ANONYMOUS_OPERATIONS: string[] = ['getPublicUiAppearance']");
  });

  it('SDK 导出集与 spec 操作集不等时抛错（C11 在生成期执法）', () => {
    // 断言点名到具体操作：只查"抛错了"分不清是哪一腿不对。
    expect(() => emitVocabulary(TWO, ['getStatus'])).toThrow(/SDK 少一条 \[streamLogs\]/);
    expect(() => emitVocabulary(TWO, [...SDK2, 'ghostOp'])).toThrow(/多一条 \[ghostOp\]/);
  });

  it('空 spec 不许静默产出空头表', () => {
    expect(() => emitVocabulary(spec([]), [])).toThrow(/operations=\[\]/);
  });
});
