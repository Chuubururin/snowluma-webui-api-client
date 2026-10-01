// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
import { describe, expect, it } from 'vitest';
import {
  buildReport,
  classifyOps,
  detectControls,
  detectMerge,
  detectPathLiterals,
  detectRoutes,
  detectSources,
  detectStreamTests,
  detectUnwrapped,
  markdownReport,
  STREAM_TEST_TOKEN,
  violationsV2,
  type CoverageReportV2,
} from './check-ui-coverage.js';
import { DECLINATIONS } from '../demo/declinations.js';
import { SSE_OPERATIONS } from '../demo/vocabulary.gen.js';
import { PARITY } from '../demo/parity.js';

/** 七条断言的判语层：只喂一份"什么都没问题"的报告，再逐条点亮一个桶。 */
const base: CoverageReportV2 = {
  totalOps: 55,
  sourcesTotal: 17,
  sourcesAnchored: 17,
  effective: ['getStatus'],
  writeOnly: [],
  notSurfaced: [],
  unregistered: [],
  unresolvableSources: [],
  unknownControls: [],
  mergeMismatches: [],
  missingStreamTests: [],
  forbiddenPathLiterals: [],
  unwrappedSdkCalls: [],
  forbiddenRoutes: [],
  harnessOnly: [],
  unreachableOps: [],
};
const v = (patch: Partial<CoverageReportV2>) => violationsV2({ ...base, ...patch });

describe('七条断言：每条都必须能单独把门禁弄红', () => {
  it('干净报告通过', () => expect(v({})).toEqual([]));
  it('1 归属缺失/多归属', () => {
    expect(v({ unregistered: ['listQq'] })).toHaveLength(1);
    expect(v({ effective: ['getStatus'], notSurfaced: ['getStatus'] })).toHaveLength(1);
  });
  it('2 Tier B 出处不得单独支撑覆盖', () =>
    expect(v({ unresolvableSources: ['parity:settings#onebot'] })).toHaveLength(1));
  it('3 控件字段名不在 spec', () => expect(v({ unknownControls: ['recoveryCodesRemaining'] })).toHaveLength(1));
  it('4 合并语义与实现不符', () =>
    expect(v({ mergeMismatches: ['saveOneBotConfig: declared partial, code does whole-document merge'] })).toHaveLength(
      1,
    ));
  it('5 effective 的流行为缺单测', () => expect(v({ missingStreamTests: ['dropped 一次性对账'] })).toHaveLength(1));
  it('6b 非流 sdk 调用没被 unwrap 包裹 ⇒ 该处 4xx 会被静默成 {data:undefined}', () =>
    expect(v({ unwrappedSdkCalls: ['demo/server/routes/settings.ts:12'] })).toHaveLength(1));
  it('6 手写 /api/ 字面量、禁用端点回归、只剩 harness 覆盖、控件不可达各算一条', () => {
    expect(v({ forbiddenPathLiterals: ['demo/server/routes/x.ts:12'] })).toHaveLength(1);
    expect(v({ forbiddenRoutes: ['api-call'] })).toHaveLength(1);
    expect(v({ harnessOnly: ['opZ'] })).toHaveLength(1);
    expect(v({ unreachableOps: ['opY'] })).toHaveLength(1);
  });
});

// ── 扫描层：每条判据都给一份最小文件表，让它既能绿也能红 ──

const SPEC_MINI = `
components:
  schemas:
    LoginData:
      type: object
      properties:
        password: { type: string }
        totp: { type: string, enum: ['x'] }
paths:
  /api/a:
    get:
      operationId: opA
      responses:
        '200':
          content:
            application/json:
              schema:
                type: object
                properties:
                  appearance: { type: object }
`;

describe('控件名单：既要在 spec 里有名，也要在自己代码里有物', () => {
  const edges = [
    { panel: 'gate', webui: 'a.tsx:1', controls: ['password', 'appearance'], ops: ['opA'], effect: 'effective' as const },
  ];

  it('spec 属性名与代码里真存在的控件名都放行', () => {
    const files = { 'demo/client/pages/gate.ts': 'const html = \'<input id="password"/><input id="appearance"/>\';' };
    expect(detectControls(edges, new Set(['password']), files)).toEqual([]);
  });
  it('既不在 spec 也不在自己代码里的控件名判红（发明出来的名单）', () => {
    expect(detectControls(edges, new Set(['password']), { 'demo/client/a.ts': 'const x = 1;' })).toEqual([
      'gate · appearance',
    ]);
  });
  it('只写在注释里的名字不算控件（名单不许靠注释蒙过）', () => {
    expect(detectControls(edges, new Set(['password']), { 'demo/client/a.ts': '// appearance 以后再说\nconst x = 1;' })).toEqual(
      ['gate · appearance'],
    );
  });
});

describe('出处分层：Tier A 解不到文件与 Tier B 单独支撑都进 unresolvableSources', () => {
  const edges = [
    { panel: 'overview', webui: 'packages/webui/src/a.tsx:10', controls: [], ops: ['opA'], effect: 'effective' as const },
    { panel: 'logs', webui: 'packages/webui/src/unanchored.tsx:4', controls: [], ops: ['opB'], effect: 'effective' as const },
  ];
  it('锚定面内的文件解不到即红；Tier B 只在"单独支撑某条覆盖"时红', async () => {
    const tier = async (p: string) => (p.endsWith('a.tsx') ? 'A' : 'B');
    expect(await detectSources(edges, tier)).toEqual([
      'logs · packages/webui/src/unanchored.tsx:4（opB 的覆盖只由 Tier B 出处支撑）',
    ]);
    const missing = async (p: string) => (p.endsWith('a.tsx') ? 'X' : 'A');
    expect(await detectSources(edges, missing)).toEqual([
      'overview · packages/webui/src/a.tsx:10（声称 Tier A 出处，但锚定副本读不到）',
    ]);
  });
  it('出处串不是 file:line 也算红', async () => {
    const bad = [{ ...edges[0], webui: 'packages/webui/src/a.tsx' }];
    expect(await detectSources(bad, async () => 'A')).toEqual([
      'overview · packages/webui/src/a.tsx（出处不是 <路径>:<行>）',
    ]);
  });
});

describe('合并语义声明与实现必须同进同退', () => {
  const fullEdge = {
    panel: 'config',
    webui: 'a:1',
    controls: [],
    ops: ['saveFull'],
    effect: 'effective' as const,
    merge: 'full' as const,
  };
  const patchEdge = {
    panel: 'config',
    webui: 'a:2',
    controls: [],
    ops: ['savePatch'],
    effect: 'effective' as const,
    merge: 'partial' as const,
  };
  const whole = (ops: string[]) => new Map(ops.map((o) => [o, true]));
  const patched = (ops: string[]) => new Map(ops.map((o) => [o, false]));

  it('声明与代码一致 ⇒ 无违例', () => {
    expect(detectMerge([fullEdge, patchEdge], whole(['saveFull']), ['saveFull', 'savePatch'])).toEqual([]);
  });
  it('声明 full 而承载代码没有整份合并 ⇒ 红', () => {
    expect(detectMerge([fullEdge, patchEdge], patched(['saveFull', 'savePatch']), ['saveFull', 'savePatch'])).toEqual([
      'config · saveFull: 声明 merge=full，承载代码里没有整份合并（deepMerge 或先读后写）',
    ]);
  });
  it('代码做了整份合并而声明是 partial ⇒ 红（写了不说的合并最危险）', () => {
    expect(detectMerge([patchEdge], whole(['savePatch']), ['savePatch'])).toEqual([
      'config · savePatch: 承载代码做了整份合并，声明却是 partial',
    ]);
  });
  it('承载代码整份合并却不属于任何带 merge 的名单 ⇒ 红（无主合并）', () => {
    const naked = [{ panel: 'config', webui: 'a:3', controls: [], ops: ['saveNaked'], effect: 'effective' as const }];
    expect(detectMerge(naked, whole(['saveNaked']), ['saveNaked'])).toEqual([
      'config · saveNaked: 承载代码做了整份合并，但这条边没有声明 merge',
    ]);
  });
});

describe('effective 的流行为要有对应单测', () => {
  it('测试语料里找得到 topic 记号就放行，找不到就点名', () => {
    const corpus: Record<string, string> = { 'tools/x.test.ts': 'fetch("/events?topic=state")' };
    expect(detectStreamTests(['streamState', 'streamLogs'], corpus)).toEqual([
      'streamLogs（测试语料里没有 /events?topic=logs 这条面）',
    ]);
  });
});

describe('静态红线：手写上游路径、unwrap 唯一折叠点、禁用与死路由', () => {
  it('注释里的 /api/ 不算，代码里的手写路径算', () => {
    const files: Record<string, string> = {
      'demo/server/routes/a.ts': "// 上游是 /api/x\nconst p = '/api/x';",
      'demo/server/routes/b.ts': '/* /api/y 只在块注释里 */\nconst q = 1;',
    };
    expect(detectPathLiterals(files)).toEqual(['demo/server/routes/a.ts:2']);
  });
  it('跨行的 unwrap 包裹认得；漏包与流操作被 unwrap 都判红', () => {
    const ops = ['opA', 'opB', 'streamState'];
    const files: Record<string, string> = {
      'demo/server/routes/a.ts':
        'const x = unwrap<any>(\n  await sdk.opA({ client })\n);\nawait sdk.opB({ client });\nunwrap(sdk.streamState({ client }));',
    };
    expect(detectUnwrapped(files, ops)).toEqual([
      'demo/server/routes/a.ts opB：非流 SDK 调用没被 unwrap 包裹（4xx 会静默成 {data:undefined}）',
      'demo/server/routes/a.ts streamState：流操作不许经 unwrap（200 是 {stream} 形态）',
    ]);
  });
  it('harness 独占、禁用端点、客户端从不请求的路由各自点名', () => {
    const routeOps = new Map<string, string[]>([
      ['GET /a', ['opA']],
      ['POST /run-all', ['opB']],
      ['POST /api-call', ['opC']],
      ['GET /dead', ['opD']],
    ]);
    const r = detectRoutes(routeOps, new Set(['/a', '/run-all']), ['api-call'], ['run-all']);
    expect(r.harnessOnly).toEqual(['opB']);
    expect(r.forbiddenRoutes).toEqual(['api-call']);
    // opC 只由那条被禁的端点承载：禁端点不算用户控件，所以它和没人请求的 opD 一样是不可达
    expect(r.unreachableOps).toEqual(['opC', 'opD']);
  });
});

describe('归属三分区', () => {
  const parity = [
    { panel: 'p', webui: 'a:1', controls: [], ops: ['opA'], effect: 'effective' as const },
    { panel: 'p', webui: 'a:2', controls: [], ops: ['opB'], effect: 'write-only' as const },
    { panel: 'p', webui: 'a:3', controls: [], ops: ['opA'], effect: 'write-only' as const },
  ];
  const decl = [
    {
      id: 'd',
      kind: 'not-surfaced' as const,
      subject: 'opC',
      webuiSource: 'a:9',
      reason: '',
      decidedBy: '',
      recoverable: true,
    },
  ];
  it('三分区各归其一，漏登记与两种 effect 重复审都点名', () => {
    const r = classifyOps(['opA', 'opB', 'opC', 'opD'], parity, decl);
    expect(r.effective).toEqual(['opA']);
    expect(r.writeOnly).toEqual(['opA', 'opB']);
    expect(r.notSurfaced).toEqual(['opC']);
    expect(r.unregistered).toEqual(['opA（同一条 op 被两种 effect 各自申报）', 'opD']);
  });
});

describe('真实仓库', () => {
  it('七条断言全绿，且 55 条操作三条分区不重不漏', async () => {
    const r = await buildReport();
    expect(r.totalOps).toBe(55);
    expect(violationsV2(r)).toEqual([]);
    expect([...r.effective, ...r.writeOnly, ...r.notSurfaced].sort()).toEqual(
      [...new Set([...r.effective, ...r.writeOnly, ...r.notSurfaced])].sort(),
    );
    expect(r.effective.length + r.writeOnly.length + r.notSurfaced.length).toBe(55);
  });

  it('markdown 报告按面板分组并给出三分区计数', async () => {
    const r = await buildReport();
    const md = markdownReport(r);
    expect(md).toContain('# UI 覆盖报告');
    expect(md).toContain('## 面板 × 操作');
    expect(md).toContain('未登记 0');
    // Tier A 比例必须真的印出来：报告里少这一行时，"引用全在锚定面内"就只是一句口头保证
    expect(md).toContain(`出处引用 ${r.sourcesTotal} 份文件 · Tier A（锚定面内）${r.sourcesAnchored} 份`);
  });
});

// 断言 5 的静默失明防线：detectStreamTests 对没有 token 的流操作 continue——
// 词表新增第 5 条流时记号表若没跟上，断言 5 对它永久失效且不报任何 violation。
// 这里钉「词表 SSE 操作 ↔ 记号表键集双向相等」，让"新流没登记 token"在单测里直接红。
describe('STREAM_TEST_TOKEN 与词表 SSE 操作对账', () => {
  it('键集双向相等：记号表不得多（手抄漂移）也不得少（静默失明）', () => {
    const tokenKeys = Object.keys(STREAM_TEST_TOKEN).sort();
    expect(tokenKeys).toEqual([...SSE_OPERATIONS].sort());
  });
});
