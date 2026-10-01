// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
/**
 * L2：SSE 代理（的服务端一半）。
 *
 * 线上形状读自 spec（`spec/openapi.yaml`）而不是想象：
 *  · 四条流端点（`/api/state/stream`、`/api/logs/stream`、`/api/debug/stream`、POST `/api/debug/invoke-stream`）
 *    的 200 都是 `text/event-stream`，帧一律 `data: <json>\n\n` 且**没有 `event:` 字段**
 *    （`x-snowluma-sse.framePrefix/frameSuffix` + `StateStreamFrame` 的描述）。
 *  · state/debug 两面的负载上有**两个** tag 键：控制帧走 `kind`（ready/dropped），
 *    快照帧走 `resource`（`tagFields: [kind, resource]`）。⇒ 转发必须逐字节原样，
 *    折成 demo 自己的信封就等于把上游的契约改掉。
 *  · 流的 200 解析结果是 `{stream}` 形态，**不经 unwrap**（`unwrap` 只认 `{data}`/`{error}`，
 *    折它会把一条正常的流当成"data 是 undefined"误抛）。
 *  · 流上的 401 不是 `UpstreamError`：`createSseClient` 在非 2xx 时抛的是
 *    `Error('SSE failed: <status> <statusText>')`（`generated/typescript/core/serverSentEvents.gen.ts:135`）
 *    ⇒ 状态码只能从这句话里读，且这条读取要被用例钉住（重新生成若改了措辞，用例必须红）。
 *  · `/api/state/stream` 的 503 是**文本体** `state stream not configured`（headless 模式，
 *    `server.ts:1386-1391`），不是 JSON ⇒ 折成"502 demo 坏了"是谎，交回空流是二次谎。
 *
 * 引用计数是这一半的核心不变量：每种 topic 服务端只开一条上游订阅，浏览器连接数归零必须 abort
 * （不留悬挂 SSE，也不让已关面板的幽灵订阅无限重连）。重连策略在这里刻意收成一枪
 * （`sseMaxRetryAttempts: 1`）：谁来重连由浏览器那一层按设计口径的三层模型决定，
 * 因为订阅的生命周期跟着浏览器连接走，不是跟着服务端走。
 */
import { describe, expect, it, vi } from 'vitest';
import { createUpstream, type Upstream } from '../demo/server/upstream.js';
import { acquireStream, streamRoutes, type StreamTopic } from '../demo/server/routes/streams.js';
import { gateRoutes } from '../demo/server/routes/gates.js';
import { sendRequest } from './helpers/demo-http.js';

const ROUTES = { ...gateRoutes, ...streamRoutes };

interface SseFixture {
  u: Upstream;
  calls: Array<{ url: string; method: string; body: string }>;
  aborts: number;
  /** 让上游再推一帧（持有不关闭的流，测引用计数与断线时才用得上）。 */
  push(frame: Record<string, unknown>): void;
  close(): void;
  agreed: boolean;
  setGates(next: { consentRequired?: boolean; mustChangePassword?: boolean }): void;
}

/**
 * 会说 SSE 的假上游。`hold` 为真时流**不自动关闭**：否则 for-await 立刻走完，
 * 引用计数与断线两组断言测的就不是同一件事了。
 * `silent` 为真时连首帧都不发 —— 这不是编出来的怪上游，而是 demo 自己的共用订阅造出来的形状：
 * 上游 state 流确实一接上就推 `ready` + 初始快照（`server.ts:1400`、`sendAllInitial`），但那只给
 * 建立订阅的第一位监听者；晚加入的那位（第二个标签页，或上一条连接还没散伙时进来的这一条）
 * 在此后很长一段时间里一帧都收不到。少了这一档，夹具等于替被测代码保证了"连上就有一帧"，
 * 而 6097 上真挂住的那条连接恰恰没有这个保证。
 */
function sseUpstream(
  opts: { hold?: boolean; silent?: boolean; streamStatus?: number; streamText?: string } = {},
): SseFixture {
  const calls: Array<{ url: string; method: string; body: string }> = [];
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let aborts = 0;
  const gates = { consentRequired: false, mustChangePassword: false };
  const enc = new TextEncoder();
  const push = (frame: Record<string, unknown>) => {
    try {
      controller?.enqueue(enc.encode(`data: ${JSON.stringify(frame)}\n\n`));
    } catch {
      // 订阅已被 abort ⇒ 上游这边再推就报"controller closed"。夹具不许因此崩：真实上游面对的就是这种走掉的客户端。
    }
  };
  const u = createUpstream(
    'http://127.0.0.1:5099',
    (async (input: Request) => {
      const body = await input.text();
      const path = input.url.replace(/^http:\/\/[^/]+/, '');
      calls.push({ url: path.split('?')[0], method: input.method, body });
      input.signal?.addEventListener('abort', () => {
        aborts++;
      });
      if (path === '/api/agreements') {
        return jsonReply({ version: 'sha256:fixture', consentRequired: gates.consentRequired, documents: [] });
      }
      if (path === '/api/auth/state') return jsonReply({ mustChangePassword: gates.mustChangePassword });
      if (path === '/api/status') return jsonReply({ booted: true, state: 'running' });
      if (/\/stream$|-stream$/.test(path)) {
        if (opts.streamStatus && opts.streamStatus !== 200) {
          return new Response(opts.streamText ?? JSON.stringify({ message: 'fixture 拒绝' }), {
            status: opts.streamStatus,
            headers: { 'content-type': opts.streamText ? 'text/plain; charset=utf-8' : 'application/json' },
          });
        }
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            controller = c;
            if (!opts.silent) c.enqueue(enc.encode('data: {"kind":"ready"}\n\n'));
            if (!opts.hold) c.close();
          },
        });
        return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }
      return jsonReply({ message: `流式夹具没有 ${input.method} ${path}` }, 404);
    }) as unknown as typeof fetch,
  );
  u.authenticate('TK-fixture');
  return {
    u,
    calls,
    get aborts() {
      return aborts;
    },
    push,
    close: () => {
      controller?.close();
      controller = null;
    },
    agreed: gates.consentRequired === false && gates.mustChangePassword === false,
    setGates(next) {
      Object.assign(gates, next);
    },
  };
}

const jsonReply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** 等生成客户端把已入队的帧读出来并交给监听者（reader → for-await → 监听者，至少两轮微任务加一次读）。 */
async function settle(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}

/** 让 demo 服务端真过第二道闸：先读一次门禁状态。 */
async function pastTheGate(f: SseFixture): Promise<void> {
  const r = await hit(f.u, 'GET', '/gate/state');
  expect(r.json).toMatchObject({ step: 'app' });
}

const hit = async (u: Upstream, method: string, path: string, body?: unknown) => {
  const { cap, done } = sendRequest(u, ROUTES, method, path, body);
  await done;
  const text = cap.body;
  return {
    status: cap.status ?? 0,
    json: text && text.startsWith('{') ? JSON.parse(text) : undefined,
    text,
    cap,
    headers: cap.headers,
  };
};

/** 走 GET /events 并等处理器接管收发端（流不自动关 ⇒ 只能靠 sendRequest 拿住 cap）。 */
async function open(f: SseFixture, topic: StreamTopic | null, extra = '') {
  const path = '/events' + (topic === null ? extra : `?topic=${topic}${extra}`);
  const s = sendRequest(f.u, ROUTES, 'GET', path);
  await s.done;
  return s;
}

describe('SSE 代理 (L2)', () => {
  it('两种订阅共用一条上游，归零才 abort，且 abort 只发生一次', async () => {
    const f = sseUpstream({ hold: true });
    await pastTheGate(f);
    const got: unknown[] = [];
    const r1 = acquireStream('state', (x) => got.push(x), f.u);
    const r2 = acquireStream('state', (x) => got.push(x), f.u);
    await settle();
    expect(f.calls.filter((c) => c.url === '/api/state/stream')).toHaveLength(1);
    expect(got).toEqual([
      { kind: 'ready' },
      { kind: 'ready' },
    ]); // 一帧上游 ⇒ 两个监听者各收到一次，而不是只给第一个
    r1();
    await settle();
    expect(f.aborts).toBe(0); // 还剩一个引用，不许断
    r2();
    await settle();
    expect(f.aborts).toBe(1);
    expect(f.calls.filter((c) => c.url === '/api/state/stream')).toHaveLength(1);
  });

  it('归零之后再订阅 ⇒ 重开一条上游，不复用已 abort 的尸体', async () => {
    const f = sseUpstream({ hold: true });
    await pastTheGate(f);
    const first = acquireStream('state', () => {}, f.u);
    await settle(); // 先让第一枪真的出网，否则 release 发生在 Request 建出来之前，abort 没对象可断
    expect(f.calls.filter((c) => c.url === '/api/state/stream')).toHaveLength(1);
    first();
    await settle();
    expect(f.aborts).toBe(1);
    const keep = acquireStream('state', () => {}, f.u);
    await settle();
    expect(f.calls.filter((c) => c.url === '/api/state/stream')).toHaveLength(2);
    keep();
    await settle();
  });

  it('三条 GET 流各打各的端点：topic 抄错就会红，而不是三条都读 state', async () => {
    const f = sseUpstream();
    await pastTheGate(f);
    for (const [topic, url] of [
      ['state', '/api/state/stream'],
      ['logs', '/api/logs/stream'],
      ['debug', '/api/debug/stream'],
    ] as const) {
      const before = f.calls.length;
      const s = await open(f, topic);
      await settle();
      expect(f.calls.slice(before).map((c) => c.url)).toEqual([url]);
      s.cap.res.end();
    }
  });

  it('快照帧逐字转发：一帧一段 data:…\\n\\n，不增键不减键、不补 event: 字段', async () => {
    const f = sseUpstream({ hold: true });
    await pastTheGate(f);
    const s = await open(f, 'state');
    await settle();
    f.push({ resource: 'qq-list', data: [{ uin: '10001', nickname: '夹具' }] });
    await settle();
    expect(s.cap.headers['content-type']).toBe('text/event-stream');
    const wire = s.cap.body ?? '';
    expect(wire).toContain('data: {"resource":"qq-list","data":[{"uin":"10001","nickname":"夹具"}]}\n\n');
    expect(wire).not.toContain('event:');
    expect(wire).not.toContain('"data":{"data"'); // 没被 unwrap 折成双层
    s.cap.res.end();
  });

  it('浏览器断开就释放引用：close 之后归零 ⇒ 上游 abort，不留悬挂 SSE', async () => {
    const f = sseUpstream({ hold: true });
    await pastTheGate(f);
    const s = await open(f, 'state');
    await settle();
    expect(f.aborts).toBe(0);
    s.fireRes('close');
    await settle();
    expect(f.aborts).toBe(1);
  });

  it('两条浏览器连接共用一条上游：其中一条走了只给留下的那条推帧（放引用=摘监听，不是加旗子）', async () => {
    const f = sseUpstream({ hold: true });
    await pastTheGate(f);
    const a = await open(f, 'state');
    const b = await open(f, 'state');
    await settle();
    expect(f.calls.filter((c2) => c2.url === '/api/state/stream')).toHaveLength(1); // 两条连接一枪上游
    const beforeA = (a.cap.body ?? '').length;
    a.fireRes('close');
    await settle();
    expect(f.aborts).toBe(0); // 还剩 b 一个引用，不许断上游
    const beforeB = (b.cap.body ?? '').length;
    f.push({ resource: 'connections', data: [] });
    await settle();
    expect((b.cap.body ?? '').length).toBeGreaterThan(beforeB); // b 收得到
    expect((a.cap.body ?? '').length).toBe(beforeA); // a 走了就再也收不到
    b.fireRes('close');
    await settle();
    expect(f.aborts).toBe(1);
  });

  it('上游流上的 401 ⇒ 只交回 kind:session-expired 一帧，会话作废、连接结束、不重试', async () => {
    const f = sseUpstream({ streamStatus: 401, streamText: JSON.stringify({ message: 'Token expired or invalid' }) });
    await pastTheGate(f);
    const s = await open(f, 'state');
    await settle();
    expect(s.cap.body).toContain('"kind":"session-expired"');
    expect(s.cap.ended).toBe(true);
    expect(f.u.token).toBeNull(); // 服务端手里的会话确实作废了，下一枪由总闸挡回登录屏
    expect(f.calls.filter((c) => c.url === '/api/state/stream')).toHaveLength(1);
  });

  it('认 401 靠的是状态码而不是那句原文：措辞换了也照样折成 session-expired', async () => {
    // 钉住 serverSentEvents.gen.ts:135 那句 `SSE failed: <status> …` 的**可读性**：
    // 重新生成若把措辞改掉，这条必须红，而不是让流的 401 静默退化成"普通错误"。
    const f = sseUpstream({ streamStatus: 401, streamText: '完全不是那句话' });
    await pastTheGate(f);
    const s = await open(f, 'state');
    await settle();
    expect(s.cap.body).toContain('"kind":"session-expired"');
  });

  it('非 401 的上游失败不冒充会话死了：503 文本体 ⇒ kind:stream-error 并说清是哪条 topic', async () => {
    const f = sseUpstream({ streamStatus: 503, streamText: 'state stream not configured' });
    await pastTheGate(f);
    const s = await open(f, 'state');
    await settle();
    expect(s.cap.body).toContain('"kind":"stream-error"');
    expect(s.cap.body).toContain('state');
    expect(s.cap.body).not.toContain('session-expired');
    expect(s.cap.ended).toBe(true);
    expect(f.u.token).toBe('TK-fixture'); // 没被误杀
  });

  it('未知或缺省 topic ⇒ 400 且一次都不出网（悄悄默认 state 等于把打错的参数读成另一条资源）', async () => {
    const f = sseUpstream();
    await pastTheGate(f);
    expect(f.calls.filter((c) => /\/stream$/.test(c.url))).toHaveLength(0); // 上面读闸没打流端点
    const cases: Array<[string, RegExp]> = [
      ['/events?topic=nope', /未知 topic/],
      ['/events', /需要 topic/],
      ['/events?topic=action', /未知 topic/],
    ];
    for (const [path, want] of cases) {
      const r = await hit(f.u, 'GET', path);
      expect(r.status, path).toBe(400);
      expect(r.json.message, path).toMatch(want);
      expect(r.headers['content-type'], path).toContain('application/json');
      expect(r.cap.ended, path).toBe(true); // 是先回 400，不是写成 SSE 再报错
    }
    expect(f.calls.filter((c) => /\/stream$/.test(c.url))).toHaveLength(0);
  });

  it('门禁没过 ⇒ 回门禁那一屏而不是半开的 SSE：收发端没被写成 text/event-stream', async () => {
    const f = sseUpstream({ hold: true });
    f.setGates({ consentRequired: true });
    const blocked = await hit(f.u, 'GET', '/gate/state');
    expect(blocked.json).toMatchObject({ step: 'consent' });
    const r = await hit(f.u, 'GET', '/events?topic=state');
    expect(r.status).toBe(403);
    expect(r.json).toMatchObject({ step: 'consent' });
    expect(r.text).not.toContain('data:'); // 收发端压根没被写成 SSE 帧
    expect(r.headers['content-type']).toContain('application/json');
    expect(f.calls.filter((c) => /\/stream$/.test(c.url))).toHaveLength(0);
  });

  it('action 那一支是 POST 且带体：本地核 uin/action/params 不过就 400 且零出网', async () => {
    const f = sseUpstream({ hold: true });
    await pastTheGate(f);
    const bad: Array<[string, unknown]> = [
      ['uin 不是 5-10 位数字', { uin: 'abc', action: 'get_group_list' }],
      ['缺 action', { uin: '10001' }],
      ['action 是空串（"给了"不等于"给了有用的"）', { uin: '10001', action: '' }],
      ['params 是数组', { uin: '10001', action: 'x', params: [1] }],
    ];
    const wants = [/需要 uin/, /需要 action/, /需要 action/, /params 给了就必须是/];
    for (const i of bad.keys()) {
      const [label, body] = bad[i];
      const want = wants[i];
      const r = await hit(f.u, 'POST', '/events/action', body);
      expect(r.status, label).toBe(400);
      expect(r.json.message, label).toMatch(want);
      expect(r.headers['content-type'], label).toContain('application/json');
    }
    expect(f.calls.filter((c) => c.url === '/api/debug/invoke-stream')).toHaveLength(0);
  });

  it('action 合法 ⇒ POST 到 /api/debug/invoke-stream，请求体只有给了的键；每枪一条订阅不共用', async () => {
    const f = sseUpstream({ hold: true });
    await pastTheGate(f);
    const a = sendRequest(f.u, ROUTES, 'POST', '/events/action', { uin: '10001', action: 'stream_events' });
    await a.done;
    const b = sendRequest(f.u, ROUTES, 'POST', '/events/action', {
      uin: '10002',
      action: 'get_group_list',
      params: { timeout: 3000 },
    });
    await b.done;
    await settle();
    const sent = f.calls.filter((c) => c.url === '/api/debug/invoke-stream');
    expect(sent).toHaveLength(2); // 一枪一枪：引用计数在这里没有共用对象
    expect(sent[0].method).toBe('POST');
    expect(JSON.parse(sent[0].body)).toEqual({ uin: '10001', action: 'stream_events' });
    expect(JSON.parse(sent[1].body)).toEqual({ uin: '10002', action: 'get_group_list', params: { timeout: 3000 } });
    expect(a.cap.body).toContain('"kind":"ready"');
  });

  it('上游正常读完（流关闭）⇒ 连接结束而不是永远挂着，且不写错误帧', async () => {
    const f = sseUpstream(); // 不 hold：ready 之后立即 close
    await pastTheGate(f);
    const s = await open(f, 'logs');
    await settle();
    expect(s.cap.body).toContain('"kind":"ready"');
    expect(s.cap.body).not.toContain('stream-error');
    expect(s.cap.ended).toBe(true);
  });
});

/**
 * 这一组只在 `silent` 夹具下成立，而其余 1200 行的流用例都从"连上立刻有一帧"出发 ——
 * 那个形状恰好把两条失效都遮住了：响应头没上线（浏览器那侧 fetch 永远不 resolve，
 * 6097 上真挂住过的那条就是它），以及空闲连接再无字节（客户端 2×15s 判死重拨，风暴不停）。
 */
describe('空闲连接也要能自证活着 (L2)', () => {
  it('一帧都没有时，响应头仍然先上线', async () => {
    const f = sseUpstream({ hold: true, silent: true });
    await pastTheGate(f);
    const s = await open(f, 'state');
    await settle();
    expect(s.cap.status).toBe(200);
    expect(s.cap.headFlushed, 'attach 里少了 flushHeaders：只 writeHead 的话 Node 不会把头发给客户端').toBe(true);
    expect(s.cap.body ?? '', '把头上线做成"编一帧数据"是另一回事').toBe('');
    s.fireRes('close');
  });

  it('空闲满一个周期出注释帧，且不会被当成数据帧', async () => {
    const f = sseUpstream({ hold: true, silent: true });
    await pastTheGate(f);
    vi.useFakeTimers();
    try {
      const s = await open(f, 'state');
      await vi.advanceTimersByTimeAsync(21000);
      expect(s.cap.body).toBe(': ping\n\n: ping\n\n');
      expect(s.cap.body).not.toContain('data:');
      s.fireRes('close');
    } finally {
      vi.useRealTimers();
    }
  });

  it('客人走了保活定时器一起停，上游订阅同时 abort', async () => {
    const f = sseUpstream({ hold: true, silent: true });
    await pastTheGate(f);
    vi.useFakeTimers();
    let s;
    try {
      // 断的是"漏一个 interval"，不是"多写几个字节"：写帧那条路有 `if (ended) return` 兜着，
      // 不 clearInterval 也只会在计数上现形 —— 而挂着不走的事件循环才是这里真正的代价。
      const base = vi.getTimerCount();
      s = await open(f, 'state');
      expect(vi.getTimerCount(), '连接建立 ⇒ 恰好多一个保活 interval').toBe(base + 1);
      await vi.advanceTimersByTimeAsync(10000);
      expect(s.cap.body).toBe(': ping\n\n');
      s.fireRes('close');
      expect(vi.getTimerCount(), 'close 之后 interval 还在 ⇒ 每条走掉的连接漏一个定时器').toBe(base);
    } finally {
      vi.useRealTimers();
    }
    await settle();
    expect(f.aborts).toBe(1);
  });
});
