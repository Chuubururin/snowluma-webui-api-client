// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
import { describe, expect, it } from 'vitest';
import {
  AdapterError,
  ConsentRequiredError,
  LoginError,
  PasswordChangeRequiredError,
  PasswordWeakError,
  SessionExpiredError,
  TotpRequiredError,
  createClient,
  type TransportResult,
} from './client.js';
import { RulesError, applyRules, loadRules, validateRules } from './rules.js';

/** 脚本化假传输：按队列弹出响应；记录全部调用供断言。不需要活实例。 */
function scripted(responses: Array<TransportResult | Error>) {
  const calls: Array<{ method: string; path: string; body?: unknown; headers?: Record<string, string> }> = [];
  const queue = [...responses];
  const transport = async (
    method: string,
    path: string,
    o: { body?: unknown; headers?: Record<string, string> },
  ): Promise<TransportResult> => {
    calls.push({ method, path, body: o.body, headers: o.headers });
    const next = queue.shift();
    if (next === undefined) throw new Error(`脚本耗尽：${method} ${path} 无对应响应（已 ${calls.length} 次调用）`);
    if (next instanceof Error) throw next;
    return next;
  };
  return { calls, transport };
}

const LOGIN_OK = {
  status: 200,
  json: { success: true, token: 'tok-1', mustChangePassword: false },
};
const AGREEMENTS_NO_CONSENT = {
  status: 200,
  json: { version: 'v1', consentRequired: false, documents: [] },
};
const AGREEMENTS_CONSENT = {
  status: 200,
  json: {
    version: 'v1',
    consentRequired: true,
    documents: [{ id: 'eula', title: 'EULA', declaredVersion: '1', effectiveDate: '2026-01-01', text: '条款' }],
  },
};

describe('bootstrapSession（设计口径门控引导）', () => {
  it('直通：login 成功、无 consent、无改密 → 返回会话状态', async () => {
    const s = scripted([LOGIN_OK, AGREEMENTS_NO_CONSENT]);
    const c = createClient({ transport: s.transport, rules: { schemaVersion: '1.0.0', rules: [] } });
    const session = await c.bootstrapSession({ password: 'pw' });
    expect(session).toEqual({ token: 'tok-1', consentRequired: false, mustChangePassword: false });
    expect(s.calls[0].path).toBe('/api/login');
    expect(s.calls[0].body).toEqual({ password: 'pw' });
    expect(s.calls[1].headers?.authorization).toBe('Bearer tok-1');
  });

  it('needsTotp 且未提供 totp → TotpRequiredError；带 totp 则随 login 体发送', async () => {
    const needsTotp = { status: 200, json: { success: false, needsTotp: true } };
    const s1 = scripted([needsTotp]);
    const c1 = createClient({ transport: s1.transport, rules: { schemaVersion: '1.0.0', rules: [] } });
    await expect(c1.bootstrapSession({ password: 'pw' })).rejects.toBeInstanceOf(TotpRequiredError);

    const s2 = scripted([{ status: 200, json: { success: true, token: 't2', mustChangePassword: false } }, AGREEMENTS_NO_CONSENT]);
    const c2 = createClient({ transport: s2.transport, rules: { schemaVersion: '1.0.0', rules: [] } });
    await c2.bootstrapSession({ password: 'pw', totp: '123456' });
    expect(s2.calls[0].body).toEqual({ password: 'pw', totp: '123456' });
  });

  it('401/429/500 登录失败 → LoginError 携带分类与文案', async () => {
    for (const [status, kind] of [
      [401, 'rejected'],
      [429, 'locked'],
      [500, 'failed'],
    ] as const) {
      const s = scripted([{ status, json: { success: false, message: `文案${status}` } }]);
      const c = createClient({ transport: s.transport, rules: { schemaVersion: '1.0.0', rules: [] } });
      const err = await c.bootstrapSession({ password: 'pw' }).catch((e) => e);
      expect(err).toBeInstanceOf(LoginError);
      expect(err.kind).toBe(kind);
      expect(err.message).toContain(`文案${status}`);
    }
  });

  it('200 的响应体不是对象 ⇒ AdapterError(protocol)，不是 TypeError（与 Python/Go 同形）', async () => {
    // 网关错误页 / 截断响应 / 被改写过的代理回包都会让 200 带上来字符串、null、数组或数字。
    for (const json of ['<html>502 from proxy</html>', null, ['tok-1'], 42]) {
      const s = scripted([{ status: 200, json }]);
      const c = createClient({ transport: s.transport, rules: { schemaVersion: '1.0.0', rules: [] } });
      const err = await c.bootstrapSession({ password: 'pw' }).catch((e) => e);
      expect(err, `login 体为 ${JSON.stringify(json)}`).toBeInstanceOf(AdapterError);
      expect((err as AdapterError).kind, `login 体为 ${JSON.stringify(json)}`).toBe('protocol');
    }

    const s2 = scripted([LOGIN_OK, { status: 200, json: null }]);
    const c2 = createClient({ transport: s2.transport, rules: { schemaVersion: '1.0.0', rules: [] } });
    const err2 = await c2.bootstrapSession({ password: 'pw' }).catch((e) => e);
    expect(err2).toBeInstanceOf(AdapterError);
    expect((err2 as AdapterError).kind).toBe('protocol');

    // 同意闸开着却缺 version：record-consent 的必填体无从取得 ⇒ 同一条 protocol 错
    const s3 = scripted([LOGIN_OK, { status: 200, json: { consentRequired: true, documents: [] } }]);
    const c3 = createClient({ transport: s3.transport, rules: { schemaVersion: '1.0.0', rules: [] } });
    const err3 = await c3.bootstrapSession({ password: 'pw', acceptAgreements: true }).catch((e) => e);
    expect(err3).toBeInstanceOf(AdapterError);
    expect((err3 as AdapterError).kind).toBe('protocol');
  });

  it('consent 闸：默认不代同意 → ConsentRequiredError 附 documents；显式 accept 才 record-consent', async () => {
    const s1 = scripted([LOGIN_OK, AGREEMENTS_CONSENT]);
    const c1 = createClient({ transport: s1.transport, rules: { schemaVersion: '1.0.0', rules: [] } });
    const err = await c1.bootstrapSession({ password: 'pw' }).catch((e) => e);
    expect(err).toBeInstanceOf(ConsentRequiredError);
    expect(err.documents).toHaveLength(1);
    expect(err.version).toBe('v1');
    expect(s1.calls).toHaveLength(2); // 不应有 record-consent 调用

    const s2 = scripted([LOGIN_OK, AGREEMENTS_CONSENT, { status: 200, json: { success: true, version: 'v1' } }]);
    const c2 = createClient({ transport: s2.transport, rules: { schemaVersion: '1.0.0', rules: [] } });
    await c2.bootstrapSession({ password: 'pw', acceptAgreements: true });
    expect(s2.calls[2]).toMatchObject({ method: 'POST', path: '/api/agreements/record-consent', body: { version: 'v1' } });
  });

  it('consent 409 版本不匹配 → 用 currentVersion 重试仅一次', async () => {
    const s = scripted([
      LOGIN_OK,
      AGREEMENTS_CONSENT,
      { status: 409, json: { success: false, message: '版本不符', currentVersion: 'v2' } },
      { status: 200, json: { success: true, version: 'v2' } },
    ]);
    const c = createClient({ transport: s.transport, rules: { schemaVersion: '1.0.0', rules: [] } });
    await c.bootstrapSession({ password: 'pw', acceptAgreements: true });
    const consents = s.calls.filter((x) => x.path === '/api/agreements/record-consent');
    expect(consents).toHaveLength(2);
    expect(consents[0].body).toEqual({ version: 'v1' });
    expect(consents[1].body).toEqual({ version: 'v2' });
  });

  it('改密闸：未给 newPassword → PasswordChangeRequiredError；400 带 rules → PasswordWeakError；400 无 rules → 普通 AdapterError', async () => {
    const mustChange = { status: 200, json: { success: true, token: 't3', mustChangePassword: true } };
    const s1 = scripted([mustChange, AGREEMENTS_NO_CONSENT]);
    const c1 = createClient({ transport: s1.transport, rules: { schemaVersion: '1.0.0', rules: [] } });
    await expect(c1.bootstrapSession({ password: 'pw' })).rejects.toBeInstanceOf(PasswordChangeRequiredError);

    const s2 = scripted([mustChange, AGREEMENTS_NO_CONSENT, { status: 400, json: { success: false, message: '强度不足', rules: [{ a: 1 }] } }]);
    const c2 = createClient({ transport: s2.transport, rules: { schemaVersion: '1.0.0', rules: [] } });
    const weak = await c2.bootstrapSession({ password: 'pw', newPassword: 'np' }).catch((e) => e);
    expect(weak).toBeInstanceOf(PasswordWeakError);
    expect(weak.rules).toEqual([{ a: 1 }]);

    const s3 = scripted([mustChange, AGREEMENTS_NO_CONSENT, { status: 400, json: { success: false, message: '当前密码不正确' } }]);
    const c3 = createClient({ transport: s3.transport, rules: { schemaVersion: '1.0.0', rules: [] } });
    const fail = await c3.bootstrapSession({ password: 'pw', newPassword: 'np' }).catch((e) => e);
    expect(fail).toBeInstanceOf(Error);
    expect(fail.kind).toBe('password-failed');
    expect(fail).not.toBeInstanceOf(PasswordWeakError);
  });

  it('改密成功（requireRelogin）→ 用新密码回到 login 再走一遍（服务端已 clear 全部会话）', async () => {
    const s = scripted([
      { status: 200, json: { success: true, token: 'old', mustChangePassword: true } },
      AGREEMENTS_NO_CONSENT,
      { status: 200, json: { success: true, requireRelogin: true } },
      { status: 200, json: { success: true, token: 'new', mustChangePassword: false } },
      AGREEMENTS_NO_CONSENT,
    ]);
    const c = createClient({ transport: s.transport, rules: { schemaVersion: '1.0.0', rules: [] } });
    const session = await c.bootstrapSession({ password: 'old-pw', newPassword: 'new-pw' });
    expect(session.token).toBe('new');
    const logins = s.calls.filter((x) => x.path === '/api/login');
    expect(logins).toHaveLength(2);
    expect(logins[0].body).toEqual({ password: 'old-pw' });
    expect(logins[1].body).toEqual({ password: 'new-pw' });
  });

  it('改密 200 非对象体 ⇒ protocol 错（asObject 守卫）', async () => {
    const mustChange = { status: 200, json: { success: true, token: 't3', mustChangePassword: true } };
    const s = scripted([mustChange, AGREEMENTS_NO_CONSENT, { status: 200, json: null }]);
    const c = createClient({ transport: s.transport, rules: { schemaVersion: '1.0.0', rules: [] } });
    const err = await c.bootstrapSession({ password: 'pw', newPassword: 'np' }).catch((e) => e);
    expect(err).toBeInstanceOf(AdapterError);
    expect(err.kind).toBe('protocol');
  });
});

describe('request 的 401 生命周期（设计口径按方法安全性分治）', () => {
  async function boot(calls: Array<TransportResult | Error>) {
    const s = scripted([LOGIN_OK, AGREEMENTS_NO_CONSENT, ...calls]);
    const c = createClient({ transport: s.transport, rules: { schemaVersion: '1.0.0', rules: [] } });
    await c.bootstrapSession({ password: 'pw' });
    return { c, calls: s.calls };
  }

  it('GET 401 → 重登一次并重放原请求', async () => {
    const { c, calls } = await boot([
      { status: 401, json: { success: false, message: 'Token expired' } },
      LOGIN_OK,
      { status: 200, json: { ok: true } },
    ]);
    const out = await c.request('GET', '/api/qq-list');
    expect(out).toEqual({ ok: true });
    const after = calls.slice(2);
    expect(after[0]).toMatchObject({ method: 'GET', path: '/api/qq-list' });
    expect(after[1]).toMatchObject({ method: 'POST', path: '/api/login', body: { password: 'pw' } });
    expect(after[2]).toMatchObject({ method: 'GET', path: '/api/qq-list' });
  });

  it('GET 重登后仍 401 → SessionExpiredError', async () => {
    const { c } = await boot([
      { status: 401, json: { success: false, message: 'expired' } },
      LOGIN_OK,
      { status: 401, json: { success: false, message: 'expired again' } },
    ]);
    await expect(c.request('GET', '/api/qq-list')).rejects.toBeInstanceOf(SessionExpiredError);
  });

  it('POST 401 → 不重登不重放，直接 SessionExpiredError', async () => {
    const { c, calls } = await boot([{ status: 401, json: { success: false, message: 'expired' } }]);
    await expect(c.request('POST', '/api/logs/level', { level: 'debug' })).rejects.toBeInstanceOf(SessionExpiredError);
    expect(calls).toHaveLength(3); // 只有 bootstrap 两步 + 原请求
  });

  it('external-fetch 例外：GET /api/update/check 401 不自动重放；/api/status（cookie）仍重放', async () => {
    const { c, calls } = await boot([
      { status: 401, json: { success: false, message: 'expired' } },
      { status: 401, json: { success: false, message: 'expired' } },
      LOGIN_OK,
      { status: 200, json: { ok: true } },
    ]);
    await expect(c.request('GET', '/api/update/check')).rejects.toBeInstanceOf(SessionExpiredError);
    expect(calls).toHaveLength(3); // bootstrap 两步 + update/check 一次（无重登）
    await c.request('GET', '/api/status');
    const tail = calls.slice(3);
    expect(tail.some((x) => x.path === '/api/login')).toBe(true); // cookie 例外走重放
  });

  it('其它 4xx → AdapterError 带服务端 message', async () => {
    const { c } = await boot([{ status: 400, json: { success: false, message: '无效的账号' } }]);
    const err = (await c.request('POST', '/api/debug/invoke', {}).catch((e) => e)) as { kind?: string; message: string };
    expect(err.kind).toBe('request-failed');
    expect(err.message).toContain('无效的账号');
  });
});

describe('rules.json 归一化（设计口径规则单源）', () => {
  it('仓库规则表通过结构校验且 config-double-shape 生效', async () => {
    const rules = loadRules();
    const s = scripted([
      LOGIN_OK,
      AGREEMENTS_NO_CONSENT,
      { status: 200, json: { config: { a: 1 } } },
    ]);
    const c = createClient({ transport: s.transport, rules });
    await c.bootstrapSession({ password: 'pw' });
    const out = await c.request('GET', '/api/config/12345');
    expect(out).toEqual({ a: 1 });
  });

  it('unwrap 仅在 when.hasKey 命中时生效；rename 改名仅顶层', () => {
    const rules = validateRules({
      schemaVersion: '1.0.0',
      rules: [
        { id: 'cfg', match: { path: '/api/config/{uin}', method: 'GET' }, op: 'unwrap', when: { hasKey: 'config' }, unwrapKey: 'config' },
        { id: 'alias', match: { path: '/api/x', method: 'GET' }, op: 'rename', rename: { from: 'old', to: 'new' } },
      ],
    });
    expect(applyRules(rules, 'GET', '/api/config/1', { config: { a: 1 } })).toEqual({ a: 1 });
    expect(applyRules(rules, 'GET', '/api/config/1', { other: 1 })).toEqual({ other: 1 });
    expect(applyRules(rules, 'GET', '/api/x', { old: 1, keep: 2 })).toEqual({ new: 1, keep: 2 });
    expect(applyRules(rules, 'GET', '/api/other', { config: { a: 1 } })).toEqual({ config: { a: 1 } });
  });

  it('结构校验：重复 id / 未知 op / 未知键 / unwrap 缺 unwrapKey 都抛错', () => {
    expect(() => validateRules({ schemaVersion: '1.0.0', rules: [{ id: 'a', match: { path: '/', method: 'GET' }, op: 'unwrap' }] })).toThrow(RulesError);
    expect(() =>
      validateRules({
        schemaVersion: '1.0.0',
        rules: [
          { id: 'a', match: { path: '/', method: 'GET' }, op: 'unwrap', unwrapKey: 'k' },
          { id: 'a', match: { path: '/', method: 'POST' }, op: 'unwrap', unwrapKey: 'k' },
        ],
      }),
    ).toThrow(/重复/);
    expect(() => validateRules({ schemaVersion: '1.0.0', rules: [{ id: 'a', match: { path: '/', method: 'GET' }, op: 'nope' }] })).toThrow(/unwrap\|rename/);
    expect(() => validateRules({ schemaVersion: '1.0.0', rules: [{ id: 'a', match: { path: '/', method: 'GET' }, op: 'unwrap', unwrapKey: 'k', extra: 1 }] })).toThrow(/未知键/);
    expect(() => validateRules({ schemaVersion: 'bad', rules: [] })).toThrow(/schemaVersion/);
  });

  // 第四轮白盒的三语分叉收口：以下语义裁定在三份实现里逐字对齐，任何一侧回退即红。
  describe('规则引擎三语同形', () => {
    const renameTable = (from: string, to: string) =>
      validateRules({ schemaVersion: '1.0.0', rules: [{ id: 'r1', match: { path: '/api/x', method: 'GET' }, op: 'rename', rename: { from, to } }] });

    it('rename from===to ⇒ no-op（键保留）', () => {
      expect(applyRules(renameTable('a', 'a'), 'GET', '/api/x', { a: 1, b: 2 })).toEqual({ a: 1, b: 2 });
    });

    it('when:null 与缺省同义 ⇒ 无条件解包；when:{} ⇒ 校验拒绝', () => {
      const rule = (when: unknown) => ({
        id: 'u1',
        match: { path: '/api/x', method: 'GET' },
        op: 'unwrap' as const,
        unwrapKey: 'config',
        ...(when === undefined ? {} : { when }),
      });
      const t = validateRules({ schemaVersion: '1.0.0', rules: [rule(null)] });
      expect(applyRules(t, 'GET', '/api/x', { config: { v: 1 } })).toEqual({ v: 1 });
      expect(() => validateRules({ schemaVersion: '1.0.0', rules: [rule({})] })).toThrow(RulesError);
    });

    it('空串 unwrapKey / rename.from / rename.to ⇒ 校验拒绝', () => {
      expect(() =>
        validateRules({ schemaVersion: '1.0.0', rules: [{ id: 'u2', match: { path: '/', method: 'GET' }, op: 'unwrap', unwrapKey: '' }] }),
      ).toThrow(RulesError);
      expect(() => validateRules({ schemaVersion: '1.0.0', rules: [{ id: 'r2', match: { path: '/', method: 'GET' }, op: 'rename', rename: { from: '', to: 'x' } }] })).toThrow(RulesError);
      expect(() => validateRules({ schemaVersion: '1.0.0', rules: [{ id: 'r3', match: { path: '/', method: 'GET' }, op: 'rename', rename: { from: 'x', to: '' } }] })).toThrow(RulesError);
    });

    it('hasKey/unwrapKey 是原型链键名 ⇒ 不命中（hasOwn 裁定，与 oneof/pointer 同仓规）', () => {
      const t = validateRules({
        schemaVersion: '1.0.0',
        rules: [{ id: 'u3', match: { path: '/api/x', method: 'GET' }, op: 'unwrap', unwrapKey: '__proto__', when: { hasKey: 'toString' } }],
      });
      expect(applyRules(t, 'GET', '/api/x', { a: 1 })).toEqual({ a: 1 });
    });

    it('构造函数注入的非法规则表 ⇒ RulesError（不静默 no-op）', () => {
      expect(() =>
        createClient({
          transport: async () => ({ status: 200, json: {} }),
          rules: { schemaVersion: '1.0.0', rules: [{ id: 'bad' }] as never },
        }),
      ).toThrow(RulesError);
    });
  });
});
