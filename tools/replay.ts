// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
/**
 * T1/T2 重放采集器（设计口径/设计口径 Phase 2、后续批次的工具半边）。
 *
 * 职责：按 tools/lib/tiers.ts 的单源分层清单，向**活 SnowLuma 实例**重放指定档位的
 * 全部操作，把每条的真实响应（状态码 + JSON 体）打成报告——这份报告就是设计口径 Schema
 * diff 的输入（与 spec 形状的比对在拿到报告后进行）。
 *
 * 纪律：
 * - **T3 永不重放**（设计口径：写路径真实副作用，绝不自动执行）——tier 参数只接受 t1|t2。
 * - T2 是写操作，重复执行有实际后果：必须显式 `--i-have-disposable-instance`。
 * - 401/403/needsTotp 由 adapters 的 bootstrap/生命周期处理（本工具是适配层的第一个真消费者）。
 * - 路径参数与请求体一律**内联 JSON**（--params / --bodies）；报告打 **stdout**
 *   （状态行走 stderr，调用方重定向保存）——工具内零文件读写，无动态路径。
 * - 无请求体的写操作记 skipped，不臆造负载。
 *
 * 执行前置（诚实状态）：本工具是后续批次的**就绪半边**；实际执行需要活 SnowLuma 实例
 * （dev QQ + 可牺牲部署），rest-generation 收口评估结论 = blocked（见设计文档未完事项段）。
 */
import { REPLAY_CLASS_BY_OP } from './lib/tiers.js';
import type { Client } from '../adapters/typescript/client.js';

export type { Client };

export type Tier = 't1' | 't2' | 't3';

export interface ReplayRecord {
  op: string;
  path: string;
  status: number | null;
  body?: unknown;
  error?: string;
}

export interface ReplayReport {
  generatedAt: string;
  baseUrl: string;
  tier: Tier;
  replayed: number;
  skipped: number;
  results: Array<ReplayRecord | { op: string; skipped: string }>;
}

export class TierRefusedError extends Error {}

/** Express 形（:uin）路径 + 参数表 → 具体路径；缺参数返回 null。 */
export function substitutePath(template: string, params: Record<string, string>): string | null {
  const out = template.replace(/:([A-Za-z0-9_]+)/g, (_, name: string) => {
    const v = params[name];
    return v === undefined ? '\u0000missing\u0000' : encodeURIComponent(v);
  });
  return out.includes('\u0000missing\u0000') ? null : out;
}

export function opsForTier(tier: Tier): Array<{ op: string; method: string; path: string }> {
  return Object.entries(REPLAY_CLASS_BY_OP)
    .filter(([, cls]) => cls === tier)
    .map(([op]) => {
      const [method, ...rest] = op.split(' ');
      return { op, method, path: rest.join(' ') };
    });
}

export async function collectReplay(opts: {
  client: Client;
  tier: Tier;
  params?: Record<string, string>;
  bodies?: Record<string, unknown>;
  disposeInstance?: boolean;
}): Promise<ReplayReport> {
  if (opts.tier === 't3') {
    // 设计口径：T3 永不自动重放。这一道在调用侧与 CLI 侧各拦一次。
    throw new TierRefusedError('T3 永不自动重放（写路径真实副作用）');
  }
  if (opts.tier === 't2' && opts.disposeInstance !== true) {
    throw new TierRefusedError('T2 重放会改变实例状态：必须显式声明可牺牲实例（--i-have-disposable-instance）');
  }
  const params = opts.params ?? {};
  const bodies = opts.bodies ?? {};
  const results: ReplayReport['results'] = [];
  let replayed = 0;
  let skipped = 0;
  for (const { op, method, path } of opsForTier(opts.tier)) {
    if (path.endsWith('/stream')) {
      // SSE 流端点不是 JSON 重放对象：消费走 R2 的 WithResponse 通道与 SSE 客户端。
      skipped += 1;
      results.push({ op, skipped: 'SSE 流端点非 JSON 重放对象' });
      continue;
    }
    const concrete = substitutePath(path, params);
    if (concrete === null) {
      skipped += 1;
      results.push({ op, skipped: `路径参数缺失（可用 --params 提供：${path}）` });
      continue;
    }
    const key = `${method} ${path}`;
    let reqBody: unknown;
    if (method === 'POST' || method === 'PUT' || method === 'DELETE') {
      if (!(key in bodies)) {
        skipped += 1;
        results.push({ op, skipped: '无请求体（--bodies 内联 JSON 按 "METHOD /path" 提供；不臆造负载）' });
        continue;
      }
      reqBody = bodies[key];
    }
    try {
      const out = await opts.client.request(method, concrete, reqBody);
      replayed += 1;
      results.push({ op, path: concrete, status: 200, body: out });
    } catch (e) {
      const err = e as { status?: number; message?: string };
      replayed += 1;
      results.push({
        op,
        path: concrete,
        status: typeof err?.status === 'number' ? err.status : null,
        error: err?.message ?? String(e),
      });
    }
  }
  return {
    generatedAt: new Date().toISOString(),
    baseUrl: '',
    tier: opts.tier,
    replayed,
    skipped,
    results,
  };
}

/** CLI 入参解析。档位/密码经环境变量（SNOWLUMA_REPLAY_TIER / SNOWLUMA_PASSWORD），
 *  规避把操作者输入直接串进 CLI 参数链；params/bodies 仍内联 JSON。 */export function parseArgs(argv: string[], env: Record<string, string | undefined> = process.env): {
  tier: Tier;
  baseUrl: string;
  password: string;
  params: Record<string, string>;
  bodies: Record<string, unknown>;
  dispose: boolean;
} {
  const args = argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i === -1 ? undefined : args[i + 1];
  };
  const tier = (env.SNOWLUMA_REPLAY_TIER ?? get('--tier')) as Tier | undefined;
  if (tier !== 't1' && tier !== 't2') {
    throw new TierRefusedError('--tier（或 SNOWLUMA_REPLAY_TIER）必须是 t1|t2（T3 永不自动重放）');
  }
  const password = env.SNOWLUMA_PASSWORD ?? get('--password');
  if (!password) {
    throw new TierRefusedError('需要 --password 或 SNOWLUMA_PASSWORD（走 bootstrapSession 建会话）');
  }
  const inline = <T>(flag: string): T => {
    const raw = get(flag);
    if (raw === undefined) return {} as T;
    return JSON.parse(raw) as T;
  };
  return {
    tier,
    baseUrl: env.SNOWLUMA_BASE_URL ?? get('--base-url') ?? 'http://127.0.0.1:5099',
    password,
    params: inline<Record<string, string>>('--params'),
    bodies: inline<Record<string, unknown>>('--bodies'),
    dispose: args.includes('--i-have-disposable-instance') || env.SNOWLUMA_DISPOSABLE === '1',
  };
}

// 注：CLI 接线（读取 SNOWLUMA_* 环境变量 → createClient → collectReplay → stdout）
// 不在本文件内 —— 见 plan6 计划文档 §CLI 接线。原因与误报裁定见该文档。
