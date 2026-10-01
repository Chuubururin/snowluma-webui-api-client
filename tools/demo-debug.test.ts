// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
/**
 * L2：调试页的服务端路由（三条操作；两条流式归实现批次）。
 *
 * 形状全部读自 spec（`spec/openapi.yaml`），三处与计划 brief 的草稿**不同**，以实码/spec 为准
 * （见 task-11-addendum.md A/B/C）：
 *  · `invokeDebugAction` 的请求体是 `{uin, action, params}`（required [uin, action]，
 *    `uin` 走 `^[0-9]{5,10}$` = `server.ts:236` UIN_REGEX），不是 `{name, params}` ——
 *    照抄 brief 会被上游四条 400 分支（`:1295/1297/1298/1300`）逐字拒掉。
 *  · debug 面的**失败信封是 `{status:'failed', message}`，没有 `success` 键**
 *    （`DebugEnvelopeFailure` `:816-822`），200 的成功支是 `{status, retcode?, data?, message?, wording?}`
 *    （`DebugInvokeResult` `:840-850`，required 只有 [status]）⇒ "HTTP 200" 与"动作成功"是两件事，
 *    demo 不许把 invoke 的 200 一律折成成功（与 `ProcessActionResult.success` 同一条教训）。
 *  · `uploadDebugFile` **不是 multipart**：请求体就是文件字节流，文件名在 `?filename=` 上
 *    （`:1850-1872` 明写）。生成侧若按 multipart 建模，三家都会发出服务端从不解析的信封。
 *  · 目录参数键名是 `name`，说明是 `desc`（`DebugActionParam` `:1234-1248`）；
 *    `default` 上游类型是 `unknown` ⇒ demo 不拿它自动填参数。
 *  · `readOnly` 与 `stream` 是安全信息：非 readOnly 的动作会改业务状态，`stream:true` 的动作
 *    在 REST invoke 上不适用（该走的流式页）。
 *  · `categories` 是 `{category,count}[]`，真 WebUI 的分类计数条用的就是它（`:2655-2673`）。
 *
 * T3 纪律：invoke 与 upload 都标 `x-replay-class: t3`（invoke 另标 `x-snowluma-destructive`），
 * 这里只走假上游，且**绝不自动重试** —— `server.ts:1304` 的 await 可能已在服务端生效。
 */
import { describe, expect, it } from 'vitest';
import { debugRoutes, DEBUG_INVOKE_KEYS } from '../demo/server/routes/debug.js';
import { gateRoutes } from '../demo/server/routes/gates.js';
import { hit, statefulUpstream, upstreamWith, type FakeReply, type FakeUpstream } from './helpers/demo-http.js';

const routes = { ...gateRoutes, ...debugRoutes };

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
        { name: 'nofilter', type: 'boolean', required: true, desc: '不过滤' },
      ],
    },
    { name: 'set_group_ban', aliases: [], readOnly: false, stream: false, params: [] },
  ],
  categories: [
    { category: 'group', count: 12 },
    { category: 'misc', count: 3 },
  ],
};

interface Call {
  url: string;
  method: string;
  body: string;
  ct: string;
}

/** 记账型假上游：默认按 spec 形状回答，`overrides` 按路径覆盖。 */
function instance(overrides: Record<string, FakeReply> = {}) {
  const seen: Call[] = [];
  const handler: FakeUpstream = (path, init) => {
    seen.push({
      url: path,
      method: (init?.method ?? 'GET').toUpperCase(),
      body: String(init?.body ?? ''),
      ct: String((init?.headers as Headers | undefined)?.get?.('content-type') ?? ''),
    });
    if (overrides[path.split('?')[0]]) return overrides[path.split('?')[0]];
    if (path === '/api/debug/actions') return { status: 200, body: ACTIONS };
    if (path === '/api/debug/invoke') return { status: 200, body: { status: 'ok', retcode: 0, data: { list: [] } } };
    if (path.startsWith('/api/debug/upload')) {
      return { status: 200, body: { status: 'ok', path: '/tmp/snowluma/upload/a.json', size: 12 } };
    }
    return { status: 404, body: { success: false, message: `调试夹具没有 ${path}` } };
  };
  return { seen, u: statefulUpstream(handler) };
}

async function pastTheGate(u: ReturnType<typeof statefulUpstream>): Promise<void> {
  u.authenticate('TK-fixture');
  expect((await hit(u, routes, 'POST', '/gate/acknowledge', {})).json).toMatchObject({ step: 'app' });
}

describe('debug (L2)', () => {
  it('三条路由第一行都是 gateGuard：门禁未过 ⇒ 一次都不出网', async () => {
    const f = instance();
    expect((await hit(f.u, routes, 'GET', '/debug-actions')).status).toBe(401);
    expect((await hit(f.u, routes, 'POST', '/debug-invoke', { uin: '10001', action: 'get_group_list' })).status).toBe(401);
    expect(
      (await hit(f.u, routes, 'POST', '/debug-upload', { filename: 'a.json', dataUrl: 'data:application/json;base64,e30=' }))
        .status,
    ).toBe(401);
    expect(f.seen).toEqual([]); // 第二道闸在发请求之前
  });

  it('动作目录原样透传两键：参数键名是 name/desc，缺 category 的动作不补兜底值', async () => {
    const f = instance();
    await pastTheGate(f.u);
    const r = await hit(f.u, debugRoutes, 'GET', '/debug-actions');
    expect(r.status).toBe(200);
    expect(r.json.data).toEqual(ACTIONS); // categories 也在：分类计数条要它
    // 读错键的两种形状都不许出现在服务端：既不重命名，也不给 category 兜底
    expect(r.json.data.actions[0].params[0].name).toBe('group_id');
    expect(r.json.data.actions[0].params[0].desc).toBe('群号');
    expect('description' in r.json.data.actions[0].params[0]).toBe(false);
    expect('category' in r.json.data.actions[1]).toBe(false); // 上游没给 ⇒ 不造 'misc'
  });

  it('invoke 本地核 uin 与 action：缺一即 400 且不出网（把注定 400 的请求发出去就是发明）', async () => {
    const f = instance();
    await pastTheGate(f.u);
    const before = f.seen.length;
    const bad: Array<[string, any]> = [
      ['缺 uin', { action: 'get_group_list' }],
      ['uin 非数字串', { uin: 10001, action: 'get_group_list' }],
      ['uin 短于 5 位', { uin: '1001', action: 'get_group_list' }],
      ['uin 长于 10 位', { uin: '10000000001', action: 'get_group_list' }],
      ['缺 action', { uin: '10001' }],
      ['action 空串', { uin: '10001', action: '' }],
    ];
    for (const [label, body] of bad) {
      const r = await hit(f.u, debugRoutes, 'POST', '/debug-invoke', body);
      expect(r.status, label).toBe(400);
    }
    expect(f.seen.length, '六条拒案一条都不该出网').toBe(before);
    expect(DEBUG_INVOKE_KEYS).toEqual(['uin', 'action', 'params']);
  });

  it('invoke 上行只带 {uin,action} 或 {uin,action,params}：不发明 params 键，params 非对象就拒', async () => {
    const f = instance();
    await pastTheGate(f.u);
    const a = await hit(f.u, debugRoutes, 'POST', '/debug-invoke', { uin: '10001', action: 'get_group_list' });
    expect(a.status).toBe(200);
    expect(JSON.parse(f.seen.at(-1)!.body)).toEqual({ uin: '10001', action: 'get_group_list' });
    const b = await hit(f.u, debugRoutes, 'POST', '/debug-invoke', {
      uin: '10001',
      action: 'get_group_list',
      params: { group_id: 1 },
    });
    expect(b.status).toBe(200);
    expect(JSON.parse(f.seen.at(-1)!.body)).toEqual({ uin: '10001', action: 'get_group_list', params: { group_id: 1 } });
    for (const params of [[1, 2], 'x', 5, null]) {
      const r = await hit(f.u, debugRoutes, 'POST', '/debug-invoke', { uin: '10001', action: 'x', params });
      expect(r.status, `params=${JSON.stringify(params)}`).toBe(400);
    }
  });

  it('invoke 的 200 不等于成功：status:failed 的信封原样交回，不折成成功', async () => {
    const f = instance({
      '/api/debug/invoke': { status: 200, body: { status: 'failed', message: 'action 未注册', retcode: 1400 } },
    });
    await pastTheGate(f.u);
    const r = await hit(f.u, debugRoutes, 'POST', '/debug-invoke', { uin: '10001', action: 'nope' });
    expect(r.status).toBe(200); // 传输层确实 200
    expect(r.json.data).toEqual({ status: 'failed', message: 'action 未注册', retcode: 1400 });
    // 但 demo 的信封里不许出现一个把动作说成成功的键
    expect('ok' in r.json).toBe(false);
    expect('success' in r.json).toBe(false);
  });

  it('invoke 的上游 4xx 保住状态码与原文：debug 面的失败没有 success 键', async () => {
    const f = instance({ '/api/debug/invoke': { status: 400, body: { status: 'failed', message: '无效账号' } } });
    await pastTheGate(f.u);
    const r = await hit(f.u, debugRoutes, 'POST', '/debug-invoke', { uin: '10001', action: 'get_group_list' });
    expect(r.status).toBe(400);
    expect(r.json.message).toBe('无效账号');
    expect(r.json.status).toBe('failed'); // 上游那对键留在响应里，客户端才分得清"没执行"与"执行失败"
  });

  it('invoke 不自动重试：上游 500 只出网一次（T3 已在服务端生效过就不许再发一遍）', async () => {
    const f = instance({ '/api/debug/invoke': { status: 500, body: { status: 'failed', message: '内部错误' } } });
    await pastTheGate(f.u);
    const r = await hit(f.u, debugRoutes, 'POST', '/debug-invoke', { uin: '10001', action: 'get_group_list' });
    expect(r.status).toBe(500);
    expect(f.seen.filter((s) => s.url === '/api/debug/invoke')).toHaveLength(1);
  });

  it('门控 401 与两道 403 仍走门禁收口：不把"会话死了/闸没过"说成动作失败', async () => {
    const dead = instance({ '/api/debug/invoke': { status: 401, body: { status: 'failed', message: 'Token expired or invalid' } } });
    await pastTheGate(dead.u);
    const r1 = await hit(dead.u, debugRoutes, 'POST', '/debug-invoke', { uin: '10001', action: 'x' });
    expect(r1.json).toMatchObject({ step: 'login' });

    const consent = instance({ '/api/debug/invoke': { status: 403, body: { status: 'failed', message: '请先同意', consentRequired: true } } });
    await pastTheGate(consent.u);
    const r2 = await hit(consent.u, debugRoutes, 'POST', '/debug-invoke', { uin: '10001', action: 'x' });
    expect(r2.json).toMatchObject({ step: 'consent' });
  });

  it('upload：filename 必填（缺省取名未经确证 ⇒ 不发明兜底名），缺文件或缺名都 400 且不出网', async () => {
    const f = instance();
    await pastTheGate(f.u);
    const before = f.seen.length;
    const cases: Array<[string, any]> = [
      ['缺 filename', { dataUrl: 'data:application/json;base64,e30=' }],
      ['filename 空串', { filename: '', dataUrl: 'data:application/json;base64,e30=' }],
      ['缺 dataUrl', { filename: 'a.json' }],
      ['dataUrl 不是 base64 那一支（尾巴含合法 base64 字符，删掉守卫就会带着脏字节出网）', { filename: 'a.json', dataUrl: 'data:application/json;charset=utf-8,SGVsbG8=' }],
      ['dataUrl 解出零字节', { filename: 'a.json', dataUrl: 'data:application/json;base64,' }],
    ];
    for (const [label, body] of cases) {
      const r = await hit(f.u, debugRoutes, 'POST', '/debug-upload', body);
      expect(r.status, label).toBe(400);
    }
    expect(f.seen.length).toBe(before);
  });

  it('upload：请求体是原始字节流（application/octet-stream，不是 multipart、不是 JSON），filename 只编码一次', async () => {
    const f = instance();
    await pastTheGate(f.u);
    const r = await hit(f.u, debugRoutes, 'POST', '/debug-upload', {
      filename: 'a b.json',
      dataUrl: 'data:application/json;base64,' + Buffer.from('{"k":1}', 'utf8').toString('base64'),
    });
    expect(r.status).toBe(200);
    const call = f.seen.at(-1)!;
    expect(call.method).toBe('POST');
    expect(call.ct).toBe('application/octet-stream');
    expect(call.body).toBe('{"k":1}'); // 解码出来的字节原样进请求体，没有 JSON 包装、没有 multipart 边界
    // 空格编码成 %20（不是 +，也不是留原样），且只编码一遍（没有 %2520 这种二次编码）
    expect(call.url).toBe('/api/debug/upload?filename=a%20b.json');
    expect(call.url).not.toContain('%2520');
  });

  it('upload 200 交回 {status,path,size}：客户端要显示落盘路径与字节数，不是一句"上传成功"', async () => {
    const f = instance();
    await pastTheGate(f.u);
    const r = await hit(f.u, debugRoutes, 'POST', '/debug-upload', {
      filename: 'a.json',
      dataUrl: 'data:application/json;base64,' + Buffer.from('{"k":1}', 'utf8').toString('base64'),
    });
    expect(r.json.data).toEqual({ status: 'ok', path: '/tmp/snowluma/upload/a.json', size: 12 });
  });

  it('上游侧非预期形状 ⇒ 502 归一并说清是哪一步，不静默给空结果', async () => {
    const f = instance({ '/api/debug/actions': { status: 200, body: { unexpected: true } } });
    await pastTheGate(f.u);
    const r = await hit(f.u, debugRoutes, 'GET', '/debug-actions');
    expect(r.status).toBe(502);
    expect(r.json.message).toContain('动作目录');
  });
});
