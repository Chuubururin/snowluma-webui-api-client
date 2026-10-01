// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
/**
 * SSE 代理（设计口径）：浏览器不直连实例的流端点，demo 服务端每种 topic 只开**一条**上游订阅，
 * 按浏览器连接数引用计数；归零即 abort，不留悬挂 SSE。
 *
 * 为什么浏览器那一侧不用 `EventSource`（demo 自己并不需要 bearer，所以这不是凭据问题）：
 *  1. `action` 那一支是 POST 且带体，`EventSource` 只有 GET；
 *  2. 它自带重连，会跟这里"一枪不重拨"的策略打架 —— 会话死了还照着 retry 无限重拨，
 *     等于对着自己的登录屏 DoS。重拨的每一次都由 `demo/client/state.ts` 决定。
 * 上游那侧 `EventSource` 带不了 bearer 是同一族约束（spec 对流端点的那条注），但那是实例的事。
 *
 * 三条刻意的"不"：
 *  1. **不经 `unwrap`**：流操作 resolve 成 `{stream}`，而 `unwrap` 只认 `{data}`/`{error}`，折它会把一条
 *     正常的流当成"上游没给数据"误抛。
 *  2. **不改帧**：上游帧的负载自己带 tag 键（`kind` 或 `resource`，见 spec 的 `x-snowluma-sse.tagFields`），
 *     demo 只在失败时补自己的三种控制帧，成功帧原样 `data: <json>\n\n` 转出去。
 *  3. **不重连**：`sseMaxRetryAttempts: 1`。重连属于浏览器那一层（设计口径的三层模型），放在服务端
 *     就成了已关面板的幽灵订阅对着实例无限重拨。
 */
import * as sdk from '../../../generated/typescript/sdk.gen.js';
import { gateGuard } from './gates.js';
import { fail, type ApiResult, type Ctx, type RouteTable } from '../http.js';
import { checkInvoke } from './debug.js';
import type { Upstream } from '../upstream.js';

/** 三条可共用的 GET 流。`action` 不在这里：它是 POST 且带体，做成 `?topic=action` 等于让一个 GET 改业务状态。 */
export type StreamTopic = 'state' | 'logs' | 'debug';
export const STREAM_TOPICS: readonly StreamTopic[] = ['state', 'logs', 'debug'];

type Frame = Record<string, unknown>;
type Listener = { frame: (f: Frame) => void; end: () => void };
interface Sub {
  listeners: Set<Listener>;
  controller: AbortController;
  closed: boolean;
}

type Opener = (
  u: Upstream,
  signal: AbortSignal,
  onError: (e: unknown) => void,
) => Promise<{ stream: AsyncGenerator<unknown> }>;

const OPENERS: Record<StreamTopic, Opener> = {
  state: (u, signal, onError) =>
    sdk.streamState({ client: u.client, signal, sseMaxRetryAttempts: 1, onSseError: onError }),
  logs: (u, signal, onError) =>
    sdk.streamLogs({ client: u.client, signal, sseMaxRetryAttempts: 1, onSseError: onError }),
  debug: (u, signal, onError) =>
    sdk.streamDebugEvents({ client: u.client, signal, sseMaxRetryAttempts: 1, onSseError: onError }),
};

/** 订阅表按 Upstream 实例存：并跑多台夹具时计数不许串。注意 setBaseUrl 原地改同一对象，不产生新键。 */
const subsByUpstream = new WeakMap<Upstream, Map<string, Sub>>();

let actionSeq = 0;

/**
 * 生成客户端在 SSE 分支上抛的是 `Error('SSE failed: <status> <statusText>')`
 * （`generated/typescript/core/serverSentEvents.gen.ts:135`），不是 `UpstreamError` —— 状态码只能从这句话里读。
 * 只认前缀与三位码、不认后面的措辞：重新生成改了 statusText 也不该让 401 退化成普通错误。
 */
function sseStatus(e: unknown): number | null {
  const m = /^SSE failed:\s*(\d{3})\b/.exec(String((e as Error)?.message ?? e));
  return m ? Number(m[1]) : null;
}

function notify(sub: Sub, f: Frame): void {
  for (const l of [...sub.listeners]) {
    try {
      l.frame(f);
    } catch {
      // 单个浏览器连接写挂了，不该把整条上游订阅带崩
    }
  }
}

function closeSub(map: Map<string, Sub>, key: string, sub: Sub, terminal: Frame | null): void {
  if (sub.closed) return;
  sub.closed = true;
  map.delete(key);
  if (terminal) notify(sub, terminal);
  for (const l of [...sub.listeners]) {
    try {
      l.end();
    } catch {
      // 同上
    }
  }
  sub.listeners.clear();
  if (!sub.controller.signal.aborted) sub.controller.abort();
}

function subscribe(key: string, opener: Opener, u: Upstream, listener: Listener): () => void {
  let map = subsByUpstream.get(u);
  if (!map) {
    map = new Map();
    subsByUpstream.set(u, map);
  }
  let sub = map.get(key);
  if (!sub || sub.closed) {
    const owned: Sub = { listeners: new Set(), controller: new AbortController(), closed: false };
    sub = owned;
    map.set(key, owned);
    let failure: unknown = null;
    void (async () => {
      const topicName = key.split(':')[0];
      const failWith = (e: unknown) => {
        const status = sseStatus(e);
        if (status === 401) {
          // 只作废会话，不另外 clearGateState：token 一空，总闸就先挡在 handler 之前，
          // 而重新登录走 `stateResult → readGates`，它第一行就 `gateStates.delete(u)` —— 多清一次是装饰。
          u.signOut();
          closeSub(map, key, owned, { kind: 'session-expired', message: '上游判死了当前会话' });
          return;
        }
        closeSub(map, key, owned, {
          kind: 'stream-error',
          topic: topicName,
          ...(status === null ? {} : { status }),
          message: `上游的 ${topicName} 流没能建立：${String((e as Error)?.message ?? e)}`,
        });
      };
      try {
        const res = await opener(u, owned.controller.signal, (e) => {
          failure = e;
        });
        for await (const raw of res.stream) {
          if (owned.closed || owned.controller.signal.aborted) break;
          notify(owned, (raw ?? {}) as Frame);
        }
        // 关键一条：生成客户端**不把流上的失败抛给消费者**。`createSseClient` 的 catch 只调
        // `onSseError` 然后 break（`serverSentEvents.gen.ts:224-236`），于是"连不上 401"与
        // "上游正常读完关闭"在 for-await 上完全同形 —— 只靠 try/catch 会把会话死了报成一切正常。
        if (owned.closed) return;
        if (failure !== null) failWith(failure);
        else closeSub(map, key, owned, null);
      } catch (e) {
        if (owned.closed) return; // 我们自己 abort 造成的 AbortError 不是上游的错误
        failWith(e);
      }
    })();
  }
  const owned = sub;
  owned.listeners.add(listener);
  return () => {
    owned.listeners.delete(listener);
    if (owned.listeners.size === 0 && !owned.closed) {
      closeSub(subsByUpstream.get(u) ?? new Map(), key, owned, null);
    }
  };
}

/**
 * 引用计数订阅（计划的 Produces 契约）。返回释放函数；最后一个引用释放即 abort 上游。
 * `onEnd` 是可选第四参：连接该在"流结束/流失败"时收尾，而不是让监听者自己猜哪一帧是末帧。
 */
export function acquireStream(
  topic: StreamTopic,
  onFrame: (f: Frame) => void,
  u: Upstream,
  onEnd: () => void = () => {},
): () => void {
  return subscribe(topic, OPENERS[topic], u, { frame: onFrame, end: onEnd });
}

/** 一枪一条订阅：invoke-stream 每次的 body 都不同，没有共用对象可言。 */
function acquireAction(
  u: Upstream,
  body: { uin: string; action: string; params?: Record<string, unknown> },
  onFrame: (f: Frame) => void, onEnd: () => void): () => void {
  const key = `action:${++actionSeq}`;
  return subscribe(
    key,
    (up, signal, onError) =>
      sdk.streamDebugAction({ client: up.client, signal, body, sseMaxRetryAttempts: 1, onSseError: onError }),
    u,
    { frame: onFrame, end: onEnd },
  );
}

/** 帧编码沿上游那一段模板：`data: <json>\n\n`，没有 `event:` 字段。 */
const encode = (f: Frame): string => `data: ${JSON.stringify(f)}\n\n`;

/**
 * 空闲连接的保活间隔。为什么 demo 必须自己发：
 *  1. demo 到上游的订阅按 topic 共用、且**不向晚加入者回放**（`subscribe` 只 `listeners.add`），
 *     所以第二条浏览器连接可能在一个完全健康的订阅上等很久都等不到一帧；
 *  2. 上游那份 15s 保活是注释帧（`sse-response.ts:62` 的 `: heartbeat`），而生成客户端只认
 *     `data:`/`event:`/`id:`/`retry:` 四种行、注释行直接丢掉
 *     （`serverSentEvents.gen.ts` 的解析分支）—— 上游的保活既进不了这里的监听者，更转不出 demo。
 * 于是"连接活着但这一路没帧"在浏览器那侧与"连接死了"同形：客户端 `state.ts:172-178` 攒够
 * 2×15s 无字节就判死重拨，空闲实例上变成每 30 秒一场的重拨风暴。10s 取在判死窗口之内。
 */
const KEEPALIVE_MS = 10000;

/** 注释帧：`blockPayload` 对无 `data:` 行的块返回 null（`state.ts:81-88`），所以它复位看门狗而不进 onFrame。 */
const PING = ': ping\n\n';

/**
 * 写头 + 接线 + 断开释放。两条路由只差"开哪一条订阅"，其余必须同进同出。
 */
function attach(ctx: Ctx, open: (frame: (f: Frame) => void, end: () => void) => () => void): ApiResult | null {
  const res = ctx.raw.res;
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  // `writeHead` 只把进程内的 `headersSent` 置真，响应头要等第一次 `write` 才上线（Node 实测：光
  // writeHead 的响应，客户端 1.5s 内连头都拿不到）。浏览器那侧读的是 fetch（`state.ts:159`），
  // 头不落地 promise 就永远不 resolve —— 而晚加入共用订阅的连接正是"先有一段时间没帧"。
  res.flushHeaders();
  let ended = false;
  let release = () => {};
  const beat = setInterval(() => {
    if (ended) return;
    try {
      res.write(PING);
    } catch {
      ended = true;
      clearInterval(beat);
      release();
    }
  }, KEEPALIVE_MS);
  const stopBeat = () => clearInterval(beat);
  release = open(
    (f) => {
      if (ended) return;
      try {
        res.write(encode(f));
      } catch {
        ended = true;
        stopBeat();
        release();
      }
    },
    () => {
      if (ended) return;
      ended = true;
      stopBeat();
      res.end();
    },
  );
  res.on('close', () => {
    // 断连认 res，不认 req：`readCtx` 用 `for await` 读完请求体的那一刻，IncomingMessage 已被
    // autoDestroy 销毁并抛过 close（真 Node 实测：客户端真断开时只有 res 响），在这里挂 req 的
    // close 等于挂一个永远不会响的监听器 —— 引用计数归零那条路就这样静默失效过。
    ended = true;
    stopBeat();
    release();
  });
  return null; // 收发端已接管，装配层不许再 end
}

export const streamRoutes: RouteTable = {
  'GET /events': async (ctx, u) => {
    const rejected = gateGuard(u);
    if (rejected) return rejected;
    const raw = ctx.query.get('topic');
    if (!raw) return fail(400, '需要 topic（state | logs | debug）：缺省就默认一条流，等于把打错的参数读成另一份资源');
    if (!(STREAM_TOPICS as readonly string[]).includes(raw)) {
      return fail(400, `未知 topic：${raw}（可用：${STREAM_TOPICS.join(' | ')}）`);
    }
    const topic = raw as StreamTopic;
    return attach(ctx, (frame, end) => acquireStream(topic, frame, u, end));
  },

  'POST /events/action': async (ctx, u) => {
    const rejected = gateGuard(u);
    if (rejected) return rejected;
    const checked = checkInvoke(ctx.json);
    if (!checked.ok) return fail(400, checked.message);
    return attach(ctx, (frame, end) => acquireAction(u, checked.body, frame, end));
  },
};
