// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
/**
 * 操作清单构建（spec 单源）：从 spec/openapi.yaml 构建全部操作的元数据表，
 * 供控制台（demo/dashboard.ts）与独立验证编排器（tools/verify-all.ts）共用。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

export interface OpEntry {
  fn: string;
  method: string;
  path: string;
  tier: string;
  kind: 'json' | 'sse';
  note?: string;
}

export const PATH_PARAMS: Record<string, string> = { uin: '10000', pid: '999' };
export const SSE_FNS = new Set(['streamState', 'streamLogs', 'streamDebugEvents', 'streamDebugAction']);

/** 安全边界注记：这些操作仍会自动调用，但负载取安全形态（详见各注记）。 */
export const OP_NOTES: Record<string, string> = {
  cleanupStorage: "自动调用 scope='temporary'（清理上传临时文件）；真实 logs 清理属破坏性，操作者手动",
  confirmTotpEnrollment: '自动调用正确密码+错码→验证码分支（401 验证码不正确）',
  importBackup: '自动调用先导出真实备份再原样导入（净零往返）；导入外部包属破坏性，操作者手动',
  deleteTlsCert: '往返还原：uploadTlsCert（openssl 自签）→ deleteTlsCert',
  deleteBackgroundImage: '往返还原：uploadBackgroundImage（1×1 PNG）→ clearBackgroundImage',
  changePassword: '成功路径刻意不在生产实例执行（凭据变更风险）；错误分支已验证',
};

/**
 * 仓根 spec：从本模块位置反推。不用 CWD 相对字面量 —— 出仓消费（工件装在别处）与
 * CI 的工作目录都不保证是仓根，而那种 ENOENT 在源码树的全部门禁里永远看不见。
 * 写法与 adapters/typescript/live.test.ts 的既有解析同形。
 */
const REPO_SPEC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'spec', 'openapi.yaml');

interface SpecShape {
  paths: Record<string, Record<string, { operationId?: string; 'x-replay-class'?: string; summary?: string }>>;
  info?: { title?: string; version?: string };
}

export function loadSpec(specPath?: string): SpecShape {
  return parseYaml(readFileSync(specPath ?? REPO_SPEC, 'utf8')) as SpecShape;
}

/** 从 spec 构建全部操作清单（55 条）。 */
export function buildOperations(spec: SpecShape): OpEntry[] {
  const ops: OpEntry[] = [];
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(item)) {
      if (!['get', 'post', 'put', 'delete', 'patch'].includes(method)) continue;
      const fn = op.operationId ?? `${method}${path.replace(/[^a-zA-Z0-9]/g, '')}`;
      const tier = op['x-replay-class'] ?? '?';
      ops.push({
        fn, method: method.toUpperCase(), path,
        tier, kind: SSE_FNS.has(fn) ? 'sse' : 'json',
        note: OP_NOTES[fn],
      });
    }
  }
  return ops;
}

/** 加载 spec 并构建操作清单（一步到位）。 */
export function buildOperationsFromSpec(specPath?: string): { spec: SpecShape; operations: OpEntry[] } {
  const spec = loadSpec(specPath);
  return { spec, operations: buildOperations(spec) };
}

/** 操作的默认调用参数：path 参数代入默认值。 */
export function optionsFor(op: OpEntry): Record<string, any> {
  const options: Record<string, any> = {};
  const params: Record<string, string> = {};
  for (const m of op.path.match(/\{([^}]+)\}/g) ?? []) {
    const name = m.slice(1, -1);
    params[name] = PATH_PARAMS[name] ?? '10000';
  }
  if (Object.keys(params).length) options.path = params;
  return options;
}
