// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
/**
 * staging 布局计划断言：只验"计划"（路径 + metadata 内容），不跑真安装。
 * 真装真解析真跑归 tools/smoke-clients.ts —— 分开是为了让"漏一个文件""版本号没跟上"
 * 这类失效在秒级现形，而不是等到装包那条慢链上才红。
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { GO_MODULE_ID, PY_PACKAGE, TS_PACKAGE_NAME, buildStagingPlan, missingGeneratedDirs, missingGoModuleFiles, requiredFiles } from './lib/client-staging.js';
import { OK_TOKEN } from './lib/client-templates.js';

const V = (parseYaml(readFileSync('spec/openapi.yaml', 'utf8')) as { info: { version: string } }).info.version;
const ANCHOR = 'b'.repeat(40);
const plan = buildStagingPlan({ version: V, anchor: ANCHOR });
const files = Object.keys(plan.files);
const contentOf = (rel: string) => {
  const e = plan.files[rel];
  expect(e, `计划里没有 ${rel}`).toBeDefined();
  return e.content ?? '';
};

describe('staging 布局', () => {
  it('三语目录都在计划里', () => {
    for (const lang of ['typescript', 'python', 'go']) {
      expect(files.some((f) => f.startsWith(`${lang}/`)), `缺 ${lang}`).toBe(true);
    }
  });

  it('requiredFiles 的每一件都在计划里（漏一件等于工件缺件）', () => {
    for (const rel of requiredFiles()) {
      expect(files, `缺 ${rel}`).toContain(rel);
    }
  });

  it('requiredFiles 自己不许被删薄（每语言四类件都在，条数有下限）', () => {
    // 上一条断言是"计划 ⊇ 清单"，清单本身变短时它不会红 —— 所以这里把清单的形状钉住。
    for (const lang of ['typescript', 'python', 'go']) {
      const list = requiredFiles().filter((f) => f.startsWith(`${lang}/`));
      for (const kind of ['README.md', 'NOTICE.md', 'provenance.json']) {
        expect(list, `${lang} 的必发件缺 ${kind}`).toContain(`${lang}/${kind}`);
      }
      expect(list.some((f) => /examples\/basic\.[a-z]+$/.test(f)), `${lang} 缺可执行示例`).toBe(true);
    }
    expect(requiredFiles().length, '必发件清单被删薄').toBeGreaterThanOrEqual(24);
  });

  it('三份 metadata 的版本号都等于 spec 契约版本（真源只有一个）', () => {
    expect(contentOf('typescript/package.json')).toContain(`"version": "${V}"`);
    expect(contentOf('python/pyproject.toml')).toContain(`version = "${V}"`);
    expect(contentOf('go/adapters/version.go')).toContain(`ContractVersion = "${V}"`);
  });

  it('TS 运行时零第三方依赖（出口只带生成码与行为适配层，不带读 spec 的仓内工装）', () => {
    const pkg = JSON.parse(contentOf('typescript/package.json')) as { dependencies?: Record<string, string> };
    expect(pkg.dependencies ?? {}).toEqual({});
  });

  it('TS 的入口声明三键齐备且都落在 dist 里（只发 TS 源码等于没发出可安装的工件）', () => {
    const pkg = JSON.parse(contentOf('typescript/package.json')) as {
      main?: string; types?: string; exports?: Record<string, Record<string, string>>; type?: string;
    };
    expect(pkg.type).toBe('module');
    expect(pkg.main).toBe('./dist/index.js');
    expect(pkg.types).toBe('./dist/index.d.ts');
    expect(pkg.exports?.['.']).toEqual({ types: './dist/index.d.ts', import: './dist/index.js' });
  });

  it('Python 依赖恰好是实测到的 httpx 与 attrs（不照生成器默认模板多写）', () => {
    const toml = contentOf('python/pyproject.toml');
    expect(toml).toMatch(/dependencies = \["httpx", "attrs"\]/);
    expect(toml).not.toMatch(/pydantic|python-dateutil/);
  });

  it('Python 把 rules.json 声明成包内数据文件（wheel 装完读不到表就是假工件）', () => {
    const toml = contentOf('python/pyproject.toml');
    expect(toml).toContain(`[tool.setuptools.package-data]`);
    expect(toml).toMatch(new RegExp(`${PY_PACKAGE} = \\[[^]]*rules\\.json`));
    expect(files).toContain(`python/${PY_PACKAGE}/rules.json`);
  });

  it('Go 的 module id 沿用生成物既有 id，且计划里不许出现 replace 或仓内相对路径', () => {
    expect(contentOf('go/go.mod')).toContain(`module ${GO_MODULE_ID}`);
    for (const [rel, entry] of Object.entries(plan.files)) {
      const text = entry.content ?? entry.copyFrom ?? '';
      expect(text, `${rel} 含带不出仓的相对引用`).not.toMatch(/\.\.\/\.\.\/generated/);
      expect(contentOf(rel), `${rel} 含 replace`).not.toMatch(/^replace\b/m);
    }
  });

  it('Go 工件里没有嵌套 module（子目录再来一个 go.mod，适配层就属另一个模块，import 解析不到）', () => {
    // 实测踩过：adapters/go/go.mod 带着 replace，被整目录搬运时一起进了工件。
    expect(files.filter((f) => f.endsWith('go.mod'))).toEqual(['go/go.mod']);
    expect(files.filter((f) => f.endsWith('go.sum'))).toEqual(['go/go.sum']);
    const nested = Object.entries(plan.files).filter(([, e]) => /adapters\/go\/go\.(mod|sum)$/.test(e.copyFrom ?? ''));
    expect(nested, `嵌套 module 的来源：${nested.map(([r]) => r).join(', ')}`).toEqual([]);
  });

  it('三语的规则表都落在各自适配层能解析到的层级（不改一行路径代码）', () => {
    // TS: adapter/rules.ts 的 join(dirname(import.meta.url), '..', 'rules.json')
    expect(files).toContain('typescript/rules.json');
    // Py: 包内 sibling
    expect(files).toContain(`python/${PY_PACKAGE}/rules.json`);
    // Go: LoadRules 的 filepath.Join(dir(thisFile), "..", "rules.json")
    expect(files).toContain('go/rules.json');
  });

  it('TS 出口 index.ts 同时给出类型化调用面与行为适配层', () => {
    const entry = contentOf('typescript/index.ts');
    expect(entry).toMatch(/generated\/index/);
    expect(entry).toMatch(/adapter\/client/);
  });

  it('TS 出口对实测撞名各有一处显式处置，两侧都可达（不是靠 star 导出碰运气）', () => {
    const entry = contentOf('typescript/index.ts');
    expect(entry).toMatch(/export \{ LoginError \} from '\.\/adapter\/client'/);
    expect(entry).toMatch(/LoginError as SdkLoginError/);
    expect(entry).toMatch(/createClient as createSdkClient/);
    expect(entry).toMatch(/createClient as createDiskClient/);
  });

  it('TS 出口默认吃内嵌规则表（出口闸第一次真跑就是在这里 ENOENT 抓到的）', () => {
    const entry = contentOf('typescript/index.ts');
    expect(entry).toMatch(/import \{ EMBEDDED_RULES \} from '\.\/adapter\/embedded-rules'/);
    expect(entry).toMatch(/createAdapterClient\(\{ rules: EMBEDDED_RULES, \.\.\.opts \}\)/);
  });

  it('内嵌的规则表必须与真源逐字段相等（派生物一旦能漂，就是第二张表）', () => {
    const mod = contentOf('typescript/adapter/embedded-rules.ts');
    const json = mod.slice(mod.indexOf('= ') + 2).trim().replace(/;$/, '');
    expect(JSON.parse(json)).toEqual(JSON.parse(readFileSync('adapters/rules.json', 'utf8')));
  });

  it('每个 example 文件都带各自语言的 OK 标记（smoke 的"用得动"层按它判）', () => {
    expect(contentOf('typescript/examples/basic.ts')).toContain(OK_TOKEN.typescript);
    expect(contentOf('python/examples/basic.py')).toContain(OK_TOKEN.python);
    expect(contentOf('go/examples/basic.go')).toContain(OK_TOKEN.go);
  });

  it('三份 README 与 NOTICE 都在，且 README 由模板渲染（含包名与契约版本）', () => {
    for (const lang of ['typescript', 'python', 'go']) {
      expect(files).toContain(`${lang}/README.md`);
      expect(files).toContain(`${lang}/NOTICE.md`);
    }
    expect(contentOf('typescript/README.md')).toContain(TS_PACKAGE_NAME);
    expect(contentOf('typescript/README.md')).toContain(V);
  });

  it('缺输入面时点名三个生成目录（Linux 冷克隆实测的是裸 ENOENT，那不是可执行的红）', () => {
    expect(missingGeneratedDirs('/definitely-not-a-repo')).toEqual([
      'generated/typescript',
      'generated/python',
      'generated/go',
    ]);
    // 本仓跑到这里必然三个都在：不在的话上面所有断言都会以 ENOENT 崩，而不是给出恢复动作。
    expect(missingGeneratedDirs()).toEqual([]);
  });

  it('Go 模块面缺件时逐件点名（冷克隆实测：init 写了 go.mod，go.sum 压根不存在）', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'sl-go-module-'));
    expect(missingGoModuleFiles(tmp)).toEqual(['go.mod', 'go.sum']);
    writeFileSync(join(tmp, 'go.mod'), 'module example.com/x\n');
    expect(missingGoModuleFiles(tmp), '只有 go.mod 时仍要报缺 go.sum').toEqual(['go.sum']);
    writeFileSync(join(tmp, 'go.sum'), '');
    expect(missingGoModuleFiles(tmp)).toEqual([]);
    // 本仓这一面必须齐：不齐的话上面所有断言读到的模块清单都是空气。
    expect(missingGoModuleFiles()).toEqual([]);
  });

  it('README 里"见同目录 X"承诺的每一件都必须是计划成员（散文不能承诺工件里没有的件）', () => {
    // 这条是自我指认型断言的解法：不是再断言一次 README 写了 provenance.json，
    // 而是把 README 指向的文件名抽出来，逐个对着 plan.files 核。
    const promised: string[] = [];
    for (const lang of ['typescript', 'python', 'go']) {
      const readme = contentOf(`${lang}/README.md`);
      for (const m of readme.matchAll(/同目录 `([^`]+)`/g)) {
        promised.push(`${lang}/${m[1]}`);
        expect(files, `${lang}/README.md 指向不存在的 ${m[1]}`).toContain(`${lang}/${m[1]}`);
      }
    }
    expect(promised.length, 'README 里一条"同目录"承诺都没有 —— 抽取式断言已经空转').toBeGreaterThan(0);
    // 血统收据是三语共用的同一份源，不是各写一份。
    for (const lang of ['typescript', 'python', 'go']) {
      expect(plan.files[`${lang}/provenance.json`]?.copyFrom).toBe('generated/.provenance.json');
    }
  });

  it('搬运项指向真实存在的源文件（拼错一个目录名，计划绿而工件缺件）', () => {
    const copies = Object.entries(plan.files).filter(([, e]) => e.copyFrom);
    expect(copies.length).toBeGreaterThan(20);
    for (const [rel, e] of copies) {
      expect(e.copyFrom, `${rel} 没有来源`).toBeTruthy();
      expect(e.copyFrom).not.toMatch(/\\/);
      expect(existsSync(e.copyFrom!), `${rel} 的来源 ${e.copyFrom} 不存在`).toBe(true);
    }
  });
});
