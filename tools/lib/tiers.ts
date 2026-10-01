// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
import type { RouteOp } from '../extract-routes.js';

export type ReplayClass = 't1' | 't2' | 't3';

// 裁定 R18：验证状态取值只允许这一份真源，类型由此数组单向派生。
export const VERIFICATION_STATUSES = [
  'verified',
  'static-only',
  'unverified-requires-qq',
  'unverified-requires-nondev',
  'destructive-static-only',
] as const;

export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

// 裁定 R18 的同一处理方式（终审 I3c）：设计口径把 `x-snowluma-side-effects` 的取值绑在
// 副作用扫描器的七个标签上，并警告"新增标签必须同步改 CHECKERS，否则声明与扫描各说各话"。
// 词表原先是 side-effects-scan.ts 的模块私有数组，校验器与 spec 都无从引用 ⇒ 拼错的标签
// （如 `external_request` 少一个连字符）会静默废掉设计口径那条"GET 携带 external-fetch 永不自动重放"。
// 因此词表在此单向导出为唯一真源：扫描器的 CHECKERS 标签类型由它派生
// （见 side-effects-scan.test.ts 的逐位相等用例），校验器按它判非法取值。
// 顺序即 CHECKERS 的书写顺序，两边逐位对齐；服务端日志按设计口径明文排除，不在表内。
export const SIDE_EFFECT_LABELS = [
  'persist',
  'save',
  'clear',
  'delete-or-write-fs',
  'cookie',
  'external-fetch',
  'mutate-map',
] as const;

export type SideEffectLabel = (typeof SIDE_EFFECT_LABELS)[number];

export const EXPECTED_TIER_COUNTS: Record<ReplayClass, number> = { t1: 25, t2: 7, t3: 23 };

const T1 = [
  'GET /api/status',
  'GET /api/system',
  'GET /api/system/settings',
  'GET /api/system/storage',
  'GET /api/processes',
  'GET /api/qq-list',
  'GET /api/connections',
  'GET /api/logs',
  'GET /api/logs/level',
  'GET /api/logs/export/trace',
  'GET /api/config/:uin',
  'GET /api/agreements',
  'GET /api/auth/state',
  'GET /api/auth/totp',
  'GET /api/notifications/config',
  'GET /api/notifications/recent',
  'GET /api/global-config',
  'GET /api/ui',
  'GET /api/ui/public',
  'GET /api/update/check',
  'GET /api/debug/actions',
  'POST /api/auth/check-strength',
  'GET /api/logs/stream',
  'GET /api/state/stream',
  'GET /api/debug/stream',
];

const T2 = [
  'POST /api/login',
  'POST /api/logout',
  'POST /api/logs/level',
  'POST /api/global-config',
  'POST /api/ui',
  'POST /api/notifications/config',
  'POST /api/system/storage/settings',
];

const T3 = [
  'POST /api/debug/invoke',
  'POST /api/debug/invoke-stream',
  'POST /api/debug/upload',
  'POST /api/auth/change-password',
  'POST /api/auth/totp/begin',
  'POST /api/auth/totp/confirm',
  'POST /api/auth/totp/disable',
  'POST /api/auth/totp/recovery-codes',
  'POST /api/agreements/record-consent',
  'GET /api/system/backup/export',
  'POST /api/system/backup/import',
  'POST /api/config/:uin',
  'POST /api/system/settings',
  'POST /api/system/tls/cert',
  'DELETE /api/system/tls/cert',
  'POST /api/system/storage/cleanup',
  'GET /api/processes/:pid/probe-login',
  'POST /api/processes/:pid/load',
  'POST /api/processes/:pid/unload',
  'POST /api/processes/:pid/refresh',
  'POST /api/notifications/test',
  'POST /api/ui/background',
  'DELETE /api/ui/background',
];

function build(): Record<string, ReplayClass> {
  const map: Record<string, ReplayClass> = {};
  for (const [cls, list] of [['t1', T1], ['t2', T2], ['t3', T3]] as const) {
    for (const key of list) {
      if (map[key]) throw new Error(`分档清单重复条目：${key}`);
      map[key] = cls;
    }
  }
  return map;
}

export const REPLAY_CLASS_BY_OP = build();

export function tierKey(op: RouteOp): string {
  return `${op.method} ${op.path}`;
}

// 裁定 R19：OpenAPI 的 {x} 与上游 Express 的 :x 是同一参数的两种写法；跨两侧比对必须先归一化。
// 本文件的 55 条键是源码真值的抄录，保持 :x 形式不动；归一化真源只在此处一份，
// 消费方为 validate-spec.ts 的档级交叉核对与 check-drift.ts 的两侧键生成。
export function normalizeParamForm(path: string): string {
  return path.replace(/\{([^/}]+)\}/g, ':$1');
}

export function replayClassOf(op: RouteOp): ReplayClass {
  const key = tierKey(op);
  const cls = REPLAY_CLASS_BY_OP[key];
  if (!cls) throw new Error(`操作 ${key} 未归类（未归入任何重放档），请更新 tools/lib/tiers.ts 与设计口径`);
  return cls;
}
