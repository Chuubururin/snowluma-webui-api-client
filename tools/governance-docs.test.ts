// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
/**
 * 治理文档面的门禁。
 *
 * AGENTS.md 写下四条禁令（不写日期 / 历史提交号 / PR·run 流水号 / `§N` 指针、计数不手抄），
 * 但此前只执法了 `spec/openapi.yaml` 的描述面与 `docs/**` 的链接面 —— 治理面
 * （README、CHANGELOG、SECURITY、CONTRIBUTING、RoadMap 等）一条都没接上电。
 * 后果不是难看，是**假事实**：CHANGELOG 写着一个用例总数，而 `npm run test` 现出的是另一个数；
 * CHANGELOG 的两个链接指向某个 semver tag，而远端 tag 里根本没有那个形状。
 *
 * 判据一律来自**活源**：操作/路径/schema 数从 `spec/openapi.yaml` 现算，门禁条数从
 * `GATES` 现取，锚点短码从 `spec/anchor.json` 现取，tag 是否存在从 `git tag` 现取。
 * 本文件不持有任何"允许的数字清单" —— 那样就是拿被检对象当尺子。
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { GATES } from './verify-all.js';

const trackedMd = execFileSync('git', ['ls-files', '*.md'], { encoding: 'utf8' })
  .split(/\r?\n/)
  .filter(Boolean);

const read = (f: string) => readFileSync(f, 'utf8');

/** 活源：契约里的操作数、路径数、schema 数，以及每个 tag / 每个重放档的操作数。 */
function contractCounts() {
  const doc = parse(read('spec/openapi.yaml')) as {
    paths: Record<string, Record<string, { tags?: string[]; 'x-replay-class'?: string }>>;
    components?: { schemas?: Record<string, unknown> };
  };
  const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];
  let operations = 0;
  const byTag = new Map<string, number>();
  const byTier = new Map<string, number>();
  for (const item of Object.values(doc.paths)) {
    for (const [method, op] of Object.entries(item)) {
      if (!METHODS.includes(method) || !op) continue;
      operations += 1;
      for (const t of op.tags ?? []) byTag.set(t, (byTag.get(t) ?? 0) + 1);
      if (op['x-replay-class']) byTier.set(op['x-replay-class'], (byTier.get(op['x-replay-class']) ?? 0) + 1);
    }
  }
  return {
    operations,
    paths: Object.keys(doc.paths).length,
    schemas: Object.keys(doc.components?.schemas ?? {}).length,
    // 每个名词各自一本账：分项操作数按 tag 与重放档都能现算出来。
    // 不合并成"一个大数字集合"——合并过一回，结果"7 个面板"恰好撞中 t2=7 而蒙混过关。
    byNoun: {
      操作: new Set<number>([operations, ...byTag.values(), ...byTier.values()]),
      路径: new Set<number>([Object.keys(doc.paths).length]),
      schema: new Set<number>([Object.keys(doc.components?.schemas ?? {}).length]),
      门禁: new Set<number>([GATES.length]),
    } as Record<string, Set<number>>,
  };
}

/** 只认"数字 量词 名词"这一形，且名词各自核账。`(?<![A-Za-z0-9])` 挡住 "IPv6 路径" 这类误伤。 */
const COUNT_CLAIM = /(?<![A-Za-z0-9])(\d+)\s*(?:条|个|种|屏)?\s*(操作|路径|schema|门禁)/g;
/** 用例数没有活源可核（它跟着每次提交变），所以只许由命令现出，不许写进文档。 */
const CASE_COUNT = /(?<![A-Za-z0-9])\d+\+?\s*(?:条|个)?\s*用例/g;
const SECTION_POINTER = /§\s*\d|evidence[^。\n]{0,10}§/;
const DATE = /\b20\d{2}-\d{2}(-\d{2})?\b|\b20\d{2}年/;
const RUN_NUMBER = /PR\s*#\d+|run\s+\d{6,}|#\d{2,}\s*(号|流水)/;
const HEX_TOKEN = /\b[0-9a-f]{7,40}\b/g;

/**
 * 判断一行是否注释面。注意：**不能**先把注释行 filter 出来再报行号 ——
 * 那样 offender 里的行号是"过滤后列表的下标"，指不到真实那一行（第一版就报错了一位，
 * 让复核者去看不存在的那句）。这里保留原行号，只做匹配。
 */
const isCommentLine = (l: string): boolean => /^\s*(\/\/|\*|\/\*)/.test(l);
/** 扫描范围：md 全文；代码只看注释面（代码字面量里的 id 不是提交号，见 `4194304` 那次误报）。 */
const inScope = (file: string, line: string): boolean => file.endsWith('.md') || isCommentLine(line);

describe('治理文档面（禁令此前只写在纸上）', () => {
  const counts = contractCounts();
  const anchorShort = (parse(read('spec/anchor.json')) as { commit: string }).commit.slice(0, 7);

  it('契约派生的计数要么与活源相等，要么就别写', () => {
    const offenders: string[] = [];
    for (const f of trackedMd) {
      read(f)
        .split(/\r?\n/)
        .forEach((line, i) => {
          for (const m of line.matchAll(COUNT_CLAIM)) {
            const n = Number(m[1]);
            const noun = m[2];
            const allowed = counts.byNoun[noun];
            if (!allowed || !allowed.has(n)) {
              offenders.push(`${f}:${i + 1} 写了「${m[0].trim()}」，而活源里 ${noun} 只现得出 {${[...(allowed ?? [])].join(', ')}}`);
            }
          }
        });
    }
    expect(offenders, `手抄且已与活源分叉的计数：\n${offenders.join('\n')}`).toEqual([]);
  });

  it('用例数不许写进任何跟踪文档（它跟着提交漂，只能由命令现出）', () => {
    const offenders: string[] = [];
    for (const f of trackedMd) {
      read(f)
        .split(/\r?\n/)
        .forEach((line, i) => {
          if (!inScope(f, line)) return;
          const hit = line.match(CASE_COUNT);
          if (hit) offenders.push(`${f}:${i + 1} 「${hit[0].trim()}」`);
        });
    }
    expect(offenders, `写死的用例计数（改成"由 npm run test / verify:all 现出"）：\n${offenders.join('\n')}`).toEqual([]);
  });

  it('禁面：`§N` 与 evidence 指针 / 日期 / PR·run 流水号', () => {
    const offenders: string[] = [];
    const faces = [...trackedMd, ...execFileSync('git', ['ls-files', '.github/workflows'], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean)];
    for (const f of faces) {
      read(f)
        .split(/\r?\n/)
        .forEach((line, i) => {
          // 规则条文本身要能写下被禁的形状，否则没法执法：反引号包裹视为引用规则。
          if (/`§N`|不写日期|历史提交号/.test(line)) return;
          if (SECTION_POINTER.test(line)) offenders.push(`${f}:${i + 1} 指针「${line.trim().slice(0, 60)}」`);
          if (DATE.test(line)) offenders.push(`${f}:${i + 1} 日期「${line.trim().slice(0, 60)}」`);
          if (RUN_NUMBER.test(line)) offenders.push(`${f}:${i + 1} 流水号「${line.trim().slice(0, 60)}」`);
        });
    }
    expect(offenders, `AGENTS.md 明令不写、却留在治理面上的引用：\n${offenders.join('\n')}`).toEqual([]);
  });

  it('注释与文档里的裸 hex 只能是当前锚点短码（历史已重建，旧提交号一律不可解析）', () => {
    const offenders: string[] = [];
    const codeFiles = execFileSync('git', ['ls-files', 'tools', 'adapters', 'demo', 'spec'], { encoding: 'utf8' })
      .split(/\r?\n/)
      .filter((f) => /\.(ts|js|mjs|py|go)$/.test(f));
    for (const f of [...trackedMd, ...codeFiles]) {
      read(f)
        .split(/\r?\n/)
        .forEach((line, i) => {
        if (!inScope(f, line)) return;
        for (const m of line.matchAll(HEX_TOKEN)) {
          const tok = m[0];
          // 纯十进制不是提交号：`4194304`（4 MiB）曾经被这条正则当成 SHA 报红。
          if (!/[a-f]/.test(tok)) continue;
          // 锚点短码是 AGENTS.md 明文豁免的功能数据；40 位全长只在 anchor.json 里算，注释里写全码
          // 也必须等于当前锚点，否则同样是死指针。
          if (tok === anchorShort || read('spec/anchor.json').includes(tok)) continue;
          if (/\b(锚点|anchor|candidate|sha256|哈希)\b/i.test(line)) continue;
          offenders.push(`${f}:${i + 1} 「${tok}」不是当前锚点（历史已重建，这个号解析不出来）`);
        }
      });
    }
    expect(offenders, `写死了不可解析的提交号：\n${offenders.join('\n')}`).toEqual([]);
  });

  it('CHANGELOG 的链接引用必须指向真实存在的 tag（Keep a Changelog 的底部 ref 是最容易烂的一面）', () => {
    const text = read('CHANGELOG.md');
    const refs = [...text.matchAll(/\[[^\]]+\]:\s*https:\/\/github\.com\/[^/]+\/[^/]+\/(releases\/tag|compare)\/([^\s#?]+)/g)];
    // 空集不算通过：把链接全删掉就让这条断言空转。
    expect(refs.length, 'CHANGELOG 没有任何链接引用，这条门禁在空转').toBeGreaterThan(0);
    const visibleTags = new Set(execFileSync('git', ['tag', '--list'], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean));
    // 量具不能是空的：浅克隆（Actions 默认 fetch-depth: 1）不拉 tag，那时每条链接都判死，
    // 报出来像"文档全烂"而实际是"没有可比的 tag"——两者的恢复动作完全相反。
    expect(visibleTags.size, '当前克隆里一个 tag 都没有：量具失效（需 fetch-depth: 0），别去删链接').toBeGreaterThan(0);
    const dead: string[] = [];
    for (const [, kind, value] of refs) {
      const names = kind === 'compare' ? value.split('...') : [value];
      for (const n of names) {
        if (n === 'HEAD') continue;
        if (!visibleTags.has(n)) dead.push(`tag ${n} 不存在（${kind}）`);
      }
    }
    expect(dead, `指向不存在 tag 的链接：${dead.join(' | ')}`).toEqual([]);
  });

  it('每份跟踪的 markdown 都必须挂在导航面上（藏在角落的文档不会被任何人读到，也不会被任何门禁看到）', () => {
    const entryFaces = ['README.md', 'AGENTS.md', 'CONTRIBUTING.md', 'CHANGELOG.md', 'SECURITY.md', 'RoadMap.md'];
    const nav = `${read('README.md')}\n${read('AGENTS.md')}\n${read('docs/README.md')}`;
    const orphans: string[] = [];
    for (const f of trackedMd) {
      if (f.startsWith('docs/')) continue; // docs/** 由 docs-index 门禁按导航表核
      // PR/issue 模板由 GitHub 平台直接消费，不存在"被人从导航点进去"这条路径。
      if (f.startsWith('.github/')) continue;
      const base = f.split('/').pop()!;
      const isEntry = entryFaces.includes(f);
      const linked = nav.includes(f) || nav.includes(`(${base})`) || nav.includes(`(${f})`) || nav.includes(`<${f}>`);
      if (!isEntry && !linked) orphans.push(`${f} 既不在入口文件清单里，也没被 README/AGENTS/docs 导航引用`);
      if (isEntry && !linked && f !== 'README.md') orphans.push(`${f} 声称是入口面，却没有任何页面链接到它`);
    }
    expect(orphans, `无人导航的跟踪文档：\n${orphans.join('\n')}`).toEqual([]);
  });

  it('门禁自己不许空转：发现面与活源都非空', () => {
    expect(trackedMd.length).toBeGreaterThan(10);
    expect(counts.operations).toBeGreaterThan(0);
    expect(counts.schemas).toBeGreaterThan(0);
    expect(GATES.length).toBeGreaterThan(0);
    expect(anchorShort.length).toBe(7);
  });
});
