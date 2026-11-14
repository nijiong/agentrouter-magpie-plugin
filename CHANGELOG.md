# 版本记录

[使用说明](<README.md>) · [优化设计与兼容边界](<docs/OPTIMIZATION.md>) · [出处与致谢](<#出处与致谢>)

本页记录本独立插件的源码行为，当前版本为 **0.1.10**。本插件未发布到 npm registry；文档和源码更新不代表远程网关升级或模型验证成功。

## 未发布 — 模块拆分

- 将站点客户端、登录提问 / 授权流程与账号服务分别提取到独立模块；入口仅负责宿主 hook、模型配置及请求处理链的组装。
- 本地签到直接复用账号服务，不再导入并实例化宿主插件；锁、24 小时节流、失败暂停和 ACL 检查不变。
- 请求回放与文本过滤共享基础消息形状判断，统一登录 / 余额查询的额度字段转换；保留各自处理范围、读取预算及不透明状态保护。
- 合并测试 fetch 辅助设施，临时安装目录按发布文件清单复制全部运行时模块；保留原有入口导出与兼容包装接口，不新增依赖。
- 明确默认国内站与高级地址覆盖的区别：保留已有 `endpoint` / `apiBase` / `siteURL` 能力；首次登录表单、Key 列表及本地签到工具仍使用国内站，不新增地址配置入口。

## 0.1.10 — 2026-11-14

- 登录表单移除「模型 Key ID」手动输入：账号密码之后，账号下只有一把可用模型 Key 时自动选用；有多把时通过 magpie 的 `ask` 钩子逐一列出（名称 + 掩码 Key，选项值为列表序号，不携带凭据），由用户选择要用的那把。
- 同一次登录的提问与授权共享一次登录与一次 Key 列表读取（按已提交答案短时缓存，authorize 取用后即删）；越界或非法的选择序号在保存前被拒绝。
- 候选过滤与不确定处理不变：启用、非空、未掩码、未过期，按实际 key 去重；无候选、列表不完整或未知形状仍失败，不代选、不补页、不重试、不创建或轮换 Key。
- 兼容边界：多 Key 选择需要支持 `ask` 钩子的较新 magpie 宿主（2026-11-10 之后的版本，同时依赖 `keyAsked` 免原生 Key 表单）。不支持 `ask` 的宿主只询问账号密码，多把 Key 时登录失败并提示重新登录选择。
- 移除 Python 维护工具：删除 `set-ar-headers.sh`（内嵌 Python 的改请求头脚本）与 `test/set-ar-headers.test.py`，移除 `npm run test:headers`。仓库不再包含 Python 代码，开发与验证只需 Node.js；自定义请求头改为按 README 手动维护账号 `metadata.headers`。
- 提供商开关的界面文案改为中文（发送前过滤配置的文本 / 内联回放完整的 Responses 消息），并通过 `labels` / `descriptions` 提供 zh、en 多语言，随宿主窗口语言显示；开关键名与默认值不变。
- 移除 `send-codex-headers` 开关：Codex 客户端请求头改为始终默认发送（网关只认自家客户端标识），需要其他标识时用请求头配置层覆盖 `User-Agent`。宿主里已保存的该开关取值不再生效，无需迁移。

## 0.1.9 — 2026-11-13

- 登录仅保留**账号密码**一种入口，账号与密码由用户手动输入后保存；移除 API Key、GitHub 授权、系统访问令牌入口与站点选择。登录以 `POST /api/user/login` 完成，用返回会话只读查找账号已有模型 Key 并保存。
- 所有请求固定发往 `https://ps.air-outer.com`；移除国际站 `agentrouter.org` 与 org/air 站点切换。
- 签到 hook 与本地签到工具改为账号密码登录；移除 GitHub Cookie 自动签到与全部 GitHub OAuth 代码。本地工具凭据文件改为 `credentials.txt`（一行 `用户名:密码`），ACL 安全机制不变。
- 签到判定与服务端一致：服务端按登录计签到，因此**重新调用登录接口成功即完成签到**；`checked_in` 降级为“是否新增额度”的附加信息，缺失或非布尔值不再判为失败（记为 `done`）。`claimed` 仍只在站点明确返回 `true` 时给出。
- 登录/余额错误不再回显站点响应正文，避免凭据经错误信息泄漏。
- 移除源码中写死的账号与密码：登录表单不再预填任何凭据，账号密码必须由用户手动输入，成功后保存到账号 metadata；未保存凭据时登录、签到与余额的密码回落均在本地拒绝，不发起请求。
- 仓库整理：全部回归测试统一移至 `test/` 目录，插件源码（`index.mjs`、`request.mjs`、`response.mjs`、`body-inspection.mjs`、`content-filter.mjs` 及示例词表、`local-checkin.mjs`、`windows-acl.mjs`）统一移至 `src/` 目录；`package.json` 的 `main`/`exports`/`files` 与全部测试导入路径同步更新，`npm test` 与 `npm run test:headers` 命令不变。
- 死代码清理：删除无引用的 `github-cookie.mjs` 与 `CHECKIN_TIMEOUT` 常量，合并重复注释块；文档移除已失效的 0.1.8 及以下上游历史章节与版本标注。
- 作为独立插件维护：解除对上游仓库的 git 追踪，仓库地址与安全报告渠道改为本仓库；保留 MIT 许可与原作者版权声明，并在 README 与本页补充[出处与致谢](<#出处与致谢>)。
- 移除全部 GitHub 自动化：删除 `.github/` 目录（CI、CodeQL、PR 审查工作流、PR 策略脚本、dependabot、Issue/PR 模板、CODEOWNERS）及仅服务于 CI 的 `test/pr-policy.test.cjs`、`test/windows-test-temp.ps1`，同时移除 `npm run test:policy`。验证改为完全由维护者本地执行。

## 出处与致谢

本插件基于 **ZhaoJun233** 的 [agentrouter-magpie-plugin](https://github.com/ZhaoJun233/agentrouter-magpie-plugin) 二次开发，现由 [nijiong](https://github.com/nijiong/agentrouter-magpie-plugin) 独立维护，不再跟随上游更新。

- **原作者 ZhaoJun233** —— 感谢其奠定了插件的整体架构与核心能力：有界响应诊断、增量 SSE 前导观察、assistant 历史与不透明状态的无损保留、本地文字过滤，以及本地签到工具的 ACL 安全机制。这些设计构成本插件的基础。
- **参考项目 [AgentRouter-Codex-Filter](https://github.com/alexcarterio/AgentRouter-Codex-Filter)**（MIT，作者 alexcarterio）—— 上游作者参考了其保守错误诊断思路。本插件延续该取舍：不移植独立代理、仪表盘、遥测、自动重试或有损历史降级。

原始版权归 ZhaoJun233 所有，依 [MIT 许可](<LICENSE>)保留其版权与许可声明。本定制版的修改部分同样以 MIT 许可发布。感谢上游社区在 magpie / OpenCode 生态中的公开实践与讨论。
