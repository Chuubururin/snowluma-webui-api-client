// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
/**
 * CI 的单一出处门禁。
 *
 * 动机有三层，都是本轮真实踩过的形状：
 *  1) workflow 抄工具链版本。三条 workflow 各写过 `go install …@v2.8.0`，步骤名却写着
 *     "版本钉 tools.lock.json" —— 派生面与真源分叉时，CI 用的生成器与锁记的不是同一个，
 *     产物横幅/模板都可能跟着换（AGENTS.md「真源在哪」表把 workflow 里的 `go install`
 *     明列为不许手抄）。
 *  2) 两条 OS job 靠人记得同步。verify 与 verify-posix 的步骤序列必须逐条相等，
 *     否则"加一条门禁只进了一个 OS"就是永久失明；两条 job 都存在是因为 required check
 *     的实测名叫 `verify`，改矩阵会让分支保护等一个永远不会来的检查。
 *  3) 引导步排在 `npm ci` 之前。`npm run venv:bootstrap` 调的是 node_modules 里的 tsx，
 *     排错了整条 CI 直接红 —— 这类顺序错误在本地跑不出来（本机早就装好依赖了），
 *     只有钉住"除 npm ci 外没有别的 npm run 在它前面"才看得见。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { oapiPin } from './install-oapi.js';

const WF_DIR = '.github/workflows';
const workflows = Object.fromEntries(
  readdirSync(WF_DIR)
    .filter((f) => f.endsWith('.yml'))
    .map((f) => [f, readFileSync(join(WF_DIR, f), 'utf8')]),
);
const parsed = Object.fromEntries(
  Object.entries(workflows).map(([f, text]) => [f, parse(text) as { jobs: Record<string, { steps?: { run?: string; name?: string }[] }> }]),
);
const scripts = Object.keys(JSON.parse(readFileSync('package.json', 'utf8')).scripts as Record<string, string>);
const lockGenerators = Object.values(
  JSON.parse(readFileSync('tools.lock.json', 'utf8')).generators as Record<string, string>,
);

/** 一个 job 的 `run:` 序列（去掉空白差异），顺序即执行顺序。 */
function runSequence(job: { steps?: { run?: string }[] }): string[] {
  return (job.steps ?? []).filter((s) => s.run).map((s) => s.run!.trim().replace(/\s+/g, ' '));
}

/** 去掉 YAML 注释行：本文件自己的"不许抄版本号"说明里就带着 `pip install pkg==X` 的形状。 */
function codeOnly(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((l) => !l.trim().startsWith('#'))
    .join('\n');
}

describe('CI 的单一出处', () => {
  it('workflow 的执行行里不许出现工具链安装版本号（版本只住 tools.lock.json）', () => {
    for (const [f, text] of Object.entries(workflows)) {
      const code = codeOnly(text);
      for (const pin of lockGenerators) {
        expect(code, `${f} 抄了版本号 ${pin}`).not.toContain(pin);
      }
      expect(code, `${f} 有 go install 抄本`).not.toMatch(/go install .*\@\S*v?\d/);
      expect(code, `${f} 有 pip install 抄本`).not.toMatch(/pip install \S*==/);
    }
  });

  it('装工具链的脚本自己按锁取版本：缺 pin 就报错，不猜、不退回记忆里的版本号', () => {
    expect(oapiPin(JSON.stringify({ generators: { 'oapi-codegen': 'v1.2.3' } }))).toBe('v1.2.3');
    expect(() => oapiPin(JSON.stringify({ generators: {} }))).toThrow(/generators\["oapi-codegen"\]/);
    expect(() => oapiPin('{}')).toThrow();
    // 真锁必须真有这项：否则上面那条拒跑会在 CI 里当场生效，而不是在评审时被发现。
    expect(oapiPin(readFileSync('tools.lock.json', 'utf8'))).toBeTruthy();
  });

  it('workflow 里每条 `npm run <name>` 都是 package.json 的真实脚本', () => {
    const unknown: string[] = [];
    for (const [f, text] of Object.entries(workflows)) {
      for (const m of text.matchAll(/npm run ([a-z][a-z0-9:_-]*)/g)) {
        if (!scripts.includes(m[1])) unknown.push(`${f} → npm run ${m[1]}`);
      }
    }
    expect(unknown, `不存在的脚本：${unknown.join(', ')}`).toEqual([]);
  });

  it('依赖步排在最前：除它自己外，任何 `npm run` 都不许走在 `npm ci` 之前', () => {
    for (const [f, doc] of Object.entries(parsed)) {
      for (const [jobName, job] of Object.entries(doc.jobs ?? {})) {
        const seq = runSequence(job);
        const ci = seq.findIndex((s) => /^npm ci$/.test(s));
        if (ci < 0) continue; // 这个 job 不装依赖（例如纯 API job），无此项可判
        const early = seq.slice(0, ci).filter((s) => s.includes('npm run '));
        expect(early, `${f}#${jobName} 在 npm ci 之前调了仓内脚本（tsx/vitest 还没装）：${early.join(' | ')}`).toEqual([]);
      }
    }
  });

  it('verify 与 verify-posix 的步骤序列逐条相等（两条 job 存在只因 required check 名叫 verify）', () => {
    const doc = parsed['verify.yml'];
    const win = runSequence(doc.jobs.verify);
    const posix = runSequence(doc.jobs['verify-posix']);
    expect(posix.length, '两条 job 步数不同').toBe(win.length);
    for (let i = 0; i < win.length; i += 1) {
      expect(posix[i], `第 ${i + 1} 步分叉`).toBe(win[i]);
    }
    // 相等性本身不许靠"两边都空"成立。
    expect(win.filter((s) => s.includes('npm run ')).length).toBeGreaterThan(4);
  });
});
