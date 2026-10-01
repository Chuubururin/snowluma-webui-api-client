// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
/**
 * 总览页路由（设计口径的"冷启动 REST 首屏 + systemInfo 独立轮询"）。
 *
 * 三条形状判据（都被 tools/demo-overview.test.ts 的假上游逐键钉住，假上游的键形抄自 spec 不是抄自愿望）：
 *  · `getStatus` 线上只有 `{status:'running'}`（`:49-55` + 实码 `server.ts:1031` 的唯一 return）
 *    ⇒ **实例版本与运行时长都不在这份响应里**：版本在 `UpdateCheckResult.current`（`:858-875`），
 *    运行秒数在 `SystemInfo.processUptime`（`:877-925`，`release` 是 OS 内核版本串，不是应用版本）。
 *  · 三个列表的 200 都是 `{list:[...]}`，`listQq` 的路径是 `/api/qq-list` —— 都由生成的 SDK 决定，
 *    本文件不出现任何上游路径字面量（carry-notes 8）。
 *  · `checkUpdate` 失败也走 200 并把原因折叠进 `error`（实码 `update-check.ts:146` 的 catch 支），
 *    所以这里不替它编 5xx；`force` 是字符串枚举 `'true'|'1'`（`:2085-2092`，上游按字面量比、从不解析成布尔）。
 *
 * 单点失败降级：七路并发、各自 try/catch，一条挂掉只落进 `errors.<key>`，整屏仍返 200。
 * 但"降级"不适用于门禁信号：会话若走过显式继续而上游那道真闸还挂着，403 两键与门控 401 必须
 * 把整屏交回门禁（`gateDispatch`），否则就是拿"这一格加载失败"伪装"门禁未过"（carry-notes 9）。
 */
import * as sdk from '../../../generated/typescript/sdk.gen.js';
import { fail, ok, type ApiResult, type RouteTable } from '../http.js';
import { UpstreamError, unwrap, type Upstream } from '../upstream.js';
import { gateDispatch, gateGuard } from './gates.js';

/** 本面板服务端真的发得出去的操作名单（实现批次拿它核对 PARITY 的 ops）。 */
export const OVERVIEW_OPS = [
  'getStatus',
  'getSystem',
  'listQq',
  'listConnections',
  'listProcesses',
  'checkUpdate',
  'getUiConfig',
] as const;

/**
 * systemInfo 的轮询周期：`max(pollInterval × 10, 10s)`，取的是实例自己配的
 * `appearance.pollInterval`（spec `:730`）——这条函数存在的意义就是让 `saveUiConfig` 的那个字段
 * 在 demo 里**真的生效**（否则整条写路径只能记 write-only）。
 * 非正数与缺键都落回 5000ms 档。上游把 `pollInterval === 0` 当"已暂停轮询"（`app-layout.tsx:277/301`
 * 的 `pollInterval > 0 ? setInterval(…) : null`），demo 有意不学（已登记 declination
 * `poll-interval-zero-pause`）：一个停摆的总览页看起来像坏了，而不是像被配置过。
 */
export function systemPollMs(pollInterval: number | undefined): number {
  const p = typeof pollInterval === 'number' && pollInterval > 0 ? pollInterval : 5000;
  return Math.max(p * 10, 10_000);
}

/** `{config:{appearance:{pollInterval}}}` —— 读不出来就是 undefined，不猜一个默认值上去。 */
function readPollInterval(ui: unknown): number | undefined {
  const raw = (ui as { config?: { appearance?: { pollInterval?: unknown } } } | null | undefined)?.config?.appearance
    ?.pollInterval;
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
}

function describeError(e: unknown): string {
  return e instanceof UpstreamError ? `${e.status} ${e.message}` : String((e as Error)?.message ?? e);
}

interface GatherBag {
  data: Record<string, unknown>;
  errors: Record<string, string>;
  /** 原样留着的错误对象：收尾时由 gateDispatch 判"这是门禁信号还是普通故障"。 */
  signals: unknown[];
}

/** 一路读取：成功进 data，失败进 errors 并把错误对象交给门禁判定（缺这一层就是整体 500）。 */
async function gather(bag: GatherBag, label: string, read: (u: Upstream) => Promise<unknown>, u: Upstream): Promise<void> {
  try {
    bag.data[label] = await read(u);
  } catch (e) {
    bag.errors[label] = describeError(e);
    bag.signals.push(e);
  }
}

/** 哨兵：gateDispatch 只在命中上游那三形时才改写它，其余原样返回 ⇒ 引用比对就能判"是不是门禁信号"。 */
const NOT_A_GATE_SIGNAL: ApiResult = { status: 0, body: null };

function gateSignalOf(signals: unknown[]): ApiResult | null {
  for (const e of signals) {
    const out = gateDispatch(e, NOT_A_GATE_SIGNAL);
    if (out !== NOT_A_GATE_SIGNAL) return out;
  }
  return null;
}

export const overviewRoutes: RouteTable = {
  'GET /overview': async (_ctx, u) => {
    const rejected = gateGuard(u);
    if (rejected) return rejected;
    const bag: GatherBag = { data: {}, errors: {}, signals: [] };
    // 七路并发，各自 try/catch：一条挂掉只塌自己那一格。unwrap 一律裹在 await 外面（carry-notes 1/15）。
    await Promise.all([
      gather(bag, 'status', async (x) => unwrap(await sdk.getStatus({ client: x.client })), u),
      gather(bag, 'system', async (x) => unwrap(await sdk.getSystem({ client: x.client })), u),
      gather(bag, 'qq', async (x) => unwrap(await sdk.listQq({ client: x.client })), u),
      gather(bag, 'connections', async (x) => unwrap(await sdk.listConnections({ client: x.client })), u),
      gather(bag, 'processes', async (x) => unwrap(await sdk.listProcesses({ client: x.client })), u),
      gather(bag, 'update', async (x) => unwrap(await sdk.checkUpdate({ client: x.client })), u),
      gather(bag, 'ui', async (x) => unwrap(await sdk.getUiConfig({ client: x.client })), u),
    ]);
    const gate = gateSignalOf(bag.signals);
    if (gate) return gate;
    const pollInterval = readPollInterval(bag.data.ui);
    return ok({
      data: bag.data,
      errors: bag.errors,
      pollInterval: pollInterval ?? null,
      systemPollMs: systemPollMs(pollInterval),
    });
  },

  // systemInfo 不在推流上（设计口径）⇒ 浏览器按 systemPollMs 单独轮这一条，别的都不顺带打。
  'GET /overview/system': async (_ctx, u) => {
    const rejected = gateGuard(u);
    if (rejected) return rejected;
    try {
      return ok({ data: unwrap(await sdk.getSystem({ client: u.client })) });
    } catch (e) {
      return gateDispatch(e, fail(502, `系统信息读取失败：${describeError(e)}`));
    }
  },

  // 显式的"立即检查"：绕开服务端那份 6 小时缓存由操作者点出来，demo 不自备定时器去强拉版本源。
  'POST /overview/update-check': async (_ctx, u) => {
    const rejected = gateGuard(u);
    if (rejected) return rejected;
    try {
      return ok({ data: unwrap(await sdk.checkUpdate({ client: u.client, query: { force: '1' } })) });
    } catch (e) {
      return gateDispatch(e, fail(502, `更新检查失败：${describeError(e)}`));
    }
  },
};
