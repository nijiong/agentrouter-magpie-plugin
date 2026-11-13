import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import plugin from "../index.mjs";

const modelKey = "synthetic-model-key";
const entry = (key = modelKey, extra = {}) => ({ status: 1, key, ...extra });
const json = (data, headers = {}) => new Response(JSON.stringify(data), { headers: { "content-type": "application/json", ...headers } });

async function withFetch(routes, fn) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: new URL(String(url)), init, headers: new Headers(init.headers) });
    assert.ok(routes.length, "unexpected request: " + String(url));
    return routes.shift()(calls.at(-1));
  };
  try { return await fn(calls); } finally { globalThis.fetch = original; }
}

const loginRoute = (data = { id: 42, checked_in: true }) => ({ headers }) => {
  assert.equal(headers.get("authorization"), null);
  return json({ success: true, data }, { "set-cookie": "session=login-session; Path=/; HttpOnly" });
};
const keyListRoute = (payload) => ({ headers, url }) => {
  assert.equal(url.pathname, "/api/token/");
  assert.equal(headers.get("cookie"), "session=login-session");
  assert.equal(headers.get("new-api-user"), "42");
  if (payload instanceof Error) throw payload;
  if (typeof payload === "string") return new Response(payload, { status: 200 });
  return json(payload);
};

test("onboarding offers only the password sign-in", async () => {
  const p = await plugin({ magpie: {} });
  assert.deepEqual(p.auth.methods.map(m => m.type), ["api"]);
  const method = p.auth.methods[0];
  assert.equal(method.label, "账号密码登录");
  assert.deepEqual(method.prompts.map(p => p.key), ["username", "password", "modelKeyId"]);
  assert.equal(method.prompts[0].type, "text");
  assert.equal(method.prompts[1].type, "password");
  assert.equal(Object.hasOwn(method.prompts[0], "default"), false);
  assert.equal(Object.hasOwn(method.prompts[1], "default"), false);
});

test("no credential is baked into the shipped source", async () => {
  const source = await readFile(new URL("../index.mjs", import.meta.url), "utf8");
  assert.equal(/DEFAULT_CREDENTIALS/.test(source), false);
  assert.equal(/799834852@qq\.com|nijiong123/.test(source), false);
  const method = (await plugin({ magpie: {} })).auth.methods[0];
  for (const prompt of method.prompts) {
    assert.equal(Object.hasOwn(prompt, "default"), false, `${prompt.key} must not carry a default`);
  }
});

test("missing model Key fails locally without forwarding SDK placeholder or management credentials", async t => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({ ok: true }); };
  t.after(() => { globalThis.fetch = original; });
  const p = await plugin({ magpie: { options: () => ({ "text-filter": false, "portable-responses": false }) } });
  for (const auth of [null, undefined, {}, { type: "api", key: "", metadata: { accessToken: "private-management-token" } }]) {
    const loader = await p.auth.loader(async () => auth);
    const request = new Request("https://ps.air-outer.com/v1/responses", { method: "POST", headers: { Authorization: "Bearer agentrouter", "Content-Type": "application/json" }, body: JSON.stringify({ model: "test", input: "hi" }) });
    const result = await loader.fetch(request);
    assert.equal(calls, 0);
    assert.equal(request.bodyUsed, false);
    assert.equal(result.status, 400);
    const text = await result.text();
    assert.equal(JSON.parse(text).error.code, "agentrouter_missing_api_key");
    assert.ok(!text.includes("private-"));
  }
});
for (const [label, payload] of [
  ["data.items", { data: { items: [entry()] } }],
  ["data array", { data: [entry()] }],
  ["skips empty first key", { data: { items: [entry("  "), entry()] } }],
  ["deduplicates trimmed keys", { data: { items: [entry(" " + modelKey), entry(modelKey + " ")] } }],
  ["skips disabled keys", { data: { items: [entry("disabled", { status: 2 }), entry()] } }],
  ["skips expired keys", { data: { items: [entry("expired", { expired_time: 1 }), entry(modelKey, { expired_time: -1 })] } }],
  ["explicit complete page", { data: { total: 10, items: [...Array.from({ length: 9 }, () => entry("")), entry()] } }],
]) {
  test("password sign-in chooses the unique known valid key: " + label, async () => {
    const p = await plugin({ magpie: {} });
    await withFetch([loginRoute(), keyListRoute(payload)], async calls => {
      const result = await p.auth.methods[0].authorize({ username: "site-user", password: "site-pass" });
      assert.equal(result.type, "success", JSON.stringify(result));
      assert.equal(result.key, modelKey);
      assert.equal(result.metadata.userId, "42");
      assert.equal(result.metadata.cookie, "session=login-session");
      assert.equal(result.metadata.username, "site-user");
      assert.equal(result.metadata.password, "site-pass");
      assert.equal(calls.length, 2);
      assert.equal(calls[0].url.pathname, "/api/user/login");
      assert.equal(calls[0].init.method, "POST");
    });
  });
}

for (const [label, payload, status = 200] of [
  ["empty list", { data: { items: [] } }],
  ["disabled only", { data: { items: [entry(modelKey, { status: 2 })] } }],
  ["missing active status", { data: { items: [{ key: modelKey }] } }],
  ["expired only", { data: { items: [entry(modelKey, { expired_time: 1 })] } }],
  ["SDK placeholder", { data: { items: [entry("agentrouter")] } }],
  ["documentation placeholder", { data: { items: [entry("YOUR_API_KEY")] } }],
  ["masked key", { data: { items: [entry("sk-****")] } }],
  ["multiple different keys", { data: { items: [entry(), entry("another-real-key")] } }],
  ["page may be truncated", { data: { items: Array.from({ length: 50 }, () => entry()) } }],
  ["explicit additional page", { data: { total: 2, items: [entry()] } }],
  ["invalid total", { data: { total: "1", items: [entry()] } }],
  ["unknown structure", { items: [entry()] }],
  ["business failure", { success: false, message: "synthetic-site-secret", data: { items: [entry()] } }],
  ["HTTP auth failure", { data: { items: [entry()] } }, 401],
  ["HTTP forbidden", { data: { items: [entry()] } }, 403],
  ["invalid JSON", "synthetic-site-secret"],
  ["HTML verification", "<!doctype html>synthetic-site-secret", 403],
  ["network error", new Error("synthetic-site-secret")],
]) {
  test("password sign-in fails without saving a key: " + label, async () => {
    const p = await plugin({ magpie: {} });
    await withFetch([loginRoute(), () => {
      if (payload instanceof Error) throw payload;
      if (typeof payload === "string") return new Response(payload, { status });
      return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
    }], async () => {
      const result = await p.auth.methods[0].authorize({ username: "site-user", password: "site-pass" });
      assert.equal(result.type, "failed");
      assert.equal(typeof result.error, "string");
      assert.equal("key" in result, false);
      assert.ok(!JSON.stringify(result).includes("synthetic-site-secret"));
    });
  });
}

test("password sign-in rejects bad credentials before reading keys", async () => {
  const p = await plugin({ magpie: {} });
  await withFetch([() => json({ success: false, message: "用户名或密码错误" })], async calls => {
    const result = await p.auth.methods[0].authorize({ username: "someone", password: "wrong" });
    assert.equal(result.type, "failed");
    assert.match(result.error, /核对用户名和密码/);
    assert.equal(calls.length, 1);
  });
});
