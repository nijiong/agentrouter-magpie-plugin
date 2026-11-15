import { open } from "node:fs/promises";
import { isPlainMessage, isPlainTextPart } from "./responses-shapes.mjs";

const MARKER = "[FILTERED]";
const MAX_CONFIG_BYTES = 32 * 1024;
const MAX_TERMS = 128;
const MAX_TERM_LENGTH = 256;
const MAX_TOTAL_TERM_LENGTH = 8192;

function configurationError() {
  const error = new Error("AgentRouter text filter configuration is invalid or unreadable. Check content-filter.local.json; no request was sent. Rule contents are not logged.");
  error.code = "agent_router_text_filter_config";
  return error;
}

function escapePattern(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// 保护 Markdown 代码，避免误改可执行示例；未闭合的代码定界符保守地保护剩余片段。
function inlineCodeRanges(text) {
  const ranges = [];
  const runs = /`+/g;
  let opening;
  while ((opening = runs.exec(text))) {
    let closing;
    while ((closing = runs.exec(text)) && closing[0].length !== opening[0].length) {}
    ranges.push([opening.index, closing ? runs.lastIndex : text.length]);
    if (!closing) break;
  }
  return ranges;
}

// 容器围栏的缩进与闭合规则依赖上下文；没有完整的 Markdown 解析器时，整体保留该字段而非冒改代码的风险。
function codePrefix(line) {
  // 单调前进：嵌套空白正则即便面对仅数字节的深层引用文本也可能指数级回溯。
  const space = char => char === " " || char === "\t";
  let position = 0, container = false, indented = false;
  while (position < line.length) {
    const start = position;
    while (space(line[position])) {
      if (line[position] === "\t") indented = true;
      position++;
    }
    if (position - start >= 4) indented = true;
    let end = position;
    if (line[position] === ">") end++;
    else if (["-", "+", "*"].includes(line[position]) && space(line[position + 1])) end++;
    else {
      while (line[end] >= "0" && line[end] <= "9") end++;
      if (end > position && [".", ")"].includes(line[end]) && space(line[end + 1])) end++;
      else end = position;
    }
    if (end === position) break;
    container = true;
    position = end;
    if (space(line[position])) position++; // 一个容器分隔符不算代码缩进。
  }
  return { indented, containerFence: container && (line.startsWith("```", position) || line.startsWith("~~~", position)) };
}

function hasContainerFence(text) {
  return text.split(/\r?\n/).some(line => codePrefix(line).containerFence);
}

// 结构分隔符跟着代码一起保留，缩进留给下一个非空行按其自身 Markdown 规则分类。
function codeRangeWithBoundaries(text, start, end) {
  while (start > 0 && /[ \t\r\n]/.test(text[start - 1])) start--;
  let cursor = end;
  while (cursor < text.length) {
    let next = cursor;
    while (text[next] === " " || text[next] === "\t") next++;
    if (text[next] === "\r" && text[next + 1] === "\n") next += 2;
    else if (text[next] === "\n") next++;
    else break;
    cursor = next;
  }
  return [start, cursor];
}

function outsideProseCode(text, replace) {
  // 对照原文而非切片收集范围：行内代码不得抹掉缩进，缩进也不得拆开跨行代码段。
  const inline = inlineCodeRanges(text);
  const protectedRanges = [...inline];
  // 字面规则本身可能含该标记；只保护以它开头的匹配，仍会让更长的规则在后续轮次吃掉标记。
  for (const marker of text.matchAll(/\[FILTERED\]/g)) {
    protectedRanges.push([marker.index, marker.index + marker[0].length]);
  }
  const paragraphs = text.split(/(\r?\n[ \t]*\r?\n)/);
  let position = 0, inlineIndex = 0;
  for (let index = 0; index < paragraphs.length; index++) {
    const paragraph = paragraphs[index];
    let linePosition = position;
    for (const line of paragraph.split("\n")) {
      while (inlineIndex < inline.length && inline[inlineIndex][1] <= linePosition) inlineIndex++;
      const insideInline = inlineIndex < inline.length && inline[inlineIndex][0] <= linePosition;
      if (!insideInline && line.trim() && codePrefix(line).indented) {
        // 两侧分隔符都要保留：吃掉任一侧都会改变下一轮的 Markdown 分类，即便未改动代码字节。
        protectedRanges.push(codeRangeWithBoundaries(text, position, position + paragraph.length));
        break;
      }
      linePosition += line.length + 1;
    }
    position += paragraph.length;
  }
  protectedRanges.sort((left, right) => left[0] - right[0]);
  const output = [];
  position = 0;
  for (const [start, end] of protectedRanges) {
    if (start > position) output.push(replace(text.slice(position, start)));
    if (end > position) output.push(text.slice(Math.max(position, start), end));
    position = Math.max(position, end);
  }
  output.push(replace(text.slice(position)));
  return output.join("");
}

function outsideCode(text, replace) {
  if (hasContainerFence(text)) return text;
  const output = [];
  const fences = /^ {0,3}(`{3,}|~{3,})([^\n]*)(?:\n|$)/gm;
  let position = 0, opening = null, match;
  while ((match = fences.exec(text))) {
    if (!opening) {
      const start = Math.max(position, codeRangeWithBoundaries(text, match.index, match.index)[0]);
      output.push(outsideProseCode(text.slice(position, start), replace));
      opening = { index: start, marker: match[1] };
    } else if (match[1][0] === opening.marker[0] && match[1].length >= opening.marker.length && !match[2].trim()) {
      const end = codeRangeWithBoundaries(text, opening.index, fences.lastIndex)[1];
      output.push(text.slice(opening.index, end));
      position = fences.lastIndex = end;
      opening = null;
    }
  }
  output.push(opening ? text.slice(opening.index) : outsideProseCode(text.slice(position), replace));
  return output.join("");
}

// 只支持字面、有界的规则：不推断厂商关键词，也不接受用户正则。
export function createTextFilter(config) {
  if (!config || typeof config !== "object" || Array.isArray(config) ||
      Object.keys(config).some(key => !["terms", "caseSensitive"].includes(key)) ||
      !Array.isArray(config.terms) || config.terms.length > MAX_TERMS ||
      (config.caseSensitive !== undefined && typeof config.caseSensitive !== "boolean") ||
      config.terms.some(term => typeof term !== "string" || !term.trim() || term.length > MAX_TERM_LENGTH) ||
      config.terms.reduce((total, term) => total + term.length, 0) > MAX_TOTAL_TERM_LENGTH) throw configurationError();
  if (!config.terms.length) return null;
  const terms = [...new Set(config.terms)].sort((left, right) => right.length - left.length);
  const pattern = new RegExp(`(${escapePattern(MARKER)})|${terms.map(escapePattern).join("|")}`, config.caseSensitive === false ? "giu" : "gu");
  return text => {
    let replacements = 0;
    const result = outsideCode(text, segment => segment.replace(pattern, (match, marker) => {
      if (marker) return match;
      replacements++;
      return MARKER;
    }));
    return { text: result, replacements };
  };
}

// 在创建 provider loader 时加载；改动文件需重新加载插件。文件缺失或词表为空即关闭；配置了但损坏的文件不会被忽略。
export async function loadTextFilter(path = new URL("./content-filter.local.json", import.meta.url)) {
  let file;
  try { file = await open(path, "r"); }
  catch (error) { if (error.code === "ENOENT") return null; throw configurationError(); }
  try {
    if (!(await file.stat()).isFile()) throw configurationError();
    const buffer = Buffer.alloc(MAX_CONFIG_BYTES + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const { bytesRead } = await file.read(buffer, bytes, buffer.length - bytes, bytes);
      if (!bytesRead) break;
      bytes += bytesRead;
    }
    if (bytes > MAX_CONFIG_BYTES) throw configurationError();
    const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytes));
    return createTextFilter(JSON.parse(text));
  } catch { throw configurationError(); }
  finally { await file.close(); }
}

// 这是范围很窄的文本改写，不是防数据丢失的边界：工具数据、标注、媒体与服务端/不透明历史都保持原样。
export function redactResponsesBody(body, filter) {
  if (!filter || !body || typeof body !== "object" || Array.isArray(body)) return { body, replacements: 0 };
  let replacements = 0;
  const redact = text => { const result = filter(text); replacements += result.replacements; return result.text; };
  const part = value => {
    if (!isPlainTextPart(value)) return value;
    const text = redact(value.text);
    return text === value.text ? value : { ...value, text };
  };
  const message = item => {
    if (!isPlainMessage(item) || (item.type != null && item.type !== "message")) return item;
    const before = replacements;
    const content = typeof item.content === "string" ? redact(item.content) : Array.isArray(item.content) ? item.content.map(part) : item.content;
    return replacements === before ? item : { ...item, content };
  };
  const input = typeof body.input === "string" ? redact(body.input) : Array.isArray(body.input) ? body.input.map(message) : body.input;
  const instructions = typeof body.instructions === "string" ? redact(body.instructions) : body.instructions;
  if (!replacements) return { body, replacements: 0 };
  const result = { ...body };
  if (Object.hasOwn(body, "input")) result.input = input;
  if (Object.hasOwn(body, "instructions")) result.instructions = instructions;
  return { body: result, replacements };
}
