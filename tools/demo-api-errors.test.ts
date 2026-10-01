// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
/**
 * api.ts `call()` 的错误形态三分支：此前只测过"错误体是 JSON 且带 step"的形状
 * （demo-gate-signal.test.ts），网关/反代在前面挡一道时回的是 502 + HTML 文本、
 * 空响应体、乃至 fetch 直接 reject —— 这三条路调用方各会拿到什么，之前没有任何测试钉过。
 * 断言全部照 api.ts 实码（非 JSON 文本走 `text.slice(0,200)` 进消息、raw 包进 body；
 * 空体解析为 null；fetch 的异常原样向上），不凭想象造形状。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, call, onGateSignal } from '../demo/client/api.js';

describe('call() 的错误形态三分支', () => {
  afterEach(() => {
    // 本文件不动门禁监听以外的模块状态，onGateSignal(null) 是 api.ts 给测试留的复位口
    onGateSignal(null);
    vi.unstubAllGlobals();
  });

  it('502 + 非 JSON 文本体 ⇒ ApiError 带原文消息与 { raw } 体，不把网关页折成"HTTP 502"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>Bad Gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } })),
    );
    const got: Array<{ step: string; message: string }> = [];
    onGateSignal((s) => got.push(s));
    const e = (await call('/logs').catch((x: unknown) => x)) as ApiError;
    expect(e).toBeInstanceOf(ApiError);
    expect(e.status).toBe(502);
    expect(e.message).toContain('Bad Gateway');
    expect(e.body).toEqual({ raw: '<html>Bad Gateway</html>' });
    // 非 JSON 体解析不出 step：不许凭空造一个门禁信号
    expect(got).toEqual([]);
  });

  it('200 + 空响应体 ⇒ 解析为 null（"没有正文"是合法形状，不许变成异常或 { raw: "" }）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })));
    await expect(call('/anything')).resolves.toBeNull();
  });

  it('fetch 直接 reject ⇒ 异常原样向上，message 保留失败原因', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed: ECONNREFUSED 127.0.0.1:5099');
      }),
    );
    const e = (await call('/logs').catch((x: unknown) => x)) as TypeError;
    expect(e).toBeInstanceOf(TypeError);
    expect(e.message).toContain('ECONNREFUSED');
    // 不被折成 ApiError：网络层的失败和业务层的非 2xx 是两回事
    expect(e.name).toBe('TypeError');
  });
});
