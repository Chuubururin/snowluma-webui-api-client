// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
// 本文件的 UPSTREAM_REPO 与 UPSTREAM_FILES（八个上游路径）是**抄录的派生事实**：
// 上游改了文件位置或仓库名时，这里不会自己变红，需人工核对设计口径与 anchor。
// 新增文件必须**同时**出现在 anchor.files 与 expectedModels 的期望里，否则等于没锚定：
// anchor.files 由本数组派生（哈希会被记下），但 expectedModels 的键集合只由下面的
// isModelSource 决定——过筛外的文件有"存在"却没有"数"，漂移检查对它有眼睛却看不见数。
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const UPSTREAM_REPO = 'SnowLuma/SnowLuma';

export const UPSTREAM_FILES = [
  'packages/core/src/webui/server.ts',
  'packages/core/src/webui/storage-routes.ts',
  'packages/core/src/webui/consent.ts',
  'packages/core/src/webui/sse-response.ts',
  'packages/core/src/webui/debug-stream.ts',
  'packages/webui/src/types.ts',
  'packages/webui/src/lib/api/types.ts',
  'packages/webui/src/lib/api/client.ts',
  // ── Go 批次实现批次：读侧 18 条操作的构造点（N26 逐端点枚举，每份「哪个端点的哪个字段」
  // 的台账见任务报告；net-new 21 份，锚定面 8 → 29）。共同判据：的 spec 要对
  // 这些文件的输出下正面断言，不锚定就只能把类型写松。被点名候选里
  // system-settings.ts / totp.ts 经实测只服务写侧（POST/DELETE 处理器），按 N26 反向
  // 不收。本批没有任何一份满足 isModelSource，expectedModels 键集合不变。
  // @snowluma/bridge —— GET /api/processes 的 list[] 三级证据：
  // server.ts 的 hookManager.listProcesses() 签名 → HookProcessInfo → 其继承底座
  // HookProcessBaseInfo{pid,name,path}。
  'packages/bridge/src/hook-manager.ts',
  'packages/bridge/src/types.ts',
  'packages/bridge/src/injector.ts',
  // @snowluma/common —— logger：GET /api/logs 的 list（getRecentLogs）、GET /api/logs/level
  // 的 level/levels（getLogLevel/LOG_LEVELS）、export/trace 的 getLogSnapshot 入参；
  // log-file-transport：GET /api/system/storage 的 snapshot 内嵌日志状态（getLogStorageStatus）；
  // runtime：GET /api/system/settings 的 settings/envOverrides（readRuntimeConfig /
  // resolveRuntimeEnvOverrides → RuntimeConfig），也是 storage settings 的底座。
  'packages/common/src/logger.ts',
  'packages/common/src/log-file-transport.ts',
  'packages/common/src/runtime.ts',
  // @snowluma/onebot —— config+types：GET /api/config/:uin 的 config（loadOneBotConfig →
  // OneBotConfig 形状声明在 types.ts）；global-config：GET /api/global-config 的 config；
  // manager+instance：GET /api/qq-list 的 list[]（getInstances(): OneBotInstance[]，uin/
  // nickname 声明在 instance.ts）与 GET /api/connections 的 list（getConnectionStatuses():
  // AccountConnections[]）；action-docs：GET /api/debug/actions 的 actions/categories；
  // stream-storage：GET /api/system/storage 的 snapshot 内嵌 temporary 部分。
  'packages/onebot/src/config.ts',
  'packages/onebot/src/global-config.ts',
  'packages/onebot/src/manager.ts',
  'packages/onebot/src/instance.ts',
  'packages/onebot/src/action-docs.ts',
  'packages/onebot/src/stream-storage.ts',
  'packages/onebot/src/types.ts',
  // core/src/webui 相对构造文件 —— update-check：GET /api/update/check 整体 +
  // export/trace 的 version（currentVersion）；ui-config：GET /api/ui 的 config 与
  // GET /api/ui/public 的 appearance；log-export：GET /api/logs/export/trace 的
  // headers+body（buildFullTraceDownload）；auth：GET /api/auth/totp 的响应形状
  // （WebuiAuth.totpStatus() 内联声明的判别 union）；storage-management/settings：
  // GET /api/system/storage 的 snapshot（StorageSnapshot）与 settings（read():
  // LogStorageSettingsState）。
  'packages/core/src/webui/update-check.ts',
  'packages/core/src/webui/ui-config.ts',
  'packages/core/src/webui/log-export.ts',
  'packages/core/src/webui/auth.ts',
  'packages/core/src/webui/storage-management.ts',
  'packages/core/src/webui/storage-settings.ts',
  // core/src/notifications —— GET /api/notifications/config 的 config（loadNotificationsConfig）
  // 与 GET /api/notifications/recent 的 recent[]（getRecent(): DeliveryRecord[]）。
  'packages/core/src/notifications/config.ts',
  'packages/core/src/notifications/manager.ts',
  // rest-generation B4（N26 反向的正向应用）：POST /api/auth/totp/begin|confirm|recovery-codes
  // 的 200 断言了 beginTotpEnrollment/confirmTotpEnrollment/regenerateRecoveryCodes 的输出形状
  //（secret/otpauthUrl/recoveryCodes），裁掉它是因当时 18 条读操作确实用不到；
  // 写侧用到即必须锚定。非模型源（不在 webui/src/ 下），expectedModels 键集合不变；
  // 无 app.<verb>( 注册（helper 模块），expectedRouteRegistrations 不变——两处不断言错即红。
  'packages/core/src/webui/totp.ts',
  // rest-generation B5（同上 N26）：GET /api/processes/:pid/probe-login 的 200 断言了
  // probeProcessLoginInfo() 的返回 `QqPortLoginInfo | null`（hook-manager.ts:222 透传
  // qq-port-probe.ts 的 probeQqLoginInfo）。同理非模型源、无路由注册。
  'packages/bridge/src/qq-port-probe.ts',
  // ── 客户端 demo 重做（设计口径的 Tier A 升级）──────────────────
  // demo/parity.ts 与 demo/declinations.ts 对真 WebUI 的**前端组件**下正面断言
  //（"这个面板替 webui 的哪个面板做，出处 file:line"）。按 N26 同一条判据，被正面断言的文件
  // 必须进清单，否则那些行号就是本仓最贵的那类缺陷——"假缓存外句"：声称某事实在某文件里，
  // 而该文件既没锚定也没哈希，于是引用无法被机器核对，也就无法在升级时变红。
  // 升级前置实测：pinned commit 与本机 snowluma-live 工作树对这批 16 份逐一比过 sha256，
  // 16/16 SAME（无 DIFF），故行号读自工作树即等价于读自 pinned 内容。
  // 本批无一份承载领域模型（isModelSource 要 endsWith('types.ts')），也无一份含
  // `app.<verb>(` 路由注册（对 16 份干跑 extractRoutesFromSource 命中 0）
  // ⇒ expectedModels 键集合与 expectedRouteRegistrations 均不变，只有 files 计数变。
  'packages/webui/src/router/index.tsx',
  'packages/webui/src/router/app-layout.tsx',
  'packages/webui/src/components/layout/sidebar.tsx',
  'packages/webui/src/components/layout/top-bar.tsx',
  'packages/webui/src/components/pages/login-page.tsx',
  'packages/webui/src/components/pages/onboarding-wizard-page.tsx',
  'packages/webui/src/components/pages/change-password-form.tsx',
  'packages/webui/src/components/pages/status-screens.tsx',
  'packages/webui/src/components/pages/overview-page.tsx',
  'packages/webui/src/components/pages/dashboard-grid.tsx',
  'packages/webui/src/components/pages/widget-config-forms.tsx',
  'packages/webui/src/components/pages/processes-page.tsx',
  'packages/webui/src/components/pages/config-page.tsx',
  'packages/webui/src/components/pages/logs-page.tsx',
  'packages/webui/src/components/pages/settings-page.tsx',
  'packages/webui/src/components/pages/debug-page.tsx',
] as const;

// 实测（同一 commit）：packages/core/src/webui/consent.ts 有 4 处行首 `export interface|type`
// （EnvironmentConsent / AgreementDoc / ConsentRecord / AgreementsPayload），但它在 core/ 下、
// 记的是同意/门控状态而非 WebUI 领域模型，故**刻意不**进模型总体；
// packages/webui/src/lib/api/client.ts 有 0 处（它行首只导出 createApiClient，类型全部 import 自
// 已锚定的 packages/webui/src/lib/api/types.ts）。放宽这条谓词会静默改变 expectedModels 的键集合，
// 于是"基线"与"漂移检查"各数各的（裁定 R18），build-anchor.test.ts 的键集合断言是这里的绊线。
// 依裁定 N26 扩进来的 sse-response.ts 与 debug-stream.ts 是 SSE 的传输壳：spec 对它们
// 有正面断言（帧封装 / 心跳 / 背压丢帧）故必须锚定，但它们不承载领域模型，仍被本谓词挡在筛外。
/** 哪些缓存文件承载"可建模的领域类型"。build-anchor 与 inventory 必须共用这一条判定。 */
export const isModelSource = (repoPath: string): boolean =>
  repoPath.includes('webui/src/') && repoPath.endsWith('types.ts');

export const VENDOR_DIR = 'vendor/upstream';

export function sha256Hex(content: string | Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

export function localPathFor(repoPath: string, dir = VENDOR_DIR): string {
  return join(dir, repoPath.replace(/^packages\//, ''));
}

export async function cachedSha256For(repoPath: string, dir = VENDOR_DIR): Promise<string> {
  let buf: Buffer;
  try {
    buf = await readFile(localPathFor(repoPath, dir));
  } catch (err) {
    // 区分两种故障：未缓存（重拉有用）vs 缓存存在但读不了（重拉无用）。
    // errno 留在 cause 里供程序化判定；消息只做人类可读分流，不含文档内引用。
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    const hint =
      code === 'ENOENT' ? '：未缓存，请重新拉取' : '：缓存存在但读取失败，重新拉取无法解决';
    throw new Error(`上游文件缓存不可用 ${repoPath}${hint}`, { cause: err });
  }
  return sha256Hex(buf);
}

export interface CachedFile {
  repoPath: string;
  localPath: string;
  sha256: string;
  bytes: number;
}

export async function fetchUpstream(commit: string, dir = VENDOR_DIR): Promise<CachedFile[]> {
  const out: CachedFile[] = [];
  for (const repoPath of UPSTREAM_FILES) {
    const url = `https://raw.githubusercontent.com/${UPSTREAM_REPO}/${commit}/${repoPath}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`拉取失败 ${res.status} ${url}`);
    const body = new Uint8Array(await res.arrayBuffer());
    const local = localPathFor(repoPath, dir);
    await mkdir(dirname(local), { recursive: true });
    await writeFile(local, body);
    out.push({ repoPath, localPath: local, sha256: sha256Hex(body), bytes: body.length });
  }
  return out;
}

// 锚点工件（spec/anchor.json）的形状。注意两件事的**总体不同**：
// files 覆盖 UPSTREAM_FILES 全体（八个，每个都有 hash），expectedModels 只覆盖过
// isModelSource 的那批（两个）——八个文件都记 hash、但只有承载领域模型的两个记数。
export interface Anchor {
  upstreamRepo: string;
  commit: string;
  fetchedAt: string;
  files: { repoPath: string; sha256: string; bytes: number }[];
  expectedRouteRegistrations: number;
  expectedApiOperations: number;
  expectedModels: Record<string, number>;
}
