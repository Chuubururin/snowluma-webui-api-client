// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
/**
 * isCliEntry 的跨平台形状。
 *
 * 此前整份断言建立在 `'C:\\repo\\tools\\build-anchor.ts'` 这种字面量上：Windows 下它是绝对路径，
 * 而在 POSIX 上它是一段**相对**路径 —— `pathToFileURL` 会拿当前工作目录去补，于是两条 OS 上
 * 测的其实不是同一件事（Linux job 实测红在这里）。
 * 现在路径按平台取绝对形态，反斜杠等价那条只在反斜杠有意义的环境里断言，
 * 但"普通路径 vs file:// URL 两侧都过 pathToFileURL 再比"这条主判据两边都真跑。
 */
import { describe, expect, it } from 'vitest';
import { pathToFileURL } from 'node:url';
import { isCliEntry } from './cli.js';

const isWin = process.platform === 'win32';
const SELF = isWin ? 'C:\\repo\\tools\\build-anchor.ts' : '/repo/tools/build-anchor.ts';
const OTHER = isWin ? 'C:\\repo\\tools\\validate-spec.ts' : '/repo/tools/validate-spec.ts';
/** 反斜杠写法只在 Windows 上是另一种路径形态；POSIX 上反斜杠是合法文件名字符，不参与等价。 */
const SELF_FWD = isWin ? 'C:/repo/tools/build-anchor.ts' : SELF;
const moduleUrl = pathToFileURL(SELF).href;

describe('isCliEntry（终审 M4：argv[1] 缺失时判 false，不得抛）', () => {
  it('argv1 为 undefined（-e / REPL / 被 import）时返回 false 而不是 ERR_INVALID_ARG_TYPE', () => {
    expect(() => isCliEntry(moduleUrl, undefined)).not.toThrow();
    expect(isCliEntry(moduleUrl, undefined)).toBe(false);
  });

  it('argv1 指向本模块时 true；指向别的文件时 false（含空串这种畸形值）', () => {
    expect(isCliEntry(moduleUrl, SELF)).toBe(true);
    expect(isCliEntry(moduleUrl, OTHER)).toBe(false);
    expect(isCliEntry(moduleUrl, '')).toBe(false);
  });

  it('比较前两侧都过 pathToFileURL：普通路径 argv1 对上 file:// 的 moduleUrl 仍算同一路径', () => {
    expect(pathToFileURL(SELF_FWD).href).toBe(moduleUrl);
    expect(isCliEntry(moduleUrl, SELF)).toBe(true);
  });

  it('Windows 上反斜杠与正斜杠两种写法判成同一个入口；POSIX 上验两种路径不会互相误判', () => {
    if (!isWin) {
      // POSIX 上反斜杠不是分隔符，"两种写法等价"这条性质不存在。
      // 这里改验更要紧的一面：不同文件的 URL 不许相等（否则 isCliEntry 会误判成自己的入口）。
      expect(pathToFileURL(SELF).href).not.toBe(pathToFileURL(OTHER).href);
      expect(isCliEntry(moduleUrl, OTHER)).toBe(false);
      return;
    }
    const fromBack = pathToFileURL(SELF).href;
    const fromFwd = pathToFileURL(SELF_FWD).href;
    expect(fromBack).toBe(fromFwd);
    expect(isCliEntry(fromBack, SELF_FWD)).toBe(true);
    expect(isCliEntry(fromFwd, SELF)).toBe(true);
  });
});
