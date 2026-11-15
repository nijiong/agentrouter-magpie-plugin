import { balanceByToken, signIn, spendOf, quotaRate } from "./site-client.mjs";

// 先试只读用户接口，再试密码登录；两者都未给出完整额度时保留失败原因。
async function balance(provider, auth) {
  const viaToken = await balanceByToken(provider, auth);
  if (viaToken.ok) return viaToken;
  const viaLogin = await signIn(provider, auth);
  if (viaLogin.ok && viaLogin.balance) return { ok: true, balance: viaLogin.balance };
  if (viaLogin.ok) return { ok: false, why: "no-quota" };
  // 报告用户能据以处置的原因：密码错误优先于验证码；缺少密码时，令牌路径的失败才是真正原因。
  if (viaLogin.why === "bad-password") return { ok: false, why: "expired", expired: true, message: viaLogin.message };
  if (viaLogin.why !== "no-password") return viaLogin;
  return viaToken;
}

// 用文本状态表达部分数据：magpie 无法展示不带百分比的消耗窗口，
// 且消耗绝不应当成余额，也不应生成虚假的 0% 使用条。
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
  // 站点默认以 1/500000 美元计数。
  const rate = quotaRate(provider);
  const dollars = (n) => Math.round((n / rate) * 100) / 100;

  // New API 字段，按站点面板的标注：
  //   quota      当前余额
  //   used_quota 历史消耗
  //   两者之和   账号获得的总额度
  // magpie 的窗口只按百分比取 Used 与 Remaining，故这里不声明该窗口的金额计数
  // （Amount/Limit/Unit 或货币形式的 "x / y" display）：凡是同时给出金额计数的窗口，
  // magpie 都会按自己的读数逐日累计，并在卡片上显示「每天花掉的金额」。
  // 剩余金额改由 `balance` 表达，卡片按账号余额显示；窗口只表达占比。
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
      },
    ],
  };
}

// 签到即登录：站点把成功登录计为当日签到，登录被接受当日即告完成。
// `checked_in` 只表示站点是否额外报告了新增额度。
function checkinResult(checkedIn) {
  if (checkedIn === true) return { outcome: "claimed", message: "AgentRouter：签到完成（已重新登录），站点确认新增额度已到账" };
  if (checkedIn === false) return { outcome: "done", message: "AgentRouter：签到完成（已重新登录），站点返回本次未新增额度（checked_in=false）" };
  return { outcome: "done", message: "AgentRouter：签到完成（已重新登录）；站点未返回签到标记，是否新增额度以站点账号为准" };
}

// checkinOf 按该站点唯一的计法完成签到：用账号密码再次登录。站点没有
// /api/user/checkin——该路径会落到 New API 的管理路由 /api/user/:id，对普通账号一律
// 回「权限不足」——且其每日额度在登录时发放。因此被站点接受的登录*即*完成的签到，
// 无论响应是否带 checked_in；该标记只是额外确认。
//
// 返回 `claimed` 表示站点报告了新增额度，`done` 表示登录完成但未报告。
// 密码错误属账号自身可修，当日即定论；站点故障可重试，与 magpie 对 `failed` 的处理一致。
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
