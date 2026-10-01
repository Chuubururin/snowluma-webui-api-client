// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
import { describe, expect, it } from 'vitest';
import { extractModelsFromSource } from './extract-models.js';

describe('extractModelsFromSource', () => {
  it('抽取 interface 与 type 导出，跳过 import 与非导出', () => {
    const src = [
      "import type { Foo } from '@/types';",
      'export interface QQInfo { uin: string }',
      'export type LogLevel = "debug" | "info";',
      'interface NotExported {}',
      'export const VERSION = 1;',
    ].join('\n');
    expect(extractModelsFromSource(src, 'types.ts')).toEqual([
      { name: 'QQInfo', kind: 'interface', file: 'types.ts', line: 2 },
      { name: 'LogLevel', kind: 'type', file: 'types.ts', line: 3 },
    ]);
  });

  it('导出泛型与下划线名同样命中', () => {
    const src = 'export interface Page<T> { items: T[] }\nexport type _Marker = never;';
    expect(extractModelsFromSource(src, 'x').map((m) => m.name)).toEqual(['Page', '_Marker']);
  });

  it('命中注释行内的 export 不算（行首非 export）', () => {
    const src = '  export interface Indented {}\nexport interface Real {}';
    expect(extractModelsFromSource(src, 'x').map((m) => m.name)).toEqual(['Real']);
  });
});
