// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { DECLINATIONS } from '../demo/declinations.js';
import { PANELS, PARITY } from '../demo/parity.js';
import { resolveUpstreamFile, symbolNearLine } from './lib/reference-tier.js';

async function specOps(): Promise<string[]> {
  const spec = parse(await readFile('spec/openapi.yaml', 'utf8')) as {
    paths: Record<string, Record<string, { operationId?: string }>>;
  };
  return Object.values(spec.paths).flatMap((item) =>
    Object.values(item).map((op) => op.operationId).filter(Boolean) as string[],
  );
}

describe('declinations', () => {
  it('每条都有出处、理由、裁定人与可恢复性', () => {
    for (const d of DECLINATIONS) {
      expect(d.webuiSource, d.id).toMatch(/^[A-Za-z0-9/._-]+\.tsx?:\d+/);
      expect(d.reason.length).toBeGreaterThan(10);
      expect(d.decidedBy).toMatch(/(用户|openhands|设计口径)/);
      expect(typeof d.recoverable).toBe('boolean');
    }
  });
  it('id 唯一', () => {
    expect(new Set(DECLINATIONS.map((d) => d.id)).size).toBe(DECLINATIONS.length);
  });
  it('webuiSource 出处互不重复（每条放弃须各引各的实码行）', () => {
    // 不变量而非巧合：放弃清单每条是一个独立决定的独立证据，两条共用同一个 file:line 至少有一条
    // 没在引它自己声称的那个位置（要么抄漏、要么把某条的出处当成"顺手复用"——正是可被复制放大的病灶）。
    // 反面对照 PARITY：同一个面板的多条边合理地共享同一承载行（如 settings-page.tsx:122 的 SystemPanel
    // 同时挂系统设置/TLS/备份三条边），跨边同行是语义事实，不是重复——所以此处只绑 DECLINATIONS，
    // 别"顺手"把同样的唯一性也套到 PARITY 上，那会把合法的多边同源误判成重复。
    expect(new Set(DECLINATIONS.map((d) => d.webuiSource)).size).toBe(DECLINATIONS.length);
  });
});

describe('parity', () => {
  it('面板集合 = 6 业务页 + 门禁屏', () => {
    expect(PANELS).toEqual(['gate', 'overview', 'processes', 'config', 'logs', 'settings', 'debug']);
  });
  it('锚定：spec 恰好 55 条操作（防 spec 缩容后"恰好归属一次"静默失真）', async () => {
    expect(await specOps(), 'spec/openapi.yaml 的操作总数变了——两份清单基线必须同步人工复核').toHaveLength(55);
  });
  it('55 条操作每条在 parity 或 not-surfaced 里恰好归属一次', async () => {
    const ops = await specOps();
    const inParity = PARITY.flatMap((e) => e.ops);
    // "恰好一次"必须数出现次数之和，而不是"至少一处有"：同一 op 重挂在两条 PARITY 边上也要红。
    expect(new Set(inParity).size, 'PARITY 内部有 operationId 重挂').toBe(inParity.length);
    const notSurfaced = DECLINATIONS.filter((d) => d.kind === 'not-surfaced').flatMap((d) => [d.subject]);
    for (const op of ops) {
      const occurrences =
        inParity.filter((x) => x === op).length + notSurfaced.filter((x) => x === op).length;
      expect(occurrences, `${op} 归属次数=${occurrences}`).toBe(1);
    }
  });
  it('ops 里不许出现 spec 之外的名字（防手抄错名）', async () => {
    const ops = new Set(await specOps());
    expect(PARITY.flatMap((e) => e.ops).filter((o) => !ops.has(o))).toEqual([]);
  });
});

// ── 出处机器核（设计口径的牙齿）───────────────────────────────────────
// 这两份清单是后续 8 个面板任务的抄写模板：一个占位行号（client.ts:520 事故）会被复制放大。
// 执法四层：① 被引文件必须走 resolveUpstreamFile 解析到 vendor 锚定副本（解不到即红，本测试不
// 复制锚定清单）；② 行号必须在该文件实际行数内；③ 被引行必须是**实码**——import 行、`//` 注释、
// `/*` 与 JSDoc 的 `*` 续行、空行四类都算占位：出处要落在"真的用了这个符号"的那一行。
// 注释行没有语义重量，符号一旦从旁边的代码里改掉或删掉，引用会静默失效而门禁毫无察觉
// （logs-page.tsx:3 = `import { useVirtualizer }` 与 processes-page.tsx:159 = 解释 showRefresh 的注释，
// 都是这种"看着绿、其实什么都没锚住"的假锚点，是 client.ts:520 事故的近亲）。
// ④ 符号执法从"点分成员"扩到 subject 的头段
// ASCII 标识符：裸名 subject（saveUiConfig / uploadDebugFile 进度回调 / checkUpdate(force)）过去没牙，
// 现在把头段当声称符号——先看该符号在被引文件全文是否真有字面量：真有即必须 symbolNearLine(±5) 命中，
// 全文零命中才走豁免名单（写死在测试里，且「豁免名单自证」当场重算它在 vendor 全树确实零命中）。
// 边界（刻意，非放宽）：纯中文 subject（日志虚拟滚动）无 ASCII 头段，只核 ①+②+③；PARITY 边的 webui
// 是路径串（头段是 packages、点分尾段是 tsx/ts 扩展名噪声），不做头段执法，同按 ①+②+③ 核。
const EXT_NOISE = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'yaml', 'yml']);

/**
 * 从 subject/描述里导出"点分成员引用"的**叶子段**标识符（`OneBotConfig.notifications.channelIds`
 * 声称的是 `channelIds`，不是 `notifications`）；路径扩展名结尾的那一段（`client.ts`）与
 * 纯中文/裸名导出 null。
 * 注意"整条链一起匹配再取末段"而不是"逐段匹配取首个"：后者会把 `A.b.c` 的 `b` 连同前面的 `A.`
 * 一起消费掉，剩下的 `.c` 没有左端点可匹配 ⇒ 只能返回 `b`，执法就停在中间那一层。
 */
function claimedSymbol(text: string): string | null {
  let leaf: string | null = null;
  for (const m of text.matchAll(/[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+/g)) {
    const segs = m[0].split('.');
    const last = segs[segs.length - 1] as string;
    if (EXT_NOISE.has(last)) continue; // 路径串（`client.ts`）不是成员引用
    leaf = last;
  }
  return leaf;
}

/** subject 头段 ASCII 标识符（`/^[A-Za-z_][A-Za-z0-9_]+/`）；纯中文开头导出 null。 */
function headerSymbol(text: string): string | null {
  const m = /^[A-Za-z_][A-Za-z0-9_]+/.exec(text);
  return m ? m[0] : null;
}

// 头段符号在被引文件全文零命中时，只许走这张写死的豁免表——加一行是一次显式动作。
// 四项均为 spec/demo 侧命名，上游另有真名（client.ts uploadBackground、client.ts getPublic、
// update-check.ts getUpdateInfo；send_* 家族在 server 里按动作名动态派发、全树无 `send_` 字面量），
// 逐条已 grep 重指到对应实码行。它们不能"因为难核就免检"——见下面的自证断言。
// 每条**绑死归属**（`owner` 就是引用它的那条清单项的 who）：裸字符串形态的名单有两个残余绕过面——
// 别的条目可以挪用已豁免的名字、以及条目失效（对应 declination 被删/改名）后没人察觉。
// 绑归属后挪用即红，且下面"每条豁免都必须真被用到"的核对把死条目也钉红。
const SYMBOL_EXEMPTIONS: Array<{ symbol: string; owner: string; why: string }> = [
  { symbol: 'uploadBackgroundImage', owner: 'declination:bg-upload-render', why: '上游方法名是 uploadBackground（client.ts）' },
  { symbol: 'getPublicUiAppearance', owner: 'declination:public-appearance-render', why: '上游方法名是 getPublic（client.ts）' },
  { symbol: 'checkUpdate', owner: 'declination:update-check-force', why: '上游导出是 getUpdateInfo（update-check.ts）' },
  { symbol: 'send_', owner: 'declination:send-success-path', why: 'server 按动作名动态派发，全树无 send_ 字面量' },
];

/** 在 vendor/ 全树里数某个字面量的出现次数（自证豁免名单真的零命中，而不是听口头声明）。 */
async function countLiteralInVendorTree(symbol: string): Promise<number> {
  let total = 0;
  const stack = ['vendor'];
  while (stack.length) {
    const dir = stack.pop() as string;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) {
        stack.push(p);
        continue;
      }
      let text;
      try {
        text = await readFile(p, 'utf8');
      } catch {
        continue; // 二进制/不可读文件不计
      }
      total += text.split(symbol).length - 1;
    }
  }
  return total;
}

describe('出处机器核：webuiSource / 边 webui 必须落在锚定文件的实码位置', () => {
  const refs = [
    ...DECLINATIONS.map((d) => ({ who: `declination:${d.id}`, claim: d.subject, ref: d.webuiSource, allowHeader: true })),
    ...PARITY.map((e, i) => ({ who: `parity#${i}:${e.panel}`, claim: e.webui, ref: e.webui, allowHeader: false })),
  ];

  it('逐条：锚定文件 + 行界 + 被引行是实码（非 import/注释/空行）+ 声称符号在 ±5 行内', async () => {
    let symbolChecks = 0;
    const exemptionUse = new Set<string>();
    for (const r of refs) {
      const m = /^(.+):(\d+)$/.exec(r.ref);
      if (!m) throw new Error(`${r.who} 出处格式非法（须 file:line）：${r.ref}`);
      const [, repoPath, lineText] = m;
      const line = Number(lineText);
      const resolved = await resolveUpstreamFile(repoPath);
      expect(resolved, `${r.who} 出处文件未锚定或 vendor 缺副本：${repoPath}`).not.toBeNull();
      const abs = (resolved as { absPath: string }).absPath;
      const lines = (await readFile(abs, 'utf8')).split(/\r?\n/);
      expect(line, `${r.who} 行号越界：${r.ref}（文件共 ${lines.length} 行）`).toBeGreaterThan(0);
      expect(line, `${r.who} 行号越界：${r.ref}（文件共 ${lines.length} 行）`).toBeLessThanOrEqual(lines.length);
      // ③ 被引行必须是实码：import 行、注释行（`//`）、块注释起始与 JSDoc 续行（`/*`、`*`）、空行
      //    一律不算锚点。它们和 import 是同一类假锚点——没有语义重量，符号从旁边的代码里改掉
      //    或删掉，引用照样"绿"，门禁毫无察觉。
      const cited = (lines[line - 1] ?? '').trim();
      expect(cited.length > 0, `${r.who} 被引行是空行：${r.ref}`).toBe(true);
      expect(/^(import\b|\/\/|\/\*|\*)/.test(cited),
        `${r.who} 被引行是 import/注释占位（须重指到真正使用该符号的实码行）：${r.ref} -> "${cited}"`).toBe(false);
      // ④ 符号执法：点分成员优先；无点分时对 subject 头段 ASCII 执法（路径串不执法）。
      const symbol = claimedSymbol(r.claim) ?? (r.allowHeader ? headerSymbol(r.claim) : null);
      if (symbol) {
        const presentInFile = lines.some((l) => l.includes(symbol));
        if (presentInFile) {
          symbolChecks += 1;
          expect(await symbolNearLine(abs, line, symbol),
            `${r.who} 声称符号 ${symbol} 不在 ${repoPath}:${line} ±5 行内`).toBe(true);
        } else {
          const ex = SYMBOL_EXEMPTIONS.find((e) => e.symbol === symbol);
          expect(ex,
            `${r.who} 的头段符号 ${symbol} 在被引文件全文零命中且不在豁免表——须重指实码行，` +
            `或显式登记进豁免表（每条会被 vendor 全树零命中自证，且必须绑归属）`).toBeTruthy();
          expect((ex as (typeof SYMBOL_EXEMPTIONS)[number]).owner,
            `豁免条目 ${symbol} 绑的是 ${(ex as { owner: string }).owner}，被 ${r.who} 挪用了——` +
            `豁免不可转让，要给这条自己登记一条`).toBe(r.who);
          exemptionUse.add(symbol);
        }
      }
    }
    // 死条目核：每条豁免都必须真被某条清单项用到（上面的 who 绑定保证用到它的那条就是登记的那条）。
    for (const e of SYMBOL_EXEMPTIONS) {
      expect(exemptionUse, `豁免条目 ${e.symbol}（归属 ${e.owner}）没被任何引用用到——条目已失效，删掉它`).toContain(e.symbol);
    }
    // 牙齿自检：头段执法后符号核实际咬到的条数（点分 8 + 头段 9 = 17）。回落到 17 以下即执法哑了。
    expect(symbolChecks).toBeGreaterThanOrEqual(17);
  });

  it('豁免表自证：每个符号在 vendor/ 全树确实零命中', async () => {
    for (const { symbol } of SYMBOL_EXEMPTIONS) {
      const n = await countLiteralInVendorTree(symbol);
      expect(n, `豁免符号 ${symbol} 在 vendor 全树出现 ${n} 次（>0 就不该被豁免，应正常执法或重指）`).toBe(0);
    }
  });

  it('导出规则本身：点分导出、头段导出、路径与纯中文不导出', () => {    // 点分形态（既有执法，保持不变）
    expect(claimedSymbol('UiLayout.navItems')).toBe('navItems');
    expect(claimedSymbol('NotificationsConfig.channelIds')).toBe('channelIds');
    // 多段点分锚**叶子**，不是第一个成员：这条曾经返回首个匹配，执法比文档松一档
    expect(claimedSymbol('OneBotConfig.notifications.channelIds')).toBe('channelIds');
    expect(claimedSymbol('a.b.c')).toBe('c');
    expect(claimedSymbol('packages/webui/src/lib/api/client.ts:524')).toBeNull();
    expect(claimedSymbol('packages/webui/src/components/pages/login-page.tsx:1')).toBeNull();
    expect(claimedSymbol('日志虚拟滚动')).toBeNull();
    expect(claimedSymbol('saveUiConfig')).toBeNull();
    expect(claimedSymbol('checkUpdate(force)')).toBeNull();
    // 头段形态（本轮新增执法）
    expect(headerSymbol('saveUiConfig')).toBe('saveUiConfig');
    expect(headerSymbol('uploadDebugFile 进度回调')).toBe('uploadDebugFile');
    expect(headerSymbol('checkUpdate(force)')).toBe('checkUpdate');
    expect(headerSymbol('send_* 成功路径（经 invokeDebugAction）')).toBe('send_');
    expect(headerSymbol('日志虚拟滚动')).toBeNull();
  });
});


describe('第二道闸的覆盖面：业务路由表逐条必须调 gateGuard', () => {
  /**
   * `gates.ts` 是门禁自己那张表（它当然不调 gateGuard），其余 `routes/*.ts` 里每条路由都必须调 ——
   * 漏一条就是"客户端拒了但服务端不拒"，而客户端那道闸是可以绕过去的（直接打 HTTP 就行）。
   * 本测试只有 0 个业务路由文件，所以这条断言现在钉的是**名单本身**：
   * 谁新加一个路由文件却没登记进下面这份名单，等式立刻红 ⇒ 扫描不会静默空转。
   * 等把文件填进来，它开始逐条 handler 咬。
   */
  const EXPECTED_BUSINESS_ROUTE_FILES: string[] = ['overview.ts', 'processes.ts', 'config.ts', 'logs.ts', 'settings.ts', 'debug.ts', 'streams.ts'];
  it('routes/ 下的业务路由文件与登记名单一致，且每条 handler 都含 gateGuard(', async () => {
    const dir = 'demo/server/routes';
    const entries = (await readdir(dir))
      .filter((f) => f.endsWith('.ts') && f !== 'gates.ts')
      .sort();
    expect(entries, '新增/删除路由文件要同时改这条名单（否则扫描会静默空转）').toEqual(
      [...EXPECTED_BUSINESS_ROUTE_FILES].sort(),
    );
    for (const file of entries) {
      const src = await readFile(join(dir, file), 'utf8');
      const keys = [...src.matchAll(/^\s*'(?:GET|POST|PUT|PATCH|DELETE) [^']+':/gm)];
      expect(keys.length, `${file} 里一条路由键都没扫到（表名对不上就是筛错了）`).toBeGreaterThan(0);
      for (let i = 0; i < keys.length; i += 1) {
        const from = keys[i].index ?? 0;
        const to = i + 1 < keys.length ? (keys[i + 1].index ?? src.length) : src.length;
        expect(src.slice(from, to), `${file} 的 ${keys[i][0].trim()} 未调 gateGuard ⇒ 第二道闸漏一条`).toContain(
          'gateGuard(',
        );
      }
    }
  });
});
