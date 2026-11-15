import { ENDPOINT, signIn, storedKeyOf } from "./site-client.mjs";

// 唯一的登录方式要求账号与密码。源码不含任何内置凭据：两者由用户输入，宿主保存
// authorize 的返回值。登录表单使用 ps.air-outer.com；旧地址覆盖只作用于已存账号/provider 配置。
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

// signInState 保存提问阶段的登录，按已给出的答案索引。ask() 先于 authorize 运行，
// 且可能对同一组答案重复运行（重绘、重试），故一次登录只登录一次、只读一次列表。
// 条目短时有效，authorize 取用后即删；其中凭据不离开本模块。
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

// listingOf 针对一组答案登录并读取账号 Key，只算一次。结果或来自登录本身
// （{ok:false,…}），或来自 storedKeyOf 的判定；无论如何每次登录只计算一次。
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

// loginProblem 把失败的登录表述给用户，绝不回显站点响应正文（其中可能含凭据）。
function loginProblem(login) {
  if (login.why === "bad-password") return "站点拒绝了登录，请核对用户名和密码后重试。";
  if (login.blocked) return "登录接口被站点验证码拦截，请稍后重试。";
  if (login.why === "no-session") return "登录成功但站点未返回会话或用户 ID，无法读取模型 Key，请稍后重试。";
  if (login.why === "key-network") return "读取模型 Key 时请求失败或超时，请重试。";
  if (String(login.why ?? "").startsWith("unreachable")) return "登录请求失败或超时，请检查网络后重试。";
  return "登录失败，站点未接受请求，请稍后重试。";
}

// ask 是登录自身的提问（magpie 的 method hook）：先账号密码，随后仅当账号有多把可用 Key 时
// 在其中选一，按名称与掩码 Key 列出；单把无需提问。不支持的宿主回落到 prompts 与 authorize，
// 仍会取用唯一 Key，或对不明确的列表拒绝。
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

// masked 让值不出现在消息里：Key 或令牌绝不进入用户可见的错误信息或日志。
export function masked(v) {
  const s = String(v ?? "");
  if (s.length <= 8) return s ? "…" : "";
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

// keyRef 是登录选择器中一把 Key 的展示：名称与掩码 Key，绝不显示 Key 本身。
// 选项值是其列表序号，故答案也不携带凭据。
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
