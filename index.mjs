import { explainResponse } from "./response.mjs";
import { prepareRequest } from "./request.mjs";
import { loadTextFilter } from "./content-filter.mjs";

// AgentRouter (ps.air-outer.com) for magpie / OpenCode.
//
// Three things make this vendor different from a plain OpenAI-compatible
// relay:
//
// 1. Its gateway only answers a client it recognises. A request whose
//    User-Agent is curl's, or a browser's, or anything else off its list is
//    refused with "unauthorized client detected", even when the key is good.
//    So the request headers are not cosmetic here: they are what gets the key
//    through, and the one that works is the vendor's own client's. They are
//    configurable — per provider and per account — and the default is that
//    client's. The provider's own switch turns that default off, for a user
//    who would rather send exactly the headers they named.
//
// 2. It has no daily check-in to call. The site is a New API deployment,
//    and most New API sites put one on GET /api/user/checkin. This one
//    does not: that path falls through to New API's *admin* route
//    /api/user/:id, which answers "权限不足" to every ordinary account —
//    the same answer it gives /api/user/foo or /api/user/zzz. The daily
//    credit is granted at sign-in instead (the site's login response
//    carries checked_in, and its settings keep DailyCheckinQuota), so
//    there is nothing for a plugin to claim after the fact. The check-in
//    hook signs in with the account's username and password, which the user
//    enters at sign-in; this build offers no other method.
//
// 3. /api/user/self reports quota and used_quota, but often returns an
//    Aliyun slider-captcha page instead. Try it with an access token or
//    browser session; neither credential guarantees passage through WAF.
//    A password sign-in can also return the current user record and grant
//    the day's credit, and its session reads the account's existing model
//    keys. The site account signs in with the username and password the
//    user entered; this build offers no other sign-in.
//
//    The model API itself only accepts a model key: the password sign-in
//    looks that key up after login and saves it for completions.

const PROVIDER = "agentrouter";

// The request endpoint: where completions and the model list go. This build
// only talks to the vendor's ps.air-outer.com front door; its web routes
// (login, balance, check-in, key list) live on the same origin.
const ENDPOINT = "https://ps.air-outer.com";

// What the vendor's own clients send. codex_cli_rs is what its gateway
// admits; the rest are the headers a Codex CLI sends beside it.
const DEFAULT_HEADERS = {
  "User-Agent": "codex_cli_rs/0.101.0",
  Accept: "application/json",
};

// How many model keys one list read covers. A count at the page size means
// the list was cut, not that the account has that many.
const MODEL_KEY_PAGE_SIZE = 50;

// Models are listed by the vendor, so this is only what to show before a
// sign-in and the shape (limits, tool calls) each listed model takes.
const MODEL_SHAPE = {
  name: undefined,
  limit: { context: 300000, output: 128000 },
  tool_call: true,
  reasoning: true,
};

// The models this plugin itself ships, by the name to show them under. They
// are what the row lists before the vendor's own list arrives — and what it
// falls back to when that list cannot be read.
//
// magpie also keeps a models.dev catalog, and its cached entry for this
// vendor still carries models the site has retired (see README, "模型列表从
// 哪来"). Falling back to the row's current models would re-advertise them,
// so the fallback is built from this table instead: a model shown here is one
// this plugin vouches for.
const DECLARED_MODELS = {
  "gpt-5.6-sol": "GPT-5.6 Sol",
  "gpt-6-astra": "GPT-6 Astra",
  "gpt-6.1-sol": "GPT-6.1 Sol",
};

// codexHeaders is whether requests are sent as a Codex CLI's, as the
// provider's own switch has it. The switch is the vendor's whitelist made
// optional: off, only the headers the user gave are sent. It is read from the
// host when the plugin loads (magpie hands the reader over as input.magpie),
// and defaults to on — including on a host too old to have the switch, which
// is why the option is checked for rather than assumed.
let codexHeaders = () => true;

const REQUEST_TIMEOUT = 30_000;

// The single sign-in method asks for the account's username and password.
// No credential is baked into the source: the user types both, and the host
// saves what authorize returned. There is no site pick: every request goes
// to ps.air-outer.com.
const USERNAME_PROMPT = {
  type: "text",
  key: "username",
  message: "站点账号（用户名 / 邮箱）",
  validate: value => String(value ?? "").trim() ? undefined : "请输入站点账号",
};

const PASSWORD_PROMPT = {
  type: "password",
  key: "password",
  message: "站点密码",
  validate: value => String(value ?? "") ? undefined : "请输入站点密码",
};

function withTimeout(ms) {
  return AbortSignal.timeout(ms);
}

// parseHeaders turns the one-header-per-line text an account keeps into an
// object. A line is "Name: value"; blank lines and lines starting with #
// are skipped, so a block copied out of a browser's devtools works as it
// is. A name repeated keeps its last value, as a Headers object would.
function parseHeaders(text) {
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

// modelHeaders is the header block the provider's editor keeps on a model:
// info() merges each model's `headers` from the plugin's config, and magpie's
// provider editor writes the user's own there. It is the place a header can
// be changed after sign-in without signing in again, so it is read here as
// the provider's own block.
function modelHeaders(provider) {
  const models = provider?.models;
  if (!models || typeof models !== "object") return {};
  const out = {};
  for (const m of Object.values(models)) {
    if (m && typeof m.headers === "object" && m.headers) Object.assign(out, m.headers);
  }
  return out;
}

// headersOf is what a request to the vendor is sent with, lowest to highest:
// the defaults, the provider's own block (its models' headers, which the
// editor keeps), and the account's own, each overriding the one before it.
//
// The Codex User-Agent is the switch's business; Accept is not a client
// claim, so it stays whatever the switch says.
function headersOf(provider, auth) {
  return {
    ...(codexHeaders() ? { "User-Agent": DEFAULT_HEADERS["User-Agent"] } : {}),
    Accept: DEFAULT_HEADERS.Accept,
    ...modelHeaders(provider),
    ...parseHeaders(provider?.headers),
    ...parseHeaders(headersText(auth)),
  };
}

// applyHeaders sets headers on a Headers object, dropping any whose value is
// empty so a user can take one off by clearing it.
function applyHeaders(h, extra) {
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined || v === null || v === "") h.delete(k);
    else h.set(k, String(v));
  }
  return h;
}

// isURLish says whether a value can be a base URL at all: an http(s) address.
// A stored endpoint is free text, so a key pasted there by an older build
// lands in the same field as a real address does. Such a value is not an
// endpoint however it was stored, and building a base out of it sends every
// request to nothing at all, with no error to show for it.
function isURLish(v) {
  return /^https?:\/\/\S+$/i.test(String(v ?? "").trim());
}

// apiBase is the base completions go to. It follows the account's own
// endpoint when it gave one, and otherwise the endpoint this plugin was built
// for: ps.air-outer.com.
//
// A stored endpoint that isn't a URL is ignored rather than used: the
// request then still goes to the vendor, which is what the account wanted
// when it pasted a key there.
function apiBase(provider, auth) {
  const said = String(meta(auth, "endpoint") ?? provider?.endpoint ?? "").trim();
  if (isURLish(said)) return `${said.replace(/\/+$/, "")}/v1`;
  const base = String(meta(auth, "apiBase") ?? "").trim();
  if (base) return base.replace(/\/+$/, "");
  return `${ENDPOINT}/v1`;
}

// siteBase is where the site's own web routes are: the balance and the
// check-in. This build only knows ps.air-outer.com.
function siteBase(provider, auth) {
  const said = String(meta(auth, "siteURL") ?? provider?.siteURL ?? "").trim();
  if (said) return said.replace(/\/+$/, "");
  return ENDPOINT;
}

// meta reads a field the account keeps, whether magpie hands the auth as the
// flat record ({type, key, accessToken, …}) or with the sign-in's answers
// under metadata ({type, key, metadata: {accessToken, …}}). Both shapes reach
// a hook: the flat one from the store, the nested one from what authorize
// returned, so every reader goes through here.
function meta(auth, name) {
  if (!auth) return undefined;
  const flat = auth[name];
  if (flat !== undefined && flat !== null && String(flat).trim() !== "") return flat;
  const nested = auth.metadata?.[name];
  return nested === undefined || nested === null ? undefined : nested;
}

// userToken is the credential the site's own /api/user routes take: the
// access token from the profile page. An sk- key is not one of those, and
// sending it there is what makes the balance read as "access token 无效".
function userToken(auth) {
  return String(meta(auth, "accessToken") ?? "").trim();
}

// apiKey is the credential completions take.
function apiKey(auth) {
  return String(auth?.key ?? "").trim();
}

// userId is the New-Api-User header's value. A New API site answers 401 to
// a session that is good but doesn't say which user it is, so the account
// keeps the id beside the token.
function userId(auth) {
  return String(meta(auth, "userId") ?? "").trim();
}

// headersText is the account's own header block, if it gave one.
function headersText(auth) {
  return String(meta(auth, "headers") ?? "");
}

// cookieText is the browser cookie the account copied from the site.
// A valid session authenticates user reads. WAF can still challenge those
// reads even when the same Cookie works in a browser.
function cookieText(auth) {
  return String(meta(auth, "cookie") ?? "").trim();
}

// parseCookies turns the text a browser shows for a site ("a=1; b=2", or
// the tab-separated lines of a devtools cookie table) into a Cookie header.
// A name repeated keeps its last value, as the browser's own send would.
function parseCookies(text) {
  const out = [];
  const seen = new Map();
  for (const raw of String(text ?? "").split(/\r?\n|;/)) {
    const s = raw.trim();
    if (!s || s.startsWith("#")) continue;
    // A devtools row is "name<TAB>value<TAB>domain…"; a plain pair is
    // "name=value". Both keep only the first two fields.
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

// userHeaders are what a /api/user call carries: the access token, the user
// id when the account knows it, and the browser cookie that gets past the
// WAF when the account has one.
function userHeaders(provider, auth) {
  const h = headersOf(provider, auth);
  h.Authorization = userToken(auth);
  delete h["Content-Type"];
  if (userId(auth)) h["New-Api-User"] = userId(auth);
  const cookie = parseCookies(cookieText(auth));
  if (cookie) h.Cookie = cookie;
  return h;
}

// masked keeps a value out of a message: a key or a token never goes into
// an error the user sees or a log line.
function masked(v) {
  const s = String(v ?? "");
  if (s.length <= 8) return s ? "…" : "";
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

async function jsonOrText(res) {
  const text = await res.text();
  try {
    return { json: JSON.parse(text), text };
  } catch {
    return { json: undefined, text };
  }
}

// ---- site session -----------------------------------------------------------

// sessionOf pulls the site's session cookie out of a response. This site
// answers a sign-in by setting `session` rather than by putting a token in
// the body, and `get("set-cookie")` joins every cookie with ", " — a
// character that also appears inside one (an Expires date) — so the separate
// entries are what get read when the runtime offers them.
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

function keyProblem(kind) {
  const messages = {
    invalidId: "模型 Key ID 需为纯数字，或留空",
    missing: "未找到启用且完整的模型 Key",
    ambiguous: "存在多个不同的模型 Key，无法确定使用哪一个",
    incomplete: "模型 Key 列表可能不完整，无法确定唯一候选",
    rejected: "站点拒绝读取模型 Key，请检查登录会话及权限",
    blocked: "读取模型 Key 时遇到站点验证页",
    unsupported: "站点返回的模型 Key 列表格式无法确认",
    upstream: "站点暂时无法提供模型 Key 列表",
    network: "读取模型 Key 的网络请求失败或超时",
  };
  return messages[kind] ?? "无法读取模型 Key";
}

function modelKeyIdProblem(value) {
  const id = String(value ?? "").trim();
  return !id || /^[1-9][0-9]*$/.test(id) ? undefined : keyProblem("invalidId");
}

function usableModelKey(value) {
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

function selectModelKey(json, pageSize) {
  const data = json?.data;
  const items = Array.isArray(data) ? data : data?.items;
  if (!Array.isArray(items)) return { kind: "unsupported" };
  const total = Array.isArray(data) ? json.total : data?.total;
  if (total != null && (!Number.isSafeInteger(total) || total < items.length)) return { kind: "unsupported" };
  if (total != null ? total > items.length : items.length >= pageSize) return { kind: "incomplete" };
  const keys = new Set();
  for (const item of items) {
    const key = enabledModelKey(item);
    if (key) keys.add(key);
  }
  if (keys.size === 0) return { kind: "missing" };
  if (keys.size !== 1) return { kind: "ambiguous" };
  return { kind: "found", key: keys.values().next().value };
}

// storedKeyOf reads the account's own keys with the credential a sign-in
// left behind: the login session cookie, or an access token on an older
// account. A named Key ID reads that one key on its own; otherwise the
// account needs exactly one enabled key to be usable without a choice.
async function storedKeyOf(base, cred, id, keyId) {
  const requested = String(keyId ?? "").trim();
  if (modelKeyIdProblem(requested)) return { kind: "invalidId" };
  const headers = { ...DEFAULT_HEADERS };
  if (cred?.cookie) headers.Cookie = cred.cookie;
  else if (cred?.token) headers.Authorization = cred.token;
  if (id) headers["New-Api-User"] = String(id);
  try {
    const url = requested ? `${base}/api/token/${requested}` : `${base}/api/token/?p=1&page_size=${MODEL_KEY_PAGE_SIZE}`;
    const res = await fetch(url, {
      headers,
      signal: withTimeout(REQUEST_TIMEOUT),
    });
    const { json, text } = await jsonOrText(res);
    if (!json && /^\s*</.test(text)) return { kind: "blocked" };
    if (res.status === 401 || res.status === 403) return { kind: "rejected" };
    if (!res.ok) return { kind: "upstream" };
    // A list that answers a business failure is a credential the site refuses;
    // a named id that answers one simply is not this account's key.
    if (json?.success === false) return requested ? { kind: "missing" } : { kind: "rejected" };
    if (requested) {
      const key = enabledModelKey(json?.data);
      return key ? { kind: "found", key } : { kind: "missing" };
    }
    return selectModelKey(json, MODEL_KEY_PAGE_SIZE);
  } catch {
    return { kind: "network" };
  }
}

// signIn is one POST to the site's login route, and it is the whole feature:
// the login response carries both the day's check-in and the balance.
//
// The vendor grants its daily credit at sign-in rather than through a route
// of its own — its front end says "签到成功，新增额度已到账" when the login
// response has checked_in — and that same response carries quota and
// used_quota, the account's balance. So one call does both jobs, and it is
// also the only way to read the balance from a server: /api/user/self, the
// route New API normally reads it from, is the one this site's WAF answers
// with a slider captcha, while /api/user/login is left alone.
//
// It answers {ok, checkedIn?, balance?, why?}. The caller decides whether a
// false `ok` is the account's to fix (wrong password) or nobody's (the site
// is down), so the reasons stay distinguishable here.
async function signIn(provider, auth) {
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
    // The body is not parsed JSON; it may echo submitted credentials, so it
    // is never repeated back to the user.
    return { ok: false, why: `HTTP ${res.status}` };
  }
  if (json.success === false) {
    const msg = String(json.message ?? json.msg ?? "");
    // The site words a wrong password and a banned account the same way, so
    // this is "the site refused these credentials", which is the account's
    // to fix.
    if (/密码|password|封禁|banned|错误/i.test(msg)) return { ok: false, why: "bad-password", message: msg };
    return { ok: false, why: msg || "refused", message: msg };
  }
  const d = json.data ?? {};
  const quota = quotaNumber(d.quota);
  const used = quotaNumber(d.used_quota);
  const balance =
    Number.isFinite(quota) && Number.isFinite(used)
      ? { quota, used, name: d.username ?? d.display_name ?? "" }
      : undefined;
  if (balance) balance.total = balance.quota + balance.used;
  // `checked_in: true` means *this* sign-in granted the day's credit. A false
  // means no new grant; a missing/non-boolean marker proves nothing.
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

// Try the read-only user endpoint first, then password sign-in. Preserve
// the failure reason when neither returns a complete quota record.
async function balance(provider, auth) {
  const viaToken = await balanceByToken(provider, auth);
  if (viaToken.ok) return viaToken;
  const viaLogin = await signIn(provider, auth);
  if (viaLogin.ok && viaLogin.balance) return { ok: true, balance: viaLogin.balance };
  if (viaLogin.ok) return { ok: false, why: "no-quota" };
  // Report the reason the user can act on: a wrong password outranks a
  // captcha, and a missing password means the token route's failure is the
  // real one.
  if (viaLogin.why === "bad-password") return { ok: false, why: "expired", expired: true, message: viaLogin.message };
  if (viaLogin.why !== "no-password") return viaLogin;
  return viaToken;
}

// Read /api/user/self with either an access token or a browser session.
async function balanceByToken(provider, auth) {
  if (!userToken(auth) && !parseCookies(cookieText(auth))) return { ok: false, why: "no-token" };
  try {
    const res = await fetch(`${siteBase(provider, auth)}/api/user/self`, {
      headers: userHeaders(provider, auth),
      signal: withTimeout(REQUEST_TIMEOUT),
    });
    const { json, text } = await jsonOrText(res);
    // New API answers 200 with success:false for a token it refuses, so the
    // status alone doesn't say; the body does.
    if (json && json.success === false) {
      const msg = String(json.message ?? "");
      if (/access\s*token|token.*(无效|invalid)|未登录/i.test(msg)) return { ok: false, why: "expired", expired: true };
      return { ok: false, why: msg || "refused" };
    }
    if (!res.ok) return { ok: false, why: `HTTP ${res.status}` };
    // The site sits behind a WAF that answers an HTML slider-captcha page
    // with 200 instead of the JSON: saying "<!doctype html>" back to the
    // user hides the real problem, which is that the read was blocked and a
    // sign-in is what gets past it.
    if (!json) {
      if (/^\s*<(?:!doctype|html)/i.test(String(text))) {
        return { ok: false, why: "blocked", blocked: true };
      }
      return { ok: false, why: `HTTP ${res.status}` };
    }
    const d = json.data ?? {};
    const quota = quotaNumber(d.quota);
    const used = quotaNumber(d.used_quota);
    if (!Number.isFinite(quota) || !Number.isFinite(used)) return { ok: false, why: "no-quota" };
    return { ok: true, balance: { quota, used, total: quota + used, name: d.username ?? d.display_name ?? "" } };
  } catch (e) {
    return { ok: false, why: `unreachable: ${e?.message ?? String(e)}` };
  }
}

// These endpoints report cumulative consumption, never remaining credit.
async function spendOf(provider, auth) {
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
      // A failed user read must not prevent the independent key fallback.
    }
  }
  return { ok: false };
}

function quotaNumber(value) {
  if (typeof value !== "number" && !(typeof value === "string" && value.trim())) return NaN;
  const n = Number(value);
  return Number.isFinite(n) ? n : NaN;
}

function quotaRate(provider) {
  const rate = Number(provider?.quotaPerUnit ?? 500000);
  return Number.isFinite(rate) && rate > 0 ? rate : 500000;
}

// magpie cannot show a percent-free consumption window. Use its text status
// for partial data so spend never becomes a balance or an invented 0% window.
async function usageOf(getAuth, provider) {
  const auth = await getAuth();
  if (!auth) return { windows: [] };
  const b = await balance(provider, auth);
  if (!b.ok) {
    const spend = await spendOf(provider, auth);
    if (spend.ok) {
      const reason = b.blocked
        ? "余额接口被滑动验证码拦截"
        : b.expired ? "站点拒绝了余额查询凭据，请核对用户名密码" : "余额接口未返回可用余额";
      return {
        error: `AgentRouter：累计消耗 $${spend.spent.toFixed(2)}；剩余额度未知（${reason}）。读取余额需有效的站点登录会话或用户名密码；登录会话不能保证通过验证码`,
        windows: [],
      };
    }
    const why =
      b.expired
        ? "AgentRouter：站点拒绝了凭据，请核对用户名密码"
        : b.blocked
          ? "AgentRouter：余额接口被滑动验证码拦截，剩余额度未知。登录会话不能保证通过验证码；可尝试重新登录读取余额"
          : b.why === "no-token"
            ? "AgentRouter：账号里没有站点登录会话，无法读取余额，请重新登录"
            : b.why === "no-quota"
              ? "AgentRouter：站点没有返回额度字段"
              : `AgentRouter：无法读取余额（${b.why}）`;
    return { error: why, windows: [] };
  }
  const bal = b.balance;
  // The site counts in 1/500000 dollars unless it says otherwise.
  const rate = quotaRate(provider);
  const dollars = (n) => Math.round((n / rate) * 100) / 100;

  // New API's fields, as the site's own dashboard labels them:
  //   quota      the balance left now      ("当前余额")
  //   used_quota what has been spent       ("历史消耗")
  //   both       the credit the account was given
  // magpie's window wants Used and Remaining as *percent*, with the counts
  // beside them in Amount/Limit/Unit — putting the dollars into Used is what
  // can make a positive balance read as "0% left" when a dollar count is
  // taken for a percentage. The percent is computed here; dollars go where
  // magpie shows counts.
  const left = dollars(bal.quota);
  const spent = dollars(bal.used);
  const whole = dollars(bal.total);
  const usedPct = whole > 0 ? Math.min(100, Math.max(0, (spent / whole) * 100)) : 0;
  const remainingPct = Math.max(0, 100 - usedPct);

  return {
    plan: bal.name || undefined,
    balance: `$${left.toFixed(2)}`,
    windows: [
      {
        name: "Balance",
        used: Math.round(usedPct * 10) / 10,
        remaining: Math.round(remainingPct * 10) / 10,
        amount: spent,
        limit: whole,
        unit: "usd",
        display: `$${left.toFixed(2)} / $${whole.toFixed(2)}`,
      },
    ],
  };
}

// A completed login and a confirmed reward are different results.
function checkinResult(checkedIn) {
  if (checkedIn === true) return { outcome: "claimed", message: "AgentRouter：站点确认本次登录签到成功，新增额度已到账" };
  if (checkedIn === false) return { outcome: "done", message: "AgentRouter：已完成登录，站点返回本次未新增签到额度（checked_in=false）" };
  return { outcome: "failed", message: "AgentRouter：登录成功但站点未返回有效签到标记，无法确认额度发放" };
}

// checkinOf claims the day's credit the only way this site grants one: by
// signing in with the account's username and password. The site has no
// /api/user/checkin — that path falls through to New API's admin route
// /api/user/:id and answers every ordinary account "权限不足", the same as
// /api/user/foo would — and its front end says "签到成功，新增额度已到账"
// when a login response carries checked_in. So signing in *is* the check-in.
//
// What comes back is `claimed` when this sign-in granted the day, and `done`
// when the site explicitly reports no new grant (not proof of an earlier one). A
// wrong password is the account's to fix and settles for the day; a site
// that is down is retried, as magpie retries any `failed`.
async function checkinOf(getAuth, provider) {
  const auth = await getAuth();
  if (!auth) return { outcome: "failed", message: "AgentRouter：尚未登录" };
  const r = await signIn(provider, auth);
  if (!r.ok) {
    if (r.why === "no-password") {
      return { outcome: "ineligible", message: "AgentRouter：账号里没有站点用户名和密码，无法登录签到" };
    }
    if (r.why === "bad-password") {
      return {
        outcome: "ineligible",
        message: `AgentRouter：站点拒绝了登录，请核对账号里的用户名和密码（站点返回「${r.message ?? r.why}」）`,
        signIn: "expired",
      };
    }
    if (r.blocked) {
      return { outcome: "failed", message: "AgentRouter：登录接口被站点验证码拦截，稍后重试" };
    }
    return { outcome: "failed", message: `AgentRouter：登录失败（${r.why}）` };
  }
  return checkinResult(r.checkedIn);
}

// declaredModels is the models this plugin vouches for, in the shape magpie
// wants: a fresh object each time, because magpie edits what it is given.
function declaredModels() {
  const out = {};
  for (const [id, name] of Object.entries(DECLARED_MODELS)) out[id] = { ...MODEL_SHAPE, name };
  return out;
}

// modelsOf asks the vendor for the models this account has. It is the same
// list every agent sees, and the vendor keeps it current.
async function modelsOf(provider, { auth } = {}) {
  // The fallback is this plugin's own list, never the row's: the row may
  // still carry models a cached models.dev catalog gave it, and handing those
  // back would advertise models the site no longer serves.
  const fallback = declaredModels();
  if (!auth) return fallback;
  const key = apiKey(auth);
  if (!key) return fallback;
  try {
    const res = await fetch(`${apiBase(provider, auth)}/models`, {
      headers: applyHeaders(new Headers(), { ...headersOf(provider, auth), Authorization: `Bearer ${key}` }),
      signal: withTimeout(REQUEST_TIMEOUT),
    });
    const { json } = await jsonOrText(res);
    if (!res.ok || !Array.isArray(json?.data)) return fallback;
    const out = {};
    for (const m of json.data) {
      if (!m?.id) continue;
      out[m.id] = {
        ...MODEL_SHAPE,
        name: m.name ?? m.display_name ?? m.id,
        limit: {
          context: Number(m.context_length ?? m.context_window ?? MODEL_SHAPE.limit.context) || MODEL_SHAPE.limit.context,
          output: Number(m.max_output_tokens ?? m.max_tokens ?? MODEL_SHAPE.limit.output) || MODEL_SHAPE.limit.output,
        },
        ...(m.supported_endpoint_types?.length ? { endpoints: m.supported_endpoint_types } : {}),
        // The vendor says "openai" for what is its Responses API; the gateway
        // reads that as the protocol the model speaks.
        responses: true,
      };
    }
    return Object.keys(out).length ? out : fallback;
  } catch {
    return fallback;
  }
}

export const AgentRouterAuthPlugin = async (input) => {
  // The host hands over its reader for the provider's switches; an older one
  // has none, and the Codex headers stay on there (README, "为什么需要自定义
  // 请求头"). Reading it through a closure keeps headersOf's own signature —
  // provider and account — which every caller already passes.
  codexHeaders = () => input?.magpie?.option?.(PROVIDER, "send-codex-headers") !== false;
  const portableResponses = () => input?.magpie?.option?.(PROVIDER, "portable-responses") !== false;
  const textFilterEnabled = () => input?.magpie?.option?.(PROVIDER, "text-filter") !== false;
  return {
    // The provider before anyone signs in: the models the vendor serves, so the
    // row has something to show, and the shape each listed one takes.
    //
    // The vendor's models answer the Responses API only: a chat-completions
    // request is refused with "does not support /v1/chat/completions, please use
    // /v1/responses", whatever the key. So the provider speaks Responses, and
    // the gateway translates an agent's Chat or Anthropic request into it.
    config: async (cfg) => {
      cfg.provider ??= {};
      cfg.provider[PROVIDER] ??= {
        name: "AgentRouter",
        npm: "@ai-sdk/openai",
        api: `${ENDPOINT}/v1`,
        models: declaredModels(),
      };
    },

    auth: {
      provider: PROVIDER,

      // The site account signs in with the username and password the user
      // entered; the login session then reads the account's existing model
      // key, which is what completions take. No other sign-in method is
      // offered, and no credential ships in the source.
      methods: [
        {
          type: "api",
          label: "账号密码登录",
          authorize: async (inputs) => {
            const username = String(inputs?.username ?? "").trim();
            const password = String(inputs?.password ?? "");
            if (!username || !password) return { type: "failed", error: "请输入站点账号和密码。" };
            const keyId = String(inputs?.modelKeyId ?? "").trim();
            const keyIdError = modelKeyIdProblem(keyId);
            if (keyIdError) return { type: "failed", error: keyIdError };
            const auth = { metadata: { username, password, site: "air" } };
            let login;
            try {
              login = await signIn({}, auth);
            } catch {
              return { type: "failed", error: "登录请求失败或超时，请检查网络后重试。" };
            }
            if (!login.ok) {
              if (login.why === "bad-password") return { type: "failed", error: "站点拒绝了登录，请核对用户名和密码后重试。" };
              if (login.blocked) return { type: "failed", error: "登录接口被站点验证码拦截，请稍后重试。" };
              return { type: "failed", error: "登录失败，站点未接受请求，请稍后重试。" };
            }
            const id = String(login.id ?? "");
            if (!login.session || !/^[1-9][0-9]*$/.test(id)) {
              return { type: "failed", error: "登录成功但站点未返回会话或用户 ID，无法读取模型 Key，请稍后重试。" };
            }
            let found;
            try {
              found = await storedKeyOf(ENDPOINT, { cookie: "session=" + login.session }, id, keyId);
            } catch {
              return { type: "failed", error: "读取模型 Key 时请求失败或超时，请重试。" };
            }
            if (found.kind !== "found") {
              const extra = found.kind === "ambiguous" || found.kind === "incomplete"
                ? "。可在「模型 Key ID」中填写目标 Key 的 ID 后重新登录"
                : "。请确认账号下存在启用的模型 Key 后重试";
              return { type: "failed", error: keyProblem(found.kind) + extra + "。" };
            }
            return {
              type: "success",
              key: found.key,
              metadata: {
                site: "air",
                apiBase: `${ENDPOINT}/v1`,
                username,
                password,
                userId: id,
                cookie: "session=" + login.session,
              },
            };
          },
          prompts: [USERNAME_PROMPT, PASSWORD_PROMPT, {
            type: "text",
            key: "modelKeyId",
            message: "模型 Key ID（可选：站点「令牌」页 ID 列的纯数字值）",
            validate: modelKeyIdProblem,
          }],
        },
      ],

      // Inline replay avoids resource-local item lookups when complete contents
      // are present. Server-only references and unknown kinds stay untouched.
      // Response normalization preserves successful bytes and never retries.
      async loader(getAuth, provider) {
        const auth = (await getAuth()) ?? {};
        const textFilter = textFilterEnabled() ? await loadTextFilter() : null;
        const base = apiBase(provider, auth);
        return {
          baseURL: base,
          apiKey: apiKey(auth) || "agentrouter",
          async fetch(input, init = {}) {
            const key = apiKey(auth);
            if (!usableModelKey(key)) {
              return Response.json({ error: {
                type: "invalid_request_error",
                code: "agentrouter_missing_api_key",
                message: "尚未配置模型 API Key，请使用账号密码登录入口重新登录以读取模型 Key。站点密码和登录会话不能用于模型调用。",
              } }, { status: 400 });
            }
            const h = new Headers(input instanceof Request ? input.headers : undefined);
            new Headers(init.headers ?? {}).forEach((v, k) => h.set(k, v));
            applyHeaders(h, headersOf(provider, auth));
            if (key) h.set("Authorization", `Bearer ${key}`);
            const requestInit = { ...init, headers: h };
            const prepared = await prepareRequest(input, requestInit, {
              portableResponses: portableResponses(),
              textFilter: textFilterEnabled() ? textFilter : null,
            });
            return explainResponse(await fetch(input, prepared));
          },
        };
      },

      usage: usageOf,
      checkin: checkinOf,

      // Switches the user can turn on the provider's editor.
      options: [
        {
          key: "text-filter",
          label: "Filter configured prose before sending",
          default: true,
          description: "Uses content-filter.local.json; no guessed terms. Preserves recognized Markdown code, tool data and encrypted state. Reload after editing rules.",
        },
        {
          key: "portable-responses",
          label: "Replay complete Responses items inline",
          description: "Remove resource-local IDs only when inline content is available; preserve call_id and encrypted content. Reference-only history still requires the original resource. Off disables ID replay only; text-filter is independent.",
          default: true,
        },
        {
          key: "send-codex-headers",
          label: "Send the Codex client headers",
          description:
            "AgentRouter's gateway only answers clients it recognises. On, requests are sent as a Codex CLI's; off, only the headers you gave are sent.",
          default: true,
        },
      ],
    },

    provider: {
      id: PROVIDER,
      models: modelsOf,
    },

    // A conversation's turns reach the vendor under one id, so its cache sees
    // them as one conversation.
    "chat.headers": async (input, output) => {
      if (input?.model?.providerID !== PROVIDER && input?.provider?.info?.id !== PROVIDER) return;
      if (input.sessionID) output.headers["x-session-id"] = input.sessionID;
    },
  };
};

export default AgentRouterAuthPlugin;
export const _internal = {
  PROVIDER,
  DEFAULT_HEADERS,
  DECLARED_MODELS,
  parseHeaders,
  parseCookies,
  headersOf,
  applyHeaders,
  apiBase,
  siteBase,
  userHeaders,
  masked,
  isURLish,
  declaredModels,
};
