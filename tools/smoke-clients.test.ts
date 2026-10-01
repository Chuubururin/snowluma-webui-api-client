// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
/**
 * 出口闸的收口逻辑。
 *
 * 三层判据（装得上 / 入口对 / 用得动）各自独立成键，是因为"只到第一层"就是假绿：
 * 文件装进去了但 exports 指错、或 exports 对了但示例跑不动，处置完全不同，
 * 而 `installed && ok` 这种单键形状会把它们合并成看不见的东西。
 */
import { readFileSync } from 'node:fs';
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

describe('TS 腿的 esbuild 调用形态', () => {
  /**
   * verify-posix 首航实测：`node node_modules/esbuild/bin/esbuild` 在 Linux 上必崩。
   * esbuild 的 install.js（第 226 行那条 `os.platform() !== 'win32'` 分支）会把
   * `bin/esbuild` **换成原生二进制**并 chmod +x —— Windows 上那里留的是 JS shim，
   * 所以本机永远跑得出绿。用 JS API（`import { build } from 'esbuild'`）才是按包声明的
   * 跨平台入口，而打包器 package-clients.ts 早就这么调了：同一条链上两处两种形态必然分叉。
   */
  const src = readFileSync('tools/smoke-clients.ts', 'utf8');

  // 只扫代码面：本文件那段解释"当初为什么崩"的注释里就带着 `node_modules/esbuild/bin/esbuild`
  // 这个字面量 —— 拿关键词量散文，会把案发现场当成罪行本身（第一版断言就是这么误红的）。
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('不许取 esbuild 的 bin 路径交给 node 执行', () => {
    expect(code).not.toMatch(/esbuild[\\/]bin/);
    expect(code).not.toMatch(/esbuildBin/);
  });

  it('走 esbuild 的 JS API（与 package-clients 同一形态）', () => {
    expect(code).toMatch(/from 'esbuild'/);
    expect(code).toMatch(/await build\(\{/);
  });
});
