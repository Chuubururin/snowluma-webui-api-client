// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
/**
 * 日志页：级别读/写、近期日志表、TRACE 导出，外加留给 SSE 的增量格子。
 *
 * 与真 WebUI 的三处刻意不同，都登记在 `demo/declinations.ts`：
 * 关键词过滤（logs-keyword-filter）、显示预设与 visibleLevels/maxLines/autoScroll/wrap
 * （logs-view-presets）、高亮规则（logs-highlight-rules）、虚拟滚动（logs-virtual-scroll）。
 * 这里做的是"每个 API 一个控件"：listLogs→表格 + limit，getLogLevel/setLogLevel→级别选择器，
 * exportTraceLog→导出按钮（落盘下载，不在页面 dump 原文），streamLogs→`logStreamFeed` 格子（接管）。
 */
import { ApiError, call, emitGateSignal, post } from '../api.js';
import { openStream, type ParsedFrame, type StreamHandle } from '../state.js';
import { downloadText, esc, section } from '../ui.js';

/** `LogEntry`（spec `:1160-1172`）：required 六键，`uin`/`req` 只在派生 logger / 请求作用域里才有。 */
export interface LogRow {
  id: number;
  time: string;
  level: string;
  scope: string;
  message: string;
  line: string;
  uin?: number;
  req?: number;
}

export interface LevelState {
  level: string | null;
  levels: string[];
}

export interface TraceState {
  filename: string | null;
  summary: Record<string, string>;
  filenameNote?: string;
}

export interface LogsModel {
  /** `null` = 这一次读没成功；空数组 = 读到了但内存里没有保留行。两者措辞必须不同。 */
  rows: LogRow[] | null;
  limit: number;
  level: LevelState | null;
  trace: TraceState | null;
  errors: Record<string, string>;
  notices: Record<string, string>;
  busy: Record<string, boolean>;
  /** 增量那一格：状态行 + 最近若干条推来的日志。与上面那张 REST 表是两个数据源，不互相覆盖。 */
  stream: { status: string; lines: StreamLine[] };
}

export interface StreamLine {
  time: string;
  level: string;
  message: string;
}

export const MAX_STREAM_LINES = 50;

/** 条目帧只认 spec 的 LogEntry 里那三键；缺键就明写缺哪个，不印 undefined 糊过去。 */
export function streamLineOf(f: ParsedFrame): StreamLine {
  const d = (f.data ?? {}) as Record<string, unknown>;
  const missing = ['time', 'level', 'message'].filter((k) => typeof d[k] !== 'string');
  if (missing.length > 0) return { time: '—', level: '—', message: '这条推来的日志缺键：' + missing.join('、') };
  return { time: String(d.time), level: String(d.level), message: String(d.message) };
}

export const EMPTY_LOGS: LogsModel = {
  rows: null,
  limit: 300,
  level: null,
  trace: null,
  errors: {},
  notices: {},
  busy: {},
  stream: { status: '连流中…', lines: [] },
};

function errText(e: unknown): string {
  if (e instanceof ApiError) return `${e.status} ${e.message}`;
  return (e as Error)?.message ?? String(e);
}

function withoutKey<V>(rec: Record<string, V>, key: string): Record<string, V> {
  if (!(key in rec)) return rec;
  const next = { ...rec };
  delete next[key];
  return next;
}

// ── 渲染 ────────────────────────────────────────────────────────────────────
export function renderLogTable(rows: LogRow[] | null): string {
  if (rows === null) return '<p class="muted">日志还没读到（下面的按钮可以重读）。</p>';
  if (rows.length === 0) return '<p class="muted" id="logTableEmpty">当前无保留日志：内存 logger 里没有保留任何行。</p>';
  return (
    '<table><thead><tr>' +
    ['时间', '级别', '模块', '消息', '关联']
      .map((h) => '<th>' + esc(h) + '</th>')
      .join('') +
    '</tr></thead><tbody>' +
    rows
      .map(
        (r) =>
          '<tr><td>' +
          esc(r.time) +
          '</td><td class="lv-' +
          esc(String(r.level).toLowerCase()) +
          '">' +
          esc(r.level) +
          '</td><td>' +
          esc(r.scope) +
          '</td><td>' +
          esc(r.message) +
          '</td><td>' +
          // 可选键：有就显示，没有就明写"无"，不拿空串冒充 0
          (r.uin === undefined && r.req === undefined ? '<span class="muted">无</span>' : 'uin ' + esc(r.uin ?? '—') + ' · req ' + esc(r.req ?? '—')) +
          '</td></tr>',
      )
      .join('') +
    '</tbody></table>'
  );
}

/**
 * 级别选择器。选项**来自上游的 `levels`**（`GET /api/logs/level` 与 400 的 `{message,levels}` 都带），
 * 客户端不硬编码六值——上游哪天加一档，这里不会悄悄少一项。
 * 措辞要说"当前会话生效、重启即回默认"：setLogLevel 是 `mutate-map`，不写盘（spec `:2397-2402`）。
 */
export function renderLevelPicker(view: { level: string | null; levels: string[]; error?: string; notice?: string; busy?: boolean; appliedNote?: string }): string {
  const head = (view.error ? '<div class="err">' + esc(view.error) + '</div>' : '') + (view.notice ? '<div class="ok">' + esc(view.notice) + '</div>' : '');
  if (view.levels.length === 0) return head + '<p class="muted">级别清单还没读到，下拉暂时无选项（不是"没有级别"）。</p>';
  return (
    head +
    '<label for="logLevelSelect">控制台日志级别<select id="logLevelSelect">' +
    view.levels
      .map((lv) => '<option value="' + esc(lv) + '"' + (view.level === lv ? ' selected' : '') + '>' + esc(lv) + '</option>')
      .join('') +
    '</select></label>' +
    '<button type="button" data-apply-level="1"' +
    (view.busy ? ' disabled' : '') +
    '>' +
    (view.busy ? '正在设置…' : '应用级别') +
    '</button>' +
    '<p class="hint">当前生效：<code>' +
    esc(view.level ?? '未读到') +
    '</code> · 这一档只改内存 logger：当前会话生效、进程重启即回默认。</p>' +
    (view.appliedNote ? '<p class="hint">' + esc(view.appliedNote) + '</p>' : '')
  );
}

/** 导出摘要：只端出正文头部那几行元信息；正文本身走下载，不进 DOM。 */
export function renderTraceSummary(summary: Record<string, string>, filename: string | null): string {
  const keys = Object.keys(summary);
  return (
    '<dl>' +
    (keys.length === 0 ? '<dt>元信息</dt><dd>导出正文里没有元信息头</dd>' : keys.map((k) => '<dt>' + esc(k) + '</dt><dd>' + esc(summary[k]) + '</dd>').join('')) +
    '</dl>' +
    '<p class="hint">文件名：<code>' +
    esc(filename ?? '未给出') +
    '</code>' +
    (filename ? '' : '（导出正文里没有 `Export time:` 行；demo 不拿本地时间冒充上游那一份）') +
    '</p>'
  );
}

export function renderLogs(m: LogsModel): string {
  return (
    '<h2>日志</h2>' +
    '<section data-ctl="levelSelect"><h3>级别</h3>' +
    renderLevelPicker({
      level: m.level?.level ?? null,
      levels: m.level?.levels ?? [],
      error: m.errors.level,
      notice: m.notices.level,
      busy: m.busy.level,
    }) +
    '</section>' +
    '<section data-ctl="logTable"><h3>近期日志</h3>' +
    (m.errors.logs ? '<div class="err">' + esc(m.errors.logs) + '</div>' : '') +
    '<label for="logLimit">读取行数（1..5000，缺省 300 与上游一致）<input id="logLimit" type="number" min="1" max="5000" value="' +
    esc(m.limit) +
    '" /></label>' +
    '<button type="button" data-reload-logs="1"' +
    (m.busy.logs ? ' disabled' : '') +
    '>' +
    (m.busy.logs ? '正在读取…' : '重新读取') +
    '</button>' +
    (m.rows ? '<p class="hint">' + m.rows.length + ' 行（本屏来自 REST 首屏）</p>' : '') +
    renderLogTable(m.rows) +
    '</section>' +
    '<section data-ctl="traceExportButton"><h3>完整 TRACE 导出</h3>' +
    (m.errors.trace ? '<div class="err">' + esc(m.errors.trace) + '</div>' : '') +
    '<button type="button" data-export-trace="1"' +
    (m.busy.trace ? ' disabled' : '') +
    '>' +
    (m.busy.trace ? '正在导出…' : '导出为文本文件（下载）') +
    '</button>' +
    (m.trace ? renderTraceSummary(m.trace.summary, m.trace.filename) : '<p class="hint">导出后这里显示正文头部的元信息摘要。</p>') +
    '</section>' +
    '<section data-ctl="logStreamFeed"><h3>增量推送</h3>' +
    '<p id="logStreamStatus">推流状态：' + esc(m.stream.status) + '</p>' +
    '<ul id="logStreamList">' +
    m.stream.lines.map((l) => `<li><code>${esc(l.level)}</code> ${esc(l.time)} — ${esc(l.message)}</li>`).join('') +
    '</ul>' +
    '<p class="hint">上面那张表是 REST 首屏，这一格是 <code>/events?topic=logs</code> 推来的增量。' +
    'logs 流没有 <code>dropped</code> 补偿帧（spec 的 <code>LogStreamFrame</code> 只有两支），所以它只做加法、不宣称自己是全量。</p>' +
    '</section>'
  );
}

// ── 挂载 ────────────────────────────────────────────────────────────────────
export interface MountedLogs {
  destroy(): void;
}

export function mountLogs(host: HTMLElement): MountedLogs {
  let model: LogsModel = { ...EMPTY_LOGS };
  let dead = false;
  let painted = false;
  let stream: StreamHandle | null = null;

  const onFrame = (fr: ParsedFrame): void => {
    if (dead) return;
    if (fr.kind === 'entry') {
      const line = streamLineOf(fr);
      model = { ...model, stream: { ...model.stream, lines: [line, ...model.stream.lines].slice(0, MAX_STREAM_LINES) } };
    } else if (fr.kind === 'ready') {
      model = { ...model, stream: { ...model.stream, status: '已连上（等待增量）' } };
    } else if (fr.kind === 'unparsable' || fr.kind === 'unlabeled') {
      model = { ...model, stream: { ...model.stream, status: '收到一帧读不懂：' + String(fr.raw ?? '').slice(0, 60) } };
    }
    paint();
  };

  const paint = () => {
    if (!painted) {
      host.innerHTML = '<div id="logsRoot"></div>';
      painted = true;
    }
    section('logsRoot', () => renderLogs(model));
  };

  const limitOf = (): number => {
    const el = host.querySelector<HTMLElement>('#logLimit') as HTMLInputElement | null;
    const n = Number(el?.value);
    return Number.isFinite(n) && n >= 1 ? Math.trunc(n) : model.limit;
  };

  const loadLogs = async () => {
    // 先读 limit 再重绘：重绘会按 model 把输入框写回去，晚一步读到的就是旧值（用户在框里打的数会蒸发）
    const limit = limitOf();
    model = { ...model, busy: { ...model.busy, logs: true } };
    paint();
    try {
      const r = await call<{ data: LogRow[]; limit: number }>('/logs?limit=' + encodeURIComponent(String(limit)));
      if (dead) return;
      model = { ...model, rows: r.data ?? [], limit: Number(r.limit) || model.limit, errors: withoutKey(model.errors, 'logs') };
    } catch (e) {
      if (dead) return;
      model = { ...model, rows: null, errors: { ...model.errors, logs: errText(e) } };
    }
    model = { ...model, busy: withoutKey(model.busy, 'logs') };
    paint();
  };

  const loadLevel = async () => {
    try {
      const r = await call<{ data: LevelState }>('/loglevel');
      if (dead) return;
      model = { ...model, level: r.data ?? null, errors: withoutKey(model.errors, 'level') };
    } catch (e) {
      if (dead) return;
      model = { ...model, errors: { ...model.errors, level: errText(e) } };
    }
    paint();
  };

  const applyLevel = async () => {
    const sel = host.querySelector<HTMLElement>('#logLevelSelect') as HTMLSelectElement | null;
    const level = sel?.value;
    if (!level) return;
    model = { ...model, busy: { ...model.busy, level: true }, notices: withoutKey(model.notices, 'level') };
    paint();
    try {
      const r = await post<{ data: LevelState }>('/loglevel', { level });
      if (dead) return;
      model = {
        ...model,
        level: r.data ?? model.level,
        notices: { ...model.notices, level: '已切到 ' + String(r.data?.level ?? level) + '（当前会话生效，不持久化）' },
        errors: withoutKey(model.errors, 'level'),
      };
    } catch (e) {
      if (dead) return;
      // 非法级别的 400 也带 levels ⇒ 用回传的清单把下拉重新填满，别让人对着空壳改
      const body = e instanceof ApiError ? (e.body as Partial<LevelState> | undefined) : undefined;
      const levels = Array.isArray(body?.levels) && body.levels.length > 0 ? body.levels : model.level?.levels ?? [];
      model = {
        ...model,
        level: { level: model.level?.level ?? null, levels },
        errors: { ...model.errors, level: errText(e) },
        notices: withoutKey(model.notices, 'level'),
      };
    }
    model = { ...model, busy: withoutKey(model.busy, 'level') };
    paint();
  };

  const exportTrace = async () => {
    model = { ...model, busy: { ...model.busy, trace: true }, errors: withoutKey(model.errors, 'trace') };
    paint();
    try {
      const r = await call<{ data: { text: string; filename: string | null; summary: Record<string, string>; filenameNote?: string } }>('/export-trace');
      if (dead) return;
      const d = r.data;
      if (!d || typeof d.text !== 'string') throw new Error('导出响应没有正文');
      downloadText(d.filename ?? 'snowluma-trace.log', d.text);
      model = { ...model, trace: { filename: d.filename ?? null, summary: d.summary ?? {}, filenameNote: d.filenameNote } };
    } catch (e) {
      if (dead) return;
      model = { ...model, errors: { ...model.errors, trace: errText(e) } };
    }
    model = { ...model, busy: withoutKey(model.busy, 'trace') };
    paint();
  };

  const onClick = (e: Event) => {
    const el = (e.target as HTMLElement | null)?.closest?.('[data-reload-logs],[data-apply-level],[data-export-trace]') as HTMLElement | null;
    if (!el) return;
    if (el.hasAttribute('data-reload-logs')) void loadLogs();
    else if (el.hasAttribute('data-apply-level')) void applyLevel();
    else if (el.hasAttribute('data-export-trace')) void exportTrace();
  };

  host.addEventListener('click', onClick);
  paint();
  void Promise.all([loadLogs(), loadLevel()]);
  stream = openStream('logs', {
    onFrame,
    onStatus: (s) => {
      if (dead) return;
      const label = s === 'open' ? '已连上（等待增量）' : s === 'closed' ? '已关闭' : s === 'error' ? '连接出错，准备重拨' : '重连中';
      model = { ...model, stream: { ...model.stream, status: label } };
      paint();
    },
    onSessionExpired: (message) => {
      if (dead) return;
      emitGateSignal('login', message);
    },
  });

  return {
    destroy() {
      dead = true;
      stream?.close();
      stream = null;
      host.removeEventListener('click', onClick);
    },
  };
}
