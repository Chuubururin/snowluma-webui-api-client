// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
/**
 * 调试页：动作目录 + 动态参数表单 + 透传调用 + 原始字节上传，外加留给的流式格子。
 *
 * 四条界面规矩直接来自 spec（与 task-11-addendum.md 一一对应）：
 * 1. **`readOnly` 是安全信息**：非只读动作第一次点击只出确认层、零请求，第二次点击才上行。
 *    这个端点接受任意 OneBot action（发消息、改群、封成员），"点一下就执行"不是可接受的形状。
 * 2. **`stream:true` 的动作不在 REST 这条路**：目录里出现它就说明该走流式页，点了也不出网。
 * 3. **动作层的成败看 `status`，不看 HTTP 码**：200 里可以是 `{status:'failed', message}`，
 *    页面显示的就是那句 message；demo 不产出"调用成功"这种把两层混起来的结论。
 * 4. **参数只有 `name/type/required/desc/values/role`**（`default` 上游是 unknown）：
 *    有 `values` 出下拉、`type:number` 出数字框，但**绝不拿 default 预填** —— 预填会让一次
 *    没被人类看过的值进入一个会改业务状态的调用。原始返回体只进折叠区，不做裸 JSON dump。
 */
import { ApiError, call, emitGateSignal, post } from '../api.js';
import { openStream, type ParsedFrame, type StreamHandle } from '../state.js';
import { esc, section } from '../ui.js';

export const DEBUG_CONTROLS = [
  'debugUinSelect',
  'debugActionList',
  'debugParamForm',
  'invokeButton',
  'invokeConfirmButton',
  'traceUploadPicker',
  'debugStreamFeed',
] as const;
export type DebugControlName = (typeof DEBUG_CONTROLS)[number];

export interface DebugParam {
  name: string;
  type: string;
  required: boolean;
  desc?: string;
  values?: (string | number)[];
  role?: string;
}

export interface DebugAction {
  name: string;
  aliases?: string[];
  category?: string;
  summary?: string;
  returns?: string;
  readOnly: boolean;
  stream?: boolean;
  invariants?: string[];
  params: DebugParam[];
}

export interface DebugCatalog {
  actions: DebugAction[];
  categories: Array<{ category: string; count: number }>;
}

export interface DebugAccount {
  uin: string;
  nickname: string | null;
}

export interface DebugModel {
  /** null = 那条读没成功或还没到；空数组是"读到了但目录是空的"，两者措辞必须不同。 */
  catalog: DebugCatalog | null;
  accounts: DebugAccount[] | null;
  selected: string | null;
  result: any;
  invokeError: string | null;
  /** 非只读动作等的那声"确认"；null 表示当前没有待确认的调用。 */
  pendingConfirm: string | null;
  pickedFile: { name: string; dataUrl: string } | null;
  uploadResult: any;
  uploadError: string | null;
  /** debugStreamFeed 那一格的数据源：全局事件流 + 当前那条动作流（一枪一条，换动作就关旧的）。 */
  stream: { status: string; frames: string[]; action: string | null };
  notices: Partial<Record<DebugControlName, string>>;
  errors: Partial<Record<DebugControlName, string>>;
  busy: Partial<Record<DebugControlName, boolean>>;
}

/** 账号那条读的形状：spec 的 QqList 是 `{list:[{uin, nickname?}]}`，uin 上游给的是数字。 */
function toAccounts(raw: any): DebugAccount[] {
  const list = Array.isArray(raw?.list) ? raw.list : [];
  return list.map((a: any) => ({ uin: String(a?.uin ?? ''), nickname: typeof a?.nickname === 'string' ? a.nickname : null }));
}

/** 参数值的种类：number 走数字框（空串不能当 0），boolean 走勾选，其余按文本。 */
/** 参数名是上游给的任意字符串 ⇒ 进 id 前收进 [A-Za-z0-9_-]，否则 `label[for]` 与 querySelector 都会失真。 */
function paramId(name: string): string {
  return 'param_' + name.replace(/[^A-Za-z0-9_-]/g, '_');
}

function paramInput(p: DebugParam, value: string): string {
  const id = `data-param="${esc(p.name)}" id="${paramId(p.name)}"`;
  const req = p.required ? ' <span class="tag">必填</span>' : '';
  const desc = p.desc ? '<span class="hint">' + esc(p.desc) + '</span>' : '';
  const head = `<label for="${paramId(p.name)}">` + esc(p.name) + req + desc + '</label>';
  if (Array.isArray(p.values) && p.values.length > 0) {
    const opts = ['', ...p.values.map((v) => String(v))]
      .map((v) => `<option value="${esc(v)}"${v === value ? ' selected' : ''}>${v === '' ? '（不给）' : esc(v)}</option>`)
      .join('');
    return `<div class="field">${head}<select ${id}>${opts}</select></div>`;
  }
  if (p.type === 'boolean') {
    return `<div class="field">${head}<input type="checkbox" ${id}${value === 'true' ? ' checked' : ''}></div>`;
  }
  if (p.type === 'number') {
    return `<div class="field">${head}<input type="number" ${id} value="${esc(value)}"></div>`;
  }
  // 未知类型不静默丢字段：出一个文本框并把上游给的 type 原样写出来，人类看得见"这里没建模"
  return (
    `<div class="field">${head}<input type="text" ${id} value="${esc(value)}">` +
    `<span class="hint">上游类型 <code>${esc(p.type)}</code>：demo 没按它收窄，值原样上行</span></div>`
  );
}

/**
 * 单个参数的表单块。抽成导出函数是为了让"未知 type 仍出框"与"不预填 default"这两条
 * 能被纯函数用例钉住（不必整套挂载）。
 */
export function renderParamForm(p: DebugParam, state: { value: string }): string {
  return paramInput(p, state.value ?? '');
}

function actionRow(a: DebugAction, selected: boolean): string {
  const tags: string[] = [];
  tags.push(a.readOnly === true ? '<span class="tag ok">只读</span>' : '<span class="tag warn">会改状态</span>');
  if (a.stream === true) tags.push('<span class="tag">流式（走流式页）</span>');
  return (
    `<li><button type="button" data-action="${esc(a.name)}" class="${selected ? 'active' : ''}">` +
    `<code>${esc(a.name)}</code>${a.summary ? ' ' + esc(a.summary) : ''}` +
    ` ${tags.join(' ')}</button></li>`
  );
}

/** 目录 + 分类计数条。计数取自 `categories`（上游给的那份），不是自己数 actions。 */
export function renderActionList(m: DebugModel): string {
  if (!m.catalog) {
    return (
      '<h3>动作目录</h3>' +
      (m.errors.debugActionList ? '<div class="err">' + esc(m.errors.debugActionList) + '</div>' : '<p class="muted">还没读到动作目录。</p>')
    );
  }
  const cats = m.catalog.categories
    .map((c) => `<span class="tag">${esc(c.category)} ${esc(String(c.count))}</span>`)
    .join(' ');
  const byCat = new Map<string, DebugAction[]>();
  for (const a of m.catalog.actions) {
    // 上游可能不给 category（spec 里它是可选）⇒ 明写"未给分类"而不是兜一个 'misc'：
    // 兜底会把"读错键"与"这个动作真没分类"混成同一句话。
    const key = typeof a.category === 'string' ? a.category : '未给分类';
    (byCat.get(key) ?? byCat.set(key, []).get(key)!).push(a);
  }
  const groups = [...byCat.entries()]
    .map(
      ([cat, list]) =>
        '<h4>' + esc(cat) + '</h4><ul>' + list.map((a) => actionRow(a, a.name === m.selected)).join('') + '</ul>',
    )
    .join('');
  return (
    '<h3>动作目录</h3><p class="hint">分类计数来自上游的 categories 清单（不是本页面自己数的）：</p>' +
    `<p>${cats || '上游没给分类'}</p>` +
    groups +
    (m.busy.debugActionList ? '<p class="muted">读取中…</p>' : '')
  );
}

/** 返回体的结构化视图：键名可见，原始 JSON 只进折叠区（"消除原始配置暴露"同一条裁定）。 */
function dataView(v: unknown, depth = 0): string {
  if (v === null || v === undefined) return '<code>null</code>';
  if (typeof v !== 'object') return '<code>' + esc(String(v)) + '</code>';
  if (Array.isArray(v)) {
    if (v.length === 0) return '<em>空数组</em>';
    return '<ul>' + v.map((x) => '<li>' + dataView(x, depth + 1) + '</li>').join('') + '</ul>';
  }
  const entries = Object.entries(v as Record<string, unknown>);
  if (entries.length === 0) return '<em>空对象</em>';
  return (
    '<dl>' +
    entries
      .map(([k, val]) => '<dt>' + esc(k) + '</dt><dd>' + dataView(val, depth + 1) + '</dd>')
      .join('') +
    '</dl>'
  );
}

/**
 * invoke 的结果视图。`DebugInvokeResult` 只有 `status` 是 required
 * （`:840-850`），其余四键都可能没给 ⇒ 给了才写，没给就在末尾一句里点名，
 * 而不是留一个空的 "retcode：" 让人以为是 0。
 */
export function renderInvokeResult(result: any, m: DebugModel): string {
  const head = '<h3>调用结果</h3>';
  if (m.invokeError) return head + '<div class="err">' + esc(m.invokeError) + '</div>';
  if (!result || typeof result !== 'object') return head + '<p class="muted">还没有调用过。选一个动作、把必填参数给齐，再点"执行"。</p>';
  const status = String(result.status ?? '（上游没给 status）');
  const tone = status === 'ok' ? 'ok' : status === 'async' ? '' : 'err';
  const absent = ['retcode', 'data', 'message', 'wording'].filter((k) => result[k] === undefined);
  return (
    head +
    `<p>动作层状态 <code class="${tone}">${esc(status)}</code></p>` +
    (result.retcode !== undefined ? '<p>retcode <code>' + esc(String(result.retcode)) + '</code></p>' : '') +
    (typeof result.message === 'string' ? '<p>' + esc(result.message) + '</p>' : '') +
    (typeof result.wording === 'string' ? '<p class="hint">措辞：' + esc(result.wording) + '</p>' : '') +
    (result.data !== undefined
      ? // 折叠区必须是块级容器：`<p>` 里放 `<details>` 会被解析器当场关掉 p，details 跑到兄弟位，
        // 于是"原文在折叠里"这条断言看着绿、其实查的那个节点里什么都没有（happy-dom 与浏览器同形）
        '<p>返回数据（结构化）：</p>' +
        dataView(result.data) +
        '<div id="debugInvokeRaw">原始返回体：<details><summary>展开 JSON 原文</summary>' +
        `<code>${esc(JSON.stringify(result.data))}</code></details></div>`
      : '') +
    (absent.length ? '<p class="muted">这次上游没给：' + esc(absent.join('、')) + '。</p>' : '') +
    '<p class="hint">"HTTP 200"与"动作成功"是两件事：上面这行读的是响应体里的 <code>status</code>。</p>'
  );
}

function uploadView(m: DebugModel): string {
  const disabled = m.pickedFile ? '' : ' disabled';
  const picked = m.pickedFile
    ? '<p class="hint">已选：<code>' + esc(m.pickedFile.name) + '</code>（按原始字节上行，不是 multipart）</p>'
    : '<p class="muted">还没选文件</p>';
  const r = m.uploadResult;
  const done =
    r && typeof r === 'object'
      ? '<p class="ok">已落盘：' +
        '<code>' +
        esc(String(r.path ?? '（上游没给 path）')) +
        '</code> · ' +
        esc(r.size === undefined ? 'size 上游没给' : String(r.size)) +
        (r.size === undefined ? '' : ' 字节') +
        '</p>'
      : '';
  return (
    '<h3>上传文件（原始字节流）</h3>' +
    (m.errors.traceUploadPicker ? '<div class="err">' + esc(m.errors.traceUploadPicker) + '</div>' : '') +
    picked +
    '<p><label for="debugFile">选择要上传的文件</label><input type="file" id="debugFile" data-debug-file></p>' +
    `<p><button type="button" data-debug-upload${disabled}>上传这份文件</button></p>` +
    (m.busy.traceUploadPicker ? '<p class="muted">上传中…</p>' : '') +
    done +
    '<p class="hint">文件名走 <code>?filename=</code>（上游把请求体当字节流读，不解析 multipart）；' +
    '这条是 T3：demo 不自动重试，失败了请人类看清楚再决定要不要再来一次。</p>'
  );
}

function confirmView(m: DebugModel): string {
  if (!m.pendingConfirm) {
    return '<h4>二次确认</h4><p class="muted">当前没有待确认的调用。</p>';
  }
  return (
    '<h4>二次确认</h4>' +
    `<p class="warn">动作 <code>${esc(m.pendingConfirm)}</code> 在上游目录里标的是<b>会改业务状态</b>：` +
    '它会经透传打到所选账号的真实 OneBot 实例。确认后才发这一枪。</p>' +
    '<p><button type="button" data-invoke-confirm>确认执行这一次</button></p>'
  );
}

function paramFormView(m: DebugModel): string {
  const a = m.catalog?.actions.find((x) => x.name === m.selected) ?? null;
  const err = m.errors.debugParamForm ? '<div class="err">' + esc(m.errors.debugParamForm) + '</div>' : '';
  if (!a) {
    return '<h3>参数</h3>' + err + '<p class="muted">先在左边选一个动作，这里才按它的参数清单出控件。</p>';
  }
  if (a.params.length === 0) {
    return '<h3>参数</h3>' + err + `<p class="muted">动作 <code>${esc(a.name)}</code> 在目录里没声明参数（params 是空清单）。</p>`;
  }
  return (
    '<h3>参数</h3>' +
    err +
    a.params.map((p) => renderParamForm(p, { value: '' })).join('') +
    '<p class="hint">必填的参数没给就不会出网；上游声明了 <code>default</code> 的参数也不预填 —— ' +
    '那等于让人类没看过的值进一次会改状态的调用。</p>'
  );
}

function uinView(m: DebugModel): string {
  if (m.errors.debugUinSelect) {
    return '<h3>目标账号（uin）</h3><div class="err">' + esc(m.errors.debugUinSelect) + '</div>';
  }
  if (!m.accounts) return '<h3>目标账号（uin）</h3><p class="muted">还没读到账号列表。</p>';
  if (m.accounts.length === 0) return '<h3>目标账号（uin）</h3><p class="muted">账号列表是空的。</p>';
  return (
    '<h3>目标账号（uin）</h3>' +
    '<p><label for="debugUin">要打到哪个账号</label><select id="debugUin" data-ctl-inner="uin">' +
    m.accounts
      .map((a) => `<option value="${esc(a.uin)}">${esc(a.nickname ? a.uin + ' · ' + a.nickname : a.uin)}</option>`)
      .join('') +
    '</select></p>' +
    '<p class="hint">选出来的仍是字符串，服务端按上游那条 pattern（5-10 位数字）再核一次 —— 选择器不是安全边界。</p>'
  );
}

function invokeView(m: DebugModel): string {
  const a = m.catalog?.actions.find((x) => x.name === m.selected) ?? null;
  const note = m.notices.invokeButton ? '<p class="warn">' + esc(m.notices.invokeButton) + '</p>' : '';
  return (
    renderInvokeResult(m.result, m) +
    note +
    (a
      ? `<p><button type="button" data-invoke${m.busy.invokeButton ? ' disabled' : ''}>执行 ${esc(a.name)}</button></p>`
      : '<p><button type="button" data-invoke disabled>执行</button></p>') +
    (m.busy.invokeButton ? '<p class="muted">执行中…（T3：不自动重试）</p>' : '')
  );
}

export const MAX_STREAM_FRAMES = 30;

/** 一帧怎么印：有标签的写标签与关键键；invoke-stream 那种"内键不断言"的写原文键名。谁都不许变成空白。 */
export function frameLine(f: ParsedFrame): string {
  if (f.kind === 'event') {
    const ev = (f.event ?? {}) as Record<string, unknown>;
    return (
      '事件 uin=' +
      String(f.uin ?? '（上游没给）') +
      ' post_type=' +
      String(ev.post_type ?? '（无）') +
      ' 键=' +
      Object.keys(ev).sort().join(',')
    );
  }
  if (f.kind === 'action') {
    const rest = Object.keys(f).filter((k) => k !== 'kind' && k !== 'uin').sort();
    return '动作实况 uin=' + String(f.uin ?? '（上游没给）') + (rest.length ? ' 键=' + rest.join(',') : '');
  }
  if (f.kind === 'dropped') return '丢了 ' + String(f.count ?? '（上游没给数字）') + ' 帧：这一格只做加法，不宣称自己是全量';
  if (f.kind === 'ready') return '就绪';
  if (f.kind === 'unparsable') return '读不懂的一帧：' + String(f.raw ?? '').slice(0, 60);
  if (f.kind === 'unlabeled') return '没有标签的一帧：' + String(f.raw ?? '').slice(0, 60);
  return f.kind + '：' + JSON.stringify(f).slice(0, 70);
}

function feedView(m: DebugModel): string {
  return (
    '<h3>流式事件与流式调用</h3>' +
    '<p>推流状态：<span id="debugStreamStatus">' +
    esc(m.stream.status) +
    '</span>' +
    (m.stream.action ? ' · 正在跟的动作流：<code>' + esc(m.stream.action) + '</code>' : '') +
    '</p>' +
    (m.notices.debugStreamFeed ? '<p class="hint">' + esc(m.notices.debugStreamFeed) + '</p>' : '') +
    '<ul id="debugStreamFrames">' +
    m.stream.frames.map((l) => '<li>' + esc(l) + '</li>').join('') +
    '</ul>' +
    '<p class="hint">两条流各走各的：<code>streamDebugEvents</code> 是本面板一挂载就订的全局事件流，' +
    '<code>streamDebugAction</code> 只在点了标 <code>stream</code> 的那个动作那一枪才开。' +
    '两者都不经 REST 那条 <code>/debug-invoke</code>。</p>'
  );
}

export function renderControl(name: DebugControlName, m: DebugModel): string {
  switch (name) {
    case 'debugUinSelect':
      return uinView(m);
    case 'debugActionList':
      return renderActionList(m);
    case 'debugParamForm':
      return paramFormView(m);
    case 'invokeButton':
      return invokeView(m);
    case 'invokeConfirmButton':
      return confirmView(m);
    case 'traceUploadPicker':
      return uploadView(m);
    case 'debugStreamFeed':
      return feedView(m);
  }
}

const EMPTY: DebugModel = {
  catalog: null,
  accounts: null,
  selected: null,
  result: null,
  invokeError: null,
  pendingConfirm: null,
  pickedFile: null,
  uploadResult: null,
  uploadError: null,
  notices: {},
  errors: {},
  busy: {},
  stream: { status: '连流中…', frames: [], action: null },
};

function errText(e: unknown): string {
  if (e instanceof ApiError) return `${e.status} ${e.message}`;
  return (e as Error)?.message ?? String(e);
}

/** 目录里这个动作的声明；找不到就说找不到，不猜参数形状。 */
function actionOf(m: DebugModel): DebugAction | null {
  return m.catalog?.actions.find((x) => x.name === m.selected) ?? null;
}

export function mountDebug(host: HTMLElement): { destroy(): void } {
  let model: DebugModel = { ...EMPTY };
  let dead = false;
  /**
   * 参数表单里人类已经打过的值：重绘会把输入框建回空值，所以按参数名留一份。
   * 只在**同一个动作**内保留（换动作就是另一套参数清单，留着旧值就是把上一次的输入混进这一次）。
   */
  let paramValues = new Map<string, string>();

  let eventStream: StreamHandle | null = null;
  let actionStream: StreamHandle | null = null;

  const pushFrame = (line: string, status?: string, action?: string | null): void => {
    model = {
      ...model,
      stream: {
        status: status ?? model.stream.status,
        frames: [line, ...model.stream.frames].slice(0, MAX_STREAM_FRAMES),
        action: action === undefined ? model.stream.action : action,
      },
    };
  };

  const streamCallbacks = (label: string, action?: string | null) => ({
    onFrame: (fr: ParsedFrame) => {
      if (dead) return;
      pushFrame('[' + label + '] ' + frameLine(fr), undefined, action);
      repaint('debugStreamFeed');
    },
    onStatus: (s: 'open' | 'reconnecting' | 'error' | 'closed') => {
      if (dead) return;
      model = {
        ...model,
        stream: {
          ...model.stream,
          status: s === 'open' ? '已连上' : s === 'closed' ? '已关闭' : s === 'error' ? '连接出错，准备重拨' : '重连中',
        },
      };
      repaint('debugStreamFeed');
    },
    onSessionExpired: (message: string) => {
      if (dead) return;
      emitGateSignal('login', message);
    },
  });

  const repaint = (...names: DebugControlName[]) => {
    for (const n of names) section('sec_' + n, () => renderControl(n, model));
  };
  const paintAll = () => {
    host.innerHTML =
      '<h2>调试</h2>' +
      DEBUG_CONTROLS.map((n) => `<section data-ctl="${n}" id="sec_${n}">${renderControl(n, model)}</section>`).join('');
  };
  paintAll();

  const read = async (key: 'catalog' | 'accounts', path: string, who: DebugControlName) => {
    model = { ...model, busy: { ...model.busy, [who]: true } };
    repaint(who);
    try {
      const r = await call<any>(path);
      if (dead) return;
      model = {
        ...model,
        [key]: key === 'catalog' ? r?.data ?? null : toAccounts(r?.data),
        errors: { ...model.errors, [who]: undefined },
        busy: { ...model.busy, [who]: false },
      };
    } catch (e) {
      if (dead) return;
      model = { ...model, errors: { ...model.errors, [who]: errText(e) }, busy: { ...model.busy, [who]: false } };
    }
    repaint(who);
  };

  /** 把当前表单里的值收进 paramValues，并拆成必填缺失与待上行的 params 两份。 */
  const collectParams = (a: DebugAction): { missing: string[]; params: Record<string, unknown> } => {
    const params: Record<string, unknown> = {};
    const missing: string[] = [];
    for (const p of a.params) {
      const el = host.querySelector(`[data-param="${p.name}"]`) as HTMLInputElement | HTMLSelectElement | null;
      if (!el) continue;
      const raw =
        el instanceof HTMLInputElement && el.type === 'checkbox' ? (el.checked ? 'true' : '') : String(el.value ?? '');
      if (raw !== '') paramValues.set(p.name, raw);
      if (raw === '') {
        if (p.required) missing.push(p.name);
        continue; // 没填的键不上行：拿 0 或空串顶上去就是发明
      }
      params[p.name] = p.type === 'number' ? Number(raw) : p.type === 'boolean' ? raw === 'true' : raw;
    }
    return { missing, params };
  };

  const uinOf = (): string => {
    const el = host.querySelector('[data-ctl-inner="uin"]') as HTMLSelectElement | null;
    return String(el?.value ?? model.accounts?.[0]?.uin ?? '');
  };

  const doInvoke = async (a: DebugAction, params: Record<string, unknown>) => {
    model = { ...model, busy: { ...model.busy, invokeButton: true }, pendingConfirm: null, invokeError: null };
    repaint('invokeButton', 'invokeConfirmButton');
    try {
      const body: Record<string, unknown> = { uin: uinOf(), action: a.name };
      if (Object.keys(params).length > 0) body.params = params;
      const r = await post<any>('/debug-invoke', body);
      if (dead) return;
      model = { ...model, result: r?.data ?? null, busy: { ...model.busy, invokeButton: false } };
    } catch (e) {
      if (dead) return;
      // 失败信封与业务 4xx 的 message 都交回原样显示；这一屏不许把"被拒"改写成"成功"
      model = { ...model, invokeError: errText(e), result: (e as ApiError)?.body ?? null, busy: { ...model.busy, invokeButton: false } };
    }
    paramValues = new Map();
    repaint('invokeButton', 'invokeConfirmButton');
  };

  const onInvoke = () => {
    const a = actionOf(model);
    if (!a) {
      model = { ...model, notices: { ...model.notices, invokeButton: '先选一个动作。' }, result: null, invokeError: null };
      repaint('invokeButton');
      return;
    }
    const { missing, params } = collectParams(a);
    if (missing.length > 0) {
      model = {
        ...model,
        errors: { ...model.errors, debugParamForm: '必填的参数还没给：' + missing.join('、') + '。带着空值出网就是把发明交给上游。' },
      };
      repaint('debugParamForm');
      return;
    }
    if (a.readOnly !== true) {
      // 非只读 ⇒ 第一枪只出确认层：请求一次都不发（含 stream 动作——T3 纪律不分 REST/流）
      model = { ...model, pendingConfirm: a.name, notices: { ...model.notices, invokeButton: undefined } };
      repaint('invokeConfirmButton', 'invokeButton');
      return;
    }
    if (a.stream === true) {
      // 目录里标了 stream ⇒ REST 那条路一发就只会拿到不该拿到的形状；这一枪交给动作流，帧印在下面那一格。
      // 一枪一条：换动作先关上一条，不留悬挂的动作流。
      actionStream?.close();
      const body: Record<string, unknown> = { uin: uinOf(), action: a.name };
      if (Object.keys(params).length > 0) body.params = params;
      model = {
        ...model,
        result: null,
        invokeError: null,
        notices: { ...model.notices, invokeButton: '这条标了 stream：REST 那条没发，已改开动作流，帧在下面那一格。' },
      };
      pushFrame('开流动作 ' + a.name, undefined, a.name);
      actionStream = openStream('action', streamCallbacks(a.name, a.name), { body });
      repaint('invokeButton', 'debugStreamFeed');
      return;
    }
    void doInvoke(a, params);
  };

  const onUpload = async () => {
    const picked = model.pickedFile;
    if (!picked) return;
    model = { ...model, busy: { ...model.busy, traceUploadPicker: true }, uploadError: null, uploadResult: null };
    repaint('traceUploadPicker');
    try {
      const r = await post<any>('/debug-upload', { filename: picked.name, dataUrl: picked.dataUrl });
      if (dead) return;
      model = { ...model, uploadResult: r?.data ?? null, pickedFile: null, busy: { ...model.busy, traceUploadPicker: false } };
    } catch (e) {
      if (dead) return;
      model = { ...model, uploadError: errText(e), errors: { ...model.errors, traceUploadPicker: errText(e) }, busy: { ...model.busy, traceUploadPicker: false } };
    }
    repaint('traceUploadPicker');
  };

  const onFile = (input: HTMLInputElement) => {
    const file = input.files?.[0];
    if (!file) {
      model = { ...model, pickedFile: null };
      repaint('traceUploadPicker');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (dead) return;
      model = {
        ...model,
        pickedFile: { name: file.name, dataUrl: String(reader.result ?? '') },
        errors: { ...model.errors, traceUploadPicker: undefined },
      };
      repaint('traceUploadPicker');
    };
    reader.onerror = () => {
      if (dead) return;
      model = { ...model, errors: { ...model.errors, traceUploadPicker: '这份文件读不出来：' + String(reader.error?.message ?? '浏览器拒绝了这次读取') } };
      repaint('traceUploadPicker');
    };
    reader.readAsDataURL(file);
  };

  const onClick = (e: MouseEvent) => {
    if (dead) return;
    const t = (e.target as HTMLElement)?.closest?.('[data-action],[data-invoke],[data-invoke-confirm],[data-debug-upload]') as HTMLElement | null;
    if (!t) return;
    if (t.hasAttribute('data-action')) {
      const name = t.getAttribute('data-action') as string;
      paramValues = new Map();
      model = { ...model, selected: name, result: null, invokeError: null, pendingConfirm: null, notices: { ...model.notices, invokeButton: undefined }, errors: { ...model.errors, debugParamForm: undefined } };
      repaint('debugActionList', 'debugParamForm', 'invokeButton', 'invokeConfirmButton');
      return;
    }
    if (t.hasAttribute('data-invoke')) {
      onInvoke();
      return;
    }
    if (t.hasAttribute('data-invoke-confirm')) {
      const a = actionOf(model);
      if (!a || model.pendingConfirm !== a.name) return;
      const { missing, params } = collectParams(a);
      if (missing.length > 0) {
        model = { ...model, errors: { ...model.errors, debugParamForm: '必填的参数还没给：' + missing.join('、') } };
        repaint('debugParamForm', 'invokeConfirmButton');
        return;
      }
      void doInvoke(a, params);
      return;
    }
    if (t.hasAttribute('data-debug-upload')) void onUpload();
  };

  const onChange = (e: Event) => {
    if (dead) return;
    const el = e.target as HTMLInputElement | null;
    if (el?.type === 'file' && el.hasAttribute('data-debug-file')) onFile(el);
  };

  host.addEventListener('click', onClick as EventListener);
  host.addEventListener('change', onChange as EventListener);
  eventStream = openStream('debug', streamCallbacks('事件'));

  void read('catalog', '/debug-actions', 'debugActionList');
  void read('accounts', '/config/accounts', 'debugUinSelect');

  return {
    destroy() {
      dead = true;
      eventStream?.close();
      eventStream = null;
      actionStream?.close();
      actionStream = null;
      host.removeEventListener('click', onClick as EventListener);
      host.removeEventListener('change', onChange as EventListener);
    },
  };
}
