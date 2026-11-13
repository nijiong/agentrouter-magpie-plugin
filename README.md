# AgentRouter 插件（magpie）

给 magpie 接入 AgentRouter [国内站](https://ps.air-outer.com/)：本定制版仅支持**账号密码登录**（由你手动输入并保存），提供模型调用、余额与用量查询、每日签到，以及**可自定义请求头**。所有请求固定发往 `ps.air-outer.com`。

## 文档导航

- [贡献指南](<CONTRIBUTING.md>)：Issue → PR → 自动检查 → 人工审查。
- [安全政策](<SECURITY.md>)：敏感信息处理与私密漏洞报告。
- [优化设计与升级指南](<docs/OPTIMIZATION.md>)：问题背景、与参考项目的取舍、兼容边界、升级/回滚与本地验证。
- [更新日志](<CHANGELOG.md>)：版本变化与[出处致谢](<CHANGELOG.md#出处与致谢>)。
- [本地签到说明](<LOCAL-CHECKIN.md>)：独立签到工具的使用与安全边界。
- [出处与致谢](<#出处与致谢>)：原始项目、作者与许可。

> 仓库源码更新不等于 npm 发布或你的网关已升级。请按升级指南自行验证；不要把真实 Cookie、访问令牌、私有词表或抓包提交到仓库。

### 本地定制版：账号密码登录，固定国内站

- 仅保留**账号密码登录**一种入口，账号与密码由你手动输入后保存（源码不含任何内置凭据）；移除 API Key、GitHub 授权、系统访问令牌入口与站点选择。
- 所有请求（模型、登录、余额、签到、Key 列表）固定发往 `https://ps.air-outer.com`，国际站 `agentrouter.org` 已移除。
- 登录成功后以会话只读查找账号下已有模型 Key 并保存；签到即密码重新登录，不再需要 GitHub Cookie。
- 作为**独立插件**维护，不跟随上游更新；版本变化见[更新日志](<CHANGELOG.md>)。

## 🚀 快速上手 (Quick Start)

按以下步骤完成插件安装、账号配置与客户端接入；上游账号、网络与宿主版本仍需分别验证：

### 1. 安装插件

本插件是独立维护的定制版，**未发布到 npm registry**，请使用下方源码安装。包名 `opencode-agentrouter-auth` 仅用于本地包标识，不代表 registry 上存在同名可用版本。

#### Docker 源码安装

**源码安装与 npm 安装二选一，不要重复注册。** 克隆后核对提交及包版本为预期版本，更新已有目录前先备份；最终以宿主实际加载版本为准，不能仅凭本地文件已更新判断升级成功。

将插件源码放入 magpie 配置卷中的本地插件目录：
```bash
# 假设 magpie 配置卷挂在宿主机 $VOL（按你的实际部署路径修改）
VOL=/path/to/magpie/config          # 替换为你自己的配置卷路径

mkdir -p "$VOL/magpie/local-plugins"
git clone https://github.com/nijiong/agentrouter-magpie-plugin.git "$VOL/magpie/local-plugins/agentrouter"
chown -R 65532:65532 "$VOL/magpie/local-plugins/agentrouter"   # 仅修改本插件；uid/gid 按镜像实际情况修改

# 在 magpie 容器中加载插件
docker exec magpie magpie plugin add /config/magpie/local-plugins/agentrouter
```

#### 本地 / 原生进程源码安装
```bash
git clone https://github.com/nijiong/agentrouter-magpie-plugin.git
magpie plugin add /path/to/agentrouter-magpie-plugin
```

---

### 2. 登录并绑定账号（本地定制版）

本定制版只保留**账号密码登录**一种方式，且所有请求固定发往国内站 `https://ps.air-outer.com`（已移除国际站 agentrouter.org、API Key、GitHub 授权与系统访问令牌入口）。登录表单的账号与密码均为空，需你本人输入自己的站点账号；两者必填，留空会在发起任何请求前被拒绝。也可按下文手动配置 `username` / `password`。

```bash
docker exec -it magpie magpie plugin login agentrouter
# 非 Docker 环境直接运行：magpie plugin login agentrouter
```

登录流程：**站点账号 → 站点密码 →（多把 Key 时）模型 Key ID**。插件以账号密码调用 `POST /api/user/login`，用返回的登录会话只读查找账号下已有的模型 Key（候选须启用、非空、未掩码、未过期；多把时按填写的 Key ID 读取），随成功认证保存模型 Key 与会话。模型调用本身只认模型 Key，密码与会话不能用于 `/v1` 请求。

- 插件不创建、轮换或修改任何 Key；没有唯一候选时不代选、不补页、不重试，也不以空 key 宣告成功。
- 保存凭据 ≠ 模型验证可用；按下一节运行模型测试。
- 站点每日额度在**登录时**发放，签到 hook 与本地工具同样以账号密码登录完成，不再需要 GitHub Cookie。

---

### 3. 测试与验证

保存凭据后分别验证模型与账号数据；宿主“已登录”只说明认证记录已保存，不是模型可用性证明：

```bash
# 1. 测试模型对话是否正常响应
docker exec magpie magpie provider test agentrouter
# 成功时输出类似：✓ responses  3469 ms · gpt-6-astra

# 2. 查看已识别并激活的模型列表
docker exec magpie magpie provider models agentrouter

# 3. 可选：已配置账号数据凭据时检查额度与用量（不是模型验证）
docker exec magpie magpie quota agentrouter
```

---

### 4. 在客户端中调用

在任何兼容 OpenAI 接口的客户端（如 Chatbox、NextChat、OpenCode、Cherry Studio、Cursor 等）中配置：

- **API 接口地址 (Base URL)**：`https://你的-magpie-域名/v1`（本地直连填 `http://localhost:3425/v1`）
- **API Key**：你在 magpie 中配置的 Caller Key（网关访问密钥）
- **模型名称**：
  - `agentrouter/gpt-5.6-sol`
  - `agentrouter/gpt-6-astra`
  - `agentrouter/gpt-6.1-sol`
  （或你在 magpie 中配置的统一全局模型名称）

> 💡 **请求头说明**：AgentRouter 网关强制校验客户端标识（User-Agent 白名单）。本插件**默认已自动附带官方兼容的客户端请求头**，日常在任意客户端发起调用均无需做任何额外请求头配置。

---

## 登录与高级配置边界

| 方式（唯一） | 首次需要填写 | 保存后的边界 |
|---|---|---|
| **账号密码登录** | 站点账号、站点密码（均需手动输入）、可选的模型 Key ID | 登录成功后只读查找唯一已有模型 key；密码与会话不能用于模型调用 |

所有请求固定发往 `https://ps.air-outer.com`；本定制版已移除国际站与其他登录入口。

余额与签到的既有能力继续保留。需要高级配置时，先备份，再按下文 [手动配置格式](<#手动配置文件格式plugin-authjson>) 维护既有账号 metadata；这些不是额外登录方式或必填问题：

- `username` / `password`：你本人的站点账号与密码；两者必填，留空时登录、签到与余额回落到密码登录都会被本地拒绝。
- `cookie` + `userId`：登录会话读取账号余额；不保证通过 WAF。
- `endpoint` / `apiBase` / `headers`：保留既有端点与请求头能力（默认均为 ps.air-outer.com）。

**当前插件选项仅支持布尔开关，没有新增 Cookie 设置页或任意文本选项。** 不要把凭据粘贴到布尔选项；高级字段只能通过已有宿主能力或下文的手动配置路径维护。

## 签到：账号密码重新登录

AgentRouter 的每日签到由**服务端按登录计算**：登录接口成功返回即算完成当日签到。因此签到 hook 的动作就是**重新调用登录接口** —— 以账号密码 `POST /api/user/login`，登录成功即签到完成，不需要（站点也没有）独立的签到接口。余额查询成功不等于签到；不再需要 GitHub Cookie，也不向 github.com 发起任何请求。

登录响应里的 `checked_in` 只是附加信息，用于区分本次登录是否**新增额度**，不作为签到是否完成的判定条件：字段缺失或为 `false` 时签到同样已完成。

密码为高权限凭据：网关部署时保存在服务器的 `plugin-auth.json`，本机工具保存在 `credentials.txt`（明文、ACL 收紧）。像保护密码一样保护这些文件，不要发到聊天、工单、截图或 Git。

### 结果含义

| 结果 | 证据与含义 |
|---|---|
| `claimed` | 登录成功，且响应返回 `data.checked_in === true`：签到完成，站点确认本次新增额度 |
| `done` | 登录成功即签到完成；`checked_in` 为 `false` 或未返回时归此类，只表示未确认新增额度 |
| `failed` | 登录未成功（网络异常、站点错误、验证码拦截等），签到未完成，允许重试 |
| `ineligible` | 未保存账号密码，或站点拒绝凭据、需要人工恢复等，需要修改账号配置 |

修改凭据后可手动签到立即验证，不必等下一天。

## 余额与累计消耗

读取顺序：

1. 有 Cookie 或访问令牌时，带用户 ID 请求 `GET /api/user/self`，读取 `quota`（剩余）和 `used_quota`（累计消耗）。
2. 失败后，有站点用户名密码则 `POST /api/user/login`，尝试从登录响应读取同样的字段。
3. 仍无余额时，尝试 `GET /api/log/self/stat`，读取账号累计消耗。
4. 再失败则用 API 密钥请求 `/v1/dashboard/billing/usage`，将 `total_usage` 的美分换成美元。

只有前两条返回完整额度字段时才显示余额和使用比例。缺字段不会当成零。只读到消耗时，插件返回“累计消耗 $…；剩余额度未知”，不会把消耗计入余额，也不会生成虚假的 0% 使用条。

magpie 可能在查询失败时保留上次成功的额度，并标记旧读取时间（`asOf`）。这种余额是历史数据，不能当成刚查到的实时余额；没有历史读数的账号会直接显示上述状态提示。

`/api/user/self` 常返回 HTTP 200 的阿里云滑动验证码 HTML，偶尔放行。有效 Cookie 也可能被拦；复制浏览器 Cookie 后不保证服务器可以读取。插件不自动破解滑块。

`/api/token/` 的 `remain_quota` 是单把令牌的限额，不是账号余额；无限令牌的该值可能为负。`/api/log/self/stat` 和 billing usage 只有消耗，不能用于推算余额。

## 为什么需要自定义请求头

AgentRouter 的网关只回应它认识的客户端 —— 白名单里是它**自家客户端**的标识。同一个 key：

| User-Agent | 结果 |
|---|---|
| `codex_cli_rs/0.101.0` | `200` |
| 浏览器（Chrome / Mobile Safari 的完整 UA） | `401 unauthorized client detected` |
| `curl/8.0` | `401 unauthorized client detected` |
| 空（删掉） | `401` |

**这条只管模型网关**（`/v1/models`、`/v1/responses`）。站点自己的路由（`/api/...`）不看这个头，浏览器 UA 也一样能用；反过来，`codex_cli_rs` 也不会帮忙过滑动验证码。

所以请求头在这里不是装饰，是**决定成败**的东西。插件默认发 Codex CLI 的头，可通过开关和以下配置层控制：

- **开关**（provider 编辑器里的 `Send the Codex client headers`）：默认开。关掉后不再发默认的 Codex 标识，只发你自己给的头 —— 适合你已经有别的可用标识时。
- **模型配置层**：宿主传入的 `provider.models[*].headers` 对象（provider 编辑器可在模型配置中保存这些头）
- **provider 级**：宿主传入的 `provider.headers` 多行文本，覆盖模型配置层
- **账号级**：既有账号的 `metadata.headers`（手动配置），覆盖前述配置层；当前登录流程不询问请求头

格式是「一行一个 `Name: value`」，空行和 `#` 开头跳过。这里**只适合放这种头**：不要整段粘贴浏览器 devtools 的请求头 —— Cookie 应放入用途对应的既有 metadata 字段，不在登录时询问，`Authorization` 由插件按 key/令牌设置，而 `User-Agent` 应该填**网关认的客户端标识**，不是浏览器的那一长串。

> 踩坑记录：把 Mobile Safari 的完整 `User-Agent` 贴进 `headers` 后，`/v1` 一律 401
> `unauthorized client detected`，而站点路由（余额、签到）却一切正常 —— 很容易以为是 key 或插件坏了。
> 网关只认它自己的客户端标识，换回 `codex_cli_rs/0.101.0`（或清空、用默认）即恢复。

## 凭据用途

- API key `sk-…`：对话、模型列表、累计消耗；登录时由插件只读查找并保存。
- 站点登录会话（`cookie`）+ 用户 ID：账号数据读取；余额可能被 WAF 拦截。
- 站点用户名密码：登录、签到与查找模型 Key；由你登录时输入并保存，源码不含任何内置凭据。

`sk-` key 不能代替账号访问令牌。`/api/user/token` 会重新生成访问令牌，使旧令牌失效；插件不调用此接口，也不会把密码或会话当作模型 key。

## 协议：只有 Responses API

AgentRouter 的模型**不支持** `/v1/chat/completions`：

```
400 模型 gpt-5.6-sol 不支持 /v1/chat/completions 接口，请改用 /v1/responses
```

所以 provider 声明为 `npm: "@ai-sdk/openai"`（Responses）。agent 发 Chat / Anthropic 请求时，由 magpie 网关负责翻译。

### 跨 OpenAI 资源的历史条目错误

如果上游提示 `The requested item was created under a different ... OpenAI resource`，通常是请求引用了另一个资源创建的服务端条目。这不是内容敏感词，也不是改一次 API Key 就能恢复的历史。

默认开启 `portable-responses`：对 `POST .../responses` 中**带完整内联内容**的普通消息和 function-call / function-call-output，去掉用于条目查找的顶层 `id`。完整 assistant 消息在内联后仍保留 `output_text` 及其空 `annotations` / `logprobs`，不会误转为 `input_text`；其他角色沿用输入文本转换。保留角色、正文和 `phase`；工具的 `call_id`、名称、参数、结果及嵌套业务 `id` 保持不变。有改写时设置 `store:false`，清除旧正文长度/摘要头。未改写时保留原始正文。实现见 [request.mjs](<request.mjs>)。

插件也识别普通 `output_text` 中的空 `logprobs: []`（网关可能随完成消息一起输出）。空概率数组不阻碍完整消息内联，assistant 消息内联时仍原样保留该字段；**非空、`null` 或形状未知的概率数据保持原样**。这类完整消息的顶层 ID 曾因该字段未被识别而保留，合成资源切换回归覆盖了此缺口。

边界：

- **不删** `previous_response_id`、`conversation` 或 `item_reference`；这些请求不做 ID 重写，因为插件并不知道它们指向的完整历史。独立文本过滤仍可替换请求中可见的匹配正文，但不能处理引用背后的历史。客户端需要重发完整内联历史，或由上游固定到原资源。
- **不删改推理及 compaction 条目**，包括它们的 ID、摘要和加密内容。`store:false` 不会让加密状态跨资源通用；不同密钥无法解密时仍须原资源。
- 非空引用注释、未知消息字段和未知条目类型保留原样，不为修复而静默丢失内容。文件/图像/容器等资源引用也不递归删除。
- 只处理最多 4 MiB 的 JSON 请求；读取 Request 副本最多 2 秒，支持取消。超限、非 JSON、压缩正文和其他端点不改写。不会自动重试，更不会重放用户历史。
- 关闭提供商选项 **Replay complete Responses items inline** 只关闭 ID 重写；若启用了下文的本地词表，文本过滤仍独立生效。两个选项都关闭才恢复原始正文透传。只有服务端引用、没有完整内联正文的旧会话，不保证仅升级插件就能继续。

当此错误仍出现，插件返回 `agent_router_resource_mismatch`，保留上游消息与可识别的 trace ID，说明需要完整内联历史或同一上游资源，而不是报成敏感词错误。

协议依据：[OpenAI 内联消息与 phase](<https://raw.githubusercontent.com/openai/openai-python/main/src/openai/types/responses/easy_input_message_param.py>)、[工具调用 id / call_id](<https://raw.githubusercontent.com/openai/openai-python/main/src/openai/types/responses/response_function_tool_call_param.py>)、[Azure 无存储推理延续](<https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/reasoning#preserve-reasoning-without-stored-responses>)。这些协议说明不等于厂商承诺跨资源加密状态可移植。

## 模型列表从哪来

面板里的模型来自**两个来源的并集**：

1. **插件自己的名单**（本仓库 `index.mjs` 的 `DECLARED_MODELS`）：登录前展示用，也是读不到站点列表时的兜底。当前是 `gpt-5.6-sol` / `gpt-6-astra` / `gpt-6.1-sol`。
2. **magpie 自带的 models.dev 目录**：`magpie` 会把目录里同名条目（`agentrouter`）的模型并进来。这个目录在服务器上是 `config/cache/magpie/models.json`，**由 magpie 自己同步，不由本插件控制**。

两者取并集去重。因此如果站点下架了某个模型，而目录缓存里还留着，面板就会多列出已下架的模型 —— 选中它只会得到：

```
503 当前分组 default 下对于模型 xxx 无可用渠道
```

插件这边能保证的是：**站点自己的列表**（`GET /v1/models`，账号有效时）永远优先，读不到时才回落到插件名单，而**不会再回落到目录里那些名字**。所以正确的做法是让站点列表生效：

```bash
# 让 magpie 重新拉一次账号的模型列表
docker exec magpie magpie providers        # 状态里会写 "N of M models · fetched …"
docker exec magpie magpie provider models agentrouter
```

如果你的面板仍显示已下架的模型，那是目录缓存的贡献，不是插件声明的。可以：

- 在 provider 编辑器里把不需要的模型关掉（`disabled`），它们在列表里就不再生效；
- 或者清掉/更新 `config/cache/magpie/models.json` 里的 `agentrouter` 条目（升级 magpie 也会刷新目录）。

> 站点给你几个模型，以 `GET /v1/models` 为准 —— 它和面板是两回事。

## 内容过滤器：被拒的请求不是限流

AgentRouter 在模型前面挂了自己的**内容过滤器**。它拒绝一段文字时回的是 HTTP **400**、
`code: "content-blocked"`，既不提密钥也不提额度，看上去很像一个可以重试的临时故障。

仓库保留的历史实验记录（2026-10-30，org 站点；不是当前版本的复测结果）：

| 内容 | 结果 |
|---|---|
| 普通长文，20 万 token | `200` |
| 20 万 token 的重复句 | `200` |
| 含 `transcript` 的短句（3 个 token） | **`400 content-blocked`** |
| `Here is the transcript of our call.` | **`400 content-blocked`** |

这些历史样例只能说明当时部分短句也被拦，不能外推为厂商的当前词表，也不能证明每次拦截都由某个词触发。只有 `content-blocked`、没有命中词或审核类别时，插件不能自动判定是哪段文字导致拒绝。

### 为什么它会被误当成 429

部分宿主会根据错误文案中的额度/限流类词判断是否切换账号或服务商。
当内容拒绝被误归类为可重试错误时，可能触发重试或故障转移；最终展示的错误也可能来自另一上游。
这只是一种可能的级联路径，**不能据此断言所有 429 都由内容拒绝引起**，应结合实际状态、错误代码和请求 ID 核验。

插件把明确的内容拒绝改写为专用说明，避免在说明中混入额度/限流类词（由回归测试约束）。
状态码保持 400，上游代码与请求 ID 保留，便于报障；是否重试或故障转移仍由宿主策略决定。
插件自身不会为此多发送请求。

> 遇到这个 400：保留 request id，向服务商核实拒绝原因。只有明确需要替换的文本才加入下方词表；不要盲目重试或把可疑词猜测当成已证实结论。过滤后仍可能被拒。

### 本地词表自动替换

提供商选项 **Filter configured prose before sending**（`text-filter`，默认开启）控制发送前替换。**没有词表或 `terms` 为空时不改正文**；不内置猜测词，不自动学习被拒的私密请求，不发送探测请求，也不追加重试。

1. 将插件目录中的 [content-filter.example.json](<content-filter.example.json>) 复制为 `content-filter.local.json`，与 [index.mjs](<index.mjs>) 放在同一目录。magpie 使用的是**服务端安装目录**，不是浏览器本机目录。
2. 仅填写自己确认需要替换的词；词表按字面量匹配，不支持正则。示例中的值仅为占位，不代表厂商拦截词：

   ```json
   { "terms": ["待替换的自定义文本"], "caseSensitive": true }
   ```

3. 词表属于私有配置，建议限制为仅运行插件的用户可读写。它已被 Git 忽略，也不在 npm 发布文件清单中；不要将真实词表放进示例文件、命令行参数或调试输出。
4. 保存后重新加载插件。运行中的 loader 使用加载时的快照；改文件本身不会立即改变在途请求。关闭 `text-filter` 可停用，重新开启后加载词表。

行为与边界：

- 仅处理 `POST .../responses` 的 `instructions`、字符串 `input`，以及 `input` 中普通 user/assistant/system/developer 消息的文本片段。Chat/Anthropic 客户端请求须先由 magpie 翻译为 Responses。`/responses/compact` 等其他端点不处理。
- 默认区分大小写；`caseSensitive:false` 可忽略大小写。按最长字面量优先、非重叠替换成 `[FILTERED]`，不递归替换生成的标记，不自动添加单词边界。跨越已有过滤标记或代码块结构分隔符的词条匹配会被保守跳过，避免再次过滤时改变代码边界；普通正文中的跨段落字面量仍可整体替换。短词可能命中更长词的一部分，配置前应自行评估。
- **不改**工具调用参数、工具结果、工具 schema、业务 ID、模型名、metadata、文件/图片、推理/compaction/加密状态和服务端历史引用。Markdown 行内代码、根级反引号/波浪线围栏和未闭合代码段保守保留。含缩进代码的段落不改，但其前后独立段落仍可过滤；遇到引用/列表容器中的围栏，为避免误判结束位置，整个文本字段不改。带引用注释或未知字段的片段也不改。它不是通用的密钥防泄漏或数据防泄漏系统，不能保证屏蔽上述范围里的词。
- 仅匹配可见的普通正文；保留被跳过内容可能意味着上游仍会拒绝。并非找到了厂商完整词表，也不保证对某次 `content-blocked` 有效。
- 没有命中时，不因过滤而重新序列化请求；有命中时仅替换发送副本，清理旧长度/摘要头，不回写本地历史。独立的 `portable-responses` 选项仍可执行 ID 兼容处理。
- 请求沿用 4 MiB UTF-8 / Request 副本 2 秒的边界。超限、无法读取、非 JSON、压缩正文按原有逻辑透传，**不是已过滤的证明**。
- 词表最多 32 KiB、128 条；每条最多 256 个 UTF-16 代码单元，总计最多 8192。不存在/空词表视为停用；配置存在但 JSON、结构、编码或读取失败时，启用状态下拒绝创建 loader，而不是静默忽略。错误只给固定提示，不输出词条或请求正文。

实现：[content-filter.mjs](<content-filter.mjs>)；回归测试：[test/content-filter.test.mjs](<test/content-filter.test.mjs>)。

文字过滤也接受普通 `output_text` 中的空 `logprobs: []`。过滤先于历史内联执行，因此开启或关闭内联都适用；关闭内联时保留原消息 ID、`output_text` 类型、空概率数组及注释。非空、`null`、形状未知的概率数据，以及未知字段、真实注释或签名仍原样保留。`input_text` 中的未知概率字段不会因此获得放行资格。

## 真正的 429：每分钟 token 上限

除了上面的内容拒绝，上游也可能报告真实的 token 速率限制。以下为**脱敏后的错误示例**，区域名仅作占位：

```json
{"message":"Your requests to gpt-6.1-sol for gpt-6.1-sol in example-region have exceeded token rate limit.","type":"api_error"}
```

这是上游明确报告的 **token 速率上限**，不能据此断言账号余额用尽。厂商没有给出
具体计数范围、准确阈值或恢复时间；也不能仅凭多个账号同时失败就断言它们共用同一个计数器。

### 为什么会显示 200 / 零用量空回，同时又出现 429

上游会先发 **HTTP 200 + `text/event-stream`**，随后在流中报告失败。
旧插件只检查 HTTP 400/429，因此漏掉这种流内错误，也没有补上等待时间。
magpie 识别流内错误为 429 后，可能立即换账号，再对同一账号进行短间隔重试。
上游未生成有效回答时可能记为零用量，但**零用量本身不是限流的证据**。

修复后的处理：

- 在首段正文、推理或工具调用发出前，检查 SSE 的元数据前缀。明确的 token 速率错误
  转成 **HTTP 429**；明确的内容拒绝转成 400。支持嵌套 JSON 错误及 HTTP 200 JSON 错误信封。
- **保留上游 `Retry-After` 和 request-id**；仅对已识别的 token 速率错误，在上游没有
  给出等待时间时补 `Retry-After: 60`。60 秒是保守建议，**不保证一分钟后恢复**。
  宿主是否遵循等待提示、短间隔重试或跨账号调度，取决于其版本与配置；插件不保证某个等待阈值会关闭重试。
- `response.completed` 明确给出空 `output`、输入/输出用量均为零且此前无有效输出时，
  单独报 **502 `agent_router_empty_response`**，不会伪装成限流。
- 正常响应逐字节透传。已有正文、推理或工具调用后的错误不重新包装，避免丢失部分输出
  或诱发工具重复执行。未知错误、普通 429、截断流也不会凭空变成 token 限流。
- 只检查最多 **64 KiB / 15 秒** 的流前缀；超过任一边界就原样放行，不缓存整段回答。
  插件自身不发起重试，也不绕过上游限制；默认 `magpie.maxConcurrency` 保持 **2**。

> 看到这个 429：遵循等待提示，降低并发并评估上下文大小。如果持续发生，应向上游提供
> request-id 查询真实阈值。插件修复的是错误识别与退避信息，不会增加上游可用容量。

## 有界响应诊断与增量 SSE

JSON 仅在 HTTP **200 / 400 / 429** 时检查副本，最多 **64 KiB / 2 秒**；检查的是实际 UTF-8 字节，不信任 `Content-Length`。超限、超时、错误编码、读取失败或非 JSON 时放弃诊断，保留原响应供调用方读取。该上限约束诊断工作量，不限制整段正常回复，也无法阻止上游一次分配更大的单个数据块。共享实现见 [body-inspection.mjs](<body-inspection.mjs>)。

只从明确的 `error`、`response.error`、SSE `event:error` 等错误封套读取最多四层嵌套的 `message` / `msg`，也支持其中 JSON 编码的错误。**不会扫描成功正文、工具结果或普通文字来猜错误**。无法识别的错误原样透传。每一层嵌套都先验证有效错误叶子，再继承有效数字状态；不借用包装层正文。预算耗尽且仍有未检查的嵌套时也原样放行，不根据已读取的祖先字段猜测。新增归类如下：

| 明确的上游错误依据 | HTTP 状态 | 插件类型 |
| --- | --- | --- |
| 数值或严格三位数字字符串 `429`，或 `rate_limit_exceeded` | 429 | `agent_router_upstream_rate_limit` |
| `overloaded_error`、`high_demand`，或错误消息中的完整短语 `currently experiencing high demand` | 503 | `agent_router_upstream_busy` |
| `server_error` | 500 | `agent_router_upstream_error` |
| 数值或严格三位数字字符串 `500` / `502` / `503` / `504` | 保留对应状态 | `agent_router_upstream_error` |

当封套同时包含可识别的数值状态和错误代码时，以状态为准；类型按限流、繁忙、服务故障区分。认证、权限、余额、配额和内容策略等明确业务错误优先，**不会被包装为暂时性服务故障**。已有 token 限流、内容拦截、跨资源历史与空输出的专用类型不变。

改写后的响应保留上游代码与消息（`error.code` / `error.upstream`）、request-id，以及 `Retry-After`（包括 HTTP 日期）和上游毫秒等待头；仅清除失效的正文长度、编码和摘要头。新增归类不自造重试时长。调用是否重试由宿主决定，插件不会多发一次 POST、切换账号或降级历史。

SSE 仍只观察首个有效内容或未知事件之前最多 **64 KiB / 15 秒** 的前缀。增量解析兼容混合换行、注释、多行 `data:` 与跨块 UTF-8；重复 `event:` 取最后一个值，只移除冒号后的一个可选空格。已知字段内出现未知数据形状时也立即结束诊断，透传原始字节并保留取消、背压及超时中的在途读取；不发送心跳、不缓存整段回答、不观察已经放行的后续事件。相关实现见 [response.mjs](<response.mjs>)。

## 账号密码登录与故障恢复（本地定制版）

登录以账号密码调用 `POST /api/user/login`，成功后用返回会话只读查找已有模型 Key 并保存；宿主原生 key 输入框不再作为登录入口。

- **保存不等于验证**：保存后运行 `magpie provider test agentrouter`，再判断模型是否可用。宿主已登录和余额可读都不是模型验证结果。
- **本地 `400 agentrouter_missing_api_key`**：loader 遇到缺失 key 或保留占位 key，在任何网络请求前返回。重新执行账号密码登录读取模型 Key 后再测。
- **旧配置端点误填 key**：`endpoint` 应为 HTTP(S) 地址。既有端点校验回退能力保留；如需手动修正，先备份，不要把 key 或其他凭据写入 URL。
- **查 key 不确定**：没有唯一可用候选或列表分页不完整时，按站点「令牌」页的 ID 列填写目标 Key ID 后重新登录；不自动创建、轮换、重试或保存空 key。

## 账号密码登录怎么走

插件的 `authorize` 会：

1. 以表单中你输入的账号密码 `POST https://ps.air-outer.com/api/user/login`
2. 从响应头提取 `Set-Cookie: session=…`，并读取用户记录（`id`、`quota`、`checked_in`）
3. 用该会话与用户 ID 调 `GET /api/token/`（或填写 Key ID 时 `GET /api/token/{id}`）查找已有模型密钥；仅接受去重后的唯一启用、非空、未掩码、未过期候选
4. 保存模型 Key、会话、用户 ID 与账号密码到账号 metadata；多个候选或分页不完整等不确定结果均失败并提示填写 Key ID，不自动补页重试、创建或轮换密钥

签到 hook 与本地工具重复第 1 步完成每日签到；余额读取优先用已保存会话请求 `/api/user/self`，失败再回落到密码登录与消耗接口。

## 改请求头（不用重新登录）

[维护脚本](<set-ar-headers.sh>)只输出固定成功提示，不回显请求头内容。但命令行参数仍可能进入 shell 历史或进程列表，因此该入口只适合非敏感客户端标识头；不要用它传入 Authorization、Cookie 或其他凭据。

```bash
./set-ar-headers.sh 'User-Agent: codex_cli_rs/0.101.0'
./set-ar-headers.sh ''          # 清空，回到默认
```

脚本默认读 `<magpie 配置目录>/magpie/plugin-auth.json`（Docker 部署常见为
`/opt/magpie/config/magpie/plugin-auth.json`），用 `AUTH_FILE` 覆盖。

四层覆盖（后者覆盖前者）：插件默认 → 模型配置 `provider.models[*].headers` → provider 级 `provider.headers` → 账号级 `metadata.headers`。当前实现先按枚举顺序汇总该 provider 的模型头，同名项由后面的模型覆盖；这不是按当前请求模型隔离的设置。模型层接受对象，provider 与账号层接受上述多行文本；宿主界面名称及配置映射以其版本为准。

## 手动配置文件格式（plugin-auth.json）

这是已支持的高级路径，不是首次登录表单，也不是新的设置页面。修改前备份宿主的认证配置，保护文件权限；示例中的占位值不可原样用于真实账号。保持既有账号 key、站点和不相关字段不变。

`plugin-auth.json` 的形态：

```json
{
  "agentrouter": {
    "type": "api",
    "key": "sk-…",
    "metadata": {
      "endpoint": "https://ps.air-outer.com",
      "site": "air",
      "username": "（你本人的站点账号，必填）",
      "password": "（你本人的站点密码，必填；保存在网关服务器）",
      "cookie": "session=…（登录时自动保存，配合用户 ID）",
      "userId": "（登录时自动保存）",
      "headers": "User-Agent: codex_cli_rs/0.101.0"
    }
  }
}
```

改完后执行 `docker restart magpie`（或重启 magpie 进程）生效。

## 端点与站点

- 本定制版所有请求（模型、登录、余额、签到、Key 列表）固定发往 `https://ps.air-outer.com`；国际站入口已移除。
- `endpoint` / `apiBase` 显式配置时仍可覆盖模型请求地址（高级路径，默认 `https://ps.air-outer.com/v1`）。
- `site` 字段固定为 `air`，仅保留兼容旧配置。

## 额度百分比与字段说明

```bash
docker exec magpie magpie quota | grep -i agentrouter
#   agentrouter · example-user · API key …XXXX   subscription  Balance 25% ($150.00 / $200.00)
#   上述为虚构示例；实际输出也可能提示“累计消耗…；剩余额度未知”。
```

`Balance` 里的百分比是 magpie 的 `Used` 字段（剩余 = 100 − 已用），金额在 `Amount` / `Limit`。
**不要把美元金额塞进 `Used`** —— 例如把 $250 当成 250%，会使剩余被截成 0%。

## 额外的本地拒绝策略（可选社区中间件）

这是独立于上文发送前替换的 **reject** 策略，不会替换文字，也不能据此判断 AgentRouter 的真实拦截词。现有部署若需要正则拒绝，可另行评估社区中间件：

```bash
docker exec magpie magpie plugin add @magpie-community/middleware-word-guard
docker exec magpie magpie plugin options word-guard '{
  "action": "reject", "check": "last",
  "patterns": ["\\b\\d{3}-\\d{4}\\b", "secret[-_]?codename"],
  "words": [], "replies": false
}'
```

实测：命中 → `400 this request has "123-4567", which this gateway doesn't send`；正常 → `200`。

### 两个坑

1. **不要写 `(?i)`**。word-guard 把 `patterns` 拼进一个已经带 `gi` 的正则，再写 `(?i)` 会变成
   `Invalid group`，**整个匹配器失效**，于是什么都不拦（失败计数会涨）。大小写本来就忽略。
2. **它只过滤 agent 发的请求**。中间件挂在 `serveAgent` 上，curl 直连网关走 `serve`，不经过它。
   验证时要带 agent 的 User-Agent 或 `magpie-<app>` 形式的 key。

它只读用户自己写的文字（user message），不读工具结果、工具调用和 system prompt。

## 开发验证

在仓库根目录运行：

```bash
npm test                 # Node.js 插件与本地签到回归
npm run test:headers     # 需要 Python 3；仅执行维护脚本的 Python 部分，不调用 Docker
```

## 文件

| `index.mjs` — 插件本体（provider + 自定义头 + 余额 + 签到 + 账号密码登录）
- `response.mjs` — HTTP / SSE 早期失败识别与有界流透传（安装时必须一起复制）
- `package.json` — 包描述
- `set-ar-headers.sh` — 改请求头的小工具
- `test/` — 全部回归测试（`npm test` 运行；`test/set-ar-headers.test.py` 由 `npm run test:headers` 运行）
- `test/usage.test.mjs` — 额度读取、登录与 HTTP 错误回归测试
- `test/loader-stream.test.mjs` — 流内错误、空完成、成功字节、工具调用等回归测试
- `test/response-bounds.test.mjs` — 有界缓存、检查超时与取消测试（统一运行 `npm test`）

## 已知问题与排查

| 现象 | 原因 | 怎么办 |
|---|---|---|
| 所有模型都无响应，面板 0/7，且**没有任何报错** | 旧版把 `sk-…` 存进了 `metadata.endpoint`，请求打到 `sk-…/v1` | 当前登录流程不询问端点；既有非 URL 端点仍会被忽略并采用已存 apiBase 或默认值，升级无需重新登录 |
| `/v1` 一律 `401 unauthorized client detected` | 自定义头里放了浏览器 `User-Agent` 等网关不认的标识 | 清掉该头，或用默认（`codex_cli_rs/0.101.0`） |
| 某模型 `503 … 无可用渠道` | 面板列的是 models.dev 目录里已下架的模型 | 见「模型列表从哪来」，用站点真实列表或关掉该模型 |
| 模型列表比预期少 | provider 编辑器里只选中了部分模型 | `magpie provider models agentrouter` 看 `pickedFrom`，在编辑器里勾选 |
| 余额显示旧值 | magpie 在读取失败时保留上次成功的读数（`asOf`） | 看 `asOf` 时间；这不是刚查到的余额 |

## 出处与致谢

本插件基于 **ZhaoJun233** 的 [agentrouter-magpie-plugin](https://github.com/ZhaoJun233/agentrouter-magpie-plugin) 二次开发，现由 [nijiong](https://github.com/nijiong/agentrouter-magpie-plugin) 独立维护，**不再跟随上游更新**。

衷心感谢原作者 **ZhaoJun233**：本插件的核心能力——有界响应诊断、增量 SSE 前导观察、assistant 历史与不透明状态的无损保留、本地文字过滤，以及本地签到工具的 ACL 安全机制——均源自其设计与实现。本定制版只是在此基础上收窄登录方式、固定站点并清理历史遗留代码。

同时感谢参考项目 [AgentRouter-Codex-Filter](https://github.com/alexcarterio/AgentRouter-Codex-Filter)（MIT，作者 alexcarterio）提供的保守错误诊断思路。本插件延续该取舍：不引入独立代理、仪表盘、遥测、自动重试或有损历史降级。

原始版权归 ZhaoJun233 所有，依 [MIT 许可](<LICENSE>)保留其版权与许可声明；本定制版的修改部分同样以 MIT 许可发布。完整版本变化见[更新日志](<CHANGELOG.md>)。
