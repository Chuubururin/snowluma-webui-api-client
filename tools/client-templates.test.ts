// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
/**
 * 三语 README 与示例的同源断言。
 *
 * 为什么值得单独钉：README 承诺的入口与示例实际 import 的入口，是两处手写的同一件事。
 * 它们分叉时的表现不是"文档不好看"，而是消费者照文档 import 拿到 undefined，
 * 而源码树所有门禁都从仓内相对路径走，看不见这条。
 *
 * 第三条断言（示例的 OK 标记）是本页与 tools/smoke-clients.ts 之间的契约：
 * 出口闸靠这些标记判"用得动"，标记改了名而不改这里，smoke 会静默失配。
 */
import { describe, expect, it } from 'vitest';
import { PY_PACKAGE, TS_PACKAGE_NAME } from './lib/client-artifact.js';
import { OK_TOKEN, renderExample, renderReadme, requiredReadmeSections } from './lib/client-templates.js';

const V = '9.9.9';
const ANCHOR = 'a'.repeat(40);
const LANGS = ['typescript', 'python', 'go'] as const;

function readme(lang: (typeof LANGS)[number]) {
  return renderReadme(lang, { version: V, anchor: ANCHOR });
}

/**
 * README 的散文面（剥掉围栏代码块）。
 * README 会把示例代码整段内嵌进去，所以"全文包含"这类断言会被内嵌代码替它打工：
 * 包名、OK 标记都必须在散文里自己出现，才算文档真的写了它们。
 */
function readmeProse(lang: (typeof LANGS)[number]) {
  return readme(lang).replace(/```[\s\S]*?```/g, '');
}

describe('README 与示例同源', () => {
  it('TS：README 散文写明两处显式另名，消费者不会撞见看不见的别名', () => {
    const prose = readmeProse('typescript');
    expect(prose).toContain('createSdkClient');
    expect(prose).toContain('SdkLoginError');
  });

  it('TS：README 里承诺的 import 与示例同为包名，且示例取的两层符号都在出口上', () => {
    const ex = renderExample('typescript');
    expect(readmeProse('typescript'), 'README 散文没写明包名').toContain(TS_PACKAGE_NAME);
    expect(ex).toContain(`from '${TS_PACKAGE_NAME}'`);
    expect(ex).toMatch(/createClient/);   // 行为适配层
    expect(ex).toMatch(/getSystem/);      // 生成的类型化调用面
  });

  it('Python：示例的 import 与 README 散文同为 PY_PACKAGE（装包后的可导入名）', () => {
    expect(renderExample('python')).toContain(`from ${PY_PACKAGE}`);
    expect(readmeProse('python')).toContain(PY_PACKAGE);
  });

  it('Go：README 明写这不是已发布的 module，且示例 import 落在本 module 前缀内', () => {
    const rm = readme('go').toLowerCase();
    expect(rm).toContain('not a published go module');
    expect(readme('go')).toContain('go work use');
    expect(renderExample('go')).toContain('example.com/sl/generated');
  });

  it('示例各埋一个 OK 标记，且 README 散文也写明它（出口闸按标记判"用得动"）', () => {
    const tokens = LANGS.map((l) => OK_TOKEN[l]);
    expect(new Set(tokens).size).toBe(3);
    for (const lang of LANGS) {
      expect(renderExample(lang), `${lang} 的示例缺 OK 标记`).toContain(OK_TOKEN[lang]);
      // 剥掉内嵌代码块后仍要出现：否则"README 写了验收标准"这条其实没写。
      expect(readmeProse(lang), `${lang} 的 README 散文没写验收标记`).toContain(OK_TOKEN[lang]);
    }
  });

  it('README 四段齐备：这是什么 / 怎么装 / 最小调用示例 / 版本与出处', () => {
    for (const lang of LANGS) {
      const rm = readme(lang);
      for (const section of requiredReadmeSections()) {
        expect(rm, `${lang} 缺「${section}」`).toContain(`## ${section}`);
      }
    }
  });

  it('「怎么装」三条命令各就各位：npm install ./ / pip install ./ / go work use', () => {
    expect(readme('typescript')).toMatch(/npm install \.\//);
    expect(readme('python')).toMatch(/pip install \.\//);
    expect(readme('go')).toMatch(/go work use \.\//);
  });

  it('Python 必须把两层抽象分开：生成腿自带 httpx 传输，适配层不持有网络实现', () => {
    const rm = readme('python');
    expect(rm).toMatch(/httpx/);
    expect(rm).toMatch(/不持有网络实现/);
  });

  it('README 不写日期与流水号，出处只指向 provenance 文件与上游锚点 SHA', () => {
    for (const lang of LANGS) {
      const rm = readme(lang);
      expect(rm).not.toMatch(/20\d\d-\d\d-\d\d/);
      expect(rm).not.toMatch(/PR #\d+|run \d+/);
      expect(rm).toMatch(/provenance\.json/);
      expect(rm).toContain(ANCHOR.slice(0, 7));
    }
  });

  it('示例绝不引用仓内相对路径（带不出仓的那种默认值就是本轮要消灭的缺陷）', () => {
    for (const lang of LANGS) {
      expect(renderExample(lang)).not.toMatch(/\.\.\/\.\.\//);
      expect(renderExample(lang)).not.toMatch(/['"]spec\/openapi\.yaml/);
    }
  });

  it('README 不许把适配器说成生成物，也不许承诺自动重放非幂等写', () => {
    for (const lang of LANGS) {
      const rm = readme(lang);
      expect(rm).toMatch(/行为适配层|适配层/);
      expect(rm).not.toMatch(/401 自动重试[^：]*写请求/);
    }
  });
});
