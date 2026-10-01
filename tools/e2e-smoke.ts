// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
/**
 * 浏览器 E2E smoke：真 Chromium 驱动真 demo 服务端，上游换成一台形状全部按 spec 的假实例。
 *
 * 这一层专门抓 L1–L3 结构上够不着的东西：CSS 是否真的解析（P1「所有 class 悬空」只在浏览器里
 * 现形）、2xx 是否真的被浏览器侧丢掉、控制台是否安静。假上游的每一个键都是从 L2 各域的
 * 健康夹具表抄下来的契约断言，不是随手编的占位；口令是明写的假常量，真实例不可达
 * （假上游只认这一个常量，且全程 127.0.0.1）。
 *
 * 只进 `npm run e2e:smoke`，不进 `verify-all.ts` 的 GATES：链的门禁面跑在 CI 冷克隆里，
 * 而浏览器腿依赖本机安装的真实 Chrome（playwright-core 只带协议，不带浏览器二进制），
 * 把它挂进 GATES 等于让 CI 的 OS 矩阵为一个「烟雾」付浏览器安装的账。收口标准与 GATES
 * 一致：任一断言红 ⇒ 退出码 1。
 */
import { mkdirSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { chromium, type Page } from 'playwright-core';
import { buildHandler } from '../demo/server/index.js';
import { collectRoutes } from '../demo/server/start.js';
import { createUpstream } from '../demo/server/upstream.js';
import { blockedPortHint, isFetchBlockedPort } from './lib/port-probe.js';

// —— 假上游的契约面（形状逐键抄自 L2 各域健康夹具；改 spec 时这里会跟着 drift 红）——
const FAKE_PASSWORD = 'pw-e2e-只认这个常量';
const FAKE_TOKEN = 'TK-e2e';
const LEVELS = ['trace', 'debug', 'info', 'success', 'warn', 'error'];

const SYSTEM = {
  hostname: 'host-a', platform: 'linux', arch: 'x64', archLabel: 'x86_64',
  release: '6.1.0-amd64', distro: 'Debian GNU/Linux 12',
  uptime: 123_456, processUptime: 3_456, nodeVersion: 'v22.1.0',
  cpu: { model: 'EPYC', cores: 8, speedMHz: 2400, loadAvg: [0.1, 0.2, 0.3], perCore: [10, 20], average: 12.5 },
  memory: { total: 16_000_000_000, free: 8_000_000_000, used: 8_000_000_000, usagePercent: 50 },
  runtime: { pid: 4242, rss: 100, heapTotal: 200, heapUsed: 300, external: 400, arrayBuffers: 500 },
};
const QQ_LIST = { list: [{ uin: '10001', nickname: '夹具小号' }] };
const CONNECTIONS = {
  list: [
    {
      uin: '10001', nickname: '夹具小号',
      adapters: [
        { name: 'http-server', kind: 'httpServer', status: 'ok', detail: '监听 :3000' },
        { name: 'ws-client', kind: 'wsClient', status: 'down', detail: '连接断开', lastError: 'ECONNRESET', lastErrorAt: 1_767_000_000 },
      ],
    },
  ],
};
const PROCESSES = {
  list: [
    {
      pid: 1234, name: 'QQ-N.exe', path: 'C:/QQ/QQ.exe', injected: true, connected: true,
      loggedIn: true, uin: '10001', status: 'online', error: '', method: 'loadModuleManual',
    },
  ],
};
const UPDATE = {
  current: '1.14.20', latest: null, hasUpdate: false, htmlUrl: null,
  notes: null, publishedAt: null, checkedAt: 1_767_000_000_000,
};
const APPEARANCE = {
  mode: 'dark', accentMode: 'preset', accentPreset: 'snow', accentCustom: '#39b', accentScope: 'sidebar',
  darkIntensity: 'soft', palette: 'default', sidebarStyle: 'follow',
  background: { type: 'image', color: '', gradient: '', imageOpacity: 0.5, imageBlur: 0, hasImage: true, imageMime: 'image/png', imageVersion: 3 },
  fontSans: 'system', fontSansCustom: '', fontMono: 'mono', fontMonoCustom: '',
  uiScale: 1, radius: 8, density: 'cozy', reduceMotion: false, disableMotion: false,
  customPointerSystem: false, customContextMenu: false, highContrast: false, sidebarPinned: true,
  timeFormat: '24h', pollInterval: 5000, customCss: '', cssVars: {},
};
const UI_CONFIG = {
  config: {
    version: 7,
    appearance: APPEARANCE,
    layout: { overviewBlocks: [{ id: 'status', visible: true }], overviewMobile: [], navItems: [{ id: 'overview', visible: true }], topbarItems: [] },
    pages: {
      defaultRoute: 'overview', processesSort: 'uin', configTab: 'onebot',
      logs: { visibleLevels: ['info'], maxLines: 500, autoScroll: true, wrap: false, highlightRules: [], preset: 'dev' },
    },
  },
};
const LOG_ENTRY = {
  id: 7, time: '2026-09-28T10:00:00.000Z', level: 'warn', scope: 'onebot', uin: 10001,
  message: '心跳超时-E2E', line: '2026-09-28T10:00:00.000Z WARN  [onebot] 心跳超时-E2E',
};
const GLOBAL_CONFIG = { config: { rkey: { fallbackServers: [] }, musicSignUrl: '' } };
const NOTIFY_CONFIG = {
  config: {
    version: 3, debounceSeconds: 30,
    channels: [{ id: 'c1', name: '运维群-E2E', type: 'webhook', url: 'https://example/hook', bodyTemplate: '{text}', enabled: true }],
  },
};
const NOTIFY_RECENT = { recent: [{ time: 1_767_000_000_000, uin: '10001', event: 'online', channelId: 'c1', ok: true, status: 200 }] };
const ONEBOT = {
  config: {
    networks: {
      httpServers: [{ name: 's1', messageFormat: 'array', reportSelfMessage: false, port: 3000 }],
      httpClients: [],
      wsServers: [{ name: 'w1', messageFormat: 'array', reportSelfMessage: false, port: 3001, role: 'Universal' }],
      wsClients: [],
    },
    statusCommand: { enabled: true, swallow: false, cooldownSeconds: 60, trigger: '#sl' },
    historySync: { enabled: false },
    notifications: { channelIds: ['c1'] },
  },
};
const SYSTEM_SETTINGS = {
  settings: { webuiPort: 5099, webuiHost: '0.0.0.0', tlsEnabled: false, trustProxy: 'false' },
  hasCert: false, envOverrides: [], listeningPort: 5099, restartRequiredToApply: false,
};
const STORAGE = {
  settings: {
    saved: { logMaxTotalMb: 200, logRetainDays: 7, logPerUin: true },
    effective: { logMaxTotalMb: 200, logRetainDays: 7, logPerUin: true },
    envOverrides: [],
  },
  snapshot: {
    logs: {
      state: 'healthy', totalBytes: 100, maxTotalBytes: 200, retainDays: 7, perUinEnabled: true,
      fileCount: 2, activeFileCount: 1, droppedLines: 0,
    },
    temporary: { totalBytes: 50, fileCount: 3, activeItemCount: 1 },
    accounts: [{ uin: '10001', online: true, messagesBytes: 1, mediaBytes: 2, reactionsBytes: 3, totalBytes: 6, nickname: '夹具小号' }],
    totals: { logsBytes: 100, temporaryBytes: 50, accountDataBytes: 6, managedBytes: 156 },
  },
  lastCleanup: null,
};
const TOTP = { enabled: true, remainingRecoveryCodes: 2, label: 'SnowLuma-E2E:admin' };
const DEBUG_ACTIONS = {
  actions: [
    {
      name: 'get_group_list-E2E', aliases: ['ggl'], category: 'group', summary: '取群列表',
      readOnly: true, stream: false,
      params: [{ name: 'group_id', type: 'number', required: false, desc: '群号', values: [1, 2], role: 'group' }],
    },
  ],
  categories: [{ category: 'group', count: 12 }],
};

const JSON_BODIES: Record<string, unknown> = {
  '/api/status': { status: 'running' },
  '/api/system': SYSTEM,
  '/api/qq-list': QQ_LIST,
  '/api/connections': CONNECTIONS,
  '/api/processes': PROCESSES,
  '/api/update/check': UPDATE,
  '/api/ui': UI_CONFIG,
  '/api/ui/public': { appearance: { mode: 'dark', accentPreset: 'blue', density: 'compact', uiScale: 1, background: { type: 'none' }, reduceMotion: false, disableMotion: false } },
  '/api/agreements': { version: 'e2e-v1', consentRequired: false, documents: [] },
  '/api/auth/state': { mustChangePassword: false },
  '/api/logs': { list: [LOG_ENTRY] },
  '/api/logs/level': { level: 'info', levels: LEVELS },
  '/api/global-config': GLOBAL_CONFIG,
  '/api/notifications/config': NOTIFY_CONFIG,
  '/api/notifications/recent': NOTIFY_RECENT,
  '/api/config/10001': ONEBOT,
  '/api/system/settings': SYSTEM_SETTINGS,
  '/api/system/storage': STORAGE,
  '/api/auth/totp': TOTP,
  '/api/debug/actions': DEBUG_ACTIONS,
};
const SSE_PATHS = new Set(['/api/state/stream', '/api/logs/stream', '/api/debug/stream']);
// 三条流统一先出 `{kind:'ready'}`：state/logs 的 onFrame 认这一支（"已连上"），
// debug 的 frameLine 对任何帧都只是转述文本 —— 三条都安全，且都满足"建流即出字节"（D2 那课）。
const SSE_READY_FRAME = { kind: 'ready' };

function makeFakeUpstream(): Server {
  return createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0] as string;
    const auth = String(req.headers.authorization ?? '');
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const send = (status: number, body: unknown) =>
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(body));
      if (path === '/api/login') {
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
        if (body.password === FAKE_PASSWORD) {
          return send(200, { success: true, token: FAKE_TOKEN, mustChangePassword: false });
        }
        return send(401, { success: false, message: '密码错误（假上游只认脚本里的假常量）' });
      }
      if (path === '/api/logout') {
        return send(200, { success: true });
      }
      if (auth !== `Bearer ${FAKE_TOKEN}`) {
        return send(401, { status: 'failed', message: 'Token expired or invalid' });
      }
      if (SSE_PATHS.has(path)) {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        res.write(`data: ${JSON.stringify(SSE_READY_FRAME)}\n\n`);
        // 建流后保持连接但不再出帧：walkthrough 全程 <60s，客户端 15s×2 的心跳判据
        // 只在 state 流上挂着——demo 服务端自己对浏览器发 `: ping`，这里不需要装活。
        req.on('close', () => res.destroy());
        return;
      }
      if (path in JSON_BODIES) return send(200, JSON_BODIES[path]);
      return send(404, { success: false, message: `E2E 假上游没有 ${req.method} ${path} 这条` });
    });
  });
}

async function listenOnFetchablePort(server: Server): Promise<number> {
  // 与 tools/demo-stream-live.test.ts 的 listen() 同判据：bad-port 端口 bind 得成、
  // 但 fetch 在连接前就拒（tools/lib/port-probe.ts）。测试里重试 8 次，脚本里给到 12。
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    server.removeAllListeners('error');
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const got = (server.address() as { port: number }).port;
    if (!(await isFetchBlockedPort(got))) return got;
    server.closeAllConnections?.();
    await new Promise<void>((r) => server.close(() => r()));
  }
  throw new Error(`连续 12 次 listen(0) 都拿到 fetch 拦掉的端口。${blockedPortHint(0)}`);
}

const closeDown = async (s: Server) => {
  s.closeAllConnections?.();
  await new Promise<void>((r) => s.close(() => r()));
};

// —— 走查与断言 ——
const failures: string[] = [];
const checks: string[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  (ok ? checks : failures).push(`${name}${detail ? ` —— ${detail}` : ''}`);
}

function attachWatchers(page: Page) {
  const consoleErrors: string[] = [];
  // 登录前的 /gate/state 与 /appearance 按设计就是 401 —— 客户端把「401 无 step」读成
  // 「还没登录」这一信号本身（spec 与 gates 的可达形状），浏览器控制台必然留下
  // "Failed to load resource"。只放行这两条路径的 401；同路径任何其它状态码仍然算红。
  const EXPECTED_401 = new Set(['/gate/state', '/appearance']);
  const isExpected401Resource = (m: { text(): string; location(): { url: string } }) => {
    if (!m.text().startsWith('Failed to load resource')) return false;
    try {
      return EXPECTED_401.has(new URL(m.location().url).pathname) && m.text().includes('401');
    } catch {
      return false;
    }
  };
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (isExpected401Resource(m)) return;
    if (m.text().includes('favicon')) return;
    consoleErrors.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
  page.on('requestfailed', (r) => {
    const text = r.failure()?.errorText ?? '';
    // 面板切换会 abort 上一条 SSE —— 那是客户端状态机的正常收线，不是网络故障。
    if (text.includes('ERR_ABORTED')) return;
    consoleErrors.push(`requestfailed: ${r.url()} ${text}`);
  });
  page.on('response', (r) => {
    const url = new URL(r.url());
    if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') return;
    if (url.pathname.includes('favicon')) return;
    if (r.status() === 401 && EXPECTED_401.has(url.pathname)) return;
    if (r.status() >= 400) consoleErrors.push(`http ${r.status()} ${url.pathname}`);
  });
  return consoleErrors;
}

async function main(): Promise<void> {
  const up = makeFakeUpstream();
  const upPort = await listenOnFetchablePort(up);
  const u = createUpstream(`http://127.0.0.1:${upPort}`);
  const demo = createServer(buildHandler(collectRoutes(), u));
  const demoPort = await listenOnFetchablePort(demo);
  const base = `http://127.0.0.1:${demoPort}`;
  mkdirSync('.e2e-smoke', { recursive: true });

  // 本机 Chrome 走 playwright-core 的 channel 通道：只带 CDP 协议，不带浏览器二进制，
  // 装不了也不该装 CI 的依赖在这里出现。找不到浏览器 = 设施故障，直接抛，不折成「通过」。
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  let consoleErrors: string[] = [];
  try {
    const page = await browser.newPage();
    consoleErrors = attachWatchers(page);

    await page.goto(`${base}/`, { waitUntil: 'load' });
    await page.waitForSelector('#loginForm', { state: 'visible', timeout: 8000 });
    check('门禁屏渲染出登录表单', true);
    await page.screenshot({ path: '.e2e-smoke/01-gate-login.png' });

    // CSS 这一组是 P1 回归位：样式表必须真的被浏览器吃下（跨域读不到 cssRules 的排除在外）。
    const css = await page.evaluate(() => {
      let rules = 0;
      for (const sheet of Array.from(document.styleSheets)) {
        try {
          rules += sheet.cssRules.length;
        } catch {
          rules += -1;
        }
      }
      return {
        rules,
        token: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(),
        bodyBg: getComputedStyle(document.body).backgroundColor,
      };
    });
    // 514 行 styles.css 在浏览器里解出 72 条规则（实测）；门槛取 50，抓的是
    // 「样式表根本没被加载/整段没解析」这类形状，不做逐条镜像（那是 demo-styles 的活）。
    check('styles.css 被解析（规则数 ≥ 50）', css.rules >= 50, `rules=${String(css.rules)}`);
    check(':root --bg 解析成 styles.css 的字面值', css.token === '#f6f7f9', `token=${css.token}`);
    check('body 背景真的落色（var 求值）', css.bodyBg === 'rgb(246, 247, 249)', `bg=${css.bodyBg}`);

    await page.fill('#password', FAKE_PASSWORD);
    await page.click('#loginSubmit');
    await page.waitForSelector('#tabs', { state: 'visible', timeout: 10_000 });
    check('登录后进主界面（#tabs 出现）', true);

    const panels: Array<[string, string]> = [
      ['overview', 'host-a'],
      ['processes', 'QQ-N.exe'],
      ['config', 'Universal'],
      ['logs', '心跳超时-E2E'],
      ['settings', 'SnowLuma-E2E:admin'],
      ['debug', 'get_group_list-E2E'],
    ];
    for (const [name, marker] of panels) {
      await page.click(`#tabs [data-panel="${name}"]`);
      let text = '';
      try {
        await page.waitForFunction(
          (m: string) => (document.getElementById('panel')?.innerText ?? '').includes(m),
          marker,
          { timeout: 10_000 },
        );
        text = marker;
      } catch {
        text = await page.evaluate(() => document.getElementById('panel')?.innerText.slice(0, 120) ?? '(空)');
      }
      check(`面板 ${name} 渲染出上游数据（标记「${marker}」）`, text === marker, text === marker ? '' : `实得 ${text}`);
      const pending = await page.evaluate(() => Boolean(document.getElementById('panelPending')));
      check(`面板 ${name} 不是「后续任务接入」占位`, !pending);
      await page.screenshot({ path: `.e2e-smoke/02-panel-${name}.png`, fullPage: false });
    }

    await page.click('#logoutButton');
    await page.waitForSelector('#loginForm', { state: 'visible', timeout: 8000 });
    check('登出回到门禁屏（会话同进同退）', true);

    check(
      '控制台与网络全程安静（零 error/零 pageerror/零 ≥400）',
      consoleErrors.length === 0,
      consoleErrors.slice(0, 8).join(' | '),
    );
  } finally {
    await browser.close();
    await closeDown(demo);
    await closeDown(up);
  }

  for (const c of checks) console.log(`  ✓ ${c}`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  console.log(`${failures.length === 0 ? 'E2E SMOKE 全部通过 ✓' : `E2E SMOKE ${String(failures.length)} 条红`}（截图在 .e2e-smoke/）`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(`E2E SMOKE 设施故障（不当作通过，也不折成断言红）：${(e as Error).stack ?? String(e)}`);
  process.exit(1);
});
