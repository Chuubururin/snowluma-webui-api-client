// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
/**
 * 浏览器侧的流状态机（设计口径的三层：推流为主 / 慢速 REST 兜底 / 冷启动 REST 首屏）。
 *
 * 为什么这里不是 `EventSource`：四条流里有 `action`（POST 且带体），`EventSource` 只有 GET；
 * 而它自带的重连会跟服务端的"一枪不重拨"策略打架 —— 会话死了它还会照着 3s 无限重拨，
 * 那是对着自己这台 demo 的登录屏 DoS。所以走 fetch + reader，重连的每一枪都由这里决定。
 * （真 WebUI 对上游也是 fetch + reader，理由记在 spec 的流端点描述里。）
 *
 * 三条与 spec 对齐的取值纪律：
 *  · 帧的分派读**负载内部**的标签（`kind` 或 `resource`）：线上没有 `event:` 字段
 *    （`x-snowluma-sse.tagFields: [kind, resource]`）。
 *  · 心跳超时只在**有锚点的那条流**上判：spec 只给 `/api/state/stream` 记了 `heartbeatMs: 15000`
 *    （`sse-response.ts:62`）。logs/debug/invoke-stream 没有这个数字 ⇒ 表里是 null，
 *    传参也造不出一个没有锚点的心跳。
 *  · 慢对账周期 `max(pollInterval × 10, 10000)`，`document.hidden` 时不烧这一枪。
 */

export type ClientTopic = 'state' | 'logs' | 'debug' | 'action';

export interface ParsedFrame {
  kind: string;
  resource?: string;
  data?: unknown;
  message?: string;
  count?: number;
  /** 帧读不懂 / 没有标签时把原文交回，界面才能写"收到一帧看不懂"而不是沉默。 */
  raw?: string;
  /** 上游的键不止上面这几个（event/uin/count/topic…），适配层不收窄键集，面板按 kind 自己读。 */
  readonly [key: string]: unknown;
}

/** 快照帧的三份资源：`dropped` 之后要一次性重取的就是这三份（spec `StateStreamFrame` 的三支）。 */
export const reconcileResource = ['processes', 'qq-list', 'connections'] as const;

export const HEARTBEAT_MS: Record<ClientTopic, number | null> = {
  state: 15000,
  logs: null,
  debug: null,
  action: null,
};

const DEFAULT_RETRY_MS = 1000;
const MAX_RETRY_MS = 30000;
const DEFAULT_POLL_MS = 5000;

function classify(payload: string): ParsedFrame | null {
  if (payload === '') return null;
  let value: any;
  try {
    value = JSON.parse(payload);
  } catch {
    return { kind: 'unparsable', raw: payload };
  }
  if (value === null || typeof value !== 'object') return { kind: 'unlabeled', raw: payload };
  if (typeof value.kind === 'string') return { ...value, kind: value.kind };
  if (typeof value.resource === 'string') return { kind: 'snapshot', resource: value.resource, data: value.data };
  // logs 那一条流的两支是 `{type:'ready'}` 与 LogEntry（spec `LogStreamFrame` R24：两支靠有无
  // `type: ready` 互斥）。它既不用 kind 也不用 resource ⇒ 适配层在这里收窄，而不是让面板各自猜。
  if (value.type === 'ready') return { kind: 'ready' };
  if (typeof value.time === 'string' && typeof value.level === 'string' && typeof value.message === 'string') {
    return { kind: 'entry', data: value };
  }
  return { kind: 'unlabeled', raw: payload };
}

/**
 * 一帧的原文（`data: <json>` 整行，或已剥前缀的负载）⇒ 结构化帧。
 * 不是帧（空行、`: ping` 心跳注释、`id:`/`retry:` 之类控制行）返回 null，不进状态机。
 */
export function formatFrame(raw: string): ParsedFrame | null {
  const line = raw.replace(/\r\n?/g, '\n');
  if (line.trim() === '') return null;
  if (line.startsWith(':')) return null; // 上游心跳注释
  const stripped = line.startsWith('data:') ? line.slice('data:'.length).replace(/^ /, '') : line;
  if (/^(event|id|retry):/.test(line)) return null; // 线上不该出现；出现了也不是负载
  return classify(stripped);
}

/** 一个 SSE 块（可能多行）里的负载文本；没有 `data:` 行就不是负载块。 */
function blockPayload(block: string): string | null {
  const lines = block.split('\n');
  const data: string[] = [];
  for (const l of lines) {
    if (l.startsWith('data:')) data.push(l.replace(/^data:\s*/, ''));
  }
  return data.length > 0 ? data.join('\n') : null;
}

/** 这一帧要不要触发 REST 对账：只有 `dropped`（慢客户端丢帧 ⇒ 此后每帧都可能是残缺全量）。 */
export function planReconcile(frame: ParsedFrame): string[] {
  return frame.kind === 'dropped' ? [...reconcileResource] : [];
}

/** 慢对账周期：实例自己配的节播放大十倍，地板 10s；缺键/非正数落回 5000 档（与 overview 的 systemPollMs 同一规则）。 */
export function slowReconcileMs(pollInterval: number | undefined): number {
  const p = typeof pollInterval === 'number' && pollInterval > 0 ? pollInterval : DEFAULT_POLL_MS;
  return Math.max(p * 10, 10000);
}

/** 周期性对账；页面在后台就不烧这一枪（回到前台的下一个周期自然补上）。 */
export function startSlowReconcile(everyMs: number, tick: () => void): () => void {
  const timer = setInterval(() => {
    if (typeof document !== 'undefined' && document.hidden) return;
    tick();
  }, everyMs);
  return () => clearInterval(timer);
}

export interface StreamHandlers {
  onFrame: (f: ParsedFrame) => void;
  /** 会话死了的唯一信号：由外壳决定弹回哪一屏，这里不自己画界面。 */
  onSessionExpired?: (message: string) => void;
  onStatus?: (s: 'open' | 'reconnecting' | 'error' | 'closed') => void;
}

export interface StreamOptions {
  retryMs?: number;
  heartbeatMs?: number;
  /** `action` 那一支的请求体（{uin,action,params?}）：它是调用参数，不是回调。 */
  body?: unknown;
}

export interface StreamHandle {
  close(): void;
}

/**
 * 打开一条 `/events` 流并把帧交给 `onFrame`。返回的 `close()` 之后：不再出网、不再重拨。
 */
export function openStream(topic: ClientTopic, handlers: StreamHandlers, opts: StreamOptions = {}): StreamHandle {
  // 没有锚点的流不允许被传参造出一个心跳：HEARTBEAT_MS 是 spec 的表，不是默认值菜单
  const heartbeat = HEARTBEAT_MS[topic] === null ? null : (opts.heartbeatMs ?? HEARTBEAT_MS[topic]);
  const retryMs = opts.retryMs ?? DEFAULT_RETRY_MS;
  let closed = false;
  let controller: AbortController | null = null;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let timedOut = false;
  let wake: (() => void) | null = null;

  const nap = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      wake = () => {
        clearTimeout(t);
        resolve();
      };
    });

  const request = async (): Promise<Response> => {
    if (topic === 'action') {
      return fetch('/events/action', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(opts.body ?? {}),
        signal: controller!.signal,
      });
    }
    return fetch('/events?topic=' + encodeURIComponent(topic), { signal: controller!.signal });
  };

  const run = async (): Promise<void> => {
    let retries = 0;
    while (!closed) {
      controller = new AbortController();
      timedOut = false;
      let watchdog: ReturnType<typeof setTimeout> | null = null;
      const arm = () => {
        if (heartbeat === null) return;
        if (watchdog !== null) clearTimeout(watchdog);
        // 心跳间隔只说明"上游至少这么久该动一次"；判死放两倍，免得拿抖动当断线
        watchdog = setTimeout(() => {
          timedOut = true;
          // 直接摘掉读端：不能只指望 fetch 认 signal —— 桩与老浏览器里 pending 的 read() 不会因此醒来，
          // 于是超时重拨会变成永远挂在这一帧上。
          void reader?.cancel().catch(() => {});
          controller?.abort();
        }, heartbeat * 2);
      };
      try {
        arm();
        const res = await request();
        if (closed) return;
        if (!res.ok || !res.body) {
          // 401 = 会话死了（token 被拒 / 换目标后旧 token 作废）⇒ 通知外壳弹回登录屏，不重拨
          if (res.status === 401) {
            handlers.onSessionExpired?.('会话已失效，请重新登录');
            return;
          }
          handlers.onStatus?.('error');
          const delay = Math.min(retryMs * 2 ** retries, MAX_RETRY_MS);
          retries++;
          await nap(delay);
          if (closed) return;
          handlers.onStatus?.('reconnecting');
          continue;
        }
        retries = 0;
        handlers.onStatus?.('open');
        const rd = res.body.getReader();
        reader = rd;
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { done, value } = await rd.read();
          if (done) break;
          arm();
          buf += dec.decode(value, { stream: true }).replace(/\r\n?/g, '\n');
          let at = buf.indexOf('\n\n');
          while (at !== -1) {
            const block = buf.slice(0, at);
            buf = buf.slice(at + 2);
            at = buf.indexOf('\n\n');
            const payload = blockPayload(block);
            if (payload === null) continue; // 心跳注释一类的非负载块
            const frame = classify(payload);
            if (frame === null) continue;
            if (frame.kind === 'session-expired') {
              // 会话死了：摘掉读端再退出，不留悬挂连接
              void rd.cancel().catch(() => {});
              controller?.abort();
              handlers.onSessionExpired?.(frame.message ?? '会话已失效');
              return;
            }
            handlers.onFrame(frame);
          }
        }
        if (closed) return;
        // 动作流正常结束 = 终态（上游把结果全推完了）；重拨会用同一 body 重发 T3 请求，
        // 违反"绝不自动重放"红线。只有超时/错误才重连，正常结束一律不重拨。
        if (topic === 'action' && !timedOut) {
          handlers.onStatus?.('closed');
          return;
        }
        handlers.onStatus?.(timedOut ? 'error' : 'reconnecting');
      } catch {
        if (closed) return; // 自己 abort 的抛错不是上游的错误
        handlers.onStatus?.('error');
      } finally {
        if (watchdog !== null) clearTimeout(watchdog);
      }
      const delay = Math.min(retryMs * 2 ** retries, MAX_RETRY_MS);
      retries++;
      await nap(delay);
    }
  };

  void run();

  return {
    close() {
      closed = true;
      controller?.abort();
      wake?.();
      wake = null;
      handlers.onStatus?.('closed');
    },
  };
}
