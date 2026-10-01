// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
/**
 * L2：门禁屏路由。假上游走的 fetch 注入缝，形态按**上游实码**写死：
 * `server.ts:626-658` 的中间件对 `/api/login` 与 `/api/ui/public` 免 token 检，
 * 登录成功恒返 200 `{success, token, mustChangePassword}`（`server.ts:713`，spec 的 LoginSuccess 三键），
 * **两键 403 来自登录之后**——CONSENT_ALLOWLIST(`:223-229`) 与 MUST_CHANGE_ALLOWLIST(`:206-216`)
 * 之外的路径才会拿到 `{consentRequired:true}` / `{mustChangePassword:true}`。
 * 所以本文件不测"login 返 403"那种根本不存在的分支，改测真可达的那条：
 * 同意未过时点 /gate/password ⇒ 上游 consent 闸 403 ⇒ demo 分派回 step 'consent'。
 */
import { describe, expect, it } from 'vitest';
import { listProcesses } from '../generated/typescript/sdk.gen.js';
import { fail, ok, type RouteTable } from '../demo/server/http.js';
import { gateDispatch, gateGuard, gateRoutes } from '../demo/server/routes/gates.js';
import { unwrap } from '../demo/server/upstream.js';
import { collectRoutes } from '../demo/server/start.js';
import { hit, statefulUpstream, upstreamWith, type FakeUpstream } from './helpers/demo-http.js';

const VERSION = 'sha256:abc';

/**
 * 一台"全新非 dev 实例"：未同意 + 必须改密。状态跨请求累积（登录发 token、同意落状态、改密要重登）。
 * 每条响应体都按 spec/实码形状写，不按"客户端希望它长这样"写。
 */
function freshInstance(init: { agreed?: boolean; changed?: boolean; password?: string; break?: 'consent-key' | 'must-change-key' | 'ui-public-401' | 'logout-500' } = {}) {
  const st = {
    agreed: init.agreed ?? false,
    changed: init.changed ?? false,
    password: init.password ?? 'old-pass',
    break: init.break,
    /** 上游侧真实收到的最后一次请求体，用来钉住键名（如 check-strength 收 `password` 而非 `newPassword`） */
    lastBody: {} as Record<string, unknown>,
    seenPaths: [] as string[],
  };
  const J = (status: number, body: unknown) => ({ status, body });
  const handler: FakeUpstream = (path, reqInit) => {
    st.seenPaths.push(path);
    const body = reqInit?.body ? JSON.parse(String(reqInit.body)) : {};
    st.lastBody = body;
    // 生成的 client 用单个 Request 调 _fetch，夹具据此重建 init，headers 因而是 Headers 实例
    const authed = String((reqInit?.headers as Headers | undefined)?.get?.('authorization') ?? '');
    // 实码 :631 对 login 与 ui/public 直接 next()：这两条在 bearer 检**之前**短路，四条闸都对它们不可达
    if (path === '/api/ui/public') {
      if (st.break === 'ui-public-401') {
        // 门控 401 与业务错误形状不同（{status:'failed'}）。/api/ui/public 在实码里
        // 连 bearer 检都豁免，所以这一形要真出现只能是上游自己变了 ⇒ 专门喂给
        // /appearance 的错误分支：它必须照样把门禁信号分派出去。
        return J(401, { status: 'failed', message: 'Token expired or invalid' });
      }
      return J(200, { appearance: { mode: 'dark', accentPreset: 'blue', density: 'compact', uiScale: 1, background: { type: 'none' }, reduceMotion: false, disableMotion: false } });
    }
    if (path === '/api/login') {
      if (body.totp === 'bad-totp') return J(401, { success: false, message: '验证码不正确' });
      if (body.password !== st.password) {
        if (body.password === 'needs-totp') return J(200, { success: false, needsTotp: true });
        return J(401, { success: false, message: '密码错误' });
      }
      return J(200, { success: true, token: 'TK', mustChangePassword: !st.changed });
    }
    // 除 login / ui.public 外一律要 bearer（实码 :632-638）；认不出的 token 一律门控 401
    if (authed !== 'Bearer TK') return J(401, { status: 'failed', message: 'Token expired or invalid' });
    // 门控 401 与业务 401 形状不同：前者 {status:'failed'}、后者 {success:false,message}
    if (!st.agreed && !CONSENT_ALLOWED.has(path)) {
      return J(403, { status: 'failed', message: '请先阅读并同意用户协议与隐私政策', consentRequired: true });
    }
    if (!st.changed && !MUST_CHANGE_ALLOWED.has(path)) {
      return J(403, { status: 'failed', message: '请先修改密码', mustChangePassword: true });
    }
    switch (path) {
      case '/api/status':
        // 线上形状只有这一个键（spec StatusInfo：required [status]、enum [running]；实码 server.ts:1031
        // 的唯一 return 是 `c.json({ status: 'running' })`）。uptime/version 不在这里 —— 它们属于 getSystem。
        return J(200, { status: 'running' });
      case '/api/agreements': {
        // spec 的 AgreementDoc 四键齐发（declaredVersion/effectiveDate/text），不按 brief 草稿的 {id,title,body}
        const payload: Record<string, unknown> = {
          version: VERSION,
          consentRequired: !st.agreed,
          documents: [
            {
              id: 'eula',
              title: '用户协议',
              declaredVersion: VERSION,
              effectiveDate: '2026-01-01',
              text: '条款正文……',
            },
          ],
        };
        // break='consent-key' 模拟"required 键缺失"的响应：上游不会这样，但门禁读侧必须不猜
        if (st.break === 'consent-key') delete payload.consentRequired;
        return J(200, payload);
      }
      case '/api/agreements/record-consent':
        if (body.version !== VERSION) {
          return J(409, { success: false, message: '版本不符', currentVersion: VERSION });
        }
        st.agreed = true;
        return J(200, { success: true, version: VERSION }); // spec 的 ConsentRecorded 是 {success,version}
      case '/api/auth/state':
        // break='must-change-key' 同理：缺键 ⇒ 'unknown'，绝不折成"不需要改密"
        return J(200, st.break === 'must-change-key' ? {} : { mustChangePassword: !st.changed });
      case '/api/auth/check-strength':
        return J(200, {
          rules: [{ id: 'len', label: '至少 10 位', ok: String(body.password ?? '').length >= 10 }],
          valid: String(body.password ?? '').length >= 10,
        });
      case '/api/auth/change-password':
        if (body.oldPassword !== st.password) return J(401, { success: false, message: '原密码不正确' });
        if (body.newPassword === 'same-as-old') return J(400, { success: false, message: '新旧密码相同' });
        if (String(body.newPassword ?? '').length < 10) {
          return J(400, {
            success: false,
            message: '强度不足',
            rules: [{ id: 'len', label: '至少 10 位', ok: false }],
          });
        }
        st.changed = true;
        return J(200, { success: true, requireRelogin: true });
      case '/api/logout':
        if (st.break === 'logout-500') return J(500, { success: false, message: '上游登出炸了' });
        return J(200, { success: true });
      default:
        return J(404, { success: false, message: 'no route' });
    }
  };
  return { st, u: statefulUpstream(handler) };
}

/** 抄自实码：CONSENT_ALLOWLIST server.ts:223-229 / MUST_CHANGE_ALLOWLIST :206-216 */
const CONSENT_ALLOWED = new Set([
  '/api/status',
  '/api/auth/state',
  '/api/agreements',
  '/api/agreements/record-consent',
  '/api/logout',
]);
const MUST_CHANGE_ALLOWED = new Set([
  '/api/status',
  '/api/auth/state',
  '/api/auth/check-strength',
  '/api/auth/change-password',
  '/api/agreements',
  '/api/agreements/record-consent',
  '/api/logout',
]);

/** 登录并（在同意已就位时）拿到会话；返回 demo 侧响应。 */
async function loginInto(f: { st: { agreed: boolean; changed: boolean; password: string }; u: ReturnType<typeof statefulUpstream> }, pw = 'old-pass') {
  return hit(f.u, gateRoutes, 'POST', '/gate/login', { password: pw });
}

describe('gate flow (L2)', () => {
  it('登录成功即拿到三键里的 token，并按登录**之后**的闸决定 step=consent（同意优先）', async () => {
    const f = freshInstance();
    const r = await loginInto(f);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ step: 'consent', consentRequired: true });
    // 设计口径：两键不混。走 consent 时不得同时把 mustChangePassword 端出去。
    expect(r.json.mustChangePassword).toBeUndefined();
    expect(f.u.token).toBe('TK'); // 会话在服务端内存，不下发浏览器
    expect(JSON.stringify(r.json)).not.toMatch(/token/);
  });

  it('needsTotp 走 200 且无 token：提示第二因子，不得谎报"密码错误"', async () => {
    const f = freshInstance();
    const r = await loginInto(f, 'needs-totp');
    expect(r.json).toMatchObject({ step: 'totp' });
    expect(f.u.token).toBeNull();
    expect(JSON.stringify(r.json)).not.toMatch(/密码错误/);
  });

  it('口令错 ⇒ 透传上游文案并留在 login 步', async () => {
    const f = freshInstance({ password: 'real-pass' });
    const r = await loginInto(f, 'wrong-pass');
    expect(r.json).toMatchObject({ step: 'login', message: '密码错误' });
    expect(f.u.token).toBeNull();
  });

  it('同意绝不代做：不带 version 直接拒且不出网；版本不符 ⇒ 409 带 currentVersion 供重取', async () => {
    const f = freshInstance();
    await loginInto(f);
    const missing = await hit(f.u, gateRoutes, 'POST', '/gate/consent', {});
    expect(missing.status).toBe(400);
    expect(f.st.seenPaths.filter((p) => p === '/api/agreements/record-consent')).toHaveLength(0); // 未上行

    const bad = await hit(f.u, gateRoutes, 'POST', '/gate/consent', { version: 'sha256:not-the-one' });
    expect(bad.status).toBe(409);
    expect(bad.json).toMatchObject({ step: 'consent', currentVersion: VERSION });
    expect(f.st.agreed).toBe(false);
  });

  it('同意成功后重读闸，落到 password 步（改密闸此时才露面）', async () => {
    const f = freshInstance();
    await loginInto(f);
    const r = await hit(f.u, gateRoutes, 'POST', '/gate/consent', { version: VERSION });
    expect(r.json).toMatchObject({ step: 'password', mustChangePassword: true });
    expect(f.st.agreed).toBe(true);
  });

  it('oldPassword 由服务端从登录时留存的口令注入，浏览器不回传凭据；改密成功要求重登', async () => {
    const f = freshInstance({ agreed: true });
    await loginInto(f);
    const r = await hit(f.u, gateRoutes, 'POST', '/gate/password', { newPassword: 'a-long-enough-pass' });
    expect(r.json).toMatchObject({ step: 'relogin', requireRelogin: true });
    expect(f.st.lastBody).toMatchObject({ oldPassword: 'old-pass', newPassword: 'a-long-enough-pass' }); // 两键恒在
    expect(f.st.changed).toBe(true);
    expect(f.u.token).toBeNull(); // requireRelogin ⇒ 旧 token 作废，不留恋
  });

  it('原密码错 ⇒ 透传"原密码不正确"，与门控 401（会话死了）分开分派', async () => {
    const f = freshInstance({ agreed: true, password: 'real-pass' });
    await hit(f.u, gateRoutes, 'POST', '/gate/login', { password: 'real-pass' });
    // 服务端留存的口令失效（上游侧口令已轮换）：注入的 oldPassword 就是当初那一个，于是上游判负
    f.st.password = 'rotated-pass';
    const r = await hit(f.u, gateRoutes, 'POST', '/gate/password', { newPassword: 'a-long-enough-pass' });
    expect(r.json).toMatchObject({ step: 'password', message: '原密码不正确' });

    const f2 = freshInstance({ agreed: true });
    await loginInto(f2);
    // demo 手里还有"一个" token，但上游已经认它了 ⇒ 门控 401 与业务 401 必须分开：
    // 前者要回登录步，后者要留在改密步，混起来就是把"会话死了"说成"密码错了"。
    f2.u.authenticate('STALE-TOKEN');
    const dead = await hit(f2.u, gateRoutes, 'POST', '/gate/password', { newPassword: 'a-long-enough-pass' });
    expect(dead.json).toMatchObject({ step: 'login' });
    expect(JSON.stringify(dead.json)).not.toMatch(/原密码/);
  });

  it('强度端点用 spec 的键名 password（不是 newPassword），并把 rules/valid 原样端出', async () => {
    const f = freshInstance({ agreed: true });
    await loginInto(f);
    const r = await hit(f.u, gateRoutes, 'POST', '/gate/strength', { password: 'a-long-enough-pass' });
    expect(f.st.lastBody).toEqual({ password: 'a-long-enough-pass' });
    expect(r.json).toMatchObject({ valid: true, rules: [{ id: 'len', label: '至少 10 位', ok: true }] });
    expect(r.json).not.toHaveProperty('score'); // 设计口径：不再有分数/进度条
  });

  it('同意未过时去改密 ⇒ 上游 consent 闸 403，demo 分派回 step=consent（两键分派的真 reachable 支）', async () => {
    const f = freshInstance();
    await loginInto(f);
    const r = await hit(f.u, gateRoutes, 'POST', '/gate/password', { newPassword: 'a-long-enough-pass' });
    expect(r.json).toMatchObject({ step: 'consent', consentRequired: true });
    expect(f.st.changed).toBe(false); // 没被"顺手"放行
  });

  it('门禁未过时业务路由被服务端拒（第二道闸），两闸全过才放行', async () => {
    /**
     * 业务路由侧的第二道闸：没有业务路由，用它把"门禁未过不出网"钉成可测的东西，
     * 的每条路由都调同一个 gateGuard（不是各写一遍）。
     */
    const business: RouteTable = {
      'GET /overview': async (_ctx, u) => gateGuard(u) ?? ok({ data: 'priv' }),
    };
    const routes = { ...gateRoutes, ...business };
    const f = freshInstance();
    // 无会话：认证闸（index.ts）先拦
    const anon = await hit(f.u, routes, 'GET', '/overview');
    expect([401, 403]).toContain(anon.status);
    // 有会话但门禁未过：服务端拒 403 且带着 step，不出网打 /api/system
    await loginInto(f);
    const blocked = await hit(f.u, routes, 'GET', '/overview');
    expect(blocked.status).toBe(403);
    expect(blocked.json).toMatchObject({ step: 'consent' });
    expect(f.st.seenPaths).not.toContain('/api/system');
    // 两闸全过：放行
    f.st.agreed = true;
    f.st.changed = true;
    const state = await hit(f.u, routes, 'GET', '/gate/state');
    expect(state.json).toMatchObject({ step: 'app' });
    const passed = await hit(f.u, routes, 'GET', '/overview');
    expect(passed.status).toBe(200);
  });

  it('GET /gate/state 只用四条白名单操作，且带出实例状态供门禁屏显示"连的是哪台"', async () => {
    const f = freshInstance();
    await loginInto(f);
    f.st.seenPaths.length = 0;
    const r = await hit(f.u, gateRoutes, 'GET', '/gate/state');
    expect(r.json).toMatchObject({ step: 'consent', status: { status: 'running' } });
    expect([...f.st.seenPaths].sort()).toEqual(
      ['/api/agreements', '/api/auth/state', '/api/status'].sort(), // 一条不多：门禁屏不碰白名单外的操作
    );
  });

  it('登出清会话与门禁缓存，回到 login 步', async () => {
    const f = freshInstance({ agreed: true, changed: true });
    await loginInto(f);
    expect((await hit(f.u, gateRoutes, 'GET', '/gate/state')).json).toMatchObject({ step: 'app' });
    const out = await hit(f.u, gateRoutes, 'POST', '/logout');
    expect(out.json).toMatchObject({ step: 'login' });
    expect(f.u.token).toBeNull();
    // 缓存清了：没有会话就再也读不到 'app'，而且 401 得带着 step:'login' 让浏览器回登录屏
    const after = await hit(f.u, gateRoutes, 'GET', '/gate/state');
    expect(after.status).toBe(401);
    expect(after.json).toMatchObject({ step: 'login' });
  });

  it('上游登出失败（500）也要拆掉本地会话——路由注释里的断言此前没有用例作证', async () => {
    // 留着坏 token 的代价是"后面每一条请求都撞 401"，比一次登出报错更糟；
    // 所以这条不是可优化掉的细节，是刻意用 catch 折掉的取舍，必须能被测红。
    const f = freshInstance({ agreed: true, changed: true, break: 'logout-500' });
    await loginInto(f);
    expect(f.u.token).toBe('TK');
    const out = await hit(f.u, gateRoutes, 'POST', '/logout');
    expect(out.json).toMatchObject({ step: 'login' });
    expect(f.u.token).toBeNull();
    expect(f.st.seenPaths).toContain('/api/logout');
    // 本地会话真没了：再读门禁只能拿 401 + step:login，而不是缓存里的 'app'
    const after = await hit(f.u, gateRoutes, 'GET', '/gate/state');
    expect(after.status).toBe(401);
    expect(after.json).toMatchObject({ step: 'login' });
  });

  it('三条本地 400：login/strength 缺 password、password 缺 newPassword——缺键在出网前就拒', async () => {
    const f = freshInstance({ agreed: true, changed: true });
    const login = await hit(f.u, gateRoutes, 'POST', '/gate/login', {});
    expect(login.status).toBe(400);
    expect(String(login.json?.message)).toContain('password');

    // strength/password 都在会话闸后面：先登录，缺键的 400 才轮得到本地校验
    await hit(f.u, gateRoutes, 'POST', '/gate/login', { password: f.st.password });

    const strength = await hit(f.u, gateRoutes, 'POST', '/gate/strength', {});
    expect(strength.status).toBe(400);
    expect(String(strength.json?.message)).toContain('password');

    const pw = await hit(f.u, gateRoutes, 'POST', '/gate/password', {});
    expect(pw.status).toBe(400);
    expect(String(pw.json?.message)).toContain('newPassword');
  });
  it('GET /appearance 登录前免会话也能读（设计口径白名单的第 4 条，上游对 ui/public 连 bearer 检都免）', async () => {
    const f = freshInstance();
    const r = await hit(f.u, gateRoutes, 'GET', '/appearance');
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, data: { appearance: { mode: 'dark' } } });
    expect(f.u.token).toBeNull(); // 读外观不建立会话
    expect(f.st.seenPaths).toEqual(['/api/ui/public']); // 一条不多：不顺手打 /api/ui
  });

  it('GET /appearance 撞上门控 401 ⇒ 401 带 step:login（错误出口照走 gateDispatch，不做成无 step 的孤儿）', async () => {
    // 这条曾是全仓唯一不过 gateDispatch 的上游错误出口。喂的是门控 401 那一形（夹具
    // break:'ui-public-401' 造得出）：拿不到 step 时客户端停在"外观读取失败"而不是门禁
    // 该做的分派——与其余所有路由不对称且无注释解释。上游对 ui/public 回门控码是否真会
    // 发生不由这条用例主张，报告设计口径里已经把"会话死了"那一形标为不可达。
    const f = freshInstance({ break: 'ui-public-401' });
    const r = await hit(f.u, gateRoutes, 'GET', '/appearance');
    expect(r.status).toBe(401);
    expect(r.json).toMatchObject({ step: 'login', message: 'Token expired or invalid' });
  });

  it('首访还没有会话 ⇒ 总闸给的文案不许说"会话过期"，且一次上游都不打', async () => {
    // 真浏览器走查抓到的：全新浏览器第一次进屏，登录屏上写着「Token expired or invalid」——
    // 从来没登录过的人被告知"你的会话死了"。401 与 step:login 都对（`/gate/state` 不在白名单里，
    // 无会话时上游本来就什么都读不到），错的是那句关于历史的断言。
    const f = freshInstance({ agreed: true, changed: true });
    const r = await hit(f.u, gateRoutes, 'GET', '/gate/state');
    expect(r.status).toBe(401);
    expect(r.json).toMatchObject({ step: 'login' });
    expect(r.json.message).not.toMatch(/过期|expired|invalid/i);
    expect(r.json.message).toMatch(/还没有.*会话|未建立会话|请重新登录/);
    expect(f.st.seenPaths).toEqual([]); // 一次都不出网：那三次读注定门控 401
  });

  it('会话死在 /gate/state 上 ⇒ 401 回登录屏，不是 200 unknown（停在 unknown 是一间没有门的房间）', async () => {
    const business: RouteTable = {
      'GET /overview': async (_ctx, u) => gateGuard(u) ?? ok({ data: 'priv' }),
    };
    const routes = { ...gateRoutes, ...business };
    const f = freshInstance({ agreed: true, changed: true });
    await loginInto(f);
    expect((await hit(f.u, routes, 'GET', '/gate/state')).json).toMatchObject({ step: 'app' });
    expect((await hit(f.u, routes, 'GET', '/overview')).status).toBe(200); // 两闸全过 ⇒ 放行

    f.u.authenticate('ROTATED-AWAY'); // 上游把会话收了（重启、TTL 到点都会这样）
    const dead = await hit(f.u, routes, 'GET', '/gate/state');
    expect(dead.status).toBe(401);
    expect(dead.json).toMatchObject({ step: 'login' });
    // 同一轮里第二道闸也必须跟着失效：readGates 开头作废缓存，不能拿"上一次成功判断"继续放行
    const blocked = await hit(f.u, routes, 'GET', '/overview');
    expect(blocked.status).toBe(403);
    expect(blocked.json).toMatchObject({ step: 'unknown' });
  });

  it('缺 required 键 ⇒ step unknown（两个键各一条），绝不折成"那道闸过了"', async () => {
    for (const brk of ['consent-key', 'must-change-key'] as const) {
      const f = freshInstance({ agreed: true, changed: true, break: brk });
      const r = await loginInto(f);
      expect(r.json, brk).toMatchObject({ step: 'unknown' });
      // 上游 mustChangePassword() 的静默 false 就是在这里被挡住的：读不出真值时不放行
      expect(r.json, brk).not.toMatchObject({ step: 'app' });
      expect(gateGuard(f.u)).toMatchObject({ status: 403 });
    }
  });

  it('带了 totp 被拒 ⇒ 留在第二因子屏（提示与输入框只在这一屏上），不打回第一步', async () => {
    const f = freshInstance();
    const r = await hit(f.u, gateRoutes, 'POST', '/gate/login', { password: 'old-pass', totp: 'bad-totp' });
    expect(r.status).toBe(401);
    expect(r.json).toMatchObject({ step: 'totp', message: '验证码不正确' });
    expect(f.u.token).toBeNull();
  });

  it('改密业务错的两种形状都原样带上：新旧相同只回文案，强度不足还要回 rules', async () => {
    const f = freshInstance({ agreed: true });
    await loginInto(f);
    const same = await hit(f.u, gateRoutes, 'POST', '/gate/password', { newPassword: 'same-as-old' });
    expect(same.status).toBe(400);
    expect(same.json).toMatchObject({ step: 'password', message: '新旧密码相同' });
    expect(same.json.rules).toBeUndefined();

    const weak = await hit(f.u, gateRoutes, 'POST', '/gate/password', { newPassword: 'short' });
    expect(weak.status).toBe(400);
    expect(weak.json).toMatchObject({ step: 'password', message: '强度不足', rules: [{ id: 'len', ok: false }] });
  });

  it('强度响应缺 rules/valid ⇒ 502 报出来，不折成"密码太弱"', async () => {
    // 独立一台假上游：只有它的 check-strength 会回一个缺键的 200（上游不会这样，但传输层坏了不能骗人）
    const u = statefulUpstream(async (path) =>
      path === '/api/auth/check-strength' ? { status: 200, body: {} } : { status: 200, body: { success: true } },
    );
    u.authenticate('TK-fixture');
    const r = await hit(u, gateRoutes, 'POST', '/gate/strength', { password: 'whatever' });
    expect(r.status).toBe(502);
    expect(r.json.message).toMatch(/缺 rules\/valid/);
  });

  it('gateDispatch：业务路由把上游那三种门禁信号交回门禁，其余错误才用调用方自己的兜底', async () => {
    /**
     * 每条业务路由的收尾形态，这里用一条假路由钉住：demo 侧那道闸只是省一次往返，
     * **真门禁在上游**。会话若走过 `POST /gate/acknowledge`（"读不出来时显式继续"），
     * `gateGuard` 会放行，而上游此时仍可能回 403 两键或门控 401 ⇒ 必须翻回门禁那一屏，
     * 不许折成"面板加载失败"（那等于把门禁未过伪装成数据不存在）。
     * 走 break 形态 + acknowledge 才能到这一步：两闸真挂着时 gateGuard 就先把请求拦下了。
     */
    const panel: RouteTable = {
      'GET /fake-panel': async (_ctx, u) => {
        const rejected = gateGuard(u);
        if (rejected) return rejected;
        try {
          return ok({ data: unwrap<any>(await listProcesses({ client: u.client })) });
        } catch (e) {
          return gateDispatch(e, fail(502, '面板数据读取失败'));
        }
      },
    };
    const routes = { ...gateRoutes, ...panel };
    // 先"显式继续"一次，才能让请求真的出网打到上游那道真闸上
    const pastGate = async (u: typeof f4) => {
      await hit(u, routes, 'POST', '/gate/acknowledge');
    };

    // ① 上游 consent 闸 403 ⇒ 门禁 consent 屏
    const f1 = freshInstance({ break: 'consent-key' });
    await loginInto(f1);
    await pastGate(f1.u);
    expect((await hit(f1.u, routes, 'GET', '/fake-panel')).json).toMatchObject({
      step: 'consent',
      consentRequired: true,
    });
    // ② 上游改密闸 403 ⇒ 门禁 password 屏
    const f2 = freshInstance({ agreed: true, break: 'must-change-key' });
    await loginInto(f2);
    await pastGate(f2.u);
    expect((await hit(f2.u, routes, 'GET', '/fake-panel')).json).toMatchObject({
      step: 'password',
      mustChangePassword: true,
    });
    // ③ 门控 401（会话死了）⇒ 401 回登录屏，不是 502
    const f3 = freshInstance({ break: 'consent-key' });
    await loginInto(f3);
    await pastGate(f3.u);
    f3.u.authenticate('ROTATED-AWAY');
    const dead = await hit(f3.u, routes, 'GET', '/fake-panel');
    expect(dead.status).toBe(401);
    expect(dead.json).toMatchObject({ step: 'login' });
    // ④ 与门禁无关的失败（上游 500）才走调用方给的兜底
    const f4 = statefulUpstream(async () => ({ status: 500, body: { message: '上游内部错' } }));
    f4.authenticate('TK-fixture');
    await pastGate(f4);
    const own = await hit(f4, routes, 'GET', '/fake-panel');
    expect(own.status).toBe(502);
    expect(own.json.message).toContain('面板数据读取失败');
  });

  it('显式继续：读不出来时 gateGuard 放行，门禁可读时这条一律 409（不是万能绕过口）', async () => {
    const unreadable = freshInstance({ break: 'consent-key' });
    await loginInto(unreadable);
    const ack = await hit(unreadable.u, gateRoutes, 'POST', '/gate/acknowledge');
    expect(ack.json).toMatchObject({ step: 'app' });
    expect(gateGuard(unreadable.u)).toBeNull(); // 由服务端记账的"操作者认下来一次"

    const readable = freshInstance(); // consentRequired:true 明摆着挂着，不是一句"读不出来" 
    await loginInto(readable);
    const denied = await hit(readable.u, gateRoutes, 'POST', '/gate/acknowledge');
    expect(denied.status).toBe(409);
    expect(denied.json).toMatchObject({ step: 'consent' });
    expect(gateGuard(readable.u)).toMatchObject({ status: 403 });
  });

  it('换目标实例把门禁缓存一并清掉：上一台"两闸已过"不能替这一台放行', async () => {
    const routes = { ...collectRoutes() };
    const f = freshInstance({ agreed: true, changed: true });
    const u = f.u;
    await hit(u, routes, 'POST', '/gate/login', { password: 'old-pass' });
    expect(gateGuard(u)).toBeNull();
    const r = await hit(u, routes, 'POST', '/set-base-url', { baseUrl: 'http://127.0.0.1:6001' });
    expect(r.json).toMatchObject({ step: 'login' });
    expect(gateGuard(u)).toMatchObject({ status: 401 }); // 没会话了
    u.authenticate('TK-fixture'); // 假设有会话但没有读过门禁状态
    expect(gateGuard(u)).toMatchObject({ status: 403, body: { step: 'unknown' } });
  });
});
