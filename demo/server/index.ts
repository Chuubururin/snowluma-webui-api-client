// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
import type { IncomingMessage, ServerResponse } from 'node:http';
import { BadRequestBody, readCtx, type RouteTable } from './http.js';
import { readClientCss, renderIndex, transpileClient } from './assets.js';
import type { Upstream } from './upstream.js';

/**
 * 认证闸白名单：门禁屏所需的最小集（设计口径），其余一律要会话。
 * 类型必须是 ReadonlySet：可变 Set 意味着任何模块 import 之后一次 `.add()` 就能把需要 token
 * 的路由悄悄洗白，而运行期没人发现得了。
 */
export const PUBLIC_ROUTES: ReadonlySet<string> = new Set([
  'GET /',
  'GET /favicon.ico',
  'GET /appearance',
  'GET /base-url',
  'POST /set-base-url',
  'POST /gate/login',
]);

/** 静态资源前缀：不进 RouteTable（它们不映射到任何 operationId）。 */
const ASSET_RE = /^\/client\/[A-Za-z0-9._/-]+\.(js|css)$/;

export function buildHandler(routes: RouteTable, u: Upstream) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // 整个监听器都在错误边界之内：少这一层 try，任何一个 handler 抛异常、readCtx 的流出错、
    // 甚至畸形 req.url 让 new URL 抛（'//' 就会）都会变成 unhandledRejection —— Node≥15 默认
    // 直接退出进程，而这个请求永远收不到响应。种子路由自带 try/catch 掩盖了它，还要
    // 再叠约 50 个 handler，那时炸的是整个 demo。
    try {
      const url = new URL(req.url ?? '/', 'http://x');
      const method = req.method ?? 'GET';
      // 只比对 pathname：带 query 的 /onebot-config?uin=… 必须能命中 /onebot-config
      const key = `${method} ${url.pathname}`;

      if (method === 'GET' && url.pathname === '/') {
        const html = await renderIndex();
        if (html === null) return send(res, 500, { success: false, message: 'demo/client/index.html 缺失' });
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html);
        return;
      }
      if (method === 'GET' && ASSET_RE.test(url.pathname)) {
        const rel = url.pathname.replace('/client/', '');
        if (rel.endsWith('.css')) {
          const css = await readClientCss(rel);
          if (css === null) return send(res, 404, { success: false, message: '样式表不存在' });
          res.writeHead(200, { 'content-type': 'text/css; charset=utf-8' }).end(css);
          return;
        }
        const js = await transpileClient(rel);
        if (js === null) return send(res, 404, { success: false, message: '客户端模块不存在' });
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }).end(js);
        return;
      }
      if (url.pathname === '/favicon.ico') {
        res.writeHead(204).end();
        return;
      }

      const handler = routes[key];
      if (!handler) return send(res, 404, { success: false, message: `未知端点 ${key}` });
      if (!PUBLIC_ROUTES.has(key) && !u.token) {
        // 带 step:'login'：这条 401 是"没有会话"，不是"状态读不出来"。少了它，客户端把登出后的第一次
        // /gate/state 画成"无法确认门禁状态"（浏览器实测踩过），而正确的一屏是登录屏。
        // 文案也不能说 "Token expired or invalid"：那是**上游**对"递上来一个失效 token"的回答，
        // 而这里是 demo 自己压根没有会话（第一次进屏 / 刚登出）。把前者印在登录屏上，
        // 等于对着从来没登录过的人说"你的会话过期了"（浏览器走查抓到）。
        return send(res, 401, { success: false, message: '还没有可用会话，请重新登录', step: 'login' });
      }
      const ctx = { ...(await readCtx(req, url)), raw: { req, res } };
      const out = await handler(ctx, u);
      // null ⇒ 处理器已自行接管 res（SSE 逐帧写），不能再 end
      if (out === null) return;
      if (res.headersSent) return;
      send(res, out.status, out.body);
    } catch (e) {
      // 请求体读不出来是客户端的错（400），其余一律 500：别让两者共用一个状态码骗前端重试。
      if (res.headersSent) return;
      const status = e instanceof BadRequestBody ? 400 : 500;
      if (status === 500 && !process.env.VITEST) console.error('[demo] 500', e);
      try {
        send(res, status, { success: false, message: String(e) });
      } catch {
        // 收发端此时多半已断开：这里再抛出去就又是 unhandledRejection，边界白设。
      }
    }
  };
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(body));
}
