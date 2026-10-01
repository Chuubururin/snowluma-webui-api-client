// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
/**
 * 客户端入口：外壳 + 门禁屏。门禁未过时主界面根本不渲染（设计口径"不得先进主界面再补"），
 * 六条操作面板（总览/进程/配置/日志/设置/调试）由逐块接进 `#main`。
 */
import { call, onGateSignal, post } from './api.js';
import { esc, section } from './ui.js';
import type { GateModel } from './pages/gate.js';
import { mountGate } from './pages/gate.js';
import { mountOverview, type OverviewSnapshot } from './pages/overview.js';
import { mountProcesses } from './pages/processes.js';
import { mountConfig } from './pages/config.js';
import { mountLogs } from './pages/logs.js';
import { mountSettings } from './pages/settings.js';
import { mountDebug } from './pages/debug.js';

document.getElementById('root')!.innerHTML =
  '<h1>SnowLuma 轻量客户端</h1>' +
  '<div id="target"></div>' +
  '<div id="appearance">外观摘要：加载中…</div>' +
  '<div id="gate"><p>门禁屏：加载中…</p></div>' +
  '<div id="main" hidden></div>';

interface BaseUrlInfo {
  baseUrl: string;
}
interface AppearanceInfo {
  ok: boolean;
  data?: { appearance?: Record<string, any> };
  message?: string;
}

/**
 * 目标实例行：读出当前值，并给一个改它的入口。
 *
 * 为什么归壳层而不是门禁屏：`#target` 在 `#gate`/`#main` 之外，门禁未过时也要看得见连的是哪台 ——
 * 而"连错了台"恰恰是还没过闸时最需要能改的一刻。换目标在服务端与 token 同进同退
 * （`upstream.ts` 的 `setBaseUrl`），响应带 `step:'login'`，`api.ts` 的 `reportGate` 会把外壳折回
 * 门禁屏；这一屏由门禁屏自己画，这里不重复画一份。
 */
function renderTarget(baseUrl: string): void {
  section(
    'target',
    () =>
      '<div>目标实例：<code>' +
      esc(baseUrl) +
      '</code></div>' +
      '<form id="targetForm"><div class="row">' +
      '<label for="targetInput">换目标实例</label>' +
      '<input id="targetInput" name="baseUrl" type="text" value="' +
      esc(baseUrl) +
      '" />' +
      '</div>' +
      '<p id="targetMsg" class="hint" role="status"></p>' +
      '<button id="targetSubmit" type="submit">切换</button></form>',
  );
  document.getElementById('targetForm')?.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const input = document.getElementById('targetInput') as HTMLInputElement;
    const btn = document.getElementById('targetSubmit') as HTMLButtonElement;
    const msg = document.getElementById('targetMsg');
    btn.disabled = true;
    if (msg) msg.textContent = '正在切换…';
    post<BaseUrlInfo>('/set-base-url', { baseUrl: input.value.trim() })
      .then((r) => {
        // 整段重画而不是只改 `<code>`：输入框里留着的还是上一台的地址，只改文本就是拿旧值冒充当前。
        renderTarget(r.baseUrl);
        readAppearance(); // 外观摘要读的是刚才那一台，换完不重读就会把别台的设置挂在屏上
      })
      .catch((e: Error) => {
        btn.disabled = false;
        if (msg) msg.textContent = '切换失败：' + e.message;
      });
  });
}

call<BaseUrlInfo>('/base-url')
  .then((j) => renderTarget(j.baseUrl))
  .catch((e: Error) => section('target', () => '<span class="err">' + esc(e.message) + '</span>'));

// 登录前免 bearer 的外观读取：demo 只把它**读出来给人看**（确认连的是哪台），不套主题变量
// （declination public-appearance-render）。
function readAppearance(): void {
  call<AppearanceInfo>('/appearance')
    .then((j) => {
      if (!j.ok) {
        section('appearance', () => '<span class="err">外观读取失败：' + esc(j.message ?? '') + '</span>');
        return;
      }
      const a = j.data?.appearance ?? {};
      const rows: Array<[string, unknown]> = [
        ['主题模式', a.mode],
        ['强调色', a.accentPreset],
        ['密度', a.density],
        ['缩放', a.uiScale],
        ['背景', a.background?.type],
        ['动效', a.reduceMotion || a.disableMotion ? '已减弱/关闭' : '默认'],
      ];
      section(
        'appearance',
        () =>
          '<details id="appearance" open><summary>实例公开外观（仅展示，demo 不套主题）</summary><dl>' +
          rows.map(([k, v]) => '<dt>' + esc(k) + '</dt><dd>' + esc(String(v ?? '—')) + '</dd>').join('') +
          '</dl></details>',
      );
    })
    .catch((e: Error) => section('appearance', () => '<span class="err">' + esc(e.message) + '</span>'));
}

readAppearance();

const gateHost = document.getElementById('gate')!;
const mainHost = document.getElementById('main')!;

function showGate(): void {
  mainHost.hidden = true;
  gateHost.hidden = false;
  mountGate(gateHost, enterApp);
}

/** 过了两道闸才画主界面外壳；面板内容按逐块填。 */
function enterApp(model: GateModel): void {
  gateHost.hidden = true;
  mainHost.hidden = false;
  // 过闸回调可能跑第二次（登录成功后门禁屏还会重读一次权威状态）。这里把 #main 整块重画，
  // #panel 随之换成全新节点，而 showPanel 对"同名已挂"是早退的 —— 不早退就得先把 currentPanel
  // 作废，否则第二次进来就是一屏外壳配一片空白（真浏览器走查抓到的就是这个）。
  currentPanel?.handle.destroy();
  currentPanel = null;
  section('main', () => mainShell(model));
  showPanel(location.hash.replace(/^#/, '') || 'overview');
}

/**
 * 已建好的面板 → 挂载函数。没在这张表里的 tab 只显示"由后续任务接入"，
 * 不放一个能点的空壳控件：控件存在但什么都不做，比没有控件更难查（设计口径那一类缺陷的近亲）。
 */
type PanelHandle = { destroy(): void };
const PANEL_MOUNTS: Record<string, (host: HTMLElement) => PanelHandle> = {
  overview: (host) => mountOverview(host, { onSnapshot: paintSessionBar }),
  processes: mountProcesses,
  config: mountConfig,
  logs: mountLogs,
  settings: mountSettings,
  debug: mountDebug,
};

let currentPanel: { name: string; handle: PanelHandle } | null = null;

function showPanel(name: string): void {
  const host = document.getElementById('panel');
  if (!host) return;
  if (currentPanel?.name === name) return; // 重复点同一个 tab 不重挂、不重复起轮询
  currentPanel?.handle.destroy();
  for (const a of document.querySelectorAll('#tabs [data-panel]')) {
    a.classList.toggle('active', a.getAttribute('data-panel') === name);
  }
  const mount = PANEL_MOUNTS[name];
  if (!mount) {
    currentPanel = null;
    host.innerHTML = '<p id="panelPending">「' + esc(name) + '」面板由后续任务接入。</p>';
    return;
  }
  host.innerHTML = '';
  currentPanel = { name, handle: mount(host) };
}

function mainShell(model: GateModel): string {
  // /api/status 线上只有 `{status:'running'}` 一个键（spec StatusInfo，实码 server.ts:1031）。
  // 实例版本与运行时长**不在这份响应里**：版本读 `UpdateCheckResult.current`、
  // 运行秒数读 `SystemInfo.processUptime`，两者都由总览页的 GET /overview 带回（见 paintSessionBar）。
  const status = (model.status ?? {}) as { status?: string };
  return (
    '<div id="sessionBar"><span>会话已建立 · 实例状态 <code id="instanceStatus">' +
    esc(status.status ?? '未知') +
    '</code> · 实例版本 <code id="sessionVersion">还没读到</code> · 本进程已运行 <code id="sessionUptime">还没读到</code></span>' +
    '<button id="logoutButton" type="button">登出</button></div>' +
    '<nav id="tabs">' +
    ['overview', 'processes', 'config', 'logs', 'settings', 'debug']
      .map((p) => '<a href="#' + p + '" data-panel="' + p + '">' + p + '</a>')
      .join('') +
    '</nav>' +
    '<div id="panel"></div>'
  );
}

/**
 * 总览页每读到一次首屏/轮询就回调这里：外壳那几个数字必须是真读到的，
 * 读不到就明写"还没读到"——上一版在这里留了"—"占位，看起来像数据、其实是空的（浏览器复验抓到的缺陷）。
 */
function paintSessionBar(s: OverviewSnapshot): void {
  const version = document.getElementById('sessionVersion');
  if (version) version.textContent = s.version ? s.version : '还没读到';
  const uptime = document.getElementById('sessionUptime');
  if (uptime) uptime.textContent = typeof s.processUptimeSeconds === 'number' ? `${s.processUptimeSeconds} 秒` : '还没读到';
  const inst = document.getElementById('instanceStatus');
  if (inst && s.instanceStatus) inst.textContent = s.instanceStatus;
}

showGate();

/**
 * 面板读到门禁信号就交回门禁屏：`api.ts` 是所有面板调用的必经处，那里的 `step` 只在这里判定去留。
 * 面板自己不决定该停在哪一屏 —— `mountGate` 会重读一次权威状态，再决定画同意/改密/登录哪一屏。
 * 已在门禁屏时不重挂，否则门禁屏自己那几次读会把它反复重启。
 */
onGateSignal(() => {
  if (mainHost.hidden) return;
  // 面板必须一起销毁：留着它的轮询就会不停撞同一道闸，把刚展出来的门禁屏再顶回去
  currentPanel?.handle.destroy();
  currentPanel = null;
  showGate();
});

document.getElementById('root')!.addEventListener('click', (e) => {
  // 主界面外壳在门禁通过后才存在，故事件委托挂 #root；closest 让点在按钮内的文字上也算命中
  const target = e.target as HTMLElement | null;
  const btn = target?.closest?.('#logoutButton') as HTMLButtonElement | null;
  if (btn) {
    btn.disabled = true;
    post('/logout', {})
      .then(() => {
        currentPanel?.handle.destroy();
        currentPanel = null;
        gateHost.innerHTML = '<p>已登出。</p>';
        showGate();
      })
      .catch(() => {
        // 错误被吞是有意为之/待议：失败只恢复按钮、不向用户呈现原因 —— 登记在此，待议后再补提示。
        btn.disabled = false;
      });
    return;
  }
  const tab = target?.closest?.('#tabs [data-panel]') as HTMLAnchorElement | null;
  if (tab) {
    e.preventDefault();
    navigateTo(tab.getAttribute('data-panel') as string);
  }
});

/**
 * 地址与面板同进同退：点标签与后退键/手改地址栏走同一条路。少了 hashchange 监听，
 * 后退就只是把地址改回去、界面纹丝不动，而深链进来那一次（enterApp 读 hash）会让人以为路由做好了。
 */
function navigateTo(name: string): void {
  if (location.hash !== '#' + name) location.hash = name;
  showPanel(name);
}

window.addEventListener('hashchange', () => {
  navigateTo(location.hash.replace(/^#/, '') || 'overview');
});
