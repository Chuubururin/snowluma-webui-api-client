// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
/**
 * L2 测试夹具：假上游（走的 fetch 注入缝）+ 直调 buildHandler，不起真端口。
 * 不起真端口的理由：才有活实例；L2 要验的是"路由→操作"映射与错误归一，
 * 绑真端口只会让测试依赖 6097 空闲并在 CI 上互撞。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { buildHandler } from '../../demo/server/index.js';
import { createUpstream, type Upstream } from '../../demo/server/upstream.js';
import type { RouteTable } from '../../demo/server/http.js';

/**
 * 假上游的处理器：拿到剥掉 origin 的路径与请求要素，返回状态与 JSON 体。
 * 第三个参数是生成客户端构造的**那个 Request 实例本身**（透传，不拆不重组）：
 * 需要验 signal 等只有 Request 上才有的字段时用它的理由——裁定：
 * 任何把 Request 拆成 (url, init) 再重建的适配层都会丢 signal，这里只"读"不"换"。
 * `text` 是唯一的非 JSON 出口（spec 里 `exportTraceLog` 的 200 就是 `text/plain`）：
 * 给了它就原样发出、不再 JSON.stringify —— 否则客户端 `parseAs:'text'` 读到的会是带引号的 JSON 字面量，
 * 那既不是上游的形状，也测不出"按行解析元信息"这类真逻辑。
 */
export type FakeReply = { status: number; body?: unknown; text?: string };
export type FakeUpstream = (path: string, init?: RequestInit, request?: Request) => FakeReply | Promise<FakeReply>;

/** 默认 seed 一个会话：多数 L2 测的是映射与归一，先过认证闸才有意义。测闸本身时传 null。 */
export function upstreamWith(handler: FakeUpstream, seedToken: string | null = 'TK-fixture'): Upstream {
  const u = createUpstream(
    'http://127.0.0.1:5099',
    (async (input: Request) => {
      const body = await input.text();
      const init: RequestInit = { method: input.method, headers: input.headers, body: body || undefined };
      const r = await handler(input.url.replace(/^http:\/\/[^/]+/, ''), init, input);
      // text 与 body 互斥：给了 text 就按 text/plain 原样发（exportTraceLog 那条唯一的非 JSON 200）
      const payload = r.text !== undefined ? r.text : JSON.stringify(r.body);
      const type = r.text !== undefined ? 'text/plain; charset=utf-8' : 'application/json';
      return new Response(payload, { status: r.status, headers: { 'content-type': type } });
    }) as unknown as typeof fetch,
  );
  if (seedToken) u.authenticate(seedToken);
  return u;
}

/** 需要跨请求状态（如门禁状态机）或"根本不该有会话"时用这个。 */
export function statefulUpstream(handler: FakeUpstream): Upstream {
  return upstreamWith(handler, null);
}

/** 裸捕获端：只有直接检查 writeHead 状态码（如 204 无响应体）时才需要，其余一律用 hit。 */
export function fakeRes(): {
  res: ServerResponse;
  get status(): number | undefined;
  get body(): string | undefined;
  get headers(): Record<string, string | string[] | undefined>;
  get ended(): boolean;
  /** 响应头是否已经**上线**。真 Node 里 `writeHead` 只置 `headersSent`，字节要等第一次 `write`
   *  或 `flushHeaders()` 才发给客户端 —— 与下面的 `headersSent` 是两件事，SSE 的"连上但暂无帧"
   *  只有这一项能观察到。 */
  get headFlushed(): boolean;
  fire(event: string): void;
} {
  const cap: { status?: number; body?: string; headers: Record<string, string | string[] | undefined> } = {
    headers: {},
  };
  let sent = false;
  let flushed = false;
  let ended = false;
  const resListeners: Record<string, Array<() => void>> = {};
  const res = {
    writeHead(status: number, headers?: Record<string, string | string[] | undefined>) {
      cap.status = status;
      Object.assign(cap.headers, headers ?? {});
      // 真 ServerResponse 在 writeHead 之后 headersSent 就是 true；写死 false 会让
      // "接管收发端之后抛错不双写"这条分支永远测不到（parked minor ①）。
      sent = true;
      return res;
    },
    flushHeaders() {
      flushed = true;
      return res;
    },
    end(chunk?: string) {
      cap.body = (cap.body ?? '') + (chunk ?? '');
      sent = true;
      flushed = true;
      ended = true;
      return res;
    },
    setHeader() {
      return res;
    },
    on(event: string, cb?: () => void) {
      // 真 ServerResponse 有 on('close')：SSE 的断连只能认它（req 在读完体时就已经 close 过）。
      // 这里的 `on` 从空壳改成记账，否则"客人走了要释放订阅"这条路在假件上永远没人喊。
      if (cb) (resListeners[event] ??= []).push(cb);
      return res;
    },
    write(chunk?: string | Uint8Array) {
      cap.body = (cap.body ?? '') + (typeof chunk === 'string' ? chunk : Buffer.from(chunk ?? []).toString('utf8'));
      flushed = true;
      return true;
    },
    get headersSent() {
      return sent;
    },
  } as unknown as ServerResponse;
  return {
    res,
    get status() {
      return cap.status;
    },
    get body() {
      return cap.body;
    },
    get headers() {
      return cap.headers;
    },
    get ended() {
      return ended;
    },
    get headFlushed() {
      return flushed;
    },
    /** 喊响应侧的事件（目前只有 'close' 有用）：SSE 的"浏览器走了"就靠它显形。 */
    fire(event: string) {
      for (const cb of resListeners[event] ?? []) cb();
    },
  };
}

/** hit() 的可选出口：不发就只能发 JSON、不能改 header 的夹具测不了上传端点。 */
export interface HitOptions {
  /** 追加/覆盖请求头；键会统一转小写（Node 的 headers 就是小写，`Content-Type` 也得能用）。 */
  headers?: Record<string, string>;
  /** 原样字节请求体：给了它就**绝不**再 JSON.stringify —— multipart 上传靠它，二进制段不容 utf8 往返。 */
  rawBody?: string | Buffer;
}

/**
 * 造 multipart 请求体：文件段按**原始字节**写入，不做任何字符编码往返，
 * 与 demo/server/http.ts 的解析侧字节对字节对齐（上传端点的 L2 测试共用，别再各抄一份边界拼接）。
 */
export function encodeMultipart(
  parts: Array<
    | { name: string; value: string }
    | { name: string; filename: string; bytes: Uint8Array; contentType?: string }
  >,
  boundary = '----SnowLumaFixtureBoundary',
): { contentType: string; body: Buffer } {
  const chunks: Buffer[] = [];
  const push = (s: string) => chunks.push(Buffer.from(s, 'utf8'));
  for (const p of parts) {
    push(`--${boundary}\r\ncontent-disposition: form-data; name="${p.name}"`);
    if ('value' in p) {
      push(`\r\n\r\n${p.value}\r\n`);
      continue;
    }
    push(`; filename="${p.filename}"`);
    if (p.contentType) push(`\r\ncontent-type: ${p.contentType}`);
    push('\r\n\r\n');
    chunks.push(Buffer.from(p.bytes));
    push('\r\n');
  }
  push(`--${boundary}--\r\n`);
  return { contentType: `multipart/form-data; boundary=${boundary}`, body: Buffer.concat(chunks) };
}

/**
 * 默认行为完全不变（JSON content-type + JSON.stringify(body)）；
 * 需要 multipart / 自定义 header / 原样字节时传 opts，别绕过夹具自己造 req——那正是要防的漂移。
 */
export function sendRequest(
  u: Upstream,
  routes: RouteTable,
  method: string,
  pathWithQuery: string,
  body?: unknown,
  opts: HitOptions = {},
): {
  cap: ReturnType<typeof fakeRes>;
  done: Promise<void>;
  /** 喊**请求**侧事件。注意：真 Node 里读完成体的 req 早已 close 过，SSE 的断连不认它（见 fakeRes.fire）。 */
  fire(event: string): void;
  fireRes(event: string): void;
} {
  const cap = fakeRes();
  const payload =
    opts.rawBody !== undefined
      ? Buffer.isBuffer(opts.rawBody)
        ? opts.rawBody
        : Buffer.from(opts.rawBody, 'utf8')
      : body !== undefined
        ? Buffer.from(JSON.stringify(body), 'utf8')
        : undefined;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  for (const [k, v] of Object.entries(opts.headers ?? {})) headers[k.toLowerCase()] = v;
  const listeners: Record<string, Array<() => void>> = {};
  const req = {
    method,
    url: pathWithQuery,
    headers,
    on(event: string, cb: () => void) {
      (listeners[event] ??= []).push(cb);
      return req;
    },
    async *[Symbol.asyncIterator]() {
      if (payload !== undefined) yield payload;
    },
  } as unknown as IncomingMessage;
  return {
    cap,
    done: buildHandler(routes, u)(req, cap.res),
    fire(event: string) {
      for (const cb of listeners[event] ?? []) cb();
    },
    fireRes(event: string) {
      cap.fire(event);
    },
  };
}

export async function hit(
  u: Upstream,
  routes: RouteTable,
  method: string,
  pathWithQuery: string,
  body?: unknown,
  opts: HitOptions = {},
): Promise<{ status: number; json: any; text?: string }> {
  const { cap, done } = sendRequest(u, routes, method, pathWithQuery, body, opts);
  await done;
  const text = cap.body;
  return { status: cap.status ?? 0, json: text ? JSON.parse(text) : undefined, text };
}
