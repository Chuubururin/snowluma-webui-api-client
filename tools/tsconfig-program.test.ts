// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
/**
 * N29 的**补缺**守卫：主 tsconfig 的检查面不许（传递地）import 任何 git-ignored 目录。
 *
 * 为什么另开一条而不是扩 run.test.ts 里那条文本守卫：那条只钉住 `"tools/gen/probe.ts"`
 * 这个字面量与 exclude 的书写位置，判据是"防删"。它咬不动"新增一个 import 了 demo/server
 * 的 tools 文件却忘了进 exclude" —— 而那正是主 `tsc` 这次红的成因：
 * `tools/demo-*.test.ts` → `demo/server/upstream.ts` → `generated/typescript/client/index.js`
 * ⇒ `generated/` 被拖进主图，NodeNext 下 12×TS2307 + 1×TS2834。
 * 文本守卫当时全绿，因为它根本不看这件事。
 *
 * 这条走的是**传递闭包**：从 include∖exclude 的每个文件出发，沿相对 import 走到底，
 * 落进 .gitignore 里的目录就红，并把链一并报出来（只报末端看不出是谁把 generated 拖进来的）。
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..');
const GITIGNORED = readFileSync(join(ROOT, '.gitignore'), 'utf8')
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l.endsWith('/') && !l.startsWith('#') && !l.includes('*'))
  .map((l) => l.replace(/\/$/, ''));

function globToRe(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '.*');
  return new RegExp(`^${escaped}$`);
}

function listTs(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listTs(p));
    else if (p.endsWith('.ts')) out.push(relative(ROOT, p).split(sep).join('/'));
  }
  return out;
}

/** import 的相对说明符 → 磁盘上真实存在的那个 .ts（tsx/vitest 把 .js 视同 .ts）。 */
function resolveSpec(fromRel: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = resolve(dirname(resolve(ROOT, fromRel)), spec);
  for (const cand of [
    base + '.ts',
    base.replace(/\.js$/, '.ts'),
    join(base.replace(/\.js$/, ''), 'index.ts'),
    base,
  ]) {
    if (existsSync(cand) && statSync(cand).isFile()) return relative(ROOT, cand).split(sep).join('/');
  }
  return null;
}

function importsOf(rel: string): string[] {
  const src = readFileSync(resolve(ROOT, rel), 'utf8');
  const specs: string[] = [];
  for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)\b[^;\n]*?from\s+['"]([^'"]+)['"]/g)) specs.push(m[1]);
  for (const m of src.matchAll(/(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g)) specs.push(m[1]);
  return specs;
}

describe('N29 补缺：主检查面的传递 import 闭包不许触到 git-ignored 目录', () => {
  const cfg = JSON.parse(readFileSync(join(ROOT, 'tsconfig.json'), 'utf8'));
  const inc = (cfg.include as string[]).flatMap((p) =>
    p.endsWith('.ts') && !p.includes('*') ? [p] : listTs(resolve(ROOT, p.split('**')[0].replace(/\/$/, ''))),
  );
  const exc = (cfg.exclude as string[]).map(globToRe);
  const program = [...new Set(inc)].filter((f) => !exc.some((re) => re.test(f)));

  it('include∖exclude 非空，且没把 demo 那一族漏回主图', () => {
    expect(program.length).toBeGreaterThan(20);
    expect(program.filter((f) => /^tools\/demo-.*\.test\.ts$/.test(f))).toEqual([]);
  });

  it('闭包里没有 generated/ 或 vendor/（报出完整链，不报末端）', () => {
    const offenders: string[] = [];
    for (const entry of program) {
      const seen = new Set<string>([entry]);
      const queue: Array<[string, string]> = [[entry, entry]];
      const trail = new Map<string, string>();
      while (queue.length) {
        const [cur] = queue.shift()!;
        for (const spec of importsOf(cur)) {
          const next = resolveSpec(cur, spec);
          if (!next || seen.has(next)) continue;
          seen.add(next);
          trail.set(next, cur);
          const hit = GITIGNORED.find((g) => next === g || next.startsWith(g + '/'));
          if (hit) {
            const chain: string[] = [next];
            let p = next;
            while (trail.get(p)) {
              p = trail.get(p)!;
              chain.push(p);
            }
            offenders.push(`${chain.reverse().join(' → ')}（落在 git-ignored 的 ${hit}/）`);
          }
          queue.push([next, cur]);
        }
      }
    }
    expect(offenders, `主 tsc 会被这些链拖进 git-ignored 产物，冷克隆下必红：\n${offenders.join('\n')}`).toEqual([]);
  });
});
