<p align="center">
  <svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" color="#4D6BFE"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/></svg>
</p>

<h3 align="center">DeepSeek Harness Agent 审批权限插件</h3>

<p align="center">
  <img src="https://img.shields.io/badge/DSH-Plugin-4D6BFE?style=flat" alt="DSH plugin">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-2EA44F?style=flat" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/Web%20UI-Yes-22C55E?style=flat" alt="Web UI">
</p>

<p align="center"><sub>中文</sub></p>

---

为 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) Web UI 打造的 **Agent 审批**权限插件：当内置的权限选项（`workspace-write + ask` / `danger-full-access + never`）不能满足需求时，为会话开启第三种模式——**以 workspace-write 为基线，提权请求交由独立审批 Agent 裁决，有风险就拒绝**。

## 功能

| 功能 | 说明 |
|---|---|
| 🛡 **权限菜单第四项** | `/permission` 菜单新增 **Agent 审批** 预设；选中即开启，切到其他预设自动关闭，跨重启保持 |
| 🤖 新权限模式 | 开启后：沙箱基线固定 `workspace-write`，审批策略切到 `ask`（内部接管），**不再弹人工审批** |
| 🤖 独立审批 Agent | 每次提权请求由一次性 `spawn` 子代理裁决：独立会话、零工具、只读材料，结构化输出 `{decision, riskLevel, rationale}` |
| ⛔ 风险即拒绝 | 破坏性 / 不可逆 / 越界（含修改操作系统或其他应用数据）/ 理由与实际命令不符 → 直接 `reject`；仅"安全、可逆、与任务相符、理由诚实"才 `approve`——项目自身的安装/部署脚本写其文档指定路径属任务所需 |
| 🔒 Fail-closed | 审批 Agent 启动失败、超时（可配 30s–600s）、结果不合法、**证据不完整（参数取不到或被截断）** → 一律按拒绝处理，绝不静默放行 |
| ⚙️ 审批模型可配置 | 设置页选择 Provider + Model，不选则固定用 **Harness 默认模型**（不跟随请求会话，口径稳定）；选择与超时**持久保存**，重启不丢 |
| 🧱 安全加固 | 长参数按「头+尾」呈现给审批员（危险尾部藏不住）；`放行 + tool=* + 空 match` 这种"一键关掉审批"的规则被拒；规则里以 `/` 开头的路径子串不再被误当正则；被截断的审计记录不提供「加白」；委派出的子会话不会被自动开启本模式 |
| 📋 审计记录（随会话） | 会话窗口顶部的**「审批」标签页**（轨迹旁）查看本会话全部审批：结论 / 风险等级 / 模型 / 耗时 / 理由；悬停看完整理由与**精确工具参数**；审批 Agent 的会话 id 可回溯完整推理；已批准行可一键**「加白」**存为放行规则。记录存在**会话存储目录内的独立文件**——随会话恢复，删除会话即随之删除 |
| 🔁 可逆开关 | 权限菜单「Agent 审批」预设、`/agent-approval on\|off` 命令两条等价路径；关闭时**恢复开启前的权限旋钮** |

## 工作原理

```
开启（菜单 / 命令）
  └─ 记住旧旋钮 → sandbox/mode=workspace-write + approval/policy=ask（规范写路径，可恢复）
        │
工具请求提权（sandbox_permissions / 人工 ask）
  └─ ctx.approval.request() → approval/request 瀑布
        └─ 本插件 prepend 抢占（先于人工弹窗 answerer）
              └─ spawn 审批 Agent（独立会话 · 零工具 · 结构化裁决 · 不会递归审批）
                    ├─ approve → allowed-once（该次放行）
                    ├─ reject  → rejected（风险操作，最终拒绝）
                    └─ 超时/故障/取消 → fail-closed（按拒绝处理）
              └─ 记入审计（会话目录内的旁路文件，「审批」标签页可见；不写会话日志）
```

- 审批 Agent 只能看到：workspace 路径、**最近的用户消息**（任务上下文）、工具名、提权理由、**精确的工具参数 JSON**（按 `callId` 从会话日志回查）。裁决看"操作 vs 用户任务"的客观对齐，不依赖理由措辞。
- 子代理审批策略被 DSH 委派机制钉死为 `never`，不存在递归审批；全局工具全部空白，审批员只能"判"不能"做"。
- 未开启的会话完全不受影响（监听器原样 `next()`，人工审批行为不变）。

## 安装

### 标准安装（推荐）

本插件是**标准 DSH bundle**：`package.json` 声明 `dsh.bundle.patch`，包内 `cordis.patch.yml` 同时完成两件事——`- insert:` 挂载插件本身，`- id: permission` 把 **Agent 审批** 预设注册进 `/permission` 菜单。用官方 `dsh plugin` 命令安装：

```bash
# 本地开发：pnpm 软链到本仓库，改代码即生效（无需重新复制）
npm install                                     # ← 必须先装依赖：loader 从插件真实路径加载，
                                                #   裸导入（cordis/typert-protocol/zod）走插件自己的 node_modules
dsh plugin --profile web add /path/to/dsh-agent-approval

# 正式发布：从 GitHub Release tarball 安装
dsh plugin --profile web add https://github.com/MoonlitDropOfBlood/dsh-agent-approval/releases/download/v1.6.0/dsh-agent-approval-1.6.0.tgz
```

> 本地路径安装前**务必先 `npm install`**：缺 `node_modules` 时启动会 `ERR_MODULE_NOT_FOUND`，整个 DSH 起不来。宿主包版本要跟本机 DSH 对齐（避免双副本漂移），详见 [AGENTS.md](AGENTS.md) 第 9 节。

重启 DSH 后：设置面板出现 **Agent 审批** 页；`/permission` 菜单出现第四项 **Agent 审批**。

> **可选：权限菜单图标**。菜单图标硬编码在官方 `dsh-client-ui-conversation` 的 `permissionGlyphs` 映射里（无公开注册口），标准安装不会补它——不跑下面的命令只是**菜单项没有图标**，预设与功能不受影响。想让菜单项带盾牌图标，装完再跑一次（幂等；DSH 升级重装原版 bundle 后重跑即可）：
> ```bash
> npm run patch:glyph
> ```

> `dsh plugin add` 把插件装成 profile 的 npm 依赖并追加到 `dsh.profile.bundles`，启动时自动应用包内 patch。卸载：`dsh plugin --profile web remove dsh-agent-approval`。
>
> ⚠️ **卸载前建议先在各会话里切回其他权限预设**：历史会话日志里写着 `permission/preset: agent-approval`，而 `dsh-permission-presets` 会在启动时重放校验全部会话日志，对未知预设名报不变量错误（`unknown preset "agent-approval"`）。插件卸载后该预设名就不在表里了，那些会话下次启动会报错。

## 使用

1. **开启**：在 `/permission` 菜单选 **Agent 审批**，或输入 `/agent-approval on`。
2. **自动裁决**：之后该会话里的提权请求（例如命令被沙箱拒绝后带 `sandbox_permissions` 的重试）不再弹窗，由审批 Agent 在后台裁决并放行/拒绝。
3. **审计**：会话窗口顶部的**「审批」标签页**（轨迹旁）查看本会话的审批记录；悬停"审批理由"看完整理由与工具参数；已批准行可「加白」存为放行规则。记录存在会话存储目录内的独立文件，删除会话即随之删除；v1.4 的旧全局记录用 `node scripts/migrate-records.mjs` 一次性迁移（`--dry-run` 预览）。
4. **配置**：设置 → **Agent 审批** 设置审批模型（不选则用 Harness 默认模型）、审批超时与放行/拒绝规则。
5. **关闭**：菜单切回其他预设，或 `/agent-approval off`，恢复开启前的沙箱模式与审批策略。

## 安全边界（请读）

这个模式是**风险削减**，不是沙箱边界，也不是分权手段：

- **裁决者是 LLM**，而被审查的 agent 控制操作内容与理由。真正的隔离边界始终是 OS 级沙箱（`workspace-write` / `danger-full-access`）。审批 Agent 的价值在于拦住明显破坏性、不可逆、越界或理由不实的操作，而不是提供密码学保证。
- **开启即同时放宽两件事**：沙箱基线被钉到 `workspace-write`（若原本是 `read-only`，这就是放宽），并且**人工弹窗被替换为模型裁决**。这正是该模式的用途，但请明确知道自己在授权什么。
- **证据不完整一律拒绝**：审批员看到的是工具参数的**头部+尾部**（超长时中间以 `…[N chars omitted]…` 标记），参数取不到、为空或带省略标记时**必须拒绝**——因为请求方可以拿无害前缀把危险尾部顶出可见范围。副作用：超过 4000 字符的提权请求会被拒，请把命令写短或拆开。
- **不允许"全量放行"规则**：`放行 + tool=* + match 留空` 等于一键关掉整个审批控制，`addRule` 直接拒绝（`拒绝` 的同形状仍然允许；手工编辑 `config.json` 仍会被加载）。规则表与审批模型是**全局的**（不区分 workspace / 会话），规则增删也不进审计——加规则时请意识到它影响所有开启本模式的会话。
- **审计存储依赖一个非公开 hook**：会话目录定位走 `sessionPersistence.locate()`（不在 DSH 公开 API 里）。一旦上游移除它，记录会退回 `<DSH_HOME>/agent-approval/records/`（不再随会话删除），**并在宿主日志打印告警**——这是有意设计，避免"审计看似正常其实已脱离会话"。
- **Remote 面按可信客户端对待**：`toggle` / `sessionRecords` / `addRule` / `setModel` 都没有调用方归属校验。今天的 Web 客户端与人工审批者同属一个信任域（能弹窗批准的人本来就能放行一切），所以不构成提权；但不要把本插件的 gateway 暴露到跨信任域的场景。
- **委派子会话不会被自动开启**：DSH 把子代理审批策略钉死为 `never`（子代理拿不到父级没给的权限）。插件在自动重新开启时会跳过 `origin: "subagent"` / 有 `parentSession` 的会话，避免覆盖这条钉死；用户在活着的子会话里**显式**选预设仍然生效。

## 目录结构

```
dsh-agent-approval/
├── index.js            # Host 半：AgentApprovalService（审批瀑布抢占 + spawn 审批 Agent + 审计）
├── lib/pure.js         # 无依赖纯逻辑：规则匹配 / 证据渲染 / shortId（可离线单测）
├── client.js           # Client 半：设置页「Agent 审批」+「审批」审计标签页 UI bundle
├── typert.host.js      # Typert Host manifest（agentApproval 8 个方法的描述）
├── cordis.patch.yml      # dsh bundle patch（挂载行 + permission 预设表覆盖）
├── test/pure.test.mjs    # node --test 单测（不需要 DSH 包）
├── scripts/patch-glyph.mjs # 可选：权限菜单图标补丁（标准安装不自动执行）
├── .github/workflows/  # GitHub Actions 校验 + 打包 + 发布
├── AGENTS.md           # 面向 AI agent 的开发指南（含踩坑）
└── LICENSE             # MIT
```

## 开发

```bash
npm run check           # node --check 全部源码与脚本
npm test                # node --test：lib/pure.js 的纯逻辑单测
npm run verify          # check + test
dsh plugin --profile web add /path/to/dsh-agent-approval   # 安装/重装到本机 DSH profile
npm run patch:glyph     # 可选：权限菜单图标
```

详见 [AGENTS.md](AGENTS.md)——记录了 DSH 正式插件（Host/Client/Typert 三件套）的完整机制、审批瀑布 prepend 抢占与结构化子代理裁决的踩坑。

## License

本项目遵循 [MIT License](LICENSE)。

> 本项目是基于 DeepSeek Harness 构建的社区插件，并非 DeepSeek 官方产品。
