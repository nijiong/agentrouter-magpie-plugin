import { ENDPOINT, signIn, storedKeyOf } from "./site-client.mjs";

// The single sign-in method asks for the account's username and password.
// No credential is baked into the source: the user types both, and the host
// saves what authorize returned. The sign-in form uses ps.air-outer.com;
// legacy address overrides apply only to stored account/provider configuration.
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

// signInState holds the logins the sign-in questions have started, keyed by
// the answers given so far. ask() runs before authorize and may run again
// for the same answers (a redraw, a retry), so one sign-in logs in once and
// reads the key list once. Entries are short-lived and dropped as soon as
// authorize takes them; the secrets they hold never leave this module.
const SIGN_IN_TTL = 10 * 60_000;
const SIGN_IN_MAX = 16;
const pendingSignIns = new Map();

function signInState(inputs) {
  const username = String(inputs?.username ?? "").trim();
  const password = String(inputs?.password ?? "");
  const now = Date.now();
  for (const [k, v] of pendingSignIns) {
    if (now - v.at > SIGN_IN_TTL) pendingSignIns.delete(k);
  }
  const key = JSON.stringify([username, password]);
  let state = pendingSignIns.get(key);
  if (!state) {
    while (pendingSignIns.size >= SIGN_IN_MAX) {
      pendingSignIns.delete(pendingSignIns.keys().next().value);
    }
    state = { at: now, username, password, listing: null };
    pendingSignIns.set(key, state);
  }
  state.at = now;
  return state;
}

// listingOf signs in and reads the account's keys once for one set of
// answers. The result is the login's own ({ok:false,…}) or storedKeyOf's
// verdict; either way it is computed a single time per sign-in.
function listingOf(state) {
  state.listing ??= (async () => {
    const auth = { metadata: { username: state.username, password: state.password, site: "air" } };
    let login;
    try {
      login = await signIn({}, auth);
    } catch {
      return { ok: false, why: "network" };
    }
    if (!login.ok) return login;
    const id = String(login.id ?? "");
    if (!login.session || !/^[1-9][0-9]*$/.test(id)) return { ok: false, why: "no-session" };
    let found;
    try {
      found = await storedKeyOf(ENDPOINT, "session=" + login.session, id);
    } catch {
      return { ok: false, why: "key-network" };
    }
    return { ...found, login, id };
  })();
  return state.listing;
}

// loginProblem words a failed sign-in for the user, never echoing the
// site's own response text (it may carry credentials).
function loginProblem(login) {
  if (login.why === "bad-password") return "站点拒绝了登录，请核对用户名和密码后重试。";
  if (login.blocked) return "登录接口被站点验证码拦截，请稍后重试。";
  if (login.why === "no-session") return "登录成功但站点未返回会话或用户 ID，无法读取模型 Key，请稍后重试。";
  if (login.why === "key-network") return "读取模型 Key 时请求失败或超时，请重试。";
  if (String(login.why ?? "").startsWith("unreachable")) return "登录请求失败或超时，请检查网络后重试。";
  return "登录失败，站点未接受请求，请稍后重试。";
}

// ask is the sign-in's own questioning (magpie's method hook): the account
// and password first, then — only when the account has several usable
// keys — one choice among them, listed by name and masked key. A single
// key needs no question. Hosts without the hook fall back to prompts and
// authorize, which still take the only key or refuse an unclear list.
async function askSignIn(inputs) {
  const given = inputs ?? {};
  if (!("username" in given)) return USERNAME_PROMPT;
  if (!("password" in given)) return PASSWORD_PROMPT;
  const state = signInState(given);
  if (!state.username || !state.password) return null;
  const listed = await listingOf(state);
  if (listed.ok === false || listed.kind !== "found" || listed.items.length <= 1) return null;
  if ("modelKeyIndex" in given) return null;
  return {
    type: "select",
    key: "modelKeyIndex",
    message: "账号下有多把模型 Key，选择要使用的一把",
    options: listed.items.map((item, i) => ({ label: keyRef(item, i), value: String(i) })),
  };
}

// masked keeps a value out of a message: a key or a token never goes into
// an error the user sees or a log line.
export function masked(v) {
  const s = String(v ?? "");
  if (s.length <= 8) return s ? "…" : "";
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

// keyRef is how one key is shown in the sign-in picker: its name and
// masked key, never the key itself. The choice's value is its place in
// the listed order, so the answer carries no credential either.
function keyRef(item, index) {
  const name = String(item?.name ?? "").trim();
  return `#${index + 1} ${name ? name + " · " : ""}${masked(item?.key)}`;
}

function keyProblem(kind) {
  const messages = {
    badChoice: "所选模型 Key 无效，请重新登录并选择",
    missing: "未找到启用且完整的模型 Key",
    incomplete: "模型 Key 列表可能不完整，无法列出全部候选",
    rejected: "站点拒绝读取模型 Key，请检查登录会话及权限",
    blocked: "读取模型 Key 时遇到站点验证页",
    unsupported: "站点返回的模型 Key 列表格式无法确认",
    upstream: "站点暂时无法提供模型 Key 列表",
    network: "读取模型 Key 的网络请求失败或超时",
  };
  return messages[kind] ?? "无法读取模型 Key";
}

async function authorizeSignIn(inputs) {
  const username = String(inputs?.username ?? "").trim();
  const password = String(inputs?.password ?? "");
  if (!username || !password) return { type: "failed", error: "请输入站点账号和密码。" };
  const state = signInState(inputs);
  const listed = await listingOf(state);
  pendingSignIns.delete(JSON.stringify([username, password]));
  if (listed.ok === false) return { type: "failed", error: loginProblem(listed) };
  if (listed.kind !== "found") {
    const extra = listed.kind === "missing"
      ? "。请确认账号下存在启用的模型 Key 后重试"
      : "。请稍后重新登录";
    return { type: "failed", error: keyProblem(listed.kind) + extra + "。" };
  }
  let chosen = listed.items[0];
  if (listed.items.length > 1) {
    const raw = String(inputs?.modelKeyIndex ?? "").trim();
    const index = Number(raw);
    if (!/^[0-9]+$/.test(raw) || !Number.isInteger(index) || index < 0 || index >= listed.items.length) {
      return { type: "failed", error: listed.items.length > 1 && !("modelKeyIndex" in (inputs ?? {}))
        ? "账号下有多把模型 Key，请在登录时选择要使用的一把后重试。"
        : keyProblem("badChoice") + "。" };
    }
    chosen = listed.items[index];
  }
  return {
    type: "success",
    key: chosen.key,
    metadata: {
      site: "air",
      apiBase: `${ENDPOINT}/v1`,
      username,
      password,
      userId: listed.id,
      cookie: "session=" + listed.login.session,
    },
  };
}

export function signInMethod() {
  return {
    type: "api",
    label: "账号密码登录",
    ask: askSignIn,
    authorize: authorizeSignIn,
    prompts: [USERNAME_PROMPT, PASSWORD_PROMPT],
  };
}
