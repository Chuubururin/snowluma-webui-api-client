// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
// @vitest-environment happy-dom
/**
 * L3：日志页的取数与下载闭环（fetch 桩）。
 * 专抓 L2 够不着的那一类：路由回的形状对、客户端读错键 / 2xx 被丢 / 下载文件名在浏览器里才对上。
 * 下拉的当前值按 `selected` **属性**断言，不按 `.value` —— happy-dom 从 innerHTML 建 select 时
 * 会把 selectedIndex 落到第二个 option（真浏览器落在带 selected 的那个），见 carry-notes 13。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mountLogs } from '../demo/client/pages/logs.js';

const LEVELS = ['trace', 'debug', 'info', 'success', 'warn', 'error'];
const ENTRY = { id: 7, time: '2026-09-28T10:00:00.000Z', level: 'warn', scope: 'onebot', message: '心跳超时', line: '…', uin: 10001 };
const EXPORT_BODY = [
  'SnowLuma full TRACE export',
  '==========================',
  'SnowLuma version: 1.14.20',
  'Operating system: win32',
  'Architecture: x64',
  'Node.js version: v24.18.0',
  'Current log level: INFO',
  'Export time: 2026-09-28T14:03:22.481Z',
  'Retained records: 1',
  '',
  'Logs',
  '----',
  '心跳超时的原文行',
].join('\n');

interface Call {
  url: string;
  method: string;
  body: any;
}

type Reply = { status?: number; body?: unknown; text?: string };

function stub(overrides: Record<string, Reply> = {}) {
  const seen: Call[] = [];
  const table: Record<string, Reply> = {
    'GET /logs': { body: { data: [ENTRY], limit: 300 } },
    'GET /loglevel': { body: { data: { level: 'info', levels: LEVELS } } },
    'POST /loglevel': { body: { data: { level: 'debug', levels: LEVELS } } },
    // 注意这一条的键形：text/plain 只存在于"上游 → demo 服务端"那一段（L2 测的就是那段）；
    // 浏览器拿到的是 demo 自己的 JSON 信封 `{data:{text,filename,summary}}`，文件名已由服务端拼好。
    'GET /export-trace': {
      body: {
        data: {
          text: EXPORT_BODY,
          filename: 'snowluma-trace-2026-09-28T14-03-22.log',
          summary: { 'SnowLuma version': '1.14.20', 'Operating system': 'win32', 'Export time': '2026-09-28T14:03:22.481Z' },
        },
      },
    },
    ...overrides,
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      const pathname = String(path).split('?')[0];
      seen.push({ url: path, method, body: init?.body ? JSON.parse(String(init.body)) : null });
      const out = table[`${method} ${pathname}`] ?? { status: 404, body: { success: false, message: `桩没有 ${method} ${pathname}` } };
      const payload = out.text !== undefined ? out.text : JSON.stringify(out.body ?? {});
      const status = out.status ?? 200;
      return new Response(payload, { status, headers: { 'content-type': out.text !== undefined ? 'text/plain' : 'application/json' } });
    }),
  );
  return seen;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

async function open(overrides: Record<string, Reply> = {}) {
  document.body.innerHTML = '<div id="panel"></div>';
  const seen = stub(overrides);
  const handle = mountLogs(document.getElementById('panel')!);
  await flush();
  await flush();
  await flush();
  return { seen, handle };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const g = (sel: string) => document.querySelector(sel) as HTMLElement;
const click = (sel: string) => g(sel).click();

describe('mountLogs 取数与下载闭环', () => {
  it('两条读各自落地：表格用 list 里的行，级别下拉的选项来自 levels', async () => {
    const { seen, handle } = await open();
    expect(seen.some((s) => s.url === '/logs?limit=300')).toBe(true);
    expect(g('[data-ctl="logTable"]').textContent).toContain('心跳超时');
    expect(g('[data-ctl="logTable"]').textContent).toContain('uin 10001');
    const sel = g('#logLevelSelect') as HTMLSelectElement;
    expect([...sel.options].map((o) => o.value)).toEqual(LEVELS);
    expect([...sel.options].filter((o) => o.hasAttribute('selected')).map((o) => o.value)).toEqual(['info']);
    expect(g('[data-ctl="logStreamFeed"]')).not.toBeNull(); // 的格子现在就位在
    handle.destroy();
  });

  it('列表读挂掉不拖垮级别：表格明写"还没读到"，下拉仍有全部选项', async () => {
    const { handle } = await open({ 'GET /logs': { status: 502, body: { success: false, message: '日志服务无响应' } } });
    const table = g('[data-ctl="logTable"]');
    expect(table.textContent).toContain('502 日志服务无响应');
    expect(table.textContent).toContain('还没读到');
    // 没读到 ≠ 上游说没有日志：不能写成"当前无保留日志"
    expect(table.textContent).not.toContain('当前无保留日志');
    expect((g('#logLevelSelect') as HTMLSelectElement).options.length).toBe(6);
    handle.destroy();
  });

  it('空列表要说"无保留日志"，与"没读到"是两句话', async () => {
    const { handle } = await open({ 'GET /logs': { body: { data: [], limit: 300 } } });
    expect(g('[data-ctl="logTable"]').textContent).toContain('当前无保留日志');
    handle.destroy();
  });

  it('改 limit 后点重读：新的 limit 上行（含 query 里的字符串值）', async () => {
    const { seen, handle } = await open();
    (g('#logLimit') as HTMLInputElement).value = '77';
    const before = seen.length;
    click('[data-reload-logs]');
    await flush();
    await flush();
    expect(seen[before].url).toBe('/logs?limit=77');
    handle.destroy();
  });

  it('应用级别回显生效后的那一档，并说清"当前会话生效、不持久化"', async () => {
    const { seen, handle } = await open();
    const before = seen.length;
    (g('#logLevelSelect') as HTMLSelectElement).value = 'debug';
    click('[data-apply-level]');
    await flush();
    await flush();
    expect(seen[before]).toEqual({ url: '/loglevel', method: 'POST', body: { level: 'debug' } });
    const sec = g('[data-ctl="levelSelect"]');
    expect(sec.textContent).toContain('已切到 debug');
    expect(sec.textContent).toContain('当前会话生效');
    expect(sec.textContent).not.toContain('已保存'); // 写盘的是 global/notifications，级别不写盘
    expect([...(g('#logLevelSelect') as HTMLSelectElement).options].filter((o) => o.hasAttribute('selected')).map((o) => o.value)).toEqual(['debug']);
    handle.destroy();
  });

  it('非法级别 400：显示上游 message，并用回传的 levels 把下拉重新填满', async () => {
    const { handle } = await open({
      'GET /loglevel': { body: { data: { level: 'info', levels: LEVELS } } },
      'POST /loglevel': { status: 400, body: { message: 'level 必须是六值之一', levels: LEVELS } },
    });
    click('[data-apply-level]');
    await flush();
    await flush();
    const sec = g('[data-ctl="levelSelect"]');
    expect(sec.textContent).toContain('400 level 必须是六值之一');
    expect((g('#logLevelSelect') as HTMLSelectElement).options.length).toBe(6);
    handle.destroy();
  });

  it('导出：文件名取正文里的 Export time，摘要进页面，正文不进页面', async () => {
    const { seen, handle } = await open();
    const downloads: string[] = [];
    document.addEventListener(
      'click',
      (e) => {
        const a = e.target as HTMLElement;
        if (a instanceof HTMLAnchorElement && a.download) downloads.push(a.download);
      },
      true,
    );
    const before = seen.length;
    click('[data-export-trace]');
    await flush();
    await flush();
    expect(seen[before].url).toBe('/export-trace');
    expect(downloads).toEqual(['snowluma-trace-2026-09-28T14-03-22.log']);
    const sec = g('[data-ctl="traceExportButton"]');
    expect(sec.textContent).toContain('1.14.20');
    expect(sec.textContent).toContain('snowluma-trace-2026-09-28T14-03-22.log');
    expect(sec.textContent).not.toContain('心跳超时的原文行'); // 原文只进下载，不 dump 到页面
    handle.destroy();
  });

  it('正文里没有 Export time 时文件名显示"未给出"，但仍完成下载（不拿本地时间冒充）', async () => {
    const { handle } = await open({
      'GET /export-trace': {
        body: { data: { text: 'Logs\n----\n只有一行', filename: null, summary: {}, filenameNote: '导出正文里没有 Export time 行，文件名未给出（不代造）' } },
      },
    });
    const downloads: string[] = [];
    document.addEventListener(
      'click',
      (e) => {
        const a = e.target as HTMLElement;
        if (a instanceof HTMLAnchorElement && a.download) downloads.push(a.download);
      },
      true,
    );
    click('[data-export-trace]');
    await flush();
    await flush();
    const sec = g('[data-ctl="traceExportButton"]');
    expect(sec.textContent).toContain('未给出');
    expect(downloads).toEqual(['snowluma-trace.log']);
    handle.destroy();
  });

  it('destroy 之后回来的响应不许再画（切 tab 会重挂，旧请求晚到要能被丢弃）', async () => {
    const { handle } = await open();
    const rootBefore = g('#panel').innerHTML;
    handle.destroy();
    click('[data-reload-logs]');
    await flush();
    await flush();
    expect(g('#panel').innerHTML).toBe(rootBefore);
  });
});
