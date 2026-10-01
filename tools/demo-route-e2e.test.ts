// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
/**
 * E2E 烟雾：真 HTTP 服务器上逐条打客户端会发的路径，断言没有一条回 `未知端点`。
 *
 * 与 demo-route-contract.test.ts 的分工：那张表比的是 `collectRoutes()` 这个**对象**，
 * 本文件比的是 `buildHandler()` 装配后**真的在收请求的那张表**，并复用生产同款 key 拼法
 * （`${method} ${url.pathname}`）。静态正则若漏掉某种调用形态，这里会以 404 现形。
 *
 * 上游刻意指向一个没人监听的端口：本测试只问"路由存不存在"，不问"数据对不对"。
 * `index.ts` 先查 handler 再查 token，所以 404 优先于 401/502 —— 反过来任何非 404
 * （401 未登录、502 上游不可达）都已经证明这条路由注册着。把上游打通反而会把断言
 * 变成对响应形状的重复校验。
 */
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildHandler } from '../demo/server/index.js';
import { collectRoutes } from '../demo/server/start.js';
import { createUpstream } from '../demo/server/upstream.js';
import { clientRequests } from './lib/client-call-paths.js';

let port = 0;
let server: Server;

beforeAll(async () => {
  // 端口上无人监听 ⇒ 上游调用必失败；见文件头，这对本测试是设定而非缺陷。
  const u = createUpstream('http://127.0.0.1:1');
  server = createServer(buildHandler(collectRoutes(), u));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  port = (server.address() as { port: number }).port;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('真实 HTTP 装配点：客户端请求不得 404', () => {
  it('每条客户端请求（方法+路径）都不返回「未知端点」', async () => {
    const reqs = (await clientRequests('demo/client')).filter((r) => !r.path.startsWith('http'));
    // 夹具守卫：扫描失效时下面的循环体一次都不跑，测试会假绿。
    expect(reqs.length).toBeGreaterThanOrEqual(20);
    expect(reqs.some((r) => r.method === 'POST')).toBe(true);

    const dead: string[] = [];
    for (const r of reqs) {
      const res = await fetch(`http://127.0.0.1:${port}${r.path}`, { method: r.method });
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      if (res.status === 404 && typeof body.message === 'string' && body.message.includes('未知端点')) {
        dead.push(`${r.method} ${r.path}`);
      }
    }
    expect(dead).toEqual([]);
  });

  it('GET /overview（首屏）在真实服务器上可达 —— 这正是 P0 挂掉的那一条', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/overview`);
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    expect(body.message ?? '').not.toContain('未知端点');
  });

  it('方法错配必须现形：POST-only 的路由用 GET 打要 404（证明本测试真在比方法）', async () => {
    // 反向自证：demo 路由器按 `${method} ${pathname}` 精确匹配。若这条不 404，
    // 说明服务器根本没用方法做键，上面那条"方法+路径"断言就是假的。
    const res = await fetch(`http://127.0.0.1:${port}/backup-import`, { method: 'GET' });
    expect(res.status).toBe(404);
  });
});
