// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
/**
 * 生成客户端的唯一装配处（设计口径）。55 条操作全部经 generated/typescript/sdk.gen.ts，
 * 本模块只管三件事：目标地址、会话 token、可替换的 fetch（离线测试的注入缝）。
 * 不引 adapters/ 作运行时依赖——它的 generic request() 会绕过生成物，而"生成物够用"正是本 demo 的命题。
 */
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { createClient, createConfig } from '../../generated/typescript/client/index.js';

const DEFAULT_BASE_URL = 'http://127.0.0.1:5099';
const STRICT_SSRF = process.env.SNOWLUMA_STRICT_SSRF === '1';

type HostClass = 'loopback' | 'private' | 'link-local' | 'public';

/** IPv4-mapped IPv6 的 hex 尾两组（`7f00:1`）→ dotted-quad（`127.0.0.1`）。 */
function hexToIPv4(hi: string, lo: string): string {
  const n1 = Number.parseInt(hi, 16);
  const n2 = Number.parseInt(lo, 16);
  return `${n1 >> 8}.${n1 & 0xff}.${n2 >> 8}.${n2 & 0xff}`;
}

/** 尾段内嵌 IPv4 的 IPv6 字面量 → dotted-quad；不带内嵌地址时返回 null。 */
function embeddedIPv4(host: string): string | null {
  // URL 归一化后（validateBaseUrl 的唯一来源）三种内嵌形都落成「前缀 + 尾两组十六进制」：
  //  - ::ffff:7f00:1 —— IPv4-mapped（第三遍白盒实证的 STRICT_SSRF 绕过）
  //  - ::7f00:1 —— IPv4-compatible，RFC 4291 设计口径.5.1 已废弃，但 OS 若仍路由它就绕开 127. 判据
  //  - 64:ff9b::7f00:1 —— NAT64 well-known 前缀（设计口径/第五轮登记的残余），NAT64 网络里它真的回到环回
  const hex = host.match(/^(?:::(?:ffff:)?|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (!hex) return null;
  return hexToIPv4(hex[1], hex[2]);
}

function classifyHost(hostname: string): HostClass {
  // URL.hostname 对 IPv6 字面量是**带方括号**的（`http://[::1]:5099` → "[::1]"）。
  // 不剥括号时 `::1` 与 IPv6 链路局部/唯一本地全都落到 public，
  // SNOWLUMA_STRICT_SSRF 对"把目标指到本机"这条路形同虚设。
  let host = hostname.replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
  const embedded = embeddedIPv4(host);
  if (embedded) host = embedded;
  if (host === 'localhost' || host.endsWith('.localhost')) return 'loopback';
  if (/^127\./.test(host) || host === '::1') return 'loopback';
  // fc00::/7（含 fd..）= 唯一本地，对应 v4 私网；fe80::/10 = 链路局部，对应 169.254。
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return 'private';
  if (/^fe[89abcdef][0-9a-f]:/.test(host)) return 'link-local';
  if (/^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) return 'private';
  if (/^169\.254\./.test(host)) return 'link-local';
  return 'public';
}

/** 契约：限 http/https、禁 userinfo、去尾斜杠。默认放行环回/私网——唯一目标就是操作者自配的实例。 */
export function validateBaseUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`地址不可解析：${raw}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`协议必须是 http/https，实为 ${parsed.protocol}`);
  }
  if (parsed.username || parsed.password) throw new Error('不应携带 userinfo');
  const cls = classifyHost(parsed.hostname);
  if (STRICT_SSRF && cls !== 'public') throw new Error(`严格模式下拒绝 ${cls} 目标：${parsed.hostname}`);
  return raw.replace(/\/+$/, '');
}

export interface Upstream {
  readonly client: ReturnType<typeof createClient>;
  baseUrl: string;
  token: string | null;
  /** 操作者口令（仅服务端内存）：改密步注入 oldPassword 要用它，浏览器永不回传凭据。 */
  password: string | null;
  setBaseUrl(next: string): void;
  authenticate(token: string): void;
  signOut(): void;
}

export function createUpstream(baseUrl: string = DEFAULT_BASE_URL, fetchImpl?: typeof fetch): Upstream {
  const url = validateBaseUrl(baseUrl);
  // 注入缝对真 `typeof fetch` 透明直通：fetchImpl 原样交给 createConfig，不拆参、不重组。
  // 生成的 client 用**单个 Request 对象**调 `_fetch(request)`（见 client.gen.ts:101），它把
  // options.signal / redirect / credentials 等都烘进那个 Request。装配处若把它拆回 (url, init)
  // 再重建，就会丢掉 signal —— 而要用 options.signal 中断 SSE，注入缝必须保住它。
  // Request → 可检查参数的读取只发生在离线测试的假 fetch 里，不进生产模块。
  const client = createClient(createConfig({ baseUrl: url, ...(fetchImpl ? { fetch: fetchImpl } : {}) }));
  const state: Upstream = {
    client,
    baseUrl: url,
    token: null,
    password: null,
    setBaseUrl(next) {
      const v = validateBaseUrl(next);
      state.baseUrl = v;
      state.token = null;
      state.password = null;
      client.setConfig({ baseUrl: v, auth: undefined });
    },
    authenticate(token) {
      state.token = token;
      client.setConfig({ auth: token });
    },
    signOut() {
      state.token = null;
      client.setConfig({ auth: undefined });
    },
  };
  return state;
}

/**
 * 非 2xx 的载体：状态码 + 原样错误体。
 * 403 的门禁两键（consentRequired / mustChangePassword）只能从这里读——
 * 折成 Error(message) 就把分派依据丢了，那是设计口径明确禁止的"只认一个键"。
 */
export class UpstreamError extends Error {
  constructor(
    readonly status: number,
    readonly body: any,
  ) {
    super(upstreamErrorText(body, status));
    this.name = 'UpstreamError';
  }
}

/**
 * 载体文本。传输层失败（连不上、TLS 握不上、fetch 的 bad-port 表）没有 HTTP 状态可读，
 * 真正的原因只挂在 `cause` 上 —— 只折 `body.message` 的话，操作者与测试看到的永远是一句
 * 光秃秃的 "fetch failed"。这条链偶发红过三次、每次都不知道红在哪，断点就在这里。
 *
 * 放在构造函数这一处而不是各路由：`unwrap()` 是全仓唯一的折叠点，所有下游
 * （`gateReject` 的正文、其它路由的 `err.message`、index.ts 的 500）都读 `e.message`。
 */
function upstreamErrorText(body: any, status: number): string {
  const base = typeof body?.message === 'string' ? body.message : `上游返回 ${String(status)}`;
  const cause = body?.cause as { message?: string } | undefined;
  return cause?.message ? `${base} ← ${cause.message}` : base;
}

/**
 * 生成客户端默认 responseStyle=fields ⇒ 每条操作 resolve 成 {data, error, request, response}，
 * 且非 2xx **不抛**（实测，见全局约束）。本函数是全仓唯一的折叠点。
 * 4 条流的 {stream} 不走这里（它们是 ServerSentEventsResult，没有 data/error 之分）。
 */
export function unwrap<T = any>(res: { data?: T; error?: unknown; response?: { status: number } }): T {
  const status = res.response?.status ?? 0;
  if (status >= 400) throw new UpstreamError(status, res.error ?? res.data);
  if (res.error !== undefined && res.error !== null && res.data === undefined) {
    throw new UpstreamError(status || 500, res.error);
  }
  return (res.data ?? null) as T;
}

/** spec 单源的 55 个 operationId：门禁、report、parity 校验共用同一份名单，避免手抄。 */
export const OPERATIONS: readonly string[] = (() => {
  const spec = parse(readFileSync('spec/openapi.yaml', 'utf8')) as {
    paths: Record<string, Record<string, { operationId?: string }>>;
  };
  return Object.values(spec.paths).flatMap((item) =>
    Object.values(item).map((op) => op.operationId).filter((x): x is string => Boolean(x)),
  );
})();

/**
 * uin 的格式闸从 spec 的 path 参数派生，不在路由文件里手抄正则。
 *
 * 原来 `routes/config.ts` 与 `routes/debug.ts` 各写了一份同一条 uin 正则字面量，注释都说
 * "等价于上游 server.ts:236 的 UIN_REGEX"。上游真把区间改掉时，validate/drift 的派生守卫
 * 会逼 spec 跟着改 —— 但那两份字面量谁也不欠，于是 demo 会继续用旧区间放行/拒绝，
 * 而测试全绿。这是 C10 那一类（手抄清单与真源分叉），不是风格问题。
 */
export const UIN_RE: RegExp = (() => {
  const doc = parse(readFileSync('spec/openapi.yaml', 'utf8')) as {
    paths?: Record<string, Record<string, { parameters?: Array<{ name?: string; schema?: { pattern?: string } }> }>>;
  };
  const item = doc.paths?.['/api/config/{uin}'];
  const op = item?.get ?? item?.post;
  const pattern = op?.parameters?.find((p) => p.name === 'uin')?.schema?.pattern;
  if (typeof pattern !== 'string' || !pattern) {
    throw new Error(
      'UIN_RE：spec 的 /api/config/{uin} 上找不到 uin 的 pattern —— 宁可起不来，也不回退成硬编码区间',
    );
  }
  return new RegExp(pattern);
})();
