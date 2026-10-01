// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
// @vitest-environment happy-dom
/**
 * L3：系统设置屏的取数、上行与"一次性凭据"闭环（fetch 桩）。
 * 专抓 L2 够不着的那一类：路由形状对但客户端读错键、2xx 被丢、控件名单与 parity 不一致、
 * secret/恢复码被写进 localStorage、TLS 开启中还把删除请求发上去。
 * 下拉当前值按 `selected` **属性**断言，不按 `.value`（carry-notes 13）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mountSettings } from '../demo/client/pages/settings.js';
import { PARITY } from '../demo/parity.js';

const SYSTEM = {
  settings: { webuiPort: 5099, webuiHost: '0.0.0.0', tlsEnabled: false, trustProxy: 'false' },
  hasCert: false,
  envOverrides: [],
  listeningPort: 5099,
  restartRequiredToApply: false,
};
const STORAGE = {
  settings: {
    saved: { logMaxTotalMb: 200, logRetainDays: 7, logPerUin: true },
    effective: { logMaxTotalMb: 200, logRetainDays: 7, logPerUin: true },
    envOverrides: ['logMaxTotalMb'],
  },
  snapshot: {
    logs: { state: 'healthy', totalBytes: 100, maxTotalBytes: 200, retainDays: 7, perUinEnabled: true, fileCount: 2, activeFileCount: 1, droppedLines: 0 },
    temporary: { totalBytes: 50, fileCount: 3, activeItemCount: 1 },
    accounts: [
      { uin: '10001', online: true, messagesBytes: 1, mediaBytes: 2, reactionsBytes: 3, totalBytes: 6, nickname: '夹具小号' },
      { uin: '10002', online: false, messagesBytes: 4, mediaBytes: 5, reactionsBytes: 6, totalBytes: 15 },
    ],
    totals: { logsBytes: 100, temporaryBytes: 50, accountDataBytes: 21, managedBytes: 171 },
  },
  lastCleanup: null,
};
const UI = {
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
  layout: { overviewBlocks: [], overviewMobile: [], navItems: [], topbarItems: [] },
  pages: {
    defaultRoute: 'overview', processesSort: 'uin', configTab: 'onebot',
    logs: { visibleLevels: ['info'], maxLines: 500, autoScroll: true, wrap: false, highlightRules: [], preset: 'dev' },
  },
};

interface Call {
  url: string;
  method: string;
  body: any;
}
type Reply = { status?: number; body?: unknown };

function stub(overrides: Record<string, Reply> = {}) {
  const seen: Call[] = [];
  const table: Record<string, Reply> = {
    'GET /system-settings-detail': { body: { data: SYSTEM } },
    'POST /system-settings-patch': { body: { data: { success: true, settings: SYSTEM.settings, restartRequiredToApply: true } } },
    'GET /storage': { body: { data: STORAGE } },
    'POST /storage-patch': { body: { data: { success: true, settings: STORAGE.settings, status: STORAGE.snapshot.logs, snapshot: STORAGE.snapshot } } },
    'POST /storage-cleanup': {
      body: {
        data: {
          success: true, scope: 'temporary',
          cleanup: { deletedFiles: 3, freedBytes: 50, skippedActiveItems: 1, failures: [] },
          snapshot: STORAGE.snapshot, lastCleanup: null,
        },
      },
    },
    'POST /tls-upload': { body: { data: { success: true, restartRequiredToApply: true, reloadRequired: true } } },
    'POST /tls-delete': { body: { data: { success: true } } },
    'GET /backup-export': { body: { data: { text: JSON.stringify({ app: 'snowluma', secretToken: 'TOP-SECRET-VALUE' }), bytes: 40, filename: 'snowluma-backup-2026-09-28T23-00-00.json', filenameNote: '文件名由 demo 侧按上游同一规则拼（生成的客户端读不到响应头）' } } },
    'POST /backup-import': { body: { data: { success: true } } },
    'GET /totp-status': { body: { data: { enabled: true, remainingRecoveryCodes: 2, label: 'SnowLuma:admin' } } },
    'POST /totp-begin': { body: { data: { success: true, secret: 'JBSWY3DPEHPK3PXP', otpauthUrl: 'otpauth://totp/SnowLuma:admin?secret=JBSWY3DPEHPK3PXP', issuer: 'SnowLuma', accountName: 'admin' } } },
    'POST /totp-confirm': { body: { data: { success: true, recoveryCodes: ['abcd-efgh', 'ijkl-mnop'] } } },
    'POST /totp-disable': { body: { data: { success: true } } },
    'POST /totp-recovery': { body: { data: { success: true, recoveryCodes: ['qqqq-wwww'] } } },
    'GET /ui-config': { body: { data: UI } },
    'POST /ui-appearance-save': { body: { data: { success: true, config: UI } } },
    'POST /ui-bg-upload': { body: { data: { success: true, config: UI } } },
    'POST /ui-bg-clear': { body: { data: { success: true, config: UI } } },
    ...overrides,
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      const pathname = String(path).split('?')[0];
      seen.push({ url: String(path), method, body: init?.body ? JSON.parse(String(init.body)) : null });
      const out = table[`${method} ${pathname}`] ?? { status: 404, body: { success: false, message: `桩里没有 ${method} ${pathname}` } };
      return new Response(JSON.stringify(out.body), { status: out.status ?? 200, headers: { 'content-type': 'application/json' } });
    }),
  );
  return { seen, u: window.fetch as ReturnType<typeof vi.fn> };
}

async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}

function host(): HTMLElement {
  document.body.innerHTML = '<div id="panel"></div>';
  const el = document.getElementById('panel')!;
  return el;
}

const q = (sel: string) => document.querySelector(sel) as HTMLElement | null;
const ctl = (name: string) => q(`[data-ctl="${name}"]`);
const text = (name: string) => ctl(name)?.textContent ?? '';
const byData = (attr: string) => document.querySelector(`[${attr}]`) as HTMLElement | null;

/** 像用户那样改值：赋值 + change（提交侧只认"真改过的字段"，见 pages/settings.ts 的 touched）。 */
function set(el: HTMLInputElement | HTMLSelectElement, value: string): void {
  el.value = value;
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

describe('mountSettings 取数与写回闭环', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('控件名单与 parity 的 settings 边逐字一致（少一个控件门禁就红，多一个也算错）', async () => {
    const want = PARITY.filter((e) => e.panel === 'settings').flatMap((e) => e.controls);
    const f = stub();
    const h = host();
    const mounted = mountSettings(h);
    await flush();
    const got = [...document.querySelectorAll('[data-ctl]')].map((el) => el.getAttribute('data-ctl'));
    expect([...new Set(want)].sort()).toEqual(want.slice().sort());
    expect(got.sort()).toEqual([...want].sort());
    mounted.destroy();
    f.seen.length = 0;
  });

  it('四条独立读：用量那条挂掉只让用量区报错，其余三区照样到货（设计口径那一类）', async () => {
    const f = stub({ 'GET /storage': { status: 500, body: { success: false, message: '存储读不到' } } });
    const mounted = mountSettings(host());
    await flush();
    expect(text('storageUsageTable')).toContain('存储读不到');
    expect(text('systemSettingsForm')).toContain('5099');
    expect(text('totpStatus')).toContain('SnowLuma:admin');
    expect(text('appearanceForm')).toContain('dark');
    mounted.destroy();
    expect(f.seen.filter((s) => s.method === 'GET').map((s) => s.url.split('?')[0]).sort()).toEqual(
      ['/storage', '/system-settings-detail', '/totp-status', '/ui-config'],
    );
  });

  it('系统闸口：settings 少到货的键输入框留空并明说没读到，不填假值冒充', async () => {
    const thin = { ...SYSTEM, settings: { webuiPort: 5100 } };
    stub({ 'GET /system-settings-detail': { body: { data: thin } } });
    const mounted = mountSettings(host());
    await flush();
    const port = document.getElementById('sysWebuiPort') as HTMLInputElement;
    expect(port.value).toBe('5100');
    const tls = document.getElementById('sysTlsEnabled') as HTMLInputElement;
    expect(tls.checked).toBe(false);
    expect(text('systemSettingsForm')).toContain('上游没给');
    mounted.destroy();
  });

  it('系统闸口保存：只上行改过的那一键；重启提醒上屏，不写"已生效"', async () => {
    const f = stub();
    const mounted = mountSettings(host());
    await flush();
    const port = document.getElementById('sysWebuiPort') as HTMLInputElement;
    port.value = '5200';
    port.dispatchEvent(new Event('change', { bubbles: true }));
    byData('data-save-system')!.click();
    await flush();
    const sent = f.seen.filter((s) => s.url === '/system-settings-patch').pop();
    expect(sent?.body).toEqual({ patch: { webuiPort: 5200 } });
    expect(text('systemSettingsForm')).toContain('重启');
    expect(text('systemSettingsForm')).not.toContain('已生效');
    mounted.destroy();
  });

  it('存储策略：上游给了 true 的勾取消后必须真的上行 false（真浏览器里发现过：改动被吞成"没改"）', async () => {
    const f = stub();
    const mounted = mountSettings(host());
    await flush();
    const per = document.querySelector('[data-path="settings.logPerUin"]') as HTMLInputElement;
    expect(per.checked).toBe(true);
    per.checked = false;
    per.dispatchEvent(new Event('change', { bubbles: true }));
    byData('data-save-storage')!.click();
    await flush();
    expect(f.seen.filter((s) => s.url === '/storage-patch').pop()?.body).toEqual({ patch: { logPerUin: false } });
    mounted.destroy();
  });

  it('服务闸口：上游给了 true 的 tlsEnabled 勾取消后同样要上行 false', async () => {
    const f = stub({ 'GET /system-settings-detail': { body: { data: { ...SYSTEM, settings: { ...SYSTEM.settings, tlsEnabled: true } } } } });
    const mounted = mountSettings(host());
    await flush();
    const tls = document.querySelector('[data-path="settings.tlsEnabled"]') as HTMLInputElement;
    expect(tls.checked).toBe(true);
    tls.checked = false;
    tls.dispatchEvent(new Event('change', { bubbles: true }));
    byData('data-save-system')!.click();
    await flush();
    expect(f.seen.filter((s) => s.url === '/system-settings-patch').pop()?.body).toEqual({ patch: { tlsEnabled: false } });
    mounted.destroy();
  });

  it('生效值那一行按 MiB 说：logMaxTotalMb 是 MiB 计数，按字节渲染就成了"200 B"这种假小值', async () => {
    stub();
    const mounted = mountSettings(host());
    await flush();
    const t = text('storagePolicyForm');
    expect(t).toContain('总上限 200 MiB');
    expect(t).not.toContain('总上限 200 B ');
    mounted.destroy();
  });

  it('存储策略：envOverrides 点名的字段禁用并标注锁定，保存只发没锁定的那一键', async () => {
    const f = stub();
    const mounted = mountSettings(host());
    await flush();
    const locked = document.getElementById('stoLogMaxTotalMb') as HTMLInputElement;
    expect(locked.disabled).toBe(true);
    expect(text('storagePolicyForm')).toContain('被环境变量锁定');
    const days = document.getElementById('stoLogRetainDays') as HTMLInputElement;
    set(days, '14');
    byData('data-save-storage')!.click();
    await flush();
    expect(f.seen.filter((s) => s.url === '/storage-patch').pop()?.body).toEqual({ patch: { logRetainDays: 14 } });
    mounted.destroy();
  });

  it('409 的 lockedFields 上屏并留在屏上（那是"哪些字段被锁"的权威答案，不是通用失败）', async () => {
    stub({ 'POST /storage-patch': { status: 409, body: { success: false, message: '被环境变量锁定', lockedFields: ['logRetainDays'] } } });
    const mounted = mountSettings(host());
    await flush();
    set(document.getElementById('stoLogRetainDays') as HTMLInputElement, '3');
    byData('data-save-storage')!.click();
    await flush();
    expect(text('storagePolicyForm')).toContain('logRetainDays');
    expect(text('storagePolicyForm')).toContain('被环境变量锁定');
    mounted.destroy();
  });

  it('用量表：accounts 逐行、totals 四键、lastCleanup 为 null 时写"还没有清理记录"', async () => {
    stub();
    const mounted = mountSettings(host());
    await flush();
    const t = text('storageUsageTable');
    expect(t).toContain('10001');
    expect(t).toContain('夹具小号');
    expect(t).not.toContain('undefined'); // nickname 缺席的那一行不能画出 undefined
    expect(t).toContain('10002');
    expect(t).toContain('还没有清理记录');
    expect(t).toContain('171');
    mounted.destroy();
  });

  it('清理临时文件：只发这一支、成功后把结果说清并重读一次用量', async () => {
    const f = stub();
    const mounted = mountSettings(host());
    await flush();
    const before = f.seen.filter((s) => s.url === '/storage').length;
    byData('data-cleanup-temporary')!.click();
    await flush();
    const sent = f.seen.filter((s) => s.url === '/storage-cleanup').pop();
    expect(sent?.body).toBeNull(); // 精确一键由服务端补，浏览器连 scope 都不必带
    expect(text('cleanupTemporaryButton')).toContain('3');
    expect(f.seen.filter((s) => s.url === '/storage').length).toBe(before + 1);
    mounted.destroy();
  });

  it('TLS：两个文件都选中才允许提交；上传成功后重读闸口（200 不回显 settings）', async () => {
    const f = stub();
    const mounted = mountSettings(host());
    await flush();
    const submit = byData('data-tls-upload') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    await pickFile('[data-ctl="tlsCertFilePicker"] input', 'cert.pem', 'CERT-PEM-TEXT');
    // 选完文件那一块会重绘，按钮必须重新取（抓着旧节点断言等于没断言）
    expect((byData('data-tls-upload') as HTMLButtonElement).disabled).toBe(true);
    await pickFile('[data-ctl="tlsKeyFilePicker"] input', 'key.pem', 'KEY-PEM-TEXT');
    const btn2 = byData('data-tls-upload') as HTMLButtonElement;
    expect(btn2.disabled).toBe(false);
    const readsBefore = f.seen.filter((s) => s.url === '/system-settings-detail').length;
    btn2.click();
    await flush(12);
    const sent = f.seen.filter((s) => s.url === '/tls-upload').pop();
    expect(Buffer.from(String(sent?.body.certDataUrl).split('base64,')[1], 'base64').toString('utf8')).toBe('CERT-PEM-TEXT');
    expect(Buffer.from(String(sent?.body.keyDataUrl).split('base64,')[1], 'base64').toString('utf8')).toBe('KEY-PEM-TEXT');
    expect(f.seen.filter((s) => s.url === '/system-settings-detail').length).toBe(readsBefore + 1);
    expect(text('tlsCertFilePicker')).toContain('重启');
    mounted.destroy();
  });

  it('TLS 开启中：删除按钮直接禁用并说明原因，不等上游那记 400', async () => {
    const f = stub({
      'GET /system-settings-detail': { body: { data: { ...SYSTEM, settings: { ...SYSTEM.settings, tlsEnabled: true }, hasCert: true } } },
    });
    const mounted = mountSettings(host());
    await flush();
    const btn = byData('data-tls-delete') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(text('tlsDeleteButton')).toContain('禁止删除');
    expect(f.seen.some((s) => s.url === '/tls-delete')).toBe(false);
    mounted.destroy();
  });

  it('备份导出：走下载，正文一个字都不进 DOM（备份里有凭据）', async () => {
    const downloads: string[] = [];
    const orig = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (this.download) downloads.push(this.download);
      return orig.call(this);
    };
    stub();
    const mounted = mountSettings(host());
    await flush();
    byData('data-backup-export')!.click();
    await flush();
    expect(downloads).toEqual(['snowluma-backup-2026-09-28T23-00-00.json']);
    expect(document.body.textContent).not.toContain('TOP-SECRET-VALUE');
    expect(text('backupExportButton')).toContain('demo');
    HTMLAnchorElement.prototype.click = orig;
    mounted.destroy();
  });

  it('备份导出响应没有 text ⇒ 明说"不代造"，不下发空文件、exportInfo 不更新', async () => {
    const downloads: string[] = [];
    const orig = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (this.download) downloads.push(this.download);
      return orig.call(this);
    };
    stub({ 'GET /backup-export': { body: { data: { filename: 'x.json', bytes: 0 } } } });
    const mounted = mountSettings(host());
    await flush();
    byData('data-backup-export')!.click();
    await flush();
    expect(downloads).toEqual([]);
    expect(text('backupExportButton')).toContain('没有正文');
    HTMLAnchorElement.prototype.click = orig;
    mounted.destroy();
  });

  it('备份导入：restoreCredentials 默认不上行，勾了才精确发 true', async () => {
    const f = stub();
    const mounted = mountSettings(host());
    await flush();
    expect((document.getElementById('backupRestoreCredentials') as HTMLInputElement).checked).toBe(false);
    await pickFile('[data-ctl="backupImportFilePicker"] input', 'b.json', JSON.stringify({ app: 'snowluma' }));
    byData('data-backup-import')!.click();
    await flush();
    expect(f.seen.filter((s) => s.url === '/backup-import').pop()?.body).toEqual({ backup: { app: 'snowluma' } });
    const box = document.getElementById('backupRestoreCredentials') as HTMLInputElement;
    box.checked = true;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    byData('data-backup-import')!.click();
    await flush();
    expect(f.seen.filter((s) => s.url === '/backup-import').at(-1)?.body).toEqual({
      backup: { app: 'snowluma' },
      restoreCredentials: true,
    });
    mounted.destroy();
  });

  it('TOTP 未开启支：只有 enabled 一键时写"未开启"，不许把缺键画成 undefined', async () => {
    stub({ 'GET /totp-status': { body: { data: { enabled: false } } } });
    const mounted = mountSettings(host());
    await flush();
    const t = text('totpStatus');
    expect(t).toContain('未开启');
    expect(t).not.toContain('undefined');
    expect((byData('data-totp-disable') as HTMLButtonElement).disabled).toBe(true);
    mounted.destroy();
  });

  it('TOTP 绑定：otpauthUrl 与 secret 只在本次显示，且不写进 localStorage', async () => {
    const setItem = vi.spyOn(window.localStorage.__proto__, 'setItem');
    const f = stub();
    const mounted = mountSettings(host());
    await flush();
    byData('data-totp-begin')!.click();
    await flush();
    expect(text('totpBeginButton')).toContain('otpauth://totp/');
    expect(text('totpBeginButton')).toContain('JBSWY3DPEHPK3PXP');
    expect(text('totpBeginButton')).toContain('只在这一屏出现一次');
    expect(setItem).not.toHaveBeenCalled();
    // 确认那一步发的是 code（不是 totp）；disable 那一步发的才是 totp
    (document.getElementById('totpPassword') as HTMLInputElement).value = 'p';
    (document.getElementById('totpCode') as HTMLInputElement).value = '123456';
    byData('data-totp-confirm')!.click();
    await flush();
    expect(f.seen.filter((s) => s.url === '/totp-confirm').pop()?.body).toEqual({ password: 'p', code: '123456' });
    expect(text('totpStatus')).toContain('abcd-efgh'); // 恢复码一次性展示
    expect(setItem).not.toHaveBeenCalled();
    mounted.destroy();
  });

  it('TOTP 关闭/重生成：第二因子齐了才上行；重生成那条只认 totp', async () => {
    const f = stub();
    const mounted = mountSettings(host());
    await flush();
    const pw = document.getElementById('totpPassword') as HTMLInputElement;
    const code = document.getElementById('totpCode') as HTMLInputElement;
    const rc = document.getElementById('totpRecoveryCode') as HTMLInputElement;
    pw.value = 'p';
    code.value = '123456';
    byData('data-totp-disable')!.click();
    await flush();
    expect(f.seen.filter((s) => s.url === '/totp-disable').pop()?.body).toEqual({ password: 'p', totp: '123456' });
    pw.value = 'p';
    code.value = '654321';
    byData('data-totp-recovery')!.click();
    await flush();
    expect(f.seen.filter((s) => s.url === '/totp-recovery').pop()?.body).toEqual({ password: 'p', totp: '654321' });
    // 只给恢复码不给当前码 ⇒ 重生成这条路不通，一次都不该上行
    rc.value = 'aaaa-bbbb';
    code.value = '';
    pw.value = '';
    byData('data-totp-recovery')!.click();
    await flush();
    expect(f.seen.filter((s) => s.url === '/totp-recovery')).toHaveLength(1);
    expect(text('recoveryCodesButton')).toContain('totp');
    mounted.destroy();
  });

  it('外观表单：枚举档来自 spec 的取值清单，保存发白名单补丁，并写明"demo 不套主题"', async () => {
    const f = stub();
    const mounted = mountSettings(host());
    await flush();
    const mode = document.getElementById('apMode') as HTMLSelectElement;
    for (const v of ['light', 'dark', 'system']) {
      expect(mode.querySelector(`option[value="${v}"]`)).not.toBeNull();
    }
    expect(mode.querySelector('option[value="dark"]')!.hasAttribute('selected')).toBe(true);
    // 放弃清单里的键不给控件
    expect(document.getElementById('apPalette')).toBeNull();
    expect(document.getElementById('apCustomCss')).toBeNull();
    expect(document.getElementById('apCssVars')).toBeNull();
    set(mode, 'light');
    byData('data-save-ui')!.click();
    await flush();
    expect(f.seen.filter((s) => s.url === '/ui-appearance-save').pop()?.body).toEqual({ patch: { appearance: { mode: 'light' } } });
    expect(text('appearanceForm')).toContain('不套主题');
    mounted.destroy();
  });

  it('日志偏好只给 preset 一个下拉；背景图上传/清除走真调用且把 hasImage 读回来', async () => {
    const f = stub();
    const mounted = mountSettings(host());
    await flush();
    const preset = document.getElementById('logsPreset') as HTMLSelectElement;
    for (const v of ['dev', 'ops', 'minimal', 'custom']) expect(preset.querySelector(`option[value="${v}"]`)).not.toBeNull();
    expect(document.getElementById('logsMaxLines')).toBeNull(); // 显示侧四项已 declination
    expect(document.getElementById('logsVisibleLevels')).toBeNull();
    set(preset, 'ops');
    byData('data-save-ui')!.click();
    await flush();
    expect(f.seen.filter((s) => s.url === '/ui-appearance-save').pop()?.body).toEqual({ patch: { pages: { logs: { preset: 'ops' } } } });
    await pickFile('[data-ctl="backgroundFilePicker"] input', 'bg.png', 'PNGBYTES');
    byData('data-bg-upload')!.click();
    await flush(12);
    const up = f.seen.filter((s) => s.url === '/ui-bg-upload').pop();
    expect(String(up?.body.dataUrl)).toMatch(/^data:image\/png;base64,/);
    byData('data-bg-clear')!.click();
    await flush();
    expect(f.seen.some((s) => s.url === '/ui-bg-clear')).toBe(true);
    expect(text('backgroundClearButton')).toContain('image/png');
    mounted.destroy();
  });

  it('destroy 之后不再有请求（面板被交回门禁屏时不许继续撞闸）', async () => {
    const f = stub();
    const mounted = mountSettings(host());
    await flush();
    const n = f.seen.length;
    mounted.destroy();
    await flush(6);
    expect(f.seen.length).toBe(n);
  });
});

/** 往某个控件里的 <input type=file> 塞一份文件内容，并派发 change（happy-dom 不真读盘）。 */
async function pickFile(scopeSel: string, name: string, contents: string): Promise<void> {
  const input = document.querySelector(scopeSel) as HTMLInputElement;
  Object.defineProperty(input, 'files', { value: [new File([contents], name)], configurable: true });
  input.dispatchEvent(new Event('change', { bubbles: true }));
  await flush(4);
}
