# 版本记录

[使用说明](<README.md>) · [优化设计与兼容边界](<docs/OPTIMIZATION.md>) · [出处与致谢](<#出处与致谢>)

本页记录本独立插件的源码行为，当前版本为 **0.1.9**。本插件未发布到 npm registry；文档和源码更新不代表远程网关升级或模型验证成功。

## 0.1.9 — 2026-11-13

- 登录仅保留**账号密码**一种入口，账号与密码由用户手动输入后保存；移除 API Key、GitHub 授权、系统访问令牌入口与站点选择。登录以 `POST /api/user/login` 完成，用返回会话只读查找账号已有模型 Key 并保存。
- 所有请求固定发往 `https://ps.air-outer.com`；移除国际站 `agentrouter.org` 与 org/air 站点切换。
- 签到 hook 与本地签到工具改为账号密码登录；移除 GitHub Cookie 自动签到与全部 GitHub OAuth 代码。本地工具凭据文件改为 `credentials.txt`（一行 `用户名:密码`），ACL 安全机制不变。
- 登录/余额错误不再回显站点响应正文，避免凭据经错误信息泄漏。
- 移除源码中写死的账号与密码：登录表单不再预填任何凭据，账号密码必须由用户手动输入，成功后保存到账号 metadata；未保存凭据时登录、签到与余额的密码回落均在本地拒绝，不发起请求。
- 仓库整理：全部回归测试统一移至 `test/` 目录，`npm test` 与 `npm run test:headers` 同步更新。
- 死代码清理：删除无引用的 `github-cookie.mjs` 与 `CHECKIN_TIMEOUT` 常量，合并重复注释块；文档移除已失效的 0.1.8 及以下上游历史章节与版本标注。
- 作为独立插件维护：解除对上游仓库的 git 追踪，仓库地址与安全报告渠道改为本仓库；保留 MIT 许可与原作者版权声明，并在 README 与本页补充[出处与致谢](<#出处与致谢>)。
- 移除全部 GitHub 自动化：删除 `.github/` 目录（CI、CodeQL、PR 审查工作流、PR 策略脚本、dependabot、Issue/PR 模板、CODEOWNERS）及仅服务于 CI 的 `test/pr-policy.test.cjs`、`test/windows-test-temp.ps1`，同时移除 `npm run test:policy`。验证改为完全由维护者本地执行。

## 出处与致谢

本插件基于 **ZhaoJun233** 的 [agentrouter-magpie-plugin](https://github.com/ZhaoJun233/agentrouter-magpie-plugin) 二次开发，现由 [nijiong](https://github.com/nijiong/agentrouter-magpie-plugin) 独立维护，不再跟随上游更新。

- **原作者 ZhaoJun233** —— 感谢其奠定了插件的整体架构与核心能力：有界响应诊断、增量 SSE 前导观察、assistant 历史与不透明状态的无损保留、本地文字过滤，以及本地签到工具的 ACL 安全机制。这些设计构成本插件的基础。
- **参考项目 [AgentRouter-Codex-Filter](https://github.com/alexcarterio/AgentRouter-Codex-Filter)**（MIT，作者 alexcarterio）—— 上游作者参考了其保守错误诊断思路。本插件延续该取舍：不移植独立代理、仪表盘、遥测、自动重试或有损历史降级。

原始版权归 ZhaoJun233 所有，依 [MIT 许可](<LICENSE>)保留其版权与许可声明。本定制版的修改部分同样以 MIT 许可发布。感谢上游社区在 magpie / OpenCode 生态中的公开实践与讨论。
