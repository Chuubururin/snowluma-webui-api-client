// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
/**
 * 面板→控件→操作对照表（设计口径）：每条边声明该面板替真 WebUI 的哪个面板/控件
 * 覆盖了哪些 operationId，以及"写了到底生不生效"。
 * effect：effective = 有控件且行为生效；write-only = 写回成功但 demo 不据此渲染；none = 无控件（须另登记 not-surfaced）。
 * merge：写路径的负载语义（full = 整份覆盖，客户端必须深合并；partial = 服务端 section-merge）。
 * 出处口径：webui 字符串必须保持纯 `<锚定路径>:<行号>`——门禁（tools/demo-lists.test.ts 出处机器核）
 * 按 `^(.+):(\d+)$` 拆串并精确匹配锚定文件表，串内加任何标识符/中文都会解不到文件即红。
 * 因此"该行标识符 + 区块说明"写在与字符串同一行的注释里（人抄模板时连注释一起抄，机器照核行号）；
 * 行号一律指向真的承载该面板/该区块的那一行（组件声明行 / JSX 起始行 / tab 容器行），禁止 `:1` 占位。
 */
export type Effect = 'effective' | 'write-only' | 'none';

export interface ParityEdge {
  panel: string;
  webui: string;
  controls: string[];
  ops: string[];
  effect: Effect;
  merge?: 'full' | 'partial';
}

export const PANELS: string[] = ['gate', 'overview', 'processes', 'config', 'logs', 'settings', 'debug'];

export const PARITY: ParityEdge[] = [
  // ── gate（login-page / onboarding-wizard-page / change-password-form）──
  // 真 WebUI 登录页：LoginPage 组件声明行（口令/TOTP 表单所在页）。
  // 恢复码不在 controls 里：spec 的 login requestBody（生成类型 LoginData）刻意只列 password/totp
  // （上游客户端会另发 recoveryCode，但其服务端处理在缓存八文件之外无从确证），
  // demo 不发明字段 ⇒ 已登记 declination recovery-code-login。
  { panel: 'gate', webui: 'packages/webui/src/components/pages/login-page.tsx:44',
    controls: ['password', 'totp'], ops: ['login', 'getStatus'], effect: 'effective' },
  // 真 WebUI 首次引导页：OnboardingWizardPage 组件声明行（同意勾选与协议文档所在页）
  { panel: 'gate', webui: 'packages/webui/src/components/pages/onboarding-wizard-page.tsx:54',
    controls: ['agreeCheckbox', 'agreementDoc'], ops: ['getAgreements', 'recordConsent'], effect: 'effective' },
  // 真 WebUI 改密表单：ChangePasswordForm 组件声明行（新密码/确认/强度规则所在组件）
  { panel: 'gate', webui: 'packages/webui/src/components/pages/change-password-form.tsx:84',
    controls: ['newPassword', 'confirmPassword', 'strengthRules'],
    ops: ['getAuthState', 'checkPasswordStrength', 'changePassword'], effect: 'effective', merge: 'partial' },
  // 登出与登录前的公开外观是两处实现，按 op 拆成两条边各自引真行（机器核覆盖每一条出处）：
  //   logout → client.ts:524 `async logout(): Promise<void> {`
  //   getPublicUiAppearance → client.ts:232 `getPublic: async () => {`（登录前免 bearer 的外观读取）
  { panel: 'gate', webui: 'packages/webui/src/lib/api/client.ts:524',
    controls: ['logoutButton'], ops: ['logout'], effect: 'effective' },
  // 控件名按响应实际承载的那个键 `appearance`，不是"品牌标题"：上游登录页的标题是编译期常量
  // APP_NAME（:268）/APP_VERSION（:269），与外观无关，demo 也不发明 title 字段。
  { panel: 'gate', webui: 'packages/webui/src/lib/api/client.ts:232',
    controls: ['appearance'], ops: ['getPublicUiAppearance'], effect: 'effective' },
  // ── overview ──
  // 真 WebUI 总览页：OverviewPage 组件声明行（状态卡/QQ 列表/连接表/进程摘要的承载页）
  { panel: 'overview', webui: 'packages/webui/src/components/pages/overview-page.tsx:66',
    controls: ['statusCards', 'qqList', 'connectionTable', 'processSummary'],
    ops: ['getSystem', 'listQq', 'listConnections', 'listProcesses'], effect: 'effective' },
  // 真 WebUI 更新徽标/实时状态流/轮询周期由 AppLayout 承载：api.stateStream 订阅行
  // （配套：pollInterval 取自 useTheme 在 :80，refreshUpdate→update.check 在 :193）
  { panel: 'overview', webui: 'packages/webui/src/router/app-layout.tsx:227',
    controls: ['updateBadge', 'stateStreamFeed', 'pollIntervalSelect'],
    ops: ['checkUpdate', 'streamState', 'getUiConfig'], effect: 'effective' },
  // ── processes ──
  // 真 WebUI 进程页：ProcessesPage 组件声明行（挂/卸/刷新/探测登录所在页）
  // 不申报 merge：这四条操作只有 path 参数 `{pid}`、**没有请求体**（spec `:2928-2991`），
  // "整份/局部合并"是有体的配置保存才有的语义，写在这里就是一个无法被任何断言证伪的假声明。
  { panel: 'processes', webui: 'packages/webui/src/components/pages/processes-page.tsx:51',
    controls: ['processTable', 'loadButton', 'unloadButton', 'refreshButton', 'probeButton'],
    ops: ['loadProcess', 'unloadProcess', 'refreshProcess', 'probeProcessLogin'], effect: 'effective' },
  // ── config ──
  // 真 WebUI 全局配置在设置页"全局配置"tab：GlobalConfigPanel 的 tab 容器行
  { panel: 'config', webui: 'packages/webui/src/components/pages/settings-page.tsx:125',
    controls: ['globalConfigForm'], ops: ['getGlobalConfig', 'saveGlobalConfig'], effect: 'effective', merge: 'partial' },
  // 真 WebUI OneBot 网络配置页：ConfigPage 组件声明行（账号选择器 + HTTP/WS 服务端客户端各 tab）
  // 这里原有第六个控件 `onebotIntentFilter` 是**发明的**，实核后删掉：
  // `intent` 在 spec 全文零命中，在 vendor 缓存的 webui/onebot 源码里也只有 TanStack Router 的
  // `defaultPreload: 'intent'`（`webui/src/router/index.tsx:14,103`），不是功能。
  // 真页的 tab 容器在缓存外的 `@/components/config/defaults`（`NETWORK_TABS`）⇒ 那份词单无从确证，
  // 但"无从确证"不等于可以编一个控件名冒充参照；可证的是四类网络（`onebot/src/types.ts:29` NetworkKind）。
  { panel: 'config', webui: 'packages/webui/src/components/pages/config-page.tsx:43',
    controls: ['onebotAccountPicker', 'onebotHttpServer', 'onebotHttpClient', 'onebotWsServer', 'onebotWsClient'],
    ops: ['getOneBotConfig', 'saveOneBotConfig'], effect: 'effective', merge: 'full' },
  // 真 WebUI 通知配置在设置页"通知"tab：NotificationsPanel 的 tab 容器行
  { panel: 'config', webui: 'packages/webui/src/components/pages/settings-page.tsx:124',
    controls: ['notificationChannelEditor', 'channelTestButton', 'notificationHistory'],
    ops: ['getNotificationsConfig', 'saveNotificationsConfig', 'testNotificationChannel', 'listRecentNotifications'],
    effect: 'effective', merge: 'partial' },
  // ── logs ──
  // 真 WebUI 日志页：LogsPage 组件声明行（表格/级别选择/trace 导出/SSE 流所在页）
  { panel: 'logs', webui: 'packages/webui/src/components/pages/logs-page.tsx:103',
    controls: ['logTable', 'levelSelect', 'traceExportButton', 'logStreamFeed'],
    ops: ['listLogs', 'getLogLevel', 'setLogLevel', 'exportTraceLog', 'streamLogs'],
    effect: 'effective', merge: 'partial' },
  // ── settings ──
  // 真 WebUI "服务"tab：SystemPanel 的 tab 容器行（监听端口/宿主/TLS/备份均属 systemSettings 组）
  { panel: 'settings', webui: 'packages/webui/src/components/pages/settings-page.tsx:122',
    controls: ['systemSettingsForm'], ops: ['getSystemSettings', 'saveSystemSettings'], effect: 'effective', merge: 'partial' },
  // 真 WebUI "存储管理"tab：StoragePanel 的 tab 容器行（用量表/策略表单/清理临时文件）
  { panel: 'settings', webui: 'packages/webui/src/components/pages/settings-page.tsx:123',
    controls: ['storageUsageTable', 'storagePolicyForm', 'cleanupTemporaryButton'],
    ops: ['getSystemStorage', 'updateStorageSettings', 'cleanupStorage'], effect: 'effective', merge: 'partial' },
  // 真 WebUI TLS 证书：同 SystemPanel（tab 容器行）；接口方法 uploadCert/deleteCert 见 lib/api/types.ts:195-196
  // 不申报 merge：证书与私钥是**整件替换**，没有"按节合并"的语义可言，这条声明任何一侧都无从核（与 processes 边同理）
  { panel: 'settings', webui: 'packages/webui/src/components/pages/settings-page.tsx:122',
    controls: ['tlsCertFilePicker', 'tlsKeyFilePicker', 'tlsDeleteButton'],
    ops: ['uploadTlsCert', 'deleteTlsCert'], effect: 'effective' },
  // 真 WebUI 备份导入导出：同 SystemPanel（tab 容器行）；接口方法 exportBackup/importBackup 见 lib/api/types.ts:198-200
  // 同上：备份是整份文档的一次性进出，没有 section 语义可声明
  { panel: 'settings', webui: 'packages/webui/src/components/pages/settings-page.tsx:122',
    controls: ['backupExportButton', 'backupImportFilePicker'],
    ops: ['exportBackup', 'importBackup'], effect: 'effective' },
  // 这条是 write-only：控件真在、真写回，但 demo 不据此渲染主题（declinations: appearance-visual）
  // 真 WebUI 外观面板：AppearancePanel 组件声明行（背景 Group 在 :632、BackgroundCard 在 :591；日志偏好在 DataPanel :923）
  // merge 从 partial 改判 full（断言 4 抓出来的假声明）：承载路由 `POST /ui-appearance-save`
  // 先 getUiConfig 读回现网那一份、改完**整份回传**（上游是不是 section-merge 在缓存外无从确证，
  // settings.ts 的注释自己就写了"绝不盲发"）。声明 partial 等于宣称"只发被编辑的那几节"，与线上负载相反。
  { panel: 'settings', webui: 'packages/webui/src/components/pages/settings-page.tsx:378',
    controls: ['appearanceForm', 'logsPrefsForm'],
    ops: ['saveUiConfig'], effect: 'write-only', merge: 'full' },
  // 背景图两支单独成边（同 TLS 证书与备份的理由）：上传/清除都是**整件替换**，
  // 没有"按节合并"的语义可声明；挂在外观那条边上会把整份回传的声明强加到这两支头上。
  { panel: 'settings', webui: 'packages/webui/src/components/pages/settings-page.tsx:378',
    controls: ['backgroundFilePicker', 'backgroundClearButton'],
    ops: ['uploadBackgroundImage', 'clearBackgroundImage'], effect: 'write-only' },
  // 真 WebUI 账号安全区：AccountPanel（声明 :1216）内 <TotpPanel /> 的 JSX 行
  { panel: 'settings', webui: 'packages/webui/src/components/pages/settings-page.tsx:1262',
    controls: ['totpStatus', 'totpBeginButton', 'totpConfirmInput', 'totpDisableButton', 'recoveryCodesButton'],
    ops: ['getTotpStatus', 'beginTotpEnrollment', 'confirmTotpEnrollment', 'disableTotp', 'regenerateTotpRecoveryCodes'],
    effect: 'effective', merge: 'partial' },
  // ── debug ──
  // 真 WebUI 调试页：DebugPage 组件声明行（动作列表/参数表单/invoke/trace 上传/事件流所在页）
  // 两个控件是这一屏自己长出来的，不是抄的：
  //  · `debugUinSelect` —— `uin` 是 invoke requestBody 的 required 键（spec `:1984-1987`，
  //    pattern 等价上游 UIN_REGEX），选择器取自账号列表，不让人手填数字；pattern 仍由服务端核
  //    （客户端选择器不是安全边界）。
  //  · `invokeConfirmButton` —— `DebugActionDoc.readOnly` 是**安全信息**（spec `:1256`）：
  //    非 readOnly 的动作会改业务状态，而这个端点是整个 5099 面最危险的一条（`:1963-1971`），
  //    所以点一次就执行不是可接受的形状，必须有显式第二次点击。
  { panel: 'debug', webui: 'packages/webui/src/components/pages/debug-page.tsx:20',
    controls: ['debugUinSelect', 'debugActionList', 'debugParamForm', 'invokeButton', 'invokeConfirmButton', 'traceUploadPicker', 'debugStreamFeed'],
    ops: ['listDebugActions', 'invokeDebugAction', 'uploadDebugFile', 'streamDebugAction', 'streamDebugEvents'],
    effect: 'effective', merge: 'partial' },
];
