// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
import { describe, expect, it, vi } from 'vitest';
import { OPERATIONS, UpstreamError, createUpstream, unwrap, validateBaseUrl } from '../demo/server/upstream.js';
import { getStatus, login } from '../generated/typescript/sdk.gen.js';

/**
 * 假 fetch：记录请求并返回预置响应。这是 hey-api `Config.fetch` 注入缝，无需真实例。
 * 实测生成的 client 用**单个 Request 对象**调 `_fetch(request)`（client.gen.ts:101），
 * 所以这里直接收 Request，把 Request → (url, init) 的读取放在测试侧（生产装配不拆参）。
 * 同时保留收到的 Request 实例本身（calls[].request），用于证明 signal 等字段未被拆掉。
 */
function recordingFetch(handler: (url: string, init?: RequestInit) => { status: number; body: unknown }) {
  const calls: { url: string; init?: RequestInit; request: Request }[] = [];
  const fetchImpl = (async (input: Request) => {
    const body = await input.text();
    const init: RequestInit = { method: input.method, headers: input.headers, body: body || undefined };
    calls.push({ url: input.url, init, request: input });
    const r = handler(input.url, init);
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe('upstream', () => {
  it('生成客户端可被注入的 fetch 驱动；登录后 token 与 auth 同步', async () => {
    const f = recordingFetch(() => ({ status: 200, body: { success: true, token: 'T-1', mustChangePassword: false } }));
    const u = createUpstream('http://127.0.0.1:5099', f.fetchImpl);
    expect(u.token).toBeNull();
    const res = unwrap(await login({ client: u.client, body: { password: 'p' } }));
    u.authenticate('T-1');
    expect(res).toMatchObject({ success: true, mustChangePassword: false });
    expect(u.token).toBe('T-1');
    expect(f.calls[0].url).toBe('http://127.0.0.1:5099/api/login'); // 装配处是唯一允许 URL 断言的地方
    // 正向钉住认证转发：登录后 authenticate 的 token 必须作为 Bearer 头进入后续请求，
    // 否则下面的 signOut"头不存在"断言会静默变成永真（头转发一旦被弄坏也测不出）。
    await getStatus({ client: u.client });
    const authed = new Headers(f.calls.at(-1)!.init!.headers as Headers);
    expect(authed.get('authorization')).toBe('Bearer T-1');
  });
  it('unwrap 把非 2xx 折成带状态码与错误体的 UpstreamError（默认不抛 ⇒ 不折就等于丢掉 403 的两个键）', async () => {
    const f = recordingFetch(() => ({ status: 403, body: { success: false, message: '请先修改密码', mustChangePassword: true } }));
    const u = createUpstream('http://127.0.0.1:5099', f.fetchImpl);
    let caught: UpstreamError | null = null;
    try {
      unwrap(await login({ client: u.client, body: { password: 'p' } }));
    } catch (e) {
      caught = e as UpstreamError;
    }
    expect(caught).toBeInstanceOf(UpstreamError);
    expect(caught!.status).toBe(403);
    expect(caught!.body).toMatchObject({ mustChangePassword: true });
    expect(caught!.message).toBe('请先修改密码');
  });
  it('unwrap 的 message 兜底：错误体非对象（无 message 键）⇒ "上游返回 N"，不因读 body.message 崩', async () => {
    const f = recordingFetch(() => ({ status: 500, body: 'proxy error page' }));
    const u = createUpstream('http://127.0.0.1:5099', f.fetchImpl);
    let caught: UpstreamError | null = null;
    try {
      unwrap(await login({ client: u.client, body: { password: 'p' } }));
    } catch (e) {
      caught = e as UpstreamError;
    }
    expect(caught).toBeInstanceOf(UpstreamError);
    expect(caught!.status).toBe(500);
    expect(caught!.message).toBe('上游返回 500');
  });
  it('unwrap 对 200 但 success:false 的分支不误判为异常（needsTotp 走的是 200）', () => {
    expect(unwrap({ data: { success: false, needsTotp: true }, response: { status: 200 } as Response })).toEqual({
      success: false,
      needsTotp: true,
    });
  });
  it('unwrap 对 2xx 空体回 null，而不是抛"形状不符"', () => {
    expect(unwrap({ data: undefined, response: { status: 204 } as Response })).toBeNull();
  });
  it('signOut 后不再带 authorization', async () => {
    const f = recordingFetch(() => ({ status: 200, body: { success: true } }));
    const u = createUpstream('http://127.0.0.1:5099', f.fetchImpl);
    u.authenticate('T-2');
    u.signOut();
    await getStatus({ client: u.client });
    const headers = new Headers((f.calls.at(-1)?.init?.headers ?? {}) as Record<string, string>);
    expect(headers.get('authorization')).toBeNull();
    expect(u.token).toBeNull();
  });
  it('注入的 fetch 收到生成客户端构造的那个 Request，signal 原样可见（要用它中断 SSE）', async () => {
    const f = recordingFetch(() => ({ status: 200, body: { success: true } }));
    const u = createUpstream('http://127.0.0.1:5099', f.fetchImpl);
    const controller = new AbortController();
    await getStatus({ client: u.client, signal: controller.signal });
    const request = f.calls.at(-1)!.request;
    // 拆参/重组会产出**新的** Request 且丢掉 signal；透明直通 ⇒ 收到的就是客户端建的那个实例本身。
    expect(request).toBeInstanceOf(Request);
    // undici 的 Request 会派生一个内部 AbortSignal（非同一实例），但仍活连着源：
    // 断言 signal 存在且 abort 能传播过去，正是用 options.signal 中断 SSE 的前提。
    expect(request.signal).toBeInstanceOf(AbortSignal);
    expect(request.signal.aborted).toBe(false);
    controller.abort();
    expect(request.signal.aborted).toBe(true);
  });
  it('setBaseUrl 与 token 同进同退（换目标 = 旧会话必然作废）', () => {
    const u = createUpstream('http://127.0.0.1:5099', recordingFetch(() => ({ status: 200, body: {} })).fetchImpl);
    u.authenticate('T-3');
    u.setBaseUrl('http://127.0.0.1:5299/');
    expect(u.baseUrl).toBe('http://127.0.0.1:5299');
    expect(u.token).toBeNull();
    expect(u.password).toBeNull();
  });
  it('SNOWLUMA_STRICT_SSRF=1 把目标收到公网：环回/私网/链路局部一律拒（classifyHost 的边界）', async () => {
    // STRICT_SSRF 在模块装载时读 env，所以必须 resetModules + 动态 import 才测得到那一支。
    // 这条是全仓唯一的 SSRF 面：demo 的 fetch 目标由操作者输入，严格模式要能钉住类别边界。
    const had = Object.prototype.hasOwnProperty.call(process.env, 'SNOWLUMA_STRICT_SSRF');
    const prev = process.env.SNOWLUMA_STRICT_SSRF;
    process.env.SNOWLUMA_STRICT_SSRF = '1';
    let strictValidate: ((raw: string) => string) | undefined;
    try {
      vi.resetModules();
      strictValidate = (await import('../demo/server/upstream.js')).validateBaseUrl;
    } finally {
      if (had) process.env.SNOWLUMA_STRICT_SSRF = prev;
      else delete process.env.SNOWLUMA_STRICT_SSRF;
    }
    const denied = [
      'http://127.0.0.1:5099', // loopback
      'http://localhost:5099', // loopback（*.localhost 同支）
      'http://[::1]:5099', // loopback v6（hostname 带方括号，剥不掉就落到 public）
      'http://[fd00::1]:5099', // 唯一本地 fc00::/7
      'http://[fe80::1]:5099', // 链路局部 fe80::/10
      'http://10.0.0.5:5099', // private
      'http://192.168.31.10:5099', // private
      'http://172.16.0.1:5099', // private 下界
      'http://169.254.1.1:5099', // link-local
      'http://[::ffff:127.0.0.1]:5099', // IPv4-mapped IPv6 → loopback（不剥前缀就落 public，SSRF 被绕过）
      'http://[::ffff:10.0.0.5]:5099', // IPv4-mapped IPv6 → private
      'http://[::ffff:169.254.1.1]:5099', // IPv4-mapped IPv6 → link-local
      'http://[::7f00:1]:5099', // IPv4-compatible（RFC 4291 已废弃形）→ loopback，设计口径登记的残余已收拢
      'http://[64:ff9b::127.0.0.1]:5099', // NAT64 well-known 前缀内嵌环回 → loopback（第五轮登记残余）
      'http://[64:ff9b::a00:5]:5099', // NAT64 内嵌 10.0.0.5（hex 归一形）→ private
    ];
    for (const url of denied) {
      expect(() => strictValidate!(url), url).toThrow(/严格模式/);
    }
    // 类别边界的另一侧：172.15 不属于私网段，公网目标与公网 IPv6 在严格模式下仍要放行
    expect(strictValidate('http://example.com:5099')).toBe('http://example.com:5099');
    expect(strictValidate('http://172.15.0.1:5099')).toBe('http://172.15.0.1:5099');
    expect(strictValidate('http://[2001:db8::1]:5099')).toBe('http://[2001:db8::1]:5099');
    // NAT64 内嵌公网地址按内嵌 IPv4 分类（收拢不能过宽：8.8.8.8 走 64:ff9b 仍是公网）
    expect(strictValidate('http://[64:ff9b::808:808]:5099')).toBe('http://[64:ff9b::808:808]:5099');

    // 同一批 URL 在非严格模式下必须放行 —— 否则上面那条断言可能只是因为整条链都抛错而"通过"
    vi.resetModules();
    const loose = (await import('../demo/server/upstream.js')).validateBaseUrl;
    for (const url of denied) {
      expect(loose(url), url).toBe(url);
    }
  });

  it('validateBaseUrl 拒协议与 userinfo、去尾斜杠、默认放行环回/私网', () => {
    expect(() => validateBaseUrl('ftp://x:21')).toThrow(/协议/);
    expect(() => validateBaseUrl('http://u:p@127.0.0.1')).toThrow(/userinfo/);
    expect(validateBaseUrl('http://192.168.1.5:5099/')).toBe('http://192.168.1.5:5099');
  });
  it('OPERATIONS 是 spec 单源且恰 55 条', () => {
    expect(OPERATIONS).toHaveLength(55);
    expect(new Set(OPERATIONS).size).toBe(55);
  });

  it('传输层失败在 unwrap 这一处就把 cause 拼进 message（下游只读 e.message）', () => {
    // 生成的 client 在网络层失败时 resolve 出 { error: TypeError }，`response` 缺席 ⇒ status 0。
    // 只折 error.message 的话，操作者与测试拿到的永远是 "fetch failed" —— bad port、ECONNREFUSED、
    // TLS 全被抹成同一句。demo-stream-live 偶发红三次查不出根因，断点就在这。
    const netErr = Object.assign(new Error('fetch failed'), { cause: new Error('bad port') });
    const err = (() => {
      try {
        unwrap({ error: netErr });
      } catch (e) {
        return e as UpstreamError;
      }
      throw new Error('unwrap 竟然没抛');
    })();
    expect(err).toBeInstanceOf(UpstreamError);
    expect(err.status).toBe(500);
    expect(err.message).toBe('fetch failed ← bad port');

    // 反向半边：上游正常的错误体不许被顺手改写（拼错的那一半会把上游文案污染掉）
    const plain = new UpstreamError(403, { message: '请先修改密码', mustChangePassword: true });
    expect(plain.message).toBe('请先修改密码');
  });
});
