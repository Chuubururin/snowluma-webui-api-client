// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
/**
 * L3：把 SSE 代理放进**真 Node 服务器**里跑一遍（其余 streams 用例跑在组装出来的假 req/res 上）。
 *
 * 这个文件存在的唯一理由，是的真浏览器走查连带抓到的一条假绿：
 *  · `readCtx` 用 `for await (const c of req)` 读体，读完的那一刻 `IncomingMessage` 就被 autoDestroy
 *    销毁并抛过 `close` —— 之后注册的 `req.on('close')` **永远听不到**（实测：客户端真断开时只有
 *    `res` 抛出 close）。于是"浏览器走了就释放上游订阅"这句在服务端一次也没生效过。
 *  · 假的 req 只有测试自己 `fire('close')` 才会响，所以 L2 那一层全绿而缺陷照在。
 * ⇒ 断连只能认 `ServerResponse` 的 close；而这条不变量只有真服务器能钉，留在这里。
 */
import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildHandler } from '../demo/server/index.js';
import { createUpstream, type Upstream } from '../demo/server/upstream.js';
import { gateRoutes } from '../demo/server/routes/gates.js';
import { streamRoutes } from '../demo/server/routes/streams.js';
import { blockedPortHint, isFetchBlockedPort } from './lib/port-probe.js';

const PASSWORD = 'live-pass';
const TOKEN = 'TK-live';

/** 假上游：只说这一族用例需要的四个门禁端点 + 一条由测试决定何时出帧的 state 流。 */
function makeUpstream() {
  const seen = { opens: 0, closes: 0 };
  const senders: Array<(o: unknown) => void> = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      const path = (req.url ?? '').split('?')[0];
      const raw = Buffer.concat(chunks).toString('utf8');
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (path === '/api/login') {
        return raw.includes(PASSWORD)
          ? json(200, { success: true, token: TOKEN, mustChangePassword: false })
          : json(401, { success: false, message: '密码错误' });
      }
      if (String(req.headers.authorization ?? '') !== `Bearer ${TOKEN}`) {
        return json(401, { status: 'failed', message: 'Token expired or invalid' });
      }
      if (path === '/api/agreements') return json(200, { version: 'v1', consentRequired: false, documents: [] });
      if (path === '/api/auth/state') return json(200, { mustChangePassword: false });
      if (path === '/api/status') return json(200, { status: 'running' });
      if (path === '/api/state/stream') {
        seen.opens += 1;
        const push = (o: unknown) => {
          if (res.writableEnded || res.destroyed) return;
          try {
            res.write('data: ' + JSON.stringify(o) + '\n\n');
          } catch {
            // 对面已经走了：这一帧本就没人接
          }
        };
        senders.push(push);
        // 建流即出一帧 ready，并且此后测试随时能再推：客户端"留在流上"能不能持续收帧，看的就是这里
        push({ kind: 'ready' });
        res.on('close', () => {
          seen.closes += 1;
        });
        return;
      }
      return json(404, { success: false, message: `夹具没有 ${req.method} ${path}` });
    });
  });
  return { server, seen, senders };
}

async function listen(server: Server, port = 0): Promise<number> {
  // 每一轮都要重新挂 error 分支：它不是装饰。bind 失败（EADDRINUSE，或 Windows 保留段的 EACCES）
  // 没人接时这个 promise 永不 settle —— 实测旧形状每条用例付 22 秒、报告写 "Hook timed out in
  // 20000ms"（原因只以一条 unhandled error 漏在日志里）；接上之后 2 秒失败并直接点名 EADDRINUSE。
  //
  // bind 成功也还不算数：端口落在 fetch 的 bad-port 表上时（6665-6669……），服务器真的在监听，
  // 但每一个 fetch 在连接之前就死掉。这就是这个文件偶发红的根因，判据与出处见 tools/lib/port-probe.ts。
  for (let attempt = 1; ; attempt++) {
    server.removeAllListeners('error');
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => resolve());
    });
    const got = (server.address() as { port: number }).port;
    if (!(await isFetchBlockedPort(got))) return got;
    await closeDown(server);
    // 显式指定的端口是契约，悄悄换一个交出去等于没按调用方说的做 ⇒ 就地报错点名。
    if (port !== 0) throw new Error(blockedPortHint(got));
    if (attempt >= 8) {
      throw new Error(`连续 ${String(attempt)} 次 listen(0) 都拿到被 fetch 拦掉的端口（最后一次 ${String(got)}）。${blockedPortHint(got)}`);
    }
  }
}

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 出网这一枪自己限时：`attach()` 现在会 `flushHeaders()`，所以"拿不到响应头"只剩一种解释 ——
 * 服务端真的没答话。这里的 'NO-HEAD' 是断言用的哨兵，不再是"头要等第一帧才 flush"的遮羞布
 * （那个前提在修之前确实成立，并且正是 6097 上挂死的那条连接）。
 */
async function openDemoStream(port: number, ms: number): Promise<Response | 'NO-HEAD'> {
  return await Promise.race([
    fetch(`http://127.0.0.1:${port}/events?topic=state`),
    settle(ms).then(() => 'NO-HEAD' as const),
  ]);
}

/** 读到 want 帧为止，或到 ms 毫秒为止；返回实际解出来的帧。 */
async function readFrames(rd: ReadableStreamDefaultReader<Uint8Array>, want: number, ms: number) {
  const dec = new TextDecoder();
  const out: any[] = [];
  let buf = '';
  const endAt = Date.now() + ms;
  while (out.length < want && Date.now() < endAt) {
    const raced = await Promise.race([rd.read(), settle(Math.max(50, endAt - Date.now())).then(() => 'TIMEOUT')]);
    if (raced === 'TIMEOUT') break;
    const { done, value } = raced as { done: boolean; value?: Uint8Array };
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let at = buf.indexOf('\n\n');
    while (at !== -1) {
      const block = buf.slice(0, at);
      buf = buf.slice(at + 2);
      at = buf.indexOf('\n\n');
      const m = /^data: ([\s\S]*)$/.exec(block);
      if (m) out.push(JSON.parse(m[1]));
    }
  }
  return out;
}

const closeDown = async (s: Server) => {
  s.closeAllConnections?.();
  await new Promise<void>((r) => s.close(() => r()));
};

describe('真 Node 服务器上的 SSE 代理', () => {
  let up: ReturnType<typeof makeUpstream>;
  let demoPort = 0;
  let demo: Server;
  let u: Upstream;
  const lastSender = () => up.senders[up.senders.length - 1];

  // 每条用例一套真服务器：订阅表、undici 的连接池、上游那条流的生死都是"这一条用例的"，
  // 用例之间不共享受服务端的进程内状态 —— 否则上一条的收尾时序会伪装成这一条的缺陷。
  beforeEach(async () => {
    up = makeUpstream();
    const upPort = await listen(up.server);
    u = createUpstream(`http://127.0.0.1:${upPort}`);
    demo = createServer(buildHandler({ ...gateRoutes, ...streamRoutes }, u));
    demoPort = await listen(demo);
    const login = await fetch(`http://127.0.0.1:${demoPort}/gate/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD }),
    });
    // 断言消息带上响应正文：这条链偶发红过三次，每次红都不知道红在哪。只报状态码就等于把成因
    // 丢掉，而正文曾经只有 `fetch failed` —— 现在的 500 会把 `cause` 一起折进来（根因那一层）。
    expect(login.status, `gate/login 正文：${await login.clone().text()}`).toBe(200);
    expect(((await login.json()) as any).step).toBe('app');
  }, 20000);

  afterEach(async () => {
    await closeDown(demo);
    await closeDown(up.server);
  }, 10000);

  it(
    '浏览器留在流上 ⇒ 第二帧、第三帧继续到浏览器（响应头不许等不到客人就走）', { timeout: 20000 },
    async () => {
      const res = await openDemoStream(demoPort, 5000);
      if (res === 'NO-HEAD') throw new Error('服务端没出响应头：/events?topic=state 挂住');
      const rd = res.body!.getReader();
      expect(await readFrames(rd, 1, 3000)).toEqual([{ kind: 'ready' }]);
      lastSender()?.({ resource: 'qq-list', data: [{ uin: 10001, nickname: '第二帧' }] });
      lastSender()?.({ kind: 'dropped', count: 2 });
      expect(await readFrames(rd, 2, 3000)).toEqual([
        { resource: 'qq-list', data: [{ uin: 10001, nickname: '第二帧' }] },
        { kind: 'dropped', count: 2 },
      ]);
      expect(up.seen.opens).toBe(1); // 一个浏览器连接 = 一条上游订阅
      await rd.cancel();
    },
  );

  it(
    '浏览器真的走了 ⇒ 上游那条订阅被释放，下一条连接不会被死订阅饿死', { timeout: 20000 },
    async () => {
      const closesBefore = up.seen.closes;
      const res = await openDemoStream(demoPort, 5000);
      if (res === 'NO-HEAD') throw new Error('服务端没出响应头：/events?topic=state 挂住');
      const rd = res.body!.getReader();
      expect(await readFrames(rd, 1, 3000)).toEqual([{ kind: 'ready' }]);
      const opensBefore = up.seen.opens;
      await rd.cancel(); // 客人离席：真断开由 res 的 close 显形
      await settle(500);
      expect(up.seen.closes).toBeGreaterThan(closesBefore); // 上游那条流确实被 abort 了
      const again = await openDemoStream(demoPort, 3000);
      if (again === 'NO-HEAD') throw new Error('上一条客人走后，新连接再也拿不到响应头（死订阅被复用）');
      const rd2 = again.body!.getReader();
      expect(await readFrames(rd2, 1, 3000)).toEqual([{ kind: 'ready' }]);
      expect(up.seen.opens).toBe(opensBefore + 1); // 归零后重新订阅，而不是骑在已死的那条上
      await rd2.cancel();
    },
  );

  it(
    '第二条浏览器连接骑在已开的共用订阅上 ⇒ 没有新帧也必须拿到响应头，且后续帧两位客人都收得到',
    { timeout: 20000 },
    async () => {
      // 这就是 6097 上实测挂死的那条形态：上游只在订阅建立那一刻推 `ready`（夹具里
      // `push({ kind: 'ready' })` 那一行，别按行号找——本文件加过守卫，行号一直在漂），
      // 晚加入的连接此后一帧都收不到，直到实例真发生一次变更。少了 attach() 里的 flushHeaders，
      // 这条连接在浏览器那侧就是"fetch 永不 resolve"——而它看起来完全像是服务端没答话。
      const a = await openDemoStream(demoPort, 5000);
      if (a === 'NO-HEAD') throw new Error('第一位客人的响应头就没出来');
      const rdA = a.body!.getReader();
      expect(await readFrames(rdA, 1, 3000)).toEqual([{ kind: 'ready' }]);
      expect(up.seen.opens).toBe(1);

      const b = await openDemoStream(demoPort, 3000);
      if (b === 'NO-HEAD') throw new Error('第二条连接骑在已开的订阅上 ⇒ 拿不到响应头（缺 flushHeaders）');
      const rdB = b.body!.getReader();

      lastSender()?.({ resource: 'qq-list', data: [{ uin: 10001, nickname: '变更帧' }] });
      // 一条上游帧要同时到达两位客人：共用订阅不是"只给第一位"
      expect(await readFrames(rdA, 1, 3000)).toEqual([{ resource: 'qq-list', data: [{ uin: 10001, nickname: '变更帧' }] }]);
      expect(await readFrames(rdB, 1, 3000)).toEqual([{ resource: 'qq-list', data: [{ uin: 10001, nickname: '变更帧' }] }]);
      expect(up.seen.opens).toBe(1); // 两位客人仍然只开一条上游
      await rdA.cancel();
      await rdB.cancel();
    },
  );
});

/**
 * `listen()` 的坏端口守卫。这两条不借用上面那套 beforeEach：它们要的只是"bind 与 fetch 是两件事"
 * 这一条不变量，放进那个 describe 会让每条用例白付两个真服务器。
 *
 * 为什么这两条钉得住、而"整套多跑几次不红"钉不住：偶发的概率由操作系统当时发到哪一段端口决定，
 * 不由代码决定。这里把端口写死成表上的那一个，机制就变成确定的 —— 摘掉守卫，第一条立刻红。
 */
describe('bind 成功不等于 fetch 打得出去', () => {
  it('显式指定被 fetch 拦掉的端口 ⇒ 就地报错点名 bad port，且不把服务器留在监听态', async () => {
    // 前提探针：这台运行时确实拦 6667。不拦的话这条守卫无从作证（判据不抄表，见 port-probe 头注）。
    expect(await isFetchBlockedPort(6667), '运行时不拦 6667：这条用例失去对象，须换端口而不是放宽守卫').toBe(true);
    const s = createServer();
    await expect(listen(s, 6667)).rejects.toThrow(/bad port/);
    expect(s.listening, '报错之前必须已经 close：留下一个没人接管的监听服务器会挂住整个测试进程').toBe(false);
  });

  it('显式指定没被拦的端口 ⇒ 原样交出去（守卫不许顺手换成别的口，也不误杀能用的端口）', async () => {
    // 带 handler：守卫的探测会真的打一次这个口。不回话的服务器也能过（探测把"超时"当成可达），
    // 但那样这条用例会白付 1.5 秒 —— 探测的真实形状是"有响应 ⇒ 可达"。
    const s = createServer((_req, res) => res.writeHead(404).end());
    expect(await listen(s, 7000)).toBe(7000);
    await closeDown(s);
  });

  it('上游地址落在被拦的端口上 ⇒ /gate/login 的 500 正文点名 bad port，而不是只剩 "fetch failed"', async () => {
    // 这就是偶发红当时的形状：路由把传输层失败折成 UpstreamError，正文曾经只有 "fetch failed"，
    // 于是三次红都没有留下原因。现在 cause 在 unwrap 那一处（全仓唯一折叠点）就拼进 message。
    // 6667 这里不需要有人监听 —— 被拦的连接根本发不出去。
    const demo = createServer(buildHandler({ ...gateRoutes }, createUpstream('http://127.0.0.1:6667')));
    const p = await listen(demo);
    try {
      const res = await fetch(`http://127.0.0.1:${String(p)}/gate/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: PASSWORD }),
      });
      const body = (await res.json()) as { step?: string; message?: string };
      expect(res.status).toBe(500);
      expect(body.step).toBe('login');
      expect(body.message, `正文必须带上成因，实为：${String(body.message)}`).toMatch(/bad port/);
    } finally {
      await closeDown(demo);
    }
  });
});
