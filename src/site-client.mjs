// 默认站点；仍支持显式 endpoint/apiBase/siteURL 覆盖。
export const ENDPOINT = "https://ps.air-outer.com";

// 厂商自家客户端发送的请求头：网关只放行 codex_cli_rs，其余是 Codex CLI 同行的头。
export const DEFAULT_HEADERS = {
  "User-Agent": "codex_cli_rs/0.101.0",
  Accept: "application/json",
};

// 一次列表读取覆盖的模型 Key 条数；数量正好等于页大小说明列表被截断，而非账号只有这些。
const MODEL_KEY_PAGE_SIZE = 50;

export const REQUEST_TIMEOUT = 30_000;

export function withTimeout(ms) {
  return AbortSignal.timeout(ms);
}

// 把账号保存的「一行一个头」文本解析成对象：行为 "Name: value"，空行与 # 开头跳过，
// 因此从 devtools 复制的整块可用；同名后者覆盖前者，与 Headers 行为一致。
export function parseHeaders(text) {
  const out = {};
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith("#")) continue;
    const at = s.indexOf(":");
    if (at < 1) continue;
    const name = s.slice(0, at).trim();
    const value = s.slice(at + 1).trim();
    if (name && value) out[name] = value;
  }
  return out;
}

// 模型层请求头：宿主把插件 config 里各模型的 headers 合并进来，provider 编辑器也写在这里，
// 是登录后仍可改头的地方，故按 provider 自身的块读取。
function modelHeaders(provider) {
  const models = provider?.models;
  if (!models || typeof models !== "object") return {};
  const out = {};
  for (const m of Object.values(models)) {
    if (m && typeof m.headers === "object" && m.headers) Object.assign(out, m.headers);
  }
  return out;
}

// 请求发送时使用的头，优先级由低到高：默认值、provider 自身的块（含其模型头）、账号自身的块，后者覆盖前者。
// Codex 的 User-Agent 是网关放行的客户端标识，用户可用自己的头覆盖。
export function headersOf(provider, auth) {
  return {
    "User-Agent": DEFAULT_HEADERS["User-Agent"],
    Accept: DEFAULT_HEADERS.Accept,
    ...modelHeaders(provider),
    ...parseHeaders(provider?.headers),
    ...parseHeaders(headersText(auth)),
  };
}

// 在 Headers 上写入请求头；值为空则删除，便于用户清空某项来移除它。
export function applyHeaders(h, extra) {
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined || v === null || v === "") h.delete(k);
    else h.set(k, String(v));
  }
  return h;
}

// 判断值是否可能作为基础 URL：须为 http(s) 地址。endpoint 是自由文本，
// 旧版本误把 key 存进去时，用非地址拼出的 base 会让请求发往空目标且不报错。
export function isURLish(v) {
  return /^https?:\/\/\S+$/i.test(String(v ?? "").trim());
}

// 模型调用的 base：优先账号自身 endpoint，否则用插件面向的站点 ps.air-outer.com。
// 非 URL 的已存 endpoint 直接忽略，请求仍发往站点，符合误填 key 的账号的意图。
export function apiBase(provider, auth) {
  const said = String(meta(auth, "endpoint") ?? provider?.endpoint ?? "").trim();
  if (isURLish(said)) return `${said.replace(/\/+$/, "")}/v1`;
  const base = String(meta(auth, "apiBase") ?? "").trim();
  if (base) return base.replace(/\/+$/, "");
  return `${ENDPOINT}/v1`;
}

// 站点接口 base：余额与签到路由，支持显式 siteURL 覆盖。
export function siteBase(provider, auth) {
  const said = String(meta(auth, "siteURL") ?? provider?.siteURL ?? "").trim();
  if (said) return said.replace(/\/+$/, "");
  return ENDPOINT;
}

// 读取账号保存的字段：magpie 可能传扁平记录，也可能把登录答案放在 metadata 下，两种形状都要兼容。
function meta(auth, name) {
  if (!auth) return undefined;
  const flat = auth[name];
  if (flat !== undefined && flat !== null && String(flat).trim() !== "") return flat;
  const nested = auth.metadata?.[name];
  return nested === undefined || nested === null ? undefined : nested;
}

// 站点 /api/user 路由使用的凭据：个人资料页的访问令牌。sk- key 不是它，
// 拿它去请求才会得到「access token 无效」。
function userToken(auth) {
  return String(meta(auth, "accessToken") ?? "").trim();
}

// 模型调用使用的凭据。
export function apiKey(auth) {
  return String(auth?.key ?? "").trim();
}

// New-Api-User 头的值：会话有效但未指明用户时，New API 站点会返回 401，故账号把 id 与会话一起保存。
function userId(auth) {
  return String(meta(auth, "userId") ?? "").trim();
}

// 账号自身的请求头块。
function headersText(auth) {
  return String(meta(auth, "headers") ?? "");
}

// 账号从站点复制的浏览器 Cookie；有效会话可鉴权用户读取，但 WAF 仍可能拦截，即便它在浏览器里可用。
function cookieText(auth) {
  return String(meta(auth, "cookie") ?? "").trim();
}

// 把浏览器展示的 Cookie 文本（"a=1; b=2"，或 devtools 制表符分隔的多行）转成 Cookie 头；
// 同名后者覆盖前者，与浏览器发送行为一致。
export function parseCookies(text) {
  const out = [];
  const seen = new Map();
  for (const raw of String(text ?? "").split(/\r?\n|;/)) {
    const s = raw.trim();
    if (!s || s.startsWith("#")) continue;
    // devtools 每行是「name<TAB>value<TAB>domain…」，纯文本是 "name=value"，两者都只取前两段。
    const cols = s.split("\t");
    let name, value;
    if (cols.length > 1) {
      name = cols[0].trim();
      value = (cols[1] ?? "").trim();
    } else {
      const at = s.indexOf("=");
      if (at < 1) continue;
      name = s.slice(0, at).trim();
      value = s.slice(at + 1).trim();
    }
    if (!name) continue;
    if (seen.has(name)) out[seen.get(name)] = `${name}=${value}`;
    else {
      seen.set(name, out.length);
      out.push(`${name}=${value}`);
    }
  }
  return out.join("; ");
}

// /api/user 请求携带的内容：访问令牌、已知时的用户 ID，以及账号持有的、可绕过 WAF 的浏览器 Cookie。
export function userHeaders(provider, auth) {
  const h = headersOf(provider, auth);
  h.Authorization = userToken(auth);
  delete h["Content-Type"];
  if (userId(auth)) h["New-Api-User"] = userId(auth);
  const cookie = parseCookies(cookieText(auth));
  if (cookie) h.Cookie = cookie;
  return h;
}

export async function jsonOrText(res) {
  const text = await res.text();
  try {
    return { json: JSON.parse(text), text };
  } catch {
    return { json: undefined, text };
  }
}

// ---- 站点会话 ---------------------------------------------------------------

// 从响应中取出站点会话 Cookie。该站点以设置 `session` 而非返回正文令牌的方式完成登录；
// get("set-cookie") 会用 ", " 连接多个 Cookie，而该字符也出现在 Expires 日期内，
// 因此运行环境提供分离条目时优先读取分离条目。
function sessionOf(res) {
  let lines = [];
  try {
    if (typeof res.headers.getSetCookie === "function") lines = res.headers.getSetCookie() ?? [];
  } catch {
    lines = [];
  }
  if (!lines.length) {
    const joined = res.headers.get("set-cookie");
    if (joined) lines = [joined];
  }
  for (const line of lines) {
    const m = /(?:^|[;,])\s*session=([^;,\s]+)/.exec(String(line));
    if (m) return m[1];
  }
  return "";
}

export function usableModelKey(value) {
  if (typeof value !== "string") return false;
  const key = value.trim();
  return key !== "" && !["agentrouter", "your_api_key"].includes(key.toLowerCase()) && !/[*…<>]|\.\.\.|\s/.test(key);
}

function enabledModelKey(item) {
  if (item?.status !== 1 || !usableModelKey(item.key)) return null;
  const expiry = item.expired_time;
  const now = Date.now() / 1000;
  if (expiry != null && (typeof expiry !== "number" || !Number.isFinite(expiry) || (expiry !== -1 && expiry <= now))) return null;
  return item.key.trim();
}

// 把一次列表读取转成可用 Key，按 key 本身去重并保持列表顺序；一把无需选择，多把列出供用户挑。
function selectModelKeys(json, pageSize) {
  const data = json?.data;
  const items = Array.isArray(data) ? data : data?.items;
  if (!Array.isArray(items)) return { kind: "unsupported" };
  const total = Array.isArray(data) ? json.total : data?.total;
  if (total != null && (!Number.isSafeInteger(total) || total < items.length)) return { kind: "unsupported" };
  if (total != null ? total > items.length : items.length >= pageSize) return { kind: "incomplete" };
  const seen = new Set();
  const itemsByKey = [];
  for (const item of items) {
    const key = enabledModelKey(item);
    if (key && !seen.has(key)) {
      seen.add(key);
      itemsByKey.push({ key, name: String(item?.name ?? "").trim() });
    }
  }
  if (!itemsByKey.length) return { kind: "missing" };
  return { kind: "found", items: itemsByKey };
}

// 用密码登录拿到的会话读取账号已有 Key，只读一次。
export async function storedKeyOf(base, cookie, id) {
  const headers = { ...DEFAULT_HEADERS };
  if (cookie) headers.Cookie = cookie;
  if (id) headers["New-Api-User"] = String(id);
  try {
    const res = await fetch(`${base}/api/token/?p=1&page_size=${MODEL_KEY_PAGE_SIZE}`, {
      headers,
      signal: withTimeout(REQUEST_TIMEOUT),
    });
    const { json, text } = await jsonOrText(res);
    if (!json && /^\s*</.test(text)) return { kind: "blocked" };
    if (res.status === 401 || res.status === 403) return { kind: "rejected" };
    if (!res.ok) return { kind: "upstream" };
    if (json?.success === false) return { kind: "rejected" };
    return selectModelKeys(json, MODEL_KEY_PAGE_SIZE);
  } catch {
    return { kind: "network" };
  }
}

// signIn 就是整个功能：一次 POST 到登录路由，登录响应同时带回当日签到与余额。
//
// 厂商在登录时发放每日额度，而不是另设路由（其前端在响应含 checked_in 时显示
// 「签到成功，新增额度已到账」），同一响应也带有额度字段。因此一次调用完成两件事；
// 这也是服务端唯一能读到余额的方式：New API 常规使用的 /api/user/self 被本站 WAF
// 以滑块验证码拦截，而 /api/user/login 未被拦截。
//
// 返回 {ok, checkedIn?, balance?, why?}。ok 为 false 时由调用方区分「账号自身可修」
// （密码错误）与「非账号问题」（站点故障），所以原因在此保持可区分。
export async function signIn(provider, auth) {
  const user = String(meta(auth, "username") ?? "").trim();
  const pass = String(meta(auth, "password") ?? "");
  if (!user || !pass) return { ok: false, why: "no-password" };
  const h = headersOf(provider, auth);
  h["Content-Type"] = "application/json";
  delete h.Authorization;
  let res;
  try {
    res = await fetch(`${siteBase(provider, auth)}/api/user/login`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({ username: user, password: pass }),
      signal: withTimeout(REQUEST_TIMEOUT),
    });
  } catch (e) {
    return { ok: false, why: `unreachable: ${e?.message ?? String(e)}` };
  }
  const { json, text } = await jsonOrText(res);
  if (!json) {
    if (/^\s*<(?:!doctype|html)/i.test(String(text))) return { ok: false, why: "blocked", blocked: true };
    // 正文不是 JSON；可能回显了提交的凭据，因此绝不回显给用户。
    return { ok: false, why: `HTTP ${res.status}` };
  }
  if (json.success === false) {
    const msg = String(json.message ?? json.msg ?? "");
    // 站点把密码错误与账号封禁表述得一样，故这里只说「站点拒绝了这组凭据」，属账号自身可修。
    if (/密码|password|封禁|banned|错误/i.test(msg)) return { ok: false, why: "bad-password", message: msg };
    return { ok: false, why: msg || "refused", message: msg };
  }
  const d = json.data ?? {};
  const balance = quotaBalance(d);
  // `checked_in: true` 表示站点确认本次登录新增了额度；为 false 或缺失不影响登录本身，
  // 站点按登录完成计当日签到。
  const session = sessionOf(res);
  return {
    ok: true,
    checkedIn: d.checked_in,
    balance,
    name: d.username ?? d.display_name ?? "",
    id: d.id,
    ...(session ? { session } : {}),
  };
}

// 用访问令牌或浏览器会话读取 /api/user/self。
export async function balanceByToken(provider, auth) {
  if (!userToken(auth) && !parseCookies(cookieText(auth))) return { ok: false, why: "no-token" };
  try {
    const res = await fetch(`${siteBase(provider, auth)}/api/user/self`, {
      headers: userHeaders(provider, auth),
      signal: withTimeout(REQUEST_TIMEOUT),
    });
    const { json, text } = await jsonOrText(res);
    // New API 对被拒的令牌返回 200 + success:false，状态码不足以判断，须看正文。
    if (json && json.success === false) {
      const msg = String(json.message ?? "");
      if (/access\s*token|token.*(无效|invalid)|未登录/i.test(msg)) return { ok: false, why: "expired", expired: true };
      return { ok: false, why: msg || "refused" };
    }
    if (!res.ok) return { ok: false, why: `HTTP ${res.status}` };
    // 站点 WAF 会用 200 返回 HTML 滑块验证码页而非 JSON：把 "<!doctype html>" 回给用户
    // 会掩盖真正的问题——读取被拦截，而登录才是绕过它的方式。
    if (!json) {
      if (/^\s*<(?:!doctype|html)/i.test(String(text))) {
        return { ok: false, why: "blocked", blocked: true };
      }
      return { ok: false, why: `HTTP ${res.status}` };
    }
    const balance = quotaBalance(json.data ?? {});
    if (!balance) return { ok: false, why: "no-quota" };
    return { ok: true, balance };
  } catch (e) {
    return { ok: false, why: `unreachable: ${e?.message ?? String(e)}` };
  }
}

// 这些接口只报告累计消耗，绝不报告剩余额度。
export async function spendOf(provider, auth) {
  const rate = quotaRate(provider);
  const reads = [];
  if (userToken(auth) || parseCookies(cookieText(auth))) {
    reads.push({
      url: `${siteBase(provider, auth)}/api/log/self/stat`,
      headers: userHeaders(provider, auth),
      field: "quota",
      divisor: rate,
    });
  }
  if (apiKey(auth)) {
    reads.push({
      url: `${apiBase(provider, auth)}/dashboard/billing/usage`,
      headers: { ...headersOf(provider, auth), Authorization: `Bearer ${apiKey(auth)}` },
      field: "total_usage",
      divisor: 100,
    });
  }
  for (const read of reads) {
    try {
      const res = await fetch(read.url, { headers: read.headers, signal: withTimeout(REQUEST_TIMEOUT) });
      const { json } = await jsonOrText(res);
      if (!res.ok || !json || json.success === false) continue;
      const value = (json.data ?? json)[read.field];
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) continue;
      return { ok: true, spent: value / read.divisor };
    } catch {
      // 用户读取失败不得阻止后面独立的 key 回退路径。
    }
  }
  return { ok: false };
}

function quotaBalance(data) {
  const quota = quotaNumber(data.quota);
  const used = quotaNumber(data.used_quota);
  if (!Number.isFinite(quota) || !Number.isFinite(used)) return undefined;
  return { quota, used, total: quota + used, name: data.username ?? data.display_name ?? "" };
}

function quotaNumber(value) {
  if (typeof value !== "number" && !(typeof value === "string" && value.trim())) return NaN;
  const n = Number(value);
  return Number.isFinite(n) ? n : NaN;
}

export function quotaRate(provider) {
  const rate = Number(provider?.quotaPerUnit ?? 500000);
  return Number.isFinite(rate) && rate > 0 ? rate : 500000;
}
