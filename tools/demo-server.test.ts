// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
import { describe, expect, it } from 'vitest';
import { PUBLIC_ROUTES, buildHandler } from '../demo/server/index.js';
import type { RouteTable } from '../demo/server/http.js';
import { createUpstream } from '../demo/server/upstream.js';
import { fakeRes, encodeMultipart, hit, upstreamWith } from './helpers/demo-http.js';
import { transpileClient } from '../demo/server/assets.js';

/**
 * 编译期闸：`PUBLIC_ROUTES` 必须真是 `ReadonlySet`。可变 Set 意味着任何模块 import 之后
 * 一次 `.add()` 就能把需要 token 的路由悄悄洗白，而运行期没人能发现。
 * 一旦哪天把它退回 `Set<string>`，`NoMutators<…>` 收成 never ⇒ typecheck:demo 立刻红。
 */
type NoMutators<T> = T extends { add: unknown } ? never : T;
const immutablePublicRoutes: NoMutators<typeof PUBLIC_ROUTES> = PUBLIC_ROUTES;

describe('server skeleton', () => {
  it('路由比对 pathname：带 query 的路由必须命中', async () => {
    const routes: RouteTable = { 'GET /onebot-config': async (ctx) => ({ status: 200, body: { uin: ctx.query.get('uin') } }) };
    const u = upstreamWith(() => ({ status: 200, body: {} }));
    expect(await hit(u, routes, 'GET', '/onebot-config?uin=10001')).toEqual({ status: 200, json: { uin: '10001' }, text: '{"uin":"10001"}' });
  });
  it('未登录时非白名单路由 401，白名单放行', async () => {
    const routes: RouteTable = {
      'GET /overview': async () => ({ status: 200, body: 'priv' }),
      'GET /appearance': async () => ({ status: 200, body: 'pub' }),
    };
    // 测闸本身：裸 createUpstream，不 seed token（与 fixtures 默认相反）。
    const u = createUpstream('http://127.0.0.1:5099');
    // 401 必须自带 step:'login'：登出后的第一次 /gate/state 走的就是这条闸，少了 step
    // 客户端只能落到"无法确认门禁状态"而不是登录屏（浏览器实测抓到的缺陷）。
    expect(await hit(u, routes, 'GET', '/overview')).toMatchObject({
      status: 401,
      json: { success: false, step: 'login' },
    });
    expect(await hit(u, routes, 'GET', '/appearance')).toMatchObject({ status: 200, json: 'pub' });
  });
  it('未知路由 404，不落到 /index.html', async () => {
    const u = upstreamWith(() => ({ status: 200, body: {} }));
    expect((await hit(u, {}, 'GET', '/nope')).status).toBe(404);
  });
  it('换目标地址在登录之前也放行：POST /set-base-url 必须在白名单里', async () => {
    expect(PUBLIC_ROUTES.has('POST /set-base-url')).toBe(true);
    const routes: RouteTable = {
      'POST /set-base-url': async (ctx, uu) => {
        uu.setBaseUrl(String(ctx.json.baseUrl));
        return { status: 200, body: { baseUrl: uu.baseUrl, token: uu.token } };
      },
    };
    // 无会话也要能改址：否则"改不了地址所以永远进不去"死锁。
    const u = createUpstream('http://127.0.0.1:5099');
    u.authenticate('T-pre');
    const r = await hit(u, routes, 'POST', '/set-base-url', { baseUrl: 'http://127.0.0.1:6001' });
    expect(r.json).toEqual({ baseUrl: 'http://127.0.0.1:6001', token: null });
  });
  it('favicon 204：裸捕获端验证无响应体', async () => {
    const cap = fakeRes();
    const handler = buildHandler({}, createUpstream('http://127.0.0.1:5099'));
    await handler({ method: 'GET', url: '/favicon.ico', headers: {}, async *[Symbol.asyncIterator]() {} } as never, cap.res);
    expect(cap.status).toBe(204);
    expect(cap.body).toBe('');
  });
  it('transpileClient 就地剥类型：下发的 .js 不含 TS 标注，且拒路径穿越', async () => {
    // 对外 URL 是 /client/app.js，磁盘源是 app.ts —— brief 原式在两头各自为政，这里钉住映射。
    // 资产响应不是 JSON，走裸捕获端而非 hit()。
    const cap = fakeRes();
    const handler = buildHandler({}, createUpstream('http://127.0.0.1:5099'));
    await handler({ method: 'GET', url: '/client/app.js', headers: {}, async *[Symbol.asyncIterator]() {} } as never, cap.res);
    expect(cap.status).toBe(200);
    // 钉的是"仍按 ESM 裸引用兄弟模块"（不内联、不打包），不是某个具体 import 语句的写法：
    // 花括号里导入了什么会随实现批次变化，写成整句就等于让每个改 api.ts 导入的人去解一条格式锁。
    expect(cap.body!).toContain('import {');
    expect(cap.body!).toContain('from "./api.js"');
    expect(cap.body!).toContain('from "./pages/gate.js"');
    const js = await transpileClient('ui.ts');
    expect(js).not.toBeNull();
    expect(js!).toContain('function esc');
    expect(js!).not.toContain(': unknown');
    expect(js!).not.toContain('export type');
    // 子目录模块：门禁屏住在 demo/client/pages/ 下，URL 里的斜杠必须原样映射到磁盘（起客户端不止一层）
    const nestedCap = fakeRes();
    await handler(
      { method: 'GET', url: '/client/pages/gate.js', headers: {}, async *[Symbol.asyncIterator]() {} } as never,
      nestedCap.res,
    );
    expect(nestedCap.status).toBe(200);
    expect(nestedCap.body!).toContain('function gateStep');
    expect(await transpileClient('../server/http.ts')).toBeNull();
  });

  it('白名单不可变：类型闸之外，需 token 的路由绝不在名单里', () => {
    expect(immutablePublicRoutes.has('POST /set-base-url')).toBe(true);
    expect(immutablePublicRoutes.has('GET /overview')).toBe(false);
  });

  it('handler 返回 null（已自行接管 res）⇒ buildHandler 一个字都不写出', async () => {
    // 的 SSE 双写防护现在只有这条测试撑着，不再是口头约定。
    const routes: RouteTable = { 'GET /stream': async () => null };
    const cap = fakeRes();
    const handler = buildHandler(routes, upstreamWith(() => ({ status: 200, body: {} })));
    await handler({ method: 'GET', url: '/stream', headers: {}, async *[Symbol.asyncIterator]() {} } as never, cap.res);
    expect(cap.status).toBeUndefined();
    expect(cap.body).toBeUndefined();
  });

  it('错误边界：handler 抛异常与畸形 URL 都归一为 500，且没有 rejection 逃逸去打死进程', async () => {
    const routes: RouteTable = { 'GET /boom': async () => { throw new Error('handler 内部炸了'); } };
    const u = upstreamWith(() => ({ status: 200, body: {} }));
    // 监听器只在本用例内挂：buildHandler 若漏了 catch，Node≥15 默认把 unhandledRejection
    // 转成未捕获异常直接退出进程 —— 那之后这条测试根本不会有结论，故同时显式断言它没响。
    let escaped: unknown = null;
    const onUnhandled = (reason: unknown) => { escaped = reason; };
    process.on('unhandledRejection', onUnhandled);
    try {
      const r = await hit(u, routes, 'GET', '/boom');
      expect(r.status).toBe(500);
      expect(r.json).toMatchObject({ success: false });
      expect(String(r.json.message)).toContain('handler 内部炸了');

      // new URL 也在边界之内：'//' 会抛（浏览器/爬虫真发得出这种请求行），否则整个请求永无响应。
      const cap = fakeRes();
      await buildHandler({}, u)({ method: 'GET', url: '//', headers: {}, async *[Symbol.asyncIterator]() {} } as never, cap.res);
      expect(cap.status).toBe(500);
      expect(cap.body).toContain('"success":false');

      await new Promise((done) => setImmediate(done));
      expect(escaped).toBeNull();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('坏 JSON 在闸口就转 400，绝不带着无人消费的哨兵流进 handler', async () => {
    let reached = false;
    const routes: RouteTable = {
      'POST /echo': async (ctx) => {
        reached = true;
        return { status: 200, body: ctx.json };
      },
    };
    const u = upstreamWith(() => ({ status: 200, body: {} }));
    const r = await hit(u, routes, 'POST', '/echo', undefined, { rawBody: '{"baseUrl":' });
    expect(reached).toBe(false);
    expect(r.status).toBe(400);
    expect(r.json).toMatchObject({ success: false });
  });

  it('multipart 按字节解析：非法 UTF-8 序列经 utf8 往返会不可逆损坏上传文件', async () => {
    // 证书/备份/图片就是这种字节：0xff、0xfe 与截断的多字节序列在 utf8 里全变 U+FFFD。
    const bytes = Uint8Array.from([
      0x89, 0xff, 0xfe, 0x00, 0x41, 0xc3, 0x28, 0xed, 0xa0, 0x80, 0xf4, 0x90, 0x80, 0x80, 0x0a,
    ]);
    const { contentType, body } = encodeMultipart([
      { name: 'note', value: '中文 ✓ 值' },
      { name: 'file', filename: 'a.png', bytes, contentType: 'image/png' },
    ]);
    const routes: RouteTable = {
      'POST /upload': async (ctx) => {
        const file = ctx.form?.get('file') as File;
        const buf = Buffer.from(await file.arrayBuffer());
        return {
          status: 200,
          body: {
            note: ctx.form?.get('note'),
            filename: file.name,
            type: file.type,
            hex: buf.toString('hex'),
          },
        };
      },
    };
    const u = upstreamWith(() => ({ status: 200, body: {} }));
    const r = await hit(u, routes, 'POST', '/upload', undefined, { headers: { 'content-type': contentType }, rawBody: body });
    expect(r.json.hex).toBe(Buffer.from(bytes).toString('hex'));
    expect(r.json.filename).toBe('a.png');
    expect(r.json.type).toBe('image/png');
    // 只有无 filename 的字段段才做 utf8 解码 —— 文本字段的中文必须完好
    expect(r.json.note).toBe('中文 ✓ 值');
  });

  it('boundary 取值截到下一个 ;：boundary=X; charset=utf-8 不再静默产出空 FormData', async () => {
    const { body } = encodeMultipart([{ name: 'note', value: '带参数头' }], 'XBOUNDARY');
    // 手工拼带 charset 参数的 content-type：split('boundary=') 不截断时会把 "; charset=utf-8"
    // 并进 boundary，body 永不命中分隔符，字段全丢且不报错。
    const ct = 'multipart/form-data; boundary=XBOUNDARY; charset=utf-8';
    const routes: RouteTable = { 'POST /upload': async (ctx) => ({ status: 200, body: { note: ctx.form?.get('note') } }) };
    const u = upstreamWith(() => ({ status: 200, body: {} }));
    const r = await hit(u, routes, 'POST', '/upload', undefined, { headers: { 'content-type': ct }, rawBody: body });
    expect(r.status).toBe(200);
    expect(r.json.note).toBe('带参数头');
  });

  it('请求体超 10MB ⇒ 400（Content-Length 预检路径）', async () => {
    const routes: RouteTable = { 'POST /echo': async (ctx) => ({ status: 200, body: ctx.json }) };
    const u = upstreamWith(() => ({ status: 200, body: {} }));
    // Content-Length 报 20MB，实际体不用真发那么多——预检在读体之前就拒。
    const r = await hit(u, routes, 'POST', '/echo', { small: true }, { headers: { 'content-length': '20000000' } });
    expect(r.status).toBe(400);
    expect(r.json.message).toMatch(/过大/);
  });

  it('请求体超 10MB ⇒ 400（无 Content-Length，累计字节闸路径）', async () => {
    const routes: RouteTable = { 'POST /echo': async (ctx) => ({ status: 200, body: ctx.json }) };
    const u = upstreamWith(() => ({ status: 200, body: {} }));
    // 不发 Content-Length，但 rawBody 真超 10MB —— 累计闸在读体过程中截断。
    const big = Buffer.alloc(11 * 1024 * 1024, 0x41); // 11MB of 'A'
    const r = await hit(u, routes, 'POST', '/echo', undefined, { rawBody: big });
    expect(r.status).toBe(400);
    expect(r.json.message).toMatch(/过大/);
  });
});
