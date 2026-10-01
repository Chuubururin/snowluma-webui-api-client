// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
/**
 * 放弃清单（设计口径）：决定不做的 API / 字段 / 面板必须登记，终审统计靠它。
 * 未登记的缺口 = 缺陷；门禁（tools/check-ui-coverage.ts）断言"未登记"计数为 0。
 */
export type DeclinationKind =
  | 'not-surfaced'
  | 'write-only-no-render'
  | 'field-not-exposed'
  | 'behavior-not-adopted'
  | 'panel-skipped'
  | 'unreachable-in-fixture';

export interface Declination {
  id: string;
  kind: DeclinationKind;
  subject: string;
  /**
   * 真 WebUI 出处 file:line；行号必须落在实码符号行（`grep -n` 可核），不得用占位行号——
   * 本清单是后续面板任务的抄写模板，假出处会被复制放大。
   * Tier B（未锚定）只许说明，不得当豁免依据（设计口径）。
   */
  webuiSource: string;
  reason: string;
  decidedBy: string;
  recoverable: boolean;
}

export const DECLINATIONS: Declination[] = [
  {
    id: 'appearance-visual',
    kind: 'write-only-no-render',
    subject: 'saveUiConfig',
    webuiSource: 'packages/core/src/webui/ui-config.ts:656',
    reason: '主题/圆角/密度/调色盘写回生效但 demo 自身不按主题渲染；pollInterval 例外（它真的决定轮询周期，见 parity overview 边）',
    decidedBy: '用户裁定"屏幕与面板级对齐，不含视觉系统"',
    recoverable: true,
  },
  { id: 'bg-upload-render', kind: 'write-only-no-render', subject: 'uploadBackgroundImage',
    webuiSource: 'packages/webui/src/lib/api/client.ts:240', reason: '上传/清除走真调用，但 demo 不把背景图套到页面上', decidedBy: '设计口径', recoverable: true },
  { id: 'bg-clear-render', kind: 'write-only-no-render', subject: 'clearBackgroundImage',
    webuiSource: 'packages/core/src/webui/ui-config.ts:745', reason: '同 bg-upload-render', decidedBy: '设计口径', recoverable: true },
  { id: 'public-appearance-render', kind: 'write-only-no-render', subject: 'getPublicUiAppearance',
    webuiSource: 'packages/webui/src/lib/api/client.ts:232', reason: '门禁屏读出外观摘要（模式/强调色/密度/缩放/背景/动效）供确认目标实例，但不把主题变量套到 demo 自己头上', decidedBy: '设计口径', recoverable: true },
  { id: 'layout-overview-blocks', kind: 'field-not-exposed', subject: 'UiLayout.overviewBlocks',
    webuiSource: 'packages/webui/src/types.ts:560', reason: '挂件拖拽布局编辑器整块不做（见 panel-skipped: gridstack），故布局字段不显示不编辑', decidedBy: '用户', recoverable: true },
  { id: 'layout-nav-items', kind: 'field-not-exposed', subject: 'UiLayout.navItems',
    webuiSource: 'packages/webui/src/types.ts:563', reason: '侧栏顺序/可见性上游用户可配，demo 固定 7 屏', decidedBy: '设计口径', recoverable: true },
  { id: 'layout-topbar-items', kind: 'field-not-exposed', subject: 'UiLayout.topbarItems',
    webuiSource: 'packages/webui/src/types.ts:565', reason: '同 layout-nav-items', decidedBy: '设计口径', recoverable: true },
  { id: 'appearance-css-vars', kind: 'field-not-exposed', subject: 'UiAppearance.cssVars',
    webuiSource: 'packages/webui/src/types.ts:543', reason: '自定义 CSS 属视觉系统，非目标（设计口径）', decidedBy: '设计口径', recoverable: true },
  { id: 'appearance-custom-css', kind: 'field-not-exposed', subject: 'UiAppearance.customCss',
    webuiSource: 'packages/webui/src/types.ts:541', reason: '同 appearance-css-vars', decidedBy: '设计口径', recoverable: true },
  { id: 'appearance-palette', kind: 'field-not-exposed', subject: 'UiAppearance.palette',
    webuiSource: 'packages/webui/src/types.ts:517', reason: '同 appearance-css-vars', decidedBy: '设计口径', recoverable: true },
  { id: 'logs-highlight-rules', kind: 'field-not-exposed', subject: 'UiLogsPrefs.highlightRules',
    webuiSource: 'packages/webui/src/types.ts:580', reason: '日志高亮规则属视觉增强，非面板级对齐目标', decidedBy: '设计口径', recoverable: true },
  { id: 'logs-view-presets', kind: 'field-not-exposed', subject: 'UiLogsPrefs 里除高亮规则外的四项（visibleLevels / maxLines / autoScroll / wrap）',
    webuiSource: 'packages/webui/src/types.ts:576',
    reason: '真页把这四项打包成开发/运维/精简三个预设（logs-page.tsx:44 的 PresetBundle），全是**显示侧**的过滤与滚动策略，一个都不进任何 API 请求；demo 的表格按 limit 直出、不做本地二次筛选，所以这套预设没有可对应的控件',
    decidedBy: '设计口径（轻量 demo）', recoverable: true },
  { id: 'logs-keyword-filter', kind: 'not-surfaced', subject: '日志页的关键词过滤输入框',
    webuiSource: 'packages/webui/src/components/pages/logs-page.tsx:114',
    reason: '真页的 filter 只筛已到货的本地数组（match 的是 level/message/scope 的小写包含），不发任何请求；demo 不做第二套本地筛选，避免"页面上看到的行数"与"上游保留的行数"两个口径',
    decidedBy: '设计口径（轻量 demo）', recoverable: true },
  { id: 'cleanup-scopes-outside-temporary', kind: 'behavior-not-adopted',
    subject: 'ALL_ACCOUNTS_CONFIRMATION 那一路的清理：日志目录、单账号数据、全部账号数据三支都不放按钮',
    webuiSource: 'packages/core/src/webui/storage-routes.ts:20',
    reason: '三支都是不可逆删除（spec 判 t3 + x-snowluma-destructive），而 parity 给 cleanupStorage 只登记了一个 cleanupTemporaryButton；确认词的字面量 spec 未写（`:3148` 只给常量名），值就在这一行（"清理全部账号"）——读得出也发得出，但本屏有意不做那三支，路由收到非 temporary 的 scope 直接 400 并指回这条',
    decidedBy: '设计口径 + parity 控件名单', recoverable: true },
  { id: 'totp-qr-image', kind: 'not-surfaced',
    subject: 'otpauthUrl 的二维码图形渲染（绑定信息只给 otpauth 地址与手工密钥文本）',
    webuiSource: 'packages/webui/src/lib/api/client.ts:348',
    reason: '真页把这串地址交给一个二维码组件画成图（该组件 packages/webui/src/components/settings/totp-qr.tsx 未进锚定八文件面，属 Tier B，只作说明不作依据）；画二维码要引一个前端库，而本 demo 无构建步骤、不引运行时依赖。otpauth 地址与 base32 密钥都以文本给出，可手工录入，绑定流程完整可用，缺的只是扫码便利',
    decidedBy: '设计口径（轻量 demo）', recoverable: true },
  { id: 'notification-channel-ids', kind: 'field-not-exposed', subject: 'OneBotConfig.notifications.channelIds',
    webuiSource: 'packages/webui/src/types.ts:131', reason: '通道启用由通道编辑器整体替代，不单独暴露 id 数组（channelIds 实为 OneBotConfig 的每账号选择性字段，非 NotificationsConfig 成员）', decidedBy: '设计口径', recoverable: true },
  { id: 'recovery-code-login', kind: 'field-not-exposed', subject: 'recoveryCode（login 请求体的恢复码分支）',
    webuiSource: 'packages/webui/src/lib/api/client.ts:499',
    reason: 'spec 的 login requestBody（生成类型 LoginData）只列 password/totp：该键的服务端处理在缓存八文件之外无从确证，demo 不发明字段也不画恢复码输入框',
    decidedBy: '设计口径', recoverable: true },
  { id: 'auto-login-query-token', kind: 'behavior-not-adopted', subject: 'login 的 ?token=<口令> 自动登录',
    webuiSource: 'packages/webui/src/lib/api/client.ts:486', reason: '把口令放进 URL 等于写进浏览器历史与反代访问日志', decidedBy: '设计口径', recoverable: false },
  { id: 'update-check-force', kind: 'behavior-not-adopted', subject: 'checkUpdate(force)',
    webuiSource: 'packages/core/src/webui/update-check.ts:146',
    reason: '6 小时节奏是上游服务端缓存的事（spec :2080 是咨询式检查），demo 不自备定时器去强拉版本源；只有操作者点总览页的"立即检查"时才传 force="1"',
    decidedBy: '设计口径', recoverable: true },
  { id: 'poll-interval-zero-pause', kind: 'behavior-not-adopted', subject: 'pollInterval=0 的暂停轮询语义',
    webuiSource: 'packages/webui/src/router/app-layout.tsx:277',
    reason: '上游把 pollInterval=0 当"已暂停轮询"（interval 直接建 null），demo 把非正数落回 5000ms 档继续轮：一个停摆的总览页看起来像坏了而不是像被配置过，而轮询周期本身仍由该字段决定（parity overview 边）',
    decidedBy: '设计口径', recoverable: true },
  { id: 'config-immediate-commit', kind: 'behavior-not-adopted', subject: 'handleDelete / onCreate / immediateSave 的即时落盘',
    webuiSource: 'packages/webui/src/components/pages/config-page.tsx:148',
    reason: '真页每次增/删/改/开关一条网络就发一次 saveOneBotConfig（t3 + destructive）。demo 把编辑留在表单里，只有点"保存"才发那一次整份覆盖：一次点击换一次落盘，操作者才可能在按下之前看见自己将要提交什么',
    decidedBy: '设计口径与安全约束"T3 只在显式点击时发"', recoverable: true },
  { id: 'export-credentials', kind: 'behavior-not-adopted', subject: 'exportBackup(credentials=1)',
    webuiSource: 'packages/webui/src/lib/api/client.ts:186', reason: '含凭据的备份会被浏览器落盘；demo 只导出不带凭据的一份', decidedBy: '设计口径', recoverable: true },
  { id: 'upload-progress', kind: 'behavior-not-adopted', subject: 'uploadDebugFile 进度回调',
    webuiSource: 'packages/webui/src/lib/api/client.ts:885', reason: '生成客户端不暴露上传进度事件', decidedBy: '设计口径', recoverable: true },
  { id: 'logs-virtual-scroll', kind: 'behavior-not-adopted', subject: '日志虚拟滚动',
    webuiSource: 'packages/webui/src/components/pages/logs-page.tsx:282', reason: '轻量 demo 用截断 + limit 归一，不引虚拟列表', decidedBy: '设计口径', recoverable: true },
  { id: 'must-change-password-silent-false', kind: 'behavior-not-adopted', subject: 'mustChangePassword() 出错时返回 false',
    webuiSource: 'packages/webui/src/lib/api/client.ts:547', reason: '查不出来当作不需改密会放行必须报警的闸；demo 显示"无法确认"并允许操作者显式继续（有意偏离上游）', decidedBy: '设计口径', recoverable: false },
  { id: 'panel-skipped', kind: 'panel-skipped', subject: 'api-browser / 原始调用台',
    webuiSource: 'packages/webui/src/components/pages/debug-page.tsx:102', reason: '本 demo 的第一条裁定就是消除原始调用台', decidedBy: '用户', recoverable: false },
  { id: 'send-success-path', kind: 'unreachable-in-fixture', subject: 'send_* 成功路径（经 invokeDebugAction）',
    webuiSource: 'packages/core/src/webui/server.ts:1293', reason: '需真实 QQ 在线；夹具上只能验错误分支', decidedBy: '设计口径', recoverable: false },
  { id: 'probe-info-nonempty', kind: 'unreachable-in-fixture', subject: 'probeProcessLogin 的非空 info',
    webuiSource: 'packages/core/src/webui/server.ts:1503', reason: '需被注入进程真的登录；夹具上真形是 {info:null}', decidedBy: '设计口径', recoverable: false },
  { id: 'hook-state-change', kind: 'unreachable-in-fixture', subject: 'hook 注入状态变化',
    // 原引 :159 是解释这段判据的注释行；新禁注释占位后重指到承载它的实码行 `const showRefresh = …`。
    // 状态变化本身要真进程与桥接层在场才触发得出，demo 的夹具造不出这条边。
    webuiSource: 'packages/webui/src/components/pages/processes-page.tsx:161', reason: '需真实进程与桥接层在场才能触发状态变化', decidedBy: '设计口径', recoverable: false },
  { id: 'unknown-uin-config', kind: 'behavior-not-adopted', subject: '未知 uin 的 getOneBotConfig / saveOneBotConfig',
    webuiSource: 'packages/core/src/webui/server.ts:1511',
    reason: '上游这条 GET 只做 pattern 检查，对格式合法但不存在的 uin 一样回 200，body 是 makeDefaultOneBotConfig()（onebot/src/config.ts:43-73）那份全局默认配置，其中 accessToken 是真实的 32 字节随机 token；demo 在 pattern 之后、出网之前加一道 listQq 存在性核（demo/server/account-presence.ts），未知 ⇒ 404、qq-list 读不到 ⇒ 502，两种都在发出 /api/config/{uin} 之前拒掉。代价：离线账号即便已落盘 onebot_<uin>.json 也读不到，而"该 uin 有配置文件"这件事没有任何 spec 操作读得出来，所以判据只能取在线集；它与账号选择器（GET /config/accounts）同源，被拒的 uin 恰好是面板上选不到的那些',
    decidedBy: '用户裁定"demo 侧加存在性检查 ⇒ 404"', recoverable: true },
];
