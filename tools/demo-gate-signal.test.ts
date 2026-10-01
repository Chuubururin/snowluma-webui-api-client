// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
// @vitest-environment happy-dom
/**
 * L3：门禁信号在浏览器侧的唯一去处。
 *
 * 起因是的浏览器复验：上游那扇真闸在业务调用上回 403 `consentRequired`，服务端 `gateDispatch`
 * 把它折成 `{step:'consent'}` 交回，而**客户端没有任何人接**——日志页于是把"门禁没过"画成
 * "导出响应没有正文"。gates.ts 的文件头明令禁止这个形态（"不许被折成'加载失败'留在业务面板上，
 * 那等于把门禁未过伪装成数据不存在"），服务端做了自己那一半，浏览器这一半原本没有归属：
 * 计划里的"浏览器侧状态机"管的是 SSE 帧分派与对账，不是门禁。这里把它补上，
 * 并且只补一个收口（`api.ts` 上报 + 外壳回门禁屏），让六个面板共用同一条出路。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type StubReply = { status?: number; body: any };

const json = (body: any, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** 装一个可编程的 fetch 桩，按 pathname 命中（带 query 的也算同一条）。 */
function stubFetch(routes: Record<string, StubReply>) {
  const seen: string[] = [];
  const fn = vi.fn(async (input: any, init?: RequestInit) => {
    const path = String(typeof input === 'string' ? input : input.url);
    seen.push(path);
    const reply = routes[path.split('?')[0]];
    if (!reply) return json({ success: false, message: `桩里没有 ${path}` }, 404);
    return json(reply.body, reply.status ?? 200);
  });
  vi.stubGlobal('fetch', fn);
  return { seen, fn };
}

describe('api 层的门禁信号收口', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('业务路由 200 里带回 step 就是门禁信号，不许留给面板当"没有正文"', async () => {
    stubFetch({ '/logs': { body: { step: 'consent', consentRequired: true, message: '请先阅读并同意' } } });
    const { call, onGateSignal } = await import('../demo/client/api.js');
    const got: any[] = [];
    onGateSignal((s) => got.push(s));
    await expect(call<any>('/logs?limit=300')).resolves.toMatchObject({ step: 'consent' });
    expect(got).toEqual([{ step: 'consent', message: '请先阅读并同意' }]);
  });

  it('非 2xx 的错误体里有 step ⇒ 照样上报，调用方仍然拿到带体的 ApiError', async () => {
    stubFetch({ '/logs': { status: 403, body: { success: false, step: 'unknown', message: '门禁状态无法确认' } } });
    const { ApiError, call, onGateSignal } = await import('../demo/client/api.js');
    const got: any[] = [];
    onGateSignal((s) => got.push(s));
    const e = await call<any>('/logs').catch((x) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e.body).toMatchObject({ step: 'unknown' });
    expect(got).toEqual([{ step: 'unknown', message: '门禁状态无法确认' }]);
  });

  it('门禁路由自己的 step 不上报：那一屏本来就该按 step 画，上报只会让它反复自摘', async () => {
    stubFetch({
      '/gate/state': { body: { step: 'consent', consentRequired: true } },
      '/gate/login': { body: { step: 'password', mustChangePassword: true } },
    });
    const { call, onGateSignal, post } = await import('../demo/client/api.js');
    const got: any[] = [];
    onGateSignal((s) => got.push(s));
    await call('/gate/state');
    await post('/gate/login', { password: 'x' });
    expect(got).toEqual([]);
  });

  it('主动登出的 step:login 不是门禁信号（外壳在那条路径上自己回登录屏）', async () => {
    stubFetch({ '/logout': { body: { step: 'login' } } });
    const { onGateSignal, post } = await import('../demo/client/api.js');
    const got: any[] = [];
    onGateSignal((s) => got.push(s));
    await post('/logout', {});
    expect(got).toEqual([]);
  });

  it('step:app 是"门禁已过"，不是信号；没有 step 的普通响应更不是', async () => {
    stubFetch({
      '/loglevel': { body: { step: 'app', data: { level: 'info', levels: [] } } },
      '/overview': { body: { data: { status: 'running' } } },
    });
    const { call, onGateSignal } = await import('../demo/client/api.js');
    const got: any[] = [];
    onGateSignal((s) => got.push(s));
    await call('/loglevel');
    await call('/overview');
    expect(got).toEqual([]);
  });
});

describe('外壳接线：面板撞上真闸就回门禁屏', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>';
    location.hash = '#logs';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('登录进主界面后，面板读到 200 + step:consent ⇒ 主界面收起、门禁屏接管并重读权威状态', async () => {
    const { seen } = stubFetch({
      '/base-url': { body: { baseUrl: 'http://127.0.0.1:5099' } },
      '/appearance': { body: { ok: true, data: { appearance: { mode: 'dark' } } } },
      '/gate/state': { body: { step: 'login' } },
      '/gate/login': { body: { step: 'app', status: { status: 'running' } } },
      // 面板这两条读都撞上上游那道真闸（服务端 gateDispatch 的 200 + step 形状）
      '/logs': { body: { step: 'consent', consentRequired: true, message: '请先阅读并同意' } },
      '/loglevel': { body: { step: 'consent', consentRequired: true, message: '请先阅读并同意' } },
    });
    await import('../demo/client/app.js');
    await flush();
    const pass = document.getElementById('password') as HTMLInputElement;
    pass.value = 'p';
    document.getElementById('loginForm')!.dispatchEvent(new Event('submit'));
    await flush();

    // 登录成功后外壳确实建起来了（#tabs 由 enterApp 画，收起主界面不清它）
    expect(document.getElementById('tabs')).not.toBeNull();
    // 面板那两次读带回 step ⇒ 界面交回门禁屏，而不是把"门禁没过"画成"响应没有正文"
    expect(document.getElementById('main')!.hidden).toBe(true);
    expect(document.getElementById('gate')!.hidden).toBe(false);
    // 交回门禁屏后一切安静：面板销毁了，没有新的面板读在顶门禁屏（门禁屏自己的状态读在上面那条里已计）
    const before = seen.length;
    await flush(3);
    expect(seen.slice(before)).toEqual([]);
    // 回门禁屏后重读一次权威状态（首屏那次 + 现在这次），画哪一屏由这一次决定
    expect(seen.filter((p) => p === '/gate/state').length).toBeGreaterThanOrEqual(2);
  });

  it('过闸回调跑第二次 ⇒ 外壳整块重画后当前面板必须重挂（真浏览器里这里是一片空白）', async () => {
    stubFetch({
      '/base-url': { body: { baseUrl: 'http://127.0.0.1:5099' } },
      '/appearance': { body: { ok: true, data: { appearance: { mode: 'dark' } } } },
      '/gate/state': { body: { step: 'login' } },
      '/gate/login': { body: { step: 'app', status: { status: 'running' } } },
      '/logs': { body: { data: { data: [], limit: 300 } } },
      '/loglevel': { body: { data: { level: 'info', levels: ['info'] } } },
    });
    await import('../demo/client/app.js');
    await flush();
    const login = () => {
      (document.getElementById('password') as HTMLInputElement).value = 'p';
      document.getElementById('loginForm')!.dispatchEvent(new Event('submit'));
    };
    login();
    await flush();
    expect(document.getElementById('panel')!.children.length).toBeGreaterThan(0);

    // 门禁屏只是 hidden，表单节点还在；重复提交 / 重读权威状态都会让 onPass 再跑一次，
    // 而 enterApp 会把 #main 整块重画 —— #panel 换成全新节点，同名早退就让它一直空着。
    login();
    await flush();
    expect(document.getElementById('main')!.hidden).toBe(false);
    expect(document.getElementById('panel')!.children.length).toBeGreaterThan(0);
  });

  it('地址变了就换面板：后退键不许只改地址不动界面', async () => {
    stubFetch({
      '/base-url': { body: { baseUrl: 'http://127.0.0.1:5099' } },
      '/appearance': { body: { ok: true, data: { appearance: { mode: 'dark' } } } },
      '/gate/state': { body: { step: 'login' } },
      '/gate/login': { body: { step: 'app', status: { status: 'running' } } },
      '/overview': { body: { data: { system: { status: 'running' }, qq: [], connections: [], processes: [] } } },
      '/overview/system': { body: { data: {} } },
      '/overview/update-check': { body: { data: {} } },
      '/logs': { body: { data: { data: [], limit: 300 } } },
      '/loglevel': { body: { data: { level: 'info', levels: ['info'] } } },
    });
    location.hash = '#overview';
    await import('../demo/client/app.js');
    await flush();
    (document.getElementById('password') as HTMLInputElement).value = 'p';
    document.getElementById('loginForm')!.dispatchEvent(new Event('submit'));
    await flush();
    expect(document.getElementById('overviewRoot')).not.toBeNull();

    // 浏览器后退（或用户直接改地址栏）只改 hash：没有 hashchange 监听的话，界面就停在原地面板上，
    // 而 #tabs 的高亮、深链、后退键全都"看起来支持"——那是假装有路由。
    location.hash = '#logs';
    window.dispatchEvent(new Event('hashchange'));
    await flush();
    expect(document.getElementById('logsRoot')).not.toBeNull();
    expect(document.getElementById('overviewRoot')).toBeNull();
  });

  const shellRoutes = (): Record<string, StubReply> => ({
    '/base-url': { body: { baseUrl: 'http://127.0.0.1:5099' } },
    '/appearance': { body: { ok: true, data: { appearance: { mode: 'dark' } } } },
    '/gate/state': { body: { step: 'login' } },
    '/gate/login': { body: { step: 'app', status: { status: 'running' } } },
    // logs 面板拿 r.data 当行数组用（logs.ts 的 loadLogs）：形状错了面板会画成渲染失败、按钮消失
    '/logs': { body: { data: [], limit: 300 } },
    '/loglevel': { body: { data: { level: 'info', levels: ['info'] } } },
  });

  it('点登出且 POST /logout 成功 ⇒ 「已登出。」落进门禁屏、面板销毁不再出网、/gate/state 被重读', async () => {
    // 登出后的那次 /gate/state 重读先扣住：renderGate 一回来就整屏重绘，「已登出。」只存在于
    // 重绘前的窗口里 —— 扣住它才能把中间形状钉住，也顺带证明重读确实发出去了。
    let gateStateReads = 0;
    let releaseGateState: () => void = () => {};
    const heldGateState = new Promise<Response>((res) => {
      releaseGateState = () => res(json({ step: 'login' }));
    });
    const seen: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: any) => {
        const path = String(typeof input === 'string' ? input : input.url).split('?')[0];
        seen.push(path);
        if (path === '/gate/state') {
          gateStateReads++;
          if (gateStateReads > 1) return heldGateState;
        }
        const routes: Record<string, StubReply> = { ...shellRoutes(), '/logout': { body: { step: 'login' } } };
        const reply = routes[path];
        if (!reply) return json({ success: false, message: `桩里没有 ${path}` }, 404);
        return json(reply.body, reply.status ?? 200);
      }),
    );
    await import('../demo/client/app.js');
    await flush();
    (document.getElementById('password') as HTMLInputElement).value = 'p';
    document.getElementById('loginForm')!.dispatchEvent(new Event('submit'));
    await flush();
    expect(gateStateReads).toBe(1);

    // 面板还活着：点"重新读取"会真的出网（这是后面"销毁"断言的对照）
    (document.querySelector('#panel [data-reload-logs]') as HTMLButtonElement).click();
    await flush();
    expect(seen.filter((p) => p === '/logs').length).toBeGreaterThanOrEqual(2);

    (document.getElementById('logoutButton') as HTMLButtonElement).click();
    await flush();
    expect(gateStateReads).toBe(2); // 回门禁屏 = 权威状态被重读
    expect(document.getElementById('main')!.hidden).toBe(true);
    expect(document.getElementById('gate')!.hidden).toBe(false);
    expect(document.getElementById('gate')!.textContent).toContain('已登出。');

    // 面板已销毁：同一个"重新读取"点击不再出网（logs 的 destroy 摘掉了 host 上的 click 监听）
    const before = seen.length;
    (document.querySelector('#panel [data-reload-logs]') as HTMLButtonElement).click();
    await flush();
    expect(seen.slice(before)).toEqual([]);

    // 扣住的那次读放行 ⇒ 门禁屏按权威状态画出登录屏（showGate → mountGate 的接线是真的）
    releaseGateState();
    await flush();
    expect(document.getElementById('gate')!.textContent).toContain('登录实例');
  });

  it('POST /logout 500 ⇒ 错误被吞但按钮恢复可点，界面留在主界面不崩', async () => {
    stubFetch({ ...shellRoutes(), '/logout': { status: 500, body: { success: false, message: '上游拒绝登出' } } });
    await import('../demo/client/app.js');
    await flush();
    (document.getElementById('password') as HTMLInputElement).value = 'p';
    document.getElementById('loginForm')!.dispatchEvent(new Event('submit'));
    await flush();
    const btn = document.getElementById('logoutButton') as HTMLButtonElement;
    btn.click();
    await flush();
    expect(btn.disabled).toBe(false);
    expect(document.getElementById('main')!.hidden).toBe(false);
    expect(document.getElementById('gate')!.hidden).toBe(true);
  });

  it('地址栏来了不在表里的面板名 ⇒ #panelPending 只落一句占位，不挂能点的空壳控件', async () => {
    stubFetch(shellRoutes());
    await import('../demo/client/app.js');
    await flush();
    (document.getElementById('password') as HTMLInputElement).value = 'p';
    document.getElementById('loginForm')!.dispatchEvent(new Event('submit'));
    await flush();
    expect(document.getElementById('logsRoot')).not.toBeNull();

    location.hash = '#bogus';
    window.dispatchEvent(new Event('hashchange'));
    await flush();
    const pending = document.getElementById('panelPending')!;
    expect(pending.textContent).toContain('「bogus」面板由后续任务接入。');
    // 旧面板随换名销毁，且没有冒出一个空壳面板根
    expect(document.getElementById('logsRoot')).toBeNull();
    expect(pending.querySelector('button')).toBeNull();
  });

  it('未知面板名只落成文本：hash 带来的任何形状都不产生活元素（esc 纪律的挂载级钉法）', async () => {
    stubFetch(shellRoutes());
    await import('../demo/client/app.js');
    await flush();
    (document.getElementById('password') as HTMLInputElement).value = 'p';
    document.getElementById('loginForm')!.dispatchEvent(new Event('submit'));
    await flush();

    // 尖括号/空格过 URL 那一道会被编码成 %3C…%3E。有人"好心"补一个 decodeURIComponent 就会把
    // 它还原成活元素 —— 这条钉死那类回归：编码后的名字必须以编码形状留在文本里。
    location.hash = '#<script>alert(1)</script>';
    window.dispatchEvent(new Event('hashchange'));
    await flush();
    let pending = document.getElementById('panelPending')!;
    expect(pending.querySelector('script')).toBeNull();
    expect(pending.querySelector('img')).toBeNull();
    expect(pending.textContent).toContain('%3Cscript%3E');

    // 单引号不在 URL 的 fragment 编码集里，属性注入形状会原样抵达 showPanel —— 同样只许落成文本
    location.hash = "#bogus'onerror='alert(1)";
    window.dispatchEvent(new Event('hashchange'));
    await flush();
    pending = document.getElementById('panelPending')!;
    expect(pending.querySelector('script')).toBeNull();
    expect(pending.querySelector('img')).toBeNull();
    expect(pending.textContent).toContain("bogus'onerror='alert(1)");
  });
});

describe('壳层目标实例行：只读展示改成可修改', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>';
    location.hash = '#overview';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  const OLD = 'http://127.0.0.1:5099';
  const shellStubs = (over: Record<string, StubReply> = {}) =>
    stubFetch({
      '/base-url': { body: { baseUrl: OLD } },
      '/appearance': { body: { ok: true, data: { appearance: { mode: 'system' } } } },
      '/gate/state': { body: { step: 'login' } },
      ...over,
    });

  it('渲染出预填当前地址的输入框与切换按钮（不是一个只能看的 <code>）', async () => {
    shellStubs();
    await import('../demo/client/app.js');
    await flush();
    const input = document.getElementById('targetInput') as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.value).toBe(OLD);
    expect(document.querySelector('#target code')!.textContent).toBe(OLD);
    expect(document.getElementById('targetSubmit')).not.toBeNull();
  });

  it('切换成功 ⇒ 只发一次 /set-base-url 带新值、显示与输入框都换成新值、外观按新目标重读', async () => {
    const { seen, fn } = shellStubs({
      '/set-base-url': { body: { baseUrl: 'http://127.0.0.1:7000', step: 'login' } },
    });
    await import('../demo/client/app.js');
    await flush();
    // 敲进去的带尾斜杠，而服务端 `validateBaseUrl` 会把尾斜杠吃掉（`upstream.ts:38`）——
    // 用这个差值才分得开"按服务端回读的值重画"和"把用户敲的文本留在原地"。
    (document.getElementById('targetInput') as HTMLInputElement).value = 'http://127.0.0.1:7000/';
    seen.length = 0;
    document.getElementById('targetForm')!.dispatchEvent(new Event('submit'));
    await flush();

    const post = seen.find((p) => p === '/set-base-url');
    expect(post).toBe('/set-base-url');
    const sent = fn.mock.calls.find((c: any[]) => String(c[0]) === '/set-base-url') as [string, RequestInit];
    expect(JSON.parse(String(sent[1].body))).toEqual({ baseUrl: 'http://127.0.0.1:7000/' });
    // 整段重画：显示值与输入框都必须是**服务端回读**的那一份，留着用户敲的原文就是拿输入当事实
    expect(document.querySelector('#target code')!.textContent).toBe('http://127.0.0.1:7000');
    expect((document.getElementById('targetInput') as HTMLInputElement).value).toBe('http://127.0.0.1:7000');
    // 外观摘要属于刚才那一台，换完必须重读一次
    expect(seen.filter((p) => p === '/appearance')).toHaveLength(1);
  });

  it('切换失败 ⇒ 原文报出服务端消息、目标显示不动、按钮恢复可点', async () => {
    shellStubs({
      '/set-base-url': { status: 400, body: { success: false, message: '不是合法的实例地址' } },
    });
    await import('../demo/client/app.js');
    await flush();
    (document.getElementById('targetInput') as HTMLInputElement).value = 'not a url';
    document.getElementById('targetForm')!.dispatchEvent(new Event('submit'));
    await flush();
    expect(document.getElementById('targetMsg')!.textContent).toBe('切换失败：不是合法的实例地址');
    expect(document.querySelector('#target code')!.textContent).toBe(OLD);
    expect((document.getElementById('targetSubmit') as HTMLButtonElement).disabled).toBe(false);
  });
});

/** happy-dom 里的宏任务/微任务都排干净：桩是 async 的，链路有好几跳。 */
async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}
