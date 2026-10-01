// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const BANNER = '// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器';
export const AUTO_GEN_MARKER = '// AUTO-GENERATED — do not edit';

export function withBanner(source: string): string {
  return `${BANNER}\n${AUTO_GEN_MARKER}\n\n${source}`;
}

export function writeGenerated(filePath: string, source: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, withBanner(source), 'utf-8');
}
