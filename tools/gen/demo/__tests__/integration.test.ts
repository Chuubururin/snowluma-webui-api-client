// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
import { describe, expect, it } from 'vitest';
import { runDemoGen } from '../index.js';

const SPEC = 'spec/openapi.yaml';

/**
 * 只跑 dry run：编排器的落盘动作由真实 `npm run gen:demo` 证明（`gen:check` 那条门禁），
 * 测试自己写 `demo/vocabulary.gen.ts` 会把"测试通过"与"产物已更新"两件事混成一件事。
 */
describe('runDemoGen', () => {
  it('dry run 不落盘，并报告词条数', async () => {
    const result = await runDemoGen({ specPath: SPEC, dryRun: true });
    expect(result.filesWritten).toEqual([]);
    expect(result.vocabularyOperations).toBe(55);
  });

  /**
   * SDK 腿必须在执行路径上，不能是发射器里的装饰。
   * 指向一个不存在的 SDK 文件时整条链就该炸 —— 证明编排器真的去读了它。
   */
  it('SDK 产物不在位时抛错，而不是静默产出一张没对过账的词表', async () => {
    await expect(
      runDemoGen({ specPath: SPEC, sdkPath: 'generated/typescript/__no_such__.ts', dryRun: true }),
    ).rejects.toThrow(/ENOENT/);
  });
});
