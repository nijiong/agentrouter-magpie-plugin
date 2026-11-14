import assert from "node:assert/strict";

export async function withFetch(routes, action) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const call = { url, init, headers: new Headers(init.headers) };
    calls.push(call);
    assert.ok(routes.length, "unexpected request: " + url.href);
    const response = routes.shift();
    if (response instanceof Error) throw response;
    return typeof response === "function" ? response(call) : response;
  };
  try { return await action(calls); }
  finally { globalThis.fetch = original; }
}
