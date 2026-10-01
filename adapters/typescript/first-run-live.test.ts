// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
/**
 * 首启门控链 + 重放采集器的活实例测试（设计口径/设计口径在**生产凭据模式**下的覆盖）。
 *
 * 仅 SNOWLUMA_LIVE=1 运行；目标必须是可牺牲实例（T2 写真实落盘）。
 *
 * 存在的理由：既有 live 一致性套件跑在 dev 模式实例上，而 dev 模式禁用了改密与 2FA
 * （上游 auth.ts:289/335），所以设计口径的改密闸与 `/api/auth/totp` 的 200 形状从未被真实
 * 采集过。本文件专补这三处：
 * 1. 首启全链：consent 闸（不带 accept 必须抛 ConsentRequiredError）→ 改密闸（不带
 *    newPassword 必须抛 PasswordChangeRequiredError）→ 双闸同开时收敛，且旧密码当场失效；
 * 2. 生产模式下 `GET /api/auth/totp` 的 200 形状（dev 模式只能拿到 400）；
 * 3. `tools/replay.ts` 的 collectReplay 对活实例的首次真实执行（含 T3 硬拒、T2 缺
 *    可牺牲声明硬拒）。
 *
 * T2 分两轮的真实原因：批次里 `POST /api/logout` 会让当次 token 失效，而设计口径规定非幂等
 * 写不自动重登，故其后的写必然 401。第一轮取 login/logout 的 200 形状，第二轮重登后取五条
 * 配置写的 200 形状——两轮都是工具的真实输出，不做拼裁。
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ConsentRequiredError,
  LoginError,
  PasswordChangeRequiredError,
  createClient,
} from './client.js';
import { TierRefusedError, collectReplay } from '../../tools/replay.js';

const LIVE = process.env.SNOWLUMA_LIVE === '1';
const BASE_URL = 'http://127.0.0.1:5099'; // 可牺牲实例固定目标（与 spec servers 块一致）
const INITIAL_PASSWORD = process.env.SNOWLUMA_INITIAL_PASSWORD ?? '';
// 强度须过上游 PASSWORD_RULES：≥10 位 + 大小写 + 特殊符号 + 无空格
const NEW_PASSWORD = 'Sl!F1rstrun-2026';
const EVIDENCE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'docs',
  'superpowers',
  'evidence',
);

const T1_BODIES = { 'POST /api/auth/check-strength': { password: NEW_PASSWORD } };
const T2_LOGIN = { 'POST /api/login': { password: NEW_PASSWORD } };
const T2_LOGOUT = { 'POST /api/logout': {} };
const T2_UI_WRITE_KEY = 'POST /api/ui';
const T2_CONFIG_WRITES = {
  'POST /api/logs/level': { level: 'info' },
  'POST /api/global-config': { rkey: { fallbackServers: ['https://replay.invalid/rk'] }, musicSignUrl: 'https://replay.invalid/sign' },
  'POST /api/notifications/config': { enabled: false },
  'POST /api/system/storage/settings': { logMaxTotalMb: 512, logRetainDays: 7, logPerUin: false },
};

function writeEvidence(name: string, payload: unknown): string {
  const file = join(EVIDENCE_DIR, name);
  writeFileSync(file, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  return file;
}

describe.skipIf(!LIVE)('首启门控链与重放采集器（生产凭据模式 · SNOWLUMA_LIVE=1）', () => {
  it('前置：必须提供首启随机口令（SNOWLUMA_INITIAL_PASSWORD）', () => {
    expect(INITIAL_PASSWORD.length).toBeGreaterThan(0);
  });

  it('设计口径 consent 闸：不带 acceptAgreements 必须抛 ConsentRequiredError 并附文档', async () => {
    const client = createClient({ baseUrl: BASE_URL });
    await expect(client.bootstrapSession({ password: INITIAL_PASSWORD })).rejects.toBeInstanceOf(
      ConsentRequiredError,
    );
    const err = await client
      .bootstrapSession({ password: INITIAL_PASSWORD })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConsentRequiredError);
    const consent = err as unknown as { documents: unknown[]; version: string };
    expect(Array.isArray(consent.documents)).toBe(true);
    expect(consent.documents.length).toBeGreaterThan(0);
    expect(typeof consent.version).toBe('string');
  });

  it('设计口径改密闸：服务端要求改密而未给 newPassword 必须抛 PasswordChangeRequiredError', async () => {
    const client = createClient({ baseUrl: BASE_URL });
    await expect(
      client.bootstrapSession({ password: INITIAL_PASSWORD, acceptAgreements: true }),
    ).rejects.toBeInstanceOf(PasswordChangeRequiredError);
  });

  it('设计口径双闸同开时收敛，且旧密码当场失效', async () => {
    const client = createClient({ baseUrl: BASE_URL });
    const session = await client.bootstrapSession({
      password: INITIAL_PASSWORD,
      acceptAgreements: true,
      newPassword: NEW_PASSWORD,
    });
    expect(typeof session.token).toBe('string');
    expect(session.mustChangePassword).toBe(false);
    // 改密后服务端 sessionTokens.clear()，旧密码须走 rejected 分支
    const stale = createClient({ baseUrl: BASE_URL });
    await expect(
      stale.bootstrapSession({ password: INITIAL_PASSWORD, acceptAgreements: true }),
    ).rejects.toBeInstanceOf(LoginError);
    // 新密码可续用会话（consent 已记录，故不再触发改密闸）
    const again = createClient({ baseUrl: BASE_URL });
    const second = await again.bootstrapSession({ password: NEW_PASSWORD, acceptAgreements: true });
    expect(typeof second.token).toBe('string');
    expect(second.consentRequired).toBe(false);
  });

  it('设计口径生产模式下 GET /api/auth/totp 返回 200 且形状与 spec 登记一致', async () => {
    const client = createClient({ baseUrl: BASE_URL });
    await client.bootstrapSession({ password: NEW_PASSWORD, acceptAgreements: true });
    const body = (await client.request('GET', '/api/auth/totp')) as Record<string, unknown>;
    expect(typeof body).toBe('object');
    expect(body.enabled).toBe(false); // 未启用 2FA 的实例
    expect(Array.isArray(Object.keys(body))).toBe(true);
    writeEvidence('totp-200.json', { capturedAt: new Date().toISOString(), body });
  });

  it('设计口径 collectReplay 对 t3 硬拒、对 t2 缺可牺牲声明硬拒', async () => {
    const client = createClient({ baseUrl: BASE_URL });
    await client.bootstrapSession({ password: NEW_PASSWORD, acceptAgreements: true });
    await expect(collectReplay({ client, tier: 't3' })).rejects.toBeInstanceOf(TierRefusedError);
    await expect(
      collectReplay({ client, tier: 't2', params: { uin: '10000' } }),
    ).rejects.toBeInstanceOf(TierRefusedError);
  });

  it('设计口径 T1 全档真实重放（25 条：22 重放 + 3 SSE 按设计跳过）', async () => {
    const client = createClient({ baseUrl: BASE_URL });
    await client.bootstrapSession({ password: NEW_PASSWORD, acceptAgreements: true });
    const report = await collectReplay({
      client,
      tier: 't1',
      params: { uin: '10000' },
      bodies: T1_BODIES,
    });
    expect(report.replayed).toBe(22);
    expect(report.skipped).toBe(3);
    const failures = report.results.filter(
      (r) => 'status' in r && typeof r.status === 'number' && r.status >= 400,
    );
    writeEvidence('replay-t1-prod.json', { ...report, baseUrl: BASE_URL });
    expect(failures).toEqual([]);
  });

  it('设计口径 T2 第一轮：login/logout 的 200 形状（此后当次 token 失效属预期）', async () => {
    const client = createClient({ baseUrl: BASE_URL });
    await client.bootstrapSession({ password: NEW_PASSWORD, acceptAgreements: true });
    const report = await collectReplay({
      client,
      tier: 't2',
      params: { uin: '10000' },
      bodies: { ...T2_LOGIN, ...T2_LOGOUT, ...T2_CONFIG_WRITES },
      disposeInstance: true,
    });
    const login = report.results.find((r) => 'op' in r && r.op === 'POST /api/login');
    const logout = report.results.find((r) => 'op' in r && r.op === 'POST /api/logout');
    expect(login && 'status' in login ? login.status : null).toBe(200);
    expect(logout && 'status' in logout ? logout.status : null).toBe(200);
    writeEvidence('replay-t2-round-a.json', { ...report, baseUrl: BASE_URL });
  });

  it('设计口径 T2 第二轮：重登后五条配置写全部 200 且写后读回一致', async () => {
    const client = createClient({ baseUrl: BASE_URL });
    await client.bootstrapSession({ password: NEW_PASSWORD, acceptAgreements: true });
    // POST /api/ui 收自由对象：用当前读回值原样写回，避免臆造负载
    const currentUi = await client.request('GET', '/api/ui');
    const report = await collectReplay({
      client,
      tier: 't2',
      params: { uin: '10000' },
      bodies: { ...T2_CONFIG_WRITES, [T2_UI_WRITE_KEY]: currentUi }, // login/logout 无体 → 按设计记 skipped
      disposeInstance: true,
    });
    expect(report.replayed).toBe(5);
    expect(report.skipped).toBe(2);
    const bad = report.results.filter(
      (r) => 'status' in r && typeof r.status === 'number' && r.status >= 400,
    );
    expect(bad).toEqual([]);
    // 写后读回：适配层拿到的正是服务端记下的值
    const level = (await client.request('GET', '/api/logs/level')) as { level: string };
    expect(level.level).toBe('info');
    const global = (await client.request('GET', '/api/global-config')) as {
      config: { rkey: { fallbackServers: string[] } };
    };
    expect(global.config.rkey.fallbackServers).toEqual(['https://replay.invalid/rk']);
    writeEvidence('replay-t2-round-b.json', { ...report, baseUrl: BASE_URL });
  });
});
