// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
/**
 * 验证链清单的用例（实现批次）。
 *
 * 这条链原先带三条 HTTP 腿：`POST /set-base-url` → `POST /login` → `POST /run-all`。
 * 前者在重做里改名成了 `/gate/login`，后者随"消除原始调用台"（commit 7d8e91d /实现批次）整个删掉了
 * —— 于是一条号称"一键全链"的编排器必然在第 1–2 步抛错，而它头注还写着"离线门禁请在终端另行执行"，
 * 那句从来没人执行。一条看起来是活链、实际跑不起来的链，比没有这条链更坏：它把"没验"记成"验过"。
 *
 * 现在它只做离线门禁 + 可选 L4，而本文件钉住这份清单本身。三条断言各挡一种具体失效：
 *  1. 清单缺一条设计口径点名的门禁 ⇒ "交付判定全绿"里有一条从没被执行过。
 *  2. 清单引用了 package.json 里不存在的脚本名 ⇒ 报告会把一条从未存在的门禁写成通过。
 *  3. 清单说这条门禁跑在某个文件上，而那个文件不在了 ⇒ spawn 会 ENOENT；
 *     那是"根本没跑"，不是"跑红了"，两者的处置完全相反。
 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { exitCodeFor, GATES, REQUIRED_GATE_IDS, summarizePassingOutput } from './verify-all.js';

const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> };
const scripts = Object.keys(pkg.scripts);

describe('验证链清单', () => {
  it('设计口径点名的每条离线门禁都在清单里', () => {
    const ids = GATES.map((g) => g.id);
    for (const need of REQUIRED_GATE_IDS) expect(ids, `清单缺门禁 ${need}`).toContain(need);
  });

  it('每条门禁点名的 npm 脚本真的存在（幽灵门禁不许写成通过）', () => {
    for (const g of GATES) expect(scripts, `npm 脚本 ${g.npmScript} 不存在`).toContain(g.npmScript);
  });

  it('每条门禁声明要跑的文件真的在磁盘上（ENOENT 不是"红"）', () => {
    for (const g of GATES) for (const f of g.runs) expect(existsSync(f), `${g.id} 要跑的 ${f} 不存在`).toBe(true);
  });

  it('清单里没有重复门禁，且每条都写着"它在证明什么"', () => {
    const ids = GATES.map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const g of GATES) {
      expect(g.proves, `${g.id} 缺 proves 一句`).toBeTruthy();
      expect(g.proves.length, g.id).toBeGreaterThan(8);
    }
  });

  it('L4 不在默认清单里，只能显式加 —— 未设 SNOWLUMA_FIXTURE 时它是 skip，skip 不是通过', () => {
    expect(GATES.map((g) => g.id)).not.toContain('test:fixture');
    expect(scripts).toContain('test:fixture');
  });

  it('报告落盘那一行必须过 redactJson（这是接线目检，不是值检查）', () => {
    // 弱断言，且只当弱断言用：它证明"写盘口挂了脱敏"这一处接线没被摘掉，
    // 而 redactJson 真的洗得掉凭据由 tools/evidence-redaction.test.ts 的执行用例钉。
    // 之所以留这条：verify-all 的 CLI 一跑就是整条链，没法在单测里执行它。
    const src = readFileSync('tools/verify-all.ts', 'utf8');
    expect(src).toMatch(/writeFileSync\([\s\S]{0,120}redactJson\(report\)/);
  });

  // 这条链唯一的机器可读信号是退出码：operator 在终端看得见 ✗，CI 与 `npm run verify:all && …`
  // 只看得到一个数。"有条门禁红了却 exit 0"正是这一族最坏的失效 —— 它把红记成绿，
  // 而这份报告的全部用途就是声称"设计口径逐条跑绿了"。
  it('任一条门禁红 ⇒ 退出码非 0', () => {
    expect(exitCodeFor([{ id: 'test', ok: true }, { id: 'drift', ok: false }])).toBe(1);
  });

  it('全绿 ⇒ 退出码 0', () => {
    expect(exitCodeFor([{ id: 'test', ok: true }, { id: 'drift', ok: true }])).toBe(0);
  });

  it('一条都没跑 ⇒ 也非 0（空清单不等于通过）', () => {
    // 收口判断如果写成 `failed.length ? 1 : 0`，把 GATES 清空会得到 exit 0 +
    // 一份"全部通过 ✓"的报告 —— 扫描器扫到 0 个文件却报齐备，是同一形状。
    expect(exitCodeFor([])).toBe(1);
  });

  it('头注里的执行清单与 GATES 表逐条同序（注释不许比表多跑或少跑一条）', () => {
    // 这份链给人读的是注释，真正跑的是表。两份一旦分叉，读到的那份就会承诺一条没跑的门禁。
    // 所以把注释按序抽出来跟表比 —— 改了表没改注释（或反过来）即红。
    const src = readFileSync('tools/verify-all.ts', 'utf8');
    const block = src.slice(src.indexOf('执行清单'), src.indexOf('收口：'));
    expect(block, '头注缺执行清单那一段').not.toBe('');
    const listed = [...block.matchAll(/npm (?:test|run ([A-Za-z0-9:._-]+))/g)].map((m) => m[1] ?? 'test');
    expect(listed).toEqual(GATES.map((g) => g.npmScript));
  });

  // 通过那一条的 tail 是报告里唯一的"这条跑成了什么样"。只取末行的采集在真报告上出过三次货：
  // test 那格是 vitest 的性能建议（读起来像警告）、drift 那格是一个右花括号、L4 那格只有 Duration，
  // 三格都不含判定。取末尾一小段而不是末一行，才装得下判定本身 —— 尤其 vitest 的建议块是打在
  // 汇总行**之后**的，窗口太小就会被它把 "Tests 5 passed" 顶出去。
  it('判定行不会被后面的提示块顶出采集窗口', () => {
    const out = [
      '',
      ' Test Files  1 passed (1)',
      '      Tests  5 passed (5)',
      '   Start at  06:24:57',
      '   Duration  245ms',
      '',
      '  consider setting isolate: false …',
      '  at least ~1.35s faster with isolate: false — reuses workers across files',
    ].join('\n');
    const s = summarizePassingOutput(out);
    expect(s).toContain('Tests  5 passed (5)');
    expect(s).toContain('Duration  245ms');
  });

  it('drift 那种 JSON 收口行也留着（末一行是花括号，上一行才是双向零缺口的证据）', () => {
    const out = ['{', '  "upstreamOnly": [],', '  "specOnly": [],', '  "anchorStale": false', '}'].join('\n');
    const s = summarizePassingOutput(out);
    expect(s).toContain('"specOnly": []');
    expect(s).toContain('}');
  });

  it('空输出采出空串而不是崩或假装有内容', () => {
    expect(summarizePassingOutput('')).toBe('');
  });

  it('采集有长度上限（八条各留一大块 stdout 进版本库，报告就没人读了）', () => {
    const long = Array.from({ length: 12 }, () => 'x'.repeat(120)).join('\n');
    expect(summarizePassingOutput(long).length).toBeLessThanOrEqual(320);
  });
});
