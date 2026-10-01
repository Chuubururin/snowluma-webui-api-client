// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
/**
 * 2FA 生命周期的活实例验证（设计口径的最后一块盲区）。
 *
 * 仅 SNOWLUMA_LIVE=1 运行，且目标必须是可牺牲实例：本流程会**真实开启并关闭** 2FA。
 *
 * 为什么需要它：`TotpStatus` 是两支 oneOf union，但 `enabled:true` 那一支
 * （以及 begin/confirm/recovery-codes/disable 四个 T3 写操作的成功形）在任何已有证据里
 * 都没被观测过——dev 模式禁 2FA（上游 auth.ts:335），生产实例上又"不启用别人的认证器"。
 * 可牺牲实例上可以合法地自己算码走完整个生命周期。
 *
 * 纪律：这四个操作属 T3，**不经 collectReplay**（那条路对 t3 硬拒，本文件另有断言钉住）；
 * 这里是显式的、单次的人工式生命周期演练。
 *
 * 码由本地按 RFC 6238 计算（SHA1/6 位/30 秒，与上游 totp.ts:3-5 的常量一致），
 * 每次受保护调用前推进到新的 30 秒窗口——上游记 lastUsedStep，同窗复用会被拒。
 */
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createClient, type Client } from './client.js';

const LIVE = process.env.SNOWLUMA_LIVE === '1';
const BASE_URL = 'http://127.0.0.1:5099';
const PASSWORD = process.env.SNOWLUMA_PASSWORD ?? '';
const PERIOD_MS = 30_000;

function base32Decode(s: string): Buffer {
  const alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ23456789';
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of s.replace(/=+$/, '').toUpperCase()) {
    const idx = alpha.indexOf(ch);
    if (idx === -1) throw new Error(`非法 base32 字符：${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function hotp(secretBase32: string, step: number): string {
  const key = base32Decode(secretBase32);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(step));
  const digest = createHmac('sha1', key).update(buf).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    (digest[offset + 1] << 16) |
    (digest[offset + 2] << 8) |
    digest[offset + 3];
  return String(binary % 1_000_000).padStart(6, '0');
}

/** 推进到一个此前未用过的 30 秒窗口并返回其验证码。 */
async function freshCode(secretBase32: string, lastStep: number): Promise<[string, number]> {
  let step = Math.floor(Date.now() / PERIOD_MS);
  if (step <= lastStep) {
    await new Promise((r) => setTimeout(r, (step + 1) * PERIOD_MS - Date.now() + 50));
    step = Math.floor(Date.now() / PERIOD_MS);
  }
  return [hotp(secretBase32, step), step];
}

describe.skipIf(!LIVE)('2FA 生命周期（可牺牲实例 · SNOWLUMA_LIVE=1）', () => {
  let client: Client;
  let secret = '';
  let lastStep = -1;

  it('前置：需 SNOWLUMA_PASSWORD（改密后的口令）', () => {
    expect(PASSWORD.length).toBeGreaterThan(0);
  });

  it('起点：TotpStatus 落在 enabled:false 支', async () => {
    client = createClient({ baseUrl: BASE_URL });
    await client.bootstrapSession({ password: PASSWORD, acceptAgreements: true });
    expect(await client.request('GET', '/api/auth/totp')).toEqual({ enabled: false });
  });

  it('begin 返回 TotpEnrollment 全键（success/secret/otpauthUrl/issuer/accountName）', async () => {
    const r = (await client.request('POST', '/api/auth/totp/begin', { issuer: 'SnowLumaLive' })) as
      Record<string, unknown>;
    for (const k of ['success', 'secret', 'otpauthUrl', 'issuer', 'accountName']) {
      expect(r, `缺键 ${k}`).toHaveProperty(k);
    }
    expect(r.success).toBe(true);
    expect(typeof r.secret).toBe('string');
    secret = r.secret as string;
    expect(String(r.otpauthUrl).startsWith('otpauth://totp/')).toBe(true);
  });

  it('边界：错验证码 confirm → 401（spec 登记分支）', async () => {
    const err = await client
      .request('POST', '/api/auth/totp/confirm', { password: PASSWORD, code: '000000' })
      .then(() => null)
      .catch((e: unknown) => e as { status?: number; message?: string });
    expect(err).not.toBeNull();
    expect(err!.status).toBe(401);
  });

  it('confirm 正码 → TotpRecoveryCodes（8 条形如 xxxx-xxxx）', async () => {
    const [code, step] = await freshCode(secret, lastStep);
    lastStep = step;
    const r = (await client.request('POST', '/api/auth/totp/confirm', { password: PASSWORD, code })) as
      { success: boolean; recoveryCodes: string[] };
    expect(r.success).toBe(true);
    expect(r.recoveryCodes).toHaveLength(8);
    expect(r.recoveryCodes[0]).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  }, 90_000);

  it('TotpStatus 切到 enabled:true 支（enabled/remainingRecoveryCodes/label）', async () => {
    const r = (await client.request('GET', '/api/auth/totp')) as Record<string, unknown>;
    expect(r.enabled).toBe(true);
    expect(typeof r.remainingRecoveryCodes).toBe('number');
    expect(typeof r.label).toBe('string');
  });

  it('recovery-codes 重生成 → 新 8 条，计数回到 8', async () => {
    const [code, step] = await freshCode(secret, lastStep);
    lastStep = step;
    const r = (await client.request('POST', '/api/auth/totp/recovery-codes', {
      password: PASSWORD,
      totp: code,
    })) as { success: boolean; recoveryCodes: string[] };
    expect(r.success).toBe(true);
    expect(r.recoveryCodes).toHaveLength(8);
    expect((await client.request('GET', '/api/auth/totp') as { remainingRecoveryCodes: number })
      .remainingRecoveryCodes).toBe(8);
  }, 90_000);

  it('disable → SuccessOnly，状态回到 enabled:false（实例不留 2FA）', async () => {
    const [code, step] = await freshCode(secret, lastStep);
    lastStep = step;
    const r = (await client.request('POST', '/api/auth/totp/disable', {
      password: PASSWORD,
      totp: code,
    })) as { success: boolean };
    expect(r).toEqual({ success: true });
    expect(await client.request('GET', '/api/auth/totp')).toEqual({ enabled: false });
  }, 90_000);

  it('T3 边界复钉：这四条不会经 collectReplay 自动执行', async () => {
    const { collectReplay, TierRefusedError } = await import('../../tools/replay.js');
    await expect(collectReplay({ client, tier: 't3' })).rejects.toBeInstanceOf(TierRefusedError);
  });
});
