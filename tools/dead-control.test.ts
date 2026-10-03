// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
/**
 * 「声明了但不生效」的门禁。
 *
 * 为什么单独一条：本仓的失效模式里最贵的一类不是"缺控制"，而是**控制写在纸上、结构上不可能触发**。
 * 行业评审计量面时，这类项比缺失项更危险 —— 缺失会被看见， inert 会被信任。实测三处（都靠
 * gh api 与 git ls-files 取证，不是读出来像）：
 *  1) workflow 全文没有 `permissions:`，而仓库默认是 `read` —— 那个开 PR 的步骤推不出分支，
 *     且因为触发条件一直没命中过，它从未红过，于是被当成"在役"。
 *  2) dependabot 声明了 pip 生态，但仓内没有任何 pip 清单文件 —— 这项永远产不出 PR，还会持续失败。
 *  3) `${{ }}` 直接插进 `run:` —— 脚本注入面，且与本仓自己在 release-clients.yml 里写下的口径相反。
 *
 * 判据一律落在**文件字节**上，且发现面来自文件系统（枚举 workflow、枚举 dependabot 条目），
 * 不来自某份手写的白名单 —— 否则就是拿被检对象当尺子。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const WF_DIR = '.github/workflows';
const workflowFiles = readdirSync(WF_DIR).filter((f) => f.endsWith('.yml'));

type Job = {
  permissions?: Record<string, string> | string;
  steps?: { uses?: string; run?: string; with?: Record<string, unknown> }[];
};
type WfDoc = {
  permissions?: Record<string, string> | string;
  jobs?: Record<string, Job>;
};

/** dependabot 各生态的可解析清单文件名（缺一个都不算"读得到"）。 */
const ECOSYSTEM_MANIFESTS: Record<string, string[]> = {
  npm: ['package.json'],
  pip: ['requirements.txt', 'pyproject.toml', 'setup.py', 'Pipfile', 'poetry.lock', 'Pipfile.lock'],
  gomod: ['go.mod'],
  cargo: ['Cargo.toml'],
  composer: ['composer.json'],
  mix: ['mix.exs'],
  gradle: ['build.gradle', 'build.gradle.kts'],
  maven: ['pom.xml'],
  docker: ['Dockerfile'],
  'github-actions': [], // 清单就是 .github/workflows/*.yml 自己，另由枚举面判
};

/**
 * 会造成远端写入的动作 → 需要的权限范围。
 * 分两面匹配：`uses:` 的镜像名在 YAML 解析后**只剩值**（`peter-evans/create-pull-request@v7`，
 * 前面不再有 "uses:" 这几个字），所以动作名与脚本内命令必须分开判 —— 混成一条正则会让
 * 权限检查对着解析值永远匹配不上，于是"门禁存在但咬不动"（第一版就是这么假绿的）。
 * 只收"写出去就收不回"的动作；`npm ci`、`vitest` 这类不在面内。
 */
const WRITE_SCOPES: { uses?: RegExp; run?: RegExp; needs: Record<string, string> }[] = [
  { uses: /peter-evans\/create-pull-request@/, needs: { contents: 'write', 'pull-requests': 'write' } },
  { run: /gh\s+release\s+create\b/, needs: { contents: 'write' } },
  { run: /gh\s+pr\s+create\b/, needs: { 'pull-requests': 'write' } },
  { run: /gh\s+issue\s+create\b/, needs: { issues: 'write' } },
  { run: /(?:^|[;&|]\s*)git\s+push\b/, needs: { contents: 'write' } },
  { uses: /actions\/deploy-pages@/, needs: { pages: 'write' } },
];

/**
 * 需要**读**权限才能拿到数据的调用 → 缺 scope 时平台给的不是空集而是 403。
 * 这条表存在的理由是一次真实故障：`dependabot/alerts` 在只有 `contents: read` 的 job 里
 * 返回 HTTP 403，而按本仓口径"取不到数据"判设施红 —— 门禁咬对了，但如果没有这条表，
 * 下一个人看到的红是"扫描腿挂了"，最省事的处置就是把那步软成打印一行字。
 */
const READ_SCOPES: { run: RegExp; needs: Record<string, string> }[] = [
  { run: /gh\s+api\b[^\n]*dependabot\/alerts/, needs: { 'security-events': 'read' } },
];

function permissionsMap(p: Job['permissions']): Record<string, string> {
  if (!p) return {};
  if (typeof p === 'string') return { all: p };
  return p;
}

/** job 级覆盖 workflow 级；未声明的键一律视为未授予。 */
function effectiveScopes(wf: WfDoc, job: Job): Record<string, string> {
  return { ...permissionsMap(wf.permissions), ...permissionsMap(job.permissions) };
}

function scopeSatisfied(scopes: Record<string, string>, key: string, want: string): boolean {
  const granted = scopes[key] ?? scopes.all;
  if (!granted) return false;
  if (granted === 'write' || granted === 'admin') return true;
  return want === 'read' && granted === 'read';
}

describe('声明即生效（inert 控制一律红）', () => {
  it('每个 job 的写动作都要有够得着的 permissions（缺块就是没授权：仓库默认是 read）', () => {
    const offenders: string[] = [];
    for (const f of workflowFiles) {
      const doc = parse(readFileSync(join(WF_DIR, f), 'utf8')) as WfDoc;
      for (const [jobName, job] of Object.entries(doc.jobs ?? {})) {
        const scopes = effectiveScopes(doc, job);
        // 没写任何 permissions 块时，GitHub 用的是仓库默认（实测 read）。本仓口径：要做写的 job
        // 必须自己声明，不许依赖默认值 —— 默认值会变，而"能不能推分支"不该由仓库设置页决定。
        const hasAnyBlock = Boolean(doc.permissions || job.permissions);
        for (const step of job.steps ?? []) {
          for (const rule of WRITE_SCOPES) {
            const hit =
              (rule.uses !== undefined && step.uses !== undefined && rule.uses.test(step.uses)) ||
              (rule.run !== undefined && step.run !== undefined && rule.run.test(step.run));
            if (!hit) continue;
            for (const [key, want] of Object.entries(rule.needs)) {
              if (!hasAnyBlock || !scopeSatisfied(scopes, key, want)) {
                offenders.push(`${f}#${jobName} 要写 ${key}（${String(rule.uses ?? rule.run)}）但权限不足/未声明`);
              }
            }
          }
        }
      }
    }
    expect(offenders, `结构性不可能完成的写动作：\n${[...new Set(offenders)].join('\n')}`).toEqual([]);
  });

  it('要读平台数据才算数的步骤，必须自己声明读权限（403 不是"零条告警"）', () => {
    const offenders: string[] = [];
    let matched = 0;
    for (const f of workflowFiles) {
      const doc = parse(readFileSync(join(WF_DIR, f), 'utf8')) as WfDoc;
      for (const [jobName, job] of Object.entries(doc.jobs ?? {})) {
        const scopes = effectiveScopes(doc, job);
        for (const step of job.steps ?? []) {
          if (!step.run) continue;
          for (const rule of READ_SCOPES) {
            if (!rule.run.test(step.run)) continue;
            matched++;
            for (const [key, want] of Object.entries(rule.needs)) {
              if (!scopeSatisfied(scopes, key, want)) {
                offenders.push(`${f}#${jobName} 要读 ${key}（${rule.run.source}）但未授予 → 该步必然 403`);
              }
            }
          }
        }
      }
    }
    // 空集不算通过：删掉扫描步或改掉端点，这条断言就静默空转。
    expect(matched, '没有任何步骤命中 READ_SCOPES，这条门禁在空转').toBeGreaterThan(0);
    expect(offenders, `声明了要扫但读不到数据的腿：\n${[...new Set(offenders)].join('\n')}`).toEqual([]);
  });

  it('dependabot 声明的每个生态都要在该 directory 有可解析清单（跟踪在 git 里才算）', () => {
    const tracked = new Set(
      execFileSync('git', ['ls-files'], { encoding: 'utf8' })
        .split(/\r?\n/)
        .filter(Boolean)
        // git 输出的是正斜杠路径，directory 也是正斜杠；这里不用 path.join，免得在 Windows 上比出反斜杠
        .map((p) => p.replace(/\\/g, '/')),
    );
    const cfg = parse(readFileSync('.github/dependabot.yml', 'utf8')) as {
      updates?: { 'package-ecosystem': string; directory: string }[];
    };
    const entries = cfg.updates ?? [];
    expect(entries.length, 'dependabot 一条声明都没有，等于这条门禁空转').toBeGreaterThan(0);

    const inert: string[] = [];
    for (const u of entries) {
      const dir = (u.directory ?? '/').replace(/^\/+|\/+$/g, '');
      if (u['package-ecosystem'] === 'github-actions') {
        const wfTracked = [...tracked].some((p) => p.startsWith('.github/workflows/') && p.endsWith('.yml'));
        if (!wfTracked) inert.push('github-actions：没有跟踪的 workflow 可解析');
        continue;
      }
      const candidates = ECOSYSTEM_MANIFESTS[u['package-ecosystem']];
      if (!candidates) {
        inert.push(`${u['package-ecosystem']}：本门禁不认识该生态，先当作未验证`);
        continue;
      }
      const hit = candidates.some((m) => tracked.has(dir ? `${dir}/${m}` : m));
      if (!hit) inert.push(`${u['package-ecosystem']} in /${dir}：跟踪文件里没有 ${candidates.join('/')}`);
    }
    expect(inert, `永远不会生效（也永远产不出更新）的 dependabot 声明：${inert.join(' | ')}`).toEqual([]);
  });

  it('`${{ }}` 不许插进 run:（插值进脚本=注入面；一律走 env: 或 with:）', () => {
    const offenders: string[] = [];
    for (const f of workflowFiles) {
      const doc = parse(readFileSync(join(WF_DIR, f), 'utf8')) as WfDoc;
      for (const [jobName, job] of Object.entries(doc.jobs ?? {})) {
        for (const step of job.steps ?? []) {
          if (step.run && /\$\{\{/.test(step.run)) {
            const line = step.run.split(/\r?\n/).find((l) => l.includes('${{')) ?? '';
            offenders.push(`${f}#${jobName}: ${line.trim().slice(0, 72)}`);
          }
        }
      }
    }
    expect(offenders, `注入面（表达式直接进脚本）：\n${offenders.join('\n')}`).toEqual([]);
  });

  it('门禁自己不许空转：workflow 确实被枚举到了（发现面非空）', () => {
    // 前两条断言都靠"遍历所有 workflow"成立。如果目录名写错或过滤条件失效，
    // 遍历空集就会全绿 —— 那是最坏的假绿：门禁存在但一口咬不到东西。
    expect(workflowFiles.length).toBeGreaterThanOrEqual(4);
    expect(Object.keys(ECOSYSTEM_MANIFESTS).length).toBeGreaterThan(4);
    expect(WRITE_SCOPES.length).toBeGreaterThan(3);
    expect(existsSync('.github/dependabot.yml')).toBe(true);
  });
});
