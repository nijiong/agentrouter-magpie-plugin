// 通过克隆读取正文，不消耗调用方的 Request/Response；返回 null 表示无法判定，调用方必须保留原对象。
export async function readCloneText(source, { maxBytes, timeoutMs, signal }) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || signal?.aborted) return null;
  let reader, timer, abort;
  try {
    reader = source.clone().body?.getReader();
    if (!reader) return null;
    const stopped = new Promise((_, reject) => {
      abort = () => reject(new Error("Body inspection stopped"));
      timer = setTimeout(abort, timeoutMs);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let bytes = 0, text = "";
    for (;;) {
      const { value, done } = await Promise.race([reader.read(), stopped]);
      if (done) return text + decoder.decode();
      bytes += value.byteLength;
      if (bytes > maxBytes) return null;
      text += decoder.decode(value, { stream: true });
    }
  } catch { return null; }
  finally {
    clearTimeout(timer);
    if (abort) signal?.removeEventListener("abort", abort);
    // 克隆流的取消可能等待原消费方，不能 await。
    if (reader) void reader.cancel().catch(() => {});
  }
}
