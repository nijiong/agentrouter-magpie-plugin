import { explainResponse } from "./response.mjs";
import { prepareRequest } from "./request.mjs";
import { loadTextFilter } from "./content-filter.mjs";
import {
  ENDPOINT, DEFAULT_HEADERS, REQUEST_TIMEOUT, parseHeaders, parseCookies,
  headersOf, applyHeaders, apiBase, siteBase, userHeaders, isURLish, apiKey,
  usableModelKey, jsonOrText, withTimeout,
} from "./site-client.mjs";
import { signInMethod, masked } from "./sign-in.mjs";
import { usageOf, checkinOf } from "./account-services.mjs";

const PROVIDER = "agentrouter";

// Models are listed by the vendor, so this is only what to show before a
// sign-in and the shape (limits, tool calls) each listed model takes.
const MODEL_SHAPE = {
  name: undefined,
  limit: { context: 300000, output: 128000 },
  tool_call: true,
  reasoning: true,
};

// The models this plugin itself ships, by the name to show them under. They
// are what the row lists before the vendor's own list arrives — and what it
// falls back to when that list cannot be read.
//
// magpie also keeps a models.dev catalog, and its cached entry for this
// vendor still carries models the site has retired (see README, "模型列表从
// 哪来"). Falling back to the row's current models would re-advertise them,
// so the fallback is built from this table instead: a model shown here is one
// this plugin vouches for.
const DECLARED_MODELS = {
  "gpt-5.6-sol": "GPT-5.6 Sol",
  "gpt-6-astra": "GPT-6 Astra",
  "gpt-6.1-sol": "GPT-6.1 Sol",
};

// declaredModels is the models this plugin vouches for, in the shape magpie
// wants: a fresh object each time, because magpie edits what it is given.
function declaredModels() {
  const out = {};
  for (const [id, name] of Object.entries(DECLARED_MODELS)) out[id] = { ...MODEL_SHAPE, name };
  return out;
}

// modelsOf asks the vendor for the models this account has. It is the same
// list every agent sees, and the vendor keeps it current.
async function modelsOf(provider, { auth } = {}) {
  // The fallback is this plugin's own list, never the row's: the row may
  // still carry models a cached models.dev catalog gave it, and handing those
  // back would advertise models the site no longer serves.
  const fallback = declaredModels();
  if (!auth) return fallback;
  const key = apiKey(auth);
  if (!key) return fallback;
  try {
    const res = await fetch(`${apiBase(provider, auth)}/models`, {
      headers: applyHeaders(new Headers(), { ...headersOf(provider, auth), Authorization: `Bearer ${key}` }),
      signal: withTimeout(REQUEST_TIMEOUT),
    });
    const { json } = await jsonOrText(res);
    if (!res.ok || !Array.isArray(json?.data)) return fallback;
    const out = {};
    for (const m of json.data) {
      if (!m?.id) continue;
      out[m.id] = {
        ...MODEL_SHAPE,
        name: m.name ?? m.display_name ?? m.id,
        limit: {
          context: Number(m.context_length ?? m.context_window ?? MODEL_SHAPE.limit.context) || MODEL_SHAPE.limit.context,
          output: Number(m.max_output_tokens ?? m.max_tokens ?? MODEL_SHAPE.limit.output) || MODEL_SHAPE.limit.output,
        },
        ...(m.supported_endpoint_types?.length ? { endpoints: m.supported_endpoint_types } : {}),
        // The vendor says "openai" for what is its Responses API; the gateway
        // reads that as the protocol the model speaks.
        responses: true,
      };
    }
    return Object.keys(out).length ? out : fallback;
  } catch {
    return fallback;
  }
}

export const AgentRouterAuthPlugin = async (input) => {
  // The host hands over its reader for the provider's switches; an older one
  // has none, and both body options stay on there.
  const portableResponses = () => input?.magpie?.option?.(PROVIDER, "portable-responses") !== false;
  const textFilterEnabled = () => input?.magpie?.option?.(PROVIDER, "text-filter") !== false;
  return {
    // The provider before anyone signs in: the models the vendor serves, so the
    // row has something to show, and the shape each listed one takes.
    //
    // The vendor's models answer the Responses API only: a chat-completions
    // request is refused with "does not support /v1/chat/completions, please use
    // /v1/responses", whatever the key. So the provider speaks Responses, and
    // the gateway translates an agent's Chat or Anthropic request into it.
    config: async (cfg) => {
      cfg.provider ??= {};
      cfg.provider[PROVIDER] ??= {
        name: "AgentRouter",
        npm: "@ai-sdk/openai",
        api: `${ENDPOINT}/v1`,
        models: declaredModels(),
      };
    },

    auth: {
      provider: PROVIDER,

      // The site account signs in with the username and password the user
      // entered; the login session then reads the account's existing model
      // keys. One key is taken as is; several are offered by ask() as a
      // choice, and the picked one is saved. No other sign-in method is
      // offered, and no credential ships in the source.
      methods: [signInMethod()],

      // Inline replay avoids resource-local item lookups when complete contents
      // are present. Server-only references and unknown kinds stay untouched.
      // Response normalization preserves successful bytes and never retries.
      async loader(getAuth, provider) {
        const auth = (await getAuth()) ?? {};
        const textFilter = textFilterEnabled() ? await loadTextFilter() : null;
        const base = apiBase(provider, auth);
        return {
          baseURL: base,
          apiKey: apiKey(auth) || "agentrouter",
          async fetch(input, init = {}) {
            const key = apiKey(auth);
            if (!usableModelKey(key)) {
              return Response.json({ error: {
                type: "invalid_request_error",
                code: "agentrouter_missing_api_key",
                message: "尚未配置模型 API Key，请使用账号密码登录入口重新登录以读取模型 Key。站点密码和登录会话不能用于模型调用。",
              } }, { status: 400 });
            }
            const h = new Headers(input instanceof Request ? input.headers : undefined);
            new Headers(init.headers ?? {}).forEach((v, k) => h.set(k, v));
            applyHeaders(h, headersOf(provider, auth));
            if (key) h.set("Authorization", `Bearer ${key}`);
            const requestInit = { ...init, headers: h };
            const prepared = await prepareRequest(input, requestInit, {
              portableResponses: portableResponses(),
              textFilter: textFilterEnabled() ? textFilter : null,
            });
            return explainResponse(await fetch(input, prepared));
          },
        };
      },

      usage: usageOf,
      checkin: checkinOf,

      // Switches the user can turn on the provider's editor. The words are
      // Chinese beside the English maps, so magpie shows them in the
      // window's own language (options' labels/descriptions).
      options: [
        {
          key: "text-filter",
          label: "发送前过滤配置的文本",
          labels: { zh: "发送前过滤配置的文本", en: "Filter configured prose before sending" },
          default: true,
          description: "使用 content-filter.local.json 词表，不猜测词条；保留识别出的 Markdown 代码、工具数据与加密状态。编辑规则后需重新加载插件。",
          descriptions: { zh: "使用 content-filter.local.json 词表，不猜测词条；保留识别出的 Markdown 代码、工具数据与加密状态。编辑规则后需重新加载插件。", en: "Uses content-filter.local.json; no guessed terms. Preserves recognized Markdown code, tool data and encrypted state. Reload after editing rules." },
        },
        {
          key: "portable-responses",
          label: "内联回放完整的 Responses 消息",
          labels: { zh: "内联回放完整的 Responses 消息", en: "Replay complete Responses items inline" },
          description: "仅在内联正文完整时移除资源本地 ID；保留 call_id 与加密内容。只有服务端引用的历史仍需原资源。关闭仅停用 ID 回放，文本过滤独立生效。",
          descriptions: { zh: "仅在内联正文完整时移除资源本地 ID；保留 call_id 与加密内容。只有服务端引用的历史仍需原资源。关闭仅停用 ID 回放，文本过滤独立生效。", en: "Remove resource-local IDs only when inline content is available; preserve call_id and encrypted content. Reference-only history still requires the original resource. Off disables ID replay only; text-filter is independent." },
          default: true,
        },
      ],
    },

    provider: {
      id: PROVIDER,
      models: modelsOf,
    },

    // A conversation's turns reach the vendor under one id, so its cache sees
    // them as one conversation.
    "chat.headers": async (input, output) => {
      if (input?.model?.providerID !== PROVIDER && input?.provider?.info?.id !== PROVIDER) return;
      if (input.sessionID) output.headers["x-session-id"] = input.sessionID;
    },
  };
};

export default AgentRouterAuthPlugin;
export const _internal = {
  PROVIDER,
  DEFAULT_HEADERS,
  DECLARED_MODELS,
  parseHeaders,
  parseCookies,
  headersOf,
  applyHeaders,
  apiBase,
  siteBase,
  userHeaders,
  masked,
  isURLish,
  declaredModels,
};
