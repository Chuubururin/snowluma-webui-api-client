// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
/**
 * 出仓路径耦合守卫。
 *
 * 判据不是"能不能读到文件"（在仓内怎么读都能读到），而是"**换了工作目录还读不读得到**"：
 * 装配层一旦依赖 CWD 相对字面量，工件离开本仓布局即 ENOENT —— 而源码树全绿抓不到它，
 * 因为所有既有测试与门禁都跑在仓根。这正是"内部链严谨、出口不严谨"的那一类失效。
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Windows 上 import() 收裸绝对路径（C:\...）会 ERR_UNSUPPORTED_ESM_URL_SCHEME，实测必须给
// file:// URL —— 这条是探针子进程的性质，不是被测代码的性质。new URL().href 本身就是该形式。
const OPERATIONS_URL = new URL('../adapters/typescript/operations.ts', import.meta.url).href;

describe('适配层不依赖 CWD', () => {
  it('TS：在仓外临时目录里调 loadSpec()（不传参）仍读到契约版本', () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'sl-cwd-'));
    try {
      // `node -e <code> <arg>` 把 arg 放在 argv[1]（实测 argv=["node","one","two"]），不是 argv[2]。
      // 路径必须给绝对值：Windows 上 URL.pathname 会产出 /C:/ 这种 Node 认不得的形状。
      const probe =
        'const m=await import(process.argv[1]);const s=m.loadSpec();' +
        'if(!s.info||!s.info.version)throw new Error("spec 读到了但没有 info.version");' +
        'console.log("OK "+s.info.version);';
      const r = spawnSync(process.execPath, ['--input-type=module', '-e', probe, OPERATIONS_URL], {
        cwd: elsewhere,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      expect(r.status, `子进程退 ${r.status}；stderr: ${r.stderr}`).toBe(0);
      expect(r.stdout).toMatch(/^OK \d+\.\d+\.\d+/m);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it('TS：显式传入的 specPath 仍然优先（改默认解析不许废掉既有入参）', () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'sl-cwd2-'));
    try {
      const probe =
        'const fs=await import("node:fs");const m=await import(process.argv[1]);' +
        'fs.writeFileSync("fake.yaml","info:\\n  version: 7.7.7\\npaths: {}\\n");' +
        'const s=m.loadSpec("fake.yaml");' +
        'if(s.info.version!=="7.7.7")throw new Error("显式入参没生效，实为 "+s.info.version);' +
        'console.log("EXPLICIT_OK");';
      const r = spawnSync(process.execPath, ['--input-type=module', '-e', probe, OPERATIONS_URL], {
        cwd: elsewhere,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      expect(r.status, `子进程退 ${r.status}；stderr: ${r.stderr}`).toBe(0);
      expect(r.stdout).toContain('EXPLICIT_OK');
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});
