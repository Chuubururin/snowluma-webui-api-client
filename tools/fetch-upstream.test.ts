// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
/**
 * fetch-upstream 的恢复路径此前只有注释在执法（"12 次""坏锚点拒用""失败要带指引"），
 * 一条用例都没有——恢复路径本身坏了，恰好在最需要它的冷克隆故障现场没人知道。
 * 本文件把这些声明变成可执行断言；I/O 全部注入，不碰网。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  ALL_FAILED_GUIDANCE,
  MAX_ATTEMPTS,
  parseAnchorCommit,
  retryFetch,
  type CachedFile,
} from './fetch-upstream.js';

const SHA = 'a'.repeat(40);
const file = (n: string): CachedFile => ({
  repoPath: `packages/core/src/webui/${n}.ts`,
  localPath: `vendor/upstream/core/src/webui/${n}.ts`,
  sha256: 'b'.repeat(64),
  bytes: 10,
});

describe('parseAnchorCommit（坏锚点不当 ref 用）', () => {
  it('40 位小写十六进制原样通过', () => {
    expect(parseAnchorCommit(SHA)).toBe(SHA);
  });

  for (const bad of ['main', 'abcdef', SHA.toUpperCase(), '', ' HEAD']) {
    it(`拒收 ${JSON.stringify(bad)}，错误信息带可执行补救指引`, () => {
      expect(() => parseAnchorCommit(bad)).toThrow(/git ls-remote/);
    });
  }
});

describe('retryFetch（批级重试的上界与失败语义）', () => {
  it('第 1 次就成：attempt=1，一次都不睡', async () => {
    const sleep = vi.fn();
    const r = await retryFetch({
      commit: SHA,
      fetch: async () => [file('server')],
      sleep,
    });
    expect(r.attempt).toBe(1);
    expect(r.files).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('先坏两次再成：attempt=3，恰好睡两次（间隔重试而非立即循环）', async () => {
    const sleep = vi.fn(async () => {});
    let n = 0;
    const r = await retryFetch({
      commit: SHA,
      fetch: async () => {
        n += 1;
        if (n < 3) throw new Error('ECONNRESET');
        return [file('server'), file('auth')];
      },
      sleep,
    });
    expect(r.attempt).toBe(3);
    expect(r.files).toHaveLength(2);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it('上界是刚性的：fetch 被叫恰好 MAX_ATTEMPTS 次后抛错，绝不无限重试', async () => {
    const fetch = vi.fn(async () => {
      throw new Error('ECONNRESET');
    });
    const sleep = vi.fn(async () => {});
    await expect(retryFetch({ commit: SHA, fetch, sleep })).rejects.toThrow(
      new RegExp(`第 ${MAX_ATTEMPTS} 次`),
    );
    expect(fetch).toHaveBeenCalledTimes(MAX_ATTEMPTS);
    // 最后一次失败之后不再多睡一次
    expect(sleep).toHaveBeenCalledTimes(MAX_ATTEMPTS - 1);
  });

  it('全败的抛错信息带着"不许放宽门禁"的原文（失败出口不许只剩一句 fetch failed）', async () => {
    await expect(
      retryFetch({
        commit: SHA,
        fetch: async () => {
          throw new Error('reset');
        },
        sleep: async () => {},
      }),
    ).rejects.toThrow(/放宽/);
    expect(ALL_FAILED_GUIDANCE).toContain('不得因此放宽');
  });

  it('空批不算成功：fetch 返回 [] 也必须抛（掏空的缓存面不能报"FETCHED 0 个文件"）', async () => {
    await expect(
      retryFetch({ commit: SHA, fetch: async () => [], sleep: async () => {} }),
    ).rejects.toThrow(new RegExp(`第 ${MAX_ATTEMPTS} 次`));
  });
});
