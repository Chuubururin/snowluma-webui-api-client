// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
/**
 * Go 工具链定位的形状检查。
 *
 * 起因是冷克隆实测：`npm run generate` 的 Go 腿在新克隆里 ENOENT，而它给的恢复动作是一条
 * 写死作者机器用户目录的 `export PATH=…`。那条消息在另一台机器上不是恢复动作，是把人往
 * 不存在的目录引。所以这里钉三件事：
 *  1) 推导出来的目录必须真实存在（不猜路径）；
 *  2) generate 的 Go 腿与适配器测试腿用的是同一个推导函数（两份认知必然分叉）；
 *  3) 恢复动作文本里不许出现任何具体机器的路径字面量。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { genCommands } from './gen/run.js';
import { goExeName, goToolchainDirs, gorootBinFromLock, envWithGo } from './lib/go-toolchain.js';

const LOCK = {
  generators: { 'hey-api-openapi-ts': '0.99.0', 'openapi-python-client': '0.29.1', 'oapi-codegen': 'v2.8.0' },
  generationConstraints: { 'hey-api-openapi-ts': { peerTypeScript: '5.9.3' } },
} as never;

describe('Go 工具链定位', () => {
  it('推导出的每个目录都真实存在，且 GOROOT/bin 那一项里真的有 go', () => {
    const dirs = goToolchainDirs();
    for (const d of dirs) expect(existsSync(d), `${d} 不存在`).toBe(true);
    const fromLock = gorootBinFromLock();
    if (fromLock) expect(existsSync(join(fromLock, goExeName()))).toBe(true);
    // 两个都不为 null 时必须是两个不同目录：go 与 go install 产物不同处，混为一谈就少一条腿。
    if (dirs.length === 2) expect(dirs[0]).not.toBe(dirs[1]);
  });

  it('锁里的 GOROOT 指空时返回 null，而不是猜一个', () => {
    const fake = mkdtempish('sl-lock-missing-goroot');
    writeFileSync(
      join(fake, 'tools.lock.json'),
      JSON.stringify({ goInstall: { env: { GOROOT: join(fake, 'definitely-not-go') } } }),
    );
    expect(gorootBinFromLock(fake)).toBeNull();
  });

  it('只改 PATH 原有的大小写键，不制造第二份 PATH/Path', () => {
    const base = process.platform === 'win32' ? { Path: '/existing' } : { PATH: '/existing' };
    const { env, borrowed } = envWithGo(base as NodeJS.ProcessEnv);
    const pathKeys = Object.keys(env).filter((k) => k.toUpperCase() === 'PATH');
    expect(pathKeys).toHaveLength(1);
    const parts = (env[pathKeys[0]] ?? '').split(delimiter).filter(Boolean);
    if (borrowed) expect(parts[0]).toBe(borrowed);
    else expect(parts).toEqual(['/existing']);
  });

  it('generate 的 Go 腿前置的就是同一个推导结果（不再有第二条认知）', () => {
    const go = genCommands(LOCK).find((c) => c.lang === 'go')!;
    const dirs = goToolchainDirs();
    const key = Object.keys(go.env ?? {}).find((k) => k.toUpperCase() === 'PATH');
    if (dirs.length === 0) {
      // 这台机器上没有任何可推导的 Go 目录 ⇒ 不该硬塞一个空 PATH 前缀
      expect(key).toBeUndefined();
      return;
    }
    expect(key, 'Go 腿没有前置推导目录').toBeTruthy();
    const front = (go.env as Record<string, string>)[key!].split(delimiter).filter(Boolean);
    expect(front.slice(0, dirs.length)).toEqual(dirs);
    expect(go.env?.GOTOOLCHAIN).toBe('local');
  });

  it('报错文本里不许出现任何具体机器的路径字面量（恢复动作必须可移植）', () => {
    for (const f of ['tools/gen/run.ts', 'tools/lib/go-toolchain.ts']) {
      expect(readFileSync(f, 'utf8'), `${f} 写死了用户目录`).not.toMatch(/Users[/\\][A-Za-z0-9._-]+|[A-Za-z]:[\\/]go\b|\/c\/go\b/);
    }
  });

  it('需要 go 的入口只许用 envWithGo 合并 PATH，不许自己拼 PATH=（本机键名可能是 Path）', () => {
    // 这条为什么必须是源码形状而不是行为断言：本机的 env 键恰好是大写 PATH，
    // 任何"自己拼一个大写 PATH"的写法在这里都跑得通 —— 它就是那种只在作者机器上成立的绿。
    const users = ['tools/smoke-clients.ts', 'tools/run-go-test.ts', 'tools/gen/run.ts'];
    for (const f of users) {
      const src = readFileSync(f, 'utf8');
      expect(src, `${f} 没有走单源 envWithGo/withPathFront`).toMatch(/envWithGo|withPathFront/);
      expect(src, `${f} 直接赋值 env.PATH`).not.toMatch(/env\.PATH\s*=/);
    }
  });
});

/** 临时目录：只用于放一份假锁，不碰仓内文件。 */
function mkdtempish(name: string): string {
  const dir = join(process.env.TEMP ?? '/tmp', `${name}-${Date.now().toString(36)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}
