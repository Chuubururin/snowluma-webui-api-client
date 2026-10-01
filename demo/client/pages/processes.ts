// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
/**
 * 进程页（对齐真 WebUI 的 `processes-page.tsx`）。
 *
 * 这个面板是全站唯一会**改上游状态**的地方：load / unload / refresh / probe-login 四条
 * 全是 `x-replay-class: t3`（前三条另带 `x-snowluma-destructive: true`，spec `:2898-2991`）。
 * 所以这里的形态约束不是风格：
 *  · 只有 `data-action` / `data-probe` 上的**点击**才发得出请求，挂载只读一次列表；
 *  · 响应一律原样显示上游的 `success` —— HTTP 200 里 `success:false` 是真实存在的分支
 *    （上游按 `processInfo.status !== 'error'` 判，实码 `server.ts:1485`），
 *    以 HTTP 码代状态就会把注入失败画成成功。
 *
 * `ProcessRow` 与状态中文标签在本模块定义：总览页的"进程摘要"卡显示的是同一批数据、
 * 同一套措辞，两处各写一份迟早会分叉（`overview.ts` 从这里 import）。
 */
import { ApiError, call, post } from '../api.js';
import { esc, section } from '../ui.js';

/** `HookProcessInfo` 十键全 required（spec `:301-321`；`error` 无错时是空串，不是缺键）。 */
export interface ProcessRow {
  pid: number;
  name: string;
  path: string;
  injected: boolean;
  connected: boolean;
  loggedIn: boolean;
  uin: string;
  status: string;
  error: string;
  method: string;
}

/** `ProcessActionResult`（spec `:509-516`）。`success` 在 200 里可以为 false。 */
export interface ProcessActionResultShape {
  success: boolean;
  process: ProcessRow;
}

/** `QqPortLoginInfo`（spec `:497-507`；`uid`/`nickName` 可选，`identityKnown` 必带）。 */
export interface QqPortLoginInfoShape {
  port: number;
  uin: string;
  uid?: string;
  nickName?: string;
  identityKnown: boolean;
}

const PROCESS_STATUS_LABEL: Record<string, string> = {
  available: '可加载',
  loading: '加载中',
  connecting: '等待连接',
  loaded: '等待登录',
  online: '已在线',
  error: '错误',
  disconnected: '已断开',
};

export function processStatusLabel(status: string): string {
  return PROCESS_STATUS_LABEL[status] ?? status;
}

const ACTION_LABEL: Record<string, string> = { load: '载入', unload: '卸载', refresh: '刷新' };

export function actionLabel(action: string): string {
  return ACTION_LABEL[action] ?? action;
}

export interface ProcessesModel {
  data: { list?: ProcessRow[] } | null;
  errors: Record<string, string>;
  /** 键 `pid:action`；最近一次动作的上游信封。 */
  outcomes: Record<string, ProcessActionResultShape>;
  /** 键 pid；缺键 = 还没点过探测，`null` = 探过了但没探到。 */
  probes: Record<string, QqPortLoginInfoShape | null>;
  /** 正在等的 `pid:action`（T3 动作期间禁用该行的四个按钮，防止连点重放）；缺省 = 没在等。 */
  pending?: string | null;
}

export const EMPTY_PROCESSES: ProcessesModel = {
  data: null,
  errors: {},
  outcomes: {},
  probes: {},
  pending: null,
};

function yesno(on: boolean): string {
  return on ? '是' : '否';
}

/**
 * 探测格三态分得开：没点过（提示去点）/ 点了但没探到（上游给 `{info:null}`，那是真形不是错误）/
 * 探到了（端口 + uin + 身份是否已知）。`identityKnown:false` 必须显出来——上游在
 * `bridge/src/qq-port-probe.ts:27-28` 专门警告"本地端点暴露了账号身份不等于协议会话就绪"。
 */
export function renderProbeCell(info: QqPortLoginInfoShape | null | undefined): string {
  if (info === undefined) return '<span class="muted">还没点过探测</span>';
  if (info === null) return '<span class="muted">未探测到（本地端口没有可识别的登录信息）</span>';
  return (
    '<span>端口 <code>' +
    esc(String(info.port)) +
    '</code> · uin <code>' +
    esc(info.uin) +
    '</code>' +
    (info.nickName ? ' · 昵称 ' + esc(info.nickName) : '') +
    (info.uid ? ' · uid ' + esc(info.uid) : '') +
    ' · 身份' +
    (info.identityKnown ? '已知' : '未知') +
    (info.identityKnown
      ? '</span>'
      : '（本地端点有身份不等于协议会话就绪）</span>')
  );
}

/**
 * 动作结果一屏。三态：没点过 = 空串（不许留"加载中"悬挂）；`success:true` = 成功并带回进程状态；
 * `success:false` = **写成失败**并带 `process.status` 与 `process.error`，即使这一枪的 HTTP 是 200。
 */
export function renderActionOutcome(action: string, result: ProcessActionResultShape | undefined): string {
  if (!result) return '';
  const label = actionLabel(action);
  const status = processStatusLabel(result.process?.status ?? '');
  if (result.success === false) {
    return (
      '<div class="err" role="status">' +
      esc(label) +
      '失败：上游返回 success:false · 进程状态 ' +
      esc(status) +
      (result.process?.error ? ' · 错误 ' + esc(result.process.error) : '') +
      '</div>'
    );
  }
  return (
    '<div class="ok" role="status">' +
    esc(label) +
    '已受理 · 进程状态 ' +
    esc(status) +
    '</div>'
  );
}

function renderRow(p: ProcessRow, m: ProcessesModel): string {
  const outcome = ['load', 'unload', 'refresh']
    .map((a) => renderActionOutcome(a, m.outcomes[`${p.pid}:${a}`]))
    .filter(Boolean)
    .join('');
  const busy = (m.pending ?? null) !== null && (m.pending as string).startsWith(`${p.pid}:`);
  return (
    '<tr data-pid="' +
    esc(String(p.pid)) +
    '">' +
    '<td><code>' +
    esc(String(p.pid)) +
    '</code></td>' +
    '<td>' +
    esc(p.name) +
    '</td>' +
    '<td><code>' +
    esc(p.path) +
    '</code></td>' +
    '<td>' +
    esc(processStatusLabel(p.status)) +
    '</td>' +
    '<td>' +
    (p.uin ? '<code>' + esc(p.uin) + '</code>' : '<span class="muted">—</span>') +
    '</td>' +
    '<td>' +
    yesno(p.injected) +
    ' / ' +
    yesno(p.connected) +
    ' / ' +
    yesno(p.loggedIn) +
    '</td>' +
    '<td>' +
    esc(p.method) +
    '</td>' +
    // 空串是"没有错"，这时连格子的 err 类都不给：留着 `<td class="err"></td>` 会让
    // "错误列永远存在但永远空"看起来像数据（真上游无错时给的就是空串）。
    (p.error ? '<td class="err">' + esc(p.error) + '</td>' : '<td class="muted">—</td>') +
    '<td data-probe-cell="' +
    esc(String(p.pid)) +
    '">' +
    renderProbeCell(p.pid in m.probes ? m.probes[p.pid] : undefined) +
    '</td>' +
    '<td>' +
    (busy
      ? '<span class="muted">等待上游响应…</span>'
      : '<button type="button" data-action="load" data-pid="' +
        esc(String(p.pid)) +
        '" data-ctl="loadButton">载入</button>' +
        '<button type="button" data-action="unload" data-pid="' +
        esc(String(p.pid)) +
        '" data-ctl="unloadButton">卸载</button>' +
        '<button type="button" data-action="refresh" data-pid="' +
        esc(String(p.pid)) +
        '" data-ctl="refreshButton">刷新</button>' +
        '<button type="button" data-probe="1" data-pid="' +
        esc(String(p.pid)) +
        '" data-ctl="probeButton">探测登录</button>') +
    (outcome ? '<div class="outcome">' + outcome + '</div>' : '') +
    '</td>' +
    '</tr>'
  );
}

export function renderProcesses(m: ProcessesModel): string {
  const list = m.data?.list ?? [];
  const loadError = m.errors.load;
  if (!m.data && loadError) {
    return (
      '<section data-ctl="processTable"><h3>进程列表</h3>' +
      '<div class="err" id="processesError">' +
      esc(loadError) +
      '</div><p class="muted">列表没读到，所以这一屏没有任何可点的动作。</p></section>'
    );
  }
  const note = loadError ? '<div class="err">更新失败，显示上次数据：' + esc(loadError) + '</div>' : '';
  if (list.length === 0) {
    return (
      note +
      '<section data-ctl="processTable"><h3>进程列表</h3>' +
      '<p id="processesEmpty">未检测到被 Hook 注入的 QQ 主进程。</p>' +
      '<p class="muted">没有进程行就没有可点的动作——四条 T3 操作只能对已存在的进程发起。</p>' +
      '<p><button type="button" data-reload="1" data-ctl="reloadButton">重新读取</button></p></section>'
    );
  }
  return (
    '<section data-ctl="processTable"><h3>进程列表</h3>' +
    note +
    (m.errors.action ? '<div class="err">' + esc(m.errors.action) + '</div>' : '') +
    (m.errors.probe ? '<div class="err">' + esc(m.errors.probe) + '</div>' : '') +
    '<table><thead><tr>' +
    ['PID', '进程名', '可执行路径', '状态', 'uin', '注入/连接/登录', '注入方式', '错误', '登录探测', '操作']
      .map((h) => '<th>' + esc(h) + '</th>')
      .join('') +
    '</tr></thead><tbody>' +
    list.map((p) => renderRow(p, m)).join('') +
    '</tbody></table>' +
    '<p class="muted">载入 / 卸载 / 刷新 / 探测登录在规格里都是 T3 操作：只在点了以后发一次，' +
    '页面不会自动重放，也不会自动重试。</p></section>'
  );
}

export interface MountedProcesses {
  destroy(): void;
}

function errText(e: unknown): string {
  if (e instanceof ApiError) return `${e.status} ${e.message}`;
  return (e as Error)?.message ?? String(e);
}

/**
 * 挂进程页：首屏一次 `GET /processes`，之后只有点击才出网。
 * 探测是 GET 但同样被划进 T3（它会打开对端端口），所以也只在按钮点击时发。
 */
export function mountProcesses(host: HTMLElement): MountedProcesses {
  let model: ProcessesModel = { ...EMPTY_PROCESSES, data: null, errors: {}, outcomes: {}, probes: {} };
  let dead = false;
  let painted = false;

  const paint = () => {
    if (!painted) {
      host.innerHTML = '<div id="processesRoot"></div>';
      painted = true;
    }
    section('processesRoot', () => renderProcesses(model));
  };

  const load = async () => {
    try {
      const r = await call<{ data: { list?: ProcessRow[] } }>('/processes');
      if (dead) return;
      model = { ...model, data: r?.data ?? { list: [] }, errors: withoutKey(model.errors, 'load') };
    } catch (e) {
      if (dead) return;
      model = { ...model, errors: { ...model.errors, load: errText(e) } };
    }
    paint();
  };

  const runAction = async (action: string, pid: number) => {
    const key = `${pid}:${action}`;
    model = { ...model, pending: key, errors: withoutKey(model.errors, 'action') };
    paint();
    try {
      const res = await post<ProcessActionResultShape>('/process-action', { action, pid });
      if (dead) return;
      // 原样存上游信封：`success:false` 要留在 outcomes 里被渲染成失败
      model = {
        ...model,
        pending: null,
        outcomes: { ...model.outcomes, [key]: res },
        data: mergeProcess(model.data, action, res),
      };
    } catch (e) {
      if (dead) return;
      model = { ...model, pending: null, errors: { ...model.errors, action: `${actionLabel(action)}：${errText(e)}` } };
    }
    paint();
  };

  const runProbe = async (pid: number) => {
    model = { ...model, errors: withoutKey(model.errors, 'probe') };
    paint();
    try {
      const r = await call<{ info: QqPortLoginInfoShape | null }>(`/probe-login?pid=${encodeURIComponent(String(pid))}`);
      if (dead) return;
      model = { ...model, probes: { ...model.probes, [String(pid)]: r?.info ?? null } };
    } catch (e) {
      if (dead) return;
      model = { ...model, errors: { ...model.errors, probe: `探测：${errText(e)}` } };
    }
    paint();
  };

  const onClick = (e: Event) => {
    const btn = (e.target as HTMLElement | null)?.closest?.('[data-action],[data-probe],[data-reload]') as HTMLElement | null;
    if (!btn || model.pending !== null) return;
    const pid = Number(btn.getAttribute('data-pid'));
    if (btn.hasAttribute('data-reload')) {
      void load();
      return;
    }
    if (!Number.isInteger(pid) || pid < 1) return; // 与路由同一道核，点击侧先拦住
    const action = btn.getAttribute('data-action');
    if (action) void runAction(action, pid);
    else if (btn.hasAttribute('data-probe')) void runProbe(pid);
  };

  host.addEventListener('click', onClick);
  void load();

  return {
    destroy() {
      dead = true;
      host.removeEventListener('click', onClick);
    },
  };
}

/**
 * 动作成功后用回带来那一条替换列表里的同 pid 行（上游 `ProcessActionResult.process` 就是最新状态），
 * 省一次整表重读；失败或找不到原行时原样留着。
 */
function mergeProcess(
  data: ProcessesModel['data'],
  action: string,
  res: ProcessActionResultShape,
): ProcessesModel['data'] {
  const list = data?.list;
  if (!Array.isArray(list) || !res?.process || res.success !== true) return data;
  if (action === 'unload') return { list: list.filter((p) => p.pid !== res.process.pid) };
  return { list: list.map((p) => (p.pid === res.process.pid ? res.process : p)) };
}

function withoutKey(errors: Record<string, string>, key: string): Record<string, string> {
  if (!(key in errors)) return errors;
  const next = { ...errors };
  delete next[key];
  return next;
}
