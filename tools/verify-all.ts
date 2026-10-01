// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
/**
 * 一键验证编排器：按设计口径的交付判定把离线门禁串成一条链，逐条跑、逐条记退出码、报告落盘。
 *
 * 这条链原先带三条 HTTP 腿：`POST /set-base-url` → `POST /login` → `POST /run-all`（全量 sweep ×2 稳定性 diff）。
 * 那两条写死的端点在重做里都没了 —— `/login` 改名成了 `/gate/login`，而 `/run-all` 随
 * "消除原始调用台"（commit 7d8e91d，实现批次）整个删掉。留着的效果是编排器必然在第 1–2 条腿抛错，
 * 而它头注还写着"离线门禁请在终端另行执行"、那句从来没人执行过：
 * 一条看起来是活链、实际跑不起来的链，比没有这条链更坏 —— 它会把"没验"记成"验过"。
 *
 * 55 条操作的活体面现在由 L4 承担（`--fixture`，一次性可牺牲夹具，设计口径）。它比旧 sweep 强在三处：
 * 跑在全新实例上（不是被既有配置掩盖的那台）、每条写都带真断言而不是只看 status、
 * 以及 T3 永不自发 —— 旧 sweep 会把 `send_group_msg` 的成功路径真发出去。
 *
 * 安全侧的连带变化：本编排器不再接受 `--password`，也不再向任何 HTTP 目标发请求。
 * "口令不进命令行、不进文件"这条约束，最好的落实方式是让这条链根本没有需要它的环节。
 * 要跑活体全量就加 `--fixture`（环回一次性实例，用完即删），永远不要把目标指向生产实例。
 *
 * 执行清单（顺序即 GATES 表；注释与表各存一份就是两份认知分叉，所以这条同序关系由
 * `tools/verify-all.test.ts` 逐条钉住 —— 只改一边即红）：
 *   npm test → npm run validate → npm run drift → npm run inventory
 *   → npm run ui-coverage（含七条断言）→ npm run typecheck:demo → npm run probe
 *   → npm run test:py-adapter → npm run test:go-adapter
 *   第 10 条可选：加 `--fixture` 才起一次性环回实例跑 L4（口令不进命令行，也不进文件）
 * 收口：任一条红或清单为空 ⇒ 退出码 1；报告落盘前过 redactJson。
 */
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { redactJson } from './redact-evidence.js';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');

export interface Gate {
  /** 清单里的稳定 id。改名等于删掉一条门禁 —— `tools/verify-all.test.ts` 会为此变红。 */
  id: string;
  /** 跑的是 package.json 里那条脚本；这里不存命令副本，免得两份认知分叉。 */
  npmScript: string;
  /** 这条门禁实际要读/跑的文件。缺了它，一次改名只会让 spawn 报 ENOENT 而不会"跑红"，
   *  而"没跑"与"跑红了"的处置完全相反。 */
  runs: string[];
  /** 它在证明什么 —— 清单要能被人逐条复核，不是命令的堆。 */
  proves: string;
}

/** 设计口径交付判定点名的离线面：少一条就不许写"全绿"。 */
export const REQUIRED_GATE_IDS = ['test', 'validate', 'drift', 'ui-coverage', 'typecheck:demo'] as const;

export const GATES: Gate[] = [
  {
    id: 'test',
    npmScript: 'test',
    runs: ['tools/demo-server.test.ts', 'demo/server/start.ts', 'demo/client/app.ts'],
    proves: 'L1 契约 + L2 七张路由 + L3 客户端状态机与挂载，含 SSE 代理的断连与引用计数',
  },
  {
    id: 'validate',
    npmScript: 'validate',
    runs: ['spec/openapi.yaml', 'tools/validate-spec.ts'],
    proves: 'OpenAPI 结构、replay 分级、流端点的 WithResponse 判语等 spec 自身约束成立',
  },
  {
    id: 'drift',
    npmScript: 'drift',
    runs: ['spec/openapi.yaml', 'tools/check-drift.ts'],
    proves: 'spec 与上游锚定面的路径×方法双向零缺口；锚定 commit 一变即红，逼人工重导',
  },
  {
    id: 'inventory',
    npmScript: 'inventory',
    runs: ['tools/inventory.ts'],
    proves: '55 条操作的分面清单与 spec 同源，不靠手抄',
  },
  {
    id: 'ui-coverage',
    npmScript: 'ui-coverage',
    runs: ['demo/parity.ts', 'demo/declinations.ts', 'tools/check-ui-coverage.ts'],
    proves: '面板覆盖七条断言（归属 / 出处分层 / 控件名不许发明 / 合并语义 / 流单测 / 手写路径与禁用端点 / unwrap 唯一折叠点），且"未登记"缺口为 0',
  },
  {
    id: 'typecheck:demo',
    npmScript: 'typecheck:demo',
    runs: ['tsconfig.demo.json', 'demo/dashboard.ts'],
    proves: 'demo 与 tools/demo-* 的类型面干净 ⇒ 55 条调用真的走生成 SDK，没靠 as any 蒙过去',
  },
  {
    id: 'probe',
    npmScript: 'probe',
    runs: ['tsconfig.probe.json', 'tsconfig.gen-ts.json'],
    proves: 'generated 缺席时全仓 tsc 仍干净，且三家生成物各自的类型面成立',
  },
  {
    id: 'test:py-adapter',
    npmScript: 'test:py-adapter',
    runs: ['adapters/python/snowluma_adapter.py', 'adapters/golden/cases.json'],
    proves: 'Python 适配器的 bootstrap 门控/401 分治/destructive 闸/规则表与 TS 语义同形（golden 夹具同源）',
  },
  {
    id: 'test:go-adapter',
    npmScript: 'test:go-adapter',
    runs: ['adapters/go/client.go', 'adapters/golden/cases.json'],
    proves: 'Go 适配器同上——三语一致性只在三份套件都被同一条链真跑时才成立，不在清单里就全靠人记得',
  },
];

export interface GateResult {
  id: string;
  npmScript: string;
  exit: number | null;
  ok: boolean;
  /** 只留尾部一截：失败清单可能几 KB，整份塞进版本库既有噪音也可能带进上游回显的内容。 */
  tail: string;
}

function runGate(g: { id: string; npmScript: string }): GateResult {
  // shell:true 是 Windows 上找到 npm.cmd 的唯一办法。命令串由 GATES 这张写死的表拼，
  // 表内容又由 tools/verify-all.test.ts 逐条对着 package.json 核 —— 没有外部输入能走到这条 shell。
  const res = spawnSync(`npm run ${g.npmScript}`, {
    cwd: ROOT,
    encoding: 'utf8',
    shell: true,
    maxBuffer: 64e6,
  });
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  const passed = res.status === 0;
  // ANSI 一律剥掉：这份报告要入库，终端控制码进去就是一堆无从 diff 的噪音。
  const plain = out.replace(/\x1b\[[0-9;]*m/g, '').replace(/\r\n/g, '\n').trim();
  return {
    id: g.id,
    npmScript: g.npmScript,
    exit: res.status,
    ok: passed,
    // 通过的那条只留一小段：八条各塞 1.4 KB stdout 进版本库，读的人一行也看不出所以然。
    // 失败时才需要原文 —— 那才是 tail 这个字段存在的理由。
    tail: passed ? summarizePassingOutput(plain) : plain.slice(-1400),
  };
}

const OUT_PATH = 'docs/operations/verify-all-report.json';

/** 通过那条留几行、留多长。窗口大小不是审美：vitest 的建议块打在汇总行之后，太窄会把判定顶出去。 */
const PASSING_TAIL_LINES = 8;
const PASSING_TAIL_CHARS = 320;

/**
 * 通过门禁的采集。只取末一行在真报告上出过三次货：`test` 那格是 vitest 的性能建议
 * （读起来像警告）、`drift` 那格是一个右花括号、L4 那格只有 Duration —— 三格都不含判定本身。
 * 取末尾一小段窗口（截头不截尾：判定行总在窗口前部），既不写死词表也不会静默变空。
 */
export function summarizePassingOutput(plain: string): string {
  return plain
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .slice(-PASSING_TAIL_LINES)
    .join(' / ')
    .slice(0, PASSING_TAIL_CHARS);
}

/**
 * 收口退出码。空清单也算红：`failed.length ? 1 : 0` 在 GATES 被清空时会 exit 0 并写一份
 * "全部通过 ✓"的报告，而那时一条门禁都没跑 —— 扫到 0 个文件却报齐备，同一形状。
 */
export function exitCodeFor(results: ReadonlyArray<{ id: string; ok: boolean }>): number {
  if (results.length === 0) return 1;
  return results.some((r) => !r.ok) ? 1 : 0;
}

/** CLI 入口判定：用 basename，Windows 上 argv[1] 是反斜杠绝对路径，路径子串匹配会静默不跑。 */
const isCli = /verify-all\.(ts|js)$/.test(process.argv[1]?.replace(/\\/g, '/') ?? '');

if (isCli) {
  const withFixture = process.argv.includes('--fixture');
  const results: GateResult[] = [];

  for (const g of GATES) {
    const r = runGate(g);
    results.push(r);
    console.log(`${r.ok ? '✓' : '✗'} ${g.id.padEnd(15)} ${g.proves}`);
    if (!r.ok) console.log(r.tail);
  }

  if (withFixture) {
    const r = runGate({ id: 'test:fixture', npmScript: 'test:fixture' });
    results.push(r);
    console.log(`${r.ok ? '✓' : '✗'} ${'L4'.padEnd(15)} 全新非 dev 夹具上的门禁矩阵/净零/首帧/锚点/2FA`);
    if (!r.ok) console.log(r.tail);
  } else {
    // 明写出来而不是默默不跑：默认这一条是 skip，而 skip 不是通过。
    console.log('· L4 未跑（加 --fixture 才起一次性环回实例真跑）');
  }

  const failed = results.filter((x) => !x.ok);
  const report = {
    generatedAt: new Date().toISOString(),
    gitHead: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim(),
    fixture: withFixture,
    results,
  };
  // 落盘走 redactJson：`tail` 是门禁的原始输出，而 L4 那一条的 tail 里可能带着上游回给夹具的
  // token / accessToken / secret。裸 JSON.stringify 就是那六份入库证据泄凭据的同一条路。
  writeFileSync(join(ROOT, OUT_PATH), redactJson(report), 'utf8');

  const code = exitCodeFor(results);
  console.log(
    code === 0
      ? '全部通过 ✓'
      : failed.length
        ? `未通过 ${failed.length} 条：${failed.map((f) => f.id).join(', ')}`
        : '清单为空：一条门禁都没跑',
  );
  console.log(`报告已写入 ${OUT_PATH}`);
  process.exit(code);
}
