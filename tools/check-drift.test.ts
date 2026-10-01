// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import {
  computeDrift,
  countExpectations,
  specOpsFromPaths,
  blocksExit,
  driftRemediation,
  STALE_CACHE_REMEDIATION,
  COUNT_MISMATCH_REMEDIATION,
  ANCHOR_COMMIT_REMEDIATION,
  type DriftReport,
} from './check-drift.js';

const logs = { method: 'GET', path: '/api/logs' };
const status = { method: 'GET', path: '/api/status' };
const login = { method: 'POST', path: '/api/login' };
// 裁定 R19：上游侧的键来自源码抽取，天然是 Express 的 :uin；spec 侧则是 OpenAPI 的 {uin}
// （见 spec/fixtures/drift-ok.yaml）。两侧同时喂进 computeDrift 才算测到真实形态。
const configUinUpstream = { method: 'GET', path: '/api/config/:uin' };

describe('computeDrift', () => {
  it('spec 与上游完全吻合时无漂移', async () => {
    const doc = parse(await readFile('spec/fixtures/drift-ok.yaml', 'utf8'));
    const report = computeDrift([logs, status, configUinUpstream], doc.paths);
    expect(report).toMatchObject({ upstreamOnly: [], specOnly: [], unclassified: [] });
  });

  it('上游新增、spec 未覆盖 → upstreamOnly', () => {
    const report = computeDrift([logs, status, login], specOpsFromPaths({
      '/api/logs': { get: {} },
      '/api/status': { get: {} },
    }));
    expect(report.upstreamOnly).toEqual(['POST /api/login']);
    expect(report.specOnly).toEqual([]);
  });

  it('上游已删除、spec 残留 → specOnly', () => {
    const report = computeDrift([logs], specOpsFromPaths({
      '/api/logs': { get: {} },
      '/api/gone': { get: {} },
    }));
    expect(report.specOnly).toEqual(['GET /api/gone']);
    expect(report.upstreamOnly).toEqual([]);
  });

  it('路径参数改名两侧同时报出', () => {
    const report = computeDrift([{ method: 'GET', path: '/api/config/:userId' }], specOpsFromPaths({ '/api/config/:uin': { get: {} } }));
    expect(report.specOnly).toEqual(['GET /api/config/:uin']);
    expect(report.upstreamOnly).toEqual(['GET /api/config/:userId']);
  });

  it('方法变更两侧同时报出', () => {
    const report = computeDrift([{ method: 'DELETE', path: '/api/ui/background' }], specOpsFromPaths({ '/api/ui/background': { post: {} } }));
    expect(report).toMatchObject({ specOnly: ['POST /api/ui/background'], upstreamOnly: ['DELETE /api/ui/background'] });
  });

  it('非 /api/ 注册不参与漂移比对', () => {
    const report = computeDrift(
      [logs, { method: 'GET', path: '*' }, { method: 'GET', path: '/robots.txt' }],
      specOpsFromPaths({ '/api/logs': { get: {} } }),
    );
    expect(report).toMatchObject({ upstreamOnly: [], specOnly: [] });
  });

  it('上游新增但未归类的操作进 unclassified', () => {
    const report = computeDrift([logs, { method: 'GET', path: '/api/brand-new' }], specOpsFromPaths({}));
    expect(report.unclassified).toEqual(['GET /api/brand-new']);
  });
});

// brief Produces 新规：三个数组必须排序后返回、unclassified 还要去重。
// 非确定的输出会让客户端批次里一次纯粹的 spec 重排在漂移差异里显示为改动（伪漂移噪音）。
describe('computeDrift 的输出确定性与返回契约', () => {
  it('列表恒按字典序返回，与输入顺序无关', () => {
    const spec = specOpsFromPaths({});
    const a = computeDrift([status, login, logs], spec);
    const b = computeDrift([login, logs, status], spec);
    expect(a.upstreamOnly).toEqual(['GET /api/logs', 'GET /api/status', 'POST /api/login']);
    expect(b.upstreamOnly).toEqual(a.upstreamOnly);
    expect(a.specOnly).toEqual([]);
  });

  it('同一未归类操作的重复注册只报一条（unclassified 须与 upstreamOnly 同样折叠）', () => {
    const dup = { method: 'GET', path: '/api/brand-new' };
    const report = computeDrift([logs, dup, dup], specOpsFromPaths({}));
    expect(report.unclassified).toEqual(['GET /api/brand-new']);
    // upstreamOnly 是集合语义（spec 为空，logs 也算未覆盖），重复注册同样只报一条：
    expect(report.upstreamOnly).toEqual(['GET /api/brand-new', 'GET /api/logs']);
  });

  it('computeDrift 不评估哈希：anchorStale 恒为 false，语义是"未评估"', () => {
    const report = computeDrift([logs], specOpsFromPaths({}));
    expect(report.anchorStale).toBe(false);
  });

  // 终审 M3：三个列表都 .sort()，但此前只有 upstreamOnly 的多元素顺序被钉过。
  // specOnly 的输入顺序来自未来那份 55 键的 openapi.yaml（键序会被人工重排），
  // unclassified 的输入顺序来自上游文件的注册顺序——两者都是"下一次计划一改就整片变红"的形状。
  it('specOnly 的多元素按字典序，与 spec 的书写顺序无关', () => {
    const sorted = ['GET /api/aaa', 'GET /api/mmm', 'GET /api/zzz'];
    const a = computeDrift([], specOpsFromPaths({ '/api/aaa': { get: {} }, '/api/mmm': { get: {} }, '/api/zzz': { get: {} } }));
    const b = computeDrift([], specOpsFromPaths({ '/api/zzz': { get: {} }, '/api/aaa': { get: {} }, '/api/mmm': { get: {} } }));
    expect(a.specOnly).toEqual(sorted);
    expect(b.specOnly).toEqual(sorted);
  });

  it('unclassified 的多元素按字典序、去重，且与上游注册顺序无关', () => {
    const ops = [
      { method: 'GET', path: '/api/zz-new' },
      { method: 'POST', path: '/api/aa-new' },
      { method: 'POST', path: '/api/aa-new' }, // 重复注册：折叠后仍只有一条
    ];
    const expected = ['GET /api/zz-new', 'POST /api/aa-new'];
    expect(computeDrift(ops, []).unclassified).toEqual(expected);
    expect(computeDrift([...ops].reverse(), []).unclassified).toEqual(expected);
  });
});

// 本工具的全部产出都是诊断，它自己崩成无文件名、无提示的裸 TypeError 不可接受。
describe('computeDrift 对畸形 spec 入参报可读错误', () => {
  it('paths 被 YAML 写坏成数组时，抛指名形状问题与正确用法的错误', () => {
    expect(() => computeDrift([logs], ['/api/logs'] as never)).toThrow(/非法的 spec 侧入参/);
  });

  it('数组里混入非 ops 形状的元素（如被当成 ops 的 paths 映射）同样抛可读错误', () => {
    expect(() => computeDrift([logs], [{ '/api/logs': { get: {} } }] as never)).toThrow(/非法的 spec 侧入参/);
  });
});

// 裁定 R19 的回归防护：`{uin}` 与 `:uin` 是同一参数的两种写法，只该在**书写**层不同。
// 不做归一化的后果不是"少一条噪音"，而是 6 条含参端点同时出现在 upstreamOnly 与 specOnly——
// 双向假漂移会把检查结果变成没人再看的东西，所以两个方向都要钉住。
describe('computeDrift 的路径参数形式归一化', () => {
  it('spec 写 {uin}、上游写 :uin：一条漂移都不报', async () => {
    const doc = parse(await readFile('spec/fixtures/drift-ok.yaml', 'utf8'));
    const report = computeDrift([logs, status, configUinUpstream], doc.paths);
    expect(report.specOnly).toEqual([]);
    expect(report.upstreamOnly).toEqual([]);
  });

  it('反方向同样归一：上游写 {uin}、spec 侧按 :uin 记录时零漂移', () => {
    const report = computeDrift(
      [{ method: 'GET', path: '/api/config/{uin}' }],
      [{ method: 'GET', path: '/api/config/:uin' }],
    );
    expect(report).toMatchObject({ upstreamOnly: [], specOnly: [], unclassified: [] });
  });

  it('归一化后统一以 tierKey 的 "METHOD /path" 形式报告，两侧同形', () => {
    const report = computeDrift([{ method: 'GET', path: '/api/config/:uin' }], specOpsFromPaths({ '/api/other/{uin}': { get: {} } }));
    expect(report.upstreamOnly).toEqual(['GET /api/config/:uin']);
    expect(report.specOnly).toEqual(['GET /api/other/:uin']);
  });

  it('真实改名不被归一化吞掉：两侧仍同时报出', () => {
    const report = computeDrift(
      [{ method: 'GET', path: '/api/config/:userId' }],
      specOpsFromPaths({ '/api/config/{uin}': { get: {} } }),
    );
    expect(report.upstreamOnly).toEqual(['GET /api/config/:userId']);
    expect(report.specOnly).toEqual(['GET /api/config/:uin']);
  });

  it('归类判定也用归一化后的键，含参端点不误进 unclassified', () => {
    const report = computeDrift(
      [{ method: 'POST', path: '/api/processes/{pid}/load' }, { method: 'GET', path: '/api/brand-new/{uin}' }],
      [],
    );
    // POST /api/processes/:pid/load 是 T3 清单里的真值，归一化后必须命中，不进 unclassified；
    // 而 /api/brand-new/:uin 是真正的未归类操作。
    expect(report.unclassified).toEqual(['GET /api/brand-new/:uin']);
  });

  // 归一化的**代价**（终审 I3a 的反面论证）：{uin} 与 :uin 折叠成同一个键，所以一份同时写着
  // 两种形式的 spec 会把自己的一条错写当成另一条的抵消项，对上游报出零漂移。
  // 归一化本身没错（R19），错的是"spec 里允许两种形式共存"——那一半由 validate-spec.ts 的
  // EXPRESS_PATH_PARAM 关死（见 tools/validate-spec.test.ts 的推论用例）。本用例钉住的是
  // "漂移检查独自承担不了这件事"这个事实，防止有人以后把它当成该在这里修的 bug。
  it('两种形式同时存在时 computeDrift 会折叠成零漂移：书写形式必须由校验器把关', () => {
    const report = computeDrift(
      [{ method: 'GET', path: '/api/config/:uin' }],
      specOpsFromPaths({ '/api/config/{uin}': { get: {} }, '/api/config/:uin': { get: {} } }),
    );
    expect(report).toMatchObject({ upstreamOnly: [], specOnly: [], unclassified: [] });
  });
});

describe('countExpectations', () => {
  const anchor = {
    expectedRouteRegistrations: 59,
    expectedApiOperations: 55,
    expectedModels: { 'packages/webui/src/types.ts': 76, 'packages/webui/src/lib/api/types.ts': 19 },
    // 真 anchor 必有非空 files（哈希比对的数据源）；空集另有专门用例钉住。
    files: [{ repoPath: 'packages/webui/src/webui/server.ts', sha256: 'a'.repeat(64) }],
  };
  const fresh = (over: Record<string, unknown> = {}) =>
    ({ ...anchor, ...over }) as unknown as Parameters<typeof countExpectations>[1];

  it('三类计数全一致时返回空数组', () => {
    expect(countExpectations(anchor as never, fresh())).toEqual([]);
  });

  it('注册数或 API 操作数不一致时，报出的行同时含期望值与实际值', () => {
    // 两个标量都要单独练到：只改 expectedApiOperations 的话，
    // expectedRouteRegistrations 那条分支坏了也不会被发现。
    const regs = countExpectations(anchor as never, fresh({ expectedRouteRegistrations: 60 }));
    expect(regs).toHaveLength(1);
    expect(regs[0]).toContain('路由注册总数');
    expect(regs[0]).toContain('59');
    expect(regs[0]).toContain('60');

    const apis = countExpectations(anchor as never, fresh({ expectedApiOperations: 56 }));
    expect(apis).toHaveLength(1);
    expect(apis[0]).toContain('API 操作数');
    expect(apis[0]).toContain('55');
    expect(apis[0]).toContain('56');
  });

  it('模型数按文件比较：计数变化、新增文件、文件消失都能报出，并指名 repoPath', () => {
    const changed = countExpectations(anchor as never,
      fresh({ expectedModels: { ...anchor.expectedModels, 'packages/webui/src/types.ts': 75 } }));
    expect(changed).toHaveLength(1);
    expect(changed[0]).toContain('packages/webui/src/types.ts');

    const added = countExpectations(anchor as never,
      fresh({ expectedModels: { ...anchor.expectedModels, 'packages/webui/src/new.ts': 3 } }));
    expect(added.join('\n')).toContain('packages/webui/src/new.ts');

    const removed = countExpectations(anchor as never,
      fresh({ expectedModels: { 'packages/webui/src/types.ts': 76 } }));
    expect(removed.join('\n')).toContain('packages/webui/src/lib/api/types.ts');
  });

  it('一增一减的总数不变仍须报出（per-file 比较的意义）', () => {
    const lines = countExpectations(anchor as never, fresh({
      expectedModels: { 'packages/webui/src/types.ts': 77, 'packages/webui/src/lib/api/types.ts': 18 },
    }));
    // 只断言 lines.length > 0 挡不住"两个文件只报出一个"的失效模式：
    // 行数与两个 repoPath 都要钉住（per-file 排序：lib 路径字典序在前）。
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('packages/webui/src/lib/api/types.ts');
    expect(lines[1]).toContain('packages/webui/src/types.ts');
  });

  it('files 被整组掏空的 anchor 必须报出（some 在空数组上恒 false，不能静默判不陈旧）', () => {
    const lines = countExpectations({ ...anchor, files: [] } as never, fresh());
    expect(lines.join('\n')).toContain('锚定文件集为空');
  });
});

describe('specOpsFromPaths', () => {
  it('把 paths 展开成 method+path 键', () => {
    expect(specOpsFromPaths({ '/api/logs': { get: {}, post: {} } })).toEqual([
      { method: 'GET', path: '/api/logs' },
      { method: 'POST', path: '/api/logs' },
    ]);
  });
});

// 裁定 R21：anchorStale 是阻断条件而非观察项。CLI 分支在本项目不做单测，
// 所以退出决策从 CLI 抽为纯函数 blocksExit 钉住——把其中的 `|| report.anchorStale`
// 摘掉（即回退到评审前的 `if (blocking) exit(1)`），下面第二条立即红。
describe('blocksExit（R21：过期缓存必须承担后果）', () => {
  const clean: DriftReport = { upstreamOnly: [], specOnly: [], unclassified: [], anchorStale: false };

  it('零漂移且缓存新鲜：不阻断', () => {
    expect(blocksExit(clean)).toBe(false);
  });

  it('零漂移但 anchorStale 为真：阻断——工具不得从它判定为过期的数据认证"无漂移"', () => {
    expect(blocksExit({ ...clean, anchorStale: true })).toBe(true);
  });

  it('三个列表任一非空即阻断，无论 anchorStale 取值', () => {
    expect(blocksExit({ ...clean, upstreamOnly: ['GET /api/x'] })).toBe(true);
    expect(blocksExit({ ...clean, specOnly: ['GET /api/y'], anchorStale: true })).toBe(true);
    expect(blocksExit({ ...clean, unclassified: ['GET /api/z'] })).toBe(true);
  });
});

// 终审 I2：工具自己的补救建议不得指向"能绕过自己关卡"的命令。
// 旧文案让操作员 `npm run extract`，而该脚本就是 build-anchor.ts——它从不 fetch，
// 只把 vendor 里的现有字节重新哈希一遍，并给 argv 传入的字符串盖上 commit 标签。
// 照旧文案做 → 哈希与当前缓存必然相符、计数必然一致、anchor.commit 却是无人核验的声称，
// 于是 R21 刚拦下的"陈旧锚点"被工具自己的下一步操作重新合法化。
describe('补救文案（I2：fetch 路径在前，单跑 extract 明确禁止）', () => {
  const messages = [
    driftRemediation(3),
    STALE_CACHE_REMEDIATION,
    COUNT_MISMATCH_REMEDIATION,
    ANCHOR_COMMIT_REMEDIATION,
  ];

  it('三条都要求按 anchor 的 SHA 走 fetchCommand 重拉缓存', () => {
    for (const m of messages) {
      expect(m).toContain('fetchCommand');
      expect(m).toContain('40 位');
    }
  });

  it('fetch 在重建锚点之前出现（顺序错了就是先自证再拉取）', () => {
    for (const m of messages) {
      expect(m.indexOf('fetchCommand')).toBeLessThan(m.indexOf('build-anchor'));
    }
  });

  it('三条都点明单跑 extract 不联网、会得到自证锚点', () => {
    for (const m of messages) expect(m).toMatch(/不要单跑 npm run extract[\s\S]*不联网/);
  });

  it('旧文案（把 extract 当恢复动作）不再出现在任何一条里', () => {
    for (const m of messages) expect(m).not.toMatch(/重跑 npm run extract|重跑 build-anchor/);
  });

  it('漂移条数仍写进消息本身（人工核对时要看得见解有多长）', () => {
    expect(driftRemediation(7)).toContain('7');
  });

  it('CLI 段只做拼装：三条消息全部来自导出的常量/纯函数', async () => {
    const src = await readFile(new URL('./check-drift.ts', import.meta.url), 'utf8');
    // 只扫 CLI 块（文件尾部）：常量定义处的注释允许引用旧文案说明其缺陷。
    const cli = src.slice(src.indexOf('if (isCliEntry(import.meta.url'));
    // indexOf 落空会静默返回 -1，slice(-1) 只剩一个换行——下面所有断言全绿但什么都没检查。
    expect(cli.startsWith('if (isCliEntry(')).toBe(true);
    expect(cli).not.toMatch(/重跑 npm run extract|重跑 build-anchor/);
    for (const name of ['driftRemediation(', 'STALE_CACHE_REMEDIATION', 'COUNT_MISMATCH_REMEDIATION']) {
      expect(cli).toContain(name);
    }
    // 消息**定义处**含 FETCH_RECOVERY 是必然的，断言 src 等于没断言；改钉 CLI 真的用了它。
    expect(src).toContain('FETCH_RECOVERY');
    expect(cli).toContain('driftRemediation(');
  });

  // 终审 I2 的收口项：读侧也要认 anchor.commit 的形状。锚点是 JSON，谁都能手改；
  // 缺这道检查时把 commit 改回 "main" 就能让全部闸门绿灯通过（写侧有契约、读侧没有）。
  it('CLI 在**使用** anchor.commit 之前先校验其形状，并给出专用补救文案', async () => {
    const src = await readFile(new URL('./check-drift.ts', import.meta.url), 'utf8');
    const cli = src.slice(src.indexOf('if (isCliEntry(import.meta.url'));
    expect(cli.startsWith('if (isCliEntry(')).toBe(true);
    expect(cli).toContain('ANCHOR_COMMIT_REMEDIATION');
    const guard = cli.indexOf('COMMIT_SHA.test(anchor.commit)');
    const use = cli.indexOf('buildAnchorFromDir(anchor.commit)');
    expect(guard).toBeGreaterThan(-1);
    // 顺序是本条的全部意义：先用了再查，检查结果就只是事后追认。
    expect(guard).toBeLessThan(use);
  });

  it('ANCHOR_COMMIT_REMEDIATION 不假设锚点里的 SHA 可信：起点是重新解析上游头', () => {
    // FETCH_RECOVERY 让人"按 anchor 记录的 SHA 重拉"，本条恰恰是那个记录不可信，
    // 所以它**必须**引用 FETCH_RECOVERY 之外的一条路径。
    expect(ANCHOR_COMMIT_REMEDIATION).toContain('git ls-remote');
    expect(ANCHOR_COMMIT_REMEDIATION).not.toContain('anchor.json 记录的那');
    expect(ANCHOR_COMMIT_REMEDIATION).toContain('人工确认');
  });
});
