// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
/**
 * L4：一次性全新非 dev 夹具上的五条硬要求（设计口径）。默认 skip，只有 `SNOWLUMA_FIXTURE=1` 才跑。
 *
 * 为什么必须有 L2/L3 之外的这一层：前两层打在假上游上，而假上游的每个键都是我自己写的
 * ——它证明的是"我的代码对我写的形状正确"。这一层打的是**上游真实返回什么**，
 * 且必须打在**全新安装**上：门禁矩阵只有在 `consentRequired` 与 `mustChangePassword`
 * 同时为真的一台机器上才验得出先后次序（`server.ts:645` 的同意闸排在 `:652` 的改密闸之前），
 * 拿一台已经配置好的实例跑，两个闸都早就是 false，缺陷会被实例状态掩盖。
 *
 * 出处（本文件逐条对着实码核过）：
 *  · 同意闸白名单 = `CONSENT_ALLOWLIST`（`packages/core/src/webui/server.ts:223-229`）
 *    —— 里面**没有** `/api/ui/public`；它 200 是另一条机制（`:631` 的免 bearer 短路），所以单独测。
 *  · 403 体：同意闸给 `{status:'failed', message, consentRequired:true}`（`:646-648`），
 *    改密闸给 `{..., mustChangePassword:true}`（`:653`）⇒ 两闸各占一键，不会同时出现。
 *  · 三条流首帧：state `send({kind:'ready'})`（`:1400`）、debug `send({kind:'ready'})`（`:1355`）、
 *    logs `ch.send({type:'ready'})`（`:1460`）—— logs 那一条用 `type`，词表各归各的。
 *  · `x-snowluma-sse` 全文只有 1 处（`spec/openapi.yaml:1804`，state），
 *    `tagFields: [kind, resource]`、`droppedUnderBackpressure: true`。
 *    计划单第 4 条写的 `heartbeatMs/drops/tagFields:['type']` 那种六键形状**在 spec 里不存在**，
 *    照抄等于把想象当成锚点 ⇒ 本测改为核 state 的真键 + 断言其余三条流端点没有这个扩展。
 *  · 2FA 面：`needs-totp` 返回 **200** 且响应里没有 token（`webui/server.ts:697-699`）；
 *    验证码错是 401 且计入 `LOGIN_MAX_ATTEMPTS = 5`（`:121`、`:689-695`）；
 *    `verifyTotpCode` 的接受窗是 `TOTP_WINDOW = 1`（`webui/totp.ts:5`），
 *    但 `step === lastUsedStep` 一律判拒（`:66`），而 confirm 成功就会写下 lastUsedStep（`:180`）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { parse } from 'yaml';
import { readFileSync } from 'node:fs';
import * as sdk from '../generated/typescript/sdk.gen.js';
import { createUpstream, unwrap, type Upstream } from '../demo/server/upstream.js';
import { startFixture, type Fixture } from './fixture.js';

const RUN = process.env.SNOWLUMA_FIXTURE === '1';
let fx: Fixture | null = null;

/** 已越过两闸的会话：三条测共用，改密只该发生一次。 */
let booted: Upstream | null = null;

/** `server.ts:223-229` 里真正属于同意闸的 GET 白名单（record-consent / logout 是 POST，不在读侧名单里）。 */
const CONSENT_ALLOWLIST = ['/api/status', '/api/auth/state', '/api/agreements'];

/** 把 `{uin}` 之类模板参填成可请求的字面量（t1 GET 面里只有 uin；uin 需 5–10 位数字，见 `:235`）。 */
const materialize = (p: string) => p.replace(/\{uin\}/g, '10001').replace(/\{pid\}/g, '999').replace(/\{id\}/g, '1');

function spec(): any {
  return parse(readFileSync('spec/openapi.yaml', 'utf8'));
}

/** spec 里全部 GET 且 t1 的读端点（同意闸应拦下除白名单与免 bearer 短路外的全部）。 */
function readOnlyPaths(): string[] {
  const out: string[] = [];
  for (const [path, item] of Object.entries<any>(spec().paths))
    for (const [method, op] of Object.entries<any>(item))
      if (method === 'get' && op['x-replay-class'] === 't1') out.push(path);
  return out;
}

describe.skipIf(!RUN)('L4 全新非 dev 夹具', () => {
  beforeAll(async () => {
    // 端口交给 startFixture 的默认值（可被 SNOWLUMA_FIXTURE_PORT 覆盖）：这里曾经硬写 5299，
    // 而 Windows 的 TCP 保留段会在运行中被 Hyper-V 重划，本机实测 5238–5337 整段被吞时
    // bind 直接 EACCES、L4 无声起不来。
    fx = await startFixture();
  }, 180_000);

  afterAll(async () => {
    await fx?.stop();
  }, 60_000);

  it('门禁矩阵：login 给 token 但业务读端点 403 带 consentRequired，白名单放行', async () => {
    // login 自身在免 bearer 短路里（server.ts:631），未同意也给 token；被拦的是业务读端点。
    // 这条测的就是"上一版 demo 登录后立刻并发拉全在 403 名单里的端点"那个缺陷。
    const u = createUpstream(fx!.baseUrl);
    const login: any = unwrap(await sdk.login({ client: u.client, body: { password: fx!.password } }));
    expect(login.token).toBeTypeOf('string');
    u.authenticate(login.token);
    fx!.token = login.token;

    const hdr = { authorization: `Bearer ${fx!.token}` };
    for (const p of CONSENT_ALLOWLIST) {
      const r = await fetch(fx!.baseUrl + p, { headers: hdr });
      expect(r.status, `${p} 应在同意闸白名单内放行`).toBe(200);
    }
    // `/api/ui/public` 的 200 与上面同一形状、不同机制：它在 bearer 检查之前就被短路放行。
    // 分开断言是为了"摘掉短路那一行"和"往白名单里加一项"是两个会各自变红的动作。
    const pubNoAuth = await fetch(fx!.baseUrl + '/api/ui/public');
    expect(pubNoAuth.status, '/api/ui/public 免 bearer 也放行').toBe(200);

    let blocked = 0;
    const notBlocked: string[] = [];
    for (const p of readOnlyPaths()) {
      if (CONSENT_ALLOWLIST.includes(p) || p === '/api/ui/public') continue;
      const r = await fetch(fx!.baseUrl + materialize(p), { headers: hdr });
      if (r.status !== 403) {
        notBlocked.push(`${p}→${r.status}`);
        continue;
      }
      const body: any = await r.json();
      expect(body.consentRequired, `${p} 的 403 必须带 consentRequired`).toBe(true);
      expect(body.mustChangePassword, `${p} 的 403 不该同时带改密键（同意闸在 server.ts:645 先返回）`).toBeUndefined();
      blocked += 1;
    }
    // 写死的数而不是 `>=17`：24 条 t1 GET 减去三条白名单减去一条免 bearer 短路 = 20。
    // 换成 >= 的话，将来 spec 新增一条没进白名单的读端点会静默通过，而"新增操作要过门禁"正是设计口径的命题。
    expect(notBlocked, '不该被同意闸拦下的端点').toEqual([]);
    expect(blocked).toBe(20);
  });

  it('净零往返：写同值→回读逐字段相等，且前后夹一次真改动证明写真的落了盘', async () => {
    const u = await boot();

    // 为什么要夹一次真改动：全新实例上"读→原样写回→再读"和"根本没写"两种情况给出同一个结果
    // ——GET 本来就是确定性的默认投影。变异检验（删掉 saveUiConfig 那一行，本用例照绿）坐实了这一点。
    // 先改一笔并验它生效，再原样写回并验逐字段复原，才同时钉住"写会落盘"与"写同值不丢字段"两件事。
    const ui = unwrap<any>(await sdk.getUiConfig({ client: u.client }));
    expect(ui.config, 'GET /api/ui 必须给 config 分支').toBeTypeOf('object');
    const poll0 = ui.config.appearance.pollInterval;
    const poll1 = poll0 === 5000 ? 30000 : 5000;
    unwrap(await sdk.saveUiConfig({
      client: u.client,
      body: { ...ui.config, appearance: { ...ui.config.appearance, pollInterval: poll1 } },
    }));
    const dirtied = unwrap<any>(await sdk.getUiConfig({ client: u.client }));
    expect(dirtied.config.appearance.pollInterval, '整份写回必须真的落盘').toBe(poll1);
    unwrap(await sdk.saveUiConfig({ client: u.client, body: ui.config }));
    const ui2 = unwrap<any>(await sdk.getUiConfig({ client: u.client }));
    expect(ui2.config).toEqual(ui.config); // 写同值必须逐字段回读相等（含 layout/pages 那几支）

    // uin 不必真有其账号：`loadOneBotConfig` 对不存在的文件返回默认投影而不抛
    // （`packages/onebot/src/config.ts:92-114`，GET 侧注释明确"never write defaults to disk"）。
    // 改的是 `statusCommand.enabled` 而不是端口：POST 会走 `oneBotManager.reloadConfig`（server.ts:1572），
    // 无在线会话时它不启动任何监听（`apply.online:false`），但我不赌"端口那一支也一定不动"。
    const cfg = unwrap<any>(await sdk.getOneBotConfig({ client: u.client, path: { uin: '10001' } }));
    expect(cfg.config).toBeTypeOf('object');
    const on0 = cfg.config.statusCommand.enabled;
    unwrap(await sdk.saveOneBotConfig({
      client: u.client,
      path: { uin: '10001' },
      body: { ...cfg.config, statusCommand: { ...cfg.config.statusCommand, enabled: !on0 } },
    }));
    const cfgFlipped = unwrap<any>(await sdk.getOneBotConfig({ client: u.client, path: { uin: '10001' } }));
    expect(cfgFlipped.config.statusCommand.enabled, 'OneBot 整份覆盖必须落盘').toBe(!on0);
    unwrap(await sdk.saveOneBotConfig({ client: u.client, path: { uin: '10001' }, body: cfg.config }));
    const cfg2 = unwrap<any>(await sdk.getOneBotConfig({ client: u.client, path: { uin: '10001' } }));
    expect(cfg2.config).toEqual(cfg.config); // 含每实例随机的 accessToken：原样回传才不许被洗掉

    // 这一条不能整份回传：POST 体走 `coerceSettingsPatch`（`system-settings.ts:19-49`），
    // 只认 webuiPort/webuiHost/tlsEnabled/trustProxy 四键，而 GET 响应是个信封
    // （另有 hasCert/envOverrides/listeningPort/restartRequiredToApply）。
    // 计划单写 `body: sys` 会把信封当补丁发出去 —— 上游对未知键静默忽略，于是那一次"写"其实什么都没写。
    const sys = unwrap<any>(await sdk.getSystemSettings({ client: u.client }));
    const patch0 = onlySettingsKeys(sys.settings);
    unwrap(await sdk.saveSystemSettings({ client: u.client, body: { ...patch0, webuiPort: patch0.webuiPort === 5098 ? 5097 : 5098 } }));
    const sysDirty = unwrap<any>(await sdk.getSystemSettings({ client: u.client }));
    expect(sysDirty.settings.webuiPort, '设置补丁必须落盘').toBe(5098);
    unwrap(await sdk.saveSystemSettings({ client: u.client, body: patch0 }));
    const sys2 = unwrap<any>(await sdk.getSystemSettings({ client: u.client }));
    expect(onlySettingsKeys(sys2.settings)).toEqual(patch0);
    // 夹具的实际监听口不受这笔写影响：env 覆盖只在内存里生效，从不回写盘（`runtime.ts:118-126`）。
    expect(sys2.listeningPort, '改盘上的 webuiPort 不许把正在听的口带跑').toBe(Number(new URL(fx!.baseUrl).port));
  }, 60_000);

  it('三条流首帧契约：ready 的标签词表各归各的（logs 用 type，其余用 kind）', async () => {
    const u = await boot();
    const first = async (name: 'streamState' | 'streamLogs' | 'streamDebugEvents') => {
      const res: any = await (sdk as any)[name]({ client: u.client, signal: AbortSignal.timeout(8000) });
      const it = res.stream[Symbol.asyncIterator]();
      const { value } = await it.next();
      await it.return?.(undefined);
      return value;
    };
    expect(await first('streamState')).toMatchObject({ kind: 'ready' });
    expect(await first('streamLogs')).toMatchObject({ type: 'ready' });
    expect(await first('streamDebugEvents')).toMatchObject({ kind: 'ready' });
  }, 60_000);

  it('x-snowluma-sse 只有 state 一处，其余三条流的锚点不许凭想象补', () => {
    const doc = spec();
    const found: Array<{ path: string; method: string; ext: any }> = [];
    for (const [path, item] of Object.entries<any>(doc.paths))
      for (const [method, op] of Object.entries<any>(item))
        if (op && typeof op === 'object' && op['x-snowluma-sse'])
          found.push({ path, method, ext: op['x-snowluma-sse'] });

    // 全文恰一处。这条断言的作用域是"有人给 logs/debug 也写一个"——那是本仓最省力也最贵的一类缺陷。
    expect(found.map((f) => `${f.method.toUpperCase()} ${f.path}`)).toEqual(['GET /api/state/stream']);

    // state 那一处的键名与值逐字核（不是 toMatchObject 的单向包含就能收工：
    // 键名写错的那一种错，包含式断言看不见）。
    const sse = found[0].ext;
    expect(Object.keys(sse).filter((k) => k !== 'note').sort()).toEqual(
      ['droppedUnderBackpressure', 'framePrefix', 'frameSuffix', 'heartbeatMs', 'tagFields'].sort(),
    );
    expect(sse.heartbeatMs).toBe(15000);
    expect(sse.framePrefix).toBe('data: ');
    expect(sse.frameSuffix).toBe('\n\n');
    expect(sse.tagFields).toEqual(['kind', 'resource']);
    expect(sse.droppedUnderBackpressure).toBe(true);

    // 扩展面 < 流的覆盖面（4 条流端点里只有 1 条带锚点）。这正是上一条 `it` 存在的理由：
    // logs 的首帧标签是 `type`（server.ts:1460），而 spec 的 tagFields 只写了 state 的 [kind, resource]。
    const streamPaths = new Set<string>();
    for (const [path, item] of Object.entries<any>(doc.paths))
      for (const [method, op] of Object.entries<any>(item))
        if (op?.responses?.['200']?.content?.['text/event-stream']) streamPaths.add(`${method.toUpperCase()} ${path}`);
    expect([...streamPaths].sort()).toEqual(
      ['GET /api/debug/stream', 'GET /api/logs/stream', 'GET /api/state/stream', 'POST /api/debug/invoke-stream'].sort(),
    );
    expect(streamPaths.size - found.length).toBe(3);
  });

  // 收编 `demo/.tmp-fixture-2fa.mjs` / `-flows.mjs` 阶段 3 / `-all.mjs` Q1 的第三条：
  // 这三条 L4 之前只有临时探测脚本走过，没有可复跑的断言。放在最后一条是因为它会**永久改变夹具状态**
  // （开了 2FA 之后所有登录都要带码），前面的用例必须先跑完。
  it('2FA 分支：needsTotp 是 200 而不发 token；同一步窗的码不得复用；新步窗的码才给会话', async () => {
    const u = await boot();
    // 绑定
    const enroll: any = unwrap(
      await sdk.beginTotpEnrollment({ client: u.client, body: { issuer: 'SnowLumaFixture', accountName: 'admin' } }),
    );
    expect(enroll.secret).toBeTypeOf('string');
    expect(enroll.otpauthUrl).toContain('otpauth://totp/');
    // 对齐到步窗：整个用例只用同一个 step，而 confirm 与后面的登录隔着几次往返。
    // 剩余不足 10 秒就等它翻窗——否则同一份 secret 在两次调用间跨了窗，红的会是断言而不是行为。
    const remain = 30_000 - (Date.now() % 30_000);
    if (remain < 10_000) await new Promise((r) => setTimeout(r, remain));
    const step = Math.floor(Date.now() / 30_000);
    unwrap(
      await sdk.confirmTotpEnrollment({
        client: u.client,
        body: { password: fx!.password, code: totpAt(enroll.secret, step) },
      }),
    );

    // needs-totp 走的是 200 + `{success:false, needsTotp:true}`（`server.ts:697-699`）。
    // 只看状态码的客户端会把它当登录成功 —— demo 的登录屏读的是 `success` 键，这条测的就是那个选择。
    const bare = await fields(sdk.login({ client: createUpstream(fx!.baseUrl).client, body: { password: fx!.password } }));
    expect(bare.status).toBe(200);
    expect(bare.body).toMatchObject({ success: false, needsTotp: true });
    // 二因子不可绕过的机器形状：这个响应里**根本没有 token 可拿去用**。
    expect('token' in bare.body, 'needsTotp 的 200 不许夹带可用会话').toBe(false);

    // 错码 401（`server.ts:689-695`）。这条连同下面两条都会计入登录限流配额
    // （LOGIN_MAX_ATTEMPTS=5，`server.ts:121`），成功一次才清零 ⇒ 本用例全程只造 2 次失败。
    const bad = await fields(sdk.login({ client: u.client, body: { password: fx!.password, totp: '000000' } }));
    expect(bad.status, '错码必须 401').toBe(401);
    expect(bad.body.success).toBe(false);

    // 同一步窗的码不许用第二次：confirm 刚把这个 step 记进 lastUsedStep（`totp.ts:180`），
    // 登录再递同一个 step 就撞在 `:66` 的 `step === lastUsedStep` 上。
    // 这条是"2FA 是真二因子"的另一半 —— 只验"码对不对"而不验"用过没有"，截获一次码就能永久登录。
    const reuse = await fields(
      sdk.login({ client: u.client, body: { password: fx!.password, totp: totpAt(enroll.secret, step) } }),
    );
    expect(reuse.status, '已被 confirm 消费的那一步窗不得复用').toBe(401);

    // 下一步窗的码可用：`TOTP_WINDOW = 1`（`totp.ts:5`）让 `totp.validate` 接受 ±1 的 delta，
    // 所以这里不必真的等 30 秒 —— 断言的是"推进一个步窗就放行"，不是"时钟必须追上"。
    const good = await fields(
      sdk.login({ client: u.client, body: { password: fx!.password, totp: totpAt(enroll.secret, step + 1) } }),
    );
    expect(good.status).toBe(200);
    expect(good.body.success).toBe(true);
    expect(good.body.token).toBeTypeOf('string');
    // 拿到的会话是真能用的：否则"登录成功"只是响应体的修辞。
    const u2 = createUpstream(fx!.baseUrl);
    u2.authenticate(good.body.token);
    const sys = unwrap<any>(await sdk.getSystem({ client: u2.client }));
    expect(sys).toBeTruthy();
  }, 60_000);
});

/** 只留可写四键（`SYSTEM_SETTINGS_KEYS` 同源）：信封侧的键发出去就是四个假键。 */
function onlySettingsKeys(settings: any): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of ['webuiPort', 'webuiHost', 'tlsEnabled', 'trustProxy'])
    if (settings?.[k] !== undefined) out[k] = settings[k];
  return out;
}

/**
 * 读原始 `{status, body}` 而不折叠：这一条测的**就是**状态码与分支键的对应关系，
 * 走 `unwrap` 会把"200 但 success:false"和"401"混成同一个异常，看不见要测的那件事。
 */
async function fields(res: Promise<any>): Promise<{ status: number; body: any }> {
  const r: any = await res;
  return { status: r.response?.status ?? 0, body: r.error ?? r.data ?? {} };
}

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 6238：SHA1 / 6 位 / 30 秒步长。上游 `totp.ts` 用的就是这套参数（夹具上 begin 回的 secret 是 base32）。 */
function totpAt(secret: string, step: number): string {
  let bits = 0;
  let val = 0;
  const bytes: number[] = [];
  for (const c of secret.toUpperCase().replace(/=+$/, '')) {
    const i = B32.indexOf(c);
    if (i < 0) continue;
    val = (val << 5) | i;
    bits += 5;
    if (bits >= 8) {
      bytes.push((val >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(step, 4);
  const h = createHmac('sha1', Buffer.from(bytes)).update(buf).digest();
  const o = h[h.length - 1] & 0x0f;
  return String((((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1_000_000).padStart(6, '0');
}

async function boot(): Promise<Upstream> {
  if (!booted) booted = await fx!.bootPastGates();
  return booted;
}
