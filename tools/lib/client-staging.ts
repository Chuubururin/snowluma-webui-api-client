// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
/**
 * 出口工件的 staging 布局计划：把仓内的生成物与行为适配层，机械搬运成三个**自包含**目录。
 *
 * 三条判据：
 *  ① 只产"计划"（路径 + 内容/来源），落盘由 tools/package-clients.ts 做 —— 计划可单测，
 *     秒级抓住"漏一件""版本没跟上"，不必等装包那条慢链。
 *  ② 名字一律取自 tools/lib/client-artifact.ts；这里再写一遍字面量就是第二真源。
 *  ③ 计划里绝不允许出现带不出仓的东西（仓内相对路径、go.mod 的 replace）。
 *     这类失效源码树全绿看不见：门禁都跑在仓根。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';
import {
  ARTIFACT_DIRS,
  BANNER,
  GO_ADAPTER_DIR,
  GO_MODULE_ID,
  GO_PACKAGE_DIR,
  PY_DIST_NAME,
  PY_PACKAGE,
  TS_PACKAGE_NAME,
  type ArtifactLang,
} from './client-artifact.js';
import { renderExample, renderReadme } from './client-templates.js';

export type FilePlan = { content?: string; copyFrom?: string };
export type StagePlan = {
  root: string;
  langs: readonly ArtifactLang[];
  files: Record<string, FilePlan>;
  /** 落盘前必须存在的仓内源目录；缺席即报错，不用旧产物冒充新产物。 */
  prerequisites: string[];
};

const PY_ADAPTER_IMPORT = `${PY_PACKAGE}.adapter`;

/** 每种语言的工件目录必须齐备的件：README / 许可 / metadata / 入口或数据文件 / 示例。 */
export function requiredFiles(): string[] {
  return [
    'typescript/README.md',
    'typescript/NOTICE.md',
    'typescript/package.json',
    'typescript/index.ts',
    'typescript/tsconfig.build.json',
    'typescript/rules.json',
    'typescript/examples/basic.ts',
    'python/README.md',
    'python/NOTICE.md',
    'python/pyproject.toml',
    `python/${PY_PACKAGE}/rules.json`,
    `python/${PY_PACKAGE}/adapter.py`,
    'python/examples/basic.py',
    'go/README.md',
    'go/NOTICE.md',
    'go/go.mod',
    'go/go.sum',
    'go/rules.json',
    `go/${GO_ADAPTER_DIR}/version.go`,
    'go/examples/basic.go',
  ];
}

/** 递归列源目录，产出 `{ 源相对路径: 工件相对路径 }`。跳过 Python 字节码缓存与 Go 测试文件。 */
function walk(srcDir: string, destPrefix: string, skip: (rel: string) => boolean = () => false): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(srcDir)) return out;
  const rec = (dir: string, relIn: string): void => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      const rel = posix.join(relIn, name).replace(/^\/+/, '');
      if (skip(rel)) continue;
      if (statSync(abs).isDirectory()) {
        rec(abs, rel);
      } else {
        out[`${srcDir}/${rel}`.replace(/\\/g, '/')] = posix.join(destPrefix, rel);
      }
    }
  };
  rec(srcDir, '');
  return out;
}

function noticeFor(lang: ArtifactLang, ctx: { version: string; anchor: string }): string {
  const base = readFileSync('spec/NOTICE.md', 'utf8').trim();
  return `${base}

---

本目录（\`${ARTIFACT_DIRS[lang]}/\`）是上述派生产物的**出口工件**，含类型化调用面与手写行为适配层，
契约版本 \`${ctx.version}\`、上游锚点 \`${ctx.anchor.slice(0, 7)}\`。
JSON 一类无注释语法的文件（\`package.json\`）不在文件内携带口径行，由本声明覆盖 —— 与 \`spec/NOTICE.md\`
对 \`anchor.json\`、\`extracted/*.json\` 的同一条豁免一致。
`;
}

function packageJson(ctx: { version: string }): string {
  return `${JSON.stringify(
    {
      name: TS_PACKAGE_NAME,
      version: ctx.version,
      type: 'module',
      main: './dist/index.js',
      types: './dist/index.d.ts',
      exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' } },
      files: ['dist', 'adapter', 'generated', 'rules.json', 'examples', 'NOTICE.md'],
      dependencies: {},
      license: 'SEE NOTICE.md',
      description: 'Derived SnowLuma WebUI admin API client (TypeScript) with behavior adapters. Not published to npm.',
    },
    null,
    2,
  )}\n`;
}

function pyprojectToml(ctx: { version: string }): string {
  return `# ${BANNER}
[build-system]
requires = ["setuptools>=68"]
build-backend = "setuptools.build_meta"

[project]
name = "${PY_DIST_NAME}"
version = "${ctx.version}"
description = "Derived SnowLuma WebUI admin API client (Python) with behavior adapters. Not published to PyPI."
requires-python = ">=3.12"
# 实测：生成腿用 httpx 传输、attrs 建模；适配层纯标准库。不写版本下限是因为本仓没有验过下限。
dependencies = ["httpx", "attrs"]

[tool.setuptools]
packages = ["${PY_PACKAGE}"]

[tool.setuptools.package-data]
# rules.json 必须是包内数据文件：wheel 装完读不到规则表 = 适配层静默不生效。
${PY_PACKAGE} = ["rules.json"]
`;
}

function goVersionGo(ctx: { version: string }): string {
  return `// ${BANNER}
package ${GO_ADAPTER_DIR}

// ContractVersion 是本工件所属契约的版本（真源：spec/openapi.yaml 的 info.version）。
// Go 的 module 元数据不携带版本，所以出口版本在这里给一处答案。
const ContractVersion = "${ctx.version}"
`;
}

function tsBuildTsconfig(): string {
  return `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "skipLibCheck": true,
    "types": ["node"],
    "declaration": true,
    "emitDeclarationOnly": true,
    "rootDir": ".",
    "outDir": "dist"
  },
  "include": ["index.ts"]
}
`;
}

/**
 * 出口入口：类型化调用面 + 行为适配层，同一个 specifier 拿到两半。
 * 不带 operations.ts（它读仓内 spec，属源仓工装；带出去就是一个读不到文件的默认值）。
 *
 * 两条显式声明不是装饰，是实测撞名的处置（改任何一侧前先跑一遍 tsc，别靠猜）：
 *  - `LoginError`：生成面（每操作错误并集）与适配层（bootstrap 失败类）同名。显式指定适配层
 *    那一支为规范名，同时把生成面那支另名给出 —— 两侧都可达，TS2308 也不会再来。
 *  - SDK 的 `createClient` 不在 `generated/index` 的出口面上（它在 client/client.gen），
 *    而适配层自己另有一个更高层的 `createClient`。故 SDK 那一支显式另名导出，
 *    避免"同一个名字在两层里指不同的东西"。
 */
function tsEntry(): string {
  return `// ${BANNER}
// 出口工件的入口：类型化调用面（生成码）与行为适配层（手写）从同一个 specifier 给出。
export * from './generated/index';
export * from './adapter/client';
export * from './adapter/rules';
export { LoginError } from './adapter/client';
export { LoginError as SdkLoginError } from './generated/index';
export { createClient as createSdkClient } from './generated/client/client.gen';
`;
}

export function buildStagingPlan(ctx: { version: string; anchor: string }, root = 'dist/clients'): StagePlan {
  const files: Record<string, FilePlan> = {};

  // ---- TypeScript ----
  for (const [src, dest] of Object.entries(walk('generated/typescript', `${ARTIFACT_DIRS.typescript}/generated`))) {
    files[dest] = { copyFrom: src };
  }
  for (const f of ['client.ts', 'rules.ts']) {
    files[`${ARTIFACT_DIRS.typescript}/adapter/${f}`] = { copyFrom: `adapters/typescript/${f}` };
  }
  files[`${ARTIFACT_DIRS.typescript}/index.ts`] = { content: tsEntry() };
  files[`${ARTIFACT_DIRS.typescript}/package.json`] = { content: packageJson(ctx) };
  files[`${ARTIFACT_DIRS.typescript}/tsconfig.build.json`] = { content: tsBuildTsconfig() };
  files[`${ARTIFACT_DIRS.typescript}/rules.json`] = { copyFrom: 'adapters/rules.json' };
  files[`${ARTIFACT_DIRS.typescript}/README.md`] = { content: renderReadme('typescript', ctx) };
  files[`${ARTIFACT_DIRS.typescript}/NOTICE.md`] = { content: noticeFor('typescript', ctx) };
  files[`${ARTIFACT_DIRS.typescript}/examples/basic.ts`] = { content: renderExample('typescript') };

  // ---- Python ----
  for (const [src, dest] of Object.entries(
    walk('generated/python', `${ARTIFACT_DIRS.python}/${PY_PACKAGE}`, (rel) => rel.startsWith('__pycache__')),
  )) {
    files[dest] = { copyFrom: src };
  }
  files[`${ARTIFACT_DIRS.python}/${PY_PACKAGE}/adapter.py`] = { copyFrom: 'adapters/python/snowluma_adapter.py' };
  files[`${ARTIFACT_DIRS.python}/${PY_PACKAGE}/rules.json`] = { copyFrom: 'adapters/rules.json' };
  files[`${ARTIFACT_DIRS.python}/pyproject.toml`] = { content: pyprojectToml(ctx) };
  files[`${ARTIFACT_DIRS.python}/README.md`] = { content: renderReadme('python', ctx) };
  files[`${ARTIFACT_DIRS.python}/NOTICE.md`] = { content: noticeFor('python', ctx) };
  files[`${ARTIFACT_DIRS.python}/examples/basic.py`] = { content: renderExample('python') };

  // ---- Go ----
  for (const [src, dest] of Object.entries(
    walk(`generated/go/${GO_PACKAGE_DIR}`, `${ARTIFACT_DIRS.go}/${GO_PACKAGE_DIR}`),
  )) {
    files[dest] = { copyFrom: src };
  }
  // 适配层源码搬进同一 module；**必须剥掉 adapters/go 自己的 go.mod / go.sum** ——
  // 那份带 `replace example.com/sl/generated => ../../generated/go`，留在子目录里会构成
  // 嵌套 module：Go 认为 adapters/ 属另一个模块，于是 example 里的 import 解析不到适配层。
  // 这是"带不出仓"最隐蔽的一种形状：文件确实在，路径也合法，只是语义换了一个模块边界。
  for (const [src, dest] of Object.entries(
    walk('adapters/go', `${ARTIFACT_DIRS.go}/${GO_ADAPTER_DIR}`, (rel) => rel.endsWith('_test.go') || rel === 'go.mod' || rel === 'go.sum'),
  )) {
    files[dest] = { copyFrom: src };
  }
  // go.mod / go.sum 直接沿用生成物自己的那份（依赖清单的真源在生成器，不在这里）：
  // 它不含 replace，而 adapters/go/go.mod 的 replace 正是带不出仓的那一条，故意不采纳。
  files[`${ARTIFACT_DIRS.go}/go.mod`] = { content: readFileSync('generated/go/go.mod', 'utf8') };
  files[`${ARTIFACT_DIRS.go}/go.sum`] = { content: readFileSync('generated/go/go.sum', 'utf8') };
  files[`${ARTIFACT_DIRS.go}/rules.json`] = { copyFrom: 'adapters/rules.json' };
  files[`${ARTIFACT_DIRS.go}/${GO_ADAPTER_DIR}/version.go`] = { content: goVersionGo(ctx) };
  files[`${ARTIFACT_DIRS.go}/README.md`] = { content: renderReadme('go', ctx) };
  files[`${ARTIFACT_DIRS.go}/NOTICE.md`] = { content: noticeFor('go', ctx) };
  files[`${ARTIFACT_DIRS.go}/examples/basic.go`] = { content: renderExample('go') };

  return {
    root,
    langs: ['typescript', 'python', 'go'],
    files,
    prerequisites: ['generated/typescript', 'generated/python', 'generated/go', 'adapters', 'spec/NOTICE.md'],
  };
}

/** 落盘前的存在性核对：缺源即点名退出，绝不用旧产物冒充新产物。 */
export function missingPrerequisites(plan: StagePlan): string[] {
  return plan.prerequisites.filter((p) => !existsSync(p));
}

/** 供 package-clients 与 smoke 共用：工件根 + 语言目录的绝对拼接口径。 */
export function artifactDir(root: string, lang: ArtifactLang): string {
  return join(root, ARTIFACT_DIRS[lang]);
}

export { GO_MODULE_ID, PY_PACKAGE, PY_ADAPTER_IMPORT, TS_PACKAGE_NAME };
