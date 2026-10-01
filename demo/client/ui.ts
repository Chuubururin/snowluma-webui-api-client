// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
/** 迁自 dashboard.ts 的内联 esc，加固版：引号也转义，杜绝属性位逃逸。 */
export function esc(s: unknown): string {
  return String(s ?? '').replace(
    /[<>&"']/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}

/** 区块独立容错渲染：任何区块的异常只影响本区块，显示为错误而不是"加载中…"悬挂。 */
export function section(id: string, render: () => string): void {
  const el = document.getElementById(id);
  if (!el) return;
  try {
    el.innerHTML = render();
  } catch (e) {
    el.innerHTML = '<div class="err">本区块渲染失败：' + esc((e as Error).message) + '</div>';
  }
}

/**
 * 文本落盘下载（TRACE 导出与的备份导出共用一份）：
 * demo 服务端拿到的是正文字符串，读不到上游的 `Content-Disposition`，所以文件名由调用方给。
 * `revokeObjectURL` 推迟到下一个宏任务：点击与下载启动之间留一次事件循环，
 * 同帧回收会让部分浏览器把这次下载一起取消掉。
 */
export function downloadText(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
