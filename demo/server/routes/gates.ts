// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
/**
 * 门禁屏路由（设计口径）。六条规矩：
 *  1. `login` 一次调用两次往返：`{success:false, needsTotp:true}`（200，**无 token**）→ `step:'totp'`；
 *     `{success:true, token, mustChangePassword}` → 先 `u.authenticate(token)`，再读两道闸决定 step。
 *  2. 403 的**两个键分别分派**：`consentRequired` → `'consent'`，`mustChangePassword` → `'password'`。
 *     只认一个键就是规格明确禁止的形态。401 还分两种：门控 401 `{status:'failed'}`（会话死了 ⇒ 回登录）
 *     与业务 401 `{success:false,message}`（原密码/验证码错 ⇒ 留在发起它那一步）。混起来两头都错：
 *     把"会话过期"说成"密码错误"是一种；把"验证码过期"打回第一步表单（第二因子屏连同"等认证器生成新码"
 *     的提示一起消失）是另一种，设计口径二因子那段专门禁后者。
 *  3. 门禁屏只用设计口径放行白名单那四条（实码 CONSENT_ALLOWLIST `server.ts:223-229` 里 demo 用得到的）：
 *     `getStatus` / `getAuthState` / `getAgreements` 由 `readGates` 一次并行读，
 *     第 4 条 `getPublicUiAppearance` 走 `GET /appearance`（实码 `:631` 对它连 bearer 检都免，
 *     所以登录前就能读，故它不进 readGates —— 同一次进屏读两遍没有意义）。其余操作在门禁未过时由
 *     `gateGuard` 在**服务端**拒（第二道），客户端也拒（第一道），两道都不出网。
 *  4. `recordConsent` 的 `version` 必须是本会话 `getAgreements` 给的那一份（内容哈希，不是日期）；
 *     空串不上行、版本不符原样回 `currentVersion` 让客户端重取，不自拼。
 *  5. `changePassword` 的 `oldPassword` 由服务端从登录时留存的口令注入 —— 浏览器永不回传凭据。
 *  6. 强度端点按 spec 的键名 `password` 发，返回 `{rules, valid}` 清单渲染，**没有 score/进度条**（设计口径）。
 *     缺键就 502 报出去：把它折成 `{rules:[],valid:false}` 等于把传输层故障说成"你的密码太弱"，
 *     与规矩 6 开头那句"不猜"是同一件事（一方客户端 `client.ts:552-560` 也是这么做的）。
 *
 * brief 草稿把 403 两键挂在 `/api/login` 上；上游实码不是这样（`:631` 短路免检，登录**成功支**恒 200 三键，
 * 另有 400/401/429/500 四条业务支），那两键来自登录**之后**的闸门。本文件按实码实现，
 * `tools/demo-gates.test.ts` 的假上游同按实码形状写。
 */
import {
  changePassword,
  checkPasswordStrength,
  getAgreements,
  getAuthState,
  getPublicUiAppearance,
  getStatus,
  login,
  logout,
  recordConsent,
} from '../../../generated/typescript/sdk.gen.js';
import { unwrap, UpstreamError, type Upstream } from '../upstream.js';
import { fail, ok, type ApiResult, type RouteTable } from '../http.js';

export interface GateState {
  consentRequired: boolean;
  mustChangePassword: boolean;
}

type GateStep = 'login' | 'totp' | 'consent' | 'password' | 'relogin' | 'app' | 'unknown';

/** 门禁状态按会话缓存在服务端。WeakMap：会话被丢弃后不必手动清。 */
const gateStates = new WeakMap<Upstream, GateState>();
/**
 * 操作者对"门禁状态读不出来"的显式知悉。设计口径与 declination
 * `must-change-password-silent-false` 都承诺"允许继续"这条出路 —— 只赦 'unknown'，真挂着的闸赦不掉。
 */
const acknowledged = new WeakSet<Upstream>();

/** 换目标实例 = 旧会话与旧门禁状态同时作废（`upstream.setBaseUrl` 只清 token，闸状态存在本模块）。 */
export function clearGateState(u: Upstream): void {
  gateStates.delete(u);
  acknowledged.delete(u);
}

/**
 * 客户端有一份同形的三行优先级判断（`demo/client/pages/gate.ts` 的 `gateStep`）——
 * 不是重复实现：浏览器包不能 import 服务端模块，两者之间的契约是这里的响应体。
 */
function stepOf(g: GateState | undefined | null, ack = false): GateStep {
  if (!g) return ack ? 'app' : 'unknown';
  if (g.consentRequired) return 'consent';
  if (g.mustChangePassword) return 'password';
  return 'app';
}

/** 门控 401（实码 `server.ts:634/638` 写 `{status:'failed'}`，没有 success 键）⇒ 会话死了，不是凭据错了。 */
function isGate401(e: UpstreamError): boolean {
  const b = (e.body ?? null) as Record<string, unknown> | null;
  return e.status === 401 && b?.success === undefined && b?.status === 'failed';
}

/**
 * 上游那三种"这是门禁信号，不是业务失败"的形状 ⇒ 折成门禁响应；不是这三形就返回 null。
 * 抽出来是给 `gateReject`（门禁路由自己用）与 `gateDispatch`（业务路由用）共用的，
 * 两处各写一遍的话，其中一处迟早漏掉门控 401 那一形。
 */
function gateOverride(e: UpstreamError): ApiResult | null {
  const b = (e.body ?? {}) as Record<string, unknown>;
  if (b.consentRequired === true) {
    return ok({ step: 'consent', consentRequired: true, message: String(b.message ?? e.message) });
  }
  if (b.mustChangePassword === true) {
    return ok({ step: 'password', mustChangePassword: true, message: String(b.message ?? e.message) });
  }
  if (isGate401(e)) {
    // 会话死了 ⇒ 回登录屏。停在 'unknown' 是一间没有门的房间：登录表单只在 login/totp 两屏出现。
    return fail(401, String(b.message ?? 'Token expired or invalid'), { step: 'login' });
  }
  return null;
}

/** 把上游错误折成门禁响应。`stepOnFailure` 是发起这条调用的路由自己的步。 */
function gateReject(e: UpstreamError, stepOnFailure: GateStep): ApiResult {
  const override = gateOverride(e);
  if (override) return override;
  const b = (e.body ?? {}) as Record<string, unknown>;
  const extra: Record<string, unknown> = {};
  if (Array.isArray(b.rules)) extra.rules = b.rules;
  if (typeof b.currentVersion === 'string') extra.currentVersion = b.currentVersion;
  // 其余错误**原样保留状态码**：409 的 currentVersion、400 的 rules 只有带着状态码上去，
  // 浏览器那边的 ApiError 才读得到（demo/client/api.ts），折成 200 就把"该重取版本"洗成了"已同意"。
  // 文本读 e.message 而不是 body.message：传输层失败的成因只在 UpstreamError 那一层才拼得出来
  // （见 upstream.ts 的 upstreamErrorText），直接抄 body.message 就只剩一句 "fetch failed"。
  return { status: e.status, body: { step: stepOnFailure, message: e.message, ...extra } };
}

interface GateRead {
  gates: GateState | null;
  status: unknown;
  agreements: { version: string; documents: unknown[] } | null;
}

/**
 * 读两道闸（只用白名单内的三条操作）。缺键 ⇒ 不猜：gates 为 null，由调用方落到 'unknown'。
 * 上游 `mustChangePassword()` 出错时静默返回 false（把该报警的闸当放行），demo 有意不学它。
 * 这里**不吞异常**：门控 401 与其它上游错误都要往上抛，由 `stateResult` / 各路由按两键分派。
 * 开头先作废缓存：读失败时不能让"上一次成功的判断"继续替本轮放行（否则第二道闸静默开着）。
 */
async function readGates(u: Upstream): Promise<GateRead> {
  gateStates.delete(u);
  const [agreements, auth, status] = await Promise.all([
    unwrap<any>(await getAgreements({ client: u.client })),
    unwrap<any>(await getAuthState({ client: u.client })),
    unwrap<any>(await getStatus({ client: u.client })),
  ]);
  if (typeof agreements?.consentRequired !== 'boolean' || typeof auth?.mustChangePassword !== 'boolean') {
    return { gates: null, status, agreements: null };
  }
  const gates: GateState = {
    consentRequired: agreements.consentRequired,
    mustChangePassword: auth.mustChangePassword,
  };
  gateStates.set(u, gates);
  return {
    gates,
    status,
    agreements: { version: agreements.version, documents: agreements.documents ?? [] },
  };
}

/** 门禁未过时只端出决定这一步的那一个键（两键不混），并把条款交给客户端去渲染。 */
function gateResult(read: GateRead, ack: boolean): Record<string, unknown> {
  const step = stepOf(read.gates, ack);
  const key =
    step === 'consent' ? { consentRequired: true } : step === 'password' ? { mustChangePassword: true } : {};
  return {
    step,
    ...key,
    status: read.status,
    ...(step === 'consent' ? { version: read.agreements?.version, documents: read.agreements?.documents } : {}),
  };
}

/** `/gate/state`、登录成功、同意成功共用的收尾：读闸折 step，门控 401 折回登录屏。 */
async function stateResult(u: Upstream): Promise<ApiResult> {
  try {
    return ok(gateResult(await readGates(u), acknowledged.has(u)));
  } catch (e) {
    if (e instanceof UpstreamError) return gateReject(e, 'login');
    throw e;
  }
}

/**
 * 第二道闸：的每条业务路由开头 `const rejected = gateGuard(u); if (rejected) return rejected;`
 * 门禁未过时**连请求都不发向上游**（省一次注定 403 的往返，也让"写了不生效"不会被误当成"生效了"）。
 */
export function gateGuard(u: Upstream): ApiResult | null {
  // 与 `index.ts` 那道总闸同一件事、同一句说法：demo 自己手里没有会话，不是"上游判你 token 死了"。
  // 走 HTTP 时总闸先拦，这条只在直接组 handler（L2 与后续装配）时够得着 —— 留着是第二道，不是装饰：
  // 它保证"业务路由绕过总闸"这种形状一旦发生，交回的还是登录屏而不是放行。
  if (!u.token) return fail(401, '还没有可用会话，请重新登录', { step: 'login' });
  const step = stepOf(gateStates.get(u), acknowledged.has(u));
  if (step === 'app') return null;
  if (step === 'unknown') return fail(403, '门禁状态无法确认', { step: 'unknown' });
  return fail(403, '门禁未过', { step });
}

/**
 * 业务路由的错误收尾：demo 侧那道闸只是省一次往返，**真门禁在上游**。
 * 会话若走过 `POST /gate/acknowledge`（"读不出来时操作者显式继续"），`gateGuard` 会放行，
 * 而上游此时仍可能回 403 两键或门控 401 ⇒ 这三形必须交回门禁对应那一屏，
 * 不许被折成"加载失败"留在业务面板上（那等于把门禁未过伪装成数据不存在）。
 * 其余错误原样返回调用方给的兜底。
 */
export function gateDispatch(e: unknown, otherwise: ApiResult): ApiResult {
  if (e instanceof UpstreamError) {
    const override = gateOverride(e);
    if (override) return override;
  }
  return otherwise;
}

export const gateRoutes: RouteTable = {
  'POST /gate/login': async (ctx, u) => {
    const { password, totp } = ctx.json ?? {};
    if (typeof password !== 'string' || !password) return fail(400, '需要 password');
    // spec 的 login requestBody（生成类型 LoginData）只有 password 与可选 totp；
    // `recoveryCode` 上游客户端会发（client.ts:499）但 spec 刻意不列 ⇒ 不补字段、不发键，
    // 已登记 declination `recovery-code-login`。
    const body: { password: string; totp?: string } = { password };
    if (typeof totp === 'string' && totp) body.totp = totp;
    try {
      const res = unwrap<any>(await login({ client: u.client, body }));
      if (res?.success === false && res?.needsTotp === true) {
        return ok({ step: 'totp', message: '请输入认证器上的 6 位验证码' });
      }
      if (res?.success !== true || typeof res?.token !== 'string') {
        return ok({ step: 'unknown', message: '登录响应形状不符预期（缺 token）' });
      }
      // 口令只在登录成立后留存（且只留服务端内存）：把一个失败尝试里的错口令留着，
      // 改密步注入的 oldPassword 就成了猜测；浏览器再也拿不回去。
      u.password = password;
      acknowledged.delete(u);
      u.authenticate(res.token);
      return await stateResult(u);
    } catch (e) {
      // 带了 totp 却被拒 ⇒ 留在第二因子屏（"等认证器生成新码"的提示只在那一屏上）
      if (e instanceof UpstreamError) return gateReject(e, body.totp ? 'totp' : 'login');
      throw e;
    }
  },

  'GET /gate/state': async (_ctx, u) => stateResult(u),

  'POST /gate/consent': async (ctx, u) => {
    const { version } = ctx.json ?? {};
    if (typeof version !== 'string' || !version) return fail(400, '需要 version（必须是 getAgreements 给的那一份）');
    try {
      const res = unwrap<any>(await recordConsent({ client: u.client, body: { version } }));
      clearGateState(u); // 同意状态变了，缓存与知悉标记一并作废，重读
      const state = await stateResult(u);
      const body = state.body as Record<string, unknown>;
      return {
        status: state.status,
        body: state.status === 200 ? { version: res?.version, ...body } : body,
      };
    } catch (e) {
      if (e instanceof UpstreamError) return gateReject(e, 'consent');
      throw e;
    }
  },

  'POST /gate/password': async (ctx, u) => {
    const { newPassword } = ctx.json ?? {};
    if (typeof newPassword !== 'string' || !newPassword) return fail(400, '需要 newPassword');
    if (!u.password) return fail(400, '服务端没有留存口令，请重新登录', { step: 'login' });
    try {
      // 两键恒在（spec 的 ChangePasswordData 都 required）；oldPassword 来自服务端留存口令
      const res = unwrap<any>(
        await changePassword({ client: u.client, body: { oldPassword: u.password, newPassword } }),
      );
      if (res?.requireRelogin === true) {
        u.signOut();
        clearGateState(u);
        return ok({ step: 'relogin', requireRelogin: true });
      }
      return ok({ step: 'unknown', message: '改密成功但上游未要求重登（形状不符预期）' });
    } catch (e) {
      if (e instanceof UpstreamError) return gateReject(e, 'password');
      throw e;
    }
  },

  'POST /gate/strength': async (ctx, u) => {
    const { password } = ctx.json ?? {};
    if (typeof password !== 'string') return fail(400, '需要 password');
    try {
      const res = unwrap<any>(await checkPasswordStrength({ client: u.client, body: { password } }));
      if (!Array.isArray(res?.rules) || typeof res?.valid !== 'boolean') {
        return fail(502, '强度响应缺 rules/valid 键（不猜）');
      }
      return ok({ rules: res.rules, valid: res.valid });
    } catch (e) {
      if (e instanceof UpstreamError) return gateReject(e, 'password');
      throw e;
    }
  },

  // 设计口径的"允许继续"：读不到门禁状态时由操作者显式认一次。门禁**可读**时这条必须拒，
  // 否则它就成了真闸门之外的万能绕过口。
  'POST /gate/acknowledge': async (_ctx, u) => {
    const g = gateStates.get(u);
    if (g) return fail(409, '门禁状态可读，不许显式绕过', { step: stepOf(g) });
    acknowledged.add(u);
    return ok(gateResult({ gates: null, status: null, agreements: null }, true));
  },

  'POST /logout': async (_ctx, u) => {
    try {
      unwrap(await logout({ client: u.client }));
    } catch (e) {
      if (!(e instanceof UpstreamError)) throw e;
      // 上游登出失败也要把本地会话拆掉：留着坏 token 只会让后面每一条请求都撞 401
    }
    u.signOut();
    u.password = null;
    clearGateState(u);
    return ok({ step: 'login' });
  },

  // 从的种子表搬来（"搬一块删一块，不留两份实现"）。
  // write-only 渲染例外：门禁屏只把外观读出来给人看（确认连的是哪台），不套主题变量
  // （declination `public-appearance-render`）。
  'GET /appearance': async (_ctx, u) => {
    try {
      return ok({ ok: true, data: unwrap(await getPublicUiAppearance({ client: u.client })) });
    } catch (e) {
      // 门禁信号照走 gateDispatch：这里曾是全仓唯一不过它的上游错误出口。
      // 可达的那一形是"上游对 /api/ui/public 回了门控 401/403"（夹具用 break:'ui-public-401'
      // 就造得出），此时该回的是 step 而不是"外观读取失败"。至于"会话死了"那一形：
      // 本路由是登录前公开读，那一形在设计流程里不可达，别拿它当改动理由（报告设计口径）。
      const err = e as { status?: number; message?: string };
      return gateDispatch(e, fail(err.status ?? 502, err.message ?? '外观读取失败'));
    }
  },
};
