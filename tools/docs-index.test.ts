// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
/**
 * 文档活性门禁。
 *
 * 动机是本轮自己往 docs/ 树里加页：一份没人导航的文档等于不存在，而文档里指向
 * 不存在的文件或不存在命令，读者（人和代理）会照着撞墙。查过的既有执法面：
 *  - tools/workspace.test.ts 的横幅纪律只管 tools/ 与 spec/fixtures/，头注明确把 docs/ 排除；
 *  - tools/redact-evidence.ts 只扫 docs/operations/ 下的跑次工件，判据是凭据形状；
 *  - verify:all 的 GATES 里没有任何一条读 docs/。
 * ⇒ 文档的导航可达性与链接活性此前无人执法。本文件补的就是这一条。
 *
 * 判据不许加豁免名单：转绿靠修文档，不靠缩面。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ENTRY_PAGES = ['README.md', 'CONTRIBUTING.md', 'AGENTS.md', 'RoadMap.md', 'docs/README.md', 'demo/README.md'];

function mdFiles(dir: string): string[] {
  return readdirSync(dir)
    .flatMap((name) => {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) return name.startsWith('.') ? [] : mdFiles(p);
      return name.endsWith('.md') ? [p] : [];
    })
    // 一律归一成正斜杠：Windows 的 join 产出 docs\concepts\...，而导航表里写的是正斜杠，
    // 不归一会让本条在 Windows 误红、Linux 误绿 —— 那是门禁自己带的 OS 假设，比没门禁更糟。
    .map((p) => p.replace(/\\/g, '/'));
}

const docsPages = mdFiles('docs').filter((f) => f !== 'docs/README.md');
const readablePages = [...ENTRY_PAGES.filter(existsSync), ...docsPages];
const scripts = Object.keys(JSON.parse(readFileSync('package.json', 'utf8')).scripts as Record<string, string>);

describe('文档活性', () => {
  it('docs/ 下每个页面都被 docs/README.md 的导航表链接到（没导航等于不存在）', () => {
    const nav = readFileSync('docs/README.md', 'utf8');
    const orphans = docsPages.filter((f) => !nav.includes(f.replace(/^docs\//, '')));
    expect(orphans, `未被导航覆盖：${orphans.join(', ')}`).toEqual([]);
  });

  it('入口页与 docs/ 里所有相对 .md 链接都指向真实文件', () => {
    const dead: string[] = [];
    for (const file of readablePages) {
      for (const m of readFileSync(file, 'utf8').matchAll(/\]\(([^)#?]+\.md)(?:#[^)]*)?\)/g)) {
        const target = m[1];
        if (/^https?:/.test(target)) continue;
        if (!existsSync(resolve(dirname(file), target))) dead.push(`${file} → ${target}`);
      }
    }
    expect(dead, `死链：${dead.join(', ')}`).toEqual([]);
  });

  it('文档里出现的每条 `npm run <name>` 都是 package.json 里真实存在的脚本', () => {
    const unknown: string[] = [];
    for (const file of readablePages) {
      for (const m of readFileSync(file, 'utf8').matchAll(/npm run ([a-z][a-z0-9:_-]*)/g)) {
        if (!scripts.includes(m[1])) unknown.push(`${file} → npm run ${m[1]}`);
      }
    }
    expect(unknown, `不存在的脚本：${unknown.join(', ')}`).toEqual([]);
  });

  it('导航页里指向工具锁、spec、报告等**非 md** 目标也得存在（改名最常撞的一类死链）', () => {
    const dead: string[] = [];
    for (const file of readablePages) {
      for (const m of readFileSync(file, 'utf8').matchAll(/\]\((?!https?:|#)([^)#?]+\.(?:json|yaml|yml|lock\.json))\)/g)) {
        if (!existsSync(resolve(dirname(file), m[1]))) dead.push(`${file} → ${m[1]}`);
      }
    }
    expect(dead, `非 md 死链：${dead.join(', ')}`).toEqual([]);
  });
});
