// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
// @vitest-environment happy-dom
/**
 * L3：浏览器侧的流状态机（设计口径的三层）。
 *
 * 这一层专门钉 L2 够不着的三件事：
 *  · **帧分派读的是负载内部的标签**。线上没有 `event:` 字段，而负载上有**两个** tag 键
 *    （spec `x-snowluma-sse.tagFields: [kind, resource]`）：控制帧走 `kind`（ready/dropped），
 *    快照帧走 `resource`。按 `event:` 分派的实现在这里必须红。
 *  · **`dropped` 不是一句提示，是一次动作**：它意味着慢客户端丢了帧，此后收到的每一帧都可能不是全量
 *    ⇒ 三份资源一次性走 REST 重取（`reconcileResource`）。把 dropped 画成"丢了几帧"就完了，
 *    等于让界面长期停在一份残缺快照上。
 *  · **心跳只在有锚点的那条流上判健康**。spec 只给 `/api/state/stream` 记了 `heartbeatMs: 15000`
 *    （`sse-response.ts:62`）；logs/debug/invoke-stream 没有这个数字 ⇒ 不许套同一个 15s 一刀切，
 *    更不许拿它当"这三条也是 15s"的证据。
 *
 * 会话死了只认一种信号：服务端把流上的 401 折成 `{kind:'session-expired'}`，浏览器据此停重连、
 * 交回门禁（重连一条注定 401 的流是自我 DoS）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HEARTBEAT_MS,
  formatFrame,
  openStream,
  planReconcile,
  reconcileResource,
  slowReconcileMs,
  startSlowReconcile,
} from '../demo/client/state.js';

function flush(times = 6): Promise<void> {
  return (async () => {
    for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
  })();
}

/** 一条永不结束的 SSE：测试自己 push 帧，模拟"连着但没动静"与"推了一帧"两种时间线。 */
function holdStream() {
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const enc = new TextEncoder();
  const res = new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
  return {
    res,
    push(text: string) {
      controller?.enqueue(enc.encode(text));
    },
    end() {
      controller?.close();
      controller = null;
    },
  };
}

describe('帧分派（读负载标签，线上没有 event:）', () => {
  it('ready / dropped 走 kind，快照走 resource 且折成 kind:snapshot', () => {
    expect(formatFrame('data: {"kind":"ready"}')).toMatchObject({ kind: 'ready' });
    expect(formatFrame('data: {"kind":"dropped","count":7}')).toMatchObject({ kind: 'dropped', count: 7 });
    expect(formatFrame('data: {"resource":"qq-list","data":[]}')).toMatchObject({
      kind: 'snapshot',
      resource: 'qq-list',
      data: [],
    });
  });
  it('空行与心跳注释不是帧：返回 null，不进状态机', () => {
    expect(formatFrame('')).toBeNull();
    expect(formatFrame(': ping')).toBeNull();
    expect(formatFrame('event: whatever')).toBeNull();
  });
  it('id: / retry: 控制行不是负载：返回 null，不进状态机（判据在行首，不深扫负载）', () => {
    expect(formatFrame('id: 3')).toBeNull();
    expect(formatFrame('retry: 5000')).toBeNull();
    // 负载**内部**带 id/retry 键不受影响：控制行判据只看这一行以什么开头
    expect(formatFrame('data: {"id":3,"retry":5000}')).not.toBeNull();
  });
  it('data: 后面是标量 ⇒ unlabeled 并保留原文：不是对象就进不了标签分派，但不许静默丢帧', () => {
    expect(formatFrame('data: 42')).toEqual({ kind: 'unlabeled', raw: '42' });
  });
  it('data: 后面没有 JSON ⇒ 明写 unparsable，不静默丢帧', () => {
    expect(formatFrame('data: not-json')).toMatchObject({ kind: 'unparsable', raw: 'not-json' });
  });
  it('两个 tag 键都没有的帧 ⇒ unlabeled，界面要显示原文而不是当 ready 用', () => {
    expect(formatFrame('data: {"foo":1}')).toMatchObject({ kind: 'unlabeled' });
  });
  it('logs 那条流的两种帧在适配层收窄：{type:ready} 是就绪，齐了 time/level/message 的是日志条目', () => {
    expect(formatFrame('data: {"type":"ready"}')).toMatchObject({ kind: 'ready' });
    expect(formatFrame('data: {"id":3,"time":"09:11","level":"warn","scope":"app","message":"m","line":"l"}')).toMatchObject(
      { kind: 'entry' },
    );
    // 只带其中两个键不算条目：条目判据是 spec 的必填键集，不是"看起来像"
    expect(formatFrame('data: {"time":"t","level":"info"}')).toMatchObject({ kind: 'unlabeled' });
  });
});

describe('对账计划', () => {
  it('dropped 触发三份资源一次性对账', () => {
    expect(planReconcile(formatFrame('data: {"kind":"dropped","count":7}')!)).toEqual(reconcileResource);
    expect(reconcileResource).toEqual(['processes', 'qq-list', 'connections']);
  });
  it('单份快照只更新那一份，不引发全量 REST', () => {
    expect(planReconcile(formatFrame('data: {"resource":"processes","data":[]}')!)).toEqual([]);
  });
  it('ready 与失败帧都不触发对账（触发了就是把首屏当丢帧补）', () => {
    expect(planReconcile(formatFrame('data: {"kind":"ready"}')!)).toEqual([]);
    expect(planReconcile(formatFrame('data: {"kind":"stream-error","message":"x"}')!)).toEqual([]);
  });
});

describe('慢对账周期', () => {
  it('max(pollInterval×10, 10s)，且缺键/非正数落回 5000×10', () => {
    expect(slowReconcileMs(2000)).toBe(20000);
    expect(slowReconcileMs(900)).toBe(10000); // 9×10=9000 但地板是 10s
    expect(slowReconcileMs(undefined)).toBe(50000);
    expect(slowReconcileMs(0)).toBe(50000);
  });
  it('document.hidden 时跳过这一枪，回到前台立刻补一次', () => {
    vi.useFakeTimers();
    try {
      const tick = vi.fn();
      const setHidden = (v: boolean) => Object.defineProperty(document, 'hidden', { value: v, configurable: true });
      setHidden(true);
      const stop = startSlowReconcile(1000, tick);
      vi.advanceTimersByTime(3500);
      expect(tick).not.toHaveBeenCalled();
      setHidden(false);
      vi.advanceTimersByTime(1000);
      expect(tick.mock.calls.length).toBeGreaterThanOrEqual(1);
      stop();
      const n = tick.mock.calls.length;
      vi.advanceTimersByTime(3500);
      expect(tick).toHaveBeenCalledTimes(n);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('心跳策略', () => {
  it('只有 state 有锚着的心跳，其余为 null（不套同一个 15s 一刀切）', () => {
    expect(HEARTBEAT_MS.state).toBe(15000);
    expect(HEARTBEAT_MS.logs).toBeNull();
    expect(HEARTBEAT_MS.debug).toBeNull();
    expect(HEARTBEAT_MS.action).toBeNull();
  });
});

describe('openStream：fetch + reader（EventSource 带不了 POST 体，也不许对死会话重拨）', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('GET 面打 /events?topic=…，帧一到就交给 onFrame', async () => {
    const h = holdStream();
    const seen: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: string) => {
        seen.push(String(path));
        return h.res;
      }),
    );
    const got: any[] = [];
    const handle = openStream('state', { onFrame: (f) => got.push(f) });
    await flush();
    expect(seen).toEqual(['/events?topic=state']);
    h.push('data: {"resource":"qq-list","data":[{"uin":"10001"}]}\n\n');
    await flush();
    expect(got).toEqual([{ kind: 'snapshot', resource: 'qq-list', data: [{ uin: '10001' }] }]);
    handle.close();
  });

  it('跨 chunk 的半帧不丢：一帧分两段也要拼回来', async () => {
    const h = holdStream();
    vi.stubGlobal('fetch', vi.fn(async () => h.res));
    const got: any[] = [];
    const handle = openStream('logs', { onFrame: (f) => got.push(f) });
    await flush();
    h.push('data: {"note":"sp');
    await flush();
    expect(got).toEqual([]); // 没有双 \\n\\n ⇒ 还不是完整帧，也不许把半截当垃圾吞掉
    h.push('lit"}\n\n');
    await flush();
    expect(got).toEqual([{ kind: 'unlabeled', raw: '{"note":"split"}' }]);
    handle.close();
  });

  it('多行 data: 块按 SSE 规范拼成单 payload 再分派，不是只读第一行', async () => {
    const h = holdStream();
    vi.stubGlobal('fetch', vi.fn(async () => h.res));
    const got: any[] = [];
    const handle = openStream('state', { onFrame: (f) => got.push(f) });
    await flush();
    h.push('data: {"note":\ndata: "两行拼一帧"}\n\n');
    await flush();
    // 两个 data: 行以 \n 相接后才是可解析的 JSON ⇒ 拼接发生在 classify 之前
    expect(got).toEqual([{ kind: 'unlabeled', raw: '{"note":\n"两行拼一帧"}' }]);
    handle.close();
  });

  it('session-expired ⇒ 停重连、交回门禁，且一条都不再出网', async () => {
    const h = holdStream();
    const fetches = vi.fn(async () => h.res);
    vi.stubGlobal('fetch', fetches);
    const expired = vi.fn();
    const handle = openStream('state', { onFrame: () => {}, onSessionExpired: expired }, { retryMs: 5 });
    try {
      await flush();
      h.push('data: {"kind":"session-expired","message":"上游判死了当前会话"}\n\n');
      // 服务端发完这一帧就收掉这条 SSE（`streams.ts` 的 `closeSub` ⇒ `end()`）：
      // 只有对面真的断了，"不许重拨"才有地方显形 —— 挂着的流上读不到第二次拨号，撤掉 return 照样全绿。
      h.end();
      await flush();
      expect(expired).toHaveBeenCalledTimes(1);
      await flush(20);
      expect(fetches).toHaveBeenCalledTimes(1);
    } finally {
      // 断言失败也要收口：失控的重拨循环会带着这条用例的 stub 转进下一条用例，把红溅到无关的人身上
      handle.close();
    }
    await flush();
    expect(fetches).toHaveBeenCalledTimes(1); // close 之后也不许有第二次
  });

  it('连接被对面正常结束 ⇒ 按退避重拨一次；close() 之后彻底停', async () => {
    const a = holdStream();
    const b = holdStream();
    const fetches = vi.fn(async () => (fetches.mock.calls.length === 1 ? a.res : b.res));
    vi.stubGlobal('fetch', fetches);
    const status: string[] = [];
    const handle = openStream('debug', { onFrame: () => {}, onStatus: (s) => status.push(s) }, { retryMs: 5 });
    await flush();
    expect(fetches).toHaveBeenCalledTimes(1);
    a.end();
    await flush(20);
    expect(fetches).toHaveBeenCalledTimes(2);
    expect(status).toContain('reconnecting');
    handle.close();
    b.end();
    await flush(20);
    expect(fetches).toHaveBeenCalledTimes(2);
  });

  it('action 面是 POST 且带体（GET 那条改不了业务状态，也不该被预取）', async () => {
    const h = holdStream();
    const calls: Array<{ url: string; init: any }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: any) => {
        calls.push({ url: String(url), init });
        return h.res;
      }),
    );
    const handle = openStream('action', { onFrame: () => {} }, { body: { uin: '10001', action: 'stream_events' } });
    await flush();
    expect(calls[0].url).toBe('/events/action');
    expect(String(calls[0].init?.method).toUpperCase()).toBe('POST');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ uin: '10001', action: 'stream_events' });
    handle.close();
  });

  it('有锚点的那条流超时没动静 ⇒ 自己重拨；没有锚点的流不许凭 15s 判死', async () => {
    const h = holdStream();
    const fetches = vi.fn(async () => h.res);
    vi.stubGlobal('fetch', fetches);
    const handle = openStream('state', { onFrame: () => {} }, { retryMs: 5, heartbeatMs: 20 });
    await new Promise((r) => setTimeout(r, 120));
    expect(fetches.mock.calls.length).toBeGreaterThan(1);
    handle.close();

    const h2 = holdStream();
    const fetches2 = vi.fn(async () => h2.res);
    vi.stubGlobal('fetch', fetches2);
    const h3 = openStream('logs', { onFrame: () => {} }, { retryMs: 5, heartbeatMs: 20 });
    await new Promise((r) => setTimeout(r, 80));
    // 默认表里 logs 是 null ⇒ 传进来的心跳**造不出**这条流没有的锚点：不许凭一个数字判死它
    expect(fetches2).toHaveBeenCalledTimes(1);
    h3.close();
  });

  it('读流过程本身抛错（网络断）⇒ 报 error 状态并按退避重拨，不把界面停在"等待推送"上', async () => {
    let first = true;
    const fetches = vi.fn(async () => {
      if (first) {
        first = false;
        throw new TypeError('network down');
      }
      return holdStream().res;
    });
    vi.stubGlobal('fetch', fetches);
    const status: string[] = [];
    const handle = openStream('state', { onFrame: () => {}, onStatus: (s) => status.push(s) }, { retryMs: 5 });
    await flush(30);
    expect(status).toContain('error');
    expect(fetches.mock.calls.length).toBeGreaterThanOrEqual(2);
    handle.close();
  });

  it('动作流正常结束 = 终态：不重拨（重拨会用同一 body 重发 T3 请求，违反"绝不自动重放"红线）', async () => {
    const h = holdStream();
    const fetches = vi.fn(async () => h.res);
    vi.stubGlobal('fetch', fetches);
    const status: string[] = [];
    const handle = openStream('action', { onFrame: () => {}, onStatus: (s) => status.push(s) }, { retryMs: 5 });
    await flush();
    expect(fetches).toHaveBeenCalledTimes(1);
    h.end();
    await flush(20);
    expect(fetches).toHaveBeenCalledTimes(1);
    expect(status).toContain('closed');
    expect(status).not.toContain('reconnecting');
    handle.close();
  });

  it('非动作流正常结束仍按退避重拨（只有 action 把正常结束当终态）', async () => {
    const a = holdStream();
    const b = holdStream();
    const fetches = vi.fn(async () => (fetches.mock.calls.length === 1 ? a.res : b.res));
    vi.stubGlobal('fetch', fetches);
    const handle = openStream('logs', { onFrame: () => {} }, { retryMs: 5 });
    await flush();
    a.end();
    await flush(20);
    expect(fetches).toHaveBeenCalledTimes(2);
    handle.close();
    b.end();
    await flush();
  });

  it('流建立前就 401 ⇒ 通知会话过期，不无限重拨', async () => {
    const fetches = vi.fn(async () => new Response(null, { status: 401 }));
    vi.stubGlobal('fetch', fetches);
    const expired = vi.fn();
    const handle = openStream('state', { onFrame: () => {}, onSessionExpired: expired }, { retryMs: 5 });
    await flush(20);
    expect(expired).toHaveBeenCalledTimes(1);
    expect(fetches).toHaveBeenCalledTimes(1);
    handle.close();
  });

  it('重连退避：连续失败间隔指数增长，封顶 30s', async () => {
    vi.useFakeTimers();
    try {
      const fetches = vi.fn(async () => new Response(null, { status: 500 }));
      vi.stubGlobal('fetch', fetches);
      const handle = openStream('state', { onFrame: () => {} }, { retryMs: 1000 });
      // 第一枪立刻出
      await vi.advanceTimersByTimeAsync(0);
      expect(fetches).toHaveBeenCalledTimes(1);
      // 第一次重试：1s 后才出
      await vi.advanceTimersByTimeAsync(999);
      expect(fetches).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(fetches).toHaveBeenCalledTimes(2);
      // 第二次重试：2s 后
      await vi.advanceTimersByTimeAsync(1999);
      expect(fetches).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(fetches).toHaveBeenCalledTimes(3);
      handle.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
