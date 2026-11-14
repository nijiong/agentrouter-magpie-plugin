// Default origin; explicit endpoint/apiBase/siteURL overrides remain supported.
export const ENDPOINT = "https://ps.air-outer.com";

// What the vendor's own clients send. codex_cli_rs is what its gateway
// admits; the rest are the headers a Codex CLI sends beside it.
export const DEFAULT_HEADERS = {
  "User-Agent": "codex_cli_rs/0.101.0",
  Accept: "application/json",
};

// How many model keys one list read covers. A count at the page size means
// the list was cut, not that the account has that many.
const MODEL_KEY_PAGE_SIZE = 50;

export const REQUEST_TIMEOUT = 30_000;

export function withTimeout(ms) {
  return AbortSignal.timeout(ms);
}

// parseHeaders turns the one-header-per-line text an account keeps into an
// object. A line is "Name: value"; blank lines and lines starting with #
// are skipped, so a block copied out of a browser's devtools works as it
// is. A name repeated keeps its last value, as a Headers object would.
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
// The Codex User-Agent is the client the gateway admits; a user with another
// working one overrides it in their own header block.
export function headersOf(provider, auth) {
  return {
    "User-Agent": DEFAULT_HEADERS["User-Agent"],
    Accept: DEFAULT_HEADERS.Accept,
    ...modelHeaders(provider),
    ...parseHeaders(provider?.headers),
    ...parseHeaders(headersText(auth)),
  };
}

// applyHeaders sets headers on a Headers object, dropping any whose value is
// empty so a user can take one off by clearing it.
export function applyHeaders(h, extra) {
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
export function isURLish(v) {
  return /^https?:\/\/\S+$/i.test(String(v ?? "").trim());
}

// apiBase is the base completions go to. It follows the account's own
// endpoint when it gave one, and otherwise the endpoint this plugin was built
// for: ps.air-outer.com.
//
// A stored endpoint that isn't a URL is ignored rather than used: the
// request then still goes to the vendor, which is what the account wanted
// when it pasted a key there.
export function apiBase(provider, auth) {
  const said = String(meta(auth, "endpoint") ?? provider?.endpoint ?? "").trim();
  if (isURLish(said)) return `${said.replace(/\/+$/, "")}/v1`;
  const base = String(meta(auth, "apiBase") ?? "").trim();
  if (base) return base.replace(/\/+$/, "");
  return `${ENDPOINT}/v1`;
}

// siteBase resolves balance/check-in routes, including an explicit siteURL override.
export function siteBase(provider, auth) {
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
export function apiKey(auth) {
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
export function parseCookies(text) {
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

// selectModelKeys turns one list read into the usable keys, deduplicated
// by the key itself and kept in list order. One key needs no choice;
// several are listed for the user to pick from.
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

// Read the account's existing keys once using the session from password login.
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
  const balance = quotaBalance(d);
  // `checked_in: true` means the site reported a new grant for *this* sign-in.
  // A false or missing marker changes nothing about the login itself: the site
  // counts the completed sign-in as the day's check-in either way.
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

// Read /api/user/self with either an access token or a browser session.
export async function balanceByToken(provider, auth) {
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
    const balance = quotaBalance(json.data ?? {});
    if (!balance) return { ok: false, why: "no-quota" };
    return { ok: true, balance };
  } catch (e) {
    return { ok: false, why: `unreachable: ${e?.message ?? String(e)}` };
  }
}

// These endpoints report cumulative consumption, never remaining credit.
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
      // A failed user read must not prevent the independent key fallback.
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
