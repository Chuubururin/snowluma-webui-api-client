// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isCliEntry } from './lib/cli.js';
import { extractRoutes, isApiOp } from './extract-routes.js';
import { extractModels } from './extract-models.js';
import {
  UPSTREAM_FILES,
  UPSTREAM_REPO,
  cachedSha256For,
  isModelSource,
  localPathFor,
  VENDOR_DIR,
  type Anchor,
} from './lib/upstream.js';

// 设计口径：anchor 的 commit **必须**是解析后的 40 位小写十六进制 SHA，不接受分支名。
// 原先这条只由 build-anchor.test.ts 的提交物形状测试事后把关；终审 I2 把它前移到入口，
// 因为 buildAnchorFromDir **从不 fetch**（只重算 vendor 现有字节的哈希），传什么字符串就
// 盖上什么标签——旧 CLI 的 `?? 'main'` 默认值等于允许"忘了传参"产出一份自证锚点。
// 顺带让 tools.lock.json 的 fetchCommand（fetchUpstream(anchor.commit)）by construction 正确：
// 锚点里的 commit 必然是不可变 SHA，不可能是会移动的头。
// 导出给 check-drift.ts 复用（终审 I2 的收口项）：读侧也要认这条形状，否则手写/过期的
// spec/anchor.json 仍能把分支名喂进 buildAnchorFromDir——写侧有契约、读侧没有，等于没有。
export const COMMIT_SHA = /^[0-9a-f]{40}$/;

export function parseCommitArg(raw: string | undefined): string {
  const usage =
    '用法：node_modules/.bin/tsx tools/build-anchor.ts <40 位小写十六进制 SHA>。' +
    ' SHA 由 git ls-remote https://github.com/SnowLuma/SnowLuma main 取得。';
  if (raw === undefined) {
    throw new Error(`未提供 commit 参数，且**没有**默认值（旧默认值 'main' 会写出可移动的分支名）。${usage}`);
  }
  if (!COMMIT_SHA.test(raw)) {
    throw new Error(
      `commit 必须是解析后的 40 位小写十六进制 SHA，不接受分支名/短 SHA/大写（实际收到 ${JSON.stringify(raw)}）。${usage}` +
        ' 不做静默归一：归一化等于允许操作者提交他并没有验证过的形状。',
    );
  }
  return raw;
}

export async function buildAnchorFromDir(commit: string, dir = VENDOR_DIR): Promise<Anchor> {
  const pairs = UPSTREAM_FILES.map((repoPath) => ({
    repoPath,
    localPath: localPathFor(repoPath, dir),
  }));

  const files = [];
  for (const p of pairs) {
    const sha256 = await cachedSha256For(p.repoPath, dir);
    const bytes = (await readFile(p.localPath)).length;
    files.push({ repoPath: p.repoPath, sha256, bytes });
  }

  const ops = await extractRoutes(pairs);
  // 判定不写在这里：见 lib/upstream.ts 的 isModelSource（的 inventory 共用同一条）
  const models = await extractModels(pairs.filter((p) => isModelSource(p.repoPath)));
  const expectedModels: Record<string, number> = {};
  for (const m of models) expectedModels[m.file] = (expectedModels[m.file] ?? 0) + 1;

  return {
    upstreamRepo: UPSTREAM_REPO,
    commit,
    fetchedAt: new Date().toISOString(),
    files,
    expectedRouteRegistrations: ops.length,
    expectedApiOperations: ops.filter((o) => isApiOp(o.path)).length,
    expectedModels,
  };
}

if (isCliEntry(import.meta.url, process.argv[1])) {
  // 参数非法（含"没传参"）→ 报错退出，绝不带着分支名或 undefined 去写锚点
  let commit: string;
  try {
    commit = parseCommitArg(process.argv[2]);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(2);
  }
  const anchor = await buildAnchorFromDir(commit);
  // spec/ 由本任务首次创建；writeFile 不会自动建父目录，缺 mkdir 必 ENOENT
  await mkdir('spec', { recursive: true });
  await writeFile('spec/anchor.json', JSON.stringify(anchor, null, 2) + '\n', 'utf8');
  console.log('写出 spec/anchor.json', {
    commit: anchor.commit,
    registrations: anchor.expectedRouteRegistrations,
    apiOperations: anchor.expectedApiOperations,
    models: anchor.expectedModels,
  });
}
