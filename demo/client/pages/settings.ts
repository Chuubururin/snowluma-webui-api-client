// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
/**
 * 系统设置屏：闸口开关、存储（用量/策略/清理）、TLS 证书、备份往返、TOTP 与恢复码、外观与背景图。
 *
 * 五条决定形状的规则（服务端那侧的键形根据见 routes/settings.ts 的文件头）：
 * 1. **四块读各自独立**：系统设置、存储、TOTP 状态、UI 配置是四条互不相干的读，一条挂掉只让
 *    那一区报错。并成一条读就是同一类缺陷。
 * 2. **少到货的键就是没读到**：`SystemSettingsResponse.settings` 的 required 是空数组
 *    （spec `:931-941`），`TotpStatus` 未开启支只有 `enabled` 一键（`:1043-1057`）。
 *    所以输入框留空并明写"上游没给"，绝不拿 false/0 冒充读到的值，也不把没填的框发上去。
 * 3. **凭据只出现一次**：`beginTotpEnrollment` 的 `secret` 与 confirm/regenerate 的 `recoveryCodes`
 *    只活在这块内存里 —— 不写 localStorage、不进日志（spec `:486` 点名要消费方丢弃内存副本）。
 * 4. **备份正文不入 DOM**：导出响应连键形都没有（`:3088`），里面还可能有凭据 ⇒ 页面只显示
 *    文件名与字节数，原文直接进下载。
 * 5. **改动只重画自己那一块**：这是一屏六个互不相干的表单，整屏重绘会把别处正敲着的内容抹掉
 *    （carry-notes 14 的次生坑）。所以成功路径按块重绘，失败路径只往那一块的错误位里写字。
 */
import { ApiError, call, post } from '../api.js';
import { downloadText, esc, section } from '../ui.js';

/** spec 的枚举取值清单（`:666-678`），不是 demo 编的候选值。 */
const THEME_MODES = ['light', 'dark', 'system'] as const;
const ACCENT_MODES = ['preset', 'custom'] as const;
const ACCENT_SCOPES = ['sidebar', 'global'] as const;
const DARK_INTENSITIES = ['soft', 'black'] as const;
const SIDEBAR_STYLES = ['follow', 'panel', 'accent'] as const;
const BACKGROUND_TYPES = ['none', 'solid', 'gradient', 'image'] as const;
const DENSITIES = ['cozy', 'compact'] as const;
const TIME_FORMATS = ['12h', '24h'] as const;
const LOGS_PRESETS = ['dev', 'ops', 'minimal', 'custom'] as const;
const IMAGE_MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };

/** parity 里 settings 面板的控件名，一一对应（的门禁按这个名单核）。 */
export const SETTINGS_CONTROLS = [
  'systemSettingsForm', 'storageUsageTable', 'storagePolicyForm', 'cleanupTemporaryButton',
  'tlsCertFilePicker', 'tlsKeyFilePicker', 'tlsDeleteButton', 'backupExportButton', 'backupImportFilePicker',
  'appearanceForm', 'logsPrefsForm', 'backgroundFilePicker', 'backgroundClearButton',
  'totpStatus', 'totpBeginButton', 'totpConfirmInput', 'totpDisableButton', 'recoveryCodesButton',
] as const;

export type ControlName = (typeof SETTINGS_CONTROLS)[number];

export interface SettingsModel {
  system: any | null;
  storage: any | null;
  totp: any | null;
  ui: any | null;
  readErrors: Record<string, string>;
  enrollment: { secret: string; otpauthUrl: string; issuer: string; accountName: string } | null;
  recoveryCodes: string[] | null;
  tlsFiles: { cert?: { name: string; dataUrl: string }; key?: { name: string; dataUrl: string } };
  bgFile: { name: string; dataUrl: string } | null;
  backup: { name: string; json: unknown } | null;
  restoreCredentials: boolean;
  exportInfo: { filename: string; bytes: number; note: string } | null;
  /** 各区块最近一次写回的说明：跟着 model 走，按块重绘时不丢。 */
  writes: Record<string, { kind: 'err' | 'ok'; msg: string }>;
}

export const EMPTY_SETTINGS: SettingsModel = {
  system: null,
  storage: null,
  totp: null,
  ui: null,
  readErrors: {},
  enrollment: null,
  recoveryCodes: null,
  tlsFiles: {},
  bgFile: null,
  backup: null,
  restoreCredentials: false,
  exportInfo: null,
  writes: {},
};

/** 浅拷贝：挂载侧每次改动都换新对象，渲染函数才谈得上"只看这一份"。 */

const fmt = (v: unknown): string => (v === undefined || v === null ? '' : String(v));
const bytes = (n: number): string =>
  n >= 1024 * 1024 ? (n / 1024 / 1024).toFixed(2) + ' MiB' : n >= 1024 ? (n / 1024).toFixed(1) + ' KiB' : n + ' B';

/**
 * 每个区块的错误位与结果位。写状态存在 model.writes 里：按块重绘时那句结果说明不会被抹掉
 * （"保存成功了但话没了"与"话还挂在上一次失败上"都是谎），发起新动作时由 clearWrite 清掉。
 */
function slots(m: SettingsModel, name: string): string {
  const w = m.writes[name];
  return (
    '<div class="err" id="err_' + name + '">' + esc(w && w.kind === 'err' ? w.msg : '') + '</div>' +
    '<div class="ok" id="note_' + name + '">' + esc(w && w.kind === 'ok' ? w.msg : '') + '</div>'
  );
}

function input(id: string, label: string, path: string, value: unknown, kind = 'text', attrs = ''): string {
  const type = kind === 'bool' ? 'checkbox' : kind === 'num' ? 'number' : 'text';
  const val = kind === 'bool' ? (value === true ? ' checked' : '') : value === undefined || value === null ? '' : ' value="' + esc(String(value)) + '"';
  return (
    '<div class="fld"><label for="' + esc(id) + '">' + esc(label) + '</label>' +
    '<input id="' + esc(id) + '" type="' + type + '" data-path="' + esc(path) + '" data-kind="' + kind + '"' + val + attrs + ' />' +
    (value === undefined ? '<span class="muted">（这一键上游没给）</span>' : '') +
    '</div>'
  );
}

function select(id: string, label: string, path: string, options: readonly string[], value: unknown): string {
  const cur = value === undefined ? null : String(value);
  return (
    '<div class="fld"><label for="' + esc(id) + '">' + esc(label) + '</label><select id="' + esc(id) +
    '" data-path="' + esc(path) + '" data-kind="select">' +
    options.map((o) => '<option value="' + esc(o) + '"' + (cur === o ? ' selected' : '') + '>' + esc(o) + '</option>').join('') +
    '</select>' + (value === undefined ? '<span class="muted">（这一键上游没给）</span>' : '') + '</div>'
  );
}

const btn = (attr: string, label: string, disabled = false): string =>
  '<button type="button" data-' + attr + '="1"' + (disabled ? ' disabled' : '') + '>' + esc(label) + '</button>';

// ── 各区块的渲染（每个都只画自己那一个 data-ctl 的内容）────────────────────────

export function renderSystemForm(m: SettingsModel): string {
  const s = m.system?.settings ?? null;
  return (
    '<h3>服务闸口</h3>' + slots(m, 'systemSettingsForm') +
    (m.readErrors.system ? '<div class="err">' + esc(m.readErrors.system) + '</div>' : '') +
    (m.system === null ? '<p class="muted">还没读到闸口配置。</p>' : '') +
    input('sysWebuiPort', '监听端口（webuiPort）', 'settings.webuiPort', s?.webuiPort, 'num') +
    input('sysWebuiHost', '监听地址（webuiHost）', 'settings.webuiHost', s?.webuiHost) +
    input('sysTlsEnabled', '启用 TLS（tlsEnabled）', 'settings.tlsEnabled', s?.tlsEnabled, 'bool') +
    input('sysTrustProxy', '信任反向代理（trustProxy）', 'settings.trustProxy', s?.trustProxy) +
    '<p class="hint">实际监听端口：<code>' + esc(fmt(m.system?.listeningPort) || '未读到') + '</code> · 证书在位：' +
    esc(m.system?.hasCert === true ? '是' : m.system?.hasCert === false ? '否' : '未读到') + '</p>' +
    '<p class="hint">被环境变量覆盖的键：' + esc((m.system?.envOverrides ?? []).join('、') || '无') + '</p>' +
    btn('save-system', '保存闸口改动', m.system === null) +
    '<p class="hint">这几项改的是<b>这台实例自身</b>的监听层：上游只存盘，<b>要重启进程才生效</b>。</p>'
  );
}

export function renderStorageUsage(m: SettingsModel): string {
  const snap = m.storage?.snapshot ?? null;
  const last = m.storage?.lastCleanup;
  if (m.storage === null) {
    return '<h3>存储用量</h3>' + slots(m, 'storageUsageTable') + (m.readErrors.storage ? '<div class="err">' + esc(m.readErrors.storage) + '</div>' : '') + '<p class="muted">还没读到用量。</p>';
  }
  const rows: string[] = [];
  for (const a of snap?.accounts ?? []) {
    rows.push(
      '<tr><td>' + esc(String(a.uin)) + '</td><td>' + esc(a.nickname ? String(a.nickname) : '（无昵称）') + '</td><td>' +
        esc(a.online === true ? '在线' : '离线') + '</td><td>' + esc(bytes(a.messagesBytes)) + '</td><td>' +
        esc(bytes(a.mediaBytes)) + '</td><td>' + esc(bytes(a.reactionsBytes)) + '</td><td>' + esc(bytes(a.totalBytes)) + '</td></tr>',
    );
  }
  const totals = snap?.totals ?? {};
  return (
    '<h3>存储用量</h3>' + slots(m, 'storageUsageTable') +
    '<dl><dt>日志</dt><dd>' + esc(snap?.logs?.state ?? '未读到') + ' · ' + esc(bytes(snap?.logs?.totalBytes ?? 0)) +
    ' / 上限 ' + esc(bytes(snap?.logs?.maxTotalBytes ?? 0)) + ' · 保留 ' + esc(fmt(snap?.logs?.retainDays) || '—') + ' 天' +
    ' · 文件 ' + esc(fmt(snap?.logs?.fileCount) || '0') + ' 个 · 丢弃行 ' + esc(fmt(snap?.logs?.droppedLines) || '0') +
    (snap?.logs?.lastError ? ' · 最近错误：' + esc(String(snap.logs.lastError)) : '') + '</dd>' +
    '<dt>临时文件</dt><dd>' + esc(bytes(totals.temporaryBytes ?? snap?.temporary?.totalBytes ?? 0)) + ' · ' +
    esc(fmt(snap?.temporary?.fileCount) || '0') + ' 个（在用 ' + esc(fmt(snap?.temporary?.activeItemCount) || '0') + ' 项不动）</dd>' +
    '<dt>合计</dt><dd>日志 ' + esc(bytes(totals.logsBytes ?? 0)) + ' · 临时 ' + esc(bytes(totals.temporaryBytes ?? 0)) +
    ' · 账号数据 ' + esc(bytes(totals.accountDataBytes ?? 0)) + ' · 受管总计 ' + esc(bytes(totals.managedBytes ?? 0)) + '</dd></dl>' +
    '<table class="grid"><thead><tr><th>账号</th><th>昵称</th><th>在线</th><th>消息</th><th>媒体</th><th>表情回应</th><th>合计</th></tr></thead>' +
    '<tbody>' + (rows.join('') || '<tr><td colspan="7">没有账号占用记录</td></tr>') + '</tbody></table>' +
    '<p class="hint">' +
    (last
      ? '最近一次清理：' + esc(String(last.scope)) + ' · 删除 ' + esc(fmt(last.deletedFiles)) + ' 个 · 释放 ' +
        esc(bytes(last.freedBytes)) + ' · ' + esc(String(last.at)) +
        (Array.isArray(last.failures) && last.failures.length ? ' · 失败 ' + esc(String(last.failures.length)) + ' 项' : '')
      : '还没有清理记录。') +
    '</p>'
  );
}

export function renderStoragePolicy(m: SettingsModel, lockedExtra: string[] = []): string {
  const saved = m.storage?.settings?.saved ?? null;
  const locked = new Set<string>([...(m.storage?.settings?.envOverrides ?? []), ...lockedExtra]);
  return (
    '<h3>日志存储策略</h3>' + slots(m, 'storagePolicyForm') +
    (m.storage === null ? '<p class="muted">还没读到策略。</p>' : '') +
    '<p class="hint">生效值：总上限 ' + esc(String(m.storage?.settings?.effective?.logMaxTotalMb ?? '—')) + ' MiB · 保留 ' +
    esc(fmt(m.storage?.settings?.effective?.logRetainDays) || '—') + ' 天 · 按账号分档 ' +
    esc(m.storage?.settings?.effective?.logPerUin === true ? '开' : '关') + '</p>' +
    input('stoLogMaxTotalMb', '日志总上限（MiB）', 'settings.logMaxTotalMb', saved?.logMaxTotalMb, 'num', locked.has('logMaxTotalMb') ? ' disabled' : '') +
    input('stoLogRetainDays', '保留天数', 'settings.logRetainDays', saved?.logRetainDays, 'num', locked.has('logRetainDays') ? ' disabled' : '') +
    input('stoLogPerUin', '按账号分档（logPerUin）', 'settings.logPerUin', saved?.logPerUin, 'bool', locked.has('logPerUin') ? ' disabled' : '') +
    (locked.size > 0 ? '<p class="hint">被环境变量锁定：' + esc([...locked].join('、')) + '，这几项改了上游会回 409。</p>' : '') +
    btn('save-storage', '保存策略改动', m.storage === null) +
    '<p class="hint">三键名借 <code>LogStorageSettings</code>；上游把请求体只约束为对象，所以补丁只带被编辑过的那几键。</p>'
  );
}

export function renderCleanup(m: SettingsModel): string {
  return (
    '<h3>临时文件清理</h3>' + slots(m, 'cleanupTemporaryButton') +
    '<p class="hint">只清临时目录，且不动仍在使用的条目；日志与账号数据的清理不在本屏（见放弃清单）。</p>' +
    btn('cleanup-temporary', '清理临时文件')
  );
}

export function renderTlsCertPicker(m: SettingsModel): string {
  const cert = m.tlsFiles.cert;
  const key = m.tlsFiles.key;
  return (
    '<h3>TLS 证书</h3>' + slots(m, 'tlsCertFilePicker') +
    '<label for="tlsCertFile">证书文件（PEM）</label><input id="tlsCertFile" type="file" accept=".pem,.crt,.cer" data-tls-file="cert" />' +
    '<span class="muted">' + esc(cert ? cert.name : '还没选证书') + '</span>' +
    btn('tls-upload', '上传证书对（cert + key）', !cert || !key) +
    '<p class="hint">上游收的是 JSON 里两个 PEM 字符串（不是 multipart）；私钥落盘权限 0600。</p>'
  );
}

export function renderTlsKeyPicker(m: SettingsModel): string {
  const key = m.tlsFiles.key;
  return (
    '<h4>私钥文件</h4>' + slots(m, 'tlsKeyFilePicker') +
    '<label for="tlsKeyFile">私钥（PEM，与证书一起才允许上传）</label>' +
    '<input id="tlsKeyFile" type="file" accept=".pem,.key" data-tls-file="key" />' +
    '<span class="muted">' + esc(key ? key.name : '还没选私钥') + '</span>'
  );
}

export function renderTlsDelete(m: SettingsModel): string {
  const tlsOn = m.system?.settings?.tlsEnabled === true;
  return (
    '<h4>删除证书</h4>' + slots(m, 'tlsDeleteButton') +
    btn('tls-delete', '删除证书', tlsOn || m.system?.hasCert !== true) +
    (tlsOn ? '<p class="hint">TLS 开关当前是<b>开</b>的：上游禁止删除（400）。要删先在闸口表单里关掉并重启。</p>' : '') +
    (m.system?.hasCert === false ? '<p class="hint">读到的状态：实例上没有证书对。</p>' : '')
  );
}

export function renderBackupExport(m: SettingsModel): string {
  const info = m.exportInfo;
  return (
    '<h3>备份</h3>' + slots(m, 'backupExportButton') +
    btn('backup-export', '导出不含凭据的备份（下载）') +
    (info
      ? '<p class="hint">已导出 <code>' + esc(info.filename) + '</code>（' + esc(bytes(info.bytes)) + '）。' + esc(info.note) + '</p>'
      : '<p class="hint">导出后这里显示文件名与字节数；备份正文一个字都不上屏（里面可能有凭据）。</p>') +
    '<p class="hint">含凭据的那一支已被放弃：demo 不发 <code>credentials=1</code>。</p>'
  );
}

export function renderBackupImport(m: SettingsModel): string {
  return (
    '<h4>导入备份</h4>' + slots(m, 'backupImportFilePicker') +
    '<label for="backupFile">选择备份 JSON 文件</label>' +
    '<input id="backupFile" type="file" accept="application/json,.json" data-backup-file="1" />' +
    '<span class="muted">' + esc(m.backup ? m.backup.name : '还没选文件') + '</span>' +
    '<div class="fld"><label for="backupRestoreCredentials"><input id="backupRestoreCredentials" type="checkbox" data-restore-credentials="1"' +
    (m.restoreCredentials ? ' checked' : '') + ' /> 恢复凭据（restoreCredentials）</label></div>' +
    btn('backup-import', '导入这份备份', m.backup === null) +
    '<p class="hint">勾了才发 <code>restoreCredentials: true</code>；不勾就一个键都不带（上游判的是精确 true）。</p>'
  );
}

export function renderTotpStatus(m: SettingsModel): string {
  const on = m.totp?.enabled === true;
  return (
    '<h3>两步验证</h3>' + slots(m, 'totpStatus') +
    (m.readErrors.totp ? '<div class="err">' + esc(m.readErrors.totp) + '</div>' : '') +
    (m.totp === null
      ? '<p class="muted">还没读到状态（这条读在开发模式下也可能回 400）。</p>'
      : on
        ? '<p>已开启 · 标签 <code>' + esc(String(m.totp.label ?? '（这一键上游没给）')) + '</code> · 剩余恢复码 ' +
          esc(fmt(m.totp.remainingRecoveryCodes) || '0') + ' 个</p>'
        : '<p>未开启。开启要先读一次绑定信息，再用认证器上的当前码确认。</p>') +
    (m.recoveryCodes
      ? '<p class="warn">恢复码只在这一屏出现一次，此刻抄下；离开本屏就再也读不到：</p><ul>' +
        m.recoveryCodes.map((c) => '<li><code>' + esc(c) + '</code></li>').join('') +
        '</ul><p class="hint">demo 不把它写进 localStorage，也不打进任何日志。</p>'
      : '')
  );
}

export function renderTotpBegin(m: SettingsModel): string {
  return (
    '<h4>绑定</h4>' + slots(m, 'totpBeginButton') +
    btn('totp-begin', '读取绑定信息', m.totp === null) +
    (m.enrollment
      ? '<p>只在这一屏出现一次：认证地址 <code>' + esc(m.enrollment.otpauthUrl) + '</code><br />手工密钥 <code>' +
        esc(m.enrollment.secret) + '</code>（issuer ' + esc(String(m.enrollment.issuer)) + ' · account ' +
        esc(String(m.enrollment.accountName)) + '）</p><p class="hint">demo 不画二维码图片；密钥与地址都不落盘、不进日志。</p>'
      : '<p class="hint">读到的一次性密钥与认证地址显示在这里（409 表示已经开着，不用重复绑定）。</p>')
  );
}

export function renderTotpConfirm(m: SettingsModel): string {
  return (
    '<h4>确认开启</h4>' + slots(m, 'totpConfirmInput') +
    '<div class="fld"><label for="totpPassword">管理口令</label><input id="totpPassword" type="password" data-totp="password" /></div>' +
    '<div class="fld"><label for="totpCode">当前 6 位码</label><input id="totpCode" type="text" data-totp="code" /></div>' +
    btn('totp-confirm', '确认并生成恢复码') +
    '<p class="hint">这条端点的第二因子键名是 <code>code</code>（关闭 / 重生成那边叫 <code>totp</code>，不通用）。</p>'
  );
}

export function renderTotpDisable(m: SettingsModel): string {
  return (
    '<h4>关闭两步验证</h4>' + slots(m, 'totpDisableButton') +
    '<div class="fld"><label for="totpRecoveryCode">恢复码（关闭时可代替当前码）</label><input id="totpRecoveryCode" type="text" data-totp="recoveryCode" /></div>' +
    btn('totp-disable', '关闭两步验证', m.totp?.enabled !== true) +
    (m.totp?.enabled !== true ? '<p class="hint">未开启时没有可关的东西，所以这条不发上行。</p>' : '') +
    '<p class="hint">关闭要口令 + 当前码（<code>totp</code>）或恢复码任一。</p>'
  );
}

export function renderTotpRecovery(m: SettingsModel): string {
  return (
    '<h4>重生成恢复码</h4>' + slots(m, 'recoveryCodesButton') +
    btn('totp-recovery', '重生成恢复码', m.totp?.enabled !== true) +
    '<p class="hint">这条路只认当前码（<code>totp</code>），恢复码不是这条路；旧码当场作废。</p>'
  );
}

export function renderAppearance(m: SettingsModel): string {
  const a = m.ui?.appearance ?? null;
  const bg = a?.background ?? null;
  return (
    '<h3>外观（写回实例）</h3>' + slots(m, 'appearanceForm') +
    (m.readErrors.ui ? '<div class="err">' + esc(m.readErrors.ui) + '</div>' : '') +
    (m.ui === null ? '<p class="muted">还没读到 UI 配置。</p>' : '<p class="hint">读到：<code>' + esc(fmt(a?.mode)) + ' · ' + esc(fmt(a?.density)) + ' · ' + esc(fmt(a?.timeFormat)) + '</code></p>') +
    select('apMode', '主题模式', 'appearance.mode', THEME_MODES, a?.mode) +
    select('apAccentMode', '强调色来源', 'appearance.accentMode', ACCENT_MODES, a?.accentMode) +
    input('apAccentPreset', '强调色预设名', 'appearance.accentPreset', a?.accentPreset) +
    input('apAccentCustom', '自定义强调色', 'appearance.accentCustom', a?.accentCustom) +
    select('apAccentScope', '强调色作用范围', 'appearance.accentScope', ACCENT_SCOPES, a?.accentScope) +
    select('apDarkIntensity', '深色浓度', 'appearance.darkIntensity', DARK_INTENSITIES, a?.darkIntensity) +
    select('apSidebarStyle', '侧栏样式', 'appearance.sidebarStyle', SIDEBAR_STYLES, a?.sidebarStyle) +
    input('apFontSans', '无衬线字体', 'appearance.fontSans', a?.fontSans) +
    input('apFontSansCustom', '自定义无衬线', 'appearance.fontSansCustom', a?.fontSansCustom) +
    input('apFontMono', '等宽字体', 'appearance.fontMono', a?.fontMono) +
    input('apFontMonoCustom', '自定义等宽', 'appearance.fontMonoCustom', a?.fontMonoCustom) +
    input('apUiScale', '界面缩放', 'appearance.uiScale', a?.uiScale, 'num', ' step="0.1" min="0.5" max="2"') +
    input('apRadius', '圆角（px）', 'appearance.radius', a?.radius, 'num') +
    select('apDensity', '密度', 'appearance.density', DENSITIES, a?.density) +
    select('apTimeFormat', '时间格式', 'appearance.timeFormat', TIME_FORMATS, a?.timeFormat) +
    input('apPollInterval', '轮询周期（毫秒）', 'appearance.pollInterval', a?.pollInterval, 'num') +
    input('apReduceMotion', '减弱动效', 'appearance.reduceMotion', a?.reduceMotion, 'bool') +
    input('apDisableMotion', '关闭动效', 'appearance.disableMotion', a?.disableMotion, 'bool') +
    input('apCustomPointer', '自定义指针', 'appearance.customPointerSystem', a?.customPointerSystem, 'bool') +
    input('apCustomContextMenu', '自定义右键菜单', 'appearance.customContextMenu', a?.customContextMenu, 'bool') +
    input('apHighContrast', '高对比', 'appearance.highContrast', a?.highContrast, 'bool') +
    input('apSidebarPinned', '侧栏固定', 'appearance.sidebarPinned', a?.sidebarPinned, 'bool') +
    select('apBgType', '背景类型', 'appearance.background.type', BACKGROUND_TYPES, bg?.type) +
    input('apBgColor', '背景色', 'appearance.background.color', bg?.color) +
    input('apBgGradient', '背景渐变', 'appearance.background.gradient', bg?.gradient) +
    input('apBgOpacity', '背景图不透明度', 'appearance.background.imageOpacity', bg?.imageOpacity, 'num', ' step="0.05" min="0" max="1"') +
    input('apBgBlur', '背景图模糊', 'appearance.background.imageBlur', bg?.imageBlur, 'num') +
    '<p class="hint">调色盘（palette）、<code>cssVars</code>、<code>customCss</code> 不给控件（放弃清单），保存时仍<b>原样回传</b>读到的那一份 —— "没有控件"与"改写别人的值"是两件事。' +
    '这条端点的请求体只约束为对象、合并语义在缓存外无从确证 ⇒ 保存走"现读-改-整份回传"。</p>' +
    '<p class="hint"><code>hasImage</code> / <code>imageVersion</code> 由服务端管理，只回显：当前 ' +
    esc(bg?.hasImage === true ? '有背景图' : '无背景图') + ' · 版本 ' + esc(fmt(bg?.imageVersion) || '—') + '。</p>' +
    '<p class="hint">改动在<b>实例的 WebUI</b> 上生效；demo 自身<b>不套主题</b>（面板级对齐，不含视觉系统）。</p>' +
    btn('save-ui', '保存外观改动', m.ui === null)
  );
}

export function renderLogsPrefs(m: SettingsModel): string {
  return (
    '<h4>日志偏好</h4>' + slots(m, 'logsPrefsForm') +
    select('logsPreset', '预设（preset）', 'pages.logs.preset', LOGS_PRESETS, m.ui?.pages?.logs?.preset) +
    '<p class="hint">这一档存在实例上、影响的是实例 WebUI 的显示偏好；其余四项（visibleLevels / maxLines / autoScroll / wrap）' +
    '与高亮规则都不给控件（放弃清单），保存时原样回传。</p>'
  );
}

export function renderBgPicker(m: SettingsModel): string {
  return (
    '<h4>背景图</h4>' + slots(m, 'backgroundFilePicker') +
    '<label for="bgFile">选择图片（PNG / JPEG / WebP，MIME 最终由上游按魔数嗅探）</label>' +
    '<input id="bgFile" type="file" accept="image/png,image/jpeg,image/webp" data-bg-file="1" />' +
    '<span class="muted">' + esc(m.bgFile ? m.bgFile.name : '还没选图') + '</span>' +
    btn('bg-upload', '上传背景图', m.bgFile === null)
  );
}

export function renderBgClear(m: SettingsModel): string {
  const bg = m.ui?.appearance?.background ?? null;
  return (
    '<h4>清除背景图</h4>' + slots(m, 'backgroundClearButton') +
    btn('bg-clear', '清除背景图', bg?.hasImage !== true) +
    '<p class="hint">读到的背景：' + esc(bg?.imageMime ? bg.imageMime : '无 MIME 记录') + ' · 类型 ' + esc(fmt(bg?.type) || '—') +
    '。上传 / 清除都走真调用，demo 不把图套到自己页面上。</p>'
  );
}

const BLOCKS: Record<ControlName, (m: SettingsModel) => string> = {
  systemSettingsForm: renderSystemForm,
  storageUsageTable: renderStorageUsage,
  storagePolicyForm: renderStoragePolicy,
  cleanupTemporaryButton: renderCleanup,
  tlsCertFilePicker: renderTlsCertPicker,
  tlsKeyFilePicker: renderTlsKeyPicker,
  tlsDeleteButton: renderTlsDelete,
  backupExportButton: renderBackupExport,
  backupImportFilePicker: renderBackupImport,
  appearanceForm: renderAppearance,
  logsPrefsForm: renderLogsPrefs,
  backgroundFilePicker: renderBgPicker,
  backgroundClearButton: renderBgClear,
  totpStatus: renderTotpStatus,
  totpBeginButton: renderTotpBegin,
  totpConfirmInput: renderTotpConfirm,
  totpDisableButton: renderTotpDisable,
  recoveryCodesButton: renderTotpRecovery,
};

export function renderSettings(m: SettingsModel): string {
  return (
    '<h2>系统设置</h2>' +
    SETTINGS_CONTROLS.map((name) => '<section data-ctl="' + name + '" id="sec_' + name + '">' + BLOCKS[name](m) + '</section>').join('')
  );
}

export interface MountedSettings {
  destroy(): void;
}

export function mountSettings(host: HTMLElement): MountedSettings {
  let model: SettingsModel = { ...EMPTY_SETTINGS, readErrors: {}, writes: {}, tlsFiles: {} };
  let dead = false;
  let painted = false;
  /** 409 回传的 lockedFields：并进策略块的锁定集里，不重画别的块。 */
  let lockedExtra: string[] = [];

  const blockHtml = (name: ControlName): string =>
    name === 'storagePolicyForm' ? renderStoragePolicy(model, lockedExtra) : BLOCKS[name](model);

  const paintAll = () => {
    host.innerHTML = renderSettings(model);
    painted = true;
  };

  /** 只重画受影响的块：一屏六个互不相干的表单，整屏重绘会抹掉别处正敲着的内容。 */
  const repaint = (...names: ControlName[]) => {
    if (!painted) {
      paintAll();
      return;
    }
    for (const name of names) {
      const el = document.getElementById('sec_' + name);
      if (!el) continue;
      // 重绘等于"这一块的现值就是刚保存/刚读到的那份"：旧改动记录一并作废
      for (const f of el.querySelectorAll('[data-path]')) touched.delete(f.getAttribute('data-path') as string);
      el.innerHTML = blockHtml(name);
    }
  };

  const write = (name: ControlName, msg: string, kind: 'err' | 'ok' = 'err') => {
    model.writes = { ...model.writes, [name]: { kind, msg } };
    const el = document.getElementById((kind === 'err' ? 'err_' : 'note_') + name);
    if (el) el.textContent = msg;
    // 另一类的位子要跟着清空，否则重绘时旧话与新话同时挂屏
    const other = document.getElementById((kind === 'err' ? 'note_' : 'err_') + name);
    if (other) other.textContent = '';
  };
  const clearWrite = (...names: ControlName[]) => {
    const rest = { ...model.writes };
    for (const n of names) {
      delete rest[n];
      const e = document.getElementById('err_' + n);
      const o = document.getElementById('note_' + n);
      if (e) e.textContent = '';
      if (o) o.textContent = '';
    }
    model.writes = rest;
  };

  const read = <T,>(slot: 'system' | 'storage' | 'totp' | 'ui', block: ControlName, path: string) => {
    call<T>(path)
      .then((envelope: any) => {
        if (dead) return;
        // demo 自己的信封是 {ok, data, message}：这一层剥出 data 再交渲染，读不到就是 null
        const v = envelope && Object.prototype.hasOwnProperty.call(envelope, 'data') ? envelope.data : null;
        (model as any)[slot] = v;
        const errs = { ...model.readErrors };
        delete errs[slot];
        model.readErrors = errs;
        repaint(block, ...(slot === 'storage' ? (['storageUsageTable', 'storagePolicyForm', 'cleanupTemporaryButton'] as ControlName[]) : []));
        if (slot === 'system') repaint('tlsDeleteButton', 'totpDisableButton');
        if (slot === 'ui') repaint('backgroundClearButton', 'logsPrefsForm', 'totpStatus');
        if (slot === 'totp') repaint('totpBeginButton', 'totpDisableButton', 'recoveryCodesButton');
      })
      .catch((e: Error) => {
        if (dead) return;
        model.readErrors = { ...model.readErrors, [slot]: e.message };
        repaint(block);
      });
  };

  const reloadAll = () => {
    read('system', 'systemSettingsForm', '/system-settings-detail');
    read('storage', 'storageUsageTable', '/storage');
    read('totp', 'totpStatus', '/totp-status');
    read('ui', 'appearanceForm', '/ui-config');
  };

  const assign = (target: Record<string, any>, dotted: string, value: unknown) => {
    const parts = dotted.split('.');
    let cur: any = target;
    for (const p of parts.slice(0, -1)) cur = cur[p] ??= {};
    cur[parts[parts.length - 1]] = value;
  };

  /**
   * 用户真改过的 data-path。补丁只从这份名单里取值，不做"DOM 现值 ≠ 读到的值就算改动"的比对 ——
   * 那条比对在 `<select>` 上不可靠：happy-dom 从 innerHTML 建 select 时 selectedIndex 会落到第二个
   * option（真浏览器落到带 selected 的那个，见 carry-notes 13），于是每个没动过的下拉都会被视为改动，
   * 一次保存就把整屏下拉的第二档全写进实例。
   */
  const touched = new Set<string>();

  /**
   * 收集某一区块里**被编辑过**的键（partial 只带真改动）；
   * 上游没给的键若也没被填（空串 / 未勾），同样不发 —— 拿 false 或 0 顶上去就是发明。
   * `base` 必须与 map 里的点路径**同根**（`{settings: ...}` 配 `settings.x`）：prev 是按同一条点路径
   * 从 base 上取的，根错位时每个键都读成 undefined，于是"上游给了 true、用户勾掉"这一支会被当成
   * 没改动吞掉（真浏览器走查时就是这样丢了一次 logPerUin 的取消）。
   */
  const collect = (scope: Element | null, base: any, map: Array<[string, 'num' | 'bool' | 'text' | 'select']>) => {
    const out: Record<string, unknown> = {};
    if (!scope) return out;
    for (const [path, kind] of map) {
      if (!touched.has(path)) continue;
      const el = scope.querySelector(`[data-path="${path}"]`) as HTMLInputElement | HTMLSelectElement | null;
      if (!el || (el as HTMLInputElement).disabled) continue;
      const cur =
        kind === 'bool'
          ? (el as HTMLInputElement).checked
          : kind === 'num'
            ? el.value === ''
              ? null
              : Number(el.value)
            : el.value;
      const prev = base ? path.split('.').reduce<any>((acc, k) => (acc == null ? undefined : acc[k]), base) : undefined;
      if (prev !== undefined && prev === cur) continue;
      if (prev === undefined && (cur === '' || cur === null || cur === false)) continue;
      assign(out, path, cur);
    }
    return out;
  };

  const scope = (name: ControlName) => document.getElementById('sec_' + name);

  const run = (blocks: ControlName[], p: Promise<any>, done: (data: any) => void) => {
    clearWrite(...blocks);
    p.then((r: any) => {
      if (dead) return;
      done(r?.data);
    }).catch((e: unknown) => {
      if (dead) return;
      const body = e instanceof ApiError ? (e.body ?? {}) : {};
      // 409 的 lockedFields 是"哪些字段被锁"的权威答案：并进锁定集，别只留一句原文
      if (Array.isArray(body.lockedFields)) {
        lockedExtra = body.lockedFields.map(String);
        repaint('storagePolicyForm');
      }
      write(blocks[0], String((e as Error).message));
    });
  };

  const readFile = (file: File, as: 'dataUrl' | 'text'): Promise<string> =>
    new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result));
      fr.onerror = () => reject(new Error(String(fr.error)));
      if (as === 'text') fr.readAsText(file);
      else fr.readAsDataURL(file);
    });

  const field = (name: string) => String((document.querySelector(`[data-totp="${name}"]`) as HTMLInputElement | null)?.value ?? '');

  const onClick = (e: MouseEvent) => {
    if (dead) return;
    const t = (e.target as HTMLElement)?.closest?.(
      '[data-save-system],[data-save-storage],[data-cleanup-temporary],[data-tls-upload],[data-tls-delete],' +
        '[data-backup-export],[data-backup-import],[data-totp-begin],[data-totp-confirm],[data-totp-disable],' +
        '[data-totp-recovery],[data-save-ui],[data-bg-upload],[data-bg-clear]',
    ) as HTMLElement | null;
    if (!t) return;

    if (t.hasAttribute('data-save-system')) {
      const got = collect(scope('systemSettingsForm'), { settings: model.system?.settings }, [
        ['settings.webuiPort', 'num'],
        ['settings.webuiHost', 'text'],
        ['settings.tlsEnabled', 'bool'],
        ['settings.trustProxy', 'text'],
      ]) as any;
      const patchBody = got.settings ?? {};
      if (Object.keys(patchBody).length === 0) {
        write('systemSettingsForm', '没有改动可保存（值与上游一致，或那几键上游没给）。', 'ok');
        return;
      }
      run(['systemSettingsForm'], post('/system-settings-patch', { patch: patchBody }), (data) => {
        write('systemSettingsForm', data?.restartRequiredToApply === true ? '已存盘；要重启进程才生效。' : '已存盘。', 'ok');
        read('system', 'systemSettingsForm', '/system-settings-detail');
      });
      return;
    }

    if (t.hasAttribute('data-save-storage')) {
      const got = collect(scope('storagePolicyForm'), { settings: model.storage?.settings?.saved }, [
        ['settings.logMaxTotalMb', 'num'],
        ['settings.logRetainDays', 'num'],
        ['settings.logPerUin', 'bool'],
      ]) as any;
      const patchBody = got.settings ?? {};
      if (Object.keys(patchBody).length === 0) {
        write('storagePolicyForm', '没有改动可保存（或被锁定的键没解锁）。', 'ok');
        return;
      }
      run(['storagePolicyForm'], post('/storage-patch', { patch: patchBody }), () => {
        write('storagePolicyForm', '策略已保存。', 'ok');
        read('storage', 'storageUsageTable', '/storage');
      });
      return;
    }

    if (t.hasAttribute('data-cleanup-temporary')) {
      // 精确一键由服务端补（三支 oneOf 各自 additionalProperties:false），所以这里连 body 都不发
      run(['cleanupTemporaryButton'], post('/storage-cleanup', undefined), (data) => {
        const c = data?.cleanup ?? {};
        write(
          'cleanupTemporaryButton',
          '已删除 ' + String(c.deletedFiles ?? 0) + ' 个、释放 ' + bytes(c.freedBytes ?? 0) +
            '（跳过在用 ' + String(c.skippedActiveItems ?? 0) + ' 项）。',
          'ok',
        );
        read('storage', 'storageUsageTable', '/storage');
      });
      return;
    }

    if (t.hasAttribute('data-tls-upload')) {
      const { cert, key } = model.tlsFiles;
      if (!cert || !key) return;
      run(['tlsCertFilePicker'], post('/tls-upload', { certDataUrl: cert.dataUrl, keyDataUrl: key.dataUrl }), (data) => {
        model.tlsFiles = {};
        write('tlsCertFilePicker', '证书已上传；' + (data?.restartRequiredToApply === true ? '要重启进程才生效。' : '已生效。'), 'ok');
        repaint('tlsCertFilePicker', 'tlsKeyFilePicker');
        // 200 不回显 settings/hasCert ⇒ 想知道"证书在位没有"只能重读那一条
        read('system', 'systemSettingsForm', '/system-settings-detail');
      });
      return;
    }

    if (t.hasAttribute('data-tls-delete')) {
      run(['tlsDeleteButton'], post('/tls-delete', {}), (data) => {
        write('tlsDeleteButton', data?.success === true ? '证书已删除（要重启进程才落到监听层）。' : '上游未确认删除。', 'ok');
        read('system', 'systemSettingsForm', '/system-settings-detail');
      });
      return;
    }

    if (t.hasAttribute('data-backup-export')) {
      run(['backupExportButton'], call<any>('/backup-export'), (data) => {
        if (!data || typeof data.text !== 'string') {
          write('backupExportButton', '导出响应没有正文（不代造备份内容）。');
          return;
        }
        downloadText(String(data.filename), data.text);
        model.exportInfo = { filename: String(data.filename), bytes: Number(data.bytes), note: String(data.filenameNote ?? '') };
        repaint('backupExportButton');
        write('backupExportButton', '已开始下载。', 'ok');
      });
      return;
    }

    if (t.hasAttribute('data-backup-import')) {
      if (!model.backup) return;
      const body: Record<string, unknown> = { backup: model.backup.json };
      // 精确 true 才带上这一键（上游判的就是 === true）
      if (model.restoreCredentials === true) body.restoreCredentials = true;
      run(['backupImportFilePicker'], post('/backup-import', body), (data) => {
        write(
          'backupImportFilePicker',
          data?.success === true ? '上游确认恢复成功（除 success 外没有可显示的字段）。' : '上游未确认。',
          'ok',
        );
        reloadAll();
      });
      return;
    }

    if (t.hasAttribute('data-totp-begin')) {
      run(['totpBeginButton'], post('/totp-begin', {}), (data) => {
        if (!data?.secret || !data?.otpauthUrl) {
          write('totpBeginButton', '绑定响应缺 secret / otpauthUrl（不猜）。');
          return;
        }
        model.enrollment = { secret: String(data.secret), otpauthUrl: String(data.otpauthUrl), issuer: String(data.issuer), accountName: String(data.accountName) };
        repaint('totpBeginButton');
      });
      return;
    }

    if (t.hasAttribute('data-totp-confirm')) {
      const password = field('password');
      const code = field('code');
      if (!password || !code) {
        write('totpConfirmInput', '要口令与当前码（code）两样齐了才发上行。');
        return;
      }
      run(['totpConfirmInput'], post('/totp-confirm', { password, code }), (data) => {
        model.recoveryCodes = Array.isArray(data?.recoveryCodes) ? data.recoveryCodes.map(String) : null;
        model.enrollment = null;
        write('totpConfirmInput', '已开启两步验证。', 'ok');
        repaint('totpStatus', 'totpBeginButton', 'totpDisableButton', 'recoveryCodesButton');
        read('totp', 'totpStatus', '/totp-status');
      });
      return;
    }

    if (t.hasAttribute('data-totp-disable')) {
      const password = field('password');
      const totp = field('code');
      const recoveryCode = field('recoveryCode');
      if (!password || (!totp && !recoveryCode)) {
        write('totpDisableButton', '关闭要口令 + 当前码（totp）或恢复码任一。');
        return;
      }
      const body: Record<string, unknown> = { password };
      if (totp) body.totp = totp;
      if (recoveryCode) body.recoveryCode = recoveryCode;
      run(['totpDisableButton'], post('/totp-disable', body), () => {
        model.enrollment = null;
        model.recoveryCodes = null;
        write('totpDisableButton', '已关闭两步验证。', 'ok');
        repaint('totpStatus', 'totpBeginButton', 'totpDisableButton', 'recoveryCodesButton');
        read('totp', 'totpStatus', '/totp-status');
      });
      return;
    }

    if (t.hasAttribute('data-totp-recovery')) {
      const password = field('password');
      const totp = field('code');
      if (!password || !totp) {
        write('recoveryCodesButton', '这条路只认当前码（totp）：恢复码不能代替，口令也不能缺。');
        return;
      }
      run(['recoveryCodesButton'], post('/totp-recovery', { password, totp }), (data) => {
        model.recoveryCodes = Array.isArray(data?.recoveryCodes) ? data.recoveryCodes.map(String) : null;
        repaint('totpStatus');
        write('recoveryCodesButton', '新码已生成，旧码当场作废。', 'ok');
        read('totp', 'totpStatus', '/totp-status');
      });
      return;
    }

    if (t.hasAttribute('data-save-ui')) {
      const appearance = collect(scope('appearanceForm'), { appearance: model.ui?.appearance }, [
        ['appearance.mode', 'select'],
        ['appearance.accentMode', 'select'],
        ['appearance.accentPreset', 'text'],
        ['appearance.accentCustom', 'text'],
        ['appearance.accentScope', 'select'],
        ['appearance.darkIntensity', 'select'],
        ['appearance.sidebarStyle', 'select'],
        ['appearance.fontSans', 'text'],
        ['appearance.fontSansCustom', 'text'],
        ['appearance.fontMono', 'text'],
        ['appearance.fontMonoCustom', 'text'],
        ['appearance.uiScale', 'num'],
        ['appearance.radius', 'num'],
        ['appearance.density', 'select'],
        ['appearance.timeFormat', 'select'],
        ['appearance.pollInterval', 'num'],
        ['appearance.reduceMotion', 'bool'],
        ['appearance.disableMotion', 'bool'],
        ['appearance.customPointerSystem', 'bool'],
        ['appearance.customContextMenu', 'bool'],
        ['appearance.highContrast', 'bool'],
        ['appearance.sidebarPinned', 'bool'],
        ['appearance.background.type', 'select'],
        ['appearance.background.color', 'text'],
        ['appearance.background.gradient', 'text'],
        ['appearance.background.imageOpacity', 'num'],
        ['appearance.background.imageBlur', 'num'],
      ]) as any;
      const logs = collect(scope('logsPrefsForm'), { pages: { logs: model.ui?.pages?.logs } }, [['pages.logs.preset', 'select']]) as any;
      const patchBody: Record<string, unknown> = {};
      if (appearance.appearance && Object.keys(appearance.appearance).length > 0) patchBody.appearance = appearance.appearance;
      if (logs.pages && Object.keys(logs.pages).length > 0) patchBody.pages = logs.pages;
      if (Object.keys(patchBody).length === 0) {
        write('appearanceForm', '没有改动可保存（值与上游一致）。', 'ok');
        return;
      }
      run(['appearanceForm', 'logsPrefsForm'], post('/ui-appearance-save', { patch: patchBody }), () => {
        write('appearanceForm', '已写回实例；demo 自身不套主题。', 'ok');
        read('ui', 'appearanceForm', '/ui-config');
      });
      return;
    }

    if (t.hasAttribute('data-bg-upload')) {
      if (!model.bgFile) return;
      run(['backgroundFilePicker'], post('/ui-bg-upload', { dataUrl: model.bgFile.dataUrl, name: model.bgFile.name }), (data) => {
        model.bgFile = null;
        if (data?.config) model.ui = data.config;
        write('backgroundFilePicker', '背景图已上传（demo 不把它套到页面上）。', 'ok');
        repaint('backgroundFilePicker', 'backgroundClearButton', 'appearanceForm', 'tlsDeleteButton');
      });
      return;
    }

    if (t.hasAttribute('data-bg-clear')) {
      run(['backgroundClearButton'], post('/ui-bg-clear', {}), (data) => {
        if (data?.config) model.ui = data.config;
        write('backgroundClearButton', '背景图已清除。', 'ok');
        repaint('backgroundClearButton', 'backgroundFilePicker', 'appearanceForm');
      });
      return;
    }
  };

  const onChange = async (e: Event) => {
    if (dead) return;
    const el = e.target as HTMLElement | null;
    if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLSelectElement)) return;
    const path = el.getAttribute('data-path');
    if (path) {
      touched.add(path);
      return; // 可编辑字段的 change 只记账：重绘会抹掉别处正敲的内容
    }
    // 下面几条都是文件框与复选框的通道，只可能是 input
    if (!(el instanceof HTMLInputElement)) return;

    const slot = el.getAttribute('data-tls-file');
    if (slot === 'cert' || slot === 'key') {
      const file = el.files?.[0];
      if (!file) return;
      const dataUrl = await readFile(file, 'dataUrl');
      if (dead) return;
      model.tlsFiles = { ...model.tlsFiles, [slot]: { name: file.name, dataUrl } };
      repaint('tlsCertFilePicker', 'tlsKeyFilePicker');
      return;
    }

    if (el.hasAttribute('data-bg-file')) {
      const file = el.files?.[0];
      if (!file) return;
      const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
      if (!IMAGE_MIME[ext]) {
        model.bgFile = null;
        repaint('backgroundFilePicker');
        write('backgroundFilePicker', '只接 PNG / JPEG / WebP（MIME 最终由上游按魔数嗅探）。');
        return;
      }
      const raw = await readFile(file, 'dataUrl');
      if (dead) return;
      model.bgFile = { name: file.name, dataUrl: raw.replace(/^data:[^;]+/, 'data:' + IMAGE_MIME[ext]) };
      repaint('backgroundFilePicker');
      return;
    }

    if (el.hasAttribute('data-restore-credentials')) {
      // 只记账不重画：重绘会抹掉别处正敲着的内容，而这一格的状态提交时从 model 读
      model.restoreCredentials = el.checked;
      return;
    }

    if (el.hasAttribute('data-backup-file')) {
      const file = el.files?.[0];
      if (!file) return;
      const contents = await readFile(file, 'text');
      if (dead) return;
      try {
        const json = JSON.parse(contents);
        if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('顶层不是对象');
        model.backup = { name: file.name, json };
        repaint('backupImportFilePicker');
        write('backupImportFilePicker', '已读出备份对象，等你点导入。', 'ok');
      } catch (err) {
        model.backup = null;
        repaint('backupImportFilePicker');
        write('backupImportFilePicker', '备份文件不是合法 JSON 对象：' + String((err as Error).message));
      }
      return;
    }
    // 其余 change 一律不重画：复选框的状态在提交时现读，重画只会抹掉别处正敲的内容
  };

  paintAll();
  host.addEventListener('click', onClick as EventListener);
  host.addEventListener('change', onChange);
  reloadAll();

  return {
    destroy() {
      dead = true;
      host.removeEventListener('click', onClick as EventListener);
      host.removeEventListener('change', onChange);
    },
  };
}
