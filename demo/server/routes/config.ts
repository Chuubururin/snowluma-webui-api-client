// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
/**
 * 节点配置页路由：全局配置 / OneBot 网络配置 / 通知配置与投递记录。
 *
 * 三件事决定这里的形态：
 * 1. **只有 OneBot 是整份覆盖**（`assertValidOneBotConfig(body)`，spec `:2246-2250`）⇒ 保存前必须先读回
 *    整份再合并；其余三条（global / notifications）服务端自己收 partial 并做 section-merge
 *    （`global-config.ts:90`、`notifications/config.ts:384` 的入参都是 `unknown` 归一化），
 *    所以直发补丁，本地再 deepMerge 一遍就是把同一套语义实现两次。
 * 2. **200 不等于生效**：`OneBotConfigSaveResult.applied` 为 false 是"落盘成功、热重载崩"
 *    （实码 `server.ts:1599-1611`），路由原样透传，绝不因 HTTP 200 说"已保存"。
 * 3. **写操作的危险等级不同**：`saveOneBotConfig` 与 `testNotificationChannel` 是 t3 destructive，
 *    `saveGlobalConfig` / `saveNotificationsConfig` 是 t2 + `[persist]`。四条都只在操作者点保存/点测试时发，
 *    这里没有任何自动重放路径，也没有"进页面就写一次"。
 *
 * `notifications.channelIds` 在 UI 上不暴露（declination notification-channel-ids），
 * 但整份覆盖要求把它原样回传——合并自读回来的那份，不是让人填。
 */
import * as sdk from '../../../generated/typescript/sdk.gen.js';
import { unknownUin } from '../account-presence.js';
import { fail, ok, type ApiResult, type RouteTable } from '../http.js';
import { UpstreamError, UIN_RE, unwrap, type Upstream } from '../upstream.js';
import { gateDispatch, gateGuard } from './gates.js';

/** `MessageFormat`（`onebot/src/types.ts:24`；'CQ' 在上游源码与 spec 里零命中）。 */
export const MESSAGE_FORMATS = ['array', 'string'] as const;
/** `WsRole`（`onebot/src/types.ts:25`），只属于 wsServers / wsClients 两类条目。 */
export const NODE_ROLES = ['Api', 'Event', 'Universal'] as const;

const NETWORK_KINDS = ['httpServers', 'httpClients', 'wsServers', 'wsClients'] as const;
const WS_KINDS = new Set<string>(['wsServers', 'wsClients']);
const RECENT_MAX = 100; // `server.ts:1643-1644`：缺省 100，上限 100

/** 对象逐层合；数组与非对象整体替换（四类 network 数组的语义是"这一类换掉"，不是逐元素合）。 */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
export function deepMerge(base: unknown, patch: unknown): any {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  const out: Record<string, unknown> = { ...((base ?? {}) as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (FORBIDDEN_KEYS.has(k)) continue;
    out[k] = deepMerge(out[k], v);
  }
  return out;
}

/** 只许带 pattern 内的 uin；非法值在出网前就拒（客户端选择器不是安全边界）。 */
function badUin(uin: string | null): ApiResult | null {
  if (!uin) return fail(400, '需要 uin');
  return UIN_RE.test(uin) ? null : fail(400, `uin 不符合 spec 的 uin pattern，实为 ${uin}`);
}

/** 上游校验支只认这些枚举（`config.ts:496-498` 与 `WsRole`）；非法值不发上行。 */
function validateNetworks(networks: unknown): string | null {
  if (networks === undefined) return null;
  if (!networks || typeof networks !== 'object' || Array.isArray(networks)) return 'networks 必须是对象';
  for (const kind of NETWORK_KINDS) {
    const list = (networks as Record<string, unknown>)[kind];
    if (list === undefined) continue;
    if (!Array.isArray(list)) return `networks.${kind} 必须是数组`;
    for (const item of list) {
      if (!item || typeof item !== 'object') return `networks.${kind} 的元素必须是对象`;
      const rec = item as Record<string, unknown>;
      if (rec.messageFormat !== undefined && !(MESSAGE_FORMATS as readonly string[]).includes(String(rec.messageFormat))) {
        return `networks.${kind}.messageFormat 只能是 ${MESSAGE_FORMATS.join('|')}，实为 ${String(rec.messageFormat)}`;
      }
      if (rec.role !== undefined) {
        if (!WS_KINDS.has(kind)) return `networks.${kind} 没有 role 字段（只有 wsServers|wsClients 有）`;
        if (!(NODE_ROLES as readonly string[]).includes(String(rec.role))) {
          return `networks.${kind}.role 只能是 ${NODE_ROLES.join('|')}，实为 ${String(rec.role)}`;
        }
      }
    }
  }
  return null;
}

function patchOf(ctxJson: Record<string, unknown> | undefined): Record<string, unknown> | null {
  const patch = ctxJson?.patch;
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return null;
  return Object.keys(patch).length > 0 ? (patch as Record<string, unknown>) : null;
}

/**
 * 上游错误的兜底：保住原状态码与文案（400 的枚举拒绝、413 的 512KB 上限、500 的落盘失败是三回事），
 * 再让调用点过 `gateDispatch`：上游那三种"这是门禁信号"的形状要交回门禁，不许显示成"配置保存失败"。
 */
function upstreamFail(e: unknown, label: string): ApiResult {
  if (e instanceof UpstreamError) {
    return { status: e.status, body: { success: false, message: `${label}：${e.status} ${e.message}` } };
  }
  return fail(502, `${label}：${String((e as Error)?.message ?? e)}`);
}

/** 整份覆盖的唯一一处预读：读回 → 合并 → 全量上行（`merge:'full'` 在 PARITY 里的根据）。 */
async function saveOneBotPatched(u: Upstream, uin: string, patch: Record<string, unknown>): Promise<ApiResult> {
  try {
    const current: any = unwrap(await sdk.getOneBotConfig({ client: u.client, path: { uin } }));
    const merged = deepMerge(current?.config, patch);
    // applied=false 是"落盘成、热重载崩"，原样端出（spec :592-611）
    return ok({ data: unwrap(await sdk.saveOneBotConfig({ client: u.client, path: { uin }, body: merged })) });
  } catch (e) {
    return gateDispatch(e, upstreamFail(e, 'OneBot 配置保存失败'));
  }
}

function recentLimit(raw: string | null): string {
  const n = Number(raw);
  return String(Number.isInteger(n) && n >= 1 ? Math.min(n, RECENT_MAX) : RECENT_MAX);
}

export const configRoutes: RouteTable = {
  // OneBot 账号选择器的数据源；uin 由这里选出来，不让人手填数字（pattern 仍由路由核）
  'GET /config/accounts': async (_ctx, u) => {
    const rejected = gateGuard(u);
    if (rejected) return rejected;
    try {
      return ok({ data: unwrap(await sdk.listQq({ client: u.client })) });
    } catch (e) {
      return gateDispatch(e, upstreamFail(e, '账号列表读取失败'));
    }
  },

  'GET /globalconfig': async (_ctx, u) => {
    const rejected = gateGuard(u);
    if (rejected) return rejected;
    try {
      return ok({ data: unwrap(await sdk.getGlobalConfig({ client: u.client })) });
    } catch (e) {
      return gateDispatch(e, upstreamFail(e, '全局配置读取失败'));
    }
  },

  // t2 + [persist]：服务端归一化并 section-merge ⇒ 直发补丁
  'POST /globalconfig': async (ctx, u) => {
    const rejected = gateGuard(u);
    if (rejected) return rejected;
    const patch = patchOf(ctx.json);
    if (!patch) return fail(400, '需要非空的 patch 对象');
    try {
      return ok({ data: unwrap(await sdk.saveGlobalConfig({ client: u.client, body: patch })) });
    } catch (e) {
      return gateDispatch(e, upstreamFail(e, '全局配置保存失败'));
    }
  },

  'GET /onebot-config': async (ctx, u) => {
    const rejected = gateGuard(u);
    if (rejected) return rejected;
    const uin = ctx.query.get('uin');
    const bad = badUin(uin);
    if (bad) return bad;
    const unknown = await unknownUin(u, uin as string);
    if (unknown) return unknown;
    try {
      const res: any = unwrap(await sdk.getOneBotConfig({ client: u.client, path: { uin: uin as string } }));
      return ok({ data: res?.config ?? null, uin });
    } catch (e) {
      return gateDispatch(e, upstreamFail(e, 'OneBot 配置读取失败'));
    }
  },

  // t3 + destructive：整份覆盖 + 落盘 + 热重载
  'POST /onebot-config': async (ctx, u) => {
    const rejected = gateGuard(u);
    if (rejected) return rejected;
    const uin = ctx.query.get('uin');
    const bad = badUin(uin);
    if (bad) return bad;
    const patch = patchOf(ctx.json);
    if (!patch) return fail(400, '需要非空的 patch 对象');
    // 本地判得出的枚举先判：非法补丁不该为了"这个账号存在吗"多发一次 qq-list。
    const invalid = validateNetworks(patch.networks);
    if (invalid) return fail(400, invalid);
    const unknown = await unknownUin(u, uin as string);
    if (unknown) return unknown;
    return saveOneBotPatched(u, uin as string, patch);
  },

  'GET /notifications-config': async (_ctx, u) => {
    const rejected = gateGuard(u);
    if (rejected) return rejected;
    try {
      return ok({ data: unwrap(await sdk.getNotificationsConfig({ client: u.client })) });
    } catch (e) {
      return gateDispatch(e, upstreamFail(e, '通知配置读取失败'));
    }
  },

  'POST /notifications-config': async (ctx, u) => {
    const rejected = gateGuard(u);
    if (rejected) return rejected;
    const patch = patchOf(ctx.json);
    if (!patch) return fail(400, '需要非空的 patch 对象');
    try {
      return ok({ data: unwrap(await sdk.saveNotificationsConfig({ client: u.client, body: patch })) });
    } catch (e) {
      return gateDispatch(e, upstreamFail(e, '通知配置保存失败'));
    }
  },

  // t3 + destructive：真往渠道发一条。200 里 success 可为 false（TestSendResult），原样端出
  'POST /notifications-test': async (ctx, u) => {
    const rejected = gateGuard(u);
    if (rejected) return rejected;
    const channelId = ctx.json?.channelId;
    if (typeof channelId !== 'string' || !channelId) return fail(400, '需要 channelId');
    try {
      return ok({ data: unwrap(await sdk.testNotificationChannel({ client: u.client, body: { channelId } })) });
    } catch (e) {
      return gateDispatch(e, upstreamFail(e, '测试发送失败'));
    }
  },

  // 真形是 {recent}，不是 {list}：读错键会永远显示"暂无记录"且不报错（设计口径）
  'GET /notifications-recent': async (ctx, u) => {
    const rejected = gateGuard(u);
    if (rejected) return rejected;
    const limit = recentLimit(ctx.query.get('limit'));
    try {
      const res: any = unwrap(await sdk.listRecentNotifications({ client: u.client, query: { limit } }));
      return ok({ data: res?.recent ?? [] });
    } catch (e) {
      return gateDispatch(e, upstreamFail(e, '投递记录读取失败'));
    }
  },
};
