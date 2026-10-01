// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
// @vitest-environment happy-dom
/**
 * L3：配置页的取数闭环（fetch 桩，不真起服务端）。
 *
 * 这一层专门钉 L2 结构上够不着的那类缺陷——**路由回的形状对、客户端读错了键**：
 *  · global / notifications 两条 GET 的 `data` 是 `{config:…}` 包装（spec `:2528-2548`、`:2450-2470`），
 *    当成本体用的话表单永远空白且不报错，正是设计口径那一类"永远显示占位符"；
 *  · 一份读挂掉不许拖垮整屏（四份读各自独立失败）；
 *  · 点保存/点测试的回显必须活过下一次重绘——存在 model 里，而不是只写进一次性 DOM。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mountConfig } from '../demo/client/pages/config.js';

type Reply = { status: number; body: unknown };
/** demo 路由的成功体一律是 `{data:…}`（`ok({data})`），桩必须照这个形状回，否则拆包路径没被走到。 */
const R = (data: unknown, status = 200): Reply => ({ status, body: { data } });

const ACCOUNTS = R({ list: [{ uin: '10001', nickname: '夹具小号' }, { uin: '10002', nickname: '另一个' }] });
const GLOBAL = R({ config: { musicSignUrl: 'http://sign.local:9000', rkey: { fallbackServers: ['http://rkey-a', 'http://rkey-b'] } } });
const NOTIFICATIONS = R({
  config: {
    debounceSeconds: 7,
    channels: [{ id: 'c1', name: '运维群', type: 'webhook', enabled: true, url: 'http://hook.local', bodyTemplate: '{msg}' }],
  },
});
const RECENT = R([{ time: 1790000000000, uin: '10001', event: 'message_sent', channelId: 'c1', ok: true, status: 200 }]);
const ONEBOT = R({
  networks: {
    httpServers: [{ name: 's1', messageFormat: 'array', reportSelfMessage: false, host: '0.0.0.0', port: 3050, path: '/onebot' }],
    httpClients: [],
    wsServers: [],
    wsClients: [],
  },
  statusCommand: { enabled: true, swallow: false, cooldownSeconds: 60, trigger: '#sl' },
  historySync: { enabled: false },
});

const flush = () => new Promise((r) => setTimeout(r, 0));

/** 默认表按 `METHOD 路径（不含 query）` 命中；overrides 同键覆盖，未命中的回 404。 */
function makeTable(overrides: Record<string, Reply> = {}): Record<string, Reply> {
  return {
    'GET /config/accounts': ACCOUNTS,
    'GET /globalconfig': GLOBAL,
    'POST /globalconfig': R({ success: true, config: GLOBAL.body }),
    'GET /notifications-config': NOTIFICATIONS,
    'POST /notifications-config': R({ success: true, config: NOTIFICATIONS.body }),
    'GET /notifications-recent': RECENT,
    'GET /onebot-config': ONEBOT,
    'POST /onebot-config': R({ success: true, saved: true, applied: true, online: true, reloaded: true, errors: [], message: '已保存并重载' }),
    'POST /notifications-test': R({ success: true, status: 200, message: '已送达' }),
    ...overrides,
  };
}

interface Call {
  url: string;
  method: string;
  body: any;
}

function stub(table: Record<string, Reply>) {
  const seen: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      const [pathname, query] = String(path).split('?');
      seen.push({ url: path, method, body: init?.body ? JSON.parse(String(init.body)) : null });
      const out = table[`${method} ${pathname}`] ?? { status: 404, body: { success: false, message: `桩没有 ${method} ${pathname}` } };
      // 每个键只生效一次之后再回默认，便于"先读后写"的用例分段控制
      return new Response(JSON.stringify(out.body), { status: out.status, headers: { 'content-type': 'application/json' } });
    }),
  );
  return { seen, table };
}

async function open(overrides: Record<string, Reply> = {}) {
  document.body.innerHTML = '<div id="panel"></div>';
  const f = stub(makeTable(overrides));
  const handle = mountConfig(document.getElementById('panel')!);
  // loadAll 四条读并发，之后串一条 oneBot 读；多冲几轮把微任务跑完
  await flush();
  await flush();
  await flush();
  return { ...f, handle };
}

/** 换掉桩但保留同一个 handle：用于"页面已画好，之后的请求换个回包"。 */
function retarget(overrides: Record<string, Reply>) {
  const f = stub(makeTable(overrides));
  return f;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const input = (sel: string) => document.querySelector(sel) as HTMLInputElement;
const click = (sel: string) => (document.querySelector(sel) as HTMLButtonElement).click();

describe('mountConfig 取数闭环（happy-dom + fetch 桩）', () => {
  it('读到 {config} 包装就拆包：全局配置与通知渠道的字段真的落到控件上', async () => {
    const { handle } = await open();
    expect(input('[data-field="musicSignUrl"]').value).toBe('http://sign.local:9000');
    expect(document.querySelectorAll('[data-field^="rkey.fallbackServers"]').length).toBe(2);
    expect(input('[data-field="debounceSeconds"]').value).toBe('7');
    expect(document.querySelector('.channelItem[data-channel-id="c1"]')).not.toBeNull();
    expect(input('[data-field="channels[0].name"]').value).toBe('运维群');
    expect(document.body.textContent).toContain('成功'); // 投递记录里那条 ok:true
    handle.destroy();
  });

  it('账号列表非空就自动选第一个并接着读它那份 OneBot 配置；端口值落到控件上', async () => {
    const { seen, handle } = await open();
    expect(seen.some((s) => s.url === '/onebot-config?uin=10001')).toBe(true);
    expect(input('[data-field="networks.httpServers[0].port"]').value).toBe('3050');
    // 选定账号后保存按钮必须可用（没账号时它是 disabled）
    expect((document.querySelector('[data-save="onebot"]') as HTMLButtonElement).disabled).toBe(false);
    handle.destroy();
  });

  it('一份读挂掉不拖垮整屏：通知配置 500 时全局表单照样 filled，错误明写在通知段', async () => {
    const { handle } = await open({ 'GET /notifications-config': { status: 500, body: { success: false, message: '上游炸了' } } });
    expect(input('[data-field="musicSignUrl"]').value).toBe('http://sign.local:9000');
    const section = document.querySelector('[data-ctl="notificationChannelEditor"]')!;
    expect(section.textContent).toContain('500 上游炸了');
    // 读失败的那一段不能伪装成"上游说这里是空的"
    expect(section.textContent).toContain('还没读到');
    expect(section.textContent).not.toContain('上游返回的渠道列表为空');
    // 空骨架上点保存＝整段覆盖成零渠道 ⇒ 按钮必须禁用
    expect((document.querySelector('[data-save="notifications"]') as HTMLButtonElement).disabled).toBe(true);
    handle.destroy();
  });

  it('存在性核的 404 要说到位：拒绝文案落在 OneBot 段，空骨架继续禁保存', async () => {
    const { handle } = await open({
      'GET /onebot-config': {
        status: 404,
        body: {
          success: false,
          message:
            '账号 10001 不在上游 qq-list（在线实例）里，它的 OneBot 配置既不读也不写：' +
            '上游对未知 uin 会返回全局默认配置，其中 accessToken 是一个真实随机 token，demo 不呈现那份东西',
        },
      },
    });
    const section = document.querySelector('[data-ctl="onebotAccountPicker"]')!;
    expect(section.textContent).toContain('不在上游 qq-list');
    // 被拒不等于"这个账号没有网络条目"：整份覆盖的空骨架一旦可点就是把四类网络全删了
    expect(section.textContent).toContain('OneBot 配置未读取');
    expect((document.querySelector('[data-save="onebot"]') as HTMLButtonElement).disabled).toBe(true);
    handle.destroy();
  });

  it('点保存只上行页面上这份配置（partial patch），并且回显"已保存"', async () => {
    const { seen, handle } = await open();
    input('[data-field="musicSignUrl"]').value = 'http://sign.local:9999';
    const before = seen.length;
    click('[data-save="global"]');
    await flush();
    await flush();
    expect(seen.slice(before)).toEqual([
      {
        url: '/globalconfig',
        method: 'POST',
        body: { patch: { musicSignUrl: 'http://sign.local:9999', rkey: { fallbackServers: ['http://rkey-a', 'http://rkey-b'] } } },
      },
    ]);
    expect(document.querySelector('[data-ctl="globalConfigForm"]')!.textContent).toContain('已保存');
    handle.destroy();
  });

  it('保存回包的 config 覆盖表单：显示的是服务端归一化后的那份，不是我提交前那份', async () => {
    const { seen, handle } = await open({
      'POST /globalconfig': R({ success: true, config: { musicSignUrl: 'http://server.normalized', rkey: { fallbackServers: [] } } }),
    });
    input('[data-field="musicSignUrl"]').value = 'http://typed.by.me';
    const before = seen.length;
    click('[data-save="global"]');
    await flush();
    await flush();
    expect(seen.length).toBe(before + 1);
    expect(input('[data-field="musicSignUrl"]').value).toBe('http://server.normalized');
    expect(document.querySelectorAll('[data-field^="rkey.fallbackServers"]').length).toBe(0);
    handle.destroy();
  });

  it('点"发一条测试通知"的回显活过整屏重绘：换账号重读之后仍在', async () => {
    const { seen, handle } = await open();
    const before = seen.length;
    click('[data-test-channel="c1"]');
    await flush();
    await flush();
    expect(seen[before]).toEqual({ url: '/notifications-test', method: 'POST', body: { channelId: 'c1' } });
    expect(document.querySelector('.channelItem[data-channel-id="c1"]')!.textContent).toContain('测试成功');

    // 失败回包 + 一次全量重绘（点"读取该账号配置"会 paint 整屏）：结果若只活在旧节点里就被抹掉
    retarget({ 'POST /notifications-test': R({ success: false, status: 502, message: '渠道未响应' }) });
    click('[data-test-channel="c1"]');
    await flush();
    await flush();
    click('[data-load-onebot]');
    await flush();
    await flush();
    expect(document.querySelector('.channelItem[data-channel-id="c1"]')!.textContent).toContain('渠道未响应');
    expect(document.querySelector('.channelItem[data-channel-id="c1"]')!.textContent).toContain('502');
    handle.destroy();
  });

  it('200 但 applied:false 的保存回显说"未生效"，同时四类网络仍在（改完能再存）', async () => {
    const { seen, handle } = await open({
      'POST /onebot-config': R({
        success: true,
        saved: true,
        applied: false,
        online: false,
        reloaded: false,
        errors: [{ name: 's1' }],
        message: '端口被占用',
      }),
    });
    const before = seen.length;
    click('[data-save="onebot"]');
    await flush();
    await flush();
    expect(seen.length).toBe(before + 1);
    const picker = document.querySelector('[data-ctl="onebotAccountPicker"]')!;
    expect(picker.textContent).toContain('未生效');
    expect(picker.textContent).toContain('端口被占用');
    expect(picker.querySelector('[data-ctl="onebotHttpServer"]')).not.toBeNull();
    handle.destroy();
  });

  it('编辑网络条目后上行的补丁保持完整路径：嵌套在 networks 下，顶层不出现剥前缀的 httpServers', async () => {
    const { seen, handle } = await open();
    input('[data-field="networks.httpServers[0].port"]').value = '3077';
    input('[data-field="historySync.enabled"]').checked = true;
    const before = seen.length;
    click('[data-save="onebot"]');
    await flush();
    await flush();
    const patch = seen[before].body.patch as Record<string, any>;
    expect(Object.keys(patch).sort()).toEqual(['historySync', 'networks', 'statusCommand']);
    expect(patch.networks.httpServers[0].port).toBe(3077);
    expect(patch.historySync).toEqual({ enabled: true });
    // 剥前缀会把同一份配置拆成两套键（旧 networks + 新 httpServers），上游只认前者 ⇒ 编辑静默不生效
    expect(patch.httpServers).toBeUndefined();
    expect(patch.enabled).toBeUndefined();

    // 通知渠道同理：channels 是数组，元素带 id（整段覆盖时原样回传）
    const b2 = seen.length;
    click('[data-save="notifications"]');
    await flush();
    await flush();
    const npatch = seen[b2].body.patch as Record<string, any>;
    expect(npatch.debounceSeconds).toBe(7);
    expect(npatch.channels).toEqual([
      { id: 'c1', name: '运维群', type: 'webhook', enabled: true, url: 'http://hook.local', bodyTemplate: '{msg}' },
    ]);
    handle.destroy();
  });

  it('结构按钮真的改列表：新增/删除网络条目，且不丢未保存的编辑', async () => {
    const { seen, handle } = await open();
    expect(document.querySelectorAll('[data-net="wsServers"]').length).toBe(0); // 夹具里 wsServers 是空的
    input('[data-field="networks.httpServers[0].name"]').value = '改过没保存';
    click('[data-add-net="wsServers"]');
    await flush();
    expect(document.querySelectorAll('[data-net="wsServers"]').length).toBe(1);
    // 上一次编辑活在 DOM 上；重绘前必须收回 model，否则这点字被旧值盖掉
    expect(input('[data-field="networks.httpServers[0].name"]').value).toBe('改过没保存');
    // 新行按 kind 给形状：wsServers 有 role/host/port/path，不该有 clients 才有的 url
    expect(input('[data-field="networks.wsServers[0].name"]').value).toBe('');
    // 下拉的当前值读 `selected` **属性**而不是 `.value`：happy-dom 从 innerHTML 建 select 时把
    // selectedIndex 落在第二个 option（真浏览器落在带 selected 的那个），所以 .value 在这里不算证据
    const roleSel = document.querySelector('[data-field="networks.wsServers[0].role"]') as HTMLSelectElement;
    expect([...roleSel.options].filter((o) => o.hasAttribute('selected')).map((o) => o.value)).toEqual(['Universal']);
    expect(document.querySelector('[data-field="networks.wsServers[0].port"]')).not.toBeNull();
    expect(document.querySelector('[data-field="networks.wsServers[0].url"]')).toBeNull();
    click('[data-remove-net="wsServers:0"]');
    await flush();
    expect(document.querySelectorAll('[data-net="wsServers"]').length).toBe(0);
    expect(input('[data-field="networks.httpServers[0].name"]').value).toBe('改过没保存');
    // 删到零行时补丁里仍要有这一类（空数组），否则服务端合并会保留旧的 ⇒ "删除"静默失效
    const b = seen.length;
    click('[data-save="onebot"]');
    await flush();
    await flush();
    const sent = seen[b].body.patch as Record<string, any>;
    expect(sent.networks.wsServers).toEqual([]);
    expect(sent.networks.httpServers[0].name).toBe('改过没保存');
    handle.destroy();
  });

  it('渠道增删与类型切换：切到 email 要长出 SMTP 六件套（否则选了也没地方填）', async () => {
    const { handle } = await open();
    expect(document.querySelectorAll('.channelItem').length).toBe(1);
    click('[data-add-channel]');
    await flush();
    const items = document.querySelectorAll('.channelItem');
    expect(items.length).toBe(2);
    const second = items[1] as HTMLElement;
    const secondId = second.getAttribute('data-channel-id');
    expect(secondId).toBeTruthy();
    expect(secondId).not.toBe('c1'); // 空 id 会被上游按"缺 channelId"处理，新渠道必须自带不重复的 id
    expect(second.querySelector('[data-field="channels[1].url"]')).not.toBeNull();
    const typeSel = second.querySelector('[data-field="channels[1].type"]') as HTMLSelectElement;
    typeSel.value = 'email';
    typeSel.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();
    for (const f of ['smtpHost', 'smtpPort', 'smtpSecure', 'smtpUser', 'smtpPass', 'from', 'to', 'subjectTemplate']) {
      expect(document.querySelector(`[data-field="channels[1].${f}"]`), `切到 email 后缺 ${f}`).not.toBeNull();
    }
    expect(document.querySelector('[data-field="channels[1].url"]')).toBeNull();
    click('[data-remove-channel="1"]');
    await flush();
    expect(document.querySelectorAll('.channelItem').length).toBe(1);
    handle.destroy();
  });

  it('rkey 兜底服务器列表可增可删（空列表＝关闭，但不能只能减不能加）', async () => {
    const { handle } = await open();
    expect(document.querySelectorAll('[data-field^="rkey.fallbackServers"]').length).toBe(2);
    click('[data-add-rkey]');
    await flush();
    expect(document.querySelectorAll('[data-field^="rkey.fallbackServers"]').length).toBe(3);
    expect(input('[data-field="rkey.fallbackServers[2]"]').value).toBe('');
    click('[data-remove-rkey="0"]');
    await flush();
    const rows = [...document.querySelectorAll('[data-field^="rkey.fallbackServers"]')].map((e) => (e as HTMLInputElement).value);
    expect(rows).toEqual(['http://rkey-b', '']);
    handle.destroy();
  });

  it('没读到配置的那一段不画"新增"：保存是禁的，新增按钮就是死键', async () => {
    const { handle } = await open({ 'GET /onebot-config': { status: 500, body: { success: false, message: '配置读不到' } } });
    expect(document.querySelectorAll('[data-add-net]').length).toBe(0);
    // 整份覆盖的写：没读到整份配置就不许点（点下去是"把四类网络全删了"）
    expect((document.querySelector('[data-save="onebot"]') as HTMLButtonElement).disabled).toBe(true);
    // 四类骨架仍在（少了才是设计口径的"没出口"）
    const ctls = [...document.querySelectorAll('[data-ctl]')].map((e) => e.getAttribute('data-ctl'));
    expect(ctls.filter((c) => String(c).startsWith('onebot')).sort()).toEqual(['onebotAccountPicker', 'onebotHttpClient', 'onebotHttpServer', 'onebotWsClient', 'onebotWsServer']);
    expect(input('[data-field="musicSignUrl"]').value).toBe('http://sign.local:9000');
    handle.destroy();
  });

  it('读挂掉时保存按钮不许让人撞：没有账号 ⇒ onebot 保存 disabled，补丁不会被发出', async () => {
    const { seen, handle } = await open({ 'GET /config/accounts': { status: 502, body: { success: false, message: '账号读不到' } } });
    expect((document.querySelector('[data-save="onebot"]') as HTMLButtonElement).disabled).toBe(true);
    const before = seen.length;
    click('[data-save="onebot"]');
    await flush();
    await flush();
    expect(seen.length).toBe(before); // 没有 uin 就不该有 POST
    expect(document.querySelector('[data-ctl="onebotAccountPicker"]')!.textContent).toContain('账号读不到');
    handle.destroy();
  });
});
