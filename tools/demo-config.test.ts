// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
/**
 * L2：节点配置页（global / onebot / notifications）路由 + 纯渲染函数。
 *
 * 键形逐条读自 spec（carry-notes 10：编一个上游没有的键 ⇒ L2 全绿 + 真实例上永远显示占位符）：
 *  · OneBotConfig 是 `{networks:{httpServers,httpClients,wsServers,wsClients},statusCommand,historySync,notifications?}`
 *    （spec `:1143-1156`，实码 `onebot/src/types.ts:119-129`）——**没有 `enable`、没有 `networkList`**
 *  · `messageFormat` 只认 `array|string`（`onebot/src/types.ts:24`；校验支 `config.ts:496-498`；`'CQ'` 全仓零命中）
 *  · `role` 只属 wsServers/wsClients（`WsRole`=`Api|Event|Universal`，`types.ts:25`）
 *  · `uin` 是 `^[0-9]{5,10}$`（spec `:2220-2226`，实码 `server.ts:236`）
 *  · saveOneBotConfig 的 200 是八键 `OneBotConfigSaveResult`，**applied:false = 落盘成但热重载崩**（`:592-611`）
 *  · notifications 的 GET 是 `{config}`、recent 是 `{recent}`（`:2462-2467`、`:2516-2524`），
 *    recent 的 `limit` 是**字符串** query 且上限 100（`:2510-2515`）
 *  · saveOneBotConfig / testNotificationChannel 是 t3 destructive；saveGlobalConfig / saveNotificationsConfig 是 t2 [persist]
 */
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { UIN_RE } from '../demo/server/upstream.js';
import {
  MESSAGE_FORMATS,
  NODE_ROLES,
  configRoutes,
  deepMerge,
} from '../demo/server/routes/config.js';
import {
  EMPTY_CONFIG,
  renderChannels,
  renderConfig,
  renderOneBotNetworks,
  renderRecentDeliveries,
  saveNotice,
  type ChannelRow,
  type DeliveryRow,
  type OneBotConfigShape,
} from '../demo/client/pages/config.js';
import { gateRoutes } from '../demo/server/routes/gates.js';
import { hit, statefulUpstream, type FakeUpstream } from './helpers/demo-http.js';

const routes = { ...gateRoutes, ...configRoutes };

const HTTP_SERVER = { name: 's1', messageFormat: 'array', reportSelfMessage: false, port: 3000 };
const WS_SERVER = { name: 'w1', messageFormat: 'array', reportSelfMessage: false, port: 3001, role: 'Universal' };

/** GET /api/config/:uin 的真形（十键里 networks/statusCommand/historySync 是 required）。 */
function oneBotFixture(): OneBotConfigShape {
  return {
    networks: {
      httpServers: [{ ...HTTP_SERVER }],
      httpClients: [],
      wsServers: [{ ...WS_SERVER }],
      wsClients: [],
    },
    statusCommand: { enabled: true, swallow: false, cooldownSeconds: 60, trigger: '#sl' },
    historySync: { enabled: false },
    notifications: { channelIds: ['c1'] },
  };
}

const SAVE_OK = {
  success: true,
  saved: true,
  applied: true,
  online: true,
  errors: [],
  config: oneBotFixture(),
  reloaded: true,
  message: '已保存并重载',
};

const CHANNEL: ChannelRow = {
  id: 'c1',
  name: '运维群',
  type: 'webhook',
  url: 'https://example/hook',
  bodyTemplate: '{text}',
  enabled: true,
};

const RECORD: DeliveryRow = { time: 1_767_000_000_000, uin: '10001', event: 'online', channelId: 'c1', ok: true, status: 200 };

/** 记账型假上游：默认全部 200，按路径覆盖；`seen` 用来钉"不许出网"。 */
function instance(overrides: Record<string, { status: number; body: unknown }> = {}) {
  const seen: string[] = [];
  const seenBodies: Array<{ path: string; body: any }> = [];
  const handler: FakeUpstream = async (path, init) => {
    const clean = path.split('?')[0] as string;
    seen.push(path);
    seenBodies.push({ path, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (overrides[clean]) return overrides[clean];
    if (clean === '/api/config/10001') {
      if (init?.method === 'GET') return { status: 200, body: { config: oneBotFixture() } };
      return { status: 200, body: SAVE_OK };
    }
    if (clean === '/api/global-config') {
      return { status: 200, body: { config: { rkey: { fallbackServers: [] }, musicSignUrl: '' } } };
    }
    if (clean === '/api/notifications/config') {
      return { status: 200, body: { config: { version: 3, debounceSeconds: 30, channels: [CHANNEL] } } };
    }
    if (clean === '/api/notifications/recent') return { status: 200, body: { recent: [RECORD] } };
    if (clean === '/api/notifications/test') return { status: 200, body: { success: true, message: '已送达' } };
    if (clean === '/api/qq-list') return { status: 200, body: { list: [{ uin: '10001', nickname: '夹具小号' }] } };
    return { status: 404, body: { success: false, message: `配置夹具没有 ${clean} 这条` } };
  };
  return { seen, seenBodies, u: statefulUpstream(handler) };
}

async function pastTheGate(u: ReturnType<typeof statefulUpstream>): Promise<void> {
  u.authenticate('TK-fixture');
  expect((await hit(u, routes, 'POST', '/gate/acknowledge', {})).json).toMatchObject({ step: 'app' });
}

describe('config (L2)', () => {
  it('整份覆盖：只编辑一段时，未编辑的各段与 UI 不暴露的 channelIds 必须原样上行', async () => {
    const f = instance();
    await pastTheGate(f.u);
    await hit(f.u, configRoutes, 'GET', '/onebot-config?uin=10001');
    const r = await hit(f.u, configRoutes, 'POST', '/onebot-config?uin=10001', {
      patch: { networks: { wsServers: [{ name: 'w1', messageFormat: 'string', reportSelfMessage: false, port: 3001, role: 'Event' }] } },
    });
    expect(r.status).toBe(200);
    const sent = f.seenBodies.filter((s) => s.path === '/api/config/10001' && s.body && s.body.networks).pop();
    expect(sent?.body).toMatchObject({
      networks: {
        httpServers: [{ name: 's1', messageFormat: 'array', port: 3000 }],
        wsServers: [{ name: 'w1', messageFormat: 'string', role: 'Event' }],
      },
      statusCommand: { trigger: '#sl' },
      historySync: { enabled: false },
      notifications: { channelIds: ['c1'] }, // declination notification-channel-ids：不给人编辑，但必须回传
    });
  });

  it('空 patch 是 400 不是 200：patchOf 对缺键/null/数组/空对象一律折 null，三条保存路由各拒一次且不出网', async () => {
    for (const route of ['/globalconfig', '/notifications-config', '/onebot-config?uin=10001']) {
      for (const body of [{}, { patch: null }, { patch: [] }, { patch: {} }]) {
        const f = instance();
        await pastTheGate(f.u);
        f.seen.length = 0;
        const r = await hit(f.u, configRoutes, 'POST', route, body as never);
        expect(r.status, `${route} body=${JSON.stringify(body)}`).toBe(400);
        expect(f.seen, `${route} body=${JSON.stringify(body)} 不许出网`).toEqual([]);
      }
    }
  });

  it('枚举用真值：messageFormat=array|string，role=Api|Event|Universal 且只属 ws* 条目；非法值 400 且不出网', async () => {
    const f = instance();
    await pastTheGate(f.u);
    const badPatches = [
      { networks: { httpServers: [{ name: 'x', messageFormat: 'CQ', reportSelfMessage: false, port: 1 }] } },
      { networks: { wsServers: [{ name: 'x', messageFormat: 'array', reportSelfMessage: false, port: 1, role: 'server' }] } },
      { networks: { httpClients: [{ name: 'x', messageFormat: 'array', reportSelfMessage: false, url: 'http://a', role: 'Api' }] } },
    ];
    for (const patch of badPatches) {
      f.seen.length = 0;
      const bad = await hit(f.u, configRoutes, 'POST', '/onebot-config?uin=10001', { patch });
      expect(bad.status, JSON.stringify(patch)).toBe(400);
      expect(f.seen, `非法枚举不许出网：${JSON.stringify(patch)}`).toEqual([]);
    }
    expect([...MESSAGE_FORMATS].sort()).toEqual(['array', 'string']);
    expect([...NODE_ROLES].sort()).toEqual(['Api', 'Event', 'Universal']);
  });

  it('uin 按上游 pattern 先拒（GET 与 POST 同一道核，非法值不出网）', async () => {
    const f = instance();
    await pastTheGate(f.u);
    for (const uin of ['1', 'abcd', '123456789012', '', '10001a']) {
      f.seen.length = 0;
      expect((await hit(f.u, configRoutes, 'GET', `/onebot-config?uin=${uin}`)).status, `GET uin=${uin}`).toBe(400);
      expect(
        (await hit(f.u, configRoutes, 'POST', `/onebot-config?uin=${uin}`, { patch: { historySync: { enabled: true } } })).status,
        `POST uin=${uin}`,
      ).toBe(400);
      expect(f.seen, `uin=${uin} 不许出网`).toEqual([]);
    }
    expect((await hit(f.u, configRoutes, 'GET', '/onebot-config?uin=10001')).status).toBe(200);
  });

  it('200 但 applied:false 不是"已生效"——落盘成、热重载崩要原样透传（spec :592-611）', async () => {
    const f = instance({
      '/api/config/10001': {
        status: 200,
        body: { ...SAVE_OK, applied: false, online: false, reloaded: false, errors: [{ name: 'w1' }], message: '重载失败' },
      },
    });
    await pastTheGate(f.u);
    const r = await hit(f.u, configRoutes, 'POST', '/onebot-config?uin=10001', { patch: { historySync: { enabled: true } } });
    expect(r.status).toBe(200);
    expect(r.json.data.applied).toBe(false);
    expect(saveNotice('onebot', r.json.data)).toContain('未生效');
    // 200 + applied:true 不许写成"未生效"，也不许只写"已保存"而丢掉 message
    expect(saveNotice('onebot', SAVE_OK)).toContain('已保存并重载');
    expect(saveNotice('onebot', { ...SAVE_OK, message: undefined })).toBe('已保存');
    expect(saveNotice('global', { ...SAVE_OK, applied: false })).not.toContain('未生效'); // applied 只属 onebot 保存结果
    // 报错时表单还在：applied:false 之后用户要能改完再存，不能只剩一条红字
    expect(renderOneBotNetworks({ networks: oneBotFixture().networks })).toContain('onebotWsServer');
  });

  it('通知历史读 recent 键（不是 list）；limit 是字符串、钳到 1..100 后原样带上行 query', async () => {
    const f = instance();
    await pastTheGate(f.u);
    const r = await hit(f.u, configRoutes, 'GET', '/notifications-recent?limit=20');
    expect(r.json.data).toHaveLength(1);
    expect(f.seen.some((p) => p.includes('/api/notifications/recent?limit=20'))).toBe(true);
    f.seen.length = 0;
    await hit(f.u, configRoutes, 'GET', '/notifications-recent?limit=9999');
    expect(f.seen.at(-1)).toContain('limit=100');
    f.seen.length = 0;
    await hit(f.u, configRoutes, 'GET', '/notifications-recent?limit=0');
    expect(f.seen.at(-1)).toContain('limit=100');
    f.seen.length = 0;
    await hit(f.u, configRoutes, 'GET', '/notifications-recent');
    expect(f.seen.at(-1)).toContain('limit=100');
  });

  it('两条 partial 保存直发补丁、不做本地 deepMerge；测试通知的 success 原样带出', async () => {
    const f = instance();
    await pastTheGate(f.u);
    await hit(f.u, configRoutes, 'POST', '/globalconfig', { patch: { musicSignUrl: 'http://a' } });
    const globalSent = f.seenBodies.filter((s) => s.path === '/api/global-config').pop();
    expect(globalSent?.body).toEqual({ musicSignUrl: 'http://a' }); // 只发这一格，别把整份读回来的 config 塞回去
    await hit(f.u, configRoutes, 'POST', '/notifications-config', { patch: { debounceSeconds: 5 } });
    const notifSent = f.seenBodies.filter((s) => s.path === '/api/notifications/config').pop();
    expect(notifSent?.body).toEqual({ debounceSeconds: 5 });
    const t = await hit(f.u, configRoutes, 'POST', '/notifications-test', { channelId: 'c1' });
    expect(t.json.data.success).toBe(true);
    expect(renderChannels({ channels: [CHANNEL], testResults: { c1: { success: true, message: '已送达' } }, loaded: true })).toContain('已送达');
    expect(renderChannels({ channels: [CHANNEL], testResults: { c1: { success: false, message: '渠道未响应' } }, loaded: true })).toContain('渠道未响应');
    // 没读到时不许写"渠道列表为空"——那是替上游做它没说过的断言
    expect(renderChannels({ channels: [], loaded: false })).toContain('还没读到');
    expect(renderChannels({ channels: [], loaded: false })).not.toContain('上游返回的渠道列表为空');
    expect(renderChannels({ channels: [], loaded: true })).toContain('上游返回的渠道列表为空');
  });

  it('上游错误保留状态码与文案：400 的枚举拒绝与 413 的体积上限不是一回事', async () => {
    for (const status of [400, 413, 500]) {
      const f = instance({ '/api/notifications/config': { status, body: { success: false, message: '渠道表非法' } } });
      await pastTheGate(f.u);
      const r = await hit(f.u, configRoutes, 'POST', '/notifications-config', { patch: { channels: [] } });
      expect(r.status, `status=${status}`).toBe(status);
      expect(String(r.json.message)).toContain('渠道表非法');
    }
  });

  it('九条路由都有第二道闸：门禁未过 403 且一条都不出网', async () => {
    const calls: Array<[string, string, unknown]> = [
      ['GET', '/globalconfig', undefined],
      ['POST', '/globalconfig', { patch: { musicSignUrl: '' } }],
      ['GET', '/onebot-config?uin=10001', undefined],
      ['POST', '/onebot-config?uin=10001', { patch: { historySync: { enabled: true } } }],
      ['GET', '/notifications-config', undefined],
      ['POST', '/notifications-config', { patch: { debounceSeconds: 1 } }],
      ['POST', '/notifications-test', { channelId: 'c1' }],
      ['GET', '/notifications-recent', undefined],
      ['GET', '/config/accounts', undefined],
    ];
    for (const [method, path, body] of calls) {
      const f = instance();
      f.u.authenticate('TK-fixture'); // 有会话，但没读过门禁状态、也没显式继续
      const r = await hit(f.u, routes, method, path, body);
      expect(r.status, `${method} ${path}`).toBe(403);
      expect(r.json, `${method} ${path}`).toMatchObject({ step: 'unknown' });
      expect(f.seen, `${method} ${path} 不许出网`).toEqual([]);
    }
  });

  it('上游那道真闸不能被折成"配置读取失败"：403 两键与门控 401 都交回门禁', async () => {
    const consent = { status: 403, body: { status: 'failed', message: '请先阅读并同意', consentRequired: true } };
    const mustChange = { status: 403, body: { status: 'failed', message: '请先修改密码', mustChangePassword: true } };
    const dead = { status: 401, body: { status: 'failed', message: 'Token expired or invalid' } };
    for (const [label, gate] of [['consent', consent], ['password', mustChange], ['401', dead]] as const) {
      const f = instance({
        '/api/global-config': gate,
        '/api/config/10001': gate,
        '/api/notifications/config': gate,
        '/api/notifications/recent': gate,
      });
      await pastTheGate(f.u);
      for (const path of ['/globalconfig', '/onebot-config?uin=10001', '/notifications-config', '/notifications-recent']) {
        const r = await hit(f.u, configRoutes, 'GET', path);
        expect(JSON.stringify(r.json), `${label} ${path} ⇒ 必须是门禁信号`).toContain('step');
      }
      if (label === '401') expect((await hit(f.u, configRoutes, 'GET', '/globalconfig')).status).toBe(401);
    }
  });

  it('deepMerge 只合并对象，数组与非对象整体替换', () => {
    expect(deepMerge({ a: { b: 1, c: [1, 2] } }, { a: { c: [3] } })).toEqual({ a: { b: 1, c: [3] } });
    expect(deepMerge({ a: 1 }, null)).toBe(null);
    expect(deepMerge(undefined, { a: 1 })).toEqual({ a: 1 });
  });

  it('deepMerge 拒绝 __proto__ / constructor / prototype 键（防原型污染）', () => {
    const base = { a: 1 };
    const malicious = JSON.parse('{"__proto__": {"polluted": true}, "constructor": {"polluted": true}, "prototype": {"polluted": true}, "a": 2}');
    const result = deepMerge(base, malicious);
    expect(result.a).toBe(2);
    expect(result).not.toHaveProperty('polluted');
    expect(({} as any).polluted).toBeUndefined();
    // 被拒键从产物自有键里消失（静默丢弃语义钉住）
    expect(Object.keys(result)).not.toContain('__proto__');
    expect(Object.keys(result)).not.toContain('constructor');
    expect(Object.keys(result)).not.toContain('prototype');
  });

  describe('渲染（纯函数，不碰 DOM）', () => {
    it('九处控件逐字挂 data-ctl（channelTestButton 挂在渠道上，没有渠道就没有可测的对象），且没有自由 JSON 文本框', () => {
      const html = renderConfig({
        ...EMPTY_CONFIG,
        accounts: [{ uin: '10001', nickname: '夹具小号' }],
        uin: '10001',
        notifications: { version: 3, debounceSeconds: 30, channels: [CHANNEL] },
        recent: [RECORD],
      });
      for (const ctl of ['globalConfigForm', 'onebotAccountPicker', 'onebotHttpServer', 'onebotHttpClient', 'onebotWsServer', 'onebotWsClient', 'notificationChannelEditor', 'channelTestButton', 'notificationHistory']) {
        expect(html, `缺 data-ctl="${ctl}"`).toContain(`data-ctl="${ctl}"`);
      }
      expect(html).not.toContain('name="rawJson"'); // 原始配置暴露的回归钉
      expect(html).not.toContain('<textarea'); // 结构化表单，不是 JSON 框
      // 空模型也不该把控件吞掉：四类网络与历史区都在，只是各写"没读到/暂无"
      const empty = renderConfig({ ...EMPTY_CONFIG });
      for (const ctl of ['onebotHttpServer', 'onebotWsClient', 'notificationChannelEditor', 'notificationHistory']) {
        expect(empty, `空模型缺 data-ctl="${ctl}"`).toContain(`data-ctl="${ctl}"`);
      }
    });

    it('四类网络的字段按 spec 分支：role 只出现在 ws*，port 只出现在 *Servers，url 只出现在 *Clients', () => {
      const html = renderOneBotNetworks({ networks: oneBotFixture().networks });
      expect(html).toContain('3000');
      expect(html).toContain('3001');
      expect(html).toContain('Universal');
      expect(html).toContain('messageFormat');
      // 夹具里只有一个 wsServers 条目、零个 wsClients 条目 ⇒ role 恰好出现一次；
      // 出现在 http 两类上就是发明字段（`onebot/src/types.ts:42-53` 没有 role）。
      // 渲染出的 data-field 是完整路径（networks.wsServers[0].role），所以匹配后缀段
      expect((html.match(/data-field="[^"]*\.role"/g) ?? [])).toHaveLength(1);
      expect((html.match(/data-field="[^"]*\.port"/g) ?? [])).toHaveLength(2); // httpServers + wsServers 各一个
      expect(html).not.toContain('data-ctl="onebotIntentFilter"'); // 缓存外无从确证的控件不实现
    });

    it('投递记录读 ok 而不是 success；失败行要显示 status 与 error', () => {
      const okHtml = renderRecentDeliveries([RECORD]);
      expect(okHtml).toContain('成功');
      const failed = renderRecentDeliveries([{ ...RECORD, ok: false, status: 502, error: '网关炸了' }]);
      expect(failed).toContain('502');
      expect(failed).toContain('网关炸了');
      expect(renderRecentDeliveries([])).toContain('暂无投递记录');
    });
  });
});

/**
 * uin 的格式闸必须是 spec 派生的那一条，不是路由里的字面量。
 * 这条用例存在的理由：config.ts 与 debug.ts 曾经各写一份 /^[0-9]{5,10}$/，
 * 而 spec 的 pattern 由 upstream-guards 从上游 UIN_REGEX 派生执法 —— 上游改区间时
 * spec 被迫跟着改，那两份字面量却谁也不欠，demo 会继续用旧区间放行且测试全绿。
 */
describe('UIN_RE 的单一来源', () => {
  const specPattern = (): string => {
    const doc = parse(readFileSync('spec/openapi.yaml', 'utf8')) as {
      paths: Record<string, Record<string, { parameters?: { name: string; schema?: { pattern?: string } }[] }>>;
    };
    const item = doc.paths['/api/config/{uin}'];
    return (item.get.parameters ?? []).find((p) => p.name === 'uin')?.schema?.pattern ?? '';
  };

  it('形状就是 spec 里那条 pattern（不是又抄一遍数字区间）', () => {
    expect(UIN_RE.source).toBe(specPattern());
  });

  it('uin 区间在 demo 侧只许有一处派生，不许再出现第二份字面量', () => {
    // 只比"内容相等"钉不住退化：有人把 UIN_RE 改回 `/^[0-9]{5,10}$/` 字面量时，
    // 上面那条断言照样绿（因为 spec 还没变）。所以这里钉结构：字面量只准出现在派生里。
    const uinLiteral = /\/\^\[0-9\]\{\d+,\d+\}\$\//;
    for (const f of ['demo/server/routes/config.ts', 'demo/server/routes/debug.ts']) {
      expect(readFileSync(f, 'utf8'), `${f} 里不该再有第二条 uin 正则字面量`).not.toMatch(uinLiteral);
      expect(readFileSync(f, 'utf8')).not.toMatch(/const UIN_RE\s*=/);
    }
    expect(readFileSync('demo/server/upstream.ts', 'utf8')).not.toMatch(uinLiteral);
  });

  it('区间边界按 spec 判：4 位拒、5 位收、10 位收、11 位拒、非数字拒', () => {
    for (const bad of ['1234', '12345678901', 'abc', '12a456', '', '12345 ']) {
      expect(UIN_RE.test(bad), `应当拒绝 ${JSON.stringify(bad)}`).toBe(false);
    }
    for (const good of ['12345', '1234567890']) {
      expect(UIN_RE.test(good), `应当接受 ${good}`).toBe(true);
    }
  });

  it('缺 uin 与 uin 形状不合法是两条不同的 400（前者是必填，后者才是 pattern）', async () => {
    const f = instance();
    await pastTheGate(f.u);
    const missing = await hit(f.u, configRoutes, 'GET', '/onebot-config');
    expect(missing.status).toBe(400);
    expect(String(missing.json?.message)).toContain('需要 uin');

    const malformed = await hit(f.u, configRoutes, 'GET', '/onebot-config?uin=123');
    expect(malformed.status).toBe(400);
    expect(String(malformed.json?.message)).toContain('pattern');
    // 两条分支必须真的可分辨：把必填当成 pattern 拒绝，报告就会说"上游规则改了"而没人去查 query。
    expect(String(missing.json?.message)).not.toContain('pattern');
  });
});

/**
 * 存在性核：`GET /api/config/:uin`（`server.ts:1511`）只做 pattern 检查，对**格式合法但不存在**
 * 的 uin 一样回 200 —— 那份 body 是全局默认 OneBot 配置，`makeDefaultOneBotConfig()`
 * （`onebot/src/config.ts:43-73`）里 `accessToken: generateAccessToken()` 是一个真实的
 * 32 字节随机 token。所以 demo 侧多一道核，判据取 `listQq`（与账号选择器同源）：
 * 不在列表里 ⇒ 404，且**那一路请求根本不发出** —— 已经取回来的 token 折掉不是修复，
 * 让人看不见它才是。
 */
describe('未知账号的 OneBot 配置读写（存在性核在出网之前）', () => {
  it('格式合法但不在 qq-list 里的 uin ⇒ 404，且一次 /api/config/{uin} 都不发', async () => {
    const f = instance();
    await pastTheGate(f.u);
    const r = await hit(f.u, configRoutes, 'GET', '/onebot-config?uin=10002');
    expect(r.status).toBe(404);
    expect(String(r.json?.message)).toContain('qq-list');
    expect(f.seen.filter((p) => p.startsWith('/api/config/10002'))).toEqual([]);
  });

  it('同一道核也拦写：未知 uin 的 POST ⇒ 404，不落盘、不热重载', async () => {
    const f = instance();
    await pastTheGate(f.u);
    const r = await hit(f.u, configRoutes, 'POST', '/onebot-config?uin=10002', {
      patch: { networks: { wsServers: [{ name: 'w1', messageFormat: 'string', reportSelfMessage: false, port: 3001, role: 'Event' }] } },
    });
    expect(r.status).toBe(404);
    expect(f.seen.filter((p) => p.startsWith('/api/config/10002'))).toEqual([]);
  });

  it('qq-list 读失败 ⇒ 502：读不到证据既不当作存在，也不当作不存在', async () => {
    const f = instance({ '/api/qq-list': { status: 500, body: { message: '上游炸了' } } });
    await pastTheGate(f.u);
    const r = await hit(f.u, configRoutes, 'GET', '/onebot-config?uin=10001');
    expect(r.status).toBe(502);
    expect(f.seen.filter((p) => p.startsWith('/api/config/10001'))).toEqual([]);
  });

  it('在线账号照常读，代价是多一次 qq-list（不缓存：账号上下线是真实状态）', async () => {
    const f = instance();
    await pastTheGate(f.u);
    const r = await hit(f.u, configRoutes, 'GET', '/onebot-config?uin=10001');
    expect(r.status).toBe(200);
    expect(f.seen.filter((p) => p === '/api/qq-list')).toHaveLength(1);
    expect(f.seen.filter((p) => p.startsWith('/api/config/10001'))).toHaveLength(1);
  });

  it('qq-list 撞上门控三形时交回门禁屏，不许折成 502（那是把"门禁未过"伪装成"数据读不出"）', async () => {
    // 两种 body 都取自 demo-gates.test.ts 的真上游桩：门控 401 是 {status:'failed'} 且不带 success；
    // 同意闸是 403 + consentRequired:true。
    const dead = instance({ '/api/qq-list': { status: 401, body: { status: 'failed', message: 'Token expired or invalid' } } });
    await pastTheGate(dead.u);
    const r1 = await hit(dead.u, configRoutes, 'GET', '/onebot-config?uin=10001');
    expect(r1.status).toBe(401);
    expect(r1.json).toMatchObject({ step: 'login' });
    expect(String(r1.json.message)).not.toContain('无法确认');
    expect(dead.seen.filter((p) => p.startsWith('/api/config/'))).toEqual([]);

    const consent = instance({
      '/api/qq-list': { status: 403, body: { status: 'failed', message: '请先阅读并同意用户协议与隐私政策', consentRequired: true } },
    });
    await pastTheGate(consent.u);
    const r2 = await hit(consent.u, configRoutes, 'GET', '/onebot-config?uin=10001');
    expect(r2.json).toMatchObject({ step: 'consent', consentRequired: true });
    expect(consent.seen.filter((p) => p.startsWith('/api/config/'))).toEqual([]);
  });

  it('qq-list 的 200 形状不对也 fail-closed：缺 list 键、空列表、条目 uin 是数字，三种都 404 且不出网', async () => {
    const shapes: Array<[string, unknown]> = [
      ['缺 list 键', {}],
      ['空列表', { list: [] }],
      // spec 的 QQInfo.uin 是 string（required，additionalProperties:false）。这里刻意不做
      // String() 强转：漂移成数字时宁可全线 404，也不要把"判据没对上"说成"账号存在"。
      ['条目 uin 是数字', { list: [{ uin: 10001, nickname: '数字形' }] }],
    ];
    for (const [label, body] of shapes) {
      const f = instance({ '/api/qq-list': { status: 200, body } });
      await pastTheGate(f.u);
      const r = await hit(f.u, configRoutes, 'GET', '/onebot-config?uin=10001');
      expect(r.status, label).toBe(404);
      expect(f.seen.filter((p) => p.startsWith('/api/config/')), label).toEqual([]);
    }
  });
});
