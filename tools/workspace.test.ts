// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
// 横幅字符串只有一个真源（R18）：从 run.ts 取，绝不在本文件里再抄一份字面量。
import { BANNER } from './gen/run.js';

describe('workspace', () => {
  it('解析 ESM + TypeScript 环境', async () => {
    const pkg = JSON.parse(await readFile('package.json', 'utf8'));
    expect(pkg.type).toBe('module');
    expect(pkg.private).toBe(true);
  });

  it('yaml 依赖真实可用', async () => {
    const { parse } = await import('yaml');
    expect(parse('a: 1')).toEqual({ a: 1 });
  });
});

// 终审 M4：四个带 CLI 守卫的模块必须**能被 import**。旧写法 `pathToFileURL(process.argv[1])`
// 在 argv[1] 为 undefined 时直接抛 ERR_INVALID_ARG_TYPE，于是客户端批次最常见的探针写法
// （`tsx -e "import('./tools/build-anchor.ts')"`）当场崩，崩栈还指向模块自己的行号。
// 这条走真实子进程：单元测试里改 process.argv[1] 会影响同 worker 的其它用例，
// 而"能不能被外部进程 import"本身就是进程级事实。
describe('工具模块可被 -e 探针 import（argv[1] 缺失时 CLI 守卫静默）', () => {
  const repoRoot = fileURLToPath(new URL('../', import.meta.url));

  for (const mod of ['build-anchor', 'validate-spec', 'check-drift', 'side-effects-scan']) {
    it(`tools/${mod}.ts：import 成功、退出码 0、不执行 CLI 分支`, () => {
      const r = spawnSync(
        process.execPath,
        ['--import', 'tsx', '-e', `import('./tools/${mod}.ts').then(() => process.stdout.write('IMPORTED_OK'))`],
        { cwd: repoRoot, encoding: 'utf8' },
      );
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain('IMPORTED_OK');
      // CLI 分支若被执行，check-drift 会打出漂移报告、validate-spec 会打用法并 exit 2
      expect(r.stdout).not.toMatch(/用法：|upstreamOnly/);
    }, 30_000);
  }
});

// 终审 N-13：横幅纪律此前**没有被正式定过** —— tools/ 下 34 个入库文件里 24 个带、10 个不带，
// 而不带的恰好包括最"编码上游假设"的两个脚本（extract-routes.ts / extract-models.ts）与 8 个测试，
// 也就是"最需要标的一类反而漏了"。与其继续靠人各自判断，这里把规则钉成一条并当场补齐：
// **`tools/` 下每个入库文件的前 12 行内必须出现横幅**（模板类文件 tools/gen/templates/imports.tmpl
// 的横幅在第 9 行 —— 它是生成物首行的插入点，故窗口取 12 而非"首行"；无豁免名单 —— Go 批次会按
// 43 条操作继续往这里加脚本，任何"某某类文件免"的豁免都会在下一批里变成新的不一致）。
// 判据用 git ls-files 而不是目录 glob：被 .gitignore 排除的产物（generated/、vendor/、.venv-gen/）
// 不进本条范围。本条管 tools/ 与 spec/fixtures/ 两处手写派生文件 —— `extracted/*.json` 与
// `spec/anchor.json` 是 JSON、无注释语法，由 spec/NOTICE.md 的覆盖声明负责（终审 N-9）；
// `docs/` 是契约来源而非派生产物，不在这条里混成一套纪律。
it('横幅纪律（N-13）：tools/ 与 spec/fixtures/ 下每个入库文件都带许可行', () => {
  const tracked = ['tools', 'spec/fixtures'].flatMap((scope) =>
    spawnSync('git', ['ls-files', scope], { encoding: 'utf8' })
      .stdout.split(/\r?\n/)
      .filter(Boolean)
      .map((f) => ({ scope, f })),
  );
  expect(tracked.length).toBeGreaterThan(30);
  const missing = tracked.filter(({ f }) => {
    const head = readFileSync(f, 'utf8').split(/\r?\n/).slice(0, 12).join('\n');
    return !head.includes(BANNER);
  });
  expect(missing, `缺横幅的入库文件：${missing.map((m) => m.f).join(', ')}`).toEqual([]);
});
