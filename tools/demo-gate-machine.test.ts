// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
// @vitest-environment happy-dom
/**
 * L3：门禁状态机与门禁屏的可操作性。测两件事，不测样式：
 *  1. `gateStep` 的优先级（同意 > 改密 > 进主界面），以及**状态读不到时既不放行也不拦死**——
 *     这条 `'unknown'` 是对上游 `mustChangePassword()` 出错静默返回 false 的有意偏离
 *     （`packages/webui/src/lib/api/client.ts:543-548`，已登记 declination `must-change-password-silent-false`）。
 *  2. 条款没勾就不许提交同意（"同意绝不代做"在 UI 侧的那一道）。
 *  3. `mountGate` 的取数闭环（文件末尾，走 fetch 桩）：2xx 与错误体都要落到渲染，
 *     上行的 version 必须是刚读到的那一份——浏览器实测抓到过"只挂 .catch 丢掉 2xx"的写法。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gateStep, mountGate, renderGate } from '../demo/client/pages/gate.js';

describe('gateStep', () => {
  it('同意优先于改密，两闸全过才进 app', () => {
    expect(gateStep({ consentRequired: true, mustChangePassword: true })).toBe('consent');
    expect(gateStep({ consentRequired: true, mustChangePassword: false })).toBe('consent');
    expect(gateStep({ consentRequired: false, mustChangePassword: true })).toBe('password');
    expect(gateStep({ consentRequired: false, mustChangePassword: false })).toBe('app');
  });

  it('状态取不到时不静默放行，也不静默拦死：落到 unknown 让操作者自己决定', () => {
    expect(gateStep({ consentRequired: undefined as any, mustChangePassword: undefined as any })).toBe('unknown');
    // 只读到一半也算读不到——上游两键分两次来，缺一个就不能断定门禁过了
    expect(gateStep({ consentRequired: false, mustChangePassword: undefined as any })).toBe('unknown');
  });
});

describe('门禁屏（happy-dom）', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="gate"></div>';
  });

  it('同意步渲染条款与勾选框，未勾选时提交按钮不可用', () => {
    renderGate(document.getElementById('gate')!, {
      step: 'consent',
      documents: [{ id: 'eula', title: '用户协议', text: '条款正文' }],
      version: 'sha256:abc',
    });
    const box = document.getElementById('agreeCheckbox') as HTMLInputElement;
    const submit = document.getElementById('consentSubmit') as HTMLButtonElement;
    expect(box).not.toBeNull();
    expect(submit.textContent).toContain('我已阅读并同意');
    expect(submit.disabled).toBe(true); // 浏览器没收到点击就不许提交
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    expect(submit.disabled).toBe(false);
  });

  it('改密步渲染规则清单而不是分数进度条（设计口径）', () => {
    renderGate(document.getElementById('gate')!, {
      step: 'password',
      rules: [
        { id: 'len', label: '至少 10 位', ok: false },
        { id: 'mixed', label: '含大小写与数字', ok: true },
      ],
    });
    const list = document.getElementById('strengthRules');
    expect(list).not.toBeNull();
    expect(list!.textContent).toContain('至少 10 位');
    expect(list!.textContent).not.toMatch(/score|进度/i);
    // 本 demo 没有样式表：只靠 class 表达"哪条没满足"等于没说，状态必须落在文字上
    expect(list!.textContent).toMatch(/未满足/);
    expect(list!.textContent).toMatch(/已满足/);
    expect(document.getElementById('newPassword')).not.toBeNull();
    // 口令永远不回浏览器：页面上不该出现任何 input[type=password] 之外的凭据展示
    expect(document.body.innerHTML).not.toMatch(/oldPassword/);
  });

  it('改密步两次输入不一致时提交保持禁用，一致才解锁（checkMatch，不靠 CSS）', () => {
    renderGate(document.getElementById('gate')!, { step: 'password', rules: [] });
    const np = document.getElementById('newPassword') as HTMLInputElement;
    const cp = document.getElementById('confirmPassword') as HTMLInputElement;
    const submit = document.getElementById('passwordSubmit') as HTMLButtonElement;
    expect(submit.disabled).toBe(true); // 初始就禁用：一个字都没敲
    np.value = 'abc';
    np.dispatchEvent(new Event('input'));
    expect(submit.disabled).toBe(true); // 确认框还空着，不许先放行
    cp.value = 'abd';
    cp.dispatchEvent(new Event('input'));
    expect(submit.disabled).toBe(true); // 两次输入不一致
    cp.value = 'abc';
    cp.dispatchEvent(new Event('input'));
    expect(submit.disabled).toBe(false); // 一致了才解锁
  });

  it('unknown 步给出"无法确认"，并把两条出路都端出来：重读与显式继续（设计口径允诺的继续）', () => {
    renderGate(document.getElementById('gate')!, { step: 'unknown', message: '上游 502' });
    expect(document.body.textContent).toContain('无法确认');
    expect(document.getElementById('gateRetry')).not.toBeNull();
    expect(document.getElementById('gateAck')).not.toBeNull();
  });
});

/**
 * mountGate 的取数闭环（同样是 happy-dom，但走 fetch 桩而不是真服务端）。
 * 钉三件浏览器实测才看得见的事：
 *  1. 2xx 的响应体真的要落到渲染（只挂 .catch 的实现会永远停在"加载中…"，这一条正是那样的写法漏掉的）；
 *  2. 非 2xx 的错误体也走同一条渲染路径（401 里的 step 决定回哪一屏）；
 *  3. 提交同意时上行的 version 必须是这次读到的那一份，不是客户端自拼的。
 */
describe('mountGate 取数闭环（happy-dom + fetch 桩）', () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));

  function stubFetch(implement: (req: { url: string; init?: RequestInit }) => { status: number; body: unknown }) {
    const seen: Array<{ url: string; body: any }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: string, init?: RequestInit) => {
        const body = init?.body ? JSON.parse(String(init.body)) : null;
        seen.push({ url: path, body });
        const out = implement({ url: path, init });
        return new Response(JSON.stringify(out.body), {
          status: out.status,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    return seen;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('GET /gate/state 返 2xx 就画对应那一屏；401 的错误体同样落到渲染', async () => {
    document.body.innerHTML = '<div id="gate"></div>';
    const seen = stubFetch(() => ({
      status: 200,
      body: {
        step: 'consent',
        consentRequired: true,
        version: 'sha256:read-once',
        documents: [{ id: 'eula', title: '用户协议', text: '正文', declaredVersion: 'v1', effectiveDate: '2026-01-01' }],
      },
    }));
    mountGate(document.getElementById('gate')!, () => {});
    await flush();
    expect(seen[0].url).toBe('/gate/state');
    expect(document.getElementById('gateTitle')?.textContent).toContain('同意');
    expect(document.getElementById('agreementDoc')).not.toBeNull();

    // 会话死了：门控 401 的 body 里带 step:'login'，必须回到登录屏而不是挂在原步
    document.body.innerHTML = '<div id="gate"></div>';
    stubFetch(() => ({ status: 401, body: { success: false, message: 'Token expired or invalid', step: 'login' } }));
    mountGate(document.getElementById('gate')!, () => {});
    await flush();
    expect(document.getElementById('gateTitle')?.textContent).toContain('登录实例');
    expect(document.getElementById('gateError')?.textContent).toContain('Token expired');
  });

  it('空 totp 不上行；同意上行的 version 就是刚读到的那一份；过闸才交主界面', async () => {
    document.body.innerHTML = '<div id="gate"></div>';
    const seen: Array<{ url: string; body: any }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: string, init?: RequestInit) => {
        const body = init?.body ? JSON.parse(String(init.body)) : null;
        seen.push({ url: path, body });
        const out =
          path === '/gate/state'
            ? { status: 200, body: { step: 'login' } }
            : path === '/gate/login'
              ? {
                  status: 200,
                  body: {
                    step: 'consent',
                    version: 'sha256:read-once',
                    documents: [{ id: 'eula', title: '用户协议', text: '正文' }],
                  },
                }
              : path === '/gate/consent'
                ? { status: 200, body: { step: 'password' } }
                : { status: 404, body: { message: `桩没有 ${path}` } };
        return new Response(JSON.stringify(out.body), { status: out.status, headers: { 'content-type': 'application/json' } });
      }),
    );
    const passed: string[] = [];
    mountGate(document.getElementById('gate')!, (m) => passed.push(String(m.step)));
    await flush();

    (document.getElementById('password') as HTMLInputElement).value = 'p@ss';
    document.getElementById('loginForm')!.dispatchEvent(new Event('submit'));
    await flush();
    expect(seen.at(-1)).toEqual({ url: '/gate/login', body: { password: 'p@ss' } }); // 空 totp 不留键

    expect(document.getElementById('gateTitle')?.textContent).toContain('同意');
    (document.getElementById('agreeCheckbox') as HTMLInputElement).checked = true;
    document.getElementById('agreeCheckbox')!.dispatchEvent(new Event('change'));
    (document.getElementById('consentSubmit') as HTMLButtonElement).click();
    await flush();
    expect(seen.at(-1)).toEqual({ url: '/gate/consent', body: { version: 'sha256:read-once' } });
    expect(document.getElementById('gateTitle')?.textContent).toContain('修改密码');

    // 两闸全过：交出主界面，而不是再画一次门禁屏
    document.body.innerHTML = '<div id="gate"></div>';
    stubFetch(() => ({ status: 200, body: { step: 'app' } }));
    mountGate(document.getElementById('gate')!, (m) => passed.push(String(m.step)));
    await flush();
    expect(passed).toContain('app');
    expect(document.getElementById('gateTitle')).toBeNull();
  });

  it('条款版本不符（409）时不再让人拿旧 version 反复撞：只留"重取条款"这一条路', async () => {
    document.body.innerHTML = '<div id="gate"></div>';
    const seen: Array<{ url: string; body: any }> = [];
    let version = 'sha256:V1';
    let attempted = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: string, init?: RequestInit) => {
        seen.push({ url: path, body: init?.body ? JSON.parse(String(init.body)) : null });
        // 上游在我们撞了一次 409 之后才把条款换到 V2：重读时必须端出新的那一份
        if (path === '/gate/consent') attempted += 1;
        if (path === '/gate/state' && attempted > 0) version = 'sha256:V2';
        const out =
          path === '/gate/state'
            ? { status: 200, body: { step: 'consent', version, documents: [{ id: 'eula', title: '用户协议', text: '正文' }] } }
            : path === '/gate/consent'
              ? { status: 409, body: { step: 'consent', currentVersion: 'sha256:V2', message: '版本不符' } }
              : { status: 404, body: { message: `桩没有 ${path}` } };
        return new Response(JSON.stringify(out.body), { status: out.status, headers: { 'content-type': 'application/json' } });
      }),
    );
    mountGate(document.getElementById('gate')!, () => {});
    await flush();
    (document.getElementById('agreeCheckbox') as HTMLInputElement).checked = true;
    document.getElementById('agreeCheckbox')!.dispatchEvent(new Event('change'));
    (document.getElementById('consentSubmit') as HTMLButtonElement).click();
    await flush();

    // 409 之后：提交按钮与勾选框一并撤掉，屏上只剩重取 —— 手里那份版本已经不作数了
    expect(document.getElementById('consentSubmit')).toBeNull();
    expect(document.getElementById('agreeCheckbox')).toBeNull();
    const reload = document.getElementById('consentReload');
    expect(reload).not.toBeNull();
    expect(document.getElementById('gate')?.textContent).not.toContain('上游没有给出任何条款文档');

    reload!.click();
    await flush();
    expect(document.getElementById('consentSubmit')).not.toBeNull();
    (document.getElementById('agreeCheckbox') as HTMLInputElement).checked = true;
    document.getElementById('agreeCheckbox')!.dispatchEvent(new Event('change'));
    (document.getElementById('consentSubmit') as HTMLButtonElement).click();
    await flush();
    expect(seen.at(-1)).toEqual({ url: '/gate/consent', body: { version: 'sha256:V2' } });
  });

  it('relogin 步渲染"密码已修改"；点击返回登录后，手里那份 version 被清空且不被 merge 复活', async () => {
    document.body.innerHTML = '<div id="gate"></div>';
    const seen: Array<{ url: string; body: any }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: string, init?: RequestInit) => {
        const body = init?.body ? JSON.parse(String(init.body)) : null;
        seen.push({ url: path, body });
        const out =
          path === '/gate/state'
            ? { status: 200, body: { step: 'relogin' } }
            : path === '/gate/login'
              ? // 故意不带 version：改密会作废旧会话，新会话的条款 version 必须由服务端重新下发；
                // 若客户端从旧 model 把 version merge 回来，这里上行的就是上一会话的残值
                { status: 200, body: { step: 'consent', documents: [{ id: 'eula', title: '用户协议', text: '正文' }] } }
              : path === '/gate/consent'
                ? { status: 200, body: { step: 'app' } }
                : { status: 404, body: { message: `桩没有 ${path}` } };
        return new Response(JSON.stringify(out.body), { status: out.status, headers: { 'content-type': 'application/json' } });
      }),
    );
    const passed: string[] = [];
    mountGate(document.getElementById('gate')!, (m) => passed.push(String(m.step)));
    await flush();
    expect(document.getElementById('gateTitle')?.textContent).toContain('密码已修改');
    expect(document.getElementById('reloginButton')).not.toBeNull();
    expect(document.getElementById('gate')?.textContent).toContain('重新登录');

    (document.getElementById('reloginButton') as HTMLButtonElement).click();
    await flush();
    expect(document.getElementById('gateTitle')?.textContent).toContain('登录实例'); // 回到登录屏
    expect(document.getElementById('reloginButton')).toBeNull();

    // 重新登录 → 直接落到同意屏（响应不带 version）→ 同意时上行的 version 必须是清空后的那一份
    (document.getElementById('password') as HTMLInputElement).value = 'p@ss';
    document.getElementById('loginForm')!.dispatchEvent(new Event('submit'));
    await flush();
    expect(seen.at(-1)?.url).toBe('/gate/login');
    (document.getElementById('agreeCheckbox') as HTMLInputElement).checked = true;
    document.getElementById('agreeCheckbox')!.dispatchEvent(new Event('change'));
    (document.getElementById('consentSubmit') as HTMLButtonElement).click();
    await flush();
    expect(seen.at(-1)).toEqual({ url: '/gate/consent', body: { version: '' } });
    expect(passed).toContain('app');
  });

  it('strength 请求 250ms 去抖：窗口内连续两次输入只发一次 /gate/strength，发的是最后一次输入', async () => {
    vi.useFakeTimers();
    try {
      document.body.innerHTML = '<div id="gate"></div>';
      const seen: string[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (path: string, init?: RequestInit) => {
          seen.push(path + ' ' + String(init?.body ?? ''));
          const body = path === '/gate/state' ? { step: 'password', rules: [] } : { rules: [], valid: true };
          return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
        }),
      );
      mountGate(document.getElementById('gate')!, () => {});
      await vi.advanceTimersByTimeAsync(0); // 让挂载时的 /gate/state 落地
      const strengthCalls = () => seen.filter((x) => x.startsWith('/gate/strength')).length;
      expect(strengthCalls()).toBe(0);

      const np = document.getElementById('newPassword') as HTMLInputElement;
      np.value = 'a';
      np.dispatchEvent(new Event('input'));
      np.value = 'ab'; // 250ms 窗口内的第二次输入：把前一次的定时器顶掉
      np.dispatchEvent(new Event('input'));
      await vi.advanceTimersByTimeAsync(249);
      expect(strengthCalls()).toBe(0); // 去抖窗口还没走完，一次都不许发
      await vi.advanceTimersByTimeAsync(1);
      expect(strengthCalls()).toBe(1); // 只发一次
      expect(seen.find((x) => x.startsWith('/gate/strength'))).toContain('"ab"'); // 且是最后一次输入
      expect(seen.find((x) => x.startsWith('/gate/strength'))).not.toContain('"a"');

      np.value = 'abc'; // 窗口走完后再敲：又是一个完整去抖周期
      np.dispatchEvent(new Event('input'));
      await vi.advanceTimersByTimeAsync(250);
      expect(strengthCalls()).toBe(2);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it('strength 上游失败只落在强度位：正在敲的新口令不被整屏重绘抹掉', async () => {
    document.body.innerHTML = '<div id="gate"></div>';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: string) => {
        const body = path === '/gate/state' ? { step: 'password', rules: [] } : { success: false, message: '强度服务不在场' };
        return new Response(JSON.stringify(body), { status: path === '/gate/state' ? 200 : 500, headers: { 'content-type': 'application/json' } });
      }),
    );
    try {
      mountGate(document.getElementById('gate')!, () => {});
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      const np = document.getElementById('newPassword') as HTMLInputElement;
      np.value = '正在敲的口令abc';
      np.dispatchEvent(new Event('input'));
      await new Promise((r) => setTimeout(r, 300)); // 过去抖窗口，strength 请求发出并失败
      // 失败腿只更新强度位；apply 的整屏重绘会把 input 清空——这里是它的回归网
      expect((document.getElementById('newPassword') as HTMLInputElement).value).toBe('正在敲的口令abc');
      expect(document.getElementById('gateTitle')?.textContent ?? '').toContain('修改密码'); // 仍在 password 屏
      expect(document.getElementById('strengthValid')?.textContent).toContain('强度查询失败');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('unknown 屏的"显式继续"要经服务端记账（POST /gate/acknowledge），不是本地遮羞', async () => {
    document.body.innerHTML = '<div id="gate"></div>';
    const seen: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: string) => {
        seen.push(path);
        const body =
          path === '/gate/state'
            ? { step: 'unknown', message: '读不到' }
            : { step: 'app', message: '已由操作者显式认下' };
        return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      }),
    );
    const passed: string[] = [];
    mountGate(document.getElementById('gate')!, () => passed.push('app'));
    await flush();
    expect(document.getElementById('gateAck')).not.toBeNull();
    (document.getElementById('gateAck') as HTMLButtonElement).click();
    await flush();
    expect(seen).toContain('/gate/acknowledge');
    expect(passed).toEqual(['app']);
  });
});
