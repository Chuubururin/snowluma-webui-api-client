// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
/**
 * 节点配置页：全局配置 / OneBot 网络配置（四类端点 + 状态命令 + 历史同步）/ 通知渠道与投递记录。
 *
 * 这一页的形态约束只有一条：**不出现原始配置形态**。每份配置都按 spec 的 schema 摊成
 * 一个字段一个控件（枚举走下拉、数组走行增删），既没有自由 JSON 文本框，也没有"整份 config"转储。
 * 字段名、可选性、枚举值一律照 `spec/openapi.yaml`（OneBotConfig `:1143-1156`、
 * GlobalSettings `:1227-1234`、NotificationsConfig `:1196-1205`、DeliveryRecord `:1206-1226`），
 * 上游没有的键在这里就不存在——`notifications.channelIds` 属于"整份覆盖要回传但人不碰"那一类，
 * 由服务端合并带回（declination notification-channel-ids）。
 */
import { ApiError, call, post } from '../api.js';
import { esc, section } from '../ui.js';

export interface QqAccount {
  uin: string;
  nickname: string;
}

export interface NetworkItem {
  name: string;
  enabled?: boolean;
  accessToken?: string;
  messageFormat: string;
  reportSelfMessage: boolean;
  host?: string;
  port?: number;
  path?: string;
  enableWebSocket?: boolean;
  url?: string;
  timeoutMs?: number;
  role?: string;
  reconnectIntervalMs?: number;
}

export interface NetworksShape {
  httpServers: NetworkItem[];
  httpClients: NetworkItem[];
  wsServers: NetworkItem[];
  wsClients: NetworkItem[];
}

export interface OneBotConfigShape {
  networks: NetworksShape;
  statusCommand: { enabled: boolean; swallow: boolean; cooldownSeconds: number; trigger: string };
  historySync: { enabled: boolean };
  notifications?: { channelIds: string[] };
}

/** OneBotConfigSaveResult 的八键里，这一屏要用的是 applied/online/message/errors。 */
export interface OneBotSaveShape {
  applied?: boolean;
  online?: boolean;
  message?: string;
  errors?: unknown[];
  config?: OneBotConfigShape;
}

export interface GlobalSettingsShape {
  rkey: { fallbackServers: string[] };
  musicSignUrl: string;
}

export interface ChannelRow {
  id: string;
  name: string;
  type: string;
  url: string;
  bodyTemplate: string;
  enabled: boolean;
  headers?: Record<string, string>;
  smtpHost?: string;
  smtpPort?: number;
  smtpSecure?: boolean;
  smtpUser?: string;
  smtpPass?: string;
  from?: string;
  to?: string;
  subjectTemplate?: string;
}

export interface NotificationsConfigShape {
  version: number;
  debounceSeconds: number;
  channels: ChannelRow[];
}

export interface DeliveryRow {
  time: number;
  uin: string;
  event: string;
  channelId: string;
  ok: boolean;
  status?: number;
  error?: string;
}

export interface TestResultShape {
  success: boolean;
  status?: number;
  message?: string;
}

export interface ConfigModel {
  global: GlobalSettingsShape | null;
  onebot: OneBotConfigShape | null;
  notifications: NotificationsConfigShape | null;
  recent: DeliveryRow[];
  accounts: QqAccount[];
  uin: string | null;
  errors: Record<string, string>;
  /** 保存/测试的回显（含 `applied:false` 这类"200 但没生效"）。 */
  notices: Record<string, string>;
  /** 渠道级测试回显按 channelId 存；不进上行补丁，但必须活过重绘。 */
  testResults: Record<string, TestResultShape>;
}

export const EMPTY_CONFIG: ConfigModel = {
  global: null,
  onebot: null,
  notifications: null,
  recent: [],
  accounts: [],
  uin: null,
  errors: {},
  notices: {},
  testResults: {},
};

function field(label: string, kind: 'text' | 'number' | 'checkbox', dataField: string, value: unknown, extra = ''): string {
  const id = 'f_' + dataField.replace(/[^A-Za-z0-9]/g, '_');
  if (kind === 'checkbox') {
    return (
      '<label for="' +
      esc(id) +
      '">' +
      esc(label) +
      '<input id="' +
      esc(id) +
      '" type="checkbox" data-field="' +
      esc(dataField) +
      '"' +
      (value ? ' checked' : '') +
      extra +
      '></label>'
    );
  }
  return (
    '<label for="' +
    esc(id) +
    '">' +
    esc(label) +
    '<input id="' +
    esc(id) +
    '" type="' +
    kind +
    '" data-field="' +
    esc(dataField) +
    '" value="' +
    esc(value === undefined || value === null ? '' : String(value)) +
    '"' +
    extra +
    '></label>'
  );
}

function selectField(label: string, dataField: string, options: readonly string[], value: unknown): string {
  const id = 'f_' + dataField.replace(/[^A-Za-z0-9]/g, '_');
  return (
    '<label for="' +
    esc(id) +
    '">' +
    esc(label) +
    '<select id="' +
    esc(id) +
    '" data-field="' +
    esc(dataField) +
    '">' +
    options
      .map((o) => '<option value="' + esc(o) + '"' + (String(value) === o ? ' selected' : '') + '>' + esc(o) + '</option>')
      .join('') +
    '</select></label>'
  );
}

function noticeOrError(model: ConfigModel, key: string): string {
  const err = model.errors[key];
  const notice = model.notices[key];
  if (err) return '<div class="err">' + esc(err) + '</div>';
  return notice ? '<div class="ok">' + esc(notice) + '</div>' : '';
}

// ── 全局配置 ────────────────────────────────────────────────────────────────
export function renderGlobalForm(global: GlobalSettingsShape | null): string {
  if (!global) return '<p class="muted">全局配置还没读到。</p>';
  const servers = global.rkey?.fallbackServers ?? [];
  return (
    field('音乐签名服务地址（空串＝用内建默认）', 'text', 'musicSignUrl', global.musicSignUrl) +
    '<fieldset><legend>rkey 远端兜底服务器（空列表＝关闭，不连任何第三方）</legend>' +
    (servers.length === 0
      ? '<p class="muted">未配置 = 关闭。</p>'
      : servers
          .map((s, i) => field('第 ' + (i + 1) + ' 条', 'text', 'rkey.fallbackServers[' + i + ']', s) + '<button type="button" data-remove-rkey="' + i + '">删除这条</button>')
          .join('')) +
    '<button type="button" data-add-rkey="1">新增一条</button></fieldset>'
  );
}

// ── OneBot 网络四表单 ───────────────────────────────────────────────────────
const KIND_META: Record<keyof NetworksShape, { ctl: string; title: string }> = {
  httpServers: { ctl: 'onebotHttpServer', title: 'HTTP 服务端' },
  httpClients: { ctl: 'onebotHttpClient', title: 'HTTP 客户端' },
  wsServers: { ctl: 'onebotWsServer', title: 'WebSocket 服务端' },
  wsClients: { ctl: 'onebotWsClient', title: 'WebSocket 客户端' },
};

/**
 * "新建 HTTP 服务端"这类按钮的初值（真 WebUI 每个 tab 都有 create：`config-page.tsx:234`、
 * 空态"创建第一个"：`:502`）。这里给的是**可编辑的起点**，不是契约断言：
 * 必填的四键按 `onebot/src/types.ts:39-44` 给全，选填按该 kind 该有哪个给哪个（role 只属 ws*）。
 */
export function blankNetwork(kind: keyof NetworksShape): NetworkItem {
  const base: NetworkItem = { name: '', enabled: false, accessToken: '', messageFormat: 'array', reportSelfMessage: false };
  if (kind === 'httpServers') return { ...base, host: '0.0.0.0', port: 3000, path: '/onebot', enableWebSocket: false };
  if (kind === 'wsServers') return { ...base, host: '127.0.0.1', port: 3001, path: '/onebot', role: 'Universal' };
  if (kind === 'httpClients') return { ...base, url: 'http://127.0.0.1:3000', timeoutMs: 10000 };
  return { ...base, url: 'ws://127.0.0.1:3001', reconnectIntervalMs: 5000, role: 'Api' };
}

/** 新渠道的 id：上游要求 `id` 必填且用于路由（`NotificationChannel` required 六键），不能留空串。 */
export function blankChannel(existing: ChannelRow[]): ChannelRow {
  const used = new Set(existing.map((c) => c.id));
  let n = existing.length + 1;
  while (used.has('channel-' + n)) n += 1;
  return { id: 'channel-' + n, name: '', type: 'webhook', url: '', bodyTemplate: '', enabled: false };
}

function renderNetworkItem(kind: keyof NetworksShape, item: NetworkItem, index: number): string {
  const prefix = 'networks.' + kind + '[' + index + ']';
  const rows: string[] = [
    field('名称', 'text', prefix + '.name', item.name),
    field('启用', 'checkbox', prefix + '.enabled', item.enabled),
    field('access token', 'text', prefix + '.accessToken', item.accessToken),
    selectField('消息格式', prefix + '.messageFormat', ['array', 'string'], item.messageFormat),
    field('回报自发消息', 'checkbox', prefix + '.reportSelfMessage', item.reportSelfMessage),
  ];
  if (kind === 'httpServers' || kind === 'wsServers') {
    rows.push(field('监听地址', 'text', prefix + '.host', item.host));
    rows.push(field('端口', 'number', prefix + '.port', item.port));
    rows.push(field('路径', 'text', prefix + '.path', item.path));
  } else {
    rows.push(field('目标 URL', 'text', prefix + '.url', item.url));
    rows.push(field(kind === 'httpClients' ? '超时毫秒' : '重连间隔毫秒', 'number', prefix + (kind === 'httpClients' ? '.timeoutMs' : '.reconnectIntervalMs'), kind === 'httpClients' ? item.timeoutMs : item.reconnectIntervalMs));
  }
  // role 只属 ws*（`onebot/src/types.ts:49,53`）；给 http* 加这个下拉就是发明字段
  if (kind === 'wsServers' || kind === 'wsClients') {
    rows.push(selectField('角色', prefix + '.role', ['Api', 'Event', 'Universal'], item.role ?? 'Universal'));
  }
  if (kind === 'httpServers') rows.push(field('同一监听上接受 WS', 'checkbox', prefix + '.enableWebSocket', item.enableWebSocket));
  return (
    '<div class="netItem" data-net="' +
    esc(kind) +
    '" data-index="' +
    index +
    '">' +
    rows.join('') +
    '<button type="button" data-remove-net="' +
    esc(kind) +
    ':' +
    index +
    '">删除这一条</button></div>'
  );
}

/**
 * 四类网络的骨架。控件名单不随读取成功与否增减——面板"有控件"和"控件有数据"是两件事，
 * 前者少了就是设计口径那一类"没出口的界面"。保存回显走 `saveNotice`，不在这里吞掉表单。
 */
export function renderOneBotNetworks(view: { networks?: NetworksShape; editable?: boolean }): string {
  const networks = view?.networks;
  const editable = view?.editable !== false;
  // 不说"还没选定账号"：存在性核拒绝（404）时账号是选着的，那句会和上面的拒绝文案当场矛盾。
  const emptyNote = networks ? '' : '<p class="muted">OneBot 配置未读取。</p>';
  return (
    emptyNote +
    (Object.keys(KIND_META) as Array<keyof NetworksShape>)
      .map((kind) => {
        const meta = KIND_META[kind];
        const list = networks?.[kind] ?? [];
        return (
          '<section data-ctl="' +
          meta.ctl +
          '"><h4>' +
          esc(meta.title) +
          '（' +
          list.length +
          ' 条）</h4>' +
          (list.length === 0 ? '<p class="muted">未配置。</p>' : list.map((item, i) => renderNetworkItem(kind, item, i)).join('')) +
          // 没读到配置就不画"新增一条"：保存此时是禁的，画一个点了没反应的按钮更糟
          (editable ? '<button type="button" data-add-net="' + esc(kind) + '">新增一条</button>' : '') +
          '</section>'
        );
      })
      .join('')
  );
}

export function renderOneBotExtras(onebot: OneBotConfigShape | null): string {
  if (!onebot) return '';
  const sc = onebot.statusCommand;
  const hs = onebot.historySync;
  return (
    '<fieldset><legend>内建状态命令</legend>' +
    field('启用', 'checkbox', 'statusCommand.enabled', sc?.enabled) +
    field('吞掉命令消息', 'checkbox', 'statusCommand.swallow', sc?.swallow) +
    field('冷却秒数', 'number', 'statusCommand.cooldownSeconds', sc?.cooldownSeconds) +
    field('触发词', 'text', 'statusCommand.trigger', sc?.trigger) +
    '</fieldset><fieldset><legend>历史同步</legend>' +
    field('启用（默认关闭）', 'checkbox', 'historySync.enabled', hs?.enabled) +
    '</fieldset>'
  );
}

/**
 * 保存回显的唯一措辞处。`applied:false` 是"落盘成功、热重载崩"（spec `:592-611`），
 * 200 不等于生效——这里必须说清，也不能顺手把表单吃掉。
 */
export function saveNotice(which: 'global' | 'onebot' | 'notifications', data: OneBotSaveShape | undefined): string {
  if (which === 'onebot' && data && data.applied === false) {
    const detail = Array.isArray(data.errors) && data.errors.length > 0 ? '（' + data.errors.length + ' 条重载错误）' : '';
    return '配置已落盘，但热重载未生效（applied:false）' + detail + '：' + (data.message ?? '');
  }
  return '已保存' + (data?.message ? '：' + data.message : '');
}

// ── 通知渠道 ────────────────────────────────────────────────────────────────
function renderChannelRow(ch: ChannelRow, index: number, test?: TestResultShape): string {
  const prefix = 'channels[' + index + ']';
  const isEmail = ch.type === 'email';
  const rows = [
    field('渠道 ID（上游按它路由：整段覆盖时原样回传，新渠道自己起一个不重复的）', 'text', prefix + '.id', ch.id),
    field('名称', 'text', prefix + '.name', ch.name),
    selectField('类型', prefix + '.type', ['webhook', 'email'], ch.type),
    field('启用', 'checkbox', prefix + '.enabled', ch.enabled),
  ];
  if (isEmail) {
    rows.push(
      field('SMTP 主机', 'text', prefix + '.smtpHost', ch.smtpHost),
      field('SMTP 端口', 'number', prefix + '.smtpPort', ch.smtpPort),
      field('SMTP 加密', 'checkbox', prefix + '.smtpSecure', ch.smtpSecure),
      field('SMTP 用户', 'text', prefix + '.smtpUser', ch.smtpUser),
      field('SMTP 口令', 'text', prefix + '.smtpPass', ch.smtpPass),
      field('发件人', 'text', prefix + '.from', ch.from),
      field('收件人', 'text', prefix + '.to', ch.to),
      field('标题模板', 'text', prefix + '.subjectTemplate', ch.subjectTemplate),
    );
  } else {
    rows.push(field('Webhook URL', 'text', prefix + '.url', ch.url), field('正文模板', 'text', prefix + '.bodyTemplate', ch.bodyTemplate));
  }
  const tested = test
    ? '<div class="' + (test.success ? 'ok' : 'err') + '">测试' + (test.success ? '成功' : '失败') + '：' + esc(test.message ?? '') +
      (typeof test.status === 'number' ? '（渠道返回 ' + esc(String(test.status)) + '）' : '') +
      '</div>'
    : '';
  return (
    '<div class="channelItem" data-channel-index="' +
    index +
    '" data-channel-id="' +
    esc(ch.id) +
    '">' +
    rows.join('') +
    tested +
    '<button type="button" data-test-channel="' +
    esc(ch.id) +
    '" data-ctl="channelTestButton">发一条测试通知</button>' +
    '<button type="button" data-remove-channel="' +
    index +
    '">删除这个渠道</button></div>'
  );
}

export function renderChannels(view: {
  channels: ChannelRow[];
  debounceSeconds?: number;
  testResults?: Record<string, TestResultShape>;
  /** `false` = 这份配置根本没读到。此时不能写"渠道列表为空"——那是替上游做它没说过的断言。 */
  loaded?: boolean;
}): string {
  const rows = view.channels.map((c, i) => renderChannelRow(c, i, view.testResults?.[c.id]));
  const notRead = view.loaded === false;
  return (
    (notRead ? '<p class="muted">通知配置还没读到，下面是空白骨架——不代表上游没有渠道。</p>' : '') +
    (typeof view.debounceSeconds === 'number'
      ? field('防抖秒数（同一事件在该窗口内只发一次）', 'number', 'debounceSeconds', view.debounceSeconds)
      : '') +
    (rows.length === 0 ? '<p class="muted">' + (notRead ? '未读取，故不写"空列表"。' : '上游返回的渠道列表为空。') + '</p>' : rows.join('')) +
    (notRead ? '' : '<button type="button" data-add-channel="1">新增渠道</button>')
  );
}

// ── 投递记录 ────────────────────────────────────────────────────────────────
export function renderRecentDeliveries(rows: DeliveryRow[], loaded = true): string {
  // 读失败与"读到了但确实是空的"是两回事：前者不能写成后者的样子（设计口径）
  if (rows.length === 0) return '<p id="notificationHistoryEmpty">' + (loaded ? '暂无投递记录。' : '投递记录未读取。') + '</p>';
  return (
    '<table><thead><tr>' +
    ['时间', '账号', '事件', '渠道', '结果', '渠道码', '错误']
      .map((h) => '<th>' + esc(h) + '</th>')
      .join('') +
    '</tr></thead><tbody>' +
    rows
      .map(
        (r) =>
          '<tr><td>' +
          esc(new Date(r.time).toLocaleString()) +
          '</td><td><code>' +
          esc(r.uin) +
          '</code></td><td>' +
          esc(r.event === 'online' ? '上线' : r.event === 'offline' ? '下线' : r.event) +
          '</td><td><code>' +
          esc(r.channelId) +
          '</code></td><td class="' +
          (r.ok ? 'ok' : 'err') +
          '">' +
          (r.ok ? '成功' : '失败') +
          '</td><td>' +
          // status 与 error 都是可选键（DeliveryRecord `:1206-1226`）：缺键就明写缺，不许显示 0 或空串冒充数据
          (typeof r.status === 'number' ? esc(String(r.status)) : '<span class="muted">未给出</span>') +
          '</td><td>' +
          (r.error ? esc(r.error) : '<span class="muted">—</span>') +
          '</td></tr>',
      )
      .join('') +
    '</tbody></table>'
  );
}

// ── 整屏 ────────────────────────────────────────────────────────────────────
export function renderConfig(m: ConfigModel): string {
  return (
    '<h2>节点配置</h2>' +
    '<section data-ctl="globalConfigForm"><h3>全局配置（rkey 兜底 + 音乐签名服务）</h3>' +
    noticeOrError(m, 'global') +
    renderGlobalForm(m.global) +
    '<button type="button" data-save="global">保存全局配置</button></section>' +
    '<section data-ctl="onebotAccountPicker"><h3>OneBot 配置</h3>' +
    (m.errors.accounts ? '<div class="err">账号列表：' + esc(m.errors.accounts) + '</div>' : '') +
    '<label for="onebotUin">账号<select id="onebotUin" data-field="uin">' +
    (m.accounts.length === 0 ? '<option value="">' + (m.errors.accounts ? '（账号列表读取失败）' : '（上游没有返回任何账号）') + '</option>' : '') +
    m.accounts
      .map((a) => '<option value="' + esc(a.uin) + '"' + (m.uin === a.uin ? ' selected' : '') + '>' + esc(a.nickname) + ' · ' + esc(a.uin) + '</option>')
      .join('') +
    '</select></label><button type="button" data-load-onebot="1">读取该账号配置</button>' +
    noticeOrError(m, 'onebot') +
    renderOneBotNetworks({ networks: m.onebot?.networks, editable: !!m.onebot }) +
    renderOneBotExtras(m.onebot) +
    // 没读到整份配置就禁保存：这一屏是"整份覆盖"，空骨架点下去等于把四类网络全删了
    '<button type="button" data-save="onebot"' +
    (m.onebot && m.uin ? '' : ' disabled') +
    '>保存 OneBot 配置（整份覆盖 + 落盘 + 热重载）</button></section>' +
    '<section data-ctl="notificationChannelEditor"><h3>通知渠道</h3>' +
    noticeOrError(m, 'notifications') +
    renderChannels({
      channels: m.notifications?.channels ?? [],
      debounceSeconds: m.notifications?.debounceSeconds,
      testResults: m.testResults,
      loaded: !!m.notifications,
    }) +
    // 没读到就禁保存：这份表单是空骨架，点下去等于"把上游的渠道全删了"（整段覆盖语义）
    '<button type="button" data-save="notifications"' +
    (m.notifications ? '' : ' disabled') +
    '>保存通知配置（整段覆盖渠道表）</button></section>' +
    '<section data-ctl="notificationHistory"><h3>最近投递记录</h3>' +
    (m.errors.recent ? '<div class="err">' + esc(m.errors.recent) + '</div>' : '') +
    renderRecentDeliveries(m.recent, !m.errors.recent) +
    '</section>'
  );
}

export interface MountedConfig {
  destroy(): void;
}

function errText(e: unknown): string {
  if (e instanceof ApiError) return `${e.status} ${e.message}`;
  return (e as Error)?.message ?? String(e);
}

function withoutKey(errors: Record<string, string>, key: string): Record<string, string> {
  if (!(key in errors)) return errors;
  const next = { ...errors };
  delete next[key];
  return next;
}

/**
 * 挂配置页：四份读各自独立失败（一份挂掉不拖垮整屏），写只在点"保存/测试"时发。
 * 编辑器里的改动活在 DOM 上，保存时按 `data-field` 路径收回补丁——不做双向绑定框架，
 * 也不把整份 config 摊成一个文本框。
 */
export function mountConfig(host: HTMLElement): MountedConfig {
  let model: ConfigModel = { ...EMPTY_CONFIG };
  let dead = false;
  let painted = false;

  const paint = () => {
    if (!painted) {
      host.innerHTML = '<div id="configRoot"></div>';
      painted = true;
    }
    section('configRoot', () => renderConfig(model));
  };

  const read = async <T>(path: string, key: string): Promise<T | null> => {
    try {
      const r = await call<{ data: T }>(path);
      if (dead) return null;
      model = { ...model, errors: withoutKey(model.errors, key) };
      return r?.data ?? null;
    } catch (e) {
      if (dead) return null;
      model = { ...model, errors: { ...model.errors, [key]: errText(e) } };
      return null;
    }
  };

  const loadAll = async () => {
    // global / notifications 两条 GET 的线上形状是 `{config:…}`（spec `:2528-2548`、`:2450-2470`），
    // 直接当成本体的话表单会永远空白——读错键不报错，只是永远显示占位符（设计口径）。
    const [accounts, globalRes, notifRes, recent] = await Promise.all([
      read<{ list?: QqAccount[] }>('/config/accounts', 'accounts'),
      read<{ config?: GlobalSettingsShape }>('/globalconfig', 'global'),
      read<{ config?: NotificationsConfigShape }>('/notifications-config', 'notifications'),
      read<DeliveryRow[]>('/notifications-recent', 'recent'),
    ]);
    if (dead) return;
    const list = accounts?.list ?? [];
    model = {
      ...model,
      accounts: list,
      uin: model.uin ?? list[0]?.uin ?? null,
      global: globalRes?.config ?? null,
      notifications: notifRes?.config ?? null,
      recent: recent ?? [],
    };
    paint();
    if (model.uin) await loadOneBot(model.uin);
  };

  const loadOneBot = async (uin: string) => {
    const cfg = await read<OneBotConfigShape>('/onebot-config?uin=' + encodeURIComponent(uin), 'onebot');
    if (dead) return;
    model = { ...model, uin, onebot: cfg };
    paint();
  };

  /**
   * 从 DOM 上的 data-field 收回一份补丁对象（数组下标写成 `a[0].b` 这种路径）。
   * `scope` 只决定"收哪些控件"，**不剥前缀**：剥掉之后 `networks.httpServers[0].port` 会变成
   * 顶层的 `httpServers`，合并出的整份配置就同时有旧 `networks` 和新 `httpServers` 两套键——
   * 上游只认前者，编辑静默不生效（真浏览器复验抓到，路径保持完整才谈得上 merge:full）。
   */
  const collectPatch = (root: HTMLElement, scope: string, seed: Record<string, unknown> = {}): Record<string, unknown> => {
    const patch: Record<string, unknown> = seed;
    const set = (path: string, value: unknown) => {
      const segs = path.replace(/\[(\d+)\]/g, '.$1').split('.');
      let node: Record<string, unknown> = patch;
      for (let i = 0; i < segs.length - 1; i += 1) {
        const seg = segs[i];
        const next = node[seg] as Record<string, unknown> | unknown[] | undefined;
        if (next === undefined) node[seg] = /^\d+$/.test(segs[i + 1]) ? [] : {};
        node = node[seg] as Record<string, unknown>;
      }
      node[segs[segs.length - 1]] = value;
    };
    root.querySelectorAll<HTMLElement>('[data-field]').forEach((el) => {
      const path = el.getAttribute('data-field') as string;
      if (!path.startsWith(scope)) return;
      if (el instanceof HTMLInputElement && el.type === 'checkbox') set(path, el.checked);
      else if (el instanceof HTMLInputElement && el.type === 'number') set(path, el.value === '' ? undefined : Number(el.value));
      else set(path, (el as HTMLInputElement | HTMLSelectElement).value);
    });
    return patch;
  };

  /**
   * 三段各自"从 DOM 收一份完整形状"。种子（seed）是必需的：某一类网络一行都没有时，
   * 光靠 DOM 收不出 `wsServers` 这个键，合出来的补丁会**漏掉这一类**——
   * 于是"删掉最后一个 ws 服务端"发出去的是"什么都没改"，而"新增一条"会在 undefined 上 push。
   * 种子每次新建（collectPatch 会就地改它，共用一份就是把上一次的编辑留在下一行里）。
   */
  const collectGlobal = (root: HTMLElement): Record<string, unknown> => ({
    ...collectPatch(root, 'musicSignUrl'),
    ...collectPatch(root, 'rkey.', { rkey: { fallbackServers: [] } }),
  });
  const collectOneBot = (root: HTMLElement): Record<string, unknown> => ({
    ...collectPatch(root, 'networks.', { networks: { httpServers: [], httpClients: [], wsServers: [], wsClients: [] } }),
    ...collectPatch(root, 'statusCommand.', { statusCommand: {} }),
    ...collectPatch(root, 'historySync.', { historySync: {} }),
  });
  const collectNotifications = (root: HTMLElement): Record<string, unknown> => ({
    ...collectPatch(root, 'debounceSeconds'),
    ...collectPatch(root, 'channels[', { channels: [] }),
  });

  /**
   * 结构改动（增删行会整屏重绘）前先把页面上的编辑收回 model，
   * 否则"改完名字再点新增"会把刚打的字丢掉。
   */
  const syncFromDom = (): void => {
    const root = host.querySelector<HTMLElement>('#configRoot');
    if (!root) return;
    if (model.global) model = { ...model, global: { ...model.global, ...collectGlobal(root) } as GlobalSettingsShape };
    if (model.onebot) model = { ...model, onebot: { ...model.onebot, ...collectOneBot(root) } as OneBotConfigShape };
    if (model.notifications) model = { ...model, notifications: { ...model.notifications, ...collectNotifications(root) } as NotificationsConfigShape };
  };

  /** 六个列表结构按钮：命中就返回 true（onClick 据此决定要不要继续往下找）。 */
  const structural = (target: HTMLElement): boolean => {
    const el = target.closest?.('[data-add-net],[data-remove-net],[data-add-channel],[data-remove-channel],[data-add-rkey],[data-remove-rkey]') as HTMLElement | null;
    if (!el) return false;
    const attr = (name: string): string | null => el.getAttribute(name);
    // 增删行都要整屏重绘，所以先 syncFromDom：否则刚打进去、还没保存的值会被 model 里的旧值盖掉
    const addNet = attr('data-add-net');
    if (addNet && model.onebot) {
      syncFromDom();
      const key = addNet as keyof NetworksShape;
      (model.onebot.networks[key] as NetworkItem[]).push(blankNetwork(key));
      paint();
      return true;
    }
    const removeNet = attr('data-remove-net');
    if (removeNet && model.onebot) {
      syncFromDom();
      const [kind, idx] = removeNet.split(':');
      (model.onebot.networks[kind as keyof NetworksShape] as NetworkItem[]).splice(Number(idx), 1);
      paint();
      return true;
    }
    if (attr('data-add-channel') !== null && model.notifications) {
      syncFromDom();
      model.notifications.channels.push(blankChannel(model.notifications.channels));
      paint();
      return true;
    }
    const removeChannel = attr('data-remove-channel');
    if (removeChannel !== null && model.notifications) {
      syncFromDom();
      model.notifications.channels.splice(Number(removeChannel), 1);
      paint();
      return true;
    }
    if (attr('data-add-rkey') !== null && model.global) {
      syncFromDom();
      model.global.rkey.fallbackServers.push('');
      paint();
      return true;
    }
    const removeRkey = attr('data-remove-rkey');
    if (removeRkey !== null && model.global) {
      syncFromDom();
      model.global.rkey.fallbackServers.splice(Number(removeRkey), 1);
      paint();
      return true;
    }
    return true; // 命中了选择器但对应配置还没读到：吃掉这次点击，不做无意义的重绘
  };

  const save = async (which: 'global' | 'onebot' | 'notifications') => {
    const paths = { global: '/globalconfig', onebot: '/onebot-config?uin=' + encodeURIComponent(model.uin ?? ''), notifications: '/notifications-config' } as const;
    const root = host.querySelector<HTMLElement>('#configRoot');
    if (!root) return;
    let patch: Record<string, unknown>;
    if (which === 'global') {
      const servers = Array.from(root.querySelectorAll<HTMLElement>('[data-field^="rkey.fallbackServers"]')).map((el) => (el as HTMLInputElement).value).filter(Boolean);
      patch = { musicSignUrl: (root.querySelector<HTMLElement>('[data-field="musicSignUrl"]') as HTMLInputElement)?.value ?? '', rkey: { fallbackServers: servers } };
    } else if (which === 'notifications') {
      patch = collectNotifications(root);
    } else {
      if (!model.uin) return;
      patch = collectOneBot(root);
    }
    model = { ...model, notices: { ...model.notices, [which]: '正在保存…' } };
    paint();
    try {
      const r = await post<{ data: unknown }>(paths[which], { patch });
      if (dead) return;
      const data = r?.data as (OneBotSaveShape & { config?: unknown }) | undefined;
      model = {
        ...model,
        notices: { ...model.notices, [which]: saveNotice(which, data) },
        errors: withoutKey(model.errors, which),
      };
      // 三条保存的 200 都带 `{success,config}`：以服务端归一化后的那一份为准刷新表单，
      // 不拿"我以为提交的内容"当已落盘的内容显示。config 的具体形状按 which 分派。
      const reply = r?.data as { config?: unknown } | undefined;
      const cfg = reply?.config;
      if (cfg && typeof cfg === 'object') {
        if (which === 'onebot') model = { ...model, onebot: cfg as OneBotConfigShape };
        if (which === 'global') model = { ...model, global: cfg as GlobalSettingsShape };
        if (which === 'notifications') model = { ...model, notifications: cfg as NotificationsConfigShape };
      }
    } catch (e) {
      if (dead) return;
      model = { ...model, errors: { ...model.errors, [which]: errText(e) }, notices: withoutKey(model.notices, which) };
    }
    paint();
  };

  const runTest = async (channelId: string) => {
    try {
      const r = await post<{ data: TestResultShape }>('/notifications-test', { channelId });
      if (dead) return;
      model = { ...model, testResults: { ...model.testResults, [channelId]: r?.data ?? { success: false, message: '无响应' } } };
    } catch (e) {
      if (dead) return;
      model = { ...model, testResults: { ...model.testResults, [channelId]: { success: false, message: errText(e) } } };
    }
    paint();
  };

  const onClick = (e: Event) => {
    const el = e.target as HTMLElement | null;
    if (!el) return;
    if (structural(el)) return;
    const saveBtn = el.closest?.('[data-save]') as HTMLElement | null;
    if (saveBtn) {
      void save(saveBtn.getAttribute('data-save') as 'global' | 'onebot' | 'notifications');
      return;
    }
    const testBtn = el.closest?.('[data-test-channel]') as HTMLElement | null;
    if (testBtn) {
      void runTest(testBtn.getAttribute('data-test-channel') as string);
      return;
    }
    const loadBtn = el.closest?.('[data-load-onebot]') as HTMLElement | null;
    if (loadBtn) {
      const sel = host.querySelector<HTMLSelectElement>('#onebotUin');
      if (sel?.value) void loadOneBot(sel.value);
    }
  };

  /**
   * 渠道 type 从 webhook 切到 email 会换一整组字段（SMTP 六件套，`notifications/config.ts:45-63`），
   * 不重绘就是"选了 email 但没地方填"。其余下拉（messageFormat/role）不改字段集，不需要重绘。
   */
  const onChange = (e: Event) => {
    const el = e.target as HTMLElement | null;
    if (!el) return;
    const path = el.getAttribute('data-field');
    if (!path || !path.endsWith('.type')) return;
    syncFromDom();
    paint();
  };

  host.addEventListener('click', onClick);
  host.addEventListener('change', onChange);
  void loadAll();

  return {
    destroy() {
      dead = true;
      host.removeEventListener('click', onClick);
      host.removeEventListener('change', onChange);
    },
  };
}
