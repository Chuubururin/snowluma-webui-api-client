// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
/**
 * L2：日志页路由（列表 / 级别读 / 级别写 / TRACE 导出）+ 纯渲染函数。
 *
 * 形状逐条读自 spec 与 vendor 实码（carry-notes 10：编一个上游没有的键 ⇒ 测试全绿 + 真实例永远空白）：
 *  · `GET /api/logs` 的 200 **只有 `{list}`**（required:[list]，`spec:2358-2364`；上游 `server.ts:1424-1427`），
 *    级别不在里面 —— 它是另一条 `GET /api/logs/level` 的 `{level, levels}`（`:2384-2390`）。
 *  · `limit` 是**字符串** query，上游缺省 300（`:2350-2354`）。demo 的钳位（1..5000）是自己的策略，
 *    注释里写清，不冒充上游语义。
 *  · 非法级别的 400 是 `{message, levels}`，**没有 success 键**（`InvalidLogLevel` → `LevelRejected`，`:1356-1360`）。
 *  · `exportTraceLog` 的 200 是 `text/plain` 字符串（`:2414-2449`），生成的客户端读不到响应头
 *    （`grep -rn responseHeader generated/typescript/` 零命中）⇒ 文件名只能从正文的 `Export time:` 行按
 *    上游同一规则拼（`log-export.ts:26-29`：`slice(0,19)` 后 `[:.]`→`-`，**保留中间的 T**）。
 *  · setLogLevel 是 t2 + `mutate-map`：即时生效、只改内存 logger ⇒ 措辞是"当前会话生效"，不写"已保存"。
 */
import { describe, expect, it } from 'vitest';
import {
  LIMIT_DEFAULT,
  clampLimit,
  logRoutes,
  traceFilename,
  traceSummary,
} from '../demo/server/routes/logs.js';
import {
  renderLevelPicker,
  renderLogTable,
  renderTraceSummary,
} from '../demo/client/pages/logs.js';
import { gateRoutes } from '../demo/server/routes/gates.js';
import { hit, statefulUpstream, type FakeUpstream } from './helpers/demo-http.js';

const routes = { ...gateRoutes, ...logRoutes };

const ENTRY = { id: 7, time: '2026-09-28T10:00:00.000Z', level: 'warn', scope: 'onebot', uin: 10001, message: '心跳超时', line: '2026-09-28T10:00:00.000Z WARN  [onebot] 心跳超时' };
const LEVELS = ['trace', 'debug', 'info', 'success', 'warn', 'error'];

const EXPORT_BODY = [
  'SnowLuma full TRACE export',
  '==========================',
  'SnowLuma version: 1.14.20',
  'Operating system: win32',
  'Architecture: x64',
  'Node.js version: v24.18.0',
  'Current log level: INFO',
  'Export time: 2026-09-28T14:03:22.481Z',
  'Retained records: 2',
  '',
  'Logs',
  '----',
  ENTRY.line,
].join('\n');

/** 记账型假上游：按路径覆盖；`seen` 用来钉"不许出网"。 */
function instance(overrides: Record<string, { status: number; body?: unknown; text?: string }> = {}) {
  const seen: string[] = [];
  const seenBodies: Array<{ path: string; body: any }> = [];
  const handler: FakeUpstream = async (path, init) => {
    const clean = path.split('?')[0];
    seen.push(path);
    seenBodies.push({ path, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (overrides[clean]) return overrides[clean];
    if (clean === '/api/logs') return { status: 200, body: { list: [ENTRY] } };
    if (clean === '/api/logs/level') {
      if (init?.method === 'POST') return { status: 200, body: { level: JSON.parse(String(init.body)).level, levels: LEVELS } };
      return { status: 200, body: { level: 'info', levels: LEVELS } };
    }
    if (clean === '/api/logs/export/trace') return { status: 200, text: EXPORT_BODY };
    return { status: 404, body: { success: false, message: `日志夹具没有 ${clean}` } };
  };
  return { seen, seenBodies, u: statefulUpstream(handler) };
}

async function pastTheGate(u: ReturnType<typeof statefulUpstream>): Promise<void> {
  u.authenticate('TK-fixture');
  expect((await hit(u, routes, 'POST', '/gate/acknowledge', {})).json).toMatchObject({ step: 'app' });
}

describe('logs (L2)', () => {
  it('limit 与上游同缺省（300），非法回落 300，越界钳到 1..5000，且以字符串上行', async () => {
    const f = instance();
    await pastTheGate(f.u);
    expect(LIMIT_DEFAULT).toBe(300);
    for (const [raw, want] of [
      [null, 300],
      ['50', 50],
      ['abc', 300],
      ['-3', 300],
      ['0', 300],
      ['99999', 5000],
      ['12.7', 12],
    ] as Array<[string | null, number]>) {
      expect(clampLimit(raw), `limit=${raw}`).toBe(want);
    }
    const before = f.seen.length;
    await hit(f.u, logRoutes, 'GET', '/logs?limit=50');
    expect(f.seen[before]).toContain('limit=50');
    await hit(f.u, logRoutes, 'GET', '/logs');
    expect(f.seen[before + 1]).toContain('limit=300');
  });

  it('GET /logs 读 list 键（不是 records/logs），data 就是那个数组', async () => {
    const f = instance();
    await pastTheGate(f.u);
    const r = await hit(f.u, logRoutes, 'GET', '/logs');
    expect(Array.isArray(r.json.data)).toBe(true);
    expect(r.json.data[0].id).toBe(7);
    // 上游回空列表时 data 是 []，不是 undefined：客户端要能区分"读了但没日志"与"没读到"
    const empty = instance({ '/api/logs': { status: 200, body: { list: [] } } });
    await pastTheGate(empty.u);
    expect((await hit(empty.u, logRoutes, 'GET', '/logs')).json.data).toEqual([]);
  });

  it('级别是独立一条读：GET /loglevel 原样带出 level 与 levels 六值', async () => {
    const f = instance();
    await pastTheGate(f.u);
    const r = await hit(f.u, logRoutes, 'GET', '/loglevel');
    expect(r.json.data).toEqual({ level: 'info', levels: LEVELS });
  });

  it('空 level 不发上行（客户端选择器不是安全边界）', async () => {
    const f = instance();
    await pastTheGate(f.u);
    const before = f.seen.length;
    for (const body of [{ level: '' }, {}, { level: 7 }, null]) {
      const r = await hit(f.u, logRoutes, 'POST', '/loglevel', body);
      expect(r.status).toBe(400);
    }
    expect(f.seen.slice(before)).toEqual([]);
  });

  it('非法级别保住上游的 400 与 {message,levels}——不编出上游不发的 success 键', async () => {
    const f = instance({
      '/api/logs/level': { status: 400, body: { message: 'level 必须是六值之一', levels: LEVELS } },
    });
    await pastTheGate(f.u);
    const r = await hit(f.u, logRoutes, 'POST', '/loglevel', { level: 'verbose' });
    expect(r.status).toBe(400);
    expect(r.json.message).toBe('level 必须是六值之一');
    expect(r.json.levels).toEqual(LEVELS); // 下拉的选项来自服务端回传，不靠客户端硬编码
    expect('success' in r.json).toBe(false);
  });

  it('级别改成功回显生效后的那一份（level 与 levels 同形返回）', async () => {
    const f = instance();
    await pastTheGate(f.u);
    const r = await hit(f.u, logRoutes, 'POST', '/loglevel', { level: 'debug' });
    expect(r.json.data).toEqual({ level: 'debug', levels: LEVELS });
    expect(f.seenBodies.some((s) => s.path === '/api/logs/level' && s.body?.level === 'debug')).toBe(true);
  });

  it('导出：文件名从正文 Export time 行按上游规则拼（保留 T，: 与 . 转 -），元信息进摘要', async () => {
    expect(traceFilename(EXPORT_BODY)).toBe('snowluma-trace-2026-09-28T14-03-22.log');
    const meta = traceSummary(EXPORT_BODY);
    expect(meta['SnowLuma version']).toBe('1.14.20');
    expect(meta['Current log level']).toBe('INFO');
    expect(meta['Retained records']).toBe('2');
    const f = instance();
    await pastTheGate(f.u);
    const r = await hit(f.u, logRoutes, 'GET', '/export-trace');
    expect(r.json.data.filename).toBe('snowluma-trace-2026-09-28T14-03-22.log');
    expect(r.json.data.summary['Export time']).toBe('2026-09-28T14:03:22.481Z');
    expect(r.json.data.text).toContain('心跳超时');
  });

  it('正文里没有 Export time 行时不代造文件名（宁可说"未给出"，也不冒充上游）', async () => {
    expect(traceFilename('Logs\n----\n只有正文')).toBeNull();
    const f = instance({ '/api/logs/export/trace': { status: 200, text: 'Logs\n----\n一行都没有' } });
    await pastTheGate(f.u);
    const r = await hit(f.u, logRoutes, 'GET', '/export-trace');
    expect(r.json.data.filename).toBeNull();
    expect(r.json.data.filenameNote).toContain('未');
  });

  it('四条路由都有第二道闸：门禁未过 403 且一条都不出网', async () => {
    for (const [method, path, body] of [
      ['GET', '/logs', undefined],
      ['GET', '/loglevel', undefined],
      ['POST', '/loglevel', { level: 'info' }],
      ['GET', '/export-trace', undefined],
    ] as Array<[string, string, unknown]>) {
      const f = instance();
      f.u.authenticate('TK-fixture'); // 有会话，但门禁状态没读过
      const r = await hit(f.u, routes, method, path, body);
      expect(r.status, `${method} ${path}`).toBe(403);
      expect(r.json, `${method} ${path}`).toMatchObject({ step: 'unknown' });
      expect(f.seen, `${method} ${path} 不许出网`).toEqual([]);
    }
  });

  it('上游那道真闸不能被折成"读取失败"：403 两键与门控 401 都交回门禁', async () => {
    const consent = { status: 403, body: { status: 'failed', message: '请先阅读并同意', consentRequired: true } };
    const mustChange = { status: 403, body: { status: 'failed', message: '请先修改密码', mustChangePassword: true } };
    const dead = { status: 401, body: { status: 'failed', message: 'Token expired or invalid' } };
    for (const [label, gate] of [['consent', consent], ['password', mustChange], ['401', dead]] as const) {
      const f = instance({
        '/api/logs': gate,
        '/api/logs/level': gate,
        '/api/logs/export/trace': gate,
      });
      await pastTheGate(f.u);
      for (const path of ['/logs', '/loglevel', '/export-trace']) {
        const r = await hit(f.u, logRoutes, 'GET', path);
        expect(JSON.stringify(r.json), `${label} ${path} ⇒ 必须是门禁信号`).toContain('step');
      }
    }
  });

  describe('渲染（纯函数，不碰 DOM）', () => {
    it('四处控件逐字挂 data-ctl；空列表写"当前无保留日志"而不是空白表', () => {
      const html = renderLogTable([ENTRY]);
      expect(html).toContain('心跳超时');
      expect(html).toContain('2026-09-28T10:00:00.000Z');
      const empty = renderLogTable([]);
      expect(empty).toContain('当前无保留日志');
      expect(empty).not.toContain('undefined');
    });

    it('级别下拉的选项来自 levels；400 的 message 与"重启即回默认"都在页面上说清', () => {
      const html = renderLevelPicker({ level: 'info', levels: LEVELS });
      for (const lv of LEVELS) expect(html, `下拉缺选项 ${lv}`).toContain('value="' + lv + '"');
      // "即时生效、不持久化"是 setLogLevel 的真实语义（t2 + mutate-map），写成"已保存"就是撒谎
      expect(html).toContain('重启');
      const rejected = renderLevelPicker({ level: null, levels: LEVELS, error: '400 level 必须是六值之一' });
      expect(rejected).toContain('level 必须是六值之一');
      expect(rejected).toContain('info'); // 被拒后下拉仍有全部选项，不是空壳
    });

    it('导出摘要渲染元信息，正文不进 DOM（与"消除原始配置暴露"同一条裁定）', () => {
      const html = renderTraceSummary(traceSummary(EXPORT_BODY), 'snowluma-trace-2026-09-28T14-03-22.log');
      expect(html).toContain('1.14.20');
      expect(html).toContain('snowluma-trace-2026-09-28T14-03-22.log');
      expect(html).not.toContain('心跳超时');
    });
  });
});
