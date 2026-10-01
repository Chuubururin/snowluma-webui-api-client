// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { BANNER, filesMissingHeader, genCommands, OUTPUTS, PROVENANCE_PATH, SPEC_PATH, VENV_BIN_DIR, writeProvenance, type LockForGen } from './run.js';
import { createHash } from 'node:crypto';

// 与 tools.lock.json 同形的最小 lock：测试里**不**读真文件，好让"版本号从 lock 来"这件事可证伪。
const lock: LockForGen = {
  generators: {
    'hey-api-openapi-ts': '0.99.0',
    'openapi-python-client': '0.29.1',
    'oapi-codegen': 'v2.8.0',
  },
  runtimes: { node: 'v22.23.1', python: '3.14.6', go: 'go1.27.1' },
  generationConstraints: {
    'hey-api-openapi-ts': { peerTypeScript: '5.9.3' },
  },
};

const find = (lang: 'typescript' | 'python' | 'go') => {
  const c = genCommands(lock).find((x) => x.lang === lang);
  if (!c) throw new Error(`genCommands 没返回 ${lang} 那条`);
  return c;
};

describe('genCommands', () => {
  it('版本全部来自 lock，不出现未 pin 的安装命令', () => {
    const joined = genCommands(lock).map((c) => c.argv.join(' ')).join('\n');
    expect(joined).toContain('@hey-api/openapi-ts@0.99.0');
    expect(joined).not.toMatch(/pip install(?!=)|npm i(nstall)? (?!-y )/);
  });

  it('Go 侧显式钉住 GOTOOLCHAIN=local，否则会自动下载工具链', () => {
    expect(find('go').env?.GOTOOLCHAIN).toBe('local');
  });

  it('lock 里缺 pin 就报错，不退回硬编码版本', () => {
    const noOpc = structuredClone(lock);
    noOpc.generators['openapi-python-client'] = undefined;
    expect(() => genCommands(noOpc)).toThrow(/openapi-python-client/);
    const noPeer = structuredClone(lock);
    noPeer.generationConstraints!['hey-api-openapi-ts'] = undefined;
    expect(() => genCommands(noPeer)).toThrow(/peerTypeScript/);
  });

  it('hey-api 走配置文件 -f（-c 是 --client），TS peer 也从 lock 来', () => {
    const c = find('typescript');
    expect(c.argv).toEqual([
      'npx', '-y',
      '-p', '@hey-api/openapi-ts@0.99.0',
      '-p', 'typescript@5.9.3', // 不是仓库自己的 typescript@7.0.2 —— 会在 import 期崩
      'openapi-ts',
      '-f', 'tools/gen/hey-api.config.ts',
    ]);
    // argv 里不许出现空格/引号：这条要 shell:true 才能起 npx.cmd，走 shell 时靠的就是"无需转义"
    for (const a of c.argv) expect(a).not.toMatch(/[\s'"]/);
    expect(c.shell).toBe(true);
  });

  it('python 用实测的长参数形态，并把 venv Scripts 前置进 PATH', () => {
    const c = find('python');
    const joined = c.argv.join(' ');
    // 0.29.1 `generate --help` 实测没有 -c/-p/-o 短参；重跑必须 --overwrite
    expect(joined).toContain('--path spec/openapi.yaml');
    expect(joined).toContain('--output-path generated/python');
    expect(joined).toContain('--config tools/gen/python-config.yml');
    expect(joined).toContain('--meta none');
    expect(joined).toContain('--overwrite');
    expect(c.argv.filter((a) => /^-[a-z]+$/.test(a))).toEqual(['-m']);
    // PATH 不含 venv 目录时 ruff 与 post_hooks 全部静默跳过 → 头部不会落进产物。
    const pathKey = Object.keys(c.env ?? {}).find((k) => k.toUpperCase() === 'PATH');
    expect(pathKey).toBeDefined();
    const first = (c.env as Record<string, string>)[pathKey!].split(delimiter)[0].replace(/\\/g, '/');
    // 首项必须落在 .venv-gen 的某个合法解释器目录里（POSIX 是 bin，Windows 是 Scripts）；
    // 这里不写死 'Scripts'——那是把 Windows 语义焊进断言，Linux job 上必红却什么也没证明。
    expect(first).toMatch(/\.venv-gen\/(Scripts|bin)$/);
    // 下一条才是真判据：必须等于实现按平台解析出的那个目录（写死 Scripts 的实现在 Linux 上会红在这里）。
    expect(first).toBe(resolve(VENV_BIN_DIR).replace(/\\/g, '/'));
  });

  it('lock 的 runtimes 不参与拼命令：命令里只出现生成器 pin 与 peer TS', () => {
    const joined = genCommands(lock).map((c) => c.argv.join(' ')).join('\n');
    expect(joined).not.toContain('go1.27.1');
    expect(joined).not.toContain('v22.23.1');
  });

  it('三条命令的产物目录都在 generated/ 下（.gitignore 的覆盖面）', () => {
    for (const c of genCommands(lock)) {
      expect(OUTPUTS[c.lang].dir).toMatch(/^generated\//);
      expect(OUTPUTS[c.lang].exts.length).toBeGreaterThan(0);
    }
    // python/go 从 CLI 拿 spec；hey-api 的 spec 在配置文件里（input 必须带 ./，见 findings 偏差 2）
    expect(find('python').argv).toContain('spec/openapi.yaml');
    expect(find('go').argv).toContain('spec/openapi.yaml');
  });
});

it('模板副本带 pin 出处与许可声明（升版本必须重新 diff）', async () => {
  const t = await readFile('tools/gen/templates/imports.tmpl', 'utf8');
  expect(t).toContain(BANNER);
  expect(t).toMatch(/oapi-codegen v2\.8\.0/);
});

it('许可声明与 tools.lock.json 的 banner 同字', async () => {
  const l = JSON.parse(await readFile('tools.lock.json', 'utf8')) as { banner: string };
  expect(BANNER).toBe(l.banner);
});

it('Go 配置钉住枚举前缀、模板副本与产物路径，且用新版 config 形态', async () => {
  const y = await readFile('tools/gen/oapi-codegen.yaml', 'utf8');
  // 关掉布尔 enum 的包级裸常量 False/True（findings Q5 附带发现）
  expect(y).toMatch(/always-prefix-enum-values:\s*true/);
  expect(y).toMatch(/imports\.tmpl:\s*tools\/gen\/templates\/imports\.tmpl/);
  expect(y).toMatch(/package:\s*snowluma/);
  expect(y).toMatch(/output:\s*generated\/go\/snowluma\/types\.gen\.go/);
  // 老式 `generate:` 写字符串列表会被判为 old-config-style（上游标注将来移除）
  expect(y).not.toMatch(/^generate:\s*\[/m);
  expect(y).toMatch(/^generate:\s*$/m);
});

// 终审 W3：run.ts 的报错文案引用 lock 当"机器可读权威"，而 lock 的 headerMechanism 曾与
// shipped config 相反（写着"只能 -templates"，实际用的是 output-options.user-templates；
// -templates 已废弃且整目录皆算覆盖，findings 416-420）。这份断言让两处漂移必红其一。
it('lock 的 oapi-codegen headerMechanism 点名 shipped config 实际使用的键，不再宣称 -templates 唯一', async () => {
  const l = JSON.parse(await readFile('tools.lock.json', 'utf8')) as {
    generationConstraints: Record<string, { headerMechanism?: string } | undefined>;
  };
  const mech = l.generationConstraints['oapi-codegen']?.headerMechanism ?? '';
  expect(mech).toContain('user-templates'); // config 真用的键（output-options.user-templates）
  expect(mech).not.toMatch(/只能\s*-templates/); // 旧文案的"唯一可靠"式断言
  const y = await readFile('tools/gen/oapi-codegen.yaml', 'utf8');
  // 被测事实的另一半：config 确实在 output-options 下挂 user-templates，且没有走 CLI -templates
  const userTemplates = y.split(/\r?\n/).find((line, i, all) => line.includes('user-templates:') && all[i - 1]?.includes('output-options:'));
  expect(userTemplates).toBeDefined();
});

it('hey-api 配置自带注释语义的 header，且 hey-api 不在仓库依赖里', async () => {
  const s = await readFile('tools/gen/hey-api.config.ts', 'utf8');
  expect(s).toContain(`header: '// ${BANNER}'`);
  expect(s).toMatch(/input:\s*'\.\/spec\/openapi\.yaml'/);
  const pkg = JSON.parse(await readFile('package.json', 'utf8')) as {
    devDependencies: Record<string, string>;
    scripts: Record<string, string>;
  };
  // tools.lock.json → generationConstraints.note：生成期依赖不得与仓库 devDependencies 混用
  expect(Object.keys(pkg.devDependencies)).not.toContain('@hey-api/openapi-ts');
  expect(pkg.scripts.generate).toBe('tsx tools/gen/run.ts');
});

it('Python 头部 hook 走配置文件里的 post_hooks，且排在 ruff 之后', async () => {
  const y = await readFile('tools/gen/python-config.yml', 'utf8');
  // 只看列表项，注释里也出现这些词
  const hooks = y
    .split(/\r?\n/)
    .filter((l) => /^\s*-\s/.test(l))
    .map((l) => l.replace(/^\s*-\s+/, '').replace(/^"(.*)"$/, '$1').trim());
  expect(hooks).toEqual([
    'ruff check . --fix-only --extend-select=I',
    'ruff format .',
    'python ../../tools/gen/add-header.py',
  ]);
  // hook 的 cwd 是输出目录（generated/python），所以路径必须回退两级
  expect(hooks[2]).toContain('../../tools/gen/add-header.py');
  // 计划草稿用的 project_name/package_name 不是 ConfigFile 的字段（pydantic 默认忽略多余键，
  // 用错名不报错，只会静默换成 "<title>-client" 这套包名，下游实现批次的导入路径全断）
  expect(y).toMatch(/package_name_override:\s*snowluma_webui/);
  expect(y).not.toMatch(/^project_name:/m);
});

// filesMissingHeader 是全管线唯一的横幅执法点：三家生成器里 python 在 post_hook 被跳过时
// 仍然返回 0（实测复现：95 个 .py 写出来，client.py 第一行是 `import ssl`）。
// 这三条用 mkdtemp 里的临时目录跑，**不读 generated/** —— 冷克隆没有产物，
// 读本地的产物目录会让用例在一台干净机器上无故变红。
describe('filesMissingHeader', () => {
  const withDir = async (files: Record<string, string>, run: () => Promise<unknown>) => {
    const dir = await mkdtemp(join(tmpdir(), 'slgen-'));
    const prev = OUTPUTS.typescript;
    try {
      for (const [name, body] of Object.entries(files)) await writeFile(join(dir, name), body);
      OUTPUTS.typescript = { dir, exts: ['.ts'] };
      return await run();
    } finally {
      OUTPUTS.typescript = prev;
      await rm(dir, { recursive: true, force: true });
    }
  };

  it('目录存在但一个该语言文件都没有 ⇒ 算失败，不许空对空地说"产物齐备"', () =>
    withDir({ 'readme.md': '不是源文件' }, async () => {
      const bad = await filesMissingHeader('typescript');
      expect(bad).toHaveLength(1);
      expect(bad[0]).toContain('扫到 0 个 .ts 文件');
    }));

  it('带横幅的不被点名，缺横幅的被点名', () =>
    withDir(
      {
        'a.ts': `// ${BANNER}\nexport const a = 1;\n`,
        'b.ts': 'export const b = 2;\n',
      },
      async () => {
        const bad = await filesMissingHeader('typescript');
        expect(bad.map((f) => f.split(/[\\/]/).pop())).toEqual(['b.ts']);
      },
    ));

  it('整个目录不存在时仍报"目录不存在"，不与"0 个文件"混成同一条消息', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'slgen-'));
    const missing = join(dir, 'nope');
    const prev = OUTPUTS.typescript;
    try {
      OUTPUTS.typescript = { dir: missing, exts: ['.ts'] };
      const bad = await filesMissingHeader('typescript');
      expect(bad).toEqual([`${missing} <整个目录不存在>`]);
    } finally {
      OUTPUTS.typescript = prev;
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// 评审的 Minor：`hey-api.config.ts` 里的 output.path 与 run.ts 的 OUTPUTS.typescript.dir
// 是两处独立字符串。写歪时开发机上有一份**过期但存在**的 generated/typescript/，
// 横幅检查会对着旧产物点头 —— 冷克隆上才会炸。这条断言把"验的是刚生成的那一份"
// 变成机器事实，而不是靠人记。（配置文件是纯 default export，所以 import 它不引入任何
// 生成期依赖 —— 那正是它不用 defineConfig 的附带结果。）
it('TS 侧的产物路径两处一致：横幅检查验的就是刚生成的那一份', async () => {
  const cfg = (await import('./hey-api.config.js')).default;
  expect(cfg.output.path).toBe(OUTPUTS.typescript.dir);
  expect(cfg.input).toBe('./spec/openapi.yaml');
});

// 终审 A4：头部注入替换掉了生成器默认头，产物里没有任何版本戳 ⇒ "probe 绿"此前分不出
// 新鲜产物与手改产物。本用例钉收据本身的构成（路径在 generated/ 下 → 随产物一起被
// .gitignore 排除；sha 必须能对上现算值，否则整条信任链是摆设）。
it('provenance 收据（A4）：spec sha256 + 三家 pin + 时间戳，落在 generated/ 下', async () => {
  // 断言按平台无关的分段做：PROVENANCE_PATH 是 path.join 出来的，Windows 上分隔符是 `\`，
  // 写成 /^generated\// 就是把"这台机器是 POSIX"偷偷当前提（与 OUTPUTS.*.dir 那两条不同 ——
  // 那两处是硬编码的 POSIX 字符串，所以 /^generated\// 对它们成立）。
  expect(PROVENANCE_PATH.split(/[\\/]/)).toEqual(['generated', '.provenance.json']);
  const dir = await mkdtemp(join(tmpdir(), 'slprov-'));
  try {
    const dest = join(dir, 'sub', '.provenance.json');
    const p = await writeProvenance(lock, ['typescript', 'python', 'go'], new Date('2026-09-27T00:00:00Z'), dest);
    const written = JSON.parse(await readFile(dest, 'utf8'));
    expect(written).toEqual({ ...p, generatedAt: '2026-09-27T00:00:00.000Z' });
    expect(p.banner).toBe(BANNER);
    expect(p.generators['oapi-codegen']).toBe('v2.8.0');
    expect(p.languages).toEqual(['typescript', 'python', 'go']);
    const spec = await readFile(SPEC_PATH);
    expect(p.specSha256).toBe(createHash('sha256').update(spec).digest('hex'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// R1（prework P3-5）：收据必须记录**本次实际生成成功**的语言集。旧收据不管跑了几个语言
// 都长得一样，`run.ts go` 单跑会写出一份声称"三语言出自当前 spec"的收据 ⇒ 血统检查在
// 部分重生成时失效。languages 由调用方传入（CLI 循环里逐语言成功后收集），
// probe.py 的第四道按"齐全"判定 —— 部分重生成的收据在这里就现出原形。
it('R1：单跑一个语言时，收据的 languages 恰为该语言（不是三语言全量）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'slprov-'));
  try {
    const dest = join(dir, '.provenance.json');
    const p = await writeProvenance(lock, ['go'], new Date('2026-09-27T00:00:00Z'), dest);
    expect(p.languages).toEqual(['go']);
    const written = JSON.parse(await readFile(dest, 'utf8'));
    expect(written.languages).toEqual(['go']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// N29（设计口径）：tsconfig.json 的 exclude 是「仓库类型检查不依赖 git-ignored 产物」
// 这条不变量的唯一执法点 —— 删掉它在本机不会有任何测试变红（generated/ 还在时 tsc 照样
// 绿，只有冷克隆才会报 TS2307）。行为判据做不到（行为只在冷克隆红），所以守卫的对象是
// 文本本身：exclude 仍点名 probe.ts，且写在 include 之后（防有人靠删 include 让它
// "看起来生效"）。这条是"防删"而非"补缺"，现状下绿是预期；下面另有变异验证让它自证能红。
describe('N29 的 tsconfig exclude 是"仓库类型检查不依赖 git-ignored 产物"的唯一执法点', () => {
  const tsconfig = readFileSync('tsconfig.json', 'utf8');
  it('exclude 里仍然点名 tools/gen/probe.ts', () => {
    expect(tsconfig).toContain('"tools/gen/probe.ts"');
  });
  it('排除项写在 include 之后，防止有人靠删 include 让它"看起来生效"', () => {
    expect(tsconfig.indexOf('"exclude"')).toBeGreaterThan(tsconfig.indexOf('"include"'));
  });
});

// 姊妹账（prework P3-3 用户裁定并入本条）：tools/integrity-check.ts 的四道红路只在提交时
// 人工验过一次，人工验过 ≠ 有守卫 —— 下一次重构可以静默把它改成不会红的检查而无人察觉。
// 行为判据（真跑它看退出码）会 fork 进程且依赖工作区状态，这里钉结构本身：
// 缺参数必须 exit 2（不接受静默通过）、子进程必须结构上拿不到 stdin（本文件存在的理由）。
it('integrity-check 的用法行存在且缺参数时退出码为 2（不接受静默通过）', () => {
  const src = readFileSync('tools/integrity-check.ts', 'utf8');
  expect(src).toContain('process.exit(2)');
  expect(src).toContain("stdio: ['ignore', 'pipe', 'pipe']"); // 结构免疫本身要被钉住，否则下次重构就没了
});
