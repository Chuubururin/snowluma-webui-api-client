// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
/**
 * 三语客户端生成器的统一入口。
 *
 * 职责：按 `tools.lock.json` 里的 pin 拼出三条命令、逐条执行、执行后**校验许可头部是否真的落进产物**。
 * 不做：不重新探测版本（读 lock）、不改 `generated/` 内容、不装包。
 *
 * 为什么"校验头部"是这里必须的一步，而不是可选项：
 * `tools.lock.json → generationConstraints` 记了三条静默失败路径 —— Python 侧 venv 的 Scripts 不在
 * PATH 上时 ruff 与 post_hooks 全部跳过（每文件只打印一句 'Skipping Integration'，exit 仍是 0）；
 * hey-api 的 `output.header` 是替换语义，配置写错键名就是没有头；oapi-codegen 的模板副本一旦与
 * pin 版本分叉，头部同样会消失。三家的共同点是**缺头部不会让命令失败**，所以只能事后取证。
 *
 * 用法：`node_modules/.bin/tsx tools/gen/run.ts [typescript|python|go]`
 * （Go 侧要 `go` 与 oapi-codegen 可执行：两者分别落在锁记的 GOROOT/bin 与 <GOPATH>/bin，
 *  本脚本按 tools.lock.json 推导后前置进子进程 PATH —— Go 按 notPersisted 裁定不写系统 PATH，
 *  所以操作者的终端里没有它们也能跑。）
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';
import { isCliEntry } from '../lib/cli.js';
import { GO_MODULE_ID } from '../lib/client-artifact.js';
import { goToolchainDirs } from '../lib/go-toolchain.js';
import { runDemoGen } from './demo/index.js';

export const BANNER = '派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器';
export const SPEC_PATH = 'spec/openapi.yaml';

/** 只取本脚本会用到的那几项；其余 lock 字段原样忽略。 */
export interface LockForGen {
  generators: Record<string, string | undefined>;
  runtimes?: Record<string, string | undefined>;
  generationConstraints?: Record<string, { peerTypeScript?: string } | undefined>;
}

export type GenLang = 'typescript' | 'python' | 'go';

export interface GenCommand {
  lang: GenLang;
  argv: string[];
  env?: Record<string, string>;
  /**
   * Windows 下 npx 是 `npx.cmd`，而 Node 起子进程时不会自动补 PATHEXT
   * （实测 spawnSync('npx', …) → ENOENT；spawnSync('oapi-codegen', …) → 0，因为 libuv 会试 `.exe`；
   * .cmd 因 CVE-2024-27980 必须走 shell）。所以只有 TS 那条要 shell:true，
   * 相应地 argv 里**不允许**出现空格与引号 —— npx 的 `-p 'pkg@ver'` 这里写成 `-p pkg@ver`。
   */
  shell?: boolean;
  why: string;
}

/** venv 的可执行目录（客户端批次自建，入库说明见 python-config.yml 与本文件；不入库由 .gitignore 保证）。 */
export const VENV_BIN_DIR = join('.venv-gen', process.platform === 'win32' ? 'Scripts' : 'bin');
/** venv 里的解释器名，同样按平台分叉（Windows `python.exe` / POSIX `python`）。 */
export const VENV_PY = join(VENV_BIN_DIR, process.platform === 'win32' ? 'python.exe' : 'python');

function pin(lock: LockForGen, key: string): string {
  const v = lock.generators[key];
  if (!v) throw new Error(`tools.lock.json 缺 generators["${key}"] —— 禁止凭记忆补版本号`);
  return v;
}

/**
 * 只改 PATH 这一个键。
 * Windows 下 process.env 里的实际键名是 `Path`；直接塞一个大写 `PATH` 会得到两份大小写不同的副本，
 * 谁覆盖谁取决于运行时 —— 所以先按大小写无关地把原键名找出来再改。
 */
function withPathFront(dir: string | string[]): Record<string, string> {
  const key = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  const cur = process.env[key] ?? '';
  const dirs = (Array.isArray(dir) ? dir : [dir]).map((d) => resolve(d));
  return { [key]: [...dirs, cur].filter(Boolean).join(delimiter) };
}

/**
 * Go 腿的两类可执行文件不在同一个目录：`go` 在锁记的 GOROOT/bin，`go install` 出来的
 * oapi-codegen 在 <GOPATH>/bin。冷克隆实测：只借 GOROOT 时 generate 的 Go 腿照样 ENOENT，
 * 而它报的"环境问题"其实是我们没按自己的文档去推导目录。
 */
function goPathEnv(): Record<string, string> {
  const dirs = goToolchainDirs();
  return dirs.length ? withPathFront(dirs) : {};
}

/**
 * 提示里只写推导出来的目录或安装动作，不写任何具体机器的路径 ——
 * 冷克隆实测到的原话把作者机器 GOROOT 与 GOPATH 两个目录逐字写死在 export 里，
 * 换一台机器它就是一条把人往不存在的目录引的假恢复动作。
 */
function goPathHint(oapi?: string): string {
  const dirs = goToolchainDirs();
  const where = dirs.length
    ? `本机推导到的可执行目录：${dirs.join(delimiter)}`
    : '没推导到 Go 的可执行目录：按 docs/getting-started/installation.md 第 3 步装 Go（版本取自 tools.lock.json）。';
  const install = oapi
    ? `\n  oapi-codegen 不在上面这些目录里时先装：go install github.com/oapi-codegen/oapi-codegen/v2/cmd/oapi-codegen@${oapi}`
    : '';
  return `  Go 工具链不写系统 PATH（tools.lock.json → goInstall.notPersisted）。${where}${install}`;
}

/** 三条命令逐字来自 tools.lock.json 与 spike/findings.md（含 Q6 的实测校正），禁止凭记忆改。 */
export function genCommands(lock: LockForGen): GenCommand[] {
  const hey = pin(lock, 'hey-api-openapi-ts');
  const opc = pin(lock, 'openapi-python-client');
  const oapi = pin(lock, 'oapi-codegen');
  const peerTs = lock.generationConstraints?.['hey-api-openapi-ts']?.peerTypeScript;
  if (!peerTs) {
    throw new Error(
      'tools.lock.json 缺 generationConstraints["hey-api-openapi-ts"].peerTypeScript —— ' +
        'hey-api 必须配 typescript@5.x 跑，裸取 peer 会拿到 TS 7 并在 import 期崩（findings 偏差 1）',
    );
  }
  return [
    {
      lang: 'typescript',
      // typescript@5.9.3 是硬约束：hey-api 0.99.0 的 peer 会取到 TS 7 并在 import 期崩
      argv: [
        'npx', '-y',
        '-p', `@hey-api/openapi-ts@${hey}`,
        '-p', `typescript@${peerTs}`,
        'openapi-ts',
        // 配置文件形态：CLI 无 --header，头部只能走 output.header；
        // 计划草稿写的 `-c <cfg>` 是 `--client <name>`（实测 --help），配置文件是 `-f/--file`。
        '-f', 'tools/gen/hey-api.config.ts',
      ],
      shell: true,
      why: `hey-api ${hey} + typescript ${peerTs}（peer 硬约束）· 头部走 output.header`,
    },
    {
      lang: 'python',
      // 实测校正（0.29.1 `generate --help`）：没有 -c/-p/-o 短参数，spec 走 `--path`；
      // 重跑必须 `--overwrite`，否则"Directory already exists"直接拒绝（findings Q6）。
      argv: [
        VENV_PY,
        '-m', 'openapi_python_client', 'generate',
        '--path', SPEC_PATH,
        '--output-path', 'generated/python',
        '--config', 'tools/gen/python-config.yml',
        '--meta', 'none',
        '--overwrite',
      ],
      // venv 的 Scripts 必须在 PATH 上，否则 ruff 与 post_hooks 静默跳过 → 头部消失。
      // 走 venv 解释器（`-m openapi_python_client`）本身不受这条影响，容易只看到"生成成功"。
      env: withPathFront(VENV_BIN_DIR),
      why: `openapi-python-client ${opc} · 头部走 post_hooks · venv Scripts 前置进 PATH`,
    },
    {
      lang: 'go',
      // 实测校正（v2.8.0 `--help`）：没有 `-templates.addPayload` 这个 flag（报
      // `flag provided but not defined`）。模板覆盖放在 config 的 `user-templates` 里，
      // CLI 侧只需要 --config。
      argv: ['oapi-codegen', '--config', 'tools/gen/oapi-codegen.yaml', SPEC_PATH],
      env: { GOTOOLCHAIN: 'local', ...goPathEnv() },
      why: `${oapi} 无 --include/--header，走 config 的 output-options.user-templates 覆盖 imports.tmpl；GOTOOLCHAIN 钉 local；GOROOT/bin 与 <GOPATH>/bin 从 tools.lock.json 推导后前置`,
    },
  ];
}

/** 各语言的产物目录与需要头部校验的文件后缀。 */
export const OUTPUTS: Record<GenLang, { dir: string; exts: string[] }> = {
  typescript: { dir: 'generated/typescript', exts: ['.ts'] },
  python: { dir: 'generated/python', exts: ['.py'] },
  go: { dir: 'generated/go', exts: ['.go'] },
};

async function* walkFiles(dir: string): AsyncGenerator<string> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walkFiles(p);
    else yield p;
  }
}

/**
 * 头部取证：产物目录里每一个该语言源文件，前 5 行内必须出现 BANNER。
 * Python 侧尤其不能省 —— post_hook 被跳过时生成命令仍返回 0（见文件头注释）。
 */
export async function filesMissingHeader(lang: GenLang): Promise<string[]> {
  const { dir, exts } = OUTPUTS[lang];
  if (!existsSync(dir)) return [`${dir} <整个目录不存在>`];
  const bad: string[] = [];
  let scanned = 0;
  for await (const f of walkFiles(dir)) {
    if (!exts.some((x) => f.endsWith(x))) continue;
    scanned++;
    const head = (await readFile(f, 'utf8')).split(/\r?\n/).slice(0, 5);
    if (!head.some((line) => line.includes(BANNER))) bad.push(f);
  }
  // 零个文件必须算失败。"没有任何文件缺横幅"在 scanned=0 时字面为真，却什么都没证明：
  // 后缀改名、产物目录形状变化、或上面那行过滤条件写歪，都会让它打印"产物齐备"。
  // 这里是全管线唯一的横幅执法点（生成器自己在 post_hook 被跳过时仍返回 0），
  // 所以它不许有一种"安静通过"的输入 —— 评审把它定为 Important。
  if (scanned === 0) return [`${dir} <扫到 0 个 ${exts.join('/')} 文件，无从证明横幅存在>`];
  return bad;
}

export async function readLock(): Promise<LockForGen> {
  return JSON.parse(await readFile('tools.lock.json', 'utf8')) as LockForGen;
}

/**
 * 产物血统戳（终审 A4）：把"这批 generated/ 出自哪份 spec、哪三个 pin、哪个时刻"落盘。
 * 为什么必须显式写：头部注入按 lock → headerMechanism **替换**掉生成器默认头，
 * 三家产物里因此一枚版本戳都不剩 —— "probe 绿"此前与"有人手改过 generated/"完全相容。
 * 消费方是 tools/gen/probe.py（比对 spec sha 后才继续信任产物）。generated/ 被 .gitignore
 * 排除，本文件随之不入仓 —— 它是构建副产物的收据，不是源码。
 */
export const PROVENANCE_PATH = join('generated', '.provenance.json');

export interface Provenance {
  banner: string;
  specPath: string;
  specSha256: string;
  generators: Record<string, string | undefined>;
  runtimes: Record<string, string | undefined>;
  /**
   * 本次**实际**生成成功的语言集（R1，prework P3-5）。旧收据不管跑了几个语言都长得一样，
   * `run.ts go` 单跑会写出一份声称"三语言出自当前 spec"的收据 ⇒ 血统检查在部分重生成时失效。
   * probe.py 的第四道按"齐全"判定：languages 不是全集就红，部分重生成不再能冒充全量。
   */
  languages: GenLang[];
  generatedAt: string;
}

export async function writeProvenance(
  lock: LockForGen,
  ran: readonly GenLang[],
  now = new Date(),
  dest = PROVENANCE_PATH,
): Promise<Provenance> {
  const spec = await readFile(SPEC_PATH);
  const p: Provenance = {
    banner: BANNER,
    specPath: SPEC_PATH,
    specSha256: createHash('sha256').update(spec).digest('hex'),
    generators: { ...lock.generators },
    runtimes: { ...(lock.runtimes ?? {}) },
    languages: [...ran],
    generatedAt: now.toISOString(),
  };
  await mkdir(resolve(dest, '..'), { recursive: true });
  await writeFile(dest, JSON.stringify(p, null, 2) + '\n', 'utf8');
  return p;
}

/** spawn 失败时 Node 给的是 Error 上挂 code/errno，类型里没有声明这一层。 */
function spawnReason(e: Error): string {
  return (e as NodeJS.ErrnoException).code ?? e.message;
}

/**
 * 半途失败时删除旧收据：不许「新产物 + 旧 provenance」的组合存在。
 * probe.py 按 spec sha 比对，旧收据配新产物会让部分重生成的失败静默通过。
 */
function invalidateProvenance(): void {
  try {
    if (existsSync(PROVENANCE_PATH)) unlinkSync(PROVENANCE_PATH);
  } catch {
    // 删不掉也不阻塞退出——失败路径的主要目的是不让旧收据背书新产物
  }
}

/**
 * 生成目录必须是 Go 模块，否则 adapters/go 无法 import 它。
 * 为什么由脚本而不是人工做：`generated/` 已在 .gitignore（裁定 N2），
 * 所以 `go.mod` 在新克隆里必然不存在 —— 一次性手工 init 等于把"能构建"变成只有作者机器成立的状态。
 */
async function initGoModuleIfMissing(): Promise<void> {
  const dir = 'generated/go';
  if (!existsSync(dir)) return;
  if (existsSync(join(dir, 'go.mod'))) return;
  const r = spawnSync('go', ['mod', 'init', GO_MODULE_ID], {
    cwd: dir,
    stdio: 'inherit',
    env: { ...process.env, ...goPathEnv(), GOTOOLCHAIN: 'local' },
  });
  if (r.error || r.status !== 0) {
    console.error(
      `go mod init 失败（${r.error ? spawnReason(r.error) : `exit ${r.status}`}）—— adapters/go 将无法解析导入。\n` +
        goPathHint(),
    );
    process.exit(r.status ?? 1);
  }
}

if (isCliEntry(import.meta.url, process.argv[1])) {
  const only = process.argv[2] as GenLang | 'demo' | undefined;
  if (only !== undefined && !['typescript', 'python', 'go', 'demo'].includes(only)) {
    console.error(`未知语言 ${JSON.stringify(only)}，可选 typescript | python | go | demo`);
    process.exit(2);
  }
  if (!existsSync(SPEC_PATH)) {
    console.error(`${SPEC_PATH} 不存在 —— 生成器没有输入，拒绝运行（不要用旧产物冒充新产物）`);
    process.exit(2);
  }

  if (only === 'demo') {
    const result = await runDemoGen({ specPath: SPEC_PATH });
    console.log(`demo gen: ${result.filesWritten.join(', ')}（${result.vocabularyOperations} 条操作）`);
    process.exit(0);
  }

  let lock: LockForGen;
  try {
    lock = await readLock();
  } catch (e) {
    console.error(`读不到 tools.lock.json：${(e as Error).message}`);
    process.exit(2);
  }
  // R1：逐语言成功后收集实际语言集，血统戳据此写 languages —— 单跑一语言时它就不是全集，
  // probe.py 的第四道（齐全判定）会让部分重生成的收据现出原形。
  const ran: GenLang[] = [];
  for (const cmd of genCommands(lock)) {
    if (only && cmd.lang !== only) continue;
    console.log(`$ ${cmd.argv.join(' ')}   # ${cmd.why}`);
    const r = spawnSync(cmd.argv[0], cmd.argv.slice(1), {
      stdio: 'inherit',
      shell: cmd.shell ?? false,
      env: { ...process.env, ...(cmd.env ?? {}) },
    });
    if (r.error) {
      const hint =
        cmd.lang === 'go'
          ? `\n${goPathHint(pin(lock, 'oapi-codegen'))}`
          : cmd.lang === 'python'
            ? `\n  需要先建 venv：python -m venv .venv-gen && ${VENV_PY} -m pip install "openapi-python-client==${pin(lock, 'openapi-python-client')}"`
            : '';
      console.error(`${cmd.lang} 起不来（${spawnReason(r.error)}）—— ${cmd.argv[0]} 不可执行？${hint}`);
      invalidateProvenance();
      process.exit(1);
    }
    if (r.status !== 0) {
      console.error(`${cmd.lang} 生成失败（exit ${r.status}）—— 不写半成品。`);
      invalidateProvenance();
      process.exit(r.status ?? 1);
    }
    if (cmd.lang === 'go') await initGoModuleIfMissing();
    const missing = await filesMissingHeader(cmd.lang);
    if (missing.length > 0) {
      console.error(
        `${cmd.lang} 生成物缺许可头部（前 5 行内没有 BANNER）：\n` +
          missing.map((f) => `  ${f}`).join('\n') +
          `\n  生成命令本身可能仍返回 0 —— 三家的头部机制都会静默失败，` +
          `详见 tools.lock.json → generationConstraints。`,
      );
      invalidateProvenance();
      process.exit(1);
    }
    ran.push(cmd.lang);
    console.log(`${cmd.lang}: 产物齐备，许可头部已落到每个文件`);
  }
  // 血统戳在全部请求的语言都成功之后才写：半途失败时旧收据配新产物的组合不许出现。
  // R1：languages 记录实际语言集 —— 部分重生成的收据会在 probe.py 的第四道现形。
  const prov = await writeProvenance(lock, ran);
  console.log(`generated/.provenance.json 已写入：spec sha256=${prov.specSha256.slice(0, 16)}… @ ${prov.generatedAt} · languages=[${prov.languages.join(', ')}]`);
}
