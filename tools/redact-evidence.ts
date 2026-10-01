// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
/**
 * 证据出盘前的凭据脱敏（设计口径安全约束的执行面）。
 *
 * 三件设计上的事：
 * 1. **只替值，保留键与形状**。`{"token":"[REDACTED]"}` 仍然证明"这条操作返回过一个 token 字段"，
 *    而这正是证据要说的话。把整行删掉或把键一起抹掉，证据就变成一段无从核对的文字。
 * 2. **幂等**：`[REDACTED]` 本身不再被任何形状命中。没有幂等就没有"跑一遍工具"的终态，
 *    第二次跑要么再改一遍（无从 diff），要么报告"又发现一处"（无从判断是否已处理）。
 * 3. **报告里只有形状名，永不含秘密值**。`findSecrets` 返回 `['token']` 而不是那串 hex ——
 *    否则这条安全工具自己就成了把凭据抄进终端日志的那一步。
 *
 * 为什么要覆盖到 accessToken 与 TOTP secret 而不止 session token：那次实扫
 * （当时证据还在独立目录）发现四份生产实例证据里同时躺着
 * session token（会随 TTL 自旧）、OneBot `accessToken`（长期有效，三份文件里是同一对值）、
 * 以及 `beginTotpEnrollment` 回的 base32 `secret` 与嵌着它的 `otpauthUrl`。
 * 三种寿命差一个数量级的凭据只脱第一种，剩下的那份"已脱敏"就是句假话。
 *
 * 注意：本工具改的是**工作树**。已经提交过的值仍在 git history 里（以及任何克隆与备份），
 * 那部分不是改文件能收回的，只能轮换。见 evidence/README.md 的处置记录。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';

interface Shape {
  name: string;
  re: RegExp;
  to: string;
}

/** 键值型形状：键名整键匹配（`"passwordHint"` 不算 `password`），且值不得已经是掩码。 */
const SHAPES: Shape[] = [
  // JSON 双引号键值
  { name: 'token', re: /"token"(\s*:\s*)"(?!\[REDACTED]")([^"]{8,})"/g, to: '"token"$1"[REDACTED]"' },
  { name: 'accessToken', re: /"accessToken"(\s*:\s*)"(?!\[REDACTED]")([^"]{6,})"/g, to: '"accessToken"$1"[REDACTED]"' },
  { name: 'secret', re: /"secret"(\s*:\s*)"(?!\[REDACTED]")([^"]{8,})"/g, to: '"secret"$1"[REDACTED]"' },
  { name: 'otpauthUrl', re: /"otpauthUrl"(\s*:\s*)"(?!\[REDACTED]")([^"]+)"/g, to: '"otpauthUrl"$1"[REDACTED]"' },
  { name: 'password', re: /"password"(\s*:\s*)"(?!\[REDACTED]")([^"]+)"/g, to: '"password"$1"[REDACTED]"' },
  { name: 'oldPassword', re: /"oldPassword"(\s*:\s*)"(?!\[REDACTED]")([^"]+)"/g, to: '"oldPassword"$1"[REDACTED]"' },
  { name: 'newPassword', re: /"newPassword"(\s*:\s*)"(?!\[REDACTED]")([^"]+)"/g, to: '"newPassword"$1"[REDACTED]"' },
  { name: 'recoveryCode', re: /"recoveryCode"(\s*:\s*)"(?!\[REDACTED]")([^"]+)"/g, to: '"recoveryCode"$1"[REDACTED]"' },
  // JSON 数组值（recoveryCodes: ["code1", "code2"]）。guard 锚在"首元素整体"上：
  // 产物 ["[REDACTED]"] 的首元素以 " 开头，guard 若只看 [ 后一个字符会打不中 ⇒ --check 永远红。
  { name: 'recoveryCodes-array', re: /"recoveryCodes"(\s*:\s*)\[(?!\s*"\[REDACTED\]"\s*\])([^\]]{8,})\]/g, to: '"recoveryCodes"$1["[REDACTED]"]' },
  // 转义字符串里的 token（{\"token\":\"…\"}）。guard 是 \[REDACTED\] 后跟转义引号前的 \——
  // 产物 \"[REDACTED]\" 里 [REDACTED] 后面是 ]，曾写成 \[REDACTED\\] 打不中自己的产物 ⇒ --check 永久红。
  { name: 'escaped-token', re: /\\"token\\"(\s*:\s*)\\"(?!\[REDACTED\]\\)([^"]{8,})\\"/g, to: '\\"token\\"$1\\"[REDACTED]\\"' },
  // Query string token（?token=xxx）
  { name: 'query-token', re: /([?&]token=)(?!\[REDACTED])([^&\s"]{8,})/g, to: '$1[REDACTED]' },
  // YAML/Markdown 无引号值（token: xxx）。值整行消费：\S+ 会在第一个空白停住，
  // "token: \"my secret value\"" 会残留后半段明文。guard 在冒号组之后且自带 \s* 前缀——
  // 否则冒号两侧的 \s* 各提供一条回溯缝（'token:'/'token: ' 切分、' '/'  ' 切分）让 guard 换位失明。
  // 行尾的 \r 捕获回吐：CRLF 文件替换后不混行尾。
  { name: 'yaml-token', re: /^(\s*)token(\s*:\s*)(?!\s*\[REDACTED\]\s*\r?$)([^\r\n]*?)(\r?)$/gm, to: '$1token$2[REDACTED]$4' },
  { name: 'yaml-secret', re: /^(\s*)secret(\s*:\s*)(?!\s*\[REDACTED\]\s*\r?$)([^\r\n]*?)(\r?)$/gm, to: '$1secret$2[REDACTED]$4' },
  // 单引号 JS 对象（'token': 'xxx'）。guard 的转义字符是 ] 不是 '（曾写错致 --check 永久红）。
  { name: 'sq-token', re: /'token'(\s*:\s*)'(?!\[REDACTED\])([^']{8,})'/g, to: "'token'$1'[REDACTED]'" },
  // 传输层：前缀留在原地，读证据的人仍认得出这是哪一栏。
  { name: 'bearer', re: /Bearer\s+(?!\[REDACTED])([A-Za-z0-9._-]{16,})/gi, to: 'Bearer [REDACTED]' },
  { name: 'sessionCookie', re: /snowluma_session=(?!\[REDACTED])([^;"\s]+)/g, to: 'snowluma_session=[REDACTED]' },
  // snake_case 变体
  { name: 'session_token', re: /"session_token"(\s*:\s*)"(?!\[REDACTED]")([^"]{8,})"/g, to: '"session_token"$1"[REDACTED]"' },
  { name: 'access_token', re: /"access_token"(\s*:\s*)"(?!\[REDACTED]")([^"]{8,})"/g, to: '"access_token"$1"[REDACTED]"' },
];

/** 命中的形状名（去重、按 SHAPES 顺序）。返回值本身不含任何秘密字节。 */
export function findSecrets(text: string): string[] {
  const out: string[] = [];
  for (const s of SHAPES) {
    s.re.lastIndex = 0;
    if (s.re.test(text)) out.push(s.name);
  }
  return out;
}

export function redactSecrets(text: string): string {
  let next = text;
  for (const s of SHAPES) next = next.replace(s.re, s.to);
  return next;
}

/**
 * 落盘前的唯一出口：序列化 + 脱敏。
 * `verify-all-report.json` 那一份就是 `verify-all.ts` 把整轮 sweep 的响应体原样 `JSON.stringify`
 * 出来的产物 —— 只洗存量工件而不在写盘那一行设卡，下一次跑活体 sweep 就把同一批凭据再抄一遍。
 */
export function redactJson(value: unknown): string {
  return `${redactSecrets(JSON.stringify(value, null, 2))}\n`;
}

/**
 * 跟踪面里该扫的文件。'all' = 跟踪面 ∪ 未跟踪面。
 * 扫描面 = 机器跑次工件的落盘目录（verify:all 的报告）。手册页不在其内：
 * 契约文档必须原样展示 `{"password": "…"}` 这类形状，把它们扫进形状表只会教人
 * 给文档加豁免——而豁免名单正是这条防线最想要防的东西。
 */
export function evidenceFiles(scope: 'tracked' | 'all' = 'tracked', dir = 'docs/operations'): string[] {
  const tracked = execFileSync('git', ['ls-files', dir], { encoding: 'utf8' })
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (scope === 'tracked') return tracked.filter((f) => !f.endsWith('README.md'));
  // 未跟踪面必须单独问 git：`git status --porcelain` 不列"已跟踪且未改动"的文件，
  // 只按它拼 'all' 会漏掉全部入库证据 —— 那正是"扫描器报告干净而其实什么都没扫"那一类缺陷。
  const untracked = execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '--', dir], { encoding: 'utf8' })
    .split(/\r?\n/)
    .filter((l) => l.startsWith('?? '))
    .map((l) => l.slice(3).trim())
    .filter(Boolean);
  return [...new Set([...tracked, ...untracked])].filter((f) => !f.endsWith('README.md'));
}

// 用 basename 而不是路径子串：Windows 上 argv[1] 是反斜杠绝对路径，
// `includes('tools/redact-evidence')` 在那儿永远不成立（CLI 会静默不跑，比报错更糟）。
if (basename(process.argv[1] ?? '') === 'redact-evidence.ts') {
  const check = process.argv.includes('--check');
  const scope: 'tracked' | 'all' = process.argv.includes('--all') ? 'all' : 'tracked';
  let dirty = 0;
  let scanned = 0;
  for (const f of evidenceFiles(scope)) {
    scanned += 1;
    const before = readFileSync(f, 'utf8');
    const hits = findSecrets(before);
    if (!hits.length) continue;
    dirty += 1;
    console.log(`${check ? '待脱敏' : '已脱敏'} ${f} → ${hits.join(', ')}`);
    if (!check) writeFileSync(f, redactSecrets(before), 'utf8');
  }
  // 空面不绿：扫到 0 个文件说明路径或 git 接线断了，那不是"通过"。
  if (scanned === 0) {
    console.error('扫到 0 份证据文件 ⇒ 目录或 git 接线有问题，拒绝报"干净"');
    process.exit(1);
  }
  console.log(dirty ? `共 ${dirty} 份文件含活凭据${check ? '（--check：未写盘）' : '，已按值替掉'}` : `扫过 ${scanned} 份，证据面干净`);
  process.exit(check && dirty ? 1 : 0);
}
