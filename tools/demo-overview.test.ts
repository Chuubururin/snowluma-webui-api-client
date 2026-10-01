// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
/**
 * L2：总览页路由 + 纯渲染函数。
 *
 * 假上游的每个键都是契约断言（carry-notes 10）⇒ 形状逐条从 `spec/openapi.yaml` 与上游实码核过，
 * 不照抄 brief 的草稿夹具（那份有四形是编的）：
 *  · `/api/qq-list`（`:2298`，**不是** `/api/qq/list`）
 *  · `listQq` / `listConnections` / `listProcesses` 的 200 都是 `{ list: [...] }`
 *    （`:2335-2340` / `:2313-2318` / `:2288-2294`，`required:[list]`；brief 写的 `items:[]` 不存在）
 *  · `getStatus` 的 200 只有 `{ status: 'running' }`（StatusInfo `:49-55` + 实码 `server.ts:1031` 唯一 return）
 *  · `getSystem` 的 SystemInfo 12 个顶层键恒在（`:877-925`），**里面没有应用版本**
 *  · `UpdateCheckResult` 七键 required，`latest/htmlUrl/notes/publishedAt` 可空非可选，`error` 唯一可选
 *    （`:858-875`；实码 `update-check.ts:146` 的失败支是 200 + `error`，从不报 5xx）
 *  · `/api/ui` 的 200 是 `{config}`（`:2588`），轮询周期读 `config.appearance.pollInterval`（`:730`）
 *
 * 门禁侧：本文件的多数用例要让第二道闸放行。demo 侧唯一合法的"没有真读过闸状态也放行"的路径是
 * 操作者显式继续（`POST /gate/acknowledge`，落地），故夹具统一先走那一条 ——
 * 它同时也是 `gateDispatch` 收尾能被测到的前提：闸读不出来时请求才会真的出网打到上游那道真闸。
 */
import { describe, expect, it } from 'vitest';
import { OVERVIEW_OPS, overviewRoutes, systemPollMs } from '../demo/server/routes/overview.js';
import {
  renderOverview,
  renderSystemCard,
  renderUpdateBadge,
  checkTime,
  type OverviewModel,
  type SystemInfoShape,
  type UpdateCheckShape,
} from '../demo/client/pages/overview.js';
import { gateRoutes } from '../demo/server/routes/gates.js';
import { OPERATIONS } from '../demo/server/upstream.js';
import { hit, statefulUpstream, type FakeUpstream } from './helpers/demo-http.js';

const routes = { ...gateRoutes, ...overviewRoutes };

const SYSTEM: SystemInfoShape = {
  hostname: 'host-a',
  platform: 'linux',
  arch: 'x64',
  archLabel: 'x86_64',
  release: '6.1.0-amd64',
  distro: 'Debian GNU/Linux 12',
  uptime: 123_456,
  processUptime: 3_456,
  nodeVersion: 'v22.1.0',
  cpu: { model: 'EPYC', cores: 8, speedMHz: 2400, loadAvg: [0.1, 0.2, 0.3], perCore: [10, 20], average: 12.5 },
  memory: { total: 16_000_000_000, free: 8_000_000_000, used: 8_000_000_000, usagePercent: 50 },
  runtime: { pid: 4242, rss: 100, heapTotal: 200, heapUsed: 300, external: 400, arrayBuffers: 500 },
};

/** 七条上游路径的"健康实例"响应体，逐键按 spec。 */
const OK_BODIES: Record<string, unknown> = {
  '/api/status': { status: 'running' },
  '/api/system': SYSTEM,
  '/api/qq-list': { list: [{ uin: '10001', nickname: '小明' }] },
  '/api/connections': {
    list: [
      {
        uin: '10001',
        nickname: '小明',
        adapters: [
          { name: 'http-server', kind: 'httpServer', status: 'ok', detail: '监听 :3000' },
          {
            name: 'ws-client',
            kind: 'wsClient',
            status: 'down',
            detail: '连接断开',
            lastError: 'ECONNRESET',
            lastErrorAt: 1_767_000_000,
          },
        ],
      },
    ],
  },
  '/api/processes': {
    list: [
      {
        pid: 1234,
        name: 'QQ.exe',
        path: 'C:/QQ/QQ.exe',
        injected: true,
        connected: true,
        loggedIn: true,
        uin: '10001',
        status: 'online',
        error: '',
        method: 'loadModuleManual',
      },
    ],
  },
  '/api/update/check': {
    current: '1.14.20',
    latest: null,
    hasUpdate: false,
    htmlUrl: null,
    notes: null,
    publishedAt: null,
    checkedAt: 1_767_000_000_000,
  },
  // UiConfig.appearance 有 27 个必填键，本路由只消费 pollInterval（`:730`）⇒ 夹具只带被消费的那一个
  '/api/ui': { config: { version: 1, appearance: { pollInterval: 3000 } } },
};

/** 一台健康实例，可按路径覆盖成失败形；`seen` 记的是含 query 的完整上游路径。 */
function instance(overrides: Record<string, { status: number; body: unknown }> = {}) {
  const seen: string[] = [];
  const handler: FakeUpstream = (path) => {
    seen.push(path);
    const clean = path.split('?')[0] as string;
    if (overrides[clean]) return overrides[clean];
    if (clean in OK_BODIES) return { status: 200, body: OK_BODIES[clean] };
    return { status: 404, body: { success: false, message: `总览夹具没有 ${clean} 这条` } };
  };
  return { seen, u: statefulUpstream(handler) };
}

/** 显式继续一次，让第二道闸放行（理由见文件头）。 */
async function pastTheGate(u: ReturnType<typeof statefulUpstream>): Promise<void> {
  u.authenticate('TK-fixture');
  const ack = await hit(u, routes, 'POST', '/gate/acknowledge', {});
  expect(ack.json).toMatchObject({ step: 'app' });
}

describe('overview (L2)', () => {
  it('GET /overview 一次拿齐七份，每份都是 spec 的线上形状', async () => {
    const f = instance();
    await pastTheGate(f.u);
    const r = await hit(f.u, overviewRoutes, 'GET', '/overview');
    expect(r.status).toBe(200);
    expect(r.json.errors).toEqual({});
    // getStatus：线上只有这一个键
    expect(r.json.data.status).toEqual({ status: 'running' });
    expect(r.json.data.qq.list).toEqual([{ uin: '10001', nickname: '小明' }]);
    expect(r.json.data.connections.list[0].adapters).toHaveLength(2);
    expect(r.json.data.processes.list[0].status).toBe('online');
    expect(r.json.data.system.processUptime).toBe(3456);
    expect(r.json.data.update.current).toBe('1.14.20');
    expect(r.json.data.ui.config.appearance.pollInterval).toBe(3000);
    expect(Object.keys(r.json.data).sort()).toEqual(
      ['connections', 'processes', 'qq', 'status', 'system', 'ui', 'update'],
    );
  });

  it('实例版本读 update.current、运行秒数读 system.processUptime（两个都不在 /api/status 里）', async () => {
    const f = instance();
    await pastTheGate(f.u);
    const r = await hit(f.u, overviewRoutes, 'GET', '/overview');
    expect(r.json.data.update.current).toBe('1.14.20');
    expect(r.json.data.system.processUptime).toBe(3456);
    // 反向钉住那个缺陷的延续形态：外壳不许再从 status 响应里"顺手"读版本/uptime
    expect(JSON.stringify(r.json.data.status)).toBe('{"status":"running"}');
  });

  it('systemInfo 的轮询周期由实例的 appearance.pollInterval 决定（systemPollMs 真的生效）', async () => {
    const f = instance();
    await pastTheGate(f.u);
    const r = await hit(f.u, overviewRoutes, 'GET', '/overview');
    expect(r.json.pollInterval).toBe(3000);
    expect(r.json.systemPollMs).toBe(30_000); // max(3000 × 10, 10_000)
  });

  it('ui 配置读不出来 ⇒ pollInterval 是 null（不猜），周期落回默认档', async () => {
    const f = instance({ '/api/ui': { status: 500, body: { message: 'ui boom' } } });
    await pastTheGate(f.u);
    const r = await hit(f.u, overviewRoutes, 'GET', '/overview');
    expect(r.status).toBe(200);
    expect(r.json.errors.ui).toContain('500');
    expect(r.json.pollInterval).toBeNull();
    expect(r.json.systemPollMs).toBe(50_000); // 默认 5000 × 10
    expect(r.json.data.qq.list).toHaveLength(1); // 其余六路不受影响
  });

  it('单条挂掉进 errors.<key> 而不是整体 500，其余各条照常返回', async () => {
    const f = instance({ '/api/system': { status: 500, body: { message: 'boom' } } });
    await pastTheGate(f.u);
    const r = await hit(f.u, overviewRoutes, 'GET', '/overview');
    expect(r.status).toBe(200);
    expect(r.json.errors).toEqual({ system: '500 boom' });
    expect(r.json.data.system).toBeUndefined();
    expect(r.json.data.qq.list).toHaveLength(1);
    expect(r.json.data.update.current).toBe('1.14.20');
  });

  it('七路各自 try/catch：一条 500 不会把别的项目一起拖走', async () => {
    const f = instance({ '/api/connections': { status: 500, body: { message: 'conn boom' } } });
    await pastTheGate(f.u);
    const r = await hit(f.u, overviewRoutes, 'GET', '/overview');
    expect(r.json.errors).toEqual({ connections: '500 conn boom' });
    expect(r.json.data.status).toEqual({ status: 'running' });
    expect(r.json.data.system.hostname).toBe('host-a');
    expect(r.json.data.qq.list).toHaveLength(1);
    expect(r.json.data.processes.list).toHaveLength(1);
    expect(r.json.data.update.current).toBe('1.14.20');
  });

  it('GET /overview/system 只打 /api/system 一条（systemInfo 不在流上，独立轮询）', async () => {
    const f = instance();
    await pastTheGate(f.u);
    f.seen.length = 0;
    const r = await hit(f.u, overviewRoutes, 'GET', '/overview/system');
    expect(r.status).toBe(200);
    expect(r.json.data).toEqual(SYSTEM);
    expect(f.seen).toEqual(['/api/system']); // 一条不多：轮询不得顺带把七路再打一遍
  });

  it('POST /overview/update-check 用 spec 的字符串枚举上行 force（立即检查绕开服务端缓存）', async () => {
    const f = instance();
    await pastTheGate(f.u);
    f.seen.length = 0;
    const r = await hit(f.u, overviewRoutes, 'POST', '/overview/update-check', {});
    expect(r.status).toBe(200);
    expect(r.json.data.current).toBe('1.14.20');
    // 上游判据是字面量 `=== 'true' || === '1'`（server.ts:1040），从不解析成布尔
    expect(f.seen).toEqual(['/api/update/check?force=1']);
  });

  it('检查失败也走 200 + error：不报 5xx，客户端据此显示"检查未成功"而不是"已是最新"', async () => {
    const failed: UpdateCheckShape = {
      current: '1.14.20',
      latest: null,
      hasUpdate: false,
      htmlUrl: null,
      notes: null,
      publishedAt: null,
      checkedAt: 1,
      error: 'fetch failed',
    };
    const f = instance({ '/api/update/check': { status: 200, body: failed } });
    await pastTheGate(f.u);
    const r = await hit(f.u, overviewRoutes, 'POST', '/overview/update-check', {});
    expect(r.status).toBe(200);
    expect(r.json.data).toEqual(failed);
    const badge = renderUpdateBadge(r.json.data);
    expect(badge).toContain('检查未成功');
    expect(badge).not.toContain('已是最新');
    expect(renderUpdateBadge({ ...failed, error: 'disabled' })).toContain('更新检查已关闭');
    expect(renderUpdateBadge({ ...failed, error: undefined })).toContain('已是最新');
    // 有 error 时那一支优先：hasUpdate 在失败支里恒 false，但即便上游给了 true 也不能盖过"检查未成功"
    expect(renderUpdateBadge({ ...failed, error: undefined, hasUpdate: true, latest: '1.15.0' })).toContain('1.15.0');
    // `checkedAt` 是 epoch 毫秒（spec :866）：徽标上给人读得懂的时间，不许把原始时间戳印到页面上
    const withTime = { ...failed, error: undefined, hasUpdate: true, latest: '1.15.0', checkedAt: 1_767_000_000_000 };
    expect(renderUpdateBadge(withTime)).not.toContain('1767000000000');
    expect(renderUpdateBadge(withTime)).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
    expect(checkTime(Number.NaN)).toBe('时间未知');
    expect(checkTime(undefined)).toBe('时间未知');
    expect(checkTime('1767000000000')).toBe('时间未知'); // 字符串不猜：上游给的是 number
  });

  it('门禁未过时 GET /overview 被服务端拒，一条都不出网', async () => {
    // 有会话但没读过门禁状态（也没显式继续）：第二道闸判"无法确认"⇒ 403 且不出网。
    // 认证闸（index.ts）那条 401 支由 tools/demo-server.test.ts 钉，这里要的是 gateGuard 这一道。
    const f = instance();
    f.u.authenticate('TK-fixture');
    const r = await hit(f.u, routes, 'GET', '/overview');
    expect(r.status).toBe(403);
    expect(r.json).toMatchObject({ step: 'unknown' });
    expect(f.seen).toEqual([]); // 不出网是设计要的，不是优化
  });

  it('三条路由都有第二道闸：门禁未过时 /overview/system 与 /overview/update-check 同样不出网', async () => {
    // GET /overview 那条由 demo-lists 的静态核 + 上面那条行为用例双重钉住；这里补齐另两条路由，
    // 否则"只给首屏路由加闸"这种半吊子实现能一路绿灯。
    for (const [method, path] of [
      ['GET', '/overview/system'],
      ['POST', '/overview/update-check'],
    ] as const) {
      const f = instance();
      f.u.authenticate('TK-fixture'); // 有会话，但门禁状态从没读过也没显式继续
      const r = await hit(f.u, routes, method, path, {});
      expect(r.status, `${method} ${path}`).toBe(403);
      expect(r.json, `${method} ${path}`).toMatchObject({ step: 'unknown' });
      expect(f.seen, `${method} ${path} 不许出网`).toEqual([]);
    }
  });

  it('上游那道真闸不能被折成"数据不存在"：403 consentRequired 交回门禁屏', async () => {
    const gate: { status: number; body: unknown } = {
      status: 403,
      body: { status: 'failed', message: '请先阅读并同意用户协议与隐私政策', consentRequired: true },
    };
    const f = instance({ '/api/system': gate, '/api/status': gate });
    await pastTheGate(f.u);
    const r = await hit(f.u, overviewRoutes, 'GET', '/overview');
    expect(r.json).toMatchObject({ step: 'consent', consentRequired: true });
    expect(r.json.errors).toBeUndefined(); // 不许留在面板上显示成"这一格加载失败"
  });

  it('门控 401（会话死了）走 401 回登录屏，不是 200 带 errors', async () => {
    const dead = {
      status: 401,
      body: { status: 'failed', message: 'Token expired or invalid' },
    };
    const f = instance({ '/api/system': dead, '/api/status': dead });
    await pastTheGate(f.u);
    const r = await hit(f.u, overviewRoutes, 'GET', '/overview');
    expect(r.status).toBe(401);
    expect(r.json).toMatchObject({ step: 'login' });
  });

  it('GET /overview/system 的失败收尾：门禁信号交回门禁，普通 500 才是本路由自己的兜底', async () => {
    const f = instance({ '/api/system': { status: 500, body: { message: 'system boom' } } });
    await pastTheGate(f.u);
    const own = await hit(f.u, overviewRoutes, 'GET', '/overview/system');
    expect(own.status).toBe(502);
    expect(String(own.json.message)).toContain('系统信息');
    expect(String(own.json.message)).toContain('system boom');

    const gate = {
      status: 403,
      body: { status: 'failed', message: '请先修改密码', mustChangePassword: true },
    };
    const g = instance({ '/api/system': gate });
    await pastTheGate(g.u);
    const back = await hit(g.u, overviewRoutes, 'GET', '/overview/system');
    expect(back.json).toMatchObject({ step: 'password', mustChangePassword: true });
  });

  it('OVERVIEW_OPS 只列 spec 里真存在的 operationId（不发明操作名）', () => {
    expect([...OVERVIEW_OPS].sort()).toEqual([
      'checkUpdate',
      'getStatus',
      'getSystem',
      'getUiConfig',
      'listConnections',
      'listProcesses',
      'listQq',
    ]);
    for (const op of OVERVIEW_OPS) expect(OPERATIONS, `spec 里没有 ${op}`).toContain(op);
  });

  it('systemPollMs：默认 5 秒档、下限 10 秒、非正数与缺键都落回默认档', () => {
    expect(systemPollMs(undefined)).toBe(50_000);
    expect(systemPollMs(3000)).toBe(30_000);
    expect(systemPollMs(1500)).toBe(15_000);
    expect(systemPollMs(900)).toBe(10_000); // 下限：max(9000, 10_000)
    expect(systemPollMs(0)).toBe(50_000); // 上游把 0 当"已暂停轮询"，demo 不学它（已登记 declination）
    expect(systemPollMs(-5)).toBe(50_000);
    expect(systemPollMs(Number.NaN)).toBe(50_000);
  });
});

describe('overview 渲染（纯函数，不碰 DOM）', () => {
  const base: OverviewModel = { data: {}, errors: {}, pollInterval: null, systemPollMs: 50_000 };

  it('每个 errored 区块画出自己的错误文案，且不留悬挂的"加载中…"', () => {
    const html = renderOverview({
      data: { status: { status: 'running' }, qq: { list: [] } },
      errors: {
        system: '500 boom',
        connections: '500 conn boom',
        processes: '500 proc boom',
        update: '500 upd boom',
        ui: '500 ui boom',
      },
      pollInterval: null,
      systemPollMs: 50_000,
    });
    for (const msg of ['500 boom', '500 conn boom', '500 proc boom', '500 upd boom', '500 ui boom']) {
      expect(html).toContain(msg);
    }
    expect(html).not.toContain('加载中');
  });

  it('七个 PARITY 控件名逐字挂上 data-ctl（的 controls 匹配按这个）', () => {
    const html = renderOverview(base);
    for (const ctl of [
      'statusCards',
      'qqList',
      'connectionTable',
      'processSummary',
      'updateBadge',
      'stateStreamFeed',
      'pollIntervalSelect',
    ]) {
      expect(html, `缺 data-ctl="${ctl}"`).toContain(`data-ctl="${ctl}"`);
    }
  });

  it('空列表是真形：0 个账号显示"暂无"，不是空白也不是错误', () => {
    const html = renderOverview({
      ...base,
      data: { qq: { list: [] }, connections: { list: [] }, processes: { list: [] }, status: { status: 'running' } },
      pollInterval: 3000,
      systemPollMs: 30_000,
    });
    expect(html).toContain('暂无');
    expect(html).not.toContain('undefined');
    expect(html).not.toContain('NaN');
  });

  it('systemInfo 卡只读 spec 的 12 个键：不把 release 说成应用版本', () => {
    const html = renderSystemCard(SYSTEM);
    expect(html).toContain('host-a');
    expect(html).toContain('EPYC');
    expect(html).toContain('v22.1.0');
    expect(html).toContain('3456');
    expect(html).toContain('6.1.0-amd64'); // OS 内核版本，标签必须是"内核"
    expect(html).not.toContain('SnowLuma 版本');
  });

  it('systemInfo 读不出来时显示错误，不是永远"加载中"', () => {
    const html = renderSystemCard(null, '502 系统信息读取失败');
    expect(html).toContain('502');
    expect(html).not.toContain('加载中');
  });

  it('连接表把可选的 lastError/lastErrorAt 也带上（缺键与有键两种形状都不崩）', () => {
    const html = renderOverview({
      ...base,
      // 夹具那份就是 /api/connections 的 200 体（`{list:[...]}`），直接端给渲染层
      data: { connections: OK_BODIES['/api/connections'] as never },
    });
    expect(html).toContain('ECONNRESET');
    expect(html).toContain('监听 :3000');
  });

  it('进程摘要卡与 stateStreamFeed 容器都在（只换数据来源，不改控件名单）', () => {
    const html = renderOverview({
      ...base,
      data: { processes: OK_BODIES['/api/processes'] as never, qq: OK_BODIES['/api/qq-list'] as never },
    });
    expect(html).toContain('1234');
    expect(html).toContain('在线');
    expect(html).toContain('推流');
  });
});
