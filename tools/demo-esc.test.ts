// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
// @vitest-environment happy-dom
/**
 * XSS 回归网：上游字段会经 esc() 插进 innerHTML（logs 的 message、overview 的 lastError、
 * gate 的条款正文……），而此前**没有任何测试**喂过恶意串——任何一处删掉 esc() 全套件照样绿。
 * 两层各钉一面：纯函数钉五个实体的转义形状（引号也在内，属性位逃逸才真正被堵住）；
 * 挂载层钉"上游数据进 DOM 后不产生元素"——转义形状对不对由上一层保证，
 * "数据真的经过了它"只有真 DOM 能证明。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { esc } from '../demo/client/ui.js';
import { mountLogs } from '../demo/client/pages/logs.js';

const EVIL = '<img src=x onerror=alert(1)>';

describe('esc 的转义形状', () => {
  it('五个实体逐字对应，引号也转义（属性位逃逸堵在源头）', () => {
    expect(esc('<>&"\'')).toBe('&lt;&gt;&amp;&quot;&#39;');
  });

  it('非字符串与空值安全：数字、null、undefined 都走 String() 不抛', () => {
    expect(esc(42)).toBe('42');
    expect(esc(null)).toBe('');
    expect(esc(undefined)).toBe('');
  });
});

describe('挂载层：上游字段里的 HTML 不许活下来', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('日志 message 带标签 ⇒ DOM 里没有 img/script 元素，原文以实体出现在表格里', async () => {
    document.body.innerHTML = '<div id="panel"></div>';
    const seen: Array<{ url: string; method: string }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: string, init?: RequestInit) => {
        seen.push({ url: path, method: (init?.method ?? 'GET').toUpperCase() });
        const body = {
          data: [{ id: 1, time: '2026-09-30T00:00:00.000Z', level: 'warn', scope: EVIL, message: `${EVIL}"><script>alert(1)</script>`, line: '…', uin: 10001 }],
          limit: 300,
        };
        return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      }),
    );
    const handle = mountLogs(document.getElementById('panel')!);
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    const table = document.querySelector('[data-ctl="logTable"]') as HTMLElement;
    // 文本内容可读（真实信息不丢）
    expect(table.textContent).toContain('alert(1)');
    // 但不产生任何元素：转义后的形状以实体留在 innerHTML 里
    expect(table.querySelector('img')).toBeNull();
    expect(table.querySelector('script')).toBeNull();
    expect(table.innerHTML).toContain('&lt;img src=x');
    expect(table.innerHTML).toContain('&lt;script&gt;');
    handle.destroy();
    vi.unstubAllGlobals();
  });
});
