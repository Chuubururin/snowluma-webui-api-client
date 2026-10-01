// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
import { createServer } from 'node:http';
import { buildHandler } from './index.js';
import { createUpstream, type Upstream } from './upstream.js';
import { fail, ok, type RouteTable } from './http.js';
import { gateRoutes, clearGateState } from './routes/gates.js';
// 路由表来源必须是**手写**那份：demo 的语义端点（`GET /overview` 聚合 7 路上游、`POST /totp-begin`
// 的绑定时序）是策展出来的客户端行为，spec 里没有任何一条 operation 能机械推出它们。
// `.gen.ts` 那份是上游路径的 1:1 镜像（`GET /status`），与客户端调用的路径零交集。
import { overviewRoutes } from './routes/overview.js';
import { processRoutes } from './routes/processes.js';
import { configRoutes } from './routes/config.js';
import { logRoutes } from './routes/logs.js';
import { settingsRoutes } from './routes/settings.js';
import { debugRoutes } from './routes/debug.js';
import { streamRoutes } from './routes/streams.js';

/**
 * 各批次往这里加自己那张表；加一块、删一块 dashboard.ts 里的旧实现，不留两份。
 * `GET /appearance` 原在的种子表里，把它搬进 gates.ts（它是门禁屏的第 4 条白名单读），
 * 这里只留地址两端的路由 —— 同一形状的实现留两份，改一处漏一处。
 */
export function collectRoutes(): RouteTable {
  return {
    'GET /base-url': async (_ctx, u) => ok({ baseUrl: u.baseUrl }),
    'POST /set-base-url': async (ctx, u) => {
      try {
        u.setBaseUrl(String(ctx.json?.baseUrl ?? ''));
      } catch (e) {
        return fail(400, (e as Error).message);
      }
      // setBaseUrl 与 token 同进同退（实现批次）：换目标 = 旧会话必然作废。
      // 门禁状态存在 gates.ts 的 WeakMap 里，setBaseUrl 管不到它 —— 不一起清就会拿上一台的判断
      // 替这一台放行（第二道闸静默开着）。
      clearGateState(u);
      return ok({ baseUrl: u.baseUrl, step: 'login' });
    },
    ...gateRoutes,
    ...overviewRoutes,
    ...processRoutes,
    ...configRoutes,
    ...logRoutes,
    ...settingsRoutes,
    ...debugRoutes,
    ...streamRoutes,
  };
}

/** 只监听 127.0.0.1：这个 demo 持有操作者口令，绑 0.0.0.0 等于把它交给整张局域网。 */
export function startDemoServer(port = 6097, upstream?: Upstream) {
  const u = upstream ?? createUpstream(process.env.SNOWLUMA_DEMO_BASE_URL ?? 'http://127.0.0.1:5099');
  const server = createServer(buildHandler(collectRoutes(), u));
  // 端口占用/保留段直接裸栈崩是同一病灶（测试侧修过两次），生产装配点必须有 error 监听。
  server.on('error', (e: NodeJS.ErrnoException) => {
    if (e.code === 'EADDRINUSE') {
      console.error(`端口 ${port} 已被占用。换端口：SNOWLUMA_DEMO_PORT=<空闲端口> npm run demo`);
    } else if (e.code === 'EACCES') {
      console.error(
        `端口 ${port} 被系统保留（Windows 动态端口段）。` +
          `查保留段：netsh int ipv4 show excludedportrange protocol=tcp\n` +
          `换端口：SNOWLUMA_DEMO_PORT=<空闲端口> npm run demo`,
      );
    } else {
      console.error(`服务器启动失败：${e.message}`);
    }
    process.exit(1);
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`SnowLuma 轻量客户端 demo：http://127.0.0.1:${port}（目标实例 ${u.baseUrl}）`);
  });
  return { server, upstream: u };
}
