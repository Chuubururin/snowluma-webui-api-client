// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
// @vitest-environment happy-dom
/**
 * L3：调试页的浏览器侧闭环。专抓 L2 够不着的那一类：路由回的形状对、界面读错键 /
 * 把动作层的失败画成成功 / 二次确认根本没有出口。
 *
 * 三条本屏特有的形状必须在这里钉住（都在 task-11-addendum.md 里）：
 *  · `readOnly` 是安全信息 ⇒ 非只读动作**第一次点击只出确认层，不发请求**；
 *  · 参数的键名是 `name`、说明是 `desc`，`default` 是 unknown ⇒ 选择器出下拉但不自动填值；
 *  · invoke 的 200 里可能是 `{status:'failed'}` ⇒ 页面显示的是那句 message，不是"调用成功"。
 *
 * 下拉的当前值按 `selected` **属性**断言，不按 `.value`（happy-dom 从 innerHTML 建 select 时
 * 会把 selectedIndex 落到第二个 option，见 carry-notes 13）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PARITY } from '../demo/parity.js';
import { mountDebug, renderActionList, renderInvokeResult, renderParamForm } from '../demo/client/pages/debug.js';

const ACTIONS = {
  actions: [
    {
      name: 'get_group_list',
      aliases: ['ggl'],
      category: 'group',
      summary: '取群列表',
      readOnly: true,
      stream: false,
      params: [
        { name: 'group_id', type: 'number', required: false, desc: '群号', values: [1, 2], role: 'group' },
        { name: 'timeout', type: 'number', required: true, desc: '超时毫秒', default: 5000 },
      ],
    },
    {
      name: 'set_group_ban',
      aliases: [],
      category: 'group',
      summary: '禁言群成员',
      readOnly: false,
      stream: false,
      params: [{ name: 'user_id', type: 'number', required: true, desc: '被禁成员' }],
    },
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
  categories: [
    { category: 'group', count: 12 },
    { category: 'events', count: 2 },
  ],
};

const ACCOUNTS = { list: [{ uin: 10001, nickname: '夹具小号' }, { uin: 10002 }] };

type Reply = { status?: number; body?: unknown };

function stub(overrides: Record<string, Reply> = {}) {
  const seen: Array<{ url: string; method: string; body: any }> = [];
  const table: Record<string, Reply> = {
    'GET /debug-actions': { body: { data: ACTIONS } },
    'GET /config/accounts': { body: { data: ACCOUNTS } },
    'POST /debug-invoke': { body: { data: { status: 'ok', retcode: 0, data: { list: [{ id: 7 }] }, message: '执行完成' } } },
    'POST /debug-upload': { body: { data: { status: 'ok', path: '/tmp/snowluma/upload/t.json', size: 9 } } },
    ...overrides,
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      const pathname = String(path).split('?')[0];
      seen.push({ url: String(path), method, body: init?.body ? JSON.parse(String(init.body)) : null });
      const out = table[`${method} ${pathname}`] ?? { status: 404, body: { success: false, message: `桩没有 ${method} ${pathname}` } };
      return new Response(JSON.stringify(out.body ?? {}), {
        status: out.status ?? 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  return seen;
}

async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}

function host(): HTMLElement {
  document.body.innerHTML = '<div id="panel"></div>';
  return document.getElementById('panel')!;
}

const q = (sel: string) => document.querySelector(sel) as HTMLElement | null;
const ctl = (name: string) => q(`[data-ctl="${name}"]`);
const text = (name: string) => ctl(name)?.textContent ?? '';
const byData = (attr: string) => document.querySelector(`[${attr}]`) as HTMLElement | null;

async function pickFile(scopeSel: string, name: string, contents: string): Promise<void> {
  const input = document.querySelector(scopeSel) as HTMLInputElement | null;
  if (!input) throw new Error(`夹具里没有 ${scopeSel}`);
  Object.defineProperty(input, 'files', { value: [new File([contents], name)], configurable: true });
  input.dispatchEvent(new Event('change', { bubbles: true }));
  await flush(3);
}

describe('mountDebug 目录 / 确认 / 结果三闭环', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('控件名单与 parity 的 debug 边逐字一致', async () => {
    const want = PARITY.filter((e) => e.panel === 'debug').flatMap((e) => e.controls);
    stub();
    const mounted = mountDebug(host());
    await flush();
    const got = [...document.querySelectorAll('[data-ctl]')].map((el) => el.getAttribute('data-ctl'));
    expect([...new Set(got)].sort()).toEqual([...new Set(want)].sort());
    mounted.destroy();
  });

  it('目录到货：分类计数用 categories（不是自己数 actions），readOnly 与 stream 都显示出来', async () => {
    stub();
    const mounted = mountDebug(host());
    await flush();
    const t = text('debugActionList');
    expect(t).toContain('group 12'); // categories 给的计数，不是 actions 里那两条
    expect(t).toContain('events 2');
    expect(t).toContain('只读');
    expect(t).toContain('会改状态');
    expect(t).toContain('流式');
    // 名称与摘要各归各的键，读错就是一片空白
    expect(t).toContain('get_group_list');
    expect(t).toContain('取群列表');
    mounted.destroy();
  });

  it('参数表单按 name/desc/values 出控件：有 values 的是下拉，default 不自动填进框里', async () => {
    stub();
    const mounted = mountDebug(host());
    await flush();
    byData('data-action="get_group_list"')!.click();
    await flush();
    const form = text('debugParamForm');
    expect(form).toContain('群号'); // desc，不是 description
    expect(form).toContain('必填');
    const sel = document.querySelector('[data-param="group_id"]') as HTMLSelectElement | null;
    expect(sel).not.toBeNull();
    expect([...sel!.options].map((o) => o.value)).toEqual(['', '1', '2']);
    expect(sel!.selectedOptions[0].value).toBe(''); // default 没被拿来预填
    const num = document.querySelector('[data-param="timeout"]') as HTMLInputElement | null;
    expect(num!.type).toBe('number');
    expect(num!.value).toBe('');
    mounted.destroy();
  });

  it('非只读动作：第一次点击只出确认层且零请求，第二次点击才真的上行（含 uin/action）', async () => {
    const f = stub();
    const mounted = mountDebug(host());
    await flush();
    byData('data-action="set_group_ban"')!.click();
    await flush();
    (document.querySelector('[data-param="user_id"]') as HTMLInputElement).value = '20002';
    const before = f.length;
    byData('data-invoke')!.click();
    await flush(3);
    expect(f.length).toBe(before); // 一次都没出网
    expect(text('invokeConfirmButton')).toContain('确认');
    byData('data-invoke-confirm')!.click();
    await flush();
    const sent = f.filter((s) => s.url.startsWith('/debug-invoke')).pop();
    expect(sent?.body).toEqual({ uin: '10001', action: 'set_group_ban', params: { user_id: 20002 } });
    mounted.destroy();
  });

  it('只读动作一步就发，不等第二次点击；uin 取自账号列表的选择器', async () => {
    const f = stub();
    const mounted = mountDebug(host());
    await flush();
    byData('data-action="get_group_list"')!.click();
    await flush();
    (document.querySelector('[data-param="timeout"]') as HTMLInputElement).value = '3000';
    byData('data-invoke')!.click();
    await flush();
    expect(f.filter((s) => s.url.startsWith('/debug-invoke'))).toHaveLength(1);
    expect(f.filter((s) => s.url.startsWith('/debug-invoke')).pop()?.body).toEqual({
      uin: '10001',
      action: 'get_group_list',
      params: { timeout: 3000 },
    });
    // 选择器的第一项来自账号列表真值，不是手填的猜测
    const uin = document.querySelector('[data-ctl="debugUinSelect"] select') as HTMLSelectElement;
    expect([...uin.options].map((o) => o.value)).toEqual(['10001', '10002']);
    mounted.destroy();
  });

  it('缺必填参数 ⇒ 表单报错且不出网（number 型空串不算 0）', async () => {
    const f = stub();
    const mounted = mountDebug(host());
    await flush();
    byData('data-action="get_group_list"')!.click();
    await flush();
    const before = f.length;
    byData('data-invoke')!.click();
    await flush(3);
    expect(f.length).toBe(before);
    expect(text('debugParamForm')).toContain('timeout');
    expect(text('debugParamForm')).toContain('必填的参数还没给');
    mounted.destroy();
  });

  it('invoke 的 200 里 status:failed ⇒ 页面显示的是那句 message，不写"调用成功"', async () => {
    stub({ 'POST /debug-invoke': { body: { data: { status: 'failed', message: 'action 未注册', retcode: 1400 } } } });
    const mounted = mountDebug(host());
    await flush();
    byData('data-action="get_group_list"')!.click();
    await flush();
    (document.querySelector('[data-param="timeout"]') as HTMLInputElement).value = '3000';
    byData('data-invoke')!.click();
    await flush();
    const t = text('invokeButton');
    expect(t).toContain('action 未注册');
    expect(t).toContain('failed');
    expect(t).toContain('1400');
    expect(t).not.toContain('调用成功');
    mounted.destroy();
  });

  it('成功支：status/retcode/message 齐显，data 走结构化视图且原文只在折叠里', async () => {
    stub();
    const mounted = mountDebug(host());
    await flush();
    byData('data-action="get_group_list"')!.click();
    await flush();
    (document.querySelector('[data-param="timeout"]') as HTMLInputElement).value = '3000';
    byData('data-invoke')!.click();
    await flush();
    const t = text('invokeButton');
    expect(t).toContain('ok');
    expect(t).toContain('执行完成');
    expect(t).toContain('id'); // data.list[0] 的键名以结构化方式出现
    expect(q('#debugInvokeRaw')?.querySelector('details')).not.toBeNull();
    expect(ctl('invokeButton')!.querySelector('pre')).toBeNull(); // 不是裸 JSON dump
    mounted.destroy();
  });

  it('stream:true 的动作不走 REST 那条：/debug-invoke 零请求，改开一条动作流', async () => {
    // 那版这里是"拒发并说明该走流式页"，接上流之后，拒发就不是终点了：
    // 界面上必须真的有一条流被开起来（否则就是"给了个不能用的按钮"）。
    const f = stub();
    const mounted = mountDebug(host());
    await flush();
    byData('data-action="stream_events"')!.click();
    await flush();
    const invokeCalls = f.filter((s) => s.url.startsWith('/debug-invoke')).length;
    byData('data-invoke')!.click();
    await flush(3);
    expect(f.filter((s) => s.url.startsWith('/debug-invoke'))).toHaveLength(invokeCalls);
    expect(f.some((s) => s.url === '/events/action')).toBe(true);
    expect(text('invokeButton')).toContain('REST 那条没发');
    mounted.destroy();
  });

  it('上传：选了文件才可用，成功后 path 与 size 都上屏且 size 不是 NaN', async () => {
    const f = stub();
    const mounted = mountDebug(host());
    await flush();
    const btn = byData('data-debug-upload') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    await pickFile('[data-ctl="traceUploadPicker"] input', 'trace.json', '{"a":1}');
    expect((byData('data-debug-upload') as HTMLButtonElement).disabled).toBe(false);
    byData('data-debug-upload')!.click();
    await flush();
    const t = text('traceUploadPicker');
    expect(t).toContain('/tmp/snowluma/upload/t.json');
    expect(t).toContain('9');
    expect(t).not.toMatch(/NaN|undefined/);
    const sent = f.filter((s) => s.url.startsWith('/debug-upload')).pop();
    expect(sent?.body.filename).toBe('trace.json');
    // MIME 不是契约的一部分（上游收的是原始字节流，文件名才在 query 上）：
    // happy-dom 的 File 没类型 ⇒ dataURL 前缀是 octet-stream，真浏览器按文件给出 json。
    // 所以钉"是 base64 data URI"与"解出来的字节就是原文件"，不钉那个随环境变的 MIME。
    expect(sent?.body.dataUrl).toMatch(/^data:[^,;]+;base64,/);
    expect(Buffer.from(String(sent?.body.dataUrl).split('base64,')[1], 'base64').toString('utf8')).toBe('{"a":1}');
    mounted.destroy();
  });

  it('账号那条读挂了只影响选择器格子：目录照常到货，选择器明写没读到', async () => {
    stub({ 'GET /config/accounts': { status: 500, body: { success: false, message: '账号列表读不到' } } });
    const mounted = mountDebug(host());
    await flush();
    expect(text('debugUinSelect')).toContain('账号列表读不到');
    expect(text('debugActionList')).toContain('get_group_list');
    mounted.destroy();
  });

  it('目录那条读挂了只影响目录格子，别的格子照常', async () => {
    stub({ 'GET /debug-actions': { status: 502, body: { success: false, message: '动作目录读不到预期形状' } } });
    const mounted = mountDebug(host());
    await flush();
    expect(text('debugActionList')).toContain('动作目录读不到预期形状');
    expect(document.querySelectorAll('[data-ctl="debugActionList"] [data-action]')).toHaveLength(0);
    expect((document.querySelector('[data-ctl="traceUploadPicker"] input') as HTMLInputElement)).not.toBeNull();
    mounted.destroy();
  });

  it('debugStreamFeed 的格子现在就存在并明写还没接流（只换数据来源）', async () => {
    stub();
    const mounted = mountDebug(host());
    await flush();
    expect(ctl('debugStreamFeed')).not.toBeNull();
    expect(text('debugStreamFeed')).toContain('流式');
    mounted.destroy();
  });

  it('每个表单控件都有 id 且有 label[for] 指向它（浏览器走查报的"无标签字段"缺陷）', async () => {
    stub();
    const mounted = mountDebug(host());
    await flush();
    byData('data-action="get_group_list"')!.click();
    await flush();
    const fields = [...document.querySelectorAll('#panel select, #panel input')] as Array<
      HTMLInputElement | HTMLSelectElement
    >;
    expect(fields.length).toBeGreaterThanOrEqual(3); // 两个参数 + uin 选择器 + 文件框
    for (const el of fields) {
      expect(el.id, `${el.getAttribute('data-param') ?? el.type} 没有 id`).toBeTruthy();
      const label = document.querySelector(`label[for="${el.id}"]`);
      expect(label, `控件 ${el.id} 没有关联的 label`).not.toBeNull();
      expect((label as HTMLElement).textContent!.trim().length).toBeGreaterThan(0);
    }
    mounted.destroy();
  });

  it('destroy 之后不再有请求（面板被门禁顶回时不许继续撞）', async () => {
    const f = stub();
    const mounted = mountDebug(host());
    await flush();
    byData('data-action="get_group_list"')!.click();
    await flush();
    (document.querySelector('[data-param="timeout"]') as HTMLInputElement).value = '1';
    mounted.destroy();
    const before = f.length;
    byData('data-invoke')!.click();
    await flush(3);
    expect(f.length).toBe(before);
  });

  it('纯函数：目录渲染给 category 缺席的动作写"未分类"而不是留空（读错键与没数据要分得开）', () => {
    const html = renderActionList({
      catalog: {
        actions: [{ name: 'x', aliases: [], readOnly: true, stream: false, params: [] }],
        categories: [{ category: 'group', count: 1 }],
      },
      selected: null,
      accounts: null,
      result: null,
      invokeError: null,
      notices: {},
      errors: {},
      busy: {},
      uploading: null,
      pickedFile: null,
    } as any);
    expect(html).toContain('x');
    expect(html).toContain('未给分类');
    expect(html).not.toContain('undefined');
  });

  it('纯函数：结果视图缺 retcode 就整段不写，而不是显示"retcode 空"', () => {
    const html = renderInvokeResult({ status: 'ok', data: { a: 1 }, message: 'm' } as any, {} as any);
    expect(html).toContain('retcode'); // 有标签区
    expect(html).not.toContain('undefined');
  });

  it('纯函数：参数表单对未知 type 仍出输入框并明写类型（不静默丢参数）', () => {
    const html = renderParamForm(
      { name: 'z', type: 'weird', required: false, desc: '怪类型' } as any,
      { value: '' },
    );
    expect(html).toContain('data-param="z"');
    expect(html).toContain('怪类型');
    expect(html).toContain('weird');
  });
});
