// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
/**
 * 进程页路由（对齐真 WebUI 的 `processes-page.tsx`：进程注入控制面板）。
 *
 * 四条动作全是 `x-replay-class: t3` + `x-snowluma-destructive: true`（spec `:2898-2991`）⇒
 *  1. 只有操作者显式点击才发得出：本模块没有任何"进页面自动探测/自动重试/顺带触发"的路径，
 *     `GET /processes` 也只读列表（tools/demo-processes.test.ts 拿假上游的记账把这条钉住了）。
 *  2. 动态派发只认白名单三个动作，**不做 `sdk[action + 'Process']` 那种字符串取属性** ——
 *     那等于把"任意操作可被 UI 触发"重新开放，正是本 demo 消除的形态（原始调用台）。
 *  3. `ProcessActionResult` 的 `success` 在 200 里也可以为 false（`:509-516`，上游按
 *    `processInfo.status !== 'error'` 判，实码 `server.ts:1485`）⇒ 路由把 `{success,process}` **原样**
 *     端出去，不包成 `{ok:true,...}`（包一层就把失败吞成成功了）。
 *  4. `probeProcessLogin` 的 `{info:null}` 是真形（`:2919-2925`，探不到即 null，不是错误）。
 *  5. `pid` 是整数 1..4194304（`:2913-2918` + 实码 `server.ts:1475/1479`）⇒ 范围核在出网**之前**，
 *     `Number.isFinite` 拦不住 0/-1/1.5/1e20，这里用 `Number.isInteger` 加闭区间两端。
 */
import * as sdk from '../../../generated/typescript/sdk.gen.js';
import { fail, ok, type ApiResult, type RouteTable } from '../http.js';
import { UpstreamError, unwrap, type Upstream } from '../upstream.js';
import { gateDispatch, gateGuard } from './gates.js';

export const PROCESS_ACTIONS = ['load', 'unload', 'refresh'] as const;
export type ProcessAction = (typeof PROCESS_ACTIONS)[number];

/** 实码 `MAX_PID`（`server.ts:1475`），spec 的 path 参数maximum 同一个数。 */
export const PROCESS_MAX_PID = 4_194_304;

/**
 * 表驱动：动作名 → 操作。unwrap 一律在调用点里侧（carry-notes 1/15），
 * 否则那一处的 403/401/400 会被静默成 `{data:undefined}`。
 */
const ACTION_FN: Record<ProcessAction, (u: Upstream, pid: number) => Promise<unknown>> = {
  load: async (u, pid) => unwrap(await sdk.loadProcess({ client: u.client, path: { pid } })),
  unload: async (u, pid) => unwrap(await sdk.unloadProcess({ client: u.client, path: { pid } })),
  refresh: async (u, pid) => unwrap(await sdk.refreshProcess({ client: u.client, path: { pid } })),
};

/** 合法 pid 归一：数字与数字串都收，其余（空串/null/'abc'/1.5/0/-1/1e20/超界）一律 null。 */
/** 合法 pid 归一：数字与纯数字串都收，其余（空串/null/'abc'/1.5/0/-1/1e20/超界）一律 null。
 * 字符串走 ^\d+$ 而不是 Number()：'0x10'→16、'1e2'→100、' 42 '→42、'0b101'→5 都是
 * Number 的宽容转换，spec 只说整数——十六进制/指数/二进制/带空白不是 pid 的书写形。 */
function validPid(raw: unknown): number | null {
  const n =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string' && /^\d+$/.test(raw)
        ? Number(raw)
        : Number.NaN;
  return Number.isInteger(n) && n >= 1 && n <= PROCESS_MAX_PID ? n : null;
}

/**
 * 上游错误的兜底：保留原状态码与文案（400 的"进程不存在"与 503 的"桥接层不在场"是两回事），
 * 非上游异常才落 502。调用点再过一次 `gateDispatch`：门禁三形要交回门禁屏，不能显示成"操作失败"。
 */
function upstreamFail(e: unknown, label: string): ApiResult {
  if (e instanceof UpstreamError) {
    return { status: e.status, body: { success: false, message: `${label}：${e.status} ${e.message}` } };
  }
  return fail(502, `${label}：${String((e as Error)?.message ?? e)}`);
}

export const processRoutes: RouteTable = {
  'GET /processes': async (_ctx, u) => {
    const rejected = gateGuard(u);
    if (rejected) return rejected;
    try {
      return ok({ data: unwrap(await sdk.listProcesses({ client: u.client })) });
    } catch (e) {
      return gateDispatch(e, upstreamFail(e, '进程列表读取失败'));
    }
  },

  'POST /process-action': async (ctx, u) => {
    const rejected = gateGuard(u);
    if (rejected) return rejected;
    const { action, pid } = ctx.json ?? {};
    // 白名单先判再取属性：`ACTION_FN[action]` 对 'constructor'/'__proto__' 这类键不会发出操作，
    // 但"是不是合法动作"必须在这里就判死，不留到运行期靠 undefined 兜。
    if (typeof action !== 'string' || !(PROCESS_ACTIONS as readonly string[]).includes(action)) {
      return fail(400, `未知动作：${String(action)}（只认 ${PROCESS_ACTIONS.join('/')}）`);
    }
    const id = validPid(pid);
    if (id === null) return fail(400, `pid 必须是 1..${PROCESS_MAX_PID} 的整数，实为 ${String(pid)}`);
    try {
      return ok(await ACTION_FN[action as ProcessAction](u, id));
    } catch (e) {
      return gateDispatch(e, upstreamFail(e, `进程动作 ${action} 失败`));
    }
  },

  // 探测走 GET 但同样带 query：带 ?pid= 的路由必须命中（pathname 比对，设计口径那个缺陷）
  'GET /probe-login': async (ctx, u) => {
    const rejected = gateGuard(u);
    if (rejected) return rejected;
    const id = validPid(ctx.query.get('pid'));
    if (id === null) return fail(400, `pid 必须是 1..${PROCESS_MAX_PID} 的整数`);
    try {
      return ok(unwrap(await sdk.probeProcessLogin({ client: u.client, path: { pid: id } })));
    } catch (e) {
      return gateDispatch(e, upstreamFail(e, '登录探测失败'));
    }
  },
};
