export function isPlainMessage(item) {
  return item != null && typeof item === "object" &&
    ["user", "assistant", "system", "developer"].includes(item.role) &&
    Object.keys(item).every(key => ["type", "id", "role", "content", "status", "phase"].includes(key));
}

export function isPlainTextPart(part) {
  if (!part || typeof part !== "object" || !["input_text", "output_text"].includes(part.type) ||
      typeof part.text !== "string") return false;
  // 只有 output_text 可以带空 logprobs；带未知字段的输入部分留在文本过滤之外。
  return Object.keys(part).every(key => ["type", "text", "annotations"].includes(key) ||
      part.type === "output_text" && key === "logprobs" && Array.isArray(part.logprobs) && !part.logprobs.length) &&
    (part.annotations == null || Array.isArray(part.annotations) && part.annotations.length === 0);
}
