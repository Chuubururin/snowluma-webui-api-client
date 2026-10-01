// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
import { readFile } from 'node:fs/promises';

export interface ModelExport {
  name: string;
  kind: 'interface' | 'type';
  file: string;
  line: number;
}

// 锚定行首（^ + m 标志），缩进的 export 不匹配 —— 上游代码里没有缩进 export。
// 注意这只挡住"缩进"的注释行；行首就是 `export` 的块注释文本仍会命中（上游 types.ts
// 有 6 处行首块注释起始，当前均不含 `export interface/type` 字样，故 76/19 计数可靠）。
const EXPORT = /^export\s+(interface|type)\s+([A-Za-z0-9_]+)/gm;

export function extractModelsFromSource(source: string, fileLabel: string): ModelExport[] {
  const out: ModelExport[] = [];
  EXPORT.lastIndex = 0;
  let m: RegExpExecArray | null;
  let line = 0;
  for (const text of source.split('\n')) {
    line += 1;
    EXPORT.lastIndex = 0;
    const hit = EXPORT.exec(text);
    if (hit) out.push({ name: hit[2], kind: hit[1] as 'interface' | 'type', file: fileLabel, line });
  }
  return out;
}

export async function extractModels(
  files: { repoPath: string; localPath: string }[],
): Promise<ModelExport[]> {
  const out: ModelExport[] = [];
  for (const f of files) {
    out.push(...extractModelsFromSource(await readFile(f.localPath, 'utf8'), f.repoPath));
  }
  return out;
}
