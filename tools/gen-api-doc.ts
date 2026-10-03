// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
/**
 * 从契约现出「操作清单」文档面。
 *
 * 为什么要生成而不是手写：`docs/reference/api.md` 里那张按域分组的手写表已经漂了 ——
 * 它写着 auth 6 操作 / system 8 操作，而 `spec/openapi.yaml` 现出的是 auth 10、system 13，
 * 合计少列 14 条操作。这是主消费文档（API 参考）上的**假事实**，而且此前没有任何门禁会响。
 * 按本仓口径，能派生的面就不该手抄：把它变成生成面，漂移就变成"忘了跑一条命令"，
 * 而那条命令由 `npm run gen:check` 在 CI 里钉住新鲜度。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { parse } from 'yaml';
import { isCliEntry } from './lib/cli.js';
import { BANNER } from './lib/client-artifact.js';

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];
const OUT = 'docs/reference/operations.gen.md';

type Op = {
  operationId: string;
  method: string;
  path: string;
  tags: string[];
  tier: string;
  summary: string;
};

function collect(): { ops: Op[]; contractVersion: string; paths: number; schemas: number; tagOrder: string[] } {
  const doc = parse(readFileSync('spec/openapi.yaml', 'utf8')) as {
    info: { version: string };
    tags?: { name: string }[];
    paths: Record<string, Record<string, Partial<Op> & { summary?: string; description?: string }>>;
    components?: { schemas?: Record<string, unknown> };
  };
  const ops: Op[] = [];
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(item)) {
      if (!METHODS.includes(method) || !op || typeof op.operationId !== 'string') continue;
      ops.push({
        operationId: op.operationId,
        method: method.toUpperCase(),
        path,
        tags: (op.tags ?? ['(未归组)']).map(String),
        tier: String(op['x-replay-class'] ?? '(未定档)'),
        summary: String(op.summary ?? op.description ?? '').split(/\r?\n/)[0] ?? '',
      });
    }
  }
  return {
    ops,
    contractVersion: doc.info.version,
    paths: Object.keys(doc.paths).length,
    schemas: Object.keys(doc.components?.schemas ?? {}).length,
    // 声明序优先；契约里没声明的 tag 排到末尾并显式标出，逼它被补进 tags 列表。
    tagOrder: [...new Set([...(doc.tags ?? []).map((t) => t.name), ...ops.flatMap((o) => o.tags)])],
  };
}

const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();

export function render(): string {
  const { ops, contractVersion, paths, schemas, tagOrder } = collect();
  const lines: string[] = [
    BANNER,
    '',
    '<!-- 本面由 `npm run gen:docs` 从 spec/openapi.yaml 现出，不要手改：',
    '     手改会被 `npm run gen:check` 判红，而它已经在 CI 里。',
    '     数字全部由生成器现算 —— 本页不手抄计数（口径见 AGENTS.md）。 -->',
    '',
    '# 操作清单（由契约现出）',
    '',
    `契约版本 \`${contractVersion}\` · 操作 ${ops.length} · 路径 ${paths} · schema ${schemas}。`,
    '',
    '档级口径：t1 只读可重放 / t2 可回滚写 / t3 非幂等写（永不自动重放）。',
    '',
  ];
  for (const tag of tagOrder) {
    const group = ops.filter((o) => o.tags.includes(tag)).sort((a, b) => (a.path === b.path ? a.method.localeCompare(b.method) : a.path.localeCompare(b.path)));
    if (!group.length) continue;
    lines.push(`## ${tag}（${group.length} 操作）`, '');
    lines.push('| 操作 | 方法 | 路径 | 档级 | 摘要 |', '| --- | --- | --- | --- | --- |');
    for (const op of group) {
      lines.push(`| \`${op.operationId}\` | ${op.method} | \`${op.path}\` | ${op.tier} | ${cell(op.summary)} |`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

if (isCliEntry(import.meta.url, process.argv[1])) {
  writeFileSync(OUT, render());
  const { ops } = collect();
  console.log(`${OUT} 已重出：${ops.length} 条操作`);
}
