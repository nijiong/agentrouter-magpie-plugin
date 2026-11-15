import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentRouterAuthPlugin } from '../src/index.mjs';
import { headersOf } from '../src/site-client.mjs';

const plugin = await AgentRouterAuthPlugin();
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

const apiMethod = (p) => p.auth.methods.find((m) => m.type === 'api');

test('password sign-in requires credentials and offers no other method', async () => {
  assert.deepEqual(plugin.auth.methods.map((m) => m.type), ['api']);
  const method = plugin.auth.methods[0];
  const result = await method.authorize({ username: '  ', password: '' });
  assert.equal(result.type, 'failed');
  assert.match(result.error, /账号和密码/);
});

test('password sign-in saves the login session and reads the existing key', async () => {
  const method = plugin.auth.methods[0];
  const original = globalThis.fetch;
  const calls = [];
  const responses = [
    new Response(JSON.stringify({ success: true, data: { id: 123, checked_in: true } }), {
      headers: { 'Set-Cookie': 'session=example; Path=/; HttpOnly' },
    }),
    json({ success: true, data: { items: [{ status: 1, key: 'sk-example' }] } }),
  ];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), ...init });
    assert.ok(responses.length, `Unexpected request: ${url}`);
    return responses.shift();
  };
  try {
    const result = await method.authorize({ username: '  site-user  ', password: 'site-pass' });
    assert.equal(result.type, 'success');
    assert.equal(result.metadata.username, 'site-user');
    assert.equal(result.metadata.password, 'site-pass');
    assert.equal(result.metadata.cookie, 'session=example');
    assert.equal(result.metadata.userId, '123');
    assert.equal(result.key, 'sk-example');
    assert.equal(calls[0].url, 'https://ps.air-outer.com/api/user/login');
    assert.equal(new Headers(calls[1].headers).get('Cookie'), 'session=example');
    assert.equal(new Headers(calls[1].headers).get('New-Api-User'), '123');
    assert.ok(calls.every((call) => !call.url.includes('/api/user/token')));
  } finally {
    globalThis.fetch = original;
  }
});

test('Endpoint onboarding is absent and a previously misplaced key stays ignored', async () => {
  assert.deepEqual(apiMethod(plugin).prompts.map(p => p.key), ["username", "password"]);

  const { calls } = await readUsage(
    { key: 'sk-example', metadata: { endpoint: 'sk-example', username: 'example', password: 'example' } },
    [json({ success: false, message: 'refused' }), json({ total_usage: 0 })],
  );
  assert.equal(calls[1].url, 'https://ps.air-outer.com/v1/dashboard/billing/usage');
});

test('The Codex headers are always sent unless the user overrides them', async () => {
  // 网关只放行自家客户端，故 Codex User-Agent 是默认值而非开关；有可用其他标识的用户
  // 可在自己的请求头块中覆盖。
  assert.equal(headersOf({}, {})['User-Agent'], 'codex_cli_rs/0.101.0');
  assert.equal(headersOf({}, {}).Accept, 'application/json');
  assert.equal(
    headersOf({}, { metadata: { headers: 'User-Agent: mine' } })['User-Agent'],
    'mine',
  );

  // 旧宿主完全不提供读取器，默认值相同。
  await AgentRouterAuthPlugin();
  assert.equal(headersOf({}, {})['User-Agent'], 'codex_cli_rs/0.101.0');
});

test('A retired model is never advertised back, whichever path lists it', async () => {
  // magpie 缓存的 models.dev 该厂商条目仍列出站点已下架的模型；厂商列表读不到时插件回以
  // 自己的列表，因此这些名字无法经它回来。
  const retired = ['claude-opus-5', 'claude-opus-4-8', 'deepseek-v4-flash', 'glm-5.3'];
  const config = {};
  await plugin.config(config);
  const declared = Object.keys(config.provider.agentrouter.models);
  assert.deepEqual(declared, ['gpt-5.6-sol', 'gpt-6-astra', 'gpt-6.1-sol']);
  for (const id of retired) assert.ok(!declared.includes(id), `${id} must not be declared`);

  // 尚无账号：无法询问厂商列表，行上保留插件的列表而非行自身的。
  const row = { models: { 'claude-opus-5': { name: 'x' }, 'gpt-6-astra': { name: 'y' } } };
  const listed = await plugin.provider.models(row);
  for (const id of retired) assert.ok(!(id in listed), `${id} must not be listed`);

  // 厂商拒绝提供列表：答案相同，仍是插件的列表。
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('nope', { status: 500 });
  try {
    const fell = await plugin.provider.models(row, { auth: { key: 'sk-example' } });
    assert.deepEqual(Object.keys(fell), declared);
  } finally {
    globalThis.fetch = original;
  }
});

test('A content-filter refusal is explained, not left looking like a rate limit', async () => {
  // 厂商过滤器对被拒文本回 400 content-blocked；等待或重试都无法解除，若 agent 把它
  // 当成暂时性网关故障，会一直重复同一段文本、耗尽预算。
  const original = globalThis.fetch;
  const blocked = JSON.stringify({
    error: {
      code: 'content-blocked',
      message: 'content-blocked (request id: abc)',
      type: 'agent_router_api_error',
    },
  });
  globalThis.fetch = async () =>
    new Response(blocked, { status: 400, headers: { 'content-type': 'application/json' } });
  try {
    const p = await AgentRouterAuthPlugin();
    const loader = await p.auth.loader(async () => ({ key: 'sk-example' }), {});
    const res = await loader.fetch('https://ps.air-outer.com/v1/responses', {
      method: 'POST',
      body: '{}',
    });
    const text = await res.text();
    assert.equal(res.status, 400);
    assert.match(text, /content-blocked/);
    assert.match(text, /内容过滤器/);
    assert.match(text, /改写/);

    // magpie 靠正文里的 quota / rate-limit 词判断「是否允许其他提供商重试」
    // （fallback.go 的 retryable/quotaWords）。若该说明读起来像其中之一，硬拒绝会被
    // 每个账号重试后故障转移，最终呈现为别的提供商的 429。因此说明中不得含有这些词。
    const quotaWords =
      /quota|insufficient|balance|credit|billing|out of budget|budget (exceeded|exhausted)|exceeded|rate.?limit|usage.?limit|limit.?reached|hit your .*limit|too many requests|overloaded|余额|额度|欠费|限流|频率|套餐|用量|上限/i;
    assert.equal(quotaWords.test(text), false, 'the refusal must not read like a quota error');
  } finally {
    globalThis.fetch = original;
  }
});

test('A token-rate-limit 429 says it is a rate cap with a wait, not a spent account', async () => {
  // 厂商对每分钟 token 上限回 429 且不带 Retry-After，也不说明何时解除。magpie 会在
  // 每个账号上重试（每次重试都继续消耗同一批已计 token）再故障转移，调用方最终看到的
  // 可能是别的提供商的 429。给出「一分钟后再试」并发送 Retry-After，才是调用方能据以行动的信息。
  const original = globalThis.fetch;
  const capped = JSON.stringify({
    message: 'Your requests to gpt-6.1-sol for gpt-6.1-sol in example-region have exceeded token rate limit.',
    type: 'api_error',
  });
  globalThis.fetch = async () =>
    new Response(capped, { status: 429, headers: { 'content-type': 'application/json' } });
  try {
    const p = await AgentRouterAuthPlugin();
    const loader = await p.auth.loader(async () => ({ key: 'sk-example' }), {});
    const res = await loader.fetch('https://ps.air-outer.com/v1/responses', {
      method: 'POST',
      body: '{}',
    });
    assert.equal(res.status, 429);
    assert.equal(res.headers.get('retry-after'), '60');
    const text = await res.text();
    assert.match(text, /gpt-6\.1-sol/);
    assert.match(text, /一分钟后再试/);
    assert.match(text, /不保证届时已恢复/);
    // 这仍是速率限制，magpie 继续按速率限制处理（failRate）。
    assert.match(text, /token rate limit/i);
  } finally {
    globalThis.fetch = original;
  }
});

test('A 429 that is not this cap is passed through untouched', async () => {
  const original = globalThis.fetch;
  const body = JSON.stringify({ error: { code: 'insufficient_quota', message: 'out of quota' } });
  globalThis.fetch = async () =>
    new Response(body, { status: 429, headers: { 'content-type': 'application/json' } });
  try {
    const p = await AgentRouterAuthPlugin();
    const loader = await p.auth.loader(async () => ({ key: 'sk-example' }), {});
    const res = await loader.fetch('https://ps.air-outer.com/v1/responses', {
      method: 'POST',
      body: '{}',
    });
    assert.equal(res.status, 429);
    assert.equal(res.headers.get('retry-after'), null);
    assert.equal(await res.text(), body);
  } finally {
    globalThis.fetch = original;
  }
});

test('Any other refusal is passed through untouched', async () => {
  const original = globalThis.fetch;
  const body = JSON.stringify({ error: { code: 'invalid_api_key', message: 'bad key' } });
  globalThis.fetch = async () =>
    new Response(body, { status: 401, headers: { 'content-type': 'application/json' } });
  try {
    const p = await AgentRouterAuthPlugin();
    const loader = await p.auth.loader(async () => ({ key: 'sk-example' }), {});
    const res = await loader.fetch('https://ps.air-outer.com/v1/responses', {
      method: 'POST',
      body: '{}',
    });
    assert.equal(res.status, 401);
    assert.equal(await res.text(), body);
  } finally {
    globalThis.fetch = original;
  }
});

async function readUsage(auth, responses, provider = {}) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, ...init });
    const response = responses.shift();
    assert.ok(response, `Unexpected request: ${url}`);
    return response;
  };
  try {
    return { usage: await plugin.auth.usage(async () => auth, provider), calls };
  } finally {
    globalThis.fetch = original;
  }
}

test('Cookie-only account reads the remaining balance as a share, with no money counted in the window', async () => {
  const { usage, calls } = await readUsage(
    { metadata: { cookie: 'session=example', userId: '123' } },
    [json({ success: true, data: { quota: 75000000, used_quota: 25000000 } })],
  );
  assert.equal(calls[0].headers.Cookie, 'session=example');
  assert.equal(calls[0].headers['New-Api-User'], '123');
  assert.equal(usage.balance, '$150.00');
  assert.equal(usage.windows[0].used, 25);
  assert.equal(usage.windows[0].remaining, 75);
  // 若窗口在占比之外还给出金额计数，magpie 会逐日累计其读数并显示「每天花掉的金额」；
  // 美元金额改由 `balance` 表达，故窗口中不得出现任何计数。
  for (const field of ['amount', 'limit', 'unit', 'display']) {
    assert.equal(field in usage.windows[0], false, `${field} must not be declared`);
  }
});

test('WAF-blocked balance falls back to account consumption without inventing remaining quota', async () => {
  const { usage, calls } = await readUsage(
    { key: 'sk-example', metadata: { cookie: 'session=example', userId: '123', username: 'example', password: 'example' } },
    [new Response('<!doctype html><html>captcha</html>'), json({ success: false, message: 'refused' }), json({ success: true, data: { quota: 4500000 } })],
  );
  assert.ok(calls[2].url.endsWith('/api/log/self/stat'));
  assert.match(usage.error, /累计消耗 \$9\.00/);
  assert.match(usage.error, /剩余额度未知/);
  assert.equal(usage.balance, undefined);
  assert.deepEqual(usage.windows, []);
});

test('Missing quota fields are not zero balance; key usage is converted from cents', async () => {
  const { usage, calls } = await readUsage(
    { key: 'sk-example', metadata: { accessToken: 'example', userId: '123', endpoint: 'https://relay.example', username: 'example', password: 'example' } },
    [json({ success: true, data: {} }), json({ success: false, message: 'refused' }), json({ success: false }), json({ total_usage: 12345.67 })],
  );
  assert.equal(calls[3].url, 'https://relay.example/v1/dashboard/billing/usage');
  assert.equal(calls[3].headers.Authorization, 'Bearer sk-example');
  assert.match(usage.error, /累计消耗 \$123\.46/);
  assert.equal(usage.balance, undefined);
});

test('Saved account password can report zero consumption without claiming zero balance', async () => {
  const { usage, calls } = await readUsage(
    { key: 'sk-example', metadata: { username: 'example', password: 'example' } },
    [json({ success: false, message: 'refused' }), json({ total_usage: 0 })],
  );
  assert.equal(calls.length, 2);
  assert.ok(calls[0].url.endsWith('/api/user/login'));
  assert.match(usage.error, /累计消耗 \$0\.00/);
  assert.equal(usage.balance, undefined);
  assert.deepEqual(usage.windows, []);
});

test('A key without saved credentials reads consumption without attempting a login', async () => {
  const { usage, calls } = await readUsage({ key: 'sk-example' }, [json({ total_usage: 0 })]);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.endsWith('/v1/dashboard/billing/usage'));
  assert.match(usage.error, /累计消耗 \$0\.00/);
  assert.equal(usage.balance, undefined);
});

test('Successful login without quota does not crash or invent balance', async () => {
  const { usage } = await readUsage(
    { metadata: { username: 'example', password: 'example' } },
    [json({ success: true, data: { checked_in: true } })],
  );
  assert.match(usage.error, /没有返回额度字段/);
  assert.equal(usage.balance, undefined);
});

test('Password login supplies balance when user read is blocked', async () => {
  const { usage } = await readUsage(
    { metadata: { accessToken: 'example', username: 'example', password: 'example' } },
    [new Response('<html>captcha</html>'), json({ success: true, data: { quota: 0, used_quota: 500000, username: 'example' } })],
  );
  assert.equal(usage.balance, '$0.00');
  assert.equal(usage.plan, 'example');
  assert.equal(usage.windows[0].used, 100);
});

test('Malformed account and billing amounts stay unknown', async () => {
  const { usage } = await readUsage(
    { key: 'sk-example', metadata: { cookie: 'session=example', userId: '123' } },
    [json({ success: true, data: { quota: null, used_quota: 1 } }), json({ success: true, data: {} }), json({ data: { quota: null } }), json({ total_usage: -1 })],
  );
  assert.match(usage.error, /没有返回额度字段/);
  assert.equal(usage.balance, undefined);
});
