// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
/**
 * 调试页路由：动作目录、透传调用、原始字节上传（两条流式操作归实现批次）。
 *
 * 四条决定形状的事实（逐条读自 spec，与计划 brief 的草稿不同处已按 spec 改）：
 * 1. **invoke 的请求体是 `{uin, action, params}`**（`spec:1978-1994`，required [uin, action]），
 *    `uin` 的 pattern 等价于上游 `server.ts:236` 的 UIN_REGEX，`action` 是 minLength:1。
 *    上游对这四档各有 400（`server.ts:1295/1297/1298/1300`），demo 在发出去之前就把明显不合法的
 *    拒掉 —— 但**只做 spec 写着的校验**，不额外猜 action 名、不猜参数键。
 * 2. **debug 面的失败没有 `success` 键**：失败信封是 `{status:'failed', message}`
 *    （`DebugEnvelopeFailure` `:816-822`），200 的成功支是 `{status, retcode?, data?, message?, wording?}`
 *    （`DebugInvokeResult` `:840-850`，required 只有 [status]）。所以"HTTP 200"从来不等价于
 *    "动作成功"：这里原样透传，把 `status` 交给客户端判色，demo 不产出一个 `ok` 键冒充结论
 *    （与 `ProcessActionResult.success`、`OneBotConfigSaveResult.applied` 同一条教训）。
 * 3. **上传不是 multipart**：`spec:1850-1872` 明写请求体就是文件字节流、文件名在 `?filename=` 上，
 *    生成侧按 multipart 建模会发出服务端从不解析的信封。`filename` 上游是可选（类型允许 undefined），
 *    但**缺省时服务端如何取名未经确证**（实现在缓存外的 `./debug-tools`）⇒ demo 侧把它定为必填：
 *    与其发明一个兜底名，不如让人把名字给全。编码交给生成的客户端（它已做一次 encodeURIComponent），
 *    这里绝不重复编码。
 * 4. **目录里的 `readOnly` 与 `stream` 是安全信息**：非 readOnly 的动作会改业务状态（整个 5099 面
 *    最危险的端点），`stream:true` 的动作在 REST invoke 上不适用。服务端只原样带出这两个键，
 *    判色与二次确认在客户端做。`default` 上游类型是 `unknown` ⇒ 不拿它自动填参数。
 *
 * T3 纪律：`x-replay-class: t3` 且 invoke 标 `x-snowluma-destructive` ⇒ 不自动重放、**不自动重试**
 * （`server.ts:1304` 的 await 可能已在服务端生效，重试就是执行两遍）。
 */
import * as sdk from '../../../generated/typescript/sdk.gen.js';
import { fail, ok, type ApiResult, type RouteTable } from '../http.js';
import { UIN_RE, UpstreamError, unwrap } from '../upstream.js';
import { gateDispatch, gateGuard } from './gates.js';

/** invoke 唯一允许的三键（多一个键就是发明，spec 的 requestBody 只有这三项）。 */
export const DEBUG_INVOKE_KEYS = ['uin', 'action', 'params'] as const;
/** data URL 只收 base64 那一支：文本支要靠 utf8 往返，二进制会在解码前就被字符化。 */
const DATA_URL_BASE64 = /^data:[^,;]*;base64,([\s\S]*)$/;

/**
 * 上游 4xx 的折叠：保住状态码 + 原文 + debug 面那两个自有键（`status`、以及 action 自己带的
 * `retcode`）。折成 502 等于把"你的实例拒绝了这个操作"说成"demo 自己坏了"。
 */
function upstreamReject(e: unknown, label: string): ApiResult {
  if (e instanceof UpstreamError) {
    const b = (e.body ?? {}) as Record<string, unknown>;
    const out: Record<string, unknown> = {
      success: false,
      message: typeof b.message === 'string' ? b.message : `${label}：上游返回 ${e.status}`,
    };
    for (const k of ['status', 'retcode', 'wording']) if (b[k] !== undefined) out[k] = b[k];
    return { status: e.status, body: out };
  }
  return fail(502, `${label}：${String((e as Error)?.message ?? e)}`);
}

/** 只有"字符串数组 + 对象数组且两键齐"才算目录到货；其余是传输成功但形状不对 ⇒ 502 说清哪一步。 */
function isCatalog(v: any): boolean {
  return Array.isArray(v?.actions) && Array.isArray(v?.categories);
}

export type InvokeCheck =
  | { ok: true; body: { uin: string; action: string; params?: Record<string, unknown> } }
  | { ok: false; message: string };

/**
 * invoke 与 invoke-stream 共用的本地核（的流式那一支走的是同一个上游体形状）。
 * 抽成一处而不是两处各写一遍，是因为这两条路的"注定 400"判据必须同进同退：
 * REST 那条拒掉的 uin，流式那条不许放出去。
 */
export function checkInvoke(json: any): InvokeCheck {
  const { uin, action, params } = json ?? {};
  if (typeof uin !== 'string' || !UIN_RE.test(uin)) {
    return { ok: false, message: '需要 uin：必须匹配 spec 的 uin pattern（上游 UIN_REGEX 同规则），非在线账号也会被判无效' };
  }
  if (typeof action !== 'string' || action === '') {
    return { ok: false, message: '需要 action（非空字符串）' };
  }
  const body: { uin: string; action: string; params?: Record<string, unknown> } = { uin, action };
  if (params !== undefined) {
    if (params === null || typeof params !== 'object' || Array.isArray(params)) {
      return { ok: false, message: 'params 给了就必须是自由对象' };
    }
    body.params = params;
  }
  return { ok: true, body };
}

export const debugRoutes: RouteTable = {
  'GET /debug-actions': async (_ctx, u) => {
    const rejected = gateGuard(u);
    if (rejected) return rejected;
    try {
      const data = unwrap<any>(await sdk.listDebugActions({ client: u.client }));
      if (!isCatalog(data)) {
        return fail(502, '动作目录读不到预期形状（上游 200 应有 actions 与 categories 两键）');
      }
      return ok({ data });
    } catch (e) {
      return gateDispatch(e, upstreamReject(e, '动作目录读取失败'));
    }
  },

  'POST /debug-invoke': async (ctx, u) => {
    const rejected = gateGuard(u);
    if (rejected) return rejected;
    const checked = checkInvoke(ctx.json);
    if (!checked.ok) return fail(400, checked.message);
    const body = checked.body;
    try {
      // 200 里可能是 `{status:'failed'}`：unwrap 只管 HTTP 层，动作层的成败交回原键由客户端判
      return ok({ data: unwrap<unknown>(await sdk.invokeDebugAction({ client: u.client, body })) });
    } catch (e) {
      return gateDispatch(e, upstreamReject(e, '动作调用失败'));
    }
  },

  'POST /debug-upload': async (ctx, u) => {
    const rejected = gateGuard(u);
    if (rejected) return rejected;
    const { filename, dataUrl } = ctx.json ?? {};
    if (typeof filename !== 'string' || filename === '') {
      return fail(400, '需要 filename：上游缺省时如何取名未经确证（实现在缓存外的 ./debug-tools），demo 不发明兜底名');
    }
    const m = typeof dataUrl === 'string' ? DATA_URL_BASE64.exec(dataUrl) : null;
    if (!m) return fail(400, '需要 base64 形态的 dataUrl（文件字节流由浏览器读进来，不走文本支）');
    const bytes = Buffer.from(m[1], 'base64');
    if (bytes.length === 0) return fail(400, '文件是空的：上游会把它落盘成零字节文件，这里先拒');
    try {
      // 字节直进请求体：`new Uint8Array(bytes)` 拷出独立 ArrayBuffer 交给 Blob，全程不做 utf8 往返
      const data = unwrap<any>(
        await sdk.uploadDebugFile({ client: u.client, body: new Blob([new Uint8Array(bytes)]), query: { filename } }),
      );
      return ok({ data });
    } catch (e) {
      return gateDispatch(e, upstreamReject(e, '调试文件上传失败'));
    }
  },
};
