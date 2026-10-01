// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
import { parseSpec } from './ir.js';
import { emitVocabulary } from './emit-vocabulary.js';
import { writeGenerated } from './emit.js';
import { existsSync, readFileSync } from 'node:fs';
import { isCliEntry } from '../../lib/cli.js';

export interface DemoGenOptions {
  specPath: string;
  sdkPath?: string;
  dryRun?: boolean;
}

export interface DemoGenResult {
  filesWritten: string[];
  vocabularyOperations: number;
}

/**
 * 从生成的 TS SDK 取操作函数名。
 *
 * `generated/` 被 gitignore ⇒ 这一腿只能在**生成期**核：测试期读不到它，把门禁建在
 * "全新检出必红"的东西上等于没有门禁。spec ↔ SDK 不等就抛，`gen:check`（重新生成后
 * `git diff --exit-code demo/`）在 CI 里把这条腿重新证明一遍。
 * 导出形状实测唯一：`export const <operationId> = <ThrowOnError extends boolean = false>(...)`。
 */
function sdkExportedOperations(sdkPath: string): string[] {
  const src = readFileSync(sdkPath, 'utf8');
  return [...src.matchAll(/^export const ([A-Za-z0-9_]+) = /gm)].map((m) => m[1]);
}

/**
 * demo 生成面的全部。
 *
 * 只产词表一份。曾经还产路由 / 面板描述 / 类型 / parity 四类，全部作废：逐条读完 50 条手写
 * 端点后确认它们表达的是判断而不是映射（聚合哪几路、怎么按路降级、响应里那几个上游根本没有的键、
 * 为什么不能套 `{data}`）。判据是"能否从 spec + SDK 零判断推出"，推不出的留手写面。
 */
export async function runDemoGen(opts: DemoGenOptions): Promise<DemoGenResult> {
  const spec = parseSpec(opts.specPath);
  const source = emitVocabulary(
    spec,
    sdkExportedOperations(opts.sdkPath ?? 'generated/typescript/sdk.gen.ts'),
  );

  const written: string[] = [];
  if (!opts.dryRun) {
    writeGenerated('demo/vocabulary.gen.ts', source);
    written.push('demo/vocabulary.gen.ts');
  }

  return { filesWritten: written, vocabularyOperations: spec.operations.length };
}

if (isCliEntry(import.meta.url, process.argv[1])) {
  const dryRun = process.argv.includes('--dry-run');
  const specPath = 'spec/openapi.yaml';
  if (!existsSync(specPath)) {
    console.error(`spec not found: ${specPath}`);
    process.exit(1);
  }
  const result = await runDemoGen({ specPath, dryRun });
  console.log(`demo gen: ${result.filesWritten.join(', ')}（${result.vocabularyOperations} 条操作）`);
  if (dryRun) console.log('(dry run — no files written)');
}
