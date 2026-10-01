// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
/**
 * 出口闸 `npm run smoke:clients`：在**仓外临时目录**里把三个工件真装、真解析入口、真跑示例。
 *
 * 为什么需要它：源码树全绿不等于交付物可消费。本仓所有既有门禁都跑在仓根，于是
 * "路径带不出仓""exports 指错""装完读不到规则表"这三类失效在链上一条都看不见 ——
 * 而它们恰恰是 Release 工件唯一会被消费者真正碰到的三件事。
 *
 * 三层各成一键、不合并也不短路：`installed && ok` 这种形状会把"入口不对"和"没装上"
 * 糊成同一条红，而两者的处置动作完全不同（红时逐条打印恢复动作）。
 *
 * 设施故障（npm / python / go 起不来）退 2，与判定红（退 1）分开：「没验」既不能读成
 * 「验不过」，更不能读成「验过」。本闸不连任何真实实例，示例全走注入的假传输。
 *
 * 探针一律先落成文件再执行：shell:true 下在命令行里嵌引号写 JS/Python 是多行字符串的经典炸点。
 */
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { isCliEntry } from './lib/cli.js';
import { envWithGo } from './lib/go-toolchain.js';
import { ARTIFACT_DIRS, ARTIFACT_ROOT, GO_MODULE_ID, PY_DIST_NAME, PY_PACKAGE, TS_PACKAGE_NAME, type ArtifactLang } from './lib/client-artifact.js';
import { OK_TOKEN } from './lib/client-templates.js';

/** 设施故障的退出码，与判定红（1）分开。 */
export const FACILITY_EXIT = 2;

export interface LangResult {
  installed: boolean;
  entryOk: boolean;
  ranOk: boolean;
  detail: string;
}

export interface SmokeReport {
  langs: Partial<Record<ArtifactLang, LangResult>>;
  /** 设施缺件时非空：判定根本没成立，退出码与"验不过"分开。 */
  facility?: string[];
}

/** 三语齐备是判定成立的前提：少一门就是"没验那一门"，不许算通过。空清单同样红。 */
export function exitCodeFor(report: SmokeReport): number {
  if (report.facility?.length) return FACILITY_EXIT;
  const entries = Object.values(report.langs) as LangResult[];
  if (entries.length !== 3) return 1;
  return entries.every((r) => r.installed && r.entryOk && r.ranOk) ? 0 : 1;
}

export function summarizeLine(lang: ArtifactLang, r: LangResult): string {
  const mark = (b: boolean) => (b ? '✓' : '✗');
  return `${lang} 装=${mark(r.installed)} 入口=${mark(r.entryOk)} 跑=${mark(r.ranOk)}${r.detail ? ` — ${r.detail}` : ''}`;
}

interface RunResult {
  code: number | null;
  out: string;
}

function run(cmd: string, cwd: string, timeoutMs = 420_000): RunResult {
  // Go 不写系统 PATH（tools.lock.json → goInstall.notPersisted）：出口闸与 test:go-adapter
  // 必须用同一份兜底，否则同一条链会出现"go 腿一条能跑、另一条喊缺工具"的分叉。
  // 合并动作也住在那里 —— 本机 env 的键名可能是 `Path`，自己拼一个大写 PATH 会得到两份
  // 大小写不同的副本，谁覆盖谁取决于运行时（这条在 tools/lib/go-toolchain.ts 里已被记过一次）。
  const { env } = envWithGo({ ...process.env, GOTOOLCHAIN: 'local' } as NodeJS.ProcessEnv);
  const r = spawnSync(cmd, { cwd, encoding: 'utf8', shell: true, timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'], env });
  const err = r.error as (NodeJS.ErrnoException & { signal?: string }) | undefined;
  if (err && (err.code === 'ENOENT' || err.code === 'ETIMEDOUT')) {
    return { code: null, out: `FACILITY: ${err.code} ${err.message}` };
  }
  // 超时是被信号杀掉的：那属"没验"，写成判定红就等于把设施故障算成工件不合格。
  if (r.status === null && r.signal) {
    return { code: null, out: `FACILITY: 子进程被 ${r.signal} 终止（上限 ${timeoutMs}ms）` };
  }
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}

function lastLines(s: string, n = 3): string {
  return s
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '')
    .slice(-n)
    .join(' | ')
    .slice(0, 400);
}

function contractVersion(): string {
  return (parseYaml(readFileSync('spec/openapi.yaml', 'utf8')) as { info: { version: string } }).info.version;
}

/**
 * 设施探针：缺哪几样就返回哪几样。
 * 不在这里 process.exit —— 以前它直接退，把外层的 `finally`（清理临时目录）整个跳过，
 * 每次设施红都在系统临时目录里留一份装了半套的垃圾。判定与清场分开，谁都不许抢跑。
 */
export function facilitiesMissing(cwd: string): string[] {
  const missing: string[] = [];
  for (const [name, cmd] of [
    ['npm', 'npm -v'],
    ['python', 'python -V'],
    ['go', 'go env GOVERSION'],
  ] as const) {
    const r = run(cmd, cwd, 60_000);
    if (r.code !== 0) missing.push(`${name}（退 ${r.code}：${lastLines(r.out, 1)}）`);
  }
  return missing;
}

export function facilityNote(missing: string[]): string {
  return (
    `设施缺件，判定不成立：${missing.join('、')}\n` +
    '  恢复动作：见 docs/getting-started/installation.md。Go 不写系统 PATH，需按锁里的 GOROOT 前置；' +
    'Python 腿用系统 python 即可（纯标准库）。\n' +
    '  本闸不静默跳过任何一门语言。'
  );
}

const venvPython = (venv: string) =>
  join(venv, process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'python.exe' : 'python');

async function smokeTypeScript(artifact: string, tmp: string, version: string): Promise<LangResult> {
  const r: LangResult = { installed: false, entryOk: false, ranOk: false, detail: '' };
  const proj = join(tmp, 'ts');
  mkdirSync(proj, { recursive: true });
  writeFileSync(join(proj, 'package.json'), '{ "name": "smoke-ts", "private": true, "type": "module" }\n', 'utf8');

  /**
   * 装的是 `npm pack` 出来的 tgz，不是工件目录。
   * 为什么：目录安装在本机 npm 10.9.8 实测是把 node_modules/<pkg> 做成**指向工件目录的符号链接**，
   * 于是"仓外真装"这一层对 TS 并不成立，package.json 的 `files` 白名单也永远走不到（漏一件
   * 只有 pack 之后才发现）。Go 腿为此专门复制工件（见 smokeGo），TS 腿不许例外。
   */
  const packed = run(`npm pack --pack-destination "${tmp}"`, artifact);
  const tgz = (packed.out.match(/[\w.-]+\.tgz/g) ?? []).pop();
  if (packed.code !== 0 || !tgz) {
    r.detail = `npm pack 退 ${packed.code}：${lastLines(packed.out)}`;
    return r;
  }
  const inst = run(`npm install "${join(tmp, tgz)}" --no-audit --no-fund --loglevel=error`, proj);
  if (inst.code !== 0) {
    r.detail = `npm install 退 ${inst.code}：${lastLines(inst.out)}`;
    return r;
  }
  r.installed = true;

  /**
   * 声明的入口文件必须真实存在。
   * 为什么不能只靠 tsc：把 types 指到一个不存在的 .d.ts，tsc 会**静默回落**到 main 旁边的
   * 同名声明文件然后编译通过（变异检验实测：smoke 整条仍绿）。也就是说"能编译"证明不了
   * "package.json 承诺的入口就是那个文件"，而消费者按承诺的路径去取就是取不到。
   */
  const pkgDir = join(proj, 'node_modules', TS_PACKAGE_NAME);
  const meta = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as {
    version?: string;
    main?: string;
    types?: string;
    exports?: Record<string, Record<string, string>>;
  };
  const declared = [
    meta.main,
    meta.types,
    meta.exports?.['.']?.types,
    meta.exports?.['.']?.import,
  ].filter((p): p is string => typeof p === 'string');
  const absentFiles = declared.filter((p) => !existsSync(join(pkgDir, p)));
  if (meta.version !== version) {
    r.detail = `已装版本 ${meta.version} ≠ 契约版本 ${version}`;
    return r;
  }
  if (absentFiles.length) {
    r.detail = `package.json 声明的入口文件不存在：${absentFiles.join(', ')}`;
    return r;
  }

  /**
   * README 里"见同目录 X"承诺的每一件，必须真的在**装好之后**的包目录里。
   * 为什么计划级断言不够（client-staging.test.ts 已经钉过一次成员）：npm 只按 package.json
   * 的 `files` 白名单装包，计划里有、白名单没写 = 目录里在、装完没有。这类失效只在
   * shipped bytes 上现形，而上一轮就是这样漏掉 provenance.json 的。
   */
  const readmePath = join(pkgDir, 'README.md');
  if (!existsSync(readmePath)) {
    r.detail = '装好的包里没有 README.md（工件自带的安装说明没进白名单）';
    return r;
  }
  const promised = [...readFileSync(readmePath, 'utf8').matchAll(/同目录 `([^`]+)`/g)].map((m) => m[1]);
  const missingPromised = promised.filter((p) => !existsSync(join(pkgDir, p)));
  if (missingPromised.length) {
    r.detail = `README 承诺的同目录文件没进包：${missingPromised.join(', ')}（package.json 的 files 白名单漏写）`;
    return r;
  }
  if (!promised.length) {
    r.detail = 'README 里没有一条"同目录"承诺 —— 本层断言已空转，判红而不是判过';
    return r;
  }

  // 入口判据落成脚本再跑：验"README/example 承诺的符号"真的从包名可达。
  writeFileSync(
    join(proj, 'probe.mjs'),
    `import * as pkg from '${TS_PACKAGE_NAME}';
const need = ['login', 'getSystem', 'createClient', 'applyRules', 'createSdkClient'];
const missing = need.filter((k) => typeof pkg[k] !== 'function');
if (missing.length) { console.error('MISSING ' + missing.join(',')); process.exit(1); }
console.log('ENTRY_OK');
`,
    'utf8',
  );
  const entry = run('node probe.mjs', proj);
  if (entry.code !== 0) {
    r.detail = `入口解析退 ${entry.code}：${lastLines(entry.out)}`;
    return r;
  }

  // 类型面：把工件自带的示例拷进装了包的项目里，用发布方承诺的解析形态 tsc 一次。
  mkdirSync(join(proj, 'examples'), { recursive: true });
  cpSync(join(artifact, 'examples/basic.ts'), join(proj, 'examples/basic.ts'));
  const tscBin = resolve('node_modules/typescript/bin/tsc');
  const types = run(
    `node "${tscBin}" --noEmit --strict --target es2022 --module esnext --moduleResolution bundler examples/basic.ts`,
    proj,
  );
  if (types.code !== 0) {
    r.detail = `类型面不过：${lastLines(types.out)}`;
    return r;
  }
  r.entryOk = true;

  /**
   * 示例打包走 esbuild 的 **JS API**，不是 `node node_modules/esbuild/bin/esbuild`。
   * verify-posix 首航实测：Linux 上那个文件被 esbuild 的 install.js（`os.platform() !== 'win32'`
   * 那条分支）换成**原生二进制**并 chmod +x，node 加载它直接崩在 run_main；
   * Windows 上那里留的是 JS shim，所以本机永远跑得绿 —— 又是一条"只在作者机器成立"的绿。
   * 打包器 package-clients.ts 一直用同一个 API，两条腿本来就该同形。
   */
  try {
    await build({
      entryPoints: [join(proj, 'examples/basic.ts')],
      outfile: join(proj, 'examples/basic.mjs'),
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'es2022',
      absWorkingDir: proj,
      logLevel: 'silent',
    });
  } catch (e) {
    // esbuild 的错误正文在**前面**（消息 + 定位），用 tail 三行只会看到 Node 的收尾栈——
    // 上一轮排查就是被这个截断误导过一次。
    const text = (e as Error).message ?? String(e);
    r.detail = `示例打包失败：${text.split(/\r?\n/).slice(0, 4).join(' | ').slice(0, 400)}`;
    return r;
  }
  const exe = run('node examples/basic.mjs', proj);
  if (exe.code === 0 && exe.out.includes(`${OK_TOKEN.typescript} true`)) {
    r.ranOk = true;
  } else {
    r.detail = `示例跑不通（退 ${exe.code}）：${lastLines(exe.out)}`;
  }
  return r;
}

function smokePython(artifact: string, tmp: string, version: string): LangResult {
  const r: LangResult = { installed: false, entryOk: false, ranOk: false, detail: '' };
  const proj = join(tmp, 'py');
  mkdirSync(proj, { recursive: true });
  const venv = join(proj, 'venv');

  const mk = run(`python -m venv "${venv}"`, proj);
  if (mk.code !== 0) {
    r.detail = `venv 起不来：${lastLines(mk.out)}`;
    return r;
  }
  const py = venvPython(venv);
  const inst = run(`"${py}" -m pip install --quiet "${artifact}"`, proj);
  if (inst.code !== 0) {
    r.detail = `pip install 退 ${inst.code}：${lastLines(inst.out)}`;
    return r;
  }
  r.installed = true;

  writeFileSync(
    join(proj, 'probe.py'),
    `import importlib.metadata as md
from ${PY_PACKAGE} import adapter
from ${PY_PACKAGE} import Client

def transport(method, path, opts=None):
    return (200, {"success": True, "token": "t", "mustChangePassword": False})

# 不传 rules_path：装包后必须自己读到包内 rules.json（读不到就抛 RulesError）
client = adapter.SnowlumaClient(transport=transport)
print("ENTRY_OK", md.version("${PY_DIST_NAME}"), client.token is None, Client is not None)
`,
    'utf8',
  );
  const entry = run(`"${py}" probe.py`, proj);
  if (entry.code !== 0 || !entry.out.includes(`ENTRY_OK ${version} True True`)) {
    r.detail = `入口不对：${lastLines(entry.out)}（期望 ENTRY_OK ${version} True True）`;
    return r;
  }
  r.entryOk = true;

  const exe = run(`"${py}" "${join(artifact, 'examples/basic.py')}"`, proj);
  if (exe.code === 0 && exe.out.includes(`${OK_TOKEN.python} True`)) {
    r.ranOk = true;
  } else {
    r.detail = `示例跑不通（退 ${exe.code}）：${lastLines(exe.out)}`;
  }
  return r;
}

function smokeGo(artifact: string, tmp: string, version: string): LangResult {
  const r: LangResult = { installed: false, entryOk: false, ranOk: false, detail: '' };
  const proj = join(tmp, 'go');
  mkdirSync(proj, { recursive: true });
  // 复制而不是原地引用：复制证明"这一坨自身完整"，原地引用会替缺项打掩护。
  cpSync(artifact, join(proj, ARTIFACT_DIRS.go), { recursive: true });
  const dir = join(proj, ARTIFACT_DIRS.go);

  const work = run('go work init .', dir);
  if (work.code !== 0) {
    r.detail = `go work init 失败：${lastLines(work.out)}`;
    return r;
  }
  r.installed = true;

  const list = run('go list -m', dir);
  if (list.code !== 0 || list.out.trim() !== GO_MODULE_ID) {
    r.detail = `module 路径不是承诺的 ${GO_MODULE_ID}（实为 ${lastLines(list.out, 1)}）`;
    return r;
  }
  /**
   * 工件里不该出现 replace（尤其不该指回仓内布局）。
   * 为什么不能靠编译来判：把 `replace example.com/sl/generated => ../../generated/go` 塞回
   * 工件的 go.mod，go build 照样绿（自替换被忽略），变异检验实测漏过 —— 但带不出仓的
   * 路径就是带不出仓，这与编译成不成立无关。
   */
  const modFile = readFileSync(join(dir, 'go.mod'), 'utf8');
  if (/^replace\b/m.test(modFile)) {
    r.detail = 'go.mod 含 replace 行（带不出仓的路径配置）';
    return r;
  }
  const buildRun = run('go build ./...', dir);
  if (buildRun.code !== 0) {
    r.detail = `编译不过：${lastLines(buildRun.out)}`;
    return r;
  }
  r.entryOk = true;

  const exe = run('go run ./examples', dir);
  if (exe.code === 0 && exe.out.includes(`${OK_TOKEN.go} ${version}`)) {
    r.ranOk = true;
  } else {
    r.detail = `示例跑不通（退 ${exe.code}）：${lastLines(exe.out)}`;
  }
  return r;
}

export async function runSmoke(root = resolve(ARTIFACT_ROOT), workDir = mkdtempSync(join(tmpdir(), 'sl-smoke-'))): Promise<SmokeReport> {
  const version = contractVersion();
  try {
    const facility = facilitiesMissing(process.cwd());
    if (facility.length) return { langs: {}, facility };
    return {
      langs: {
        typescript: await smokeTypeScript(join(root, ARTIFACT_DIRS.typescript), workDir, version),
        python: smokePython(join(root, ARTIFACT_DIRS.python), workDir, version),
        go: smokeGo(join(root, ARTIFACT_DIRS.go), workDir, version),
      },
    };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

if (isCliEntry(import.meta.url, process.argv[1])) {
  const report = await runSmoke();
  if (report.facility?.length) console.error(facilityNote(report.facility));
  for (const [lang, res] of Object.entries(report.langs)) {
    const r = res as LangResult;
    const pass = r.installed && r.entryOk && r.ranOk;
    console.log(`${pass ? '✓' : '✗'} ${summarizeLine(lang as ArtifactLang, r)}`);
  }
  const code = exitCodeFor(report);
  if (code === 1) {
    console.error(
      '出口闸未通过。逐层对照：\n' +
        '  装不上 → npm/pip/go 是否可用、工件目录是否齐备（npm run package:clients 会点名缺项）\n' +
        '  入口不对 → package.json 的 main/types/exports、pyproject 的 packages 与 package-data、go.mod 的 module 行\n' +
        '  跑不动 → 规则表是否随包、适配层是否在同一 module 内\n' +
        '  禁止的处置：放宽本闸、跳过某门语言、或把红解释成环境问题后照常发布',
    );
  }
  console.log(
    code === 0
      ? '出口闸三层全真 ✓'
      : code === FACILITY_EXIT
        ? `出口闸**没有跑**（设施缺件，exit ${FACILITY_EXIT}）—— 这既不是通过也不是判定红`
        : `出口闸判定红（exit ${code}）`,
  );
  process.exit(code);
}
