import { balanceByToken, signIn, spendOf, quotaRate } from "./site-client.mjs";

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

// magpie cannot show a percent-free consumption window. Use its text status
// for partial data so spend never becomes a balance or an invented 0% window.
export async function usageOf(getAuth, provider) {
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

// The check-in is the login: the site counts a successful sign-in as the
// day's check-in, so an accepted login settles the day on its own.
// `checked_in` only says whether the site reported a new grant on top of it.
function checkinResult(checkedIn) {
  if (checkedIn === true) return { outcome: "claimed", message: "AgentRouter：签到完成（已重新登录），站点确认新增额度已到账" };
  if (checkedIn === false) return { outcome: "done", message: "AgentRouter：签到完成（已重新登录），站点返回本次未新增额度（checked_in=false）" };
  return { outcome: "done", message: "AgentRouter：签到完成（已重新登录）；站点未返回签到标记，是否新增额度以站点账号为准" };
}

// checkinOf checks the day in the only way this site counts one: by signing
// in again with the account's username and password. The site has no
// /api/user/checkin — that path falls through to New API's admin route
// /api/user/:id and answers every ordinary account "权限不足", the same as
// /api/user/foo would — and its daily credit is granted at sign-in. So a
// login the site accepts *is* the completed check-in, whether or not the
// response carries checked_in; that marker is only extra confirmation.
//
// What comes back is `claimed` when the site reports a new grant and `done`
// when the login completed without one. A wrong password is the account's to
// fix and settles for the day; a site that is down is retried, as magpie
// retries any `failed`.
export async function checkinOf(getAuth, provider) {
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
