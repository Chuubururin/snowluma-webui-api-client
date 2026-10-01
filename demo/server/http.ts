// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
import type { IncomingMessage, ServerResponse } from 'node:http';

export interface ApiResult {
  status: number;
  body: unknown;
}

export interface Ctx {
  /** 已剥 query：带 ?uin= 的 /onebot-config 必须能命中路由（设计口径缺陷） */
  pathname: string;
  query: URLSearchParams;
  json: any;
  form: FormData | null;
  /** SSE 处理器要从 raw.res 写帧，故 ctx 必须带原始收发端。 */
  raw: { req: IncomingMessage; res: ServerResponse };
}

export type Handler = (ctx: Ctx, u: import('./upstream.js').Upstream) => Promise<ApiResult | null>;
export type RouteTable = Record<string, Handler>;

export const ok = (body: unknown): ApiResult => ({ status: 200, body });
export const fail = (status: number, message: string, extra: Record<string, unknown> = {}): ApiResult => ({
  status,
  body: { success: false, message, ...extra },
});

/**
 * 请求体本身读不出来（JSON 语法坏、multipart 缺 boundary）。
 * 旧写法是往 ctx.json 里塞 `{ __parseError: true }` 哨兵，而全仓没有任何 handler 消费它 ⇒
 * 坏请求体带着 200 静默流进业务逻辑。现在只在一处抛出，由 buildHandler 的错误边界统一转 400，
 * 与"handler 自己抛异常 ⇒ 500"划清界限。
 */
export class BadRequestBody extends Error {}

const CRLF_CRLF = Buffer.from('\r\n\r\n', 'utf8');

/** multipart 只需要"一个文件 + 若干标量"，故用上游同款的手写边界切分，不引 busboy。 */
function parseMultipart(body: Buffer, boundary: string): FormData {
  const form = new FormData();
  const delim = Buffer.from(`--${boundary}`, 'utf8');
  let at = body.indexOf(delim);
  while (at !== -1) {
    const from = at + delim.length;
    const next = body.indexOf(delim, from);
    const raw = body.subarray(from, next === -1 ? body.length : next);
    at = next;
    // 结束界 `--boundary--` 与其后的 epilogue：跳过，否则会产出一个幽灵字段
    if (raw.length === 0 || raw[0] === 0x2d) continue;
    const head = raw[0] === 0x0d && raw[1] === 0x0a ? raw.subarray(2) : raw;
    const cut = head.indexOf(CRLF_CRLF);
    if (cut === -1) continue;
    // 头部是 ASCII ⇒ 只对它做 utf8 解码；段体全程保持原始字节
    const headers = head.subarray(0, cut).toString('utf8');
    let value = head.subarray(cut + CRLF_CRLF.length);
    if (value.length >= 2 && value[value.length - 2] === 0x0d && value[value.length - 1] === 0x0a) {
      value = value.subarray(0, value.length - 2);
    }
    const m = /name="([^"]+)"(?:;\s*filename="([^"]*)")?/i.exec(headers);
    if (!m) continue;
    // 只有无 filename 的字段段才是文本：那里 utf8 解码是对的。
    // brief 原式 `append(name, string|Blob, filename)` 在 DOM 类型下不成立（带第三参即选 Blob 重载），
    // 故两条分支各调各的重载。
    if (m[2] === undefined) {
      form.append(m[1], value.toString('utf8'));
      continue;
    }
    const type = /content-type:\s*([^\r\n]+)/i.exec(headers)?.[1]?.trim();
    // new Uint8Array(buf) 拷出一份独立的 ArrayBuffer（BlobPart 的类型要求如此，顺带不再牵住
    // 整个请求体缓冲）。字节内容不变，Blob 侧看到的仍是原始二进制。
    form.append(m[1], new Blob([new Uint8Array(value)], type ? { type } : undefined), m[2]);
  }
  return form;
}

/** 读请求体：JSON 与 multipart 两条形态各归各的字段，不靠调用方猜 content-type。 */
const MAX_BODY = 10 * 1024 * 1024; // 10 MB —— demo 服务器，含文件上传；超此值直接拒，不缓冲。
export async function readCtx(req: IncomingMessage, url: URL): Promise<Omit<Ctx, 'raw'>> {
  const cl = Number(req.headers['content-length']);
  if (cl > MAX_BODY) throw new BadRequestBody(`请求体过大（${cl} > ${MAX_BODY}）`);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of req) {
    total += (c as Buffer).length;
    if (total > MAX_BODY) throw new BadRequestBody(`请求体过大（> ${MAX_BODY}）`);
    chunks.push(c as Buffer);
  }
  // 二进制安全的要害：这里从字节出发切分，只在"确知是文本"的地方才 toString('utf8')。
  // 早先的写法先 `Buffer.concat(...).toString('utf8')` 再 `Blob([value])` 重新编码 —— 图片/备份/证书
  // 里的非法 UTF-8 序列会全变 U+FFFD，上传落盘即不可逆损坏（用的正是这条路径）。
  const body = Buffer.concat(chunks);
  const ct = (req.headers['content-type'] ?? '') as string;
  let json: any = null;
  let form: FormData | null = null;
  if (body.length > 0) {
    if (ct.includes('application/json')) {
      try {
        json = JSON.parse(body.toString('utf8'));
      } catch (e) {
        throw new BadRequestBody(`请求体不是合法 JSON：${String(e)}`);
      }
    } else if (ct.includes('multipart/form-data')) {
      // boundary 取值截到下一个 ; —— 否则 "boundary=x; charset=utf-8" 会把参数并进
      // boundary，body 永不命中分隔符，静默产出空 FormData（字段全丢且不报错）。
      const boundary = ct.split('boundary=')[1]?.split(';')[0]?.trim().replace(/^"|"$/g, '');
      if (!boundary) throw new BadRequestBody('multipart 请求体缺少 boundary');
      form = parseMultipart(body, boundary);
    }
  }
  return { pathname: url.pathname, query: url.searchParams, json, form };
}
