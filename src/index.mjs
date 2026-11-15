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

// 模型由厂商列出，这里只是在登录前展示的内容及每个列出模型的形状（上下文、工具调用）。
const MODEL_SHAPE = {
  name: undefined,
  limit: { context: 300000, output: 128000 },
  tool_call: true,
  reasoning: true,
};

// 本插件自带并在其名下展示的模型：厂商列表到达前展示它们，读取失败时回退到它们。
//
// magpie 也保有 models.dev 目录，其缓存的该厂商条目仍含站点已下架的模型（见 README
// “模型列表从哪来”）。回退若沿用行上的模型会把它们重新上架，因此回退改由本表构建：
// 出现在这里的模型即本插件背书的模型。
const DECLARED_MODELS = {
  "gpt-5.6-sol": "GPT-5.6 Sol",
  "gpt-6-astra": "GPT-6 Astra",
  "gpt-6.1-sol": "GPT-6.1 Sol",
};

// declaredModels 返回本插件背书的模型，形状符合 magpie 要求：每次都新建对象，
// 因为 magpie 会修改交给它的对象。
function declaredModels() {
  const out = {};
  for (const [id, name] of Object.entries(DECLARED_MODELS)) out[id] = { ...MODEL_SHAPE, name };
  return out;
}

// modelsOf 向厂商询问该账号可用的模型：这是所有 agent 看到的同一份列表，由厂商保持最新。
async function modelsOf(provider, { auth } = {}) {
  // 回退用本插件自己的列表，绝不用行上的：行上可能仍带着 models.dev 缓存给出的模型，
  // 交回去等于宣传站点已不再提供的模型。
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
        // 厂商对其 Responses API 报作 "openai"，网关据此理解该模型所说的协议。
        responses: true,
      };
    }
    return Object.keys(out).length ? out : fallback;
  } catch {
    return fallback;
  }
}

export const AgentRouterAuthPlugin = async (input) => {
  // 宿主交出读取 provider 开关的读取器；旧宿主没有，两个正文选项在那里都保持开启。
  const portableResponses = () => input?.magpie?.option?.(PROVIDER, "portable-responses") !== false;
  const textFilterEnabled = () => input?.magpie?.option?.(PROVIDER, "text-filter") !== false;
  return {
    // 登录前的 provider：列出厂商提供的模型让行上先有内容，并给出每个列出模型的形状。
    //
    // 厂商的模型只应答 Responses API：无论 key 为何，chat-completions 请求都会被拒并提示
    // "does not support /v1/chat/completions, please use /v1/responses"。因此 provider 说
    // Responses，由网关把 agent 的 Chat 或 Anthropic 请求转换过来。
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

      // 站点账号用用户输入的用户名与密码登录，登录会话随后只读读取账号已有模型 Key：
      // 一把直接取用，多把由 ask() 列出供选并将所选保存。不提供其他登录方式，源码不含凭据。
      methods: [signInMethod()],

      // 内联回放：在正文完整时避免按资源本地条目查找。仅服务端引用与未知类型保持原样。
      // 响应归一化保留成功字节，且从不重试。
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

      // 用户在 provider 编辑器中可切换的开关：中文文案与英文映射并存，
      // 由 magpie 按窗口语言展示（options 的 labels/descriptions）。
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

    // 同一会话的轮次以同一个 id 到达厂商，其缓存因此把它们视为同一会话。
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
