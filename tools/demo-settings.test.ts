// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
/**
 * L2：系统设置屏的服务端路由（19 条操作 / 六个易错面）。
 *
 * 每条形状都逐字读自 spec（carry-notes 10：假上游里多一个键或少一个键，都是把契约写错 ——
 * 测试全绿而真实例永远显示占位符）。关键出处（spec/openapi.yaml 行号）：
 *  · getSystemSettings 200 固定五键，但 `settings` 的 required 是**空数组**（`:927-946`）⇒
 *    "某个键根本没到货"是合法形状，demo 不许补默认值冒充读到了。
 *  · saveSystemSettings / updateStorageSettings / saveUiConfig 三条的 requestBody 只约束为
 *    "对象"（`:2146`、`:2737`、`:2611`），键名唯一可证的来源是**响应侧 schema 的投影**。
 *  · getSystemStorage 200 = `{settings, snapshot, lastCleanup?}`（`:2182-2188`；无清理记录时
 *    lastCleanup 为 null），snapshot 四键 required（`:1001-1018`）。
 *  · updateStorageSettings 的 409 是专用形状 `{success,message,lockedFields}`（`:642-653`）。
 *  · cleanupStorage 请求体是 oneOf 三支且**每支 additionalProperties:false**（`:3139-3168`），
 *    上游 `assertExactKeys` 多一带一键就是 400 ⇒ demo 只能发精确键集；本屏只做 temporary 支。
 *    account/allAccounts 两支要 `confirmation` 等于 ALL_ACCOUNTS_CONFIRMATION 字面量，
 *    而那个字面量 spec 没写（`:3148` 只给常量名）⇒ 无从确证，已登记 declination。
 *  · uploadTlsCert 是 **JSON 里两个 PEM 字符串**（required [cert,key]，`:3020-3030`），不是 multipart；
 *    deleteTlsCert 在 TLS 开启中必 400（`:3055` 附近），400/500 同形状 ⇒ 只能按状态码分流。
 *  · exportBackup 的 `credentials` 是 query 且值域 '0'|'1'（`:3071-3076`），declination
 *    `export-credentials` 已裁定 demo 只导出不带凭据的一份 ⇒ 这条 query 干脆不发。
 *    200 无任何键形（`:3088`），响应头读不到 ⇒ 文件名只能 demo 侧按上游规则拼并注明。
 *  · importBackup required [backup]，`restoreCredentials` 要**精确 true**（`:3104-3114`）；
 *    200 只断言 success（`:3122-3125`）⇒ 不许渲染"恢复了 N 项"。
 *  · TotpStatus 是 enabled 单值互斥的两支（`:1043-1057`）：未开启时**只有 enabled 一键**。
 *  · confirmTotpEnrollment 的第二因子键名是 `code`，disable/regenerate 的是 `totp`（`:2792-2801`
 *    vs `:2831-2841`、`:2868-2877`）—— 两个端点不同名，互换即"永远验不过"。
 *  · confirm/disable/regenerate 的 401 是**业务信封 ∪ 门控 AuthGateError** 双形（字段名分别是
 *    `success` 与 `status`）⇒ 混起来就是把"会话过期"说成"密码错误"。
 */
import { describe, expect, it } from 'vitest';
import { settingsRoutes, SYSTEM_SETTINGS_KEYS } from '../demo/server/routes/settings.js';
import { gateRoutes } from '../demo/server/routes/gates.js';
import { hit, statefulUpstream, type FakeReply, type FakeUpstream } from './helpers/demo-http.js';

const routes = { ...gateRoutes, ...settingsRoutes };

const LEVELS_OK = { success: true };

/** spec 的 settings 四键投影（GET 与 POST 同形）。 */
function systemSettings(over: Record<string, unknown> = {}) {
  return {
    settings: { webuiPort: 5099, webuiHost: '0.0.0.0', tlsEnabled: false, trustProxy: 'false', ...over },
    hasCert: false,
    envOverrides: [],
    listeningPort: 5099,
    restartRequiredToApply: false,
  };
}

const STORAGE = {
  settings: {
    saved: { logMaxTotalMb: 200, logRetainDays: 7, logPerUin: true },
    effective: { logMaxTotalMb: 200, logRetainDays: 7, logPerUin: true },
    envOverrides: [],
  },
  snapshot: {
    logs: {
      state: 'healthy', totalBytes: 100, maxTotalBytes: 200, retainDays: 7, perUinEnabled: true,
      fileCount: 2, activeFileCount: 1, droppedLines: 0,
    },
    temporary: { totalBytes: 50, fileCount: 3, activeItemCount: 1 },
    accounts: [
      { uin: '10001', online: true, messagesBytes: 1, mediaBytes: 2, reactionsBytes: 3, totalBytes: 6, nickname: '夹具小号' },
      { uin: '10002', online: false, messagesBytes: 4, mediaBytes: 5, reactionsBytes: 6, totalBytes: 15 },
    ],
    totals: { logsBytes: 100, temporaryBytes: 50, accountDataBytes: 21, managedBytes: 171 },
  },
  lastCleanup: null,
};

const TOTP_ON = { enabled: true, remainingRecoveryCodes: 2, label: 'SnowLuma:admin' };
const ENROLL = {
  success: true, secret: 'JBSWY3DPEHPK3PXP', otpauthUrl: 'otpauth://totp/SnowLuma:admin?secret=JBSWY3DPEHPK3PXP&issuer=SnowLuma',
  issuer: 'SnowLuma', accountName: 'admin',
};
const RECOVERY = { success: true, recoveryCodes: ['abcd-efgh', 'ijkl-mnop'] };

/** UiConfig 的四支 required 顶层键 + 外观/页面里本屏会写的键，逐条按 spec 的 required 清单给齐。 */
function uiConfig() {
  return {
    version: 7,
    appearance: {
      mode: 'dark', accentMode: 'preset', accentPreset: 'snow', accentCustom: '#39b', accentScope: 'sidebar',
      darkIntensity: 'soft', palette: 'default', sidebarStyle: 'follow',
      background: { type: 'image', color: '', gradient: '', imageOpacity: 0.5, imageBlur: 0, hasImage: true, imageMime: 'image/png', imageVersion: 3 },
      fontSans: 'system', fontSansCustom: '', fontMono: 'mono', fontMonoCustom: '',
      uiScale: 1, radius: 8, density: 'cozy', reduceMotion: false, disableMotion: false,
      customPointerSystem: false, customContextMenu: false, highContrast: false, sidebarPinned: true,
      timeFormat: '24h', pollInterval: 5000, customCss: '', cssVars: {},
    },
    layout: { overviewBlocks: [{ id: 'status', visible: true }], overviewMobile: [], navItems: [{ id: 'overview', visible: true }], topbarItems: [] },
    pages: {
      defaultRoute: 'overview', processesSort: 'uin', configTab: 'onebot',
      logs: { visibleLevels: ['info'], maxLines: 500, autoScroll: true, wrap: false, highlightRules: [], preset: 'dev' },
    },
  };
}

/** 记账型假上游：默认全部按上面那份 spec 形状回答；`overrides` 按路径覆盖。 */
function instance(overrides: Record<string, FakeReply> = {}) {
  const seen: Array<{ path: string; method?: string; body: any; ct: string | null }> = [];
  const handler: FakeUpstream = async (path, init, request) => {
    const clean = path.split('?')[0];
    const ct = (request ? new Headers(request.headers).get('content-type') : '') ?? '';
    // 只有 JSON 体才解析：背景图那条是 multipart，对它 JSON.parse 会抛（本屏唯一非 JSON 上行）。
    // multipart 原样留着文本，好让测试核字段名与字节真的过去了。
    const parsedBody = ct.includes('application/json') && init?.body ? JSON.parse(String(init.body)) : String(init?.body ?? '');
    seen.push({ path, method: init?.method, body: parsedBody, ct: ct ?? '' });
    if (overrides[clean]) return overrides[clean];
    if (clean === '/api/system/settings') {
      if (init?.method === 'POST') return { status: 200, body: { success: true, settings: systemSettings().settings, restartRequiredToApply: true } };
      return { status: 200, body: systemSettings() };
    }
    if (clean === '/api/system/storage') return { status: 200, body: STORAGE };
    if (clean === '/api/system/storage/settings') {
      return { status: 200, body: { success: true, settings: STORAGE.settings, status: STORAGE.snapshot.logs, snapshot: STORAGE.snapshot } };
    }
    if (clean === '/api/system/storage/cleanup') {
      return { status: 200, body: { success: true, scope: 'temporary', cleanup: { deletedFiles: 3, freedBytes: 50, skippedActiveItems: 1, failures: [] }, snapshot: STORAGE.snapshot, lastCleanup: null } };
    }
    if (clean === '/api/system/tls/cert') {
      if (init?.method === 'DELETE') return { status: 200, body: { success: true } };
      return { status: 200, body: { success: true, restartRequiredToApply: true } };
    }
    if (clean === '/api/system/backup/export') return { status: 200, body: { app: 'snowluma', version: '1.14.20', config: { anything: true } } };
    if (clean === '/api/system/backup/import') return { status: 200, body: { success: true } };
    if (clean === '/api/auth/totp') return { status: 200, body: TOTP_ON };
    if (clean === '/api/auth/totp/begin') return { status: 200, body: ENROLL };
    if (clean === '/api/auth/totp/confirm' || clean === '/api/auth/totp/recovery-codes') return { status: 200, body: RECOVERY };
    if (clean === '/api/auth/totp/disable') return { status: 200, body: LEVELS_OK };
    if (clean === '/api/ui' || clean === '/api/ui/background') {
      if (init?.method === 'DELETE') return { status: 200, body: { success: true, config: uiConfig() } };
      return { status: 200, body: { success: true, config: uiConfig() } };
    }
    return { status: 404, body: { success: false, message: `设置夹具没有 ${clean} 这条` } };
  };
  return { seen, u: statefulUpstream(handler) };
}

async function pastTheGate(u: ReturnType<typeof statefulUpstream>): Promise<void> {
  u.authenticate('TK-fixture');
  expect((await hit(u, routes, 'POST', '/gate/acknowledge', {})).json).toMatchObject({ step: 'app' });
}

describe('settings (L2)', () => {
  it('系统闸口：GET 原样带出五键；settings 少到货的键不补默认（required 是空数组）', async () => {
    const f = instance();
    await pastTheGate(f.u);
    const r = await hit(f.u, settingsRoutes, 'GET', '/system-settings-detail');
    expect(r.json.data).toEqual(systemSettings());
    // 上游对 settings 的 required 是 []：少一个键就是"没读到"，demo 补 false 就是撒谎
    const thin = instance({ '/api/system/settings': { status: 200, body: { ...systemSettings(), settings: { webuiPort: 5099 } } } });
    await pastTheGate(thin.u);
    const t = await hit(thin.u, settingsRoutes, 'GET', '/system-settings-detail');
    expect(t.json.data.settings).toEqual({ webuiPort: 5099 });
    expect('tlsEnabled' in t.json.data.settings).toBe(false);
  });

  it('系统闸口保存：只上行白名单四键，其余键丢掉；一个都不认就 400 且不出网', async () => {
    const f = instance();
    await pastTheGate(f.u);
    expect(SYSTEM_SETTINGS_KEYS).toEqual(['webuiPort', 'webuiHost', 'tlsEnabled', 'trustProxy']);
    const r = await hit(f.u, settingsRoutes, 'POST', '/system-settings-patch', {
      patch: { webuiPort: 5100, tlsEnabled: true, hasCert: true, injected: 'x' },
    });
    expect(r.status).toBe(200);
    const sent = f.seen.filter((s) => s.path === '/api/system/settings' && s.method === 'POST').pop();
    expect(sent?.body).toEqual({ webuiPort: 5100, tlsEnabled: true });
    const before = f.seen.length;
    const bad = await hit(f.u, settingsRoutes, 'POST', '/system-settings-patch', { patch: { nonsense: 1 } });
    expect(bad.status).toBe(400);
    expect(f.seen.length).toBe(before);
  });

  it('存储用量：读 snapshot 四键与 lastCleanup:null，顶层读不到会永远显示空表（设计口径）', async () => {
    const f = instance();
    await pastTheGate(f.u);
    const r = await hit(f.u, settingsRoutes, 'GET', '/storage');
    expect(r.json.data.snapshot.totals.managedBytes).toBe(171);
    expect(r.json.data.snapshot.accounts).toHaveLength(2);
    expect(r.json.data.lastCleanup).toBeNull();
    expect(r.json.data.settings.effective.logRetainDays).toBe(7);
  });

  it('存储策略：补丁只发编辑过的键（partial）；409 的 lockedFields 原样交回（专用形状，不是通用信封）', async () => {
    const f = instance();
    await pastTheGate(f.u);
    await hit(f.u, settingsRoutes, 'POST', '/storage-patch', { patch: { logRetainDays: 14 } });
    const sent = f.seen.filter((s) => s.path === '/api/system/storage/settings').pop();
    expect(sent?.body).toEqual({ logRetainDays: 14 });
    const locked = instance({
      '/api/system/storage/settings': { status: 409, body: { success: false, message: '被环境变量锁定', lockedFields: ['logMaxTotalMb'] } },
    });
    await pastTheGate(locked.u);
    const r = await hit(locked.u, settingsRoutes, 'POST', '/storage-patch', { patch: { logMaxTotalMb: 1 } });
    expect(r.status).toBe(409);
    expect(r.json.lockedFields).toEqual(['logMaxTotalMb']);
    expect(r.json.message).toBe('被环境变量锁定');
  });

  it('清理临时文件：请求体必须精确只带 scope 一键（oneOf 三支各自 additionalProperties:false）', async () => {
    const f = instance();
    await pastTheGate(f.u);
    const r = await hit(f.u, settingsRoutes, 'POST', '/storage-cleanup', {});
    expect(r.status).toBe(200);
    const sent = f.seen.filter((s) => s.path === '/api/system/storage/cleanup').pop();
    expect(sent?.body).toEqual({ scope: 'temporary' });
  });

  it('清理：非 temporary 的三支直接 400 且不出网（confirmation 字面量 spec 未给值）', async () => {
    const f = instance();
    await pastTheGate(f.u);
    const before = f.seen.length;
    for (const scope of ['logs', 'account', 'allAccounts']) {
      const r = await hit(f.u, settingsRoutes, 'POST', '/storage-cleanup', { scope });
      expect(r.status, scope).toBe(400);
      expect(r.json.message).toContain('cleanup-scopes-outside-temporary');
    }
    expect(f.seen.length).toBe(before);
  });

  it('存储：缺 snapshot 键时 502 报出来，不把空表当成"没有占用"', async () => {
    const f = instance({ '/api/system/storage': { status: 200, body: { settings: STORAGE.settings } } });
    await pastTheGate(f.u);
    const r = await hit(f.u, settingsRoutes, 'GET', '/storage');
    expect(r.status).toBe(502);
    expect(r.json.message).toContain('snapshot');
  });

  it('清理回 500 但快照里清理已发生 ⇒ 状态码与 cleanup 都要交回，不许说成"没发生"', async () => {
    const f = instance({
      '/api/system/storage/cleanup': {
        status: 500,
        body: { success: false, message: '统计刷新失败', scope: 'temporary', cleanup: { deletedFiles: 2, freedBytes: 9, skippedActiveItems: 0, failures: [] } },
      },
    });
    await pastTheGate(f.u);
    const r = await hit(f.u, settingsRoutes, 'POST', '/storage-cleanup', {});
    expect(r.status).toBe(500);
    expect(r.json.message).toBe('统计刷新失败');
    expect(r.json.cleanup).toMatchObject({ deletedFiles: 2 });
  });

  it('TLS：JSON 里两个 PEM 字符串都要；少一个 400 且不出网；dataUrl 也译成文本', async () => {
    const f = instance();
    await pastTheGate(f.u);
    const before = f.seen.length;
    const half = await hit(f.u, settingsRoutes, 'POST', '/tls-upload', { certText: 'CERT' });
    expect(half.status).toBe(400);
    expect(f.seen.length).toBe(before);
    const pem = (s: string) => 'data:application/x-pem-file;base64,' + Buffer.from(s, 'utf8').toString('base64');
    const r = await hit(f.u, settingsRoutes, 'POST', '/tls-upload', { certDataUrl: pem('PEM-CERT'), keyDataUrl: pem('PEM-KEY') });
    expect(r.status).toBe(200);
    const sent = f.seen.filter((s) => s.path === '/api/system/tls/cert' && s.method === 'POST').pop();
    expect(sent?.body).toEqual({ cert: 'PEM-CERT', key: 'PEM-KEY' });
    expect(sent?.ct).toContain('application/json'); // 背景图那条才是 multipart，这条不是
  });

  it('TLS 删除：上游"开启中禁删"的 400 原样保住状态码与原文，不折成 502', async () => {
    const f = instance({ '/api/system/tls/cert': { status: 400, body: { success: false, message: 'TLS 开启中，禁止删除证书' } } });
    await pastTheGate(f.u);
    const r = await hit(f.u, settingsRoutes, 'POST', '/tls-delete', {});
    expect(r.status).toBe(400);
    expect(r.json.message).toBe('TLS 开启中，禁止删除证书');
    expect(f.seen.some((s) => s.path === '/api/system/tls/cert' && s.method === 'DELETE')).toBe(true);
  });

  it('备份导出：绝不发 credentials query（declination export-credentials）；正文只透传、字节数按 utf8 算', async () => {
    const f = instance();
    await pastTheGate(f.u);
    const r = await hit(f.u, settingsRoutes, 'GET', '/backup-export');
    expect(f.seen.filter((s) => s.path.startsWith('/api/system/backup/export')).at(-1)?.path).toBe('/api/system/backup/export');
    expect(r.json.data.text).toContain('snowluma');
    expect(r.json.data.bytes).toBe(Buffer.byteLength(String(r.json.data.text), 'utf8'));
    expect(JSON.stringify(r.json.data)).not.toContain('credentials');
  });

  it('备份导出文件名：demo 侧按上游规则拼（Content-Disposition 读不到）且明写是 demo 拼的', async () => {
    const f = instance();
    await pastTheGate(f.u);
    const r = await hit(f.u, settingsRoutes, 'GET', '/backup-export');
    // 上游那份文件名在 Content-Disposition 里，生成的客户端读不到 ⇒ demo 侧按同规则拼，且必须自称是 demo 侧拼的
    expect(r.json.data.filename).toMatch(/^snowluma-backup-[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}\.json$/);
    expect(r.json.data.filenameNote).toContain('demo');
  });

  it('备份导入：必须 {backup} 包裹；restoreCredentials 只在显式勾选时上行；200 只认 success', async () => {
    const f = instance();
    await pastTheGate(f.u);
    const bare = await hit(f.u, settingsRoutes, 'POST', '/backup-import', { app: 'snowluma' });
    expect(bare.status).toBe(400);
    const r = await hit(f.u, settingsRoutes, 'POST', '/backup-import', { backup: { app: 'snowluma', version: '1' } });
    expect(r.status).toBe(200);
    expect(r.json.data).toEqual({ success: true });
    let sent = f.seen.filter((s) => s.path === '/api/system/backup/import').pop();
    expect(sent?.body).toEqual({ backup: { app: 'snowluma', version: '1' } });
    await hit(f.u, settingsRoutes, 'POST', '/backup-import', { backup: { a: 1 }, restoreCredentials: 'true' });
    sent = f.seen.filter((s) => s.path === '/api/system/backup/import').pop();
    expect('restoreCredentials' in sent!.body).toBe(false); // 上游判的是 === true，字符串不算
    await hit(f.u, settingsRoutes, 'POST', '/backup-import', { backup: { a: 1 }, restoreCredentials: true });
    sent = f.seen.filter((s) => s.path === '/api/system/backup/import').pop();
    expect(sent?.body).toEqual({ backup: { a: 1 }, restoreCredentials: true });
  });

  it('TOTP 状态：两支都原样带出，未开启支只有 enabled 一键（不许当成读失败）', async () => {
    const on = instance();
    await pastTheGate(on.u);
    expect((await hit(on.u, settingsRoutes, 'GET', '/totp-status')).json.data).toEqual(TOTP_ON);
    const off = instance({ '/api/auth/totp': { status: 200, body: { enabled: false } } });
    await pastTheGate(off.u);
    const r = await hit(off.u, settingsRoutes, 'GET', '/totp-status');
    expect(r.json.data).toEqual({ enabled: false });
    expect('remainingRecoveryCodes' in r.json.data).toBe(false);
  });

  it('TOTP 关闭：缺第二因子直接 400 且不出网（设计口径）；totp 与 recoveryCode 任一可上行', async () => {
    const f = instance();
    await pastTheGate(f.u);
    const before = f.seen.length;
    for (const body of [{ password: 'p' }, {}, { totp: '123456' }, null]) {
      const r = await hit(f.u, settingsRoutes, 'POST', '/totp-disable', body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.json.message).toMatch(/totp|恢复码/i);
    }
    expect(f.seen.length).toBe(before);
    await hit(f.u, settingsRoutes, 'POST', '/totp-disable', { password: 'p', totp: '123456' });
    await hit(f.u, settingsRoutes, 'POST', '/totp-disable', { password: 'p', recoveryCode: 'abcd-efgh' });
    const sends = f.seen.filter((s) => s.path === '/api/auth/totp/disable').map((s) => s.body);
    expect(sends).toEqual([
      { password: 'p', totp: '123456' },
      { password: 'p', recoveryCode: 'abcd-efgh' },
    ]);
  });

  it('TOTP 确认：键名是 code（不是 totp）；恢复码重生成只发 password+totp（那边没有恢复码这条路）', async () => {
    const f = instance();
    await pastTheGate(f.u);
    await hit(f.u, settingsRoutes, 'POST', '/totp-confirm', { password: 'p', code: '123456' });
    expect(f.seen.filter((s) => s.path === '/api/auth/totp/confirm').pop()?.body).toEqual({ password: 'p', code: '123456' });
    const r = await hit(f.u, settingsRoutes, 'POST', '/totp-recovery', { password: 'p', totp: '123456' });
    expect(r.json.data).toEqual(RECOVERY);
    expect(f.seen.filter((s) => s.path === '/api/auth/totp/recovery-codes').pop()?.body).toEqual({ password: 'p', totp: '123456' });
    const wrong = await hit(f.u, settingsRoutes, 'POST', '/totp-recovery', { password: 'p', recoveryCode: 'abcd-efgh' });
    expect(wrong.status).toBe(400);
    expect(wrong.json.message).toMatch(/totp|当前码/);
  });

  it('TOTP 的两形 401：业务 401 留原码原文，门控 401 交回登录屏', async () => {
    const biz = instance({ '/api/auth/totp/disable': { status: 401, body: { success: false, message: '口令不正确' } } });
    await pastTheGate(biz.u);
    const r = await hit(biz.u, settingsRoutes, 'POST', '/totp-disable', { password: 'p', totp: '1' });
    expect(r.status).toBe(401);
    expect(r.json.message).toBe('口令不正确');
    expect(JSON.stringify(r.json)).not.toContain('step');
    const gate = instance({ '/api/auth/totp/disable': { status: 401, body: { status: 'failed', message: 'Token expired or invalid' } } });
    await pastTheGate(gate.u);
    const g = await hit(gate.u, settingsRoutes, 'POST', '/totp-disable', { password: 'p', totp: '1' });
    expect(g.json).toMatchObject({ step: 'login' });
  });

  it('TOTP 已开启的 409 与开发模式 400：状态码与原文都要交回，不折成 502', async () => {
    const f = instance({ '/api/auth/totp/begin': { status: 409, body: { success: false, message: '已开启两步验证' } } });
    await pastTheGate(f.u);
    const r = await hit(f.u, settingsRoutes, 'POST', '/totp-begin', {});
    expect(r.status).toBe(409);
    expect(r.json.message).toBe('已开启两步验证');
    const dev = instance({ '/api/auth/totp': { status: 400, body: { success: false, message: '开发模式禁用 2FA' } } });
    await pastTheGate(dev.u);
    expect((await hit(dev.u, settingsRoutes, 'GET', '/totp-status')).status).toBe(400);
  });

  it('绑定流程的 secret 只在响应里交回一次：服务端不落盘、不进任何日志面', async () => {
    const f = instance();
    await pastTheGate(f.u);
    const r = await hit(f.u, settingsRoutes, 'POST', '/totp-begin', {});
    expect(r.json.data.secret).toBe(ENROLL.secret);
    // 唯一允许留存 secret 的地方是这次响应；出现第三条上行或任何写文件动作都算违规
    expect(f.seen.filter((s) => s.path === '/api/auth/totp/begin')).toHaveLength(1);
  });

  it('UI 配置：读 {config}；保存是"现读-改-整份回传"（只动白名单里被编辑的键，其余原样）', async () => {
    const f = instance();
    await pastTheGate(f.u);
    const r = await hit(f.u, settingsRoutes, 'POST', '/ui-appearance-save', {
      patch: { appearance: { mode: 'light', pollInterval: 8000 }, pages: { defaultRoute: 'logs' } },
    });
    expect(r.status).toBe(200);
    const sent = f.seen.filter((s) => s.path === '/api/ui' && s.method === 'POST').pop();
    expect(sent?.body.version).toBe(7);
    expect(sent?.body.layout).toEqual(uiConfig().layout);
    expect(sent?.body.pages.defaultRoute).toBe('logs');
    expect(sent?.body.pages.logs).toEqual(uiConfig().pages.logs); // 没编辑的那一支整支原样
    expect(sent?.body.appearance.mode).toBe('light');
    expect(sent?.body.appearance.pollInterval).toBe(8000);
    expect(sent?.body.appearance.density).toBe('cozy');
    // 保存前必须先读一次现网配置（写的是整份），所以那次 POST 之前有一条 GET
    const at = f.seen.findIndex((s) => s.path === '/api/ui' && s.method === 'POST');
    expect(f.seen.slice(0, at).some((s) => s.path === '/api/ui' && s.method === 'GET')).toBe(true);
    // hasImage / imageVersion 是 Server-managed（`:681-684`）：只原样回传，本屏没有控件写它们
    expect(sent?.body.appearance.background.hasImage).toBe(true);
    expect(sent?.body.appearance.background.imageVersion).toBe(3);
  });

  it('UI 配置读取：GET /ui-config 原样带出整份 config（四支顶层键都在）', async () => {
    const f = instance();
    await pastTheGate(f.u);
    const got = await hit(f.u, settingsRoutes, 'GET', '/ui-config');
    expect(got.json.data).toEqual(uiConfig());
  });

  it('UI 保存的补丁白名单：放弃清单里的键（palette/cssVars/customCss）与未知键都不接受写入', async () => {
    const f = instance();
    await pastTheGate(f.u);
    await hit(f.u, settingsRoutes, 'POST', '/ui-appearance-save', {
      patch: { appearance: { palette: 'nord', cssVars: { '--x': '1' }, customCss: 'body{}', accentPreset: 'other', bogus: 1 } },
    });
    const sent = f.seen.filter((s) => s.path === '/api/ui' && s.method === 'POST').pop();
    expect(sent?.body.appearance.palette).toBe('default'); // 原样回传读到的那份，但不接受改写
    expect(sent?.body.appearance.cssVars).toEqual({});
    expect(sent?.body.appearance.customCss).toBe('');
    expect(sent?.body.appearance.accentPreset).toBe('other'); // 这条在白名单里
    expect('bogus' in sent!.body.appearance).toBe(false);
    const bad = await hit(f.u, settingsRoutes, 'POST', '/ui-appearance-save', { patch: { layout: { navItems: [] } } });
    expect(bad.status).toBe(400); // pages 只放行 defaultRoute/processesSort/configTab，layout 整支不在本屏写
  });

  it('UI 保存：读不到现网配置就不许盲发整份（会把没编辑过的分支洗成 demo 的默认）', async () => {
    const f = instance({ '/api/ui': { status: 500, body: { success: false, message: '读不到' } } });
    await pastTheGate(f.u);
    const before = f.seen.length;
    const r = await hit(f.u, settingsRoutes, 'POST', '/ui-appearance-save', { patch: { appearance: { mode: 'light' } } });
    expect(r.status).toBe(409);
    expect(f.seen.filter((s) => s.method === 'POST' && s.path === '/api/ui').length).toBe(0);
    expect(f.seen.length).toBe(before + 1); // 只有那次失败的读，没有写
  });

  it('日志偏好只放行 preset 一键（其余五键属显示侧，见 declination logs-view-presets / logs-highlight-rules）', async () => {
    const f = instance();
    await pastTheGate(f.u);
    await hit(f.u, settingsRoutes, 'POST', '/ui-appearance-save', { patch: { pages: { logs: { preset: 'ops' } } } });
    const sent = f.seen.filter((s) => s.path === '/api/ui' && s.method === 'POST').pop();
    expect(sent?.body.pages.logs.preset).toBe('ops');
    expect(sent?.body.pages.logs.maxLines).toBe(500); // 没放行也没被改写：原样回传读到的那份
    const before = f.seen.length;
    const bad = await hit(f.u, settingsRoutes, 'POST', '/ui-appearance-save', { patch: { pages: { logs: { maxLines: 999 } } } });
    expect(bad.status).toBe(400);
    expect(f.seen.length).toBe(before);
  });

  it('背景图：浏览器只交 dataUrl，服务端译成 File 后走那条唯一的 multipart；清除走 DELETE 并把新 config 交回', async () => {
    const f = instance();
    await pastTheGate(f.u);
    const bad = await hit(f.u, settingsRoutes, 'POST', '/ui-bg-upload', {});
    expect(bad.status).toBe(400);
    const png = 'data:image/png;base64,iVBORw0KGgo=';
    const r = await hit(f.u, settingsRoutes, 'POST', '/ui-bg-upload', { dataUrl: png, name: 'bg.png' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const up = f.seen.filter((s) => s.path === '/api/ui/background' && s.method === 'POST').pop();
    expect(up?.ct).toContain('multipart/form-data'); // 生成客户端自带 formDataBodySerializer，别再手设 Content-Type
    // 字段名与文件名都要真过去：spec 对这条只认一个键 `file`（required:[file]，`:1897-1905`）
    expect(String(up?.body)).toContain('name="file"');
    expect(String(up?.body)).toContain('bg.png');
    const cleared = await hit(f.u, settingsRoutes, 'POST', '/ui-bg-clear', {});
    expect(cleared.json.data.config.appearance.mode).toBe('dark');
    expect(f.seen.some((s) => s.path === '/api/ui/background' && s.method === 'DELETE')).toBe(true);
  });

  it('每一条设置路由都有第二道闸：门禁未过时 403 且一条都不出网', async () => {
    const keys = Object.keys(settingsRoutes);
    // 18 条 = 本屏 18 个操作各一条（getSystem 归总览页），名单变动必须同时改这里
    expect(keys).toHaveLength(18);
    for (const key of keys) {
      const [method, path] = key.split(' ');
      const f = instance();
      f.u.authenticate('TK-fixture'); // 有会话，但门禁状态没读过
      const r = await hit(f.u, routes, method, path, method === 'GET' || method === 'DELETE' ? undefined : {});
      expect(r.status, key).toBe(403);
      expect(r.json, key).toMatchObject({ step: 'unknown' });
      expect(f.seen, key + ' 不许出网').toEqual([]);
    }
  });

  it('上游那道真闸不能被折成"读取失败"：403 两键与门控 401 都交回门禁', async () => {
    const consent = { status: 403, body: { status: 'failed', message: '请先阅读并同意', consentRequired: true } };
    const mustChange = { status: 403, body: { status: 'failed', message: '请先修改密码', mustChangePassword: true } };
    for (const [label, gate] of [['consent', consent], ['password', mustChange]] as const) {
      const f = instance({ '/api/system/settings': gate, '/api/system/storage': gate, '/api/auth/totp': gate, '/api/ui': gate });
      await pastTheGate(f.u);
      for (const path of ['/system-settings-detail', '/storage', '/totp-status', '/ui-config']) {
        const r = await hit(f.u, settingsRoutes, 'GET', path);
        expect(JSON.stringify(r.json), `${label} ${path} ⇒ 必须是门禁信号`).toContain('step');
      }
    }
  });
});
