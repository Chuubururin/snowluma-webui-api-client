// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAnchorFromDir, COMMIT_SHA, parseCommitArg } from './build-anchor.js';
import {
  isModelSource,
  UPSTREAM_FILES,
  localPathFor,
  VENDOR_DIR,
  type Anchor,
} from './lib/upstream.js';

async function fakeUpstream(overrides: Partial<Record<string, string>> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'anchor-'));
  // 八条与 UPSTREAM_FILES 一一对应。非路由样本刻意不含 `app.<verb>(`（否则虚增注册数），
  // 但 consent.ts / client.ts **含**行首 `export interface` —— 与上游同 commit 的实际形状一致
  // （consent.ts 有 4 个 interface、client.ts 的类型来自 api/types.ts）。这样一旦有人放宽
  // isModelSource，这些样本就会冒出额外的模型键，下面的字面量断言与键集合断言同时变红。
  // 扩进来的 sse-response.ts / debug-stream.ts 是传输壳：样本无路由注册，
  // 但照上游真实形状各带一个导出 interface（sse-response.ts:8 的 SseChannel、
  // debug-stream.ts:7 的 FramePusherOptions）—— 假样本镜像真文件是它存在的唯一理由；
  // 谓词若被放宽，这两份同样会冒出额外模型键把断言打红。
  const bodies: Record<string, string> = {
    'packages/core/src/webui/server.ts': "app.get('/api/logs', (c) => c.json({}));",
    'packages/core/src/webui/storage-routes.ts': "app.get('/api/system/storage', (c) => c.json({}));",
    'packages/core/src/webui/consent.ts': 'export interface ConsentRecord {}\nconst ok = true;\n',
    'packages/core/src/webui/sse-response.ts':
      'export interface SseChannel {}\nexport function sseResponse(): void {}\n',
    'packages/core/src/webui/debug-stream.ts':
      'export interface FramePusherOptions {}\nexport function createFramePusher(): void {}\n',
    'packages/webui/src/types.ts': 'export interface A {}\nexport type B = 1;',
    'packages/webui/src/lib/api/types.ts': 'export interface C {}',
    'packages/webui/src/lib/api/client.ts':
      'export interface ApiClient {}\nconst base = "/api";\nexport { base };\n',
    // Go 批次的 21 份读侧构造点样本：全部刻意不含 `app.<verb>(`（路由只活在
    // server.ts / storage-routes.ts，否则 expectedRouteRegistrations 虚增）。两份真实的
    // types.ts（bridge / onebot）照上游形状各带一个行首 export interface —— 与
    // consent.ts 同理，谓词一旦被放宽，这两份会冒出额外模型键把键集合断言打红；
    // 其余文件给单函数样本（构造点是函数，不是路由注册表）。
    'packages/bridge/src/hook-manager.ts':
      'export class HookManager {}\n',
    'packages/bridge/src/types.ts':
      'export interface HookProcessInfo {}\nexport type HookProcessStatus = "available";\n',
    'packages/bridge/src/injector.ts':
      'export interface HookProcessBaseInfo {}\nexport function listHookProcesses(): unknown[] { return []; }\n',
    'packages/common/src/logger.ts':
      'export function getRecentLogs(): unknown[] { return []; }\nexport function getLogLevel(): string { return "info"; }\n',
    'packages/common/src/log-file-transport.ts':
      'export function getLogStorageStatus(): unknown { return {}; }\n',
    'packages/common/src/runtime.ts':
      'export function readRuntimeConfig(): unknown { return {}; }\nexport function resolveRuntimeEnvOverrides(): string[] { return []; }\n',
    'packages/onebot/src/config.ts':
      'export function loadOneBotConfig(): unknown { return {}; }\n',
    'packages/onebot/src/global-config.ts':
      'export function loadGlobalSettings(): unknown { return {}; }\n',
    'packages/onebot/src/manager.ts':
      'export class OneBotManager {}\nexport interface AccountConnections {}\n',
    'packages/onebot/src/instance.ts':
      'export class OneBotInstance { readonly uin = ""; }\n',
    'packages/onebot/src/action-docs.ts':
      'export function collectActionDocs(): unknown[] { return []; }\nexport function collectCategories(): unknown[] { return []; }\n',
    'packages/onebot/src/stream-storage.ts':
      'export function snapshotStreamStorage(): unknown { return {}; }\n',
    'packages/onebot/src/types.ts':
      'export interface OneBotConfig {}\nexport type JsonObject = Record<string, unknown>;\n',
    'packages/core/src/webui/update-check.ts':
      'export async function getUpdateInfo(): Promise<unknown> { return {}; }\nexport function currentVersion(): string { return "0.0.0"; }\n',
    'packages/core/src/webui/ui-config.ts':
      'export function loadUiConfig(): unknown { return {}; }\nexport function publicAppearance(): unknown { return {}; }\n',
    'packages/core/src/webui/log-export.ts':
      'export function buildFullTraceDownload(): { headers: Record<string, string>; body: string } { return { headers: {}, body: "" }; }\n',
    'packages/core/src/webui/auth.ts':
      'export class WebuiAuth { totpStatus(): { enabled: false } | { enabled: true; remainingRecoveryCodes: number; label: string } { return { enabled: false }; } }\n',
    'packages/core/src/webui/storage-management.ts':
      'export class StorageManagementService {}\nexport interface StorageSnapshot {}\n',
    'packages/core/src/webui/storage-settings.ts':
      'export class LogStorageSettingsManager {}\nexport interface LogStorageSettings {}\n',
    'packages/core/src/notifications/config.ts':
      'export function loadNotificationsConfig(): unknown { return {}; }\n',
    'packages/core/src/notifications/manager.ts':
      'export class NotificationManager {}\nexport interface DeliveryRecord {}\n',
    // rest-generation B4：totp.ts（N26 写侧断言）。helper 模块：无 app.<verb>( 注册，
    // 非 webui/src/ 路径故非模型源；样本给函数形，与真实文件一致。
    'packages/core/src/webui/totp.ts':
      'export function beginTotpEnrollment(): unknown { return {}; }\nexport function confirmTotpEnrollment(): unknown { return {}; }\nexport function regenerateRecoveryCodes(): unknown { return {}; }\n',
    // 客户端 demo 重做（设计口径的 Tier A 升级）：16 份真 WebUI 前端组件/路由。
    // 判据是 parity 表与放弃清单**正面引用了它们**（file:line），按 N26 同一条：被正面断言的文件
    // 必须进清单，否则那些行号就是"假缓存外句"——无人能核对，升级时也不会变红。
    // 样本按真实形状给 React 函数组件：无 `app.<verb>(`（不虚增注册数）、
    // 文件名不是 types.ts（isModelSource 挡在筛外，不冒模型键）。
    'packages/webui/src/router/index.tsx': 'export function AppRouter() { return null; }\n',
    'packages/webui/src/router/app-layout.tsx': 'export function AppLayout() { return null; }\n',
    'packages/webui/src/components/layout/sidebar.tsx': 'export function Sidebar() { return null; }\n',
    'packages/webui/src/components/layout/top-bar.tsx': 'export function TopBar() { return null; }\n',
    'packages/webui/src/components/pages/login-page.tsx': 'export function LoginPage() { return null; }\n',
    'packages/webui/src/components/pages/onboarding-wizard-page.tsx':
      'export function OnboardingWizardPage() { return null; }\n',
    'packages/webui/src/components/pages/change-password-form.tsx':
      'export function ChangePasswordForm() { return null; }\n',
    'packages/webui/src/components/pages/status-screens.tsx': 'export function StatusScreens() { return null; }\n',
    'packages/webui/src/components/pages/overview-page.tsx': 'export function OverviewPage() { return null; }\n',
    'packages/webui/src/components/pages/dashboard-grid.tsx': 'export function DashboardGrid() { return null; }\n',
    'packages/webui/src/components/pages/widget-config-forms.tsx':
      'export function WidgetConfigForms() { return null; }\n',
    'packages/webui/src/components/pages/processes-page.tsx': 'export function ProcessesPage() { return null; }\n',
    'packages/webui/src/components/pages/config-page.tsx': 'export function ConfigPage() { return null; }\n',
    'packages/webui/src/components/pages/logs-page.tsx': 'export function LogsPage() { return null; }\n',
    'packages/webui/src/components/pages/settings-page.tsx': 'export function SettingsPage() { return null; }\n',
    'packages/webui/src/components/pages/debug-page.tsx': 'export function DebugPage() { return null; }\n',
    // rest-generation B5：qq-port-probe.ts（N26，probe-login 的 info 形状）。同上 helper；
    // 真实文件导出 QqPortLoginInfo 接口，样本照形状给（谓词只认 webui/src/ 路径，此处 core/bridge 方向不匹配，不会冒模型键）。
    'packages/bridge/src/qq-port-probe.ts':
      'export interface QqPortLoginInfo {}\nexport function probeQqLoginInfo(): unknown { return null; }\n',
  };
  for (const p of UPSTREAM_FILES) {
    const body = overrides[p] ?? bodies[p];
    // 样本表漏一条就会写出 undefined 并崩——这里显式说明成因，免得被当成断言故障。
    if (body === undefined) throw new Error(`fakeUpstream 缺样本：${p}`);
    const local = localPathFor(p, dir);
    // localPathFor 保留仓库层级，父目录不存在，必须先递归 mkdir，否则 ENOENT
    await mkdir(dirname(local), { recursive: true });
    await writeFile(local, body, 'utf8');
  }
  return dir;
}

describe('buildAnchorFromDir', () => {
  it('记录 commit、每个文件的 64 位 sha256 与字节数', async () => {
    const dir = await fakeUpstream();
    const anchor = await buildAnchorFromDir('deadbeef', dir);
    expect(anchor.commit).toBe('deadbeef');
    // 30 = UPSTREAM_FILES 全量：2 路由 + 2 类型 + client.ts + consent.ts + SSE 传输壳两份
    // + Go 批次拉进来的 21 份读侧构造点 + rest-generation B4 的 totp.ts
    //（无一份含路由注册或承载领域模型）。
    // 写死字面量而不是 UPSTREAM_FILES.length：后者会让"新增文件却没人注意到锚点变了形状"
    // 这件事静默通过。
    expect(anchor.files).toHaveLength(47);
    for (const f of anchor.files) {
      expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(f.bytes).toBeGreaterThan(0);
    }
  });

  it('从缓存计算出注册数、API 操作数与分文件模型数', async () => {
    const dir = await fakeUpstream();
    const anchor = await buildAnchorFromDir('c0ffee', dir);
    expect(anchor.expectedRouteRegistrations).toBe(2);
    expect(anchor.expectedApiOperations).toBe(2);
    // 仍然是**两个键**（不是 8）：isModelSource 只放过 webui/src/ 下以 types.ts 结尾的两份。
    expect(anchor.expectedModels).toEqual({
      'packages/webui/src/types.ts': 2,
      'packages/webui/src/lib/api/types.ts': 1,
    });
  });

  // expectedModels 的键集合必须恰好等于 UPSTREAM_FILES 里过 isModelSource 的那批 ——
  // 不是等于 UPSTREAM_FILES 全体（8 个文件里只有 2 个承载领域模型）。
  // 这条防的是：将来有人新增一个 `.../types.ts`，锚点默默记下它的 hash，但没人把它
  // 的模型数写进期望，于是漂移检查对它有眼睛却看不见数。
  it('锚点建模的集合恰好是过筛的那批，新增的两份只留 hash', async () => {
    const dir = await fakeUpstream();
    const anchor = await buildAnchorFromDir('c0ffee', dir);
    expect(Object.keys(anchor.expectedModels).sort()).toEqual(
      [...UPSTREAM_FILES].filter(isModelSource).sort(),
    );
    expect(anchor.files.length).toBe(UPSTREAM_FILES.length);
    // 反方向也要咬人：client.ts / consent.ts 在 files 里（被锚定），但不在 expectedModels 里。
    for (const repoPath of [
      'packages/core/src/webui/consent.ts',
      'packages/webui/src/lib/api/client.ts',
    ]) {
      expect(anchor.files.map((f) => f.repoPath)).toContain(repoPath);
      expect(anchor.expectedModels).not.toHaveProperty(repoPath);
    }
  });

  it('本地缓存（拉取，不重新联网）产出设计口径的基线数', async () => {
    // 用真实基线 SHA 而非 'main'：纯函数对 commit 只做标签透传，但测试也不该反过来
    // 把"分支名当 commit"固化成期望（终审 I2 要消灭的正是这种写法）。
    const anchor = await buildAnchorFromDir(
      '1ef9a2c33023b5fcb400865c8281d2dfd190540b',
      'vendor/upstream',
    );
    // 59/55 在文件从 4 变 6、再从 6 变 8 后**不变**：consent.ts / client.ts 与扩进的
    // sse-response.ts / debug-stream.ts 里都没有 `app.<verb>(` 注册（实测 0 处）。
    // 真值来自 build-anchor.ts 对八文件缓存的实际输出。
    expect(anchor.expectedRouteRegistrations).toBe(59);
    expect(anchor.expectedApiOperations).toBe(55);
    expect(anchor.expectedModels['packages/webui/src/types.ts']).toBe(76);
    expect(anchor.expectedModels['packages/webui/src/lib/api/types.ts']).toBe(19);
    // 八份全部带 hash；expectedModels 只有两条（同上）。
    // 21 份新文件同样只留 hash（均不过 isModelSource），锚定面 8 → 29；
    // rest-generation B4 再加 totp.ts 一份 → 30（同样只留 hash）；
    // B5 再加 qq-port-probe.ts 一份 → 31（同上）。
    expect(anchor.files).toHaveLength(47);
    expect(Object.keys(anchor.expectedModels)).toHaveLength(2);
  });

  // Go 批次实现批次：读侧 18 条操作的构造点散在缓存外的模块里（N26 逐端点枚举，每份文件
  // 「哪个端点的哪个字段靠它」的台账见本任务报告）。net-new 21 份，锚定面 8 → 29。
  // 这份清单是 Go 批次全部 schema 派生批（实现批次）的证据资格：不在 anchor.files 里
  // 的文件，spec 不得对它做的输出下正面断言。
  const NEW_FILES = [
    'packages/bridge/src/hook-manager.ts',
    'packages/bridge/src/types.ts',
    'packages/bridge/src/injector.ts',
    'packages/common/src/logger.ts',
    'packages/common/src/log-file-transport.ts',
    'packages/common/src/runtime.ts',
    'packages/onebot/src/config.ts',
    'packages/onebot/src/global-config.ts',
    'packages/onebot/src/manager.ts',
    'packages/onebot/src/instance.ts',
    'packages/onebot/src/action-docs.ts',
    'packages/onebot/src/stream-storage.ts',
    'packages/onebot/src/types.ts',
    'packages/core/src/webui/update-check.ts',
    'packages/core/src/webui/ui-config.ts',
    'packages/core/src/webui/log-export.ts',
    'packages/core/src/webui/auth.ts',
    'packages/core/src/webui/storage-management.ts',
    'packages/core/src/webui/storage-settings.ts',
    'packages/core/src/notifications/config.ts',
    'packages/core/src/notifications/manager.ts',
  ];

  it('新纳入的读侧模块同时出现在 anchor.files 与 expectedModels 里', async () => {
    expect(NEW_FILES.length).toBeGreaterThan(0); // 防空数组假绿
    // 字面量 SHA：COMMIT_SHA 是 RegExp 校验器（build-anchor.ts:24），不是哈希串。
    const anchor = await buildAnchorFromDir('1ef9a2c33023b5fcb400865c8281d2dfd190540b', VENDOR_DIR);
    for (const f of NEW_FILES) {
      expect(anchor.files.map((x) => x.repoPath)).toContain(f);
      // 只在 isModelSource 判定为模型源的文件上要求 expectedModels 键。本批 21 份全部
      // 不在 packages/webui/src/ 下 ⇒ 谓词一致地豁免，expectedModels 键集合仍是两份
      // （inventory 的 grouped-by-file 严格相等断言因此不需要再生 models.json）。
      if (isModelSource(f)) expect(Object.keys(anchor.expectedModels)).toContain(f);
    }
  });
});

// 上面四条用例只测"函数如何算"，测不到"仓库里那个文件是什么"。
// 少了这一条，谁跑一次 `build-anchor.ts main`（默认值就是分支名）都能把可变 ref
// 悄悄写回 spec/anchor.json 而全绿通过。只钉 commit 的形状这一个属性：
// 不做整份工件与 fresh 计算的相等比较，因为 fetchedAt 会让它永久变红，
// 内容层面的比对属于实现批次。
describe('spec/anchor.json 提交物', () => {
  // 相对本测试文件定位，不依赖 vitest 的 CWD。
  const anchorPath = fileURLToPath(new URL('../spec/anchor.json', import.meta.url));

  it('commit 记录解析后的 40 位小写 SHA，不接受分支名', async () => {
    const committed = JSON.parse(await readFile(anchorPath, 'utf8')) as Anchor;
    expect(committed.commit).toMatch(/^[0-9a-f]{40}$/);
  });
});

// 终审 I2：上面那条是"事后检查"（写坏了再由测试变红），下面是"事前预防"。
// 旧 CLI 写 `process.argv[2] ?? 'main'`，而 buildAnchorFromDir **从不 fetch**（只把 vendor
// 里现有字节重新哈希），于是"忘了传参"会产出一份哈希与当前缓存**必然相符**、commit 却只是
// 无人核验的标签的锚点——照旧补救文案做一次就能把 R21 要拦的陈旧锚点重新合法化。
// 参数契约抽成导出的纯函数（沿用 blocksExit 的做法：本项目的 CLI 分支不做单测）。
describe('parseCommitArg（设计口径的 40 位 SHA 由事后检查改为事前拦截）', () => {
  const SHA = '1ef9a2c33023b5fcb400865c8281d2dfd190540b';

  it('唯一合法输入是 40 位小写十六进制，原样返回', () => {
    expect(parseCommitArg(SHA)).toBe(SHA);
  });

  it('缺参数报错，不再隐式回落成分支名', () => {
    expect(() => parseCommitArg(undefined)).toThrow(/未提供 commit/);
    expect(() => parseCommitArg(undefined)).toThrow(/40 位/);
  });

  it('分支名与一切非"40 位小写十六进制"的形状一律拒绝', () => {
    for (const bad of [
      '',
      'main',
      'master',
      'HEAD',
      'refs/heads/main',
      SHA.slice(0, 7), // 短 SHA（git 接受，锚点不接受：可复现性要的是全 SHA）
      SHA.toUpperCase(), // 锚点的书写规范是小写，不做静默归一
      `${SHA} `,
      `x${SHA.slice(1)}`,
    ]) {
      expect(() => parseCommitArg(bad)).toThrow(/40 位/);
    }
  });

  it('报错文案给出可照做的取值方法，而不是只说非法', () => {
    expect(() => parseCommitArg('main')).toThrow(/不接受分支名/);
  });

  it('CLI 段确实走 parseCommitArg，且不再残留隐式默认值', async () => {
    const src = await readFile(new URL('./build-anchor.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/process\.argv\[2\]\s*\?\?/);
    expect(src).toMatch(/parseCommitArg\(process\.argv\[2\]/);
  });
});

// 终审 I2 的收口项：契约为什么必须落在**两个边界**而不是纯函数里。
describe('COMMIT_SHA 的执法位置（纯函数刻意不管形状）', () => {
  const SHA = '1ef9a2c33023b5fcb400865c8281d2dfd190540b';

  it('纯形状判据：只认 40 位小写十六进制，且无 /g 因而 .test 无状态可复用', () => {
    expect(COMMIT_SHA.test(SHA)).toBe(true);
    expect(COMMIT_SHA.test('main')).toBe(false);
    // 带 /g 的正则会在两次 .test 之间移动 lastIndex —— 同一合法输入可能第二次判 false。
    expect(COMMIT_SHA.global).toBe(false);
    expect(COMMIT_SHA.test(SHA)).toBe(true);
  });

  it('buildAnchorFromDir 仍接受任意 commit 标签 ⇒ 每个调用方都得自己把关', async () => {
    // 刻意不把这个"收紧"做进纯函数：它同时被测试用作临时目录的形状探针，且锚点形状归边界管
    // 更符合本项目的分工（纯函数只算哈希）。代价就是**每个**边界都得查——这条测试钉住两侧都查了。
    const anchor = await buildAnchorFromDir('anything-at-all', 'vendor/upstream');
    expect(anchor.commit).toBe('anything-at-all');

    const build = await readFile(new URL('./build-anchor.ts', import.meta.url), 'utf8');
    const drift = await readFile(new URL('./check-drift.ts', import.meta.url), 'utf8');
    expect(build).toMatch(/COMMIT_SHA\.test\(raw\)/); // 写侧
    expect(drift).toMatch(/COMMIT_SHA\.test\(anchor\.commit\)/); // 读侧
  });
});
