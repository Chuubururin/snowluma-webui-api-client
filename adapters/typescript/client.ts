// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
/**
 * SnowLuma WebUI 管理面 TypeScript 适配层（设计口径）。
 *
 * 在传输之上提供三块价值：
 * 1. **归一化**：响应体按 adapters/rules.json 单源规则表变换（设计口径，规则单源、实现三份）；
 * 2. **门控引导**：bootstrapSession 可重入循环（设计口径）——login → consent 闸 → 改密闸 →
 *    改密成功后服务端已 sessionTokens.clear()，必须用新密码回到 login；
 * 3. **会话生命周期**：401 按方法安全性分治（设计口径）——GET/HEAD 自动重登一次并重放原请求，
 *    例外是带 external-fetch 副作用标记的 GET（/api/update/check，自动重放等于打外部版本源）；
 *    非幂等写方法 401 一律不重放，抛 SessionExpiredError 由调用方决定。
 *
 * 传输可注入（测试用脚本化假传输，不需要活实例）。
 */
import { applyRules, loadRules, validateRules, type RulesTable } from './rules.js';

export interface TransportResult {
  status: number;
  /** 已 JSON 解析的响应体；非 JSON 响应为字符串或 undefined。 */
  json: unknown;
}

/** 传输函数：发一个请求，返回状态码与解析后的 JSON 体。注入自定义实现即可离线测试。 */
export type Transport = (
  method: string,
  path: string,
  opts: { body?: unknown; headers?: Record<string, string> },
) => Promise<TransportResult>;

export class AdapterError extends Error {
  constructor(
    message: string,
    readonly kind: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** 登录失败（401 密码错 / 429 限速 / 500 落盘失败）。429 的等待秒数只在中文文案里，无独立字段。 */
export class LoginError extends AdapterError {
  constructor(
    kind: 'rejected' | 'locked' | 'failed',
    message: string,
    readonly status: number,
  ) {
    super(`登录失败（${kind}）：${message}`, kind, status);
  }
}

export class TotpRequiredError extends AdapterError {
  constructor() {
    super('需要第二因子（TOTP）：带 totp 重调 bootstrapSession', 'totp-required');
  }
}

export class ConsentRequiredError extends AdapterError {
  constructor(
    readonly documents: unknown[],
    readonly version: string,
  ) {
    super(
      `需要同意用户协议（version=${version}）——同意是替操作者做的法律行为，默认不代做；` +
        '显式传 acceptAgreements: true 解锁',
      'consent-required',
    );
  }
}

export class PasswordWeakError extends AdapterError {
  constructor(
    readonly rules: unknown[],
  ) {
    super('新密码未通过强度要求', 'password-weak', 400);
  }
}

export class PasswordChangeRequiredError extends AdapterError {
  constructor() {
    super('服务端要求改密但未提供 newPassword', 'password-change-required');
  }
}

export class SessionExpiredError extends AdapterError {
  constructor(
    readonly method: string,
    readonly path: string,
    reason: string,
  ) {
    super(`会话失效且不自动恢复（${method} ${path}）：${reason}`, 'session-expired', 401);
  }
}

export interface BootstrapOptions {
  password: string;
  /** 服务端要求改密时使用；缺省且命中改密闸则抛 PasswordChangeRequiredError。 */
  newPassword?: string;
  /** 默认 false：同意 EULA 是替操作者做的法律行为，不默认代做（设计口径）。 */
  acceptAgreements?: boolean;
  /** 第二因子验证码；服务端返回 needsTotp 且未提供时抛 TotpRequiredError。 */
  totp?: string;
}

export interface SessionState {
  token: string;
  consentRequired: boolean;
  mustChangePassword: boolean;
}

export interface Client {
  /** 设计口径门控引导。可重入：改密成功（requireRelogin）后自动用新密码回到 login。 */
  bootstrapSession(opts: BootstrapOptions): Promise<SessionState>;
  /** 归一化请求：2xx 返回按规则表变换后的 JSON 体；401 按设计口径分治。 */
  request(method: string, path: string, body?: unknown): Promise<unknown>;
  /** 当前 token（bootstrap 之后有效）。 */
  readonly token: string | null;
}

const SAFE_METHODS = new Set(['GET', 'HEAD']);
/** 设计口径例外只认 external-fetch 这一种标记：带它的 GET 401 不自动重放（外打版本源）。
 *  同为带副作用标记的 /api/status（`cookie`）续签的是会话自身 cookie，仍走自动重放。 */
const NO_AUTO_REPLAY_PATHS = new Set(['/api/update/check']);
const BOOTSTRAP_MAX_PASSES = 4;

/**
 * 200 的响应体必须是对象。网关错误页、截断响应或被改写过的代理回包都可能让 200 带上
 * 字符串 / null / 数组 / 数字。这跟"缺 token"是同一类协议分歧 ⇒ 报结构化的 protocol 错，
 * 而不是让调用点抛 `TypeError: Cannot read properties of null`（既没有 where 也没有形状信息）。
 * 三语适配器同形：Python 侧是 `_as_object`，Go 侧是解码失败映射到 protocol。
 */
function asObject(json: unknown, where: string): Record<string, unknown> {
  const shape = Array.isArray(json) ? 'array' : json === null ? 'null' : typeof json;
  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    throw new AdapterError(`${where} 的 200 响应体不是对象（实为 ${shape}）`, 'protocol');
  }
  return json as Record<string, unknown>;
}

/**
 * baseUrl 入参契约（单一咽喉点，所有 createClient 入口共用）：
 * 协议限 http/https、禁止 userinfo。SnowLuma 实例通常就在操作者本机（127.0.0.1:5099），
 * 这里不做内网阻断 —— 阻断环回会破坏主要用途；校验的意义是把 URL 的形态变成显式契约。
 */
export function validateBaseUrl(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new AdapterError(`baseUrl 协议必须是 http/https，实为 ${parsed.protocol}`, 'protocol');
  }
  if (parsed.username || parsed.password) {
    throw new AdapterError('baseUrl 不应携带 userinfo', 'protocol');
  }
  return parsed.toString().replace(/\/$/, '');
}

export function createClient(opts: {
  baseUrl?: string;
  rules?: RulesTable;
  rulesPath?: string;
  transport?: Transport;
}): Client {
  // 注入的规则表与从磁盘读到的一样过结构校验：非法表静默失效等于把 fail-closed 洗成 fail-open。
  // 按键存在性分派（与 golden runner 同裁定）：显式传 null 也走校验并抛错，不静默回退仓库表。
  const rules = opts.rules !== undefined ? validateRules(opts.rules) : loadRules(opts.rulesPath);
  const base = validateBaseUrl(opts.baseUrl ?? 'http://127.0.0.1:5099');
  const transport: Transport =
    opts.transport ??
    (async (method, path, o) => {
      const res = await fetch(base + path, {
        method,
        headers: { 'content-type': 'application/json', ...(o.headers ?? {}) },
        // null 与 undefined 同样视为"无请求体"：GET 带序列化出来的 "null" 会被 fetch 拒绝
        body: o.body == null ? undefined : JSON.stringify(o.body),
      });
      const text = await res.text();
      let json: unknown = text;
      try {
        json = JSON.parse(text);
      } catch {
        /* 非 JSON（如 SSE/text）原样保留 */
      }
      return { status: res.status, json };
    });

  let token: string | null = null;
  let password: string | null = null;
  let totp: string | undefined;

  const call = async (
    method: string,
    path: string,
    body?: unknown,
    authHeader?: string,
  ): Promise<TransportResult> => {
    const headers: Record<string, string> = { ...(authHeader ? { authorization: authHeader } : {}) };
    return transport(method, path, { body, headers });
  };

  const loginOnce = async (pwd: string): Promise<TransportResult> => {
    const body: Record<string, string> = { password: pwd };
    if (totp !== undefined) body.totp = totp;
    return call('POST', '/api/login', body);
  };

  const normalize = (method: string, path: string, json: unknown): unknown =>
    applyRules(rules, method, path, json);

  const requestInternal = async (
    method: string,
    path: string,
    body: unknown,
    allowRelogin: boolean,
  ): Promise<unknown> => {
    if (!token) throw new AdapterError('未建立会话：先 bootstrapSession', 'no-session');
    const res = await call(method, path, body, `Bearer ${token}`);
    if (res.status === 401) {
      if (SAFE_METHODS.has(method) && !NO_AUTO_REPLAY_PATHS.has(path) && allowRelogin && password !== null) {
        // 设计口径：安全方法 401 → 重登一次 → 重放原请求 → 仍失败抛错。
        const r = await loginOnce(password);
        if (r.status === 200) {
          const b = r.json as { token?: string };
          if (typeof b.token === 'string') {
            token = b.token;
            return requestInternal(method, path, body, false);
          }
        }
        throw new SessionExpiredError(method, path, '重登失败（密码可能已变更或账号被限速）');
      }
      const reason =
        method === 'GET' || method === 'HEAD'
          ? '该 GET 带 external-fetch 副作用标记，自动重放会打外部版本源'
          : '非幂等写方法不自动重放（重复执行有实际后果）';
      throw new SessionExpiredError(method, path, reason);
    }
    if (res.status >= 400) {
      const env = res.json as { message?: string };
      throw new AdapterError(
        `${method} ${path} 失败（${res.status}）：${typeof env?.message === 'string' ? env.message : JSON.stringify(res.json)}`,
        'request-failed',
        res.status,
      );
    }
    return normalize(method, path, res.json);
  };

  return {
    get token() {
      return token;
    },

    async request(method: string, path: string, body?: unknown): Promise<unknown> {
      return requestInternal(method.toUpperCase(), path, body, true);
    },

    async bootstrapSession(session: BootstrapOptions): Promise<SessionState> {
      password = session.password;
      totp = session.totp;
      let mustChange = false;
      for (let pass = 0; pass < BOOTSTRAP_MAX_PASSES; pass += 1) {
        // ── 步骤 1：login ──
        const login = await loginOnce(password);
        if (login.status !== 200) {
          const env = login.json as { message?: string };
          const message = typeof env?.message === 'string' ? env.message : JSON.stringify(login.json);
          const kind = login.status === 401 ? 'rejected' : login.status === 429 ? 'locked' : 'failed';
          throw new LoginError(kind, message, login.status);
        }
        const body = asObject(login.json, 'POST /api/login') as {
          success?: boolean;
          needsTotp?: boolean;
          token?: string;
          mustChangePassword?: boolean;
        };
        if (body.needsTotp === true) {
          throw new TotpRequiredError();
        }
        if (typeof body.token !== 'string') {
          throw new AdapterError('login 200 缺 token（形状与 spec LoginSuccess 不符）', 'protocol');
        }
        token = body.token;
        mustChange = body.mustChangePassword === true;

        // ── 步骤 2：consent 闸 ──
        const agreements = (await call('GET', '/api/agreements', undefined, `Bearer ${token}`)) as TransportResult;
        if (agreements.status === 200) {
          // 非对象体按可选键读会静默跳过同意闸（fail-open）——比抛错更糟的形状。
          const payload = asObject(agreements.json, 'GET /api/agreements') as {
            version: string;
            consentRequired: boolean;
            documents: unknown[];
          };
          if (payload.consentRequired === true) {
            if (typeof payload.version !== 'string') {
              throw new AdapterError('同意闸 200 缺 version（record-consent 的必填体无从取得）', 'protocol');
            }
            if (session.acceptAgreements !== true) {
              throw new ConsentRequiredError(payload.documents ?? [], payload.version);
            }
            let recorded = await call(
              'POST',
              '/api/agreements/record-consent',
              { version: payload.version },
              `Bearer ${token}`,
            );
            if (recorded.status === 409) {
              // 设计口径：409 {currentVersion} → 用返回版本重试，仅一次。
              const mismatch = recorded.json as { currentVersion?: string };
              if (typeof mismatch?.currentVersion !== 'string') {
                throw new AdapterError('record-consent 409 缺 currentVersion', 'protocol', 409);
              }
              recorded = await call(
                'POST',
                '/api/agreements/record-consent',
                { version: mismatch.currentVersion },
                `Bearer ${token}`,
              );
            }
            if (recorded.status !== 200) {
              const env = recorded.json as { message?: string };
              throw new AdapterError(
                `record-consent 失败（${recorded.status}）：${typeof env?.message === 'string' ? env.message : ''}`,
                'request-failed',
                recorded.status,
              );
            }
          }
        }

        // ── 步骤 3：改密闸 ──
        if (!mustChange) {
          // ── 步骤 4：返回归一化会话状态 ──
          return { token, consentRequired: false, mustChangePassword: false };
        }
        if (session.newPassword === undefined) {
          throw new PasswordChangeRequiredError();
        }
        const changed = await call(
          'POST',
          '/api/auth/change-password',
          { oldPassword: password, newPassword: session.newPassword },
          `Bearer ${token}`,
        );
        if (changed.status === 400) {
          const env = changed.json as { message?: string; rules?: unknown[] };
          if (Array.isArray(env?.rules)) throw new PasswordWeakError(env.rules);
          throw new AdapterError(
            `改密失败（400）：${typeof env?.message === 'string' ? env.message : ''}`,
            'password-failed',
            400,
          );
        }
        if (changed.status !== 200) {
          const env = changed.json as { message?: string };
          throw new AdapterError(
            `改密失败（${changed.status}）：${typeof env?.message === 'string' ? env.message : ''}`,
            'password-failed',
            changed.status,
          );
        }
        const ok = asObject(changed.json, 'POST /api/auth/change-password') as { success?: boolean; requireRelogin?: boolean };
        if (ok.success !== true || ok.requireRelogin !== true) {
          throw new AdapterError('change-password 200 形状与 spec PasswordChanged 不符', 'protocol');
        }
        // ★ 服务端已 sessionTokens.clear()，当前 token 当场作废 → 用新密码回步骤 1。
        password = session.newPassword;
        token = null;
      }
      throw new AdapterError(`bootstrap 循环超过 ${BOOTSTRAP_MAX_PASSES} 轮仍未收敛`, 'protocol');
    },
  };
}
