// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
// @vitest-environment happy-dom
/**
 * L3：的"接管"。裁定是三条流的面板格子由本任务换数据来源而不换控件名单
 * （task-6-7-addendum / task-9-addendum / task-11-addendum 三处同文），所以这里测的就是
 * **"这一格的数字是从流上来的，不是从 REST 首屏来的"**。
 *
 * 为什么这一层必须单独存在：`/events` 的 L2 只证明服务端会发帧，`state.ts` 的 L3 只证明客户端会读帧，
 * 两者之间没有接上就会出现"两个半程各自全绿、界面上永远写着 REST 首屏"那种没有出口的界面。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mountOverview } from '../demo/client/pages/overview.js';
import { mountLogs } from '../demo/client/pages/logs.js';
import { mountDebug } from '../demo/client/pages/debug.js';
import { streamLineOf } from '../demo/client/pages/logs.js';
import { onGateSignal } from '../demo/client/api.js';

interface Call {
  url: string;
  method: string;
  body: any;
  signal: AbortSignal | null;
}

type Reply = { status?: number; body?: unknown };

/** JSON 面按表回答；`/events*` 面交出一条由测试手动喂帧的 SSE。 */
function stub(overrides: Record<string, Reply> = {}) {
  const calls: Call[] = [];
  const enc = new TextEncoder();
  const streams: Array<{ push(text: string): void; end(): void }> = [];
  const table: Record<string, Reply> = {
    'GET /overview': {
      body: {
        data: {
          status: { status: 'running' },
          system: {
            hostname: 'host-a', platform: 'linux', arch: 'x64', archLabel: 'x86_64',
            release: '6.1.0-amd64', distro: 'Debian GNU/Linux 12', uptime: 123456, processUptime: 3456,
            nodeVersion: 'v22.1.0',
            cpu: { model: 'EPYC', cores: 8, speedMHz: 2400, loadAvg: [0.1, 0.2, 0.3], perCore: [10, 20], average: 12.5 },
            memory: { total: 16000000000, free: 8000000000, used: 8000000000, usagePercent: 50 },
            runtime: { pid: 4242, rss: 100, heapTotal: 200, heapUsed: 300, external: 400, arrayBuffers: 500 },
          },
          qq: { list: [{ uin: 10001, nickname: 'REST 首屏' }] },
          connections: { list: [] },
          processes: { list: [] },
          update: { hasUpdate: false, current: '1.14.20' },
          ui: { config: { appearance: { pollInterval: 5000 } } },
        },
        errors: {},
        pollInterval: 5000,
        systemPollMs: 50000,
      },
    },
    'GET /overview/system': { body: { data: { hostname: 'host-a', processUptime: 3456 } } },
    'GET /logs': { body: { data: [], limit: 300 } },
    'GET /loglevel': { body: { data: { level: 'info', levels: ['info', 'warn'] } } },
    'GET /debug-actions': {
      body: {
        data: {
          actions: [
            { name: 'get_group_list', aliases: [], category: 'group', summary: '取群列表', readOnly: true, stream: false, params: [] },
            {
              name: 'stream_events',
              aliases: [],
              category: 'events',
              summary: '事件流',
              readOnly: true,
              stream: true,
              params: [],
            },
          ],
          categories: [{ category: 'group', count: 1 }],
        },
      },
    },
    'GET /config/accounts': { body: { data: { list: [{ uin: 10001, nickname: '夹具号' }] } } },
    ...overrides,
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, init?: RequestInit) => {
      const url = String(path);
      const method = (init?.method ?? 'GET').toUpperCase();
      const pathname = url.split('?')[0];
      calls.push({
        url,
        method,
        body: init?.body && typeof init.body === 'string' ? JSON.parse(init.body) : null,
        signal: (init?.signal as AbortSignal | null) ?? null,
      });
      if (pathname === '/events' || pathname === '/events/action') {
        let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
        streams.push({
          push: (text) => controller?.enqueue(enc.encode(text)),
          end: () => {
            controller?.close();
            controller = null;
          },
        });
        return new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              controller = c;
            },
          }),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        );
      }
      const out = table[`${method} ${pathname}`] ?? { status: 404, body: { success: false, message: `桩没有 ${method} ${pathname}` } };
      return new Response(JSON.stringify(out.body ?? {}), {
        status: out.status ?? 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  const frame = (i: number, obj: unknown) => streams[i]?.push(`data: ${JSON.stringify(obj)}\n\n`);
  const restCalls = (pathname: string) => calls.filter((x) => x.url.split('?')[0] === pathname).length;
  return { calls, streams, frame, restCalls, count: (p: string) => calls.filter((c) => c.url.startsWith(p)).length };
}

async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}

function panel(): HTMLElement {
  document.body.innerHTML = '<div id="panel"></div>';
  return document.getElementById('panel')!;
}

const q = (sel: string) => document.querySelector(sel) as HTMLElement | null;
const text = (name: string) => q(`[data-ctl="${name}"]`)?.textContent ?? '';

afterEach(() => {
  vi.unstubAllGlobals();
  onGateSignal(null);
});

describe('总览页接管 state 流', () => {
  it('挂上只开一条 /events?topic=state；快照帧一到就覆盖账号那一格', async () => {
    const f = stub();
    const host = panel();
    const mounted = mountOverview(host);
    await flush();
    expect(f.count('/events?topic=state')).toBe(1);
    expect(text('qqList')).toContain('REST 首屏');
    f.frame(0, { resource: 'qq-list', data: [{ uin: '20002', nickname: '推流来的号' }] });
    await flush();
    expect(text('qqList')).toContain('20002');
    expect(text('qqList')).toContain('推流来的号');
    expect(text('qqList')).not.toContain('REST 首屏');
    expect(f.count('/events')).toBe(1); // 每来一帧不重开一条流
    mounted.destroy();
  });

  it('实时状态那格写的是流的状态与最后一帧，不再挂着"本面板当前填的是 REST 首屏数据"', async () => {
    const f = stub();
    const mounted = mountOverview(panel());
    await flush();
    f.frame(0, { resource: 'connections', data: [{ uin: '20002', nickname: '推流号', adapters: [] }] });
    await flush();
    const cell = text('stateStreamFeed');
    expect(cell).toContain('connections');
    expect(cell).not.toContain('当前填的是 REST 首屏数据');
    mounted.destroy();
  });

  it('dropped 帧 ⇒ 三份资源一次性 REST 重取，并把丢帧数写在格子里', async () => {
    const f = stub();
    const mounted = mountOverview(panel());
    await flush();
    const before = f.restCalls('/overview');
    f.frame(0, { kind: 'dropped', count: 4 });
    await flush();
    expect(f.restCalls('/overview')).toBeGreaterThan(before); // 真重取过一次 REST 首屏
    expect(text('stateStreamFeed')).toContain('4'); // 丢了几帧要说得出数字
    mounted.destroy();
  });

  it('destroy 之后流被关闭：那条 SSE 的 signal 处于 aborted，不再重拨', async () => {
    const f = stub();
    const mounted = mountOverview(panel());
    await flush();
    const signal = f.calls.find((c) => c.url.startsWith('/events'))?.signal;
    expect(signal).not.toBeNull();
    mounted.destroy();
    await flush();
    expect(signal!.aborted).toBe(true);
    expect(f.count('/events')).toBe(1);
  });

  it('session-expired 帧 ⇒ 交回门禁（登录屏），面板不再自己猜', async () => {
    const steps: string[] = [];
    onGateSignal((s) => steps.push(s.step));
    const f = stub();
    const mounted = mountOverview(panel());
    await flush();
    f.frame(0, { kind: 'session-expired', message: '上游判死了当前会话' });
    await flush();
    expect(steps).toEqual(['login']);
    expect(f.count('/events')).toBe(1); // 死了就停，不许对着登录屏重拨
    mounted.destroy();
  });

  it('REST 整屏 500 ⇒ 错误位出现且不崩、轮询不被拉起；恢复后重取成功且轮询随新 systemPollMs 跑起来', async () => {
    let ok = false;
    const f = stub({
      'GET /overview/system': {
        // 轮询恢复后这张表会被真的打到：system 卡要按 SystemInfoShape 的全量键画，
        // 桩给半份（缺 cpu/memory/runtime）会让 renderSystemCard 读 sys.cpu.model 抛错——那是桩缺键，不是页面该兜的
        body: {
          data: {
            hostname: 'host-a', platform: 'linux', arch: 'x64', archLabel: 'x86_64',
            release: '6.1.0-amd64', distro: 'Debian GNU/Linux 12', uptime: 123456, processUptime: 3457,
            nodeVersion: 'v22.1.0',
            cpu: { model: 'EPYC', cores: 8, speedMHz: 2400, loadAvg: [0.1, 0.2, 0.3], perCore: [10, 20], average: 12.5 },
            memory: { total: 16000000000, free: 8000000000, used: 8000000000, usagePercent: 50 },
            runtime: { pid: 4242, rss: 100, heapTotal: 200, heapUsed: 300, external: 400, arrayBuffers: 500 },
          },
        },
      },
      'GET /overview': {
        get status() {
          return ok ? 200 : 500;
        },
        get body() {
          return ok
            ? {
                data: {
                  status: { status: 'running' },
                  system: null,
                  qq: { list: [{ uin: 30003, nickname: '恢复后的号' }] },
                  connections: { list: [] },
                  processes: { list: [] },
                  update: { hasUpdate: false, current: '1.14.20' },
                  ui: { config: { appearance: { pollInterval: 5000 } } },
                },
                errors: {},
                pollInterval: 5000,
                systemPollMs: 20, // 故意给一个很小的周期：好让"轮询真的重新跑起来"在测试里看得见
              }
            : { success: false, message: 'demo 后端整屏失败' };
        },
      },
    });
    const mounted = mountOverview(panel());
    await flush();
    // 500 那一轮：错误位明写，页面照常成形（格子有值/有错/明写"尚未读到"，不留悬挂加载态），不崩
    expect(q('#overviewLoadError')?.textContent).toContain('整屏读取失败');
    expect(q('#overviewLoadError')?.textContent).toContain('demo 后端整屏失败');
    expect(text('qqList')).not.toContain('恢复后的号');
    expect(f.restCalls('/overview/system')).toBe(0); // 首屏没读到 ⇒ 轮询周期也没读到 ⇒ 不烧这一枪

    ok = true; // 服务端恢复
    (q('#overviewReload') as HTMLElement).click();
    await flush();
    expect(text('qqList')).toContain('恢复后的号');
    expect(q('#overviewLoadError')).toBeNull(); // 上一轮的失败不该继续挂着
    await new Promise((r) => setTimeout(r, 90)); // systemPollMs=20ms ⇒ 窗口里至少轮到一次 /overview/system
    expect(f.restCalls('/overview/system')).toBeGreaterThanOrEqual(1);
    mounted.destroy();
  });
});

describe('日志页接管 logs 流', () => {
  it('条目帧进 #logStreamList，状态行不再写"尚未建立 SSE 连接"', async () => {
    const f = stub();
    const mounted = mountLogs(panel());
    await flush();
    expect(f.count('/events?topic=logs')).toBe(1);
    f.frame(0, { id: 9, time: '2026-09-29T02:00:00.000Z', level: 'warn', scope: 'onebot', message: '推流的一条', line: 'warn onebot 推流的一条' });
    await flush();
    expect(q('#logStreamList')?.textContent ?? '').toContain('推流的一条');
    expect(q('#logStreamStatus')?.textContent ?? '').not.toContain('尚未建立 SSE 连接');
    mounted.destroy();
    await flush();
    expect(f.count('/events')).toBe(1);
  });

  it('缺键的条目帧明写缺了哪几个键，而不是印一个 undefined 或空行', () => {
    expect(streamLineOf({ kind: 'entry', data: { time: 't', message: 'm' } })).toMatchObject({
      level: '—',
      message: '这条推来的日志缺键：level',
    });
    expect(streamLineOf({ kind: 'entry', data: {} }).message).toContain('time、level、message');
    expect(streamLineOf({ kind: 'entry', data: { time: 't', level: 'warn', message: 'm' } })).toEqual({
      time: 't',
      level: 'warn',
      message: 'm',
    });
  });

  it('ready 帧只更新状态行，不进日志列表（把就绪信号当一条日志印出来就是噪音）', async () => {
    const f = stub();
    const mounted = mountLogs(panel());
    await flush();
    f.frame(0, { type: 'ready' });
    await flush();
    expect(q('#logStreamList')?.textContent ?? '').toBe('');
    expect(q('#logStreamStatus')?.textContent ?? '').toContain('已连上');
    mounted.destroy();
  });

  it('session-expired 帧 ⇒ 交回门禁（登录屏），不再对死会话重拨', async () => {
    const steps: string[] = [];
    onGateSignal((s) => steps.push(s.step));
    const f = stub();
    const mounted = mountLogs(panel());
    await flush();
    f.frame(0, { kind: 'session-expired', message: '上游判死了当前会话' });
    await flush();
    expect(steps).toEqual(['login']);
    expect(f.count('/events')).toBe(1); // 死了就停，不许对着登录屏重拨
    mounted.destroy();
    await flush();
  });
});

describe('调试页接管 debug 与 action 两条流', () => {
  it('debug 帧进 debugStreamFeed：事件帧印 uin 与事件，不看键就当没收到', async () => {
    const f = stub();
    const mounted = mountDebug(panel());
    await flush();
    expect(f.count('/events?topic=debug')).toBe(1);
    f.frame(0, { kind: 'event', uin: '10001', event: { post_type: 'message', message: '推流来的事件' } });
    await flush();
    const cell = text('debugStreamFeed');
    expect(cell).toContain('10001');
    expect(cell).toContain('message');
    expect(cell).not.toContain('这一格由流式页接管（实现批次）');
    mounted.destroy();
  });

  it('目录里标 stream 的动作：执行走 POST /events/action，绝不走 REST invoke', async () => {
    const f = stub();
    const mounted = mountDebug(panel());
    await flush();
    (q('[data-action="stream_events"]') as HTMLElement).click();
    await flush();
    const btn = q('[data-invoke]') as HTMLElement;
    btn.click();
    await flush();
    expect(f.count('/debug-invoke')).toBe(0);
    expect(f.count('/events/action')).toBe(1);
    expect(f.calls.find((c) => c.url === '/events/action')?.body).toMatchObject({ uin: '10001', action: 'stream_events' });
    mounted.destroy();
  });

  it('连着点两个流式动作 ⇒ 前一条动作流被关掉（换动作不留悬挂连接）', async () => {
    const f = stub();
    const mounted = mountDebug(panel());
    await flush();
    (q('[data-action="stream_events"]') as HTMLElement).click();
    await flush();
    (q('[data-invoke]') as HTMLElement).click();
    await flush();
    const first = f.calls.find((c) => c.url === '/events/action')?.signal;
    expect(first).not.toBeNull();
    expect(first!.aborted).toBe(false);
    (q('[data-invoke]') as HTMLElement).click();
    await flush();
    expect(first!.aborted).toBe(true); // 旧的那条已经关了
    expect(f.calls.filter((c) => c.url === '/events/action')).toHaveLength(2);
    mounted.destroy();
  });

  it('动作流的帧（内键不断言）原样印进流式格子，而不是"收到未知帧"就丢掉', async () => {
    const f = stub();
    const mounted = mountDebug(panel());
    await flush();
    (q('[data-action="stream_events"]') as HTMLElement).click();
    await flush();
    (q('[data-invoke]') as HTMLElement).click();
    await flush();
    f.frame(1, { stage: 'start', detail: { seq: 1 } });
    await flush();
    expect(text('debugStreamFeed')).toContain('stage');
    mounted.destroy();
  });

  it('session-expired 帧（全局事件流）⇒ 交回门禁（登录屏），面板不自己画登录屏也不重拨', async () => {
    const steps: string[] = [];
    onGateSignal((s) => steps.push(s.step));
    const f = stub();
    const mounted = mountDebug(panel());
    await flush();
    f.frame(0, { kind: 'session-expired', message: '上游判死了当前会话' });
    await flush();
    expect(steps).toEqual(['login']);
    expect(f.count('/events')).toBe(1); // 只开过事件流这一条：死了就停，不许对着登录屏重拨
    mounted.destroy();
    await flush();
  });
});
