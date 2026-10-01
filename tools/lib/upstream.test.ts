// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import {
  sha256Hex,
  UPSTREAM_FILES,
  cachedSha256For,
  isModelSource,
  localPathFor,
} from './upstream.js';

describe('sha256Hex', () => {
  it('对已知输入产出已知摘要', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('同输入同输出、异输入异输出', () => {
    expect(sha256Hex('a')).toBe(sha256Hex('a'));
    expect(sha256Hex('a')).not.toBe(sha256Hex('b'));
  });
});

describe('UPSTREAM_FILES', () => {
  it('恰好包含四十七份设计依赖的上游文件（读侧构造点 8 → 29，B4 totp.ts → 30，B5 qq-port-probe.ts → 31，客户端 demo 重做的 16 份前端组件 → 47）', () => {
    expect([...UPSTREAM_FILES].sort()).toEqual(
      [
        'packages/core/src/webui/server.ts',
        'packages/core/src/webui/storage-routes.ts',
        'packages/core/src/webui/consent.ts',
        'packages/core/src/webui/sse-response.ts',
        'packages/core/src/webui/debug-stream.ts',
        'packages/webui/src/lib/api/types.ts',
        'packages/webui/src/types.ts',
        'packages/webui/src/lib/api/client.ts',
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
        'packages/core/src/webui/totp.ts',
        'packages/bridge/src/qq-port-probe.ts',
        // 客户端 demo 重做：demo/parity.ts 与 demo/declinations.ts 对真 WebUI 的
        // **前端组件**下 file:line 正面断言（设计口径的 Tier A 升级）。
        // 升级前置实测：pinned commit 与本机工作树对这 16 份逐份比 sha256，16/16 全等。
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
      ].sort(),
    );
  });

  // localPathFor 只剥 `packages/` 前缀：写成绝对路径或别的前缀不会报错，但会把缓存
  // 落到意料之外的目录里，于是锚点与漂移检查看的是两份不同的字节。
  // 扩展名放到 .tsx：本仓原先只锚服务端源码（全 .ts），客户端 demo 重做按 N26 把
  // "被正面断言的前端组件"也锚进来，于是这条谓词的后缀集合必须显式扩容——
  // 但它仍不许放 .json/.css/.md：锚的是**代码**，不是任意资产。
  it('每条都是 packages/ 开头的相对路径且以 .ts/.tsx 结尾', () => {
    for (const p of UPSTREAM_FILES) {
      expect(p.startsWith('packages/')).toBe(true);
      expect(/\.tsx?$/.test(p)).toBe(true);
    }
  });
});

// isModelSource 是"哪些缓存文件承载可建模的领域类型"的唯一判定：build-anchor 用它算
// expectedModels，的 inventory 要用它算 extracted/models.json 的总体。两处必须
// 共用同一条，否则"基线"与"漂移检查"各数各的，两边都绿但互不相干（裁定 R18）。
describe('isModelSource', () => {
  it('只把 webui 下的两个 types.ts 判为模型来源', () => {
    expect([...UPSTREAM_FILES].filter(isModelSource).sort()).toEqual([
      'packages/webui/src/lib/api/types.ts',
      'packages/webui/src/types.ts',
    ]);
  });

  it('新增的两份（core 下的 consent.ts、非 types.ts 的 client.ts）不建模', () => {
    expect(isModelSource('packages/core/src/webui/consent.ts')).toBe(false);
    expect(isModelSource('packages/webui/src/lib/api/client.ts')).toBe(false);
  });

  it('四十七个缓存文件里过筛的恰好两个 —— expectedModels 不随文件数线性增长', () => {
    expect(UPSTREAM_FILES.length).toBe(47);
    expect(UPSTREAM_FILES.filter(isModelSource).length).toBe(2);
    // 扩进来的两份是 SSE 的传输壳，不是领域模型；断言它们被谓词挡在外面，
    // 而不是只断言总数（总数对了、集合却悄悄多两个键，是这条断言存在的理由）
    // 客户端 demo 重做：webui/src/ 从 3 份涨到 19 份（+16 前端组件/路由），
    // 全部是 .tsx ⇒ 被 isModelSource 的 endsWith('types.ts') 挡在筛外，过筛数仍为 2。
    // 这条断言现在真正咬人了：再多锚一份前端组件它就得 +1，而模型数纹丝不动。
    expect(UPSTREAM_FILES.filter((p) => p.includes('webui/src/'))).toHaveLength(19);
    // 上一条 filter 只是代理（core 下的路径永远不含 'webui/src/'，加不加这两份都成立）；
    // 直接把两份新文件喂给谓词，未来误放行时才会指名道姓地红。
    expect(isModelSource('packages/core/src/webui/sse-response.ts')).toBe(false);
    expect(isModelSource('packages/core/src/webui/debug-stream.ts')).toBe(false);
  });
});

describe('cachedSha256For', () => {
  it('从缓存目录读取并哈希', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'slu-'));
    // localPathFor 保留仓库层级（去掉 packages/ 前缀），故此处必须写完整子路径。
    // 不可扁平为 join(dir,'server.ts')：上游有两个同名 types.ts，扁平会互相覆盖，
    // 使实现批次的 76 与 19 模型计数失真。
    const local = join(dir, 'core/src/webui/server.ts');
    await mkdir(dirname(local), { recursive: true });
    await writeFile(local, 'hello', 'utf8');
    const got = await cachedSha256For('packages/core/src/webui/server.ts', dir);
    expect(got).toBe(sha256Hex('hello'));
  });

  it('未缓存时报错含路径、cause 保留 ENOENT、提示重拉有用', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'slu-'));
    const err = await cachedSha256For('packages/webui/src/types.ts', dir).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/packages\/webui\/src\/types\.ts/);
    expect(err.message).toMatch(/未缓存/);
    expect((err.cause as NodeJS.ErrnoException).code).toBe('ENOENT');
  });

  it('缓存存在但不可读时提示重拉无用、cause 保留该 errno', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'slu-'));
    const local = localPathFor('packages/core/src/webui/server.ts', dir);
    // 在应为文件的路径上放一个目录 → EISDIR，而非 ENOENT
    await mkdir(local, { recursive: true });
    const err = await cachedSha256For('packages/core/src/webui/server.ts', dir).catch((e) => e);
    expect(err.message).toMatch(/重新拉取无法解决/);
    expect((err.cause as NodeJS.ErrnoException).code).toBe('EISDIR');
  });
});

// 这条是整套映射设计的地基守卫：上游有两个同名 types.ts，任何"把 localPathFor 扁平化"
// 的改动都会静默让二者互相覆盖，使实现批次的 76 与 19 模型计数失真。
describe('localPathFor 不得让同名 basename 互相覆盖', () => {
  it('两个 types.ts 解析出的本地路径不同', () => {
    expect(localPathFor('packages/webui/src/types.ts', 'v')).not.toBe(
      localPathFor('packages/webui/src/lib/api/types.ts', 'v'),
    );
  });

  it('八份上游路径解析结果两两互异', () => {
    const paths = UPSTREAM_FILES.map((p) => localPathFor(p, 'v'));
    expect(new Set(paths).size).toBe(paths.length);
  });
});
