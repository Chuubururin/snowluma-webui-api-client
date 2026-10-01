// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
/**
 * 总览页（对齐真 WebUI 的 `overview-page.tsx`：状态卡 / QQ 列表 / 连接表 / 进程摘要 + 更新徽标）。
 * 渲染层是纯函数（`renderOverview` / `renderSystemCard` / `renderUpdateBadge`），挂载层只管
 * 取数、轮询与按钮接线 —— 纯函数能被 `tools/demo-overview.test.ts` 直接断言，不靠 DOM。
 *
 * 三条"不许发明字段"的判据（形状全部读自 spec，缺陷清单设计口径那一类就是读不存在的键）：
 *  · 实例版本 = `UpdateCheckResult.current`，运行秒数 = `SystemInfo.processUptime`；
 *    `/api/status` 线上只有 `{status:'running'}`，`SystemInfo.release` 是 OS 内核版本串。
 *  · 三个列表的 200 都是 `{list:[...]}`；`databaseMigration`、`lastError`/`lastErrorAt` 是可选键，
 *    缺键要照常渲染而不是崩，有键要看得见。
 *  · `checkUpdate` 的 `error` 是"检查未成功/已关闭"，与 `hasUpdate:false`（"已是最新"）是两屏不同文案。
 *
 * `stateStreamFeed` 这一格：建容器 + REST 首屏，只换数据来源不改控件名单
 * （见 task-6-7-addendum 17）。现在这一格的三份列表以推流快照为准，收到 `dropped` 就一次性 REST 重取。
 */
import { ApiError, call, emitGateSignal, post } from '../api.js';
import { openStream, type ParsedFrame, type StreamHandle } from '../state.js';
import { esc, section } from '../ui.js';
// 进程行的类型与中文状态标签都取自进程面板（同一定义处），总览卡不另立一套措辞。
import { processStatusLabel, type ProcessRow } from './processes.js';

// ── 线上传输形状（逐键对 spec，不多不少；可选键按 `?` 表达）─────────────────
export interface QqRow {
  uin: string;
  nickname: string;
}

export interface AdapterRow {
  name: string;
  kind: string;
  status: string;
  detail: string;
  lastError?: string;
  lastErrorAt?: number;
}

export interface ConnectionRow {
  uin: string;
  nickname: string;
  adapters: AdapterRow[];
  databaseMigration?: {
    phase: string;
    usable: boolean;
    processed: number;
    total: number | null;
    progress: number | null;
    estimatedRemainingSeconds: number | null;
    error?: string;
  };
}

export interface SystemInfoShape {
  hostname: string;
  platform: string;
  arch: string;
  archLabel: string;
  release: string;
  distro: string;
  uptime: number;
  processUptime: number;
  nodeVersion: string;
  cpu: { model: string; cores: number; speedMHz: number; loadAvg: number[]; perCore: number[]; average: number };
  memory: { total: number; free: number; used: number; usagePercent: number };
  runtime: { pid: number; rss: number; heapTotal: number; heapUsed: number; external: number; arrayBuffers: number };
}

export interface UpdateCheckShape {
  current: string;
  latest: string | null;
  hasUpdate: boolean;
  htmlUrl: string | null;
  notes: string | null;
  publishedAt: string | null;
  checkedAt: number;
  error?: string;
}

export interface OverviewModel {
  data: {
    status?: { status?: string } | null;
    system?: SystemInfoShape | null;
    qq?: { list?: QqRow[] } | null;
    connections?: { list?: ConnectionRow[] } | null;
    processes?: { list?: ProcessRow[] } | null;
    update?: UpdateCheckShape | null;
    ui?: { config?: { appearance?: { pollInterval?: number } } } | null;
  };
  errors: Record<string, string>;
  pollInterval: number | null;
  systemPollMs: number;
}

export const EMPTY_MODEL: OverviewModel = { data: {}, errors: {}, pollInterval: null, systemPollMs: 50_000 };

// ── 小工具：非有限数一律显示成看得见的空，不产出 NaN/undefined ───────────────
function num(v: unknown): string {
  return typeof v === 'number' && Number.isFinite(v) ? String(v) : '—';
}

/**
 * `UpdateCheckResult.checkedAt` 是 epoch 毫秒（spec `:866`）。直接把它印在页面上等于
 * 让人自己心算时间戳；缺值/坏值要明写"未知"，不许显示 0 或 NaN。
 */
export function checkTime(ms: unknown): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '时间未知';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '时间未知';
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    d.getFullYear() +
    '-' +
    pad(d.getMonth() + 1) +
    '-' +
    pad(d.getDate()) +
    ' ' +
    pad(d.getHours()) +
    ':' +
    pad(d.getMinutes()) +
    ':' +
    pad(d.getSeconds())
  );
}

function bytes(v: unknown): string {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '—';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let n = v;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${i === 0 ? n : n.toFixed(1)} ${units[i]}`;
}

function seconds(v: unknown): string {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return '—';
  const d = Math.floor(v / 86400);
  const h = Math.floor((v % 86400) / 3600);
  const m = Math.floor((v % 3600) / 60);
  const s = Math.floor(v % 60);
  return (d ? `${d}天 ` : '') + `${h}小时 ${m}分 ${s}秒`;
}

/** 一格数据的三种去处：有值 / 读失败（带服务端给的错误）/ 这次没读到。 */
function state(label: string, errors: Record<string, string>, value: string): string {
  const err = errors[label];
  if (err) return `<span class="err">${esc(err)}</span>`;
  return value;
}

function listOf<T>(box: { list?: T[] } | null | undefined): T[] {
  return Array.isArray(box?.list) ? (box!.list as T[]) : [];
}

// ── 渲染 ────────────────────────────────────────────────────────────────────
export function renderSystemCard(sys: SystemInfoShape | null | undefined, error?: string): string {
  if (!sys) {
    return '<div class="err" id="systemCardBody">系统信息：' + esc(error ?? '尚未读到') + '</div>';
  }
  const stale = error ? '<div class="err" id="systemCardBody">更新失败，显示上次数据：' + esc(error) + '</div>' : '';
  const rows: Array<[string, string]> = [
    ['主机名', esc(sys.hostname)],
    ['系统', esc(`${sys.distro} · ${sys.archLabel}（${sys.platform}/${sys.arch}）`)],
    ['内核版本', esc(sys.release)],
    ['主机运行时长', esc(seconds(sys.uptime)) + `（${num(sys.uptime)} 秒）`],
    ['本进程运行时长', esc(seconds(sys.processUptime)) + `（${num(sys.processUptime)} 秒）`],
    ['Node', esc(sys.nodeVersion)],
    ['CPU', esc(`${sys.cpu.model} · ${num(sys.cpu.cores)} 核 · ${num(sys.cpu.speedMHz)} MHz`) + ` · 平均 ${num(sys.cpu.average)}%`],
    ['负载', esc((sys.cpu.loadAvg ?? []).map((v) => num(v)).join(' / '))],
    ['逐核占用', esc((sys.cpu.perCore ?? []).map((v) => num(v)).join(' / '))],
    ['内存', esc(`总 ${bytes(sys.memory.total)} · 空闲 ${bytes(sys.memory.free)} · 已用 ${bytes(sys.memory.used)}`) + ` · ${num(sys.memory.usagePercent)}%`],
    [
      '运行时',
      esc(
        `pid ${num(sys.runtime.pid)} · rss ${bytes(sys.runtime.rss)} · heap ${bytes(sys.runtime.heapUsed)}/${bytes(
          sys.runtime.heapTotal,
        )} · external ${bytes(sys.runtime.external)} · arrayBuffers ${bytes(sys.runtime.arrayBuffers)}`,
      ),
    ],
  ];
  return (
    stale +
    '<div id="systemCardBody"><dl class="kv">' +
    rows.map(([k, v]) => '<dt>' + k + '</dt><dd>' + v + '</dd>').join('') +
    '</dl></div>'
  );
}

/**
 * 更新徽标。四态互斥，别把"检查没成功"说成"已是最新"（实码 `update-check.ts:146` 的失败支是
 * 200 + `error`，`hasUpdate` 恒为 false —— 只看 hasUpdate 就会把故障报成"你已经是最新"）。
 */
export function renderUpdateBadge(update: UpdateCheckShape | null | undefined, transportError?: string): string {
  if (transportError) return '<span class="err">更新检查失败：' + esc(transportError) + '</span>';
  if (!update) return '<span id="updateState">尚未做过更新检查</span>';
  if (update.error === 'disabled') {
    return '<span id="updateState">更新检查已关闭</span> <span class="hint">当前版本 ' + esc(update.current) + '</span>';
  }
  if (update.error) {
    return (
      '<span class="err" id="updateState">检查未成功：' +
      esc(update.error) +
      '</span> <span class="hint">当前版本 ' +
      esc(update.current) +
      '</span>'
    );
  }
  if (update.hasUpdate && update.latest) {
    const link = update.htmlUrl
      ? ' <a href="' + esc(update.htmlUrl) + '" rel="noreferrer noopener" target="_blank">发行页</a>'
      : '';
    return (
      '<span id="updateState">有新版本可用 v' +
      esc(update.latest) +
      '</span> <span class="hint">当前 v' +
      esc(update.current) +
      ' · 检查于 ' +
      checkTime(update.checkedAt) +
      '</span>' +
      link
    );
  }
  return '<span id="updateState">已是最新</span> <span class="hint">当前版本 ' + esc(update.current) + '</span>';
}

function renderQqList(box: { list?: QqRow[] } | null | undefined, error?: string): string {
  if (error && !box) return '<div class="err">' + esc(error) + '</div>';
  const list = listOf(box);
  const note = error ? '<div class="err">更新失败，显示上次数据：' + esc(error) + '</div>' : '';
  if (list.length === 0) {
    return note + '<p id="qqListBody">暂无在线账号（尚未接入，或账号都离线）。</p>';
  }
  return (
    note +
    '<ul id="qqListBody">' +
    list.map((q) => '<li><code>' + esc(q.uin) + '</code> ' + esc(q.nickname || '(无昵称)') + '</li>').join('') +
    '</ul>'
  );
}

const ADAPTER_STATUS_LABEL: Record<string, string> = {
  ok: '正常',
  warn: '告警',
  down: '断开',
  disabled: '已禁用',
  degraded: '降级',
};

const MIGRATION_PHASE_LABEL: Record<string, string> = {
  preparing: '准备中',
  migrating: '迁移中',
  complete: '已完成',
  failed: '失败',
};

function renderConnections(box: { list?: ConnectionRow[] } | null | undefined, error?: string): string {
  if (error && !box) return '<div class="err">' + esc(error) + '</div>';
  const list = listOf(box);
  const note = error ? '<div class="err">更新失败，显示上次数据：' + esc(error) + '</div>' : '';
  if (list.length === 0) return note + '<p id="connectionTableBody">暂无已接入的账号实例。</p>';
  const rows = list
    .map((acc) => {
      const migration = acc.databaseMigration
        ? '<tr><td colspan="4" class="hint">数据库迁移：' +
          esc(MIGRATION_PHASE_LABEL[acc.databaseMigration.phase] ?? acc.databaseMigration.phase) +
          '（可用：' +
          (acc.databaseMigration.usable ? '是' : '否') +
          '）</td></tr>'
        : '';
      const adapters =
        acc.adapters.length === 0
          ? '<tr><td colspan="4" class="hint">未配置任何协议端点</td></tr>'
          : acc.adapters
              .map(
                (a) =>
                  '<tr><td>' +
                  esc(a.name) +
                  '</td><td>' +
                  esc(a.kind) +
                  '</td><td>' +
                  esc(ADAPTER_STATUS_LABEL[a.status] ?? a.status) +
                  '</td><td>' +
                  esc(a.detail) +
                  (a.lastError
                    ? '<div class="err">' +
                      esc(a.lastError) +
                      (typeof a.lastErrorAt === 'number' ? ' @ ' + esc(new Date(a.lastErrorAt).toISOString()) : '') +
                      '</div>'
                    : '') +
                  '</td></tr>',
              )
              .join('');
      return (
        '<tr class="account"><th colspan="4">' +
        esc(acc.nickname || acc.uin) +
        ' <code>' +
        esc(acc.uin) +
        '</code></th></tr>' +
        migration +
        adapters
      );
    })
    .join('');
  return (
    note +
    '<table id="connectionTableBody"><thead><tr><th>端点</th><th>类型</th><th>状态</th><th>详情</th></tr></thead><tbody>' +
    rows +
    '</tbody></table>'
  );
}

function renderProcessSummary(box: { list?: ProcessRow[] } | null | undefined, error?: string): string {
  if (error && !box) return '<div class="err">' + esc(error) + '</div>';
  const list = listOf(box);
  const note = error ? '<div class="err">更新失败，显示上次数据：' + esc(error) + '</div>' : '';
  if (list.length === 0) {
    return note + '<p id="processSummaryBody">未检测到可加载的 QQ 主进程。</p>';
  }
  const online = list.filter((p) => p.status === 'online').length;
  const injected = list.filter((p) => p.injected).length;
  return (
    note +
    '<p id="processSummaryBody">' +
    list.length +
    ' 个进程 · ' +
    injected +
    ' 已注入 · ' +
    online +
    ' 在线' +
    '</p><ul>' +
    list
      .map(
        (p) =>
          '<li>PID ' +
          num(p.pid) +
          ' ' +
          esc(p.name || '(无名)') +
          ' · ' +
          esc(processStatusLabel(p.status)) +
          (p.error ? ' · <span class="err">' + esc(p.error) + '</span>' : '') +
          '</li>',
      )
      .join('') +
    '</ul>'
  );
}

/** 一格要么有数据、要么有错误、要么明写"尚未读到"：绝不留悬挂的加载态。 */
function tile(label: string, value: string): string {
  return '<div class="tile"><span class="tileLabel">' + label + '</span><span class="tileValue">' + value + '</span></div>';
}

function renderStatusCards(m: OverviewModel): string {
  const qqCount = m.errors.qq ? '<span class="err">' + esc(m.errors.qq) + '</span>' : String(listOf(m.data.qq).length);
  const procs = listOf(m.data.processes);
  const procValue = m.errors.processes
    ? '<span class="err">' + esc(m.errors.processes) + '</span>'
    : m.data.processes
      ? `${procs.length} 个进程 · ${procs.filter((p) => p.status === 'online').length} 在线`
      : '尚未读到';
  const versionValue = m.data.update
    ? esc(m.data.update.current)
    : '<span class="err">' + esc(m.errors.update ?? '尚未读到') + '</span>';
  const uptimeValue = m.data.system
    ? esc(seconds(m.data.system.processUptime))
    : '<span class="err">' + esc(m.errors.system ?? '尚未读到') + '</span>';
  return (
    tile('服务状态', state('status', m.errors, m.data.status?.status ? esc(m.data.status.status) : '尚未读到')) +
    tile('在线账号', qqCount) +
    tile('进程', procValue) +
    tile('实例版本（来自更新检查）', versionValue) +
    tile('本进程运行时长（来自 systemInfo）', uptimeValue)
  );
}

/** 流视图：连接状态 + 最后一帧 + 三份资源各自的数据来源（REST 首屏还是推流）。 */
export interface StreamFeedView {
  status: string;
  last: string;
  dropped: number;
  fromStream: string[];
}

const EMPTY_FEED: StreamFeedView = { status: '连流中…', last: '还没收到帧', dropped: 0, fromStream: [] };

function renderStateStreamFeed(m: OverviewModel, feed: StreamFeedView): string {
  const errs = Object.entries(m.errors).map(([k, v]) => '<li>' + esc(k) + '：<span class="err">' + esc(v) + '</span></li>');
  const errsHtml = errs.length ? '<ul class="err">' + errs.join('') + '</ul>' : '';
  const src = (k: string) => (feed.fromStream.includes(k) ? '推流' : 'REST 首屏');
  return (
    '<p>当前快照：账号 ' +
    listOf(m.data.qq).length +
    '（' +
    src('qq') +
    '） · 连接 ' +
    listOf(m.data.connections).length +
    '（' +
    src('connections') +
    '） · 进程 ' +
    listOf(m.data.processes).length +
    '（' +
    src('processes') +
    '）</p>' +
    '<p>推流状态：<span id="stateStreamStatus">' +
    esc(feed.status) +
    '</span> · 最后一帧：<code id="stateStreamLast">' +
    esc(feed.last) +
    '</code>' +
    (feed.dropped > 0 ? '<p class="warn">累计丢帧 ' + feed.dropped + '，每收到一次 <code>dropped</code> 就做一次三份 REST 对账。</p>' : '') +
    '<p class="hint"><code>/events?topic=state</code> 一条上游订阅按浏览器连接数引用计数；快照是**整份**，收到就覆盖本地，不做 diff 合并。</p>' +
    '<ul id="stateStreamLines">' +
    errsHtml +
    '</ul>'
  );
}

function renderPollIntervalSelect(m: OverviewModel): string {
  const raw = m.pollInterval === null ? '读不出来（不猜，按默认档）' : `${m.pollInterval} 毫秒`;
  return (
    '<p>systemInfo 轮询周期：<strong>' +
    num(m.systemPollMs) +
    '</strong> 毫秒（= 实例 <code>appearance.pollInterval</code> ' +
    esc(raw) +
    ' × 10，下限 10 秒）。</p>' +
    '<p class="hint">这个值在实例上改：设置页的外观分组（<code>saveUiConfig</code>）。总览页只读它并据此轮询，不放保存按钮。</p>' +
    '<button id="systemPollNow" type="button">立即重新读取系统信息</button>'
  );
}

export function renderOverview(m: OverviewModel, feed: StreamFeedView = EMPTY_FEED): string {
  return (
    '<h2>总览</h2>' +
    (m.errors.load ? '<div class="err" id="overviewLoadError">整屏读取失败：' + esc(m.errors.load) + '</div>' : '') +
    '<p><button id="overviewReload" type="button">重新读取全部</button></p>' +
    '<section data-ctl="statusCards"><h3>状态卡 / 主机资源</h3>' +
    '<div class="tiles">' +
    renderStatusCards(m) +
    '</div>' +
    renderSystemCard(m.data.system, m.errors.system) +
    '</section>' +
    '<section data-ctl="qqList"><h3>在线账号</h3>' +
    renderQqList(m.data.qq, m.errors.qq) +
    '</section>' +
    '<section data-ctl="connectionTable"><h3>OneBot 连接</h3>' +
    renderConnections(m.data.connections, m.errors.connections) +
    '</section>' +
    '<section data-ctl="processSummary"><h3>进程摘要</h3>' +
    renderProcessSummary(m.data.processes, m.errors.processes) +
    '<p class="hint">逐进程的载入/卸载/刷新/探测在「进程」页。</p>' +
    '</section>' +
    '<section data-ctl="updateBadge"><h3>更新检查</h3>' +
    renderUpdateBadge(m.data.update, m.errors.update) +
    '<p><button id="updateCheckNow" type="button">立即检查（绕开服务端缓存）</button></p>' +
    '</section>' +
    '<section data-ctl="stateStreamFeed"><h3>实时状态</h3>' +
    renderStateStreamFeed(m, feed) +
    '</section>' +
    '<section data-ctl="pollIntervalSelect"><h3>轮询周期</h3>' +
    renderPollIntervalSelect(m) +
    '</section>'
  );
}

// ── 挂载层 ──────────────────────────────────────────────────────────────────
export interface OverviewSnapshot {
  version: string | null;
  processUptimeSeconds: number | null;
  instanceStatus: string | null;
}

export interface OverviewHooks {
  /** 外壳的 sessionBar 用同一份读到的数据（版本来自 update.current，运行秒数来自 system.processUptime）。 */
  onSnapshot?: (s: OverviewSnapshot) => void;
}

export interface MountedOverview {
  destroy(): void;
}

/**
 * 挂总览页：一次 GET /overview 首屏，然后按服务端算好的 systemPollMs 单独轮 /overview/system。
 * 轮询失败保留上一次读数并显示"更新失败，显示上次数据"（对齐上游 HostBlock 的做法），
 * 定时器在 destroy() 里清掉：换面板不留悬挂轮询。
 */
export function mountOverview(host: HTMLElement, hooks: OverviewHooks = {}): MountedOverview {
  let model: OverviewModel = { ...EMPTY_MODEL, data: {}, errors: {} };
  let timer: ReturnType<typeof setInterval> | null = null;
  let dead = false;
  let painted = false;
  let feed: StreamFeedView = { ...EMPTY_FEED, fromStream: [] };
  let stream: StreamHandle | null = null;

  /** 快照帧的资源名 → 本面板的键。认不出来的资源名明写出来，不静默吞（吞了就是"流上明明有东西"却看不见）。 */
  const RESOURCE_KEY: Record<string, 'qq' | 'connections' | 'processes'> = {
    'qq-list': 'qq',
    connections: 'connections',
    processes: 'processes',
  };

  const onFrame = (f: ParsedFrame): void => {
    if (dead) return;
    if (f.kind === 'snapshot') {
      const key = f.resource ? RESOURCE_KEY[f.resource] : undefined;
      if (!key) {
        feed = { ...feed, last: '没认出的资源：' + String(f.resource ?? '（无）') };
        paint();
        return;
      }
      const list = Array.isArray(f.data) ? f.data : [];
      model = { ...model, data: { ...model.data, [key]: { list } as never } };
      feed = {
        ...feed,
        fromStream: [...new Set([...feed.fromStream, key])],
        last: `快照 ${f.resource}（${list.length} 项）`,
      };
      paint();
      return;
    }
    if (f.kind === 'dropped') {
      const n = Number(f.count);
      const gained = Number.isFinite(n) && n > 0 ? n : 1;
      feed = { ...feed, dropped: feed.dropped + gained, last: `丢了 ${gained} 帧 ⇒ 三份 REST 对账` };
      paint();
      void load(); // 一次性对账：此后每一帧都可能是残缺全量，只能整份重取
      return;
    }
    if (f.kind === 'ready') {
      feed = { ...feed, status: '已连上', last: '就绪' };
    } else if (f.kind === 'unparsable') {
      feed = { ...feed, last: '收到一帧读不懂：' + String(f.raw ?? '').slice(0, 60) };
    } else {
      feed = { ...feed, last: '收到一帧没有标签：' + String(f.raw ?? f.kind).slice(0, 60) };
    }
    paint();
  };

  const paint = () => {
    if (!painted) {
      host.innerHTML = '<div id="overviewRoot"></div>';
      painted = true;
    }
    section('overviewRoot', () => renderOverview(model, feed));
  };

  const snapshot = () => {
    hooks.onSnapshot?.({
      version: model.data.update?.current ?? null,
      processUptimeSeconds: model.data.system?.processUptime ?? null,
      instanceStatus: model.data.status?.status ?? null,
    });
  };

  const load = async () => {
    try {
      const next = await call<OverviewModel>('/overview');
      if (dead) return;
      model = {
        data: next?.data ?? {},
        errors: next?.errors ?? {},
        pollInterval: typeof next?.pollInterval === 'number' ? next.pollInterval : null,
        systemPollMs: typeof next?.systemPollMs === 'number' ? next.systemPollMs : 50_000,
      };
      paint();
      snapshot();
      schedule();
    } catch (e) {
      if (dead) return;
      // 整屏失败也要看得见：留在原地不重画就是"永远停在上一屏"
      model = { ...model, errors: { ...model.errors, load: errText(e) } };
      paint();
    }
  };

  const pollSystem = async () => {
    try {
      const r = await call<{ data: SystemInfoShape }>('/overview/system');
      if (dead) return;
      // 保留上一次读数：上游对 systemInfo 失败也是"显示上次数据 + 一条告警"
      model = { ...model, data: { ...model.data, system: r.data ?? null }, errors: without(model.errors, 'system') };
    } catch (e) {
      if (dead) return;
      model = { ...model, errors: { ...model.errors, system: errText(e) } };
    }
    paint();
    snapshot();
  };

  const checkUpdateNow = async () => {
    try {
      const r = await post<{ data: UpdateCheckShape }>('/overview/update-check', {});
      if (dead) return;
      model = { ...model, data: { ...model.data, update: r.data ?? null }, errors: without(model.errors, 'update') };
    } catch (e) {
      if (dead) return;
      model = { ...model, errors: { ...model.errors, update: errText(e) } };
    }
    paint();
    snapshot();
  };

  const schedule = () => {
    if (timer !== null) clearInterval(timer);
    timer = setInterval(() => void pollSystem(), model.systemPollMs);
  };

  const onClick = (e: Event) => {
    const btn = (e.target as HTMLElement | null)?.closest?.('button') as HTMLButtonElement | null;
    if (!btn) return;
    if (btn.id === 'overviewReload') void load();
    else if (btn.id === 'systemPollNow') void pollSystem();
    else if (btn.id === 'updateCheckNow') void checkUpdateNow();
  };

  host.addEventListener('click', onClick);
  paint();
  void load();
  stream = openStream('state', {
    onFrame,
    onStatus: (s) => {
      if (dead) return;
      feed = { ...feed, status: s === 'open' ? '已连上' : s === 'closed' ? '已关闭' : s === 'error' ? '连接出错，准备重拨' : '重连中' };
      paint();
    },
    onSessionExpired: (message) => {
      if (dead) return;
      emitGateSignal('login', message); // 去留由外壳定：面板不自己画登录屏，也不再重拨
    },
  });

  return {
    destroy() {
      dead = true;
      stream?.close();
      stream = null;
      if (timer !== null) clearInterval(timer);
      timer = null;
      // 监听器挂在宿主元素上：面板宿主是共用的，不摘就会在下一次挂载时把按钮接成双份
      host.removeEventListener('click', onClick);
    },
  };
}

/** 从 errors 里摘掉某一个键（读到新数据后上一轮的失败不该继续挂着）。 */
function without(errors: Record<string, string>, key: string): Record<string, string> {
  const { [key]: _dropped, ...rest } = errors;
  return rest;
}

/** ApiError 带 body（门禁的 403 会把 step 与两键放在里面），纯网络错只有一句 message。 */
function errText(e: unknown): string {
  if (e instanceof ApiError) return `${e.status} ${e.body?.message ?? e.message}`;
  return String((e as Error)?.message ?? e);
}
