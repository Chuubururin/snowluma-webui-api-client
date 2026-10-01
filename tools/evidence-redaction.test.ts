// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
/**
 * 入库证据的凭据脱敏（实现批次）。
 *
 * 为什么这条门禁扫的是 **git 跟踪面**而不是整个目录：会泄的从来不是"磁盘上有这个文件"，
 * 而是"这个值进了版本库、进了备份、进了别人 clone 的那一份"。以跟踪与否划线，
 * 门禁在"提交前"这一步就有牙齿（文件一加进 index 就红），又不必伸手改并行会话的在途文件。
 * 未跟踪但带活凭据的文件不因此免责：它们必须逐条登记在下面的 pending 名单里，
 * 名单里出现一个"已经不犯了"的条目同样红 —— 这是一张债目，不是一张通行证。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { evidenceFiles, findSecrets, redactJson, redactSecrets } from './redact-evidence.js';

/**
 * 未跟踪证据里的活凭据债目。每一条都要写清归属与出路；
 * 该文件被它的主人脱敏后，本条必须同时删掉（否则这条测试红）。
 *
 * 原两条债（replay 证据里的 OneBot accessToken 与 session token）已就地脱敏清偿，
 * `--check --all` 全净。生产侧 accessToken 的轮换处置记录见 `docs/operations/security.md`
 * ——本仓历史已重建为单初始提交，曾进过历史的残留值随轮换成死值，且旧提交对象已不存在。
 * 现行扫描面是 `docs/operations/`（跑次报告的落盘目录）；机器工件只剩 verify-all 报告一份。
 */
const PENDING_UNTRACKED_SECRETS: Array<{ file: string; why: string; owner: string }> = [];

function trackedEvidence(): string[] {
  return evidenceFiles('tracked');
}

/**
 * 未跟踪面 = all ∖ tracked。这里刻意复用被测函数而不是自己再拼一遍 git 命令：
 * 两处各写一份"怎么问 git"，就会有两份对同一件事的认知，而 `evidenceFiles('all')`
 * 恰好有过一次写成"只问 git status"的缺陷（status 不列已跟踪未改动的文件 ⇒ 全部入库证据漏扫）。
 */
function untrackedEvidence(): string[] {
  const tracked = new Set(trackedEvidence());
  return evidenceFiles('all').filter((f) => !tracked.has(f));
}

describe('redactSecrets 的每个形状', () => {
  it('session token：值替掉，键与 JSON 形状原样留着', () => {
    const out = redactSecrets('{"success":true,"token":"fake-session-token-0123456789ab"}');
    expect(out).toBe('{"success":true,"token":"[REDACTED]"}');
  });

  it('OneBot accessToken 与 TOTP secret 各替各的（它们是两种寿命不同的凭据）', () => {
    expect(redactSecrets('{"accessToken":"fakeOneBotAccessTokenAA"}')).toBe('{"accessToken":"[REDACTED]"}');
    expect(redactSecrets('{"secret":"FAKEBASE32SECRETAAAA"}')).toBe('{"secret":"[REDACTED]"}');
  });

  it('otpauthUrl 整值替掉：那串 URI 里就嵌着 secret，留 URI 骨架等于没脱敏', () => {
    const out = redactSecrets('{"otpauthUrl":"otpauth://totp/FakeIssuer:fakeuser?secret=FAKEBASE32SECRETAAAA&issuer=FakeIssuer"}');
    expect(out).toBe('{"otpauthUrl":"[REDACTED]"}');
  });

  it('口令族与恢复码：四个键名各自命中，短值也照替（口令没有"短到不像凭据"这回事）', () => {
    for (const k of ['password', 'oldPassword', 'newPassword', 'recoveryCode']) {
      expect(redactSecrets(`{"${k}":"hunter2"}`), k).toBe(`{"${k}":"[REDACTED]"}`);
    }
  });

  it('传输层两处：Bearer 头与会话 cookie 的值替掉，前缀留着（读证据的人还要能认出这是哪一栏）', () => {
    expect(redactSecrets('authorization: Bearer faketokentokenFAKE0123456789ab')).toBe('authorization: Bearer [REDACTED]');
    expect(redactSecrets('set-cookie: snowluma_session=abc123DEF456; Path=/')).toBe('set-cookie: snowluma_session=[REDACTED]; Path=/');
  });

  it('幂等：脱敏过的文本再过一次，一个都不再命中（否则"跑一遍工具"这件事没有终态）', () => {
    const once = redactSecrets('{"token":"fake-session-token-0123456789ab","accessToken":"fakeOneBotAccessTokenAA"}');
    expect(findSecrets(once)).toEqual([]);
    expect(redactSecrets(once)).toBe(once);
  });

  // 第五轮白盒：三条新形状各自的幂等与整值消费——任一条坏掉，--check 对含该形状的
  // 证据文件永久红（guard 打不中自己的产物），或引号/多词值残留明文（\S+ 停在第一个空白）。
  it('recoveryCodes 数组：整批替掉，产物不再被 findSecrets 命中（幂等）', () => {
    const input = '{"success":true,"recoveryCodes":["RC4U-2KX9-QPLM-77AA","RC4U-2KX9-QPLM-77BB"]}';
    const out = redactSecrets(input);
    expect(out).toBe('{"success":true,"recoveryCodes":["[REDACTED]"]}');
    expect(findSecrets(out), '脱敏产物不得再命中（--check 的终态）').toEqual([]);
  });

  it('YAML/Markdown 值整行消费：引号值与多词值一个字节不剩', () => {
    expect(redactSecrets('token: "my secret value"')).toBe('token: [REDACTED]');
    expect(redactSecrets('token: abc def ghi')).toBe('token: [REDACTED]');
    expect(redactSecrets('  secret: FAKEBASE32SECRETAAAA')).toBe('  secret: [REDACTED]');
    const once = redactSecrets('token: abc def ghi\nsecret: xyzzy plugh\n');
    expect(findSecrets(once)).toEqual([]);
    expect(redactSecrets(once)).toBe(once);
  });

  it('单引号对象：脱敏产物不被再次命中（guard 字符曾写错致 --check 永久红）', () => {
    const out = redactSecrets("{'token': 'fake-token-value-0123456789ab'}");
    expect(out).toBe("{'token': '[REDACTED]'}");
    expect(findSecrets(out)).toEqual([]);
  });

  it('不误伤形状：schema 里的 {"token": {"type":"integer"}}、短语义值、非凭据键都得原样通过', () => {
    const benign = [
      '{"token":{"type":"integer"}}', // verify-all-report 的 schema 块就是这个形状
      '{"tokens":["a","b"]}',
      '{"token":"short"}', // 8 位以下：不是 64 位 hex 会话口的那种东西
      '{"totalTokens":12}',
      '{"passwordHint":"首字母"}', // 键名是前缀匹配就会替掉它 ⇒ 必须整键匹配
      '{"description":"the token field"}',
    ];
    for (const s of benign) expect(findSecrets(s), s).toEqual([]);
  });

  it('findSecrets 报的是形状名而不是秘密本身（错误信息与测试输出也不许夹带凭据）', () => {
    const hits = findSecrets('{"token":"fake-session-token-0123456789ab"}');
    expect(hits).toEqual(['token']);
    expect(JSON.stringify(hits)).not.toContain('fake-session-token');
  });

  it('redactJson 是落盘那一个出口：报告对象里躺着活凭据，出来的文本已洗过且仍是合法 JSON', () => {
    // 这条钉的是 verify-all.ts 的写盘行。它原先是裸 JSON.stringify(report)，
    // 而 report.sweeps[*] 就是整轮 sweep 的响应体 ⇒ 只洗存量工件不改这一行，下次跑活体 sweep 会再泄一遍。
    const report = { generatedAt: 'x', sweeps: [{ login: { data: { token: 'faketokentokenFAKE0123456789ab52b850' } } }] };
    const text = redactJson(report);
    expect(findSecrets(text)).toEqual([]);
    expect(JSON.parse(text).sweeps[0].login.data.token).toBe('[REDACTED]');
  });

  it('recoveryCodes 数组：spec required，2FA 重放会产生，整组替掉', () => {
    const out = redactSecrets('{"recoveryCodes":["code1","code2","code3"]}');
    expect(out).toBe('{"recoveryCodes":["[REDACTED]"]}');
    expect(findSecrets('{"recoveryCodes":["code1","code2","code3"]}')).toContain('recoveryCodes-array');
  });

  it('转义字符串里的 token（嵌套 JSON 日志）', () => {
    const input = '{\\"token\\":\\"fake-session-token-0123456789ab\\"}';
    const out = redactSecrets(input);
    expect(out).toContain('[REDACTED]');
    expect(findSecrets(input)).toContain('escaped-token');
    // guard 曾打不中自己的产物（[REDACTED] 后是 ] 不是 \）⇒ --check 对已脱敏文件永久红
    expect(findSecrets(out), '脱敏产物不得再命中').toEqual([]);
    expect(redactSecrets(out)).toBe(out);
  });

  it('Query string token（URL 里的 ?token=xxx）', () => {
    const out = redactSecrets('https://example.com/api?token=fake-session-token-0123456789ab&other=1');
    expect(out).toBe('https://example.com/api?token=[REDACTED]&other=1');
    expect(findSecrets('?token=fake-session-token-0123456789ab')).toContain('query-token');
  });

  it('YAML/Markdown 无引号值（token: xxx 行首）', () => {
    const out = redactSecrets('token: fake-session-token-0123456789ab\nother: value');
    expect(out).toBe('token: [REDACTED]\nother: value');
    expect(findSecrets('token: fake-session-token-0123456789ab')).toContain('yaml-token');
    expect(findSecrets('secret: FAKEBASE32SECRETAAAA')).toContain('yaml-secret');
  });

  it('单引号 JS 对象（代码片段里的 token）', () => {
    const out = redactSecrets("{ 'token': 'fake-session-token-0123456789ab' }");
    expect(out).toBe("{ 'token': '[REDACTED]' }");
    expect(findSecrets("{ 'token': 'fake-session-token-0123456789ab' }")).toContain('sq-token');
  });

  it('大小写不敏感 Bearer（bearer / BEARER 都命中）', () => {
    expect(redactSecrets('authorization: bearer faketokentokenFAKE0123456789ab')).toBe('authorization: Bearer [REDACTED]');
    expect(redactSecrets('authorization: BEARER faketokentokenFAKE0123456789ab')).toBe('authorization: Bearer [REDACTED]');
  });

  it('snake_case 变体（session_token / access_token）', () => {
    expect(redactSecrets('{"session_token":"fake-session-token-0123456789ab"}')).toBe('{"session_token":"[REDACTED]"}');
    expect(redactSecrets('{"access_token":"fake-session-token-0123456789ab"}')).toBe('{"access_token":"[REDACTED]"}');
  });
});

describe('入库证据面', () => {
  it('git 跟踪的每份证据里不得有活凭据', () => {
    const offenders: string[] = [];
    for (const f of trackedEvidence()) {
      const hits = findSecrets(readFileSync(f, 'utf8'));
      if (hits.length) offenders.push(`${f}: ${hits.join('/')}`);
    }
    expect(offenders).toEqual([]);
  });

  it('跟踪面确有证据可扫（扫到 0 份就是空检查，不许静默放行）', () => {
    expect(trackedEvidence().length).toBeGreaterThan(0);
  });

  it('未跟踪的活凭据必须逐条登记在债目里，且债目里不许留已经不犯了的条目', () => {
    const dirty = untrackedEvidence()
      .filter((f) => findSecrets(readFileSync(f, 'utf8')).length > 0)
      .sort();
    const listed = PENDING_UNTRACKED_SECRETS.map((p) => p.file.replace(/\\/g, '/')).sort();
    expect(dirty).toEqual(listed);
    // 每条债必须有 why 与 owner，登记成一句"回头再说"就等于没登记。
    for (const p of PENDING_UNTRACKED_SECRETS) {
      expect(p.why, p.file).toBeTruthy();
      expect(p.owner, p.file).toBeTruthy();
    }
  });
});
