// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
/**
 * 出口工件的落盘器：把 tools/lib/client-staging.ts 的计划物化成 dist/clients/ 下三个自包含目录，
 * 并为 TypeScript 腿产出真正可安装的 dist（打包 JS + 类型声明）。
 *
 * 为什么必须打包而不是直接发 TS 源码：hey-api 产物用无扩展名相对导入（`from './sdk.gen'`），
 * `tsc` 直出的 ESM 里这些 specifier 在 Node 下必然 ENOENT。
 * 为什么 types 也落在 dist：`package.json` 的 `exports.types` 必须指向装包后真实存在的文件，
 * 指错不会让任何仓内门禁变红 —— 它由 tools/smoke-clients.ts 的「入口对」层执法。
 */
import { build } from 'esbuild';
import { copyFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { isCliEntry } from './lib/cli.js';
import { ARTIFACT_DIRS, BANNER } from './lib/client-artifact.js';
import { artifactDir, buildStagingPlan, missingPrerequisites, requiredFiles, type StagePlan } from './lib/client-staging.js';

interface Doc {
  info: { version: string };
}

function contractVersion(): string {
  const v = (parseYaml(readFileSync('spec/openapi.yaml', 'utf8')) as Doc).info.version;
  if (!/^\d+\.\d+\.\d+$/.test(v)) {
    console.error(`spec/openapi.yaml 的 info.version 不是三段 semver（实为 ${JSON.stringify(v)}）—— 出口 metadata 无从派生，拒绝打包。`);
    process.exit(2);
  }
  return v;
}

function anchorCommit(): string {
  const a = JSON.parse(readFileSync('spec/anchor.json', 'utf8')) as { commit?: string };
  if (!a.commit || !/^[0-9a-f]{40}$/.test(a.commit)) {
    console.error(`spec/anchor.json 的 commit 不是 40 位 SHA（实为 ${JSON.stringify(a.commit)}）—— 出处无从登记，拒绝打包。`);
    process.exit(2);
  }
  return a.commit;
}

export function materialize(plan: StagePlan): void {
  const root = resolve(plan.root);
  rmSync(root, { recursive: true, force: true });
  for (const [rel, entry] of Object.entries(plan.files)) {
    const dest = join(root, rel);
    mkdirSync(dirname(dest), { recursive: true });
    if (entry.copyFrom) {
      copyFileSync(entry.copyFrom, dest);
    } else if (entry.content !== undefined) {
      writeFileSync(dest, entry.content, 'utf8');
    } else {
      // 既无来源又无内容的计划项是编程错误，静默跳过就等于交付一个缺件工件。
      console.error(`计划项 ${rel} 既没有 copyFrom 也没有 content`);
      process.exit(1);
    }
  }
}

/** 齐备性核对：计划写了不等于盘上有。缺项逐条点名并退 1。 */
export function verifyPresent(root: string): string[] {
  return requiredFiles().filter((rel) => {
    const p = join(root, rel);
    return !existsFile(p);
  });
}

function existsFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** TS 腿的构建产物：打包 ESM + 类型声明。两步任一失败即点名退出。 */
async function buildTypeScriptArtifact(root: string): Promise<void> {
  const dir = artifactDir(root, 'typescript');
  const r = await build({
    entryPoints: [join(dir, 'index.ts')],
    outfile: join(dir, 'dist/index.js'),
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'es2022',
    absWorkingDir: dir,
    logLevel: 'warning',
  });
  if (r.errors.length) {
    console.error(`esbuild 打包失败：${r.errors.map((e) => e.text).join(' / ')}`);
    process.exit(1);
  }
  const tscBin = resolve('node_modules/typescript/bin/tsc');
  const { spawnSync } = await import('node:child_process');
  const d = spawnSync(process.execPath, [tscBin, '-p', join(dir, 'tsconfig.build.json')], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (d.status !== 0) {
    console.error(`类型声明产出失败（tsc -p tsconfig.build.json 退 ${d.status}）：\n${d.stdout ?? ''}${d.stderr ?? ''}`);
    process.exit(1);
  }
}

if (isCliEntry(import.meta.url, process.argv[1])) {
  const outIdx = process.argv.indexOf('--out');
  const root = outIdx >= 0 ? process.argv[outIdx + 1] : 'dist/clients';
  const plan = buildStagingPlan({ version: contractVersion(), anchor: anchorCommit() }, root);

  const missing = missingPrerequisites(plan);
  if (missing.length) {
    console.error(
      `缺少输入面：${missing.join(', ')}\n` +
        '  恢复动作：npm run generate（并按需 npm run fetch:upstream）。不要用旧产物冒充新产物。',
    );
    process.exit(2);
  }

  materialize(plan);
  await buildTypeScriptArtifact(resolve(plan.root));

  const absent = verifyPresent(resolve(plan.root));
  for (const rel of requiredFiles()) {
    if (!absent.includes(rel)) console.log(`✓ ${rel}`);
  }
  if (absent.length) {
    console.error(`未齐备：\n${absent.map((r) => `  ✗ ${r}`).join('\n')}`);
    process.exit(1);
  }
  console.log(`${BANNER} —— 工件已就绪：${plan.root}（三语自包含目录）`);
  process.exit(0);
}

export { ARTIFACT_DIRS };
