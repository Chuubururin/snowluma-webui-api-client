// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
/**
 * L2：进程页路由 + 纯渲染函数。
 *
 * 四条动作全是 T3 + `x-snowluma-destructive: true`（spec `:2898-2991`）⇒ 本文件的假上游只是**记账**，
 * 绝不碰任何真实例；并且有一条用例专门钉"读列表不会顺带触发任何动作"。
 *
 * 键形逐条读自 spec（carry-notes 10：编一个上游没有的键 ⇒ L2 全绿 + 真实例上永远显示占位符）：
 *  · `listProcesses` 的 200 是 `{list:[HookProcessInfo]}`（`:2288-2294`），HookProcessInfo 十键恒在（`:301-321`）
 *  · 三个动作的 200 是 `ProcessActionResult = {success, process}`（`:509-516`），
 *    **success 在 200 里也可以为 false**（上游按 `processInfo.status !== 'error'` 判，`server.ts:1485`），
 *    描述原文就写着"消费方不得以 HTTP 码代状态"
 *  · `probeProcessLogin` 的 200 是 `{info}`，`info` 可为 null（`:2919-2925`，探不到即 null，**不是错误**）
 *  · `pid` 是整数 1..4194304（`:2913-2918`，实码 `Number(param)` + 整数范围判，`MAX_PID` 见 `server.ts:1475`）
 *    ⇒ `Number.isFinite` 拦不住 0 / -1 / 1.5 / 1e20，本文件逐条钉住
 *  · 三个动作是 POST `/api/processes/{pid}/load|unload|refresh`，SDK 侧走 `path:{pid}`（`:2928/2956/2984`）
 */
import { describe, expect, it } from 'vitest';
import {
  PROCESS_ACTIONS,
  PROCESS_MAX_PID,
  processRoutes,
} from '../demo/server/routes/processes.js';
import {
  renderActionOutcome,
  renderProbeCell,
  renderProcesses,
  type ProcessActionResultShape,
  type ProcessRow,
  type QqPortLoginInfoShape,
} from '../demo/client/pages/processes.js';
import { gateRoutes } from '../demo/server/routes/gates.js';
import { hit, statefulUpstream, type FakeUpstream } from './helpers/demo-http.js';

const routes = { ...gateRoutes, ...processRoutes };

const PROC: ProcessRow = {
  pid: 4321,
  name: 'QQ.exe',
  path: 'C:/QQ/QQ.exe',
  injected: true,
  connected: true,
  loggedIn: true,
  uin: '10001',
  status: 'online',
  error: '',
  method: 'loadModuleManual',
};

const PROBED: QqPortLoginInfoShape = { port: 3000, uin: '10001', identityKnown: true, uid: 'u-1', nickName: '小明' };

/** 记账型假上游：默认让三条动作与探测都成功，按用例覆盖个别路径。 */
function instance(overrides: Record<string, { status: number; body: unknown }> = {}) {
  const seen: string[] = [];
  const handler: FakeUpstream = (path) => {
    seen.push(path);
    const clean = path.split('?')[0] as string;
    if (overrides[clean]) return overrides[clean];
    if (clean === '/api/processes') return { status: 200, body: { list: [PROC] } };
    if (/^\/api\/processes\/\d+\/(load|unload|refresh)$/.test(clean)) {
      return { status: 200, body: { success: true, process: PROC } };
    }
    if (/^\/api\/processes\/\d+\/probe-login$/.test(clean)) {
      return { status: 200, body: { info: PROBED } };
    }
    return { status: 404, body: { success: false, message: `进程夹具没有 ${clean} 这条` } };
  };
  return { seen, u: statefulUpstream(handler) };
}

/** 显式继续一次让第二道闸放行（同 tools/demo-overview.test.ts 的理由）。 */
async function pastTheGate(u: ReturnType<typeof statefulUpstream>): Promise<void> {
  u.authenticate('TK-fixture');
  expect((await hit(u, routes, 'POST', '/gate/acknowledge', {})).json).toMatchObject({ step: 'app' });
}

describe('processes (L2)', () => {
  it('GET /processes 端出 spec 的十键，且一条动作都不顺带触发', async () => {
    const f = instance();
    await pastTheGate(f.u);
    const r = await hit(f.u, processRoutes, 'GET', '/processes');
    expect(r.status).toBe(200);
    expect(r.json.data).toEqual({ list: [PROC] });
    // T3 边界：进页面 = 只读列表。任何"顺手 load/refresh"都在这条上变红。
    expect(f.seen).toEqual(['/api/processes']);
  });

  it('列表读失败保留上游状态码与文案，不静默成空列表', async () => {
    const f = instance({ '/api/processes': { status: 500, body: { message: 'hook manager 不可用' } } });
    await pastTheGate(f.u);
    const r = await hit(f.u, processRoutes, 'GET', '/processes');
    expect(r.status).toBe(500);
    expect(String(r.json.message)).toContain('hook manager 不可用');
    expect(r.json.success).toBe(false);
  });

  it('动作只认白名单三个值，未知动作 400 且不出网（不再开放"任意操作可被 UI 触发"）', async () => {
    const f = instance();
    await pastTheGate(f.u);
    for (const action of ['nope', 'probe', 'loadProcess', 'invoke', '', 'constructor', '__proto__', 'toString']) {
      f.seen.length = 0;
      const r = await hit(f.u, processRoutes, 'POST', '/process-action', { action, pid: PROC.pid });
      expect(r.status, `action=${action}`).toBe(400);
      expect(f.seen, `action=${action} 不许出网`).toEqual([]);
    }
    expect([...PROCESS_ACTIONS].sort()).toEqual(['load', 'refresh', 'unload']);
  });

  it('三个动作各打各的路径，SDK 侧用 path:{pid} 而不是拼字符串', async () => {
    for (const [action, tail] of [
      ['load', 'load'],
      ['unload', 'unload'],
      ['refresh', 'refresh'],
    ] as const) {
      const f = instance();
      await pastTheGate(f.u);
      const r = await hit(f.u, processRoutes, 'POST', '/process-action', { action, pid: PROC.pid });
      expect(r.status, action).toBe(200);
      expect(f.seen, action).toEqual([`/api/processes/${PROC.pid}/${tail}`]);
      expect(r.json, action).toEqual({ success: true, process: PROC });
    }
  });

  it('pid 按 spec 的整数 1..4194304 核：0/-1/小数/超界/非数值一律 400 且不出网', async () => {
    const bad: unknown[] = [0, -1, 1.5, 4_194_305, 1e20, 'abc', '', null, undefined, Number.NaN,
      '0x10', '1e2', ' 42 ', '0b101', '12\n']; // Number() 的宽容转换形：十六进制/指数/空白/二进制/尾换行不是 pid 书写形
    for (const pid of bad) {
      const f = instance();
      await pastTheGate(f.u);
      f.seen.length = 0;
      const r = await hit(f.u, processRoutes, 'POST', '/process-action', { action: 'load', pid });
      expect(r.status, `pid=${String(pid)}`).toBe(400);
      expect(f.seen, `pid=${String(pid)} 不许出网`).toEqual([]);
      const probe = await hit(f.u, processRoutes, 'GET', `/probe-login?pid=${encodeURIComponent(String(pid))}`);
      expect(probe.status, `probe pid=${String(pid)}`).toBe(400);
    }
    // 两个边界值必须放行（spec 的 minimum/maximum 是闭区间）
    for (const pid of [1, PROCESS_MAX_PID]) {
      const f = instance();
      await pastTheGate(f.u);
      const r = await hit(f.u, processRoutes, 'POST', '/process-action', { action: 'load', pid });
      expect(r.status, `pid=${pid}`).toBe(200);
      expect(f.seen).toEqual([`/api/processes/${pid}/load`]);
    }
  });

  it('200 里 success:false 原样带到客户端，并带出 process.status（不得以 HTTP 码代状态）', async () => {
    const errored: ProcessActionResultShape = {
      success: false,
      process: { ...PROC, status: 'error', error: '注入失败：管道不可用', injected: false, connected: false, loggedIn: false },
    };
    const f = instance({ '/api/processes/4321/load': { status: 200, body: errored } });
    await pastTheGate(f.u);
    const r = await hit(f.u, processRoutes, 'POST', '/process-action', { action: 'load', pid: 4321 });
    expect(r.status).toBe(200);
    expect(r.json).toEqual(errored); // 路由没把它包成 {ok:true,...}
    expect(r.json.success).toBe(false);
    expect(r.json.process.status).toBe('error');
    // 渲染侧同一条判据：HTTP 200 + success:false 那一屏必须写成失败
    const screen = renderActionOutcome('load', r.json);
    expect(screen).toContain('失败');
    expect(screen).toContain('错误');
    expect(screen).not.toContain('完成');
  });

  it('动作失败透传上游 message 与状态码，不吞成 500', async () => {
    for (const status of [400, 500, 503]) {
      const f = instance({ '/api/processes/4321/unload': { status, body: { success: false, message: '进程不存在' } } });
      await pastTheGate(f.u);
      const r = await hit(f.u, processRoutes, 'POST', '/process-action', { action: 'unload', pid: 4321 });
      expect(r.status, `status=${status}`).toBe(status);
      expect(String(r.json.message)).toContain('进程不存在');
    }
  });

  it('probe-login 带 query 能命中路由（设计口径缺陷的回归钉），{info:null} 是真形不是错误', async () => {
    const f = instance({ '/api/processes/4321/probe-login': { status: 200, body: { info: null } } });
    await pastTheGate(f.u);
    const r = await hit(f.u, processRoutes, 'GET', '/probe-login?pid=4321');
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ info: null });
    expect(f.seen).toEqual(['/api/processes/4321/probe-login']);
    // 探不到 = 显示"未探测到"，不许渲染成"加载中"或空白
    const cell = renderProbeCell(null);
    expect(cell).toContain('未探测到');
    expect(cell).not.toContain('加载中');
    expect(cell.trim()).not.toBe('');
    expect(renderProbeCell(PROBED)).toContain('3000');
    expect(renderProbeCell(undefined)).toContain('探测');
  });

  it('探测的上游错误同样保留状态码（400/503 是 pid 不合法与 hook 层不在场，不是"没探到"）', async () => {
    const f = instance({ '/api/processes/4321/probe-login': { status: 503, body: { success: false, message: '桥接层不在场' } } });
    await pastTheGate(f.u);
    const r = await hit(f.u, processRoutes, 'GET', '/probe-login?pid=4321');
    expect(r.status).toBe(503);
    expect(String(r.json.message)).toContain('桥接层不在场');
  });

  it('三条路由都有第二道闸：门禁未过 403 且一条都不出网', async () => {
    for (const [method, path, body] of [
      ['GET', '/processes', undefined],
      ['POST', '/process-action', { action: 'load', pid: 4321 }],
      ['GET', '/probe-login?pid=4321', undefined],
    ] as const) {
      const f = instance();
      f.u.authenticate('TK-fixture'); // 有会话但没读过门禁状态、也没显式继续
      const r = await hit(f.u, routes, method, path, body);
      expect(r.status, `${method} ${path}`).toBe(403);
      expect(r.json, `${method} ${path}`).toMatchObject({ step: 'unknown' });
      expect(f.seen, `${method} ${path} 不许出网`).toEqual([]);
    }
  });

  it('上游那道真闸不能被折成"进程操作失败"：403 两键与门控 401 都交回门禁', async () => {
    const consent = {
      status: 403,
      body: { status: 'failed', message: '请先阅读并同意用户协议与隐私政策', consentRequired: true },
    };
    const mustChange = { status: 403, body: { status: 'failed', message: '请先修改密码', mustChangePassword: true } };
    const dead = { status: 401, body: { status: 'failed', message: 'Token expired or invalid' } };

    for (const [label, gate] of [['consent', consent], ['password', mustChange], ['401', dead]] as const) {
      const f = instance({
        '/api/processes': gate,
        '/api/processes/4321/load': gate,
        '/api/processes/4321/probe-login': gate,
      });
      await pastTheGate(f.u);
      const list = await hit(f.u, processRoutes, 'GET', '/processes');
      const act = await hit(f.u, processRoutes, 'POST', '/process-action', { action: 'load', pid: 4321 });
      const probe = await hit(f.u, processRoutes, 'GET', '/probe-login?pid=4321');
      for (const r of [list, act, probe]) {
        expect(JSON.stringify(r.json), `${label} ⇒ 必须是门禁信号，不是面板故障`).toContain('step');
      }
      if (label === '401') {
        expect(list.status).toBe(401);
        expect(act.status).toBe(401);
        expect(probe.status).toBe(401);
      }
    }
  });

  describe('渲染（纯函数，不碰 DOM）', () => {
    it('四个动作按钮逐字挂 data-ctl 并带上自己的 pid（T3：只有点得到才发得出）', () => {
      const html = renderProcesses({ data: { list: [PROC] }, errors: {}, outcomes: {}, probes: {} });
      for (const ctl of ['processTable', 'loadButton', 'unloadButton', 'refreshButton', 'probeButton']) {
        expect(html, `缺 data-ctl="${ctl}"`).toContain(`data-ctl="${ctl}"`);
      }
      expect(html).toContain(`data-pid="${PROC.pid}"`);
      expect(html).toContain('online'.length > 0 ? '已在线' : '');
    });

    it('没有进程时是明写的空态，不是空表格；错误态不是悬挂的加载文案', () => {
      const empty = renderProcesses({ data: { list: [] }, errors: {}, outcomes: {}, probes: {} });
      expect(empty).toContain('未检测到');
      expect(empty).not.toContain('data-ctl="loadButton"'); // 没有行就没有可点的动作
      const failed = renderProcesses({ data: null, errors: { load: '500 hook manager 不可用' }, outcomes: {}, probes: {} });
      expect(failed).toContain('500 hook manager 不可用');
      expect(failed).not.toContain('加载中');
    });

    it('HookProcessInfo 的十个键都有落点：error 是空串时不显示，非空时显示', () => {
      const withError = renderProcesses({
        data: { list: [{ ...PROC, status: 'error', error: '注入失败', injected: false }] },
        errors: {},
        outcomes: {},
        probes: {},
      });
      expect(withError).toContain('注入失败');
      expect(withError).toContain('C:/QQ/QQ.exe');
      expect(withError).toContain('loadModuleManual');
      const noError = renderProcesses({ data: { list: [PROC] }, errors: {}, outcomes: {}, probes: {} });
      expect(noError).not.toContain('<td class="err"></td>');
    });

    it('动作结果的三态分得开：成功 / HTTP 200 但 success:false / 还没点过', () => {
      expect(renderActionOutcome('refresh', { success: true, process: PROC })).toContain('刷新');
      expect(renderActionOutcome('refresh', undefined)).toBe('');
      const fail = renderActionOutcome('unload', { success: false, process: { ...PROC, status: 'error', error: '卸载没成' } });
      expect(fail).toContain('失败');
      expect(fail).toContain('卸载');
    });
  });
});
