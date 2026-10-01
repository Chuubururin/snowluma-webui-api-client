// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
/**
 * 日志页路由：近期日志、级别读/写、TRACE 全量导出。
 *
 * 三条已核实的事实决定这里的形状：
 * 1. **列表与级别是两次读**：`GET /api/logs` 的 200 只有 `{list}`（`spec:2358-2364`），
 *    级别来自 `GET /api/logs/level` 的 `{level, levels}`（`:2384-2390`）。把两者当一条读，
 *    就会在级别那条挂掉时把列表也画成空（设计口径那一类）。
 * 2. **`limit` 上游缺省 300**（`server.ts:1425` 的 `Number(query ?? 300)`），demo 跟着取 300；
 *    钳位到 1..5000 是**本 demo 自己的策略**（上游对 limit 没有文档化的上下限，`getRecentLogs`
 *    在缓存八文件之外无从确证），不是上游语义。值按 spec 声明以**字符串**上行（`:2350-2354`）。
 * 3. **导出是唯一非 JSON 的 200**（`text/plain`，`:2414-2449`）。生成的客户端没有读响应头的能力的
 *    （`responseHeader` 在 generated 里零命中）⇒ 上游那个 `Content-Disposition` 拿不到，
 *    文件名只能从正文的 `Export time:` 行按上游同一规则拼（`log-export.ts:26-29`）。
 *    非 2xx 与其余路由同样交 `unwrap` 折叠：实测 `parseAs: 'text'` 只影响 200 正文，
 *    `res.error` 仍是解析好的对象（探针：`typeof error === 'object'` 且带
 *    `consentRequired`），所以这里不需要、也没有"把字符串错误体再 JSON.parse 回来"的分支。
 */
import * as sdk from '../../../generated/typescript/sdk.gen.js';
import { fail, ok, type ApiResult, type RouteTable } from '../http.js';
import { UpstreamError, unwrap } from '../upstream.js';
import { gateDispatch, gateGuard } from './gates.js';

/** 与上游一致（`server.ts:1425`）；demo 不放这个值就会比真产品少读 100 行。 */
export const LIMIT_DEFAULT = 300;
/** demo 侧策略：一条 query 就能让上游去拼五万行文本，这里先自己封顶。 */
export const LIMIT_MIN = 1;
export const LIMIT_MAX = 5000;

/** 非法/非正数回落默认，小数截断，越界钳位。 */
export function clampLimit(raw: string | null): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < LIMIT_MIN) return LIMIT_DEFAULT;
  return Math.min(Math.trunc(n), LIMIT_MAX);
}

/** 上游的文件名规则：`exportedAt.slice(0,19)` 后把 `:` 与 `.` 换成 `-`（保留中间的 `T`）。 */
export const TRACE_FILE_PREFIX = 'snowluma-trace-';
const EXPORT_TIME_RE = /^Export time:\s*(.+)$/m;

/** 读不到 `Export time:` 就返回 null：宁可说"未给出"，也不拿本地时间冒充上游那一份。 */
export function traceFilename(body: string): string | null {
  const m = EXPORT_TIME_RE.exec(body ?? '');
  if (!m) return null;
  return TRACE_FILE_PREFIX + m[1].slice(0, 19).replace(/[:.]/g, '-') + '.log';
}

/** 导出正文的元信息头（`log-export.ts:44-53`）：这七行就是页面上那张"导出摘要"。 */
export function traceSummary(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of String(body ?? '').split('\n').slice(0, 12)) {
    const i = line.indexOf(': ');
    if (i < 1) continue;
    out[line.slice(0, i)] = line.slice(i + 2);
  }
  return out;
}

/** 保住上游的 400 形状（`{message, levels}`，无 success 键），并让门禁三形先走 gateDispatch。 */
function levelFail(e: unknown): ApiResult {
  if (e instanceof UpstreamError) {
    const body = (e.body ?? {}) as Record<string, unknown>;
    const out: Record<string, unknown> = { message: typeof body.message === 'string' ? body.message : e.message };
    if (Array.isArray(body.levels)) out.levels = body.levels;
    return { status: e.status, body: out };
  }
  return fail(502, `日志级别设置失败：${String((e as Error)?.message ?? e)}`);
}

export const logRoutes: RouteTable = {
  'GET /logs': async (ctx, u) => {
    const rejected = gateGuard(u);
    if (rejected) return rejected;
    const limit = String(clampLimit(ctx.query.get('limit')));
    try {
      const res: any = unwrap(await sdk.listLogs({ client: u.client, query: { limit } }));
      // 真形只有 {list}；读错键的话页面会永远显示"无日志"而不报错（设计口径）
      return ok({ data: Array.isArray(res?.list) ? res.list : [], limit });
    } catch (e) {
      return gateDispatch(e, fail(502, `日志读取失败：${String((e as Error)?.message ?? e)}`));
    }
  },

  'GET /loglevel': async (_ctx, u) => {
    const rejected = gateGuard(u);
    if (rejected) return rejected;
    try {
      return ok({ data: unwrap(await sdk.getLogLevel({ client: u.client })) });
    } catch (e) {
      return gateDispatch(e, fail(502, `日志级别读取失败：${String((e as Error)?.message ?? e)}`));
    }
  },

  // t2 + mutate-map：即时生效、只改内存 logger，不持久化 ⇒ 回显生效后的 {level, levels}
  'POST /loglevel': async (ctx, u) => {
    const rejected = gateGuard(u);
    if (rejected) return rejected;
    const level = ctx.json?.level;
    if (typeof level !== 'string' || !level) return fail(400, '需要 level（六值之一，由上游判定）');
    try {
      return ok({ data: unwrap(await sdk.setLogLevel({ client: u.client, body: { level } })) });
    } catch (e) {
      return gateDispatch(e, levelFail(e));
    }
  },

  // 正文交回客户端做 Blob 下载，页面只渲染元信息摘要，不 dump 原文
  'GET /export-trace': async (_ctx, u) => {
    const rejected = gateGuard(u);
    if (rejected) return rejected;
    try {
      // 200 正文按 text 取；非 2xx 交唯一的折叠点（错误体在客户端侧已是解析好的对象）
      const text = String(unwrap<string>(await sdk.exportTraceLog({ client: u.client, parseAs: 'text' })) ?? '');
      const filename = traceFilename(text);
      return ok({
        data: {
          text,
          filename,
          summary: traceSummary(text),
          filenameNote: filename ? undefined : '导出正文里没有 Export time 行，文件名未给出（不代造）',
        },
      });
    } catch (e) {
      return gateDispatch(e, fail(502, `TRACE 导出失败：${String((e as Error)?.message ?? e)}`));
    }
  },
};
