import assert from "node:assert/strict";
import { test } from "node:test";
import plugin from "../src/index.mjs";

const raw = (body, headers = {}) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json", ...headers } });
// Magpie's failed() adapter consumes error, not message.
function hostFailed(r) {
  const why = typeof r?.error === "string" ? r.error.trim() : r?.error instanceof Error ? r.error.message : "";
  return why ? { ok: false, error: why.slice(0, 500) } : { ok: false };
}
async function stubFetch(responses, fn) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    assert.ok(responses.length, "unexpected request");
    const response = responses.shift();
    if (response instanceof Error) throw response;
    return response;
  };
  try { return await fn(calls); } finally { globalThis.fetch = original; }
}
const loginResponses = () => [
  raw({ success: true, data: { id: 42, checked_in: true } }, { "Set-Cookie": "session=synthetic-site; Path=/; HttpOnly" }),
  raw({ success: true, data: { items: [{ status: 1, key: "synthetic-api-key" }] } }),
];
const twoKeys = () => [
  loginResponses()[0],
  raw({ success: true, data: { items: [{ status: 1, key: "synthetic-one", name: "first" }, { status: 1, key: "synthetic-two", name: "second" }] } }),
];

test("first login collects account and password, then offers a key choice only when needed", async () => {
  const p = await plugin({ magpie: {} });
  assert.deepEqual(p.auth.methods.map(m => m.type), ["api"]);
  const method = p.auth.methods[0];
  assert.deepEqual(method.prompts.map(p => p.key), ["username", "password"]);
  assert.equal(method.prompts[0].type, "text");
  assert.equal(method.prompts[1].type, "password");
  assert.equal(method.prompts[0].validate("site-user"), undefined);
  assert.ok(method.prompts[0].validate(" "));
  assert.equal(method.prompts[1].validate("site-pass"), undefined);
  assert.ok(method.prompts[1].validate(""));
  assert.equal(typeof method.ask, "function");
  assert.deepEqual(await method.ask(undefined), method.prompts[0]);
  assert.deepEqual(await method.ask({ username: "site-user" }), method.prompts[1]);
});

test("ask lists several keys by name and masked key, once per sign-in", async () => {
  const method = (await plugin()).auth.methods[0];
  await stubFetch(twoKeys(), async calls => {
    const inputs = { username: "site-user", password: "site-pass" };
    const choice = await method.ask(inputs);
    assert.equal(choice.type, "select");
    assert.equal(choice.key, "modelKeyIndex");
    assert.deepEqual(choice.options.map(o => o.value), ["0", "1"]);
    assert.ok(choice.options.every(o => o.label.includes("…")));
    assert.ok(choice.options[0].label.includes("first"));
    assert.ok(choice.options[1].label.includes("second"));
    for (const secret of ["synthetic-one", "synthetic-two", "site-pass"]) {
      assert.ok(!JSON.stringify(choice).includes(secret));
    }
    // Repeated asks (a redraw or retry) reuse the one login and list read.
    assert.deepEqual(await method.ask(inputs), choice);
    assert.equal(calls.length, 2);
    assert.equal(await method.ask({ ...inputs, modelKeyIndex: "1" }), null);
    assert.equal(calls.length, 2);
    const result = await method.authorize({ ...inputs, modelKeyIndex: "1" });
    assert.equal(result.type, "success");
    assert.equal(result.key, "synthetic-two");
    assert.equal(calls.length, 2);
  });
});

test("ask asks no key question when the account has a single usable key", async () => {
  const method = (await plugin()).auth.methods[0];
  await stubFetch(loginResponses(), async calls => {
    const inputs = { username: "site-user", password: "site-pass" };
    assert.equal(await method.ask(inputs), null);
    const result = await method.authorize(inputs);
    assert.equal(result.type, "success");
    assert.equal(result.key, "synthetic-api-key");
    assert.equal(calls.length, 2);
  });
});

test("ask stops at a refused login without asking anything further", async () => {
  const method = (await plugin()).auth.methods[0];
  await stubFetch([raw({ success: false, message: "用户名或密码错误" })], async calls => {
    const inputs = { username: "site-user", password: "site-pass" };
    assert.equal(await method.ask(inputs), null);
    const result = await method.authorize(inputs);
    assert.equal(result.type, "failed");
    assert.match(result.error, /核对用户名和密码/);
    assert.equal(calls.length, 1);
  });
});

test("password sign-in rejects missing credentials locally without a request", async () => {
  const method = (await plugin()).auth.methods[0];
  await stubFetch([], async calls => {
    for (const inputs of [undefined, null, {}, { username: "", password: "x" }, { username: "x", password: "" }, { username: " ", password: " " }]) {
      const result = await method.authorize(inputs);
      assert.equal(result.type, "failed");
      assert.match(hostFailed(result).error, /账号和密码/);
      assert.equal("key" in result, false);
    }
    assert.equal(calls.length, 0);
  });
});

test("password sign-in saves the session, account and a usable model key", async () => {
  const method = (await plugin()).auth.methods[0];
  await stubFetch(loginResponses(), async calls => {
    const inputs = { username: "  site-user  ", password: "site-pass", headers: "X-Private: ignored" };
    const result = await method.authorize(inputs);
    assert.equal(result.type, "success");
    assert.equal(result.key, "synthetic-api-key");
    assert.deepEqual(result.metadata, {
      site: "air",
      apiBase: "https://ps.air-outer.com/v1",
      username: "site-user",
      password: "site-pass",
      userId: "42",
      cookie: "session=synthetic-site",
    });
    assert.ok(calls.every(c => c.url.startsWith("https://ps.air-outer.com/")));
    assert.equal(calls[0].url, "https://ps.air-outer.com/api/user/login");
    assert.equal(JSON.parse(calls[0].init.body).username, "site-user");
    assert.equal(new Headers(calls[1].init.headers).get("Cookie"), "session=synthetic-site");
    assert.equal(new Headers(calls[1].init.headers).get("New-Api-User"), "42");
    assert.ok(!new Headers(calls[1].init.headers).has("Authorization"));
  });
});

test("password sign-in failures never echo credentials or save a key", async () => {
  const method = (await plugin()).auth.methods[0];
  for (const [response, said] of [
    [raw({ success: false, message: "用户名或密码错误" }), "核对用户名和密码"],
    [raw({ success: true, data: { id: 42 } }), "会话"],
    [new Response("<!doctype html><html>synthetic-private</html>"), "验证码"],
    [new Error("synthetic-private boom"), "登录"],
  ]) {
    await stubFetch([response], async calls => {
      const result = await method.authorize({ username: "site-user", password: "synthetic-private" });
      assert.equal(result.type, "failed");
      assert.match(hostFailed(result).error, new RegExp(said));
      assert.ok(!hostFailed(result).error.includes("synthetic-private"));
      assert.equal("key" in result, false);
      assert.equal(calls.length, 1);
    });
  }
});

test("password sign-in key-read failures never echo the session or save a key", async () => {
  const method = (await plugin()).auth.methods[0];
  for (const [response, said] of [
    [raw({ success: true, data: { items: [] } }), "未找到"],
    [raw({ success: false, message: "synthetic-private rejected" }), "拒绝"],
    [new Response("<html>synthetic-private</html>", { status: 403 }), "验证页"],
  ]) {
    await stubFetch([loginResponses()[0], response], async calls => {
      const result = await method.authorize({ username: "site-user", password: "site-pass" });
      assert.equal(result.type, "failed");
      assert.match(hostFailed(result).error, new RegExp(said));
      assert.ok(!hostFailed(result).error.includes("synthetic-private"));
      assert.equal("key" in result, false);
      assert.equal(calls.length, 2);
    });
  }
});

test("without a choice among several keys the sign-in fails asking to pick one", async () => {
  const method = (await plugin()).auth.methods[0];
  await stubFetch(twoKeys(), async calls => {
    const result = await method.authorize({ username: "site-user", password: "site-pass" });
    assert.equal(result.type, "failed");
    assert.match(hostFailed(result).error, /选择/);
    assert.equal("key" in result, false);
    assert.equal(calls.length, 2);
  });
});

test("an out-of-range or malformed key choice fails without saving a key", async () => {
  const method = (await plugin()).auth.methods[0];
  for (const modelKeyIndex of ["2", "-1", "1.5", "abc", "../other", ""]) {
    await stubFetch(twoKeys(), async calls => {
      const result = await method.authorize({ username: "site-user", password: "site-pass", modelKeyIndex });
      assert.equal(result.type, "failed");
      assert.match(hostFailed(result).error, /所选模型 Key 无效/);
      assert.equal("key" in result, false);
      assert.equal(calls.length, 2);
    });
  }
});

test("the first key is taken when the choice answers 0", async () => {
  const method = (await plugin()).auth.methods[0];
  await stubFetch(twoKeys(), async calls => {
    const result = await method.authorize({ username: "site-user", password: "site-pass", modelKeyIndex: "0" });
    assert.equal(result.type, "success");
    assert.equal(result.key, "synthetic-one");
    assert.equal(calls.length, 2);
  });
});
