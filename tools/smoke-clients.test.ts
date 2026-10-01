// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
/**
 * 出口闸的收口逻辑。
 *
 * 三层判据（装得上 / 入口对 / 用得动）各自独立成键，是因为"只到第一层"就是假绿：
 * 文件装进去了但 exports 指错、或 exports 对了但示例跑不动，处置完全不同，
 * 而 `installed && ok` 这种单键形状会把它们合并成看不见的东西。
 */
import { describe, expect, it } from 'vitest';
import { FACILITY_EXIT, exitCodeFor, facilityNote, summarizeLine, type LangResult, type SmokeReport } from './smoke-clients.js';

const ok: LangResult = { installed: true, entryOk: true, ranOk: true, detail: '' };

function report(over: Partial<Record<string, LangResult>> = {}): SmokeReport {
  return {
    langs: {
      typescript: ok,
      python: ok,
      go: ok,
      ...over,
    },
  };
}

describe('smoke 收口', () => {
  it('三层全真 → 0', () => {
    expect(exitCodeFor(report())).toBe(0);
  });

  it('装得上但入口不对 → 1（假绿那一类，必须单独成键才抓得到）', () => {
    expect(exitCodeFor(report({ typescript: { ...ok, entryOk: false } }))).toBe(1);
  });

  it('入口对但示例跑不动 → 1', () => {
    expect(exitCodeFor(report({ python: { ...ok, ranOk: false } }))).toBe(1);
  });

  it('装包这一步失败 → 1（不许被后两层的默认值掩盖）', () => {
    expect(exitCodeFor(report({ go: { ...ok, installed: false } }))).toBe(1);
  });

  it('缺一门语言 → 1；清单为空 → 1（与 verify-all 的"清单为空"同一形状）', () => {
    const two = { langs: { typescript: ok, python: ok } } as SmokeReport;
    expect(exitCodeFor(two)).toBe(1);
    expect(exitCodeFor({ langs: {} } as SmokeReport)).toBe(1);
  });

  it('设施故障退出码与判定红退出码不同（"没验"绝不能读成"验过"或"验不过"）', () => {
    expect(FACILITY_EXIT).toBe(2);
    expect(exitCodeFor(report())).toBe(0);
    // 三语齐但设施缺件：langs 里全是 true 也不算通过，判 2 而不是 0。
    expect(exitCodeFor({ ...report(), facility: ['go（退 1：exit status 1）'] })).toBe(FACILITY_EXIT);
    // 判定红与设施红必须是两个码。
    expect(exitCodeFor(report({ go: { ...ok, ranOk: false } }))).toBe(1);
    expect(facilityNote(['npm（退 127：not found）'])).toContain('设施缺件');
  });

  it('通过项的采集不留空话：detail 为空时 summarize 仍打出三层标记', () => {
    expect(summarizeLine('typescript', ok)).toMatch(/typescript/);
    expect(summarizeLine('typescript', ok)).toMatch(/装=✓/);
    expect(summarizeLine('typescript', { ...ok, entryOk: false })).toMatch(/入口=✗/);
  });
});
