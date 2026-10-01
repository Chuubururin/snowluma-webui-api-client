// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
/**
 * 系统设置屏的路由：闸口开关、存储用量/策略/清理、TLS 证书、备份往返、TOTP 与恢复码、UI 配置与背景图。
 *
 * 四条已核实的事实决定这里的形状（行号均指 spec/openapi.yaml）：
 * 1. **三条写操作的 requestBody 只约束为"对象"**（`:2146`、`:2737`、`:2611`），键名一律借响应侧
 *    schema 的投影。所以上行前按白名单挑键：白名单外的键（`bogus`、`layout`、被放弃的 `palette`
 *    改写口）不许溜到上游去；`coerceSettingsPatch`/`saveUiConfig` 的原文错误交回上游，demo 不代造文案。
 * 2. **`cleanupStorage` 的三支 oneOf 各自 `additionalProperties: false`**（`:3139-3168`），上游
 *    `assertExactKeys` 多一带一键就 400 ⇒ 本屏只发 `{scope:'temporary'}` 这一支、精确一键。
 *    另两支的 `confirmation` 要等于 `ALL_ACCOUNTS_CONFIRMATION`：spec 只给常量名（`:3148`），
 *    值在 vendor 实码里（`packages/core/src/webui/storage-routes.ts:20` 的"清理全部账号"），
 *    读得出也发得出 —— 但那是不可逆删除（t3 + destructive），而 parity 给这条操作只登记了
 *    `cleanupTemporaryButton` 一个控件，所以本屏有意不放那三支的按钮
 *    （declination `cleanup-scopes-outside-temporary`）。
 * 3. **TLS 是 JSON 里两个 PEM 字符串**（required [cert,key]，`:3020-3030`），不是 multipart；
 *    本清单里唯一的真 multipart 是 `uploadBackgroundImage`（`:1897-1905`，生成侧自挂
 *    `formDataBodySerializer`，`sdk.gen.ts:236`）。删除证书在 TLS 开启中必 400（400/500 同形状），
 *    所以状态码必须原样交回，折成 502 就把"该先关 TLS"说成"demo 坏了"。
 * 4. **TOTP 三个端点的第二因子键名不同**：`confirm` 用 `code`（`:2792-2801`），`disable` 用
 *    `totp` 或 `recoveryCode`（`:2831-2841`），`regenerate` 只认 `totp`（`:2868-2877`）。
 *    发错键名不会 400，而是"按空串验、必错"地走到 401 —— 那种失败看起来像"口令错了"，
 *    把人引向反复输错口令，所以本地校验是这里唯一能把住的一道关。
 *    另外这三条的 401 是"业务信封 ∪ 门控 AuthGateError"双形（字段名分别是 `success` 与 `status`），
 *    由 `gateDispatch` 分派，业务支原样保状态码。
 */
import * as sdk from '../../../generated/typescript/sdk.gen.js';
import { fail, ok, type ApiResult, type RouteTable } from '../http.js';
import { UpstreamError, unwrap } from '../upstream.js';
import { gateDispatch, gateGuard } from './gates.js';

/** `SystemSettingsResponse.settings` 的四键投影（`:931-941`；required 为空数组 ⇒ 可能少到货）。 */
export const SYSTEM_SETTINGS_KEYS = ['webuiPort', 'webuiHost', 'tlsEnabled', 'trustProxy'] as const;
/** `LogStorageSettings` 三键（`:947-954`）—— updateStorageSettings 的补丁形状就借这里。 */
export const STORAGE_SETTING_KEYS = ['logMaxTotalMb', 'logRetainDays', 'logPerUin'] as const;
/**
 * 外观里 demo 会写的键：`UiAppearance` 的 required 清单（`:701-705`）减去放弃清单里那三条
 * `field-not-exposed`（`palette`、`cssVars`、`customCss`）与两条 Server-managed
 * （`background.hasImage` / `imageVersion`，`:681-684`）。
 * 减去的四条仍会**原样回传**读到的那一份 —— "不给控件"与"改写别人的值"是两件事，
 * 而 `saveUiConfig` 是不是合并语义在缓存外（`ui-config.ts:656`）无从确证，整份回传才是安全侧。
 */
export const APPEARANCE_WRITE_KEYS = [
  'mode', 'accentMode', 'accentPreset', 'accentCustom', 'accentScope', 'darkIntensity', 'sidebarStyle',
  'fontSans', 'fontSansCustom', 'fontMono', 'fontMonoCustom', 'uiScale', 'radius', 'density',
  'reduceMotion', 'disableMotion', 'customPointerSystem', 'customContextMenu', 'highContrast',
  'sidebarPinned', 'timeFormat', 'pollInterval',
] as const;
export const BACKGROUND_WRITE_KEYS = ['type', 'color', 'gradient', 'imageOpacity', 'imageBlur'] as const;
export const PAGES_WRITE_KEYS = ['defaultRoute', 'processesSort', 'configTab'] as const;
/** `UiLogsPrefs` 里 demo 唯一放行的键：`preset` 是存进实例的那一份，其余五键属显示侧（declination）。 */
export const LOGS_PREF_WRITE_KEYS = ['preset'] as const;

/** 只挑白名单里的键；一个都没挑到就返回 null（调用方据此 400，不发注定失败的整份上行）。 */
function pick(src: any, keys: readonly string[]): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  if (src && typeof src === 'object' && !Array.isArray(src)) {
    for (const k of keys) if (src[k] !== undefined) out[k] = src[k];
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * 上游 4xx 的通用折叠：**保住状态码**与原文，并把专用形状的几个键一起交回
 * （409 的 `lockedFields`、清理 409 的 `onlineUins`、清理 500 双形里的 `cleanup`/`lastCleanup`）。
 * 折成 502 就等于把"你的实例拒绝了这个操作"说成"demo 自己坏了"。
 */
function upstreamReject(e: unknown, label: string): ApiResult {
  if (e instanceof UpstreamError) {
    const b = (e.body ?? {}) as Record<string, unknown>;
    const out: Record<string, unknown> = {
      success: false,
      message: typeof b.message === 'string' ? b.message : `${label}：上游返回 ${e.status}`,
    };
    for (const k of ['lockedFields', 'onlineUins', 'cleanup', 'lastCleanup', 'snapshot', 'settings']) {
      if (b[k] !== undefined) out[k] = b[k];
    }
    return { status: e.status, body: out };
  }
  return fail(502, `${label}：${String((e as Error)?.message ?? e)}`);
}

/** dataURL → 文本（TLS 那两个 PEM 用；与日志页的 trace 那条同规则，只是这里要解 base64）。 */
export function fileTextFromDataUrl(dataUrl: unknown): string | null {
  const m = /^data:[^;]+;base64,(.*)$/s.exec(String(dataUrl ?? ''));
  if (!m) return null;
  try {
    return Buffer.from(m[1], 'base64').toString('utf8');
  } catch {
    return null;
  }
}

/** dataURL → File：背景图那条真是 multipart，但浏览器到 demo 只有一条 dataURL 通道是干净的。 */
export function dataUrlToFile(dataUrl: unknown, name: string): File | null {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(String(dataUrl ?? ''));
  if (!m) return null;
  return new File([Buffer.from(m[2], 'base64')], name, { type: m[1] });
}

/** 第二因子：`totp` 或 `recoveryCode` 任一即可（`:2841` 的 `decideSecondFactorLogin`）。 */
function needsSecondFactor(json: any): ApiResult | null {
  const { password, totp, recoveryCode } = json ?? {};
  // 一句消息把两样都说全：缺口令时也要让人看见"还要第二因子"，否则修完口令又撞第二次 400
  const need = '需要 password，并外加第二因子：TOTP 当前码（totp）或恢复码（recoveryCode）任一';
  if (typeof password !== 'string' || !password) return fail(400, need);
  if (typeof totp !== 'string' && typeof recoveryCode !== 'string') return fail(400, need);
  return null;
}

/** `restartRequiredToApply` 一类的提醒文案：POST 侧那枚是真枚举 true，别写成"已生效"。 */
function restartNote(data: any): Record<string, unknown> {
  return data?.restartRequiredToApply === true ? { restartNote: '监听层/TLS 变更只存盘，需实例重启才生效' } : {};
}

export const settingsRoutes: RouteTable = {
  'GET /system-settings-detail': async (_ctx, u) => {
    const rejected = gateGuard(u);
    if (rejected) return rejected;
    try {
      return ok({ data: unwrap(await sdk.getSystemSettings({ client: u.client })) });
    } catch (e) {
      return gateDispatch(e, upstreamReject(e, '系统设置读取失败'));
    }
  },

  // merge:'partial'：只发被编辑的那几键（上游 coerceSettingsPatch 负责合并与落盘）
  'POST /system-settings-patch': async (ctx, u) => {
    const rejected = gateGuard(u);
    if (rejected) return rejected;
    const patch = pick(ctx.json?.patch, SYSTEM_SETTINGS_KEYS);
    if (!patch) return fail(400, `补丁里没有任何可写键（只接受 ${SYSTEM_SETTINGS_KEYS.join('/')}）`);
    try {
      const data = unwrap<any>(await sdk.saveSystemSettings({ client: u.client, body: patch }));
      return ok({ data: { ...data, ...restartNote(data) } });
    } catch (e) {
      return gateDispatch(e, upstreamReject(e, '系统设置保存失败'));
    }
  },

  'GET /storage': async (_ctx, u) => {
    const rejected = gateGuard(u);
    if (rejected) return rejected;
    try {
      const res: any = unwrap(await sdk.getSystemStorage({ client: u.client }));
      // 设计口径：用量在 snapshot 里，顶层没有；缺 snapshot/settings 就是形状不符，不猜
      if (!res?.snapshot || !res?.settings) return fail(502, '存储快照缺 settings/snapshot 键（不猜）');
      return ok({ data: res });
    } catch (e) {
      return gateDispatch(e, upstreamReject(e, '存储用量读取失败'));
    }
  },

  'POST /storage-patch': async (ctx, u) => {
    const rejected = gateGuard(u);
    if (rejected) return rejected;
    const patch = pick(ctx.json?.patch, STORAGE_SETTING_KEYS);
    if (!patch) return fail(400, `补丁里没有任何可写键（只接受 ${STORAGE_SETTING_KEYS.join('/')}）`);
    try {
      return ok({ data: unwrap(await sdk.updateStorageSettings({ client: u.client, body: patch })) });
    } catch (e) {
      // 409 是专用形状 {success,message,lockedFields}（`:642-653`）：被环境变量锁定的字段要单独显示
      return gateDispatch(e, upstreamReject(e, '存储策略保存失败'));
    }
  },

  'POST /storage-cleanup': async (ctx, u) => {
    const rejected = gateGuard(u);
    if (rejected) return rejected;
    const scope = ctx.json?.scope;
    if (scope !== undefined && scope !== 'temporary') {
      return fail(400, '本屏只清临时文件（temporary）；logs/account/allAccounts 三支见 declination cleanup-scopes-outside-temporary');
    }
    try {
      // 精确一键：三支 oneOf 各自 additionalProperties:false，多带即 400
      return ok({ data: unwrap(await sdk.cleanupStorage({ client: u.client, body: { scope: 'temporary' } })) });
    } catch (e) {
      // 500 双形之一表示"清理已执行、只是统计刷新失败"，upstreamReject 会把 cleanup 一起交回
      return gateDispatch(e, upstreamReject(e, '临时文件清理失败'));
    }
  },

  'POST /tls-upload': async (ctx, u) => {
    const rejected = gateGuard(u);
    if (rejected) return rejected;
    const cert = ctx.json?.certText ?? fileTextFromDataUrl(ctx.json?.certDataUrl);
    const key = ctx.json?.keyText ?? fileTextFromDataUrl(ctx.json?.keyDataUrl);
    if (typeof cert !== 'string' || !cert || typeof key !== 'string' || !key) {
      return fail(400, '需要证书与私钥两个文件（上游收 JSON 里的两个 PEM 字符串，不是 multipart）');
    }
    try {
      const data = unwrap<any>(await sdk.uploadTlsCert({ client: u.client, body: { cert, key } }));
      // 200 只有 {success,restartRequiredToApply}，没有 settings 回显 ⇒ hasCert 要重读才知道
      return ok({ data: { ...data, ...restartNote(data), reloadRequired: true } });
    } catch (e) {
      return gateDispatch(e, upstreamReject(e, 'TLS 证书上传失败'));
    }
  },

  'POST /tls-delete': async (_ctx, u) => {
    const rejected = gateGuard(u);
    if (rejected) return rejected;
    try {
      return ok({ data: unwrap(await sdk.deleteTlsCert({ client: u.client })) });
    } catch (e) {
      // TLS 开启中禁删是 400 且与 500 同形状（`:3055` 附近）：保住状态码才分得出这两回事
      return gateDispatch(e, upstreamReject(e, 'TLS 证书删除失败'));
    }
  },

  // 不传 credentials：declination export-credentials（含凭据的备份会落进浏览器下载）
  'GET /backup-export': async (_ctx, u) => {
    const rejected = gateGuard(u);
    if (rejected) return rejected;
    try {
      const data = unwrap<any>(await sdk.exportBackup({ client: u.client }));
      // 200 无任何键形（`:3088`）⇒ demo 不解析、不转储，只把原文交回给下载
      const text = JSON.stringify(data ?? null, null, 2);
      return ok({
        data: {
          text,
          bytes: Buffer.byteLength(text, 'utf8'),
          filename: backupFilename(new Date()),
          filenameNote: '文件名由 demo 侧按上游同一规则拼（上游那份在 Content-Disposition 里，生成的客户端读不到响应头）',
        },
      });
    } catch (e) {
      return gateDispatch(e, upstreamReject(e, '备份导出失败'));
    }
  },

  'POST /backup-import': async (ctx, u) => {
    const rejected = gateGuard(u);
    if (rejected) return rejected;
    const backup = ctx.json?.backup;
    if (!backup || typeof backup !== 'object' || Array.isArray(backup)) {
      return fail(400, '需要 {backup} 包裹的备份对象（required:[backup]，`:3104-3114`）');
    }
    const body: { backup: Record<string, unknown>; restoreCredentials?: true } = {
      backup: backup as Record<string, unknown>,
    };
    if (ctx.json?.restoreCredentials === true) body.restoreCredentials = true; // 上游判 === true
    try {
      return ok({ data: unwrap(await sdk.importBackup({ client: u.client, body })) });
    } catch (e) {
      // 事务失败走 describeRestoreFailure 的动态码（spec 自记 gap），upstreamReject 原样保住拿到的那一档
      return gateDispatch(e, upstreamReject(e, '备份导入失败'));
    }
  },

  'GET /totp-status': async (_ctx, u) => {
    const rejected = gateGuard(u);
    if (rejected) return rejected;
    try {
      return ok({ data: unwrap(await sdk.getTotpStatus({ client: u.client })) });
    } catch (e) {
      // 开发模式禁用 2FA 让这条**读**也回 400（`:1333-1337`）：本清单唯一带业务 400 的读操作
      return gateDispatch(e, upstreamReject(e, '两步验证状态读取失败'));
    }
  },

  'POST /totp-begin': async (ctx, u) => {
    const rejected = gateGuard(u);
    if (rejected) return rejected;
    const body = pick(ctx.json ?? {}, ['issuer', 'accountName']) ?? undefined;
    try {
      return ok({ data: unwrap(await sdk.beginTotpEnrollment({ client: u.client, body })) });
    } catch (e) {
      return gateDispatch(e, upstreamReject(e, '两步验证绑定开始失败'));
    }
  },

  // 键名是 code（不是 totp）；两键都缺时上游"按空串验、必错"，所以关隘在本地这道必填
  'POST /totp-confirm': async (ctx, u) => {
    const rejected = gateGuard(u);
    if (rejected) return rejected;
    const { password, code } = ctx.json ?? {};
    if (typeof password !== 'string' || !password) return fail(400, '需要 password');
    if (typeof code !== 'string' || !code) return fail(400, '需要 code（认证器上的当前 6 位码；这条端点的键名是 code，不是 totp）');
    try {
      return ok({ data: unwrap(await sdk.confirmTotpEnrollment({ client: u.client, body: { password, code } })) });
    } catch (e) {
      return gateDispatch(e, upstreamReject(e, '两步验证确认失败'));
    }
  },

  'POST /totp-disable': async (ctx, u) => {
    const rejected = gateGuard(u);
    if (rejected) return rejected;
    const bad = needsSecondFactor(ctx.json);
    if (bad) return bad;
    const body: Record<string, unknown> = { password: ctx.json.password };
    // 空串不算"带了第二因子"：按空串验必 401，等于把用错键伪装成口令错（与客户端侧的非空判断对齐）
    if (typeof ctx.json.totp === 'string' && ctx.json.totp !== '') body.totp = ctx.json.totp;
    if (typeof ctx.json.recoveryCode === 'string' && ctx.json.recoveryCode !== '') body.recoveryCode = ctx.json.recoveryCode;
    try {
      return ok({ data: unwrap(await sdk.disableTotp({ client: u.client, body })) });
    } catch (e) {
      return gateDispatch(e, upstreamReject(e, '两步验证关闭失败'));
    }
  },

  // 这一条只认 totp（没有恢复码这条路）：带着恢复码来注定 401，别把"用错键名"伪装成"码过期"
  'POST /totp-recovery': async (ctx, u) => {
    const rejected = gateGuard(u);
    if (rejected) return rejected;
    const { password, totp, recoveryCode } = ctx.json ?? {};
    if (typeof password !== 'string' || !password) return fail(400, '需要 password');
    if (typeof totp !== 'string' || !totp) {
      return fail(400, recoveryCode ? '重生成恢复码只认 TOTP 当前码（totp），恢复码不是这条路' : '需要 totp（认证器上的当前码）');
    }
    try {
      return ok({ data: unwrap(await sdk.regenerateTotpRecoveryCodes({ client: u.client, body: { password, totp } })) });
    } catch (e) {
      return gateDispatch(e, upstreamReject(e, '恢复码重生成失败'));
    }
  },

  'GET /ui-config': async (_ctx, u) => {
    const rejected = gateGuard(u);
    if (rejected) return rejected;
    try {
      const res: any = unwrap(await sdk.getUiConfig({ client: u.client }));
      if (!res?.config) return fail(502, 'UI 配置响应缺 config 键（不猜）');
      return ok({ data: res.config });
    } catch (e) {
      return gateDispatch(e, upstreamReject(e, 'UI 配置读取失败'));
    }
  },

  /**
   * 外观/页面保存是"现读-改-整份回传"：写的那条 requestBody 只约束为对象，而合并语义在缓存外
   * 无从确证 ⇒ 只有把读到的整份带回去，才不会把没编辑过的分支（layout、pages.logs 那六键、
   * 被放弃的 palette/cssVars/customCss）洗成缺省。读不到就 409 停手，绝不盲发。
   */
  'POST /ui-appearance-save': async (ctx, u) => {
    const rejected = gateGuard(u);
    if (rejected) return rejected;
    const patch = ctx.json?.patch ?? {};
    const ap = pick(patch.appearance, APPEARANCE_WRITE_KEYS);
    const bg = pick(patch.appearance?.background, BACKGROUND_WRITE_KEYS);
    const pg = pick(patch.pages, PAGES_WRITE_KEYS);
    const lg = pick(patch.pages?.logs, LOGS_PREF_WRITE_KEYS);
    if (!ap && !bg && !pg && !lg) {
      return fail(400, `补丁里没有任何可写键（外观 ${APPEARANCE_WRITE_KEYS.length} 键 / 背景 ${BACKGROUND_WRITE_KEYS.length} 键 / 页面 ${PAGES_WRITE_KEYS.join('/')} / 日志偏好 ${LOGS_PREF_WRITE_KEYS.join('/')}）`);
    }
    // 读现网那一份单独收口：读到的是门禁信号就交回门禁屏，其余失败一律 409 停手（盲发整份会洗掉没编辑的分支）
    let base: any;
    try {
      base = (unwrap<any>(await sdk.getUiConfig({ client: u.client })) ?? {}).config;
    } catch (e) {
      return gateDispatch(e, fail(409, '读不到现网 UI 配置，不做盲发整份'));
    }
    if (!base || typeof base !== 'object') return fail(409, '读到的 UI 配置没有 config 分支，不做盲发整份');
    try {
      const appearance = { ...base.appearance };
      if (ap) Object.assign(appearance, ap);
      if (bg) appearance.background = { ...base.appearance?.background, ...bg };
      const body: any = { ...base };
      if (ap || bg) body.appearance = appearance;
      if (pg || lg) {
        body.pages = { ...base.pages, ...(pg ?? {}) };
        // pages.logs 只放行 preset 一键，其余五键（visibleLevels/maxLines/autoScroll/wrap/highlightRules）
        // 属显示侧，已登记 declination ⇒ 原样回传读到的那一支，不接受改写
        if (lg) body.pages.logs = { ...base.pages?.logs, ...lg };
      }
      const data = unwrap<any>(await sdk.saveUiConfig({ client: u.client, body }));
      return ok({ data });
    } catch (e) {
      // 落盘失败在这条端点是 400 而不是 500（`:1386-1390`）：状态码必须原样交回才分得清
      return gateDispatch(e, upstreamReject(e, 'UI 配置保存失败'));
    }
  },

  'POST /ui-bg-upload': async (ctx, u) => {
    const rejected = gateGuard(u);
    if (rejected) return rejected;
    const file = dataUrlToFile(ctx.json?.dataUrl, typeof ctx.json?.name === 'string' && ctx.json.name ? ctx.json.name : 'background.png');
    if (!file) return fail(400, '需要 dataUrl（image/png|jpeg|webp 的 base64 数据）');
    try {
      // 生成侧已挂 formDataBodySerializer（sdk.gen.ts:236），它把 body 的**条目**逐个 append 进 FormData，
      // 所以这里交 `{ file }` 而不是一个 FormData 实例（实例没有可枚举条目 ⇒ 发出空 multipart）。
      // Content-Type 一律不手设：boundary 由运行时带。
      return ok({ data: unwrap(await sdk.uploadBackgroundImage({ client: u.client, body: { file } })) });
    } catch (e) {
      return gateDispatch(e, upstreamReject(e, '背景图上传失败'));
    }
  },

  'POST /ui-bg-clear': async (_ctx, u) => {
    const rejected = gateGuard(u);
    if (rejected) return rejected;
    try {
      return ok({ data: unwrap(await sdk.clearBackgroundImage({ client: u.client })) });
    } catch (e) {
      return gateDispatch(e, upstreamReject(e, '背景图清除失败'));
    }
  },
};

/** 上游的文件名规则（`server.ts:1243`）：`snowluma-backup-<ISO 时间冒号点号转连字符>.json`。 */
export function backupFilename(at: Date): string {
  return 'snowluma-backup-' + at.toISOString().slice(0, 19).replace(/[:.]/g, '-') + '.json';
}
