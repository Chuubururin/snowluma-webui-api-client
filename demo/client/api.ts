// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
/**
 * 浏览器 → demo 服务端的最小调用面：只打本服务自己的路由，
 * 绝不直连上游实例（token 只在服务端内存，浏览器拿不到也不该拿）。
 *
 * 非 2xx 抛 `ApiError` 而不是 `Error`：门禁的 409 把 `currentVersion`、403 把 `step` 放在错误体里，
 * 折成纯文本消息就等于告诉调用方"什么状态都没有"，客户端只能靠猜（设计口径禁止的形态）。
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: any,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface GateSignal {
  step: string;
  message: string;
}

/**
 * 门禁信号的唯一出口。服务端对六种面板调用都只会做一件事：把上游那三种真闸形状折成
 * 带 `step` 的响应体（`gates.ts` 的 `gateDispatch`），而"这一步该怎么办"是外壳的决定，不是
 * 每个面板的决定 —— 面板各判各的，就会有第六个面板把它画成"响应没有正文"（浏览器实测）。
 * 由外壳注册一次；传 null 是给测试留的复位口。
 */
let gateListener: ((s: GateSignal) => void) | null = null;

export function onGateSignal(cb: ((s: GateSignal) => void) | null): void {
  gateListener = cb;
}

/**
 * 不走 `call()` 的通道（SSE 用 fetch + reader，绕过这里的报告点）也必须有同一条出口：
 * 流上的 401 折成 `session-expired` 之后，"该去哪一屏"依旧是外壳的决定，面板不许自己画登录屏。
 */
export function emitGateSignal(step: string, message: string): void {
  if (gateListener === null) return;
  gateListener({ step, message });
}

/**
 * 门禁路由与登出**自带** step（那是它们自己的流程语言：`'totp'`、`'app'`、主动登出的 `'login'`），
 * 把它们也当成信号会让门禁屏每读一次状态就把自己摘掉。
 */
function ownsItsStep(path: string): boolean {
  return path.startsWith('/gate/') || path.startsWith('/logout');
}

function reportGate(path: string, body: any): void {
  if (gateListener === null || ownsItsStep(path)) return;
  const step = body && typeof body === 'object' ? (body as any).step : undefined;
  if (typeof step !== 'string' || step === 'app') return;
  gateListener({ step, message: typeof body.message === 'string' ? body.message : '' });
}

export async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  const text = await res.text();
  let parsed: any = undefined;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      /* 非 JSON 响应体：保留原文本供消息用 */
    }
  }
  // 200 与错误体都要报：`gateDispatch` 折出的同意/改密两形是 200 + `step`，门控 401 才是非 2xx
  reportGate(path, parsed);
  if (!res.ok) {
    const message =
      (typeof parsed?.message === 'string' && parsed.message) ||
      text.slice(0, 200) ||
      `HTTP ${res.status}`;
    throw new ApiError(res.status, parsed ?? { raw: text }, message);
  }
  return (parsed === undefined ? null : parsed) as T;
}

/** POST JSON 的便捷形态：所有 demo 路由的写操作都是这一个形状。 */
export function post<T>(path: string, body: unknown): Promise<T> {
  return call<T>(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
