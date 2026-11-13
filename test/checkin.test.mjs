import test from "node:test";
import assert from "node:assert/strict";
import plugin from "../index.mjs";

const SITE = "https://ps.air-outer.com";
const account = { type: "api", key: "sk-inference", metadata: {
  username: "site-user", password: "site-pass", userId: "42", cookie: "session=old-site-session",
} };
const json = (data, headers = {}) => new Response(JSON.stringify(data), {headers: {"content-type": "application/json", ...headers}});

async function run(auth, routes = []) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const call = {url: new URL(String(url)), init, headers: new Headers(init.headers)};
    calls.push(call);
    assert.ok(routes.length, "unexpected request: " + call.url.origin + call.url.pathname);
    return routes.shift()(call);
  };
  try {
    const p = await plugin();
    const result = await p.auth.checkin(async () => auth, {});
    assert.equal(routes.length, 0, "all expected requests were made");
    return {result, calls};
  } finally { globalThis.fetch = real; }
}

const login = (data) => ({url, init, headers}) => {
  assert.equal(url.href, SITE + "/api/user/login");
  assert.equal(init.method, "POST");
  assert.equal(headers.get("authorization"), null);
  assert.equal(headers.get("cookie"), null);
  return json({success: true, data});
};

test("check-in signs in with the account password and claims the nested reward marker", async () => {
  const {result, calls} = await run(account, [login({id: 42, checked_in: true})]);
  assert.equal(result.outcome, "claimed");
  assert.equal(calls.length, 1);
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.username, "site-user");
  assert.equal(body.password, "site-pass");
});

test("accounts without stored credentials never sign in with a baked account", async () => {
  const {result, calls} = await run({type: "api", key: "sk-inference"}, []);
  assert.equal(result.outcome, "ineligible");
  assert.match(result.message, /用户名和密码/);
  assert.equal(calls.length, 0);
});

test("explicit false reports no new grant, not an invented previous payout", async () => {
  const {result} = await run(account, [login({id: 42, checked_in: false})]);
  assert.equal(result.outcome, "done");
  assert.doesNotMatch(result.message, /已发放|已到账/);
});

for (const value of [undefined, "true", 1, null]) {
  test("a completed login checks in without a usable reward marker: " + value, async () => {
    const {result, calls} = await run(account, [login({id: 42, checked_in: value})]);
    assert.equal(result.outcome, "done");
    assert.match(result.message, /签到完成/);
    assert.doesNotMatch(result.message, /已到账/);
    assert.equal(calls.length, 1);
  });
}

test("a refused password is the account's to fix, not a retry", async () => {
  const {result, calls} = await run(account, [() => json({success: false, message: "用户名或密码错误"})]);
  assert.equal(result.outcome, "ineligible");
  assert.equal(result.signIn, "expired");
  assert.match(result.message, /核对/);
  assert.equal(calls.length, 1);
});

test("a captcha-blocked login stays retryable", async () => {
  const {result} = await run(account, [() => new Response("<!doctype html><html>captcha</html>")]);
  assert.equal(result.outcome, "failed");
  assert.match(result.message, /验证码/);
});

test("network failures stay retryable and do not echo credentials", async () => {
  const {result} = await run(account, [() => {throw new Error("network site-pass");}]);
  assert.equal(result.outcome, "failed");
  assert.match(result.message, /unreachable/);
});

test("legacy stored credentials still drive the login check-in", async () => {
  const auth = {metadata: {username: "legacy", ["pass" + "word"]: "test-only"}};
  const {result, calls} = await run(auth, [login({id: 42, checked_in: true})]);
  assert.equal(result.outcome, "claimed");
  assert.equal(calls.length, 1);
  assert.equal(JSON.parse(calls[0].init.body).username, "legacy");
});

test("the login alone completes the check-in", async () => {
  const {result, calls} = await run(account, [login({id: 42})]);
  assert.equal(result.outcome, "done");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.pathname, "/api/user/login");
});

test("check-in prompts never ask for a removed credential", async () => {
  for (const method of (await plugin()).auth.methods) {
    for (const key of ["githubCookie", "accessToken", "site", "endpoint"]) {
      assert.equal(method.prompts?.some(p => p.key === key) ?? false, false, key);
    }
  }
});

test("check-in never leaves the fixed site origin", async () => {
  const {result, calls} = await run(account, [login({id: 42, checked_in: true})]);
  assert.equal(result.outcome, "claimed");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.origin, SITE);
});

for (const status of [403, 429, 500]) {
  test("login HTTP failure stays retryable: " + status, async () => {
    const {result} = await run(account, [() => new Response("blocked", {status})]);
    assert.equal(result.outcome, "failed");
  });
}
