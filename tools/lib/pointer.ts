// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器

export interface PointerTarget {
  found: boolean;
  value: unknown;
}

// 通用本地 JSON pointer 下降： '#' 开头则自文档根逐级 descend，任何形状（schemas / parameters /
// responses / paths / 更深的路径）都解析，取代首轮实现只认 '#/components/schemas/…' 的单形状写法。
export function resolveLocalPointer(root: unknown, ref: string): PointerTarget {
  const raw = ref.slice(1);
  if (raw === '' || raw === '/') return { found: true, value: root };
  const segments = raw.startsWith('/') ? raw.slice(1).split('/') : raw.split('/');
  let cur: unknown = root;
  for (const seg of segments) {
    let key = seg.replace(/~1/g, '/').replace(/~0/g, '~');
    try {
      key = decodeURIComponent(key);
    } catch {
      // 不是合法的百分号编码，按 ~1/~0 解转义后的原样键名处理
    }
    if (cur === null || typeof cur !== 'object' || !Object.hasOwn(cur as object, key)) return { found: false, value: undefined };
    cur = (cur as Record<string, unknown>)[key];
  }
  return { found: true, value: cur };
}
