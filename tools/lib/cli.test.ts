// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
import { describe, expect, it } from 'vitest';
import { pathToFileURL } from 'node:url';
import { isCliEntry } from './cli.js';

describe('isCliEntry（终审 M4：argv[1] 缺失时判 false，不得抛）', () => {
  const moduleUrl = pathToFileURL('C:\\repo\\tools\\build-anchor.ts').href;

  it('argv1 为 undefined（-e / REPL / 被 import）时返回 false 而不是 ERR_INVALID_ARG_TYPE', () => {
    expect(() => isCliEntry(moduleUrl, undefined)).not.toThrow();
    expect(isCliEntry(moduleUrl, undefined)).toBe(false);
  });

  it('argv1 指向本模块时 true；指向别的文件时 false（含空串这种畸形值）', () => {
    expect(isCliEntry(moduleUrl, 'C:\\repo\\tools\\build-anchor.ts')).toBe(true);
    expect(isCliEntry(moduleUrl, 'C:\\repo\\tools\\validate-spec.ts')).toBe(false);
    expect(isCliEntry(moduleUrl, '')).toBe(false);
  });

  it('比较前两侧都过 pathToFileURL：反斜杠与正斜杠写法都算同一路径', () => {
    const forward = pathToFileURL('C:/repo/tools/build-anchor.ts').href;
    expect(forward).toBe(moduleUrl);
    expect(isCliEntry(forward, 'C:\\repo\\tools\\build-anchor.ts')).toBe(true);
  });
});
