# AGENTS.md — dsh-agent-approval

面向 AI agent 与协作者的开发指南。**读这里再动手**，尤其"关键机制"和"重要注意事项"，记录了本项目踩过的大量坑。

## 项目是什么

一个 **DeepSeek Harness（DSH）双面（Host + Client）插件**：新增一种 **Agent 审批** 权限模式。

- 以 **workspace-write 为基线沙箱**；工具请求提权（更宽沙箱，如 `sandbox_permissions`）时，不再弹人工审批，而是交由**一个独立的审批 Agent（subagent）裁决**。
- 审批 Agent 在**独立会话**里运行：零父级上下文、全局工具全部空白（`toolFilter: {allow:[]}`）、审批策略被委派机制钉死为 `never`（不会递归再审批——v1.6.0 起插件也不再自动给 fork 子会话重新开启本模式，见第 8.5 节），必须通过 `structured_output` 结构化工具给出裁决：`{ decision: approve|reject, riskLevel, rationale }`。
- **风险即拒绝**：破坏性 / 不可逆 / 越界 / 理由与实际参数不符 → `reject`；只有"安全、可逆、与任务相符、理由诚实"才 `approve`。
- **Fail-closed**：审批 Agent 启动失败、超时、结果不合法、请求被取消、**证据不完整（参数取不到或被截断）** → 一律按拒绝处理（`unavailable`/`cancelled`），绝不静默放行。
- **设置面板**新增 **Agent 审批** 页（`settings.section`）：配置审批模型（provider/model，或 Harness 默认模型）与审批超时（两者**持久保存**，重启不丢）、查看已开启会话（chip 显示**与会话列表同源的标题**（Host 侧经可选服务 `sessionTitle` 折叠，缺席降级为空串）+ 短 id，悬停看完整会话 ID 与工作区 cwd；`getState` 的 `enabledSessions` 为 `{id,title,cwd}[]`，client 兼容旧 Host 的 `string[]` 形状）、**放行/拒绝规则表**（deny/allow 规则先于模型短路，持久化）。**审计不在这里**：会话窗口顶部新增**「审批」标签页**（`conversation.view` ring，紧邻「轨迹」；chat=0 / trajectory=10 / 审批=11），按会话折叠展示审批记录（**倒序、最新在上**；结论/风险/模型/耗时/理由，悬停看完整理由与工具参数，行内可一键「加白」）——记录存在**会话目录内的独立旁路文件**（见第 6 节）。
- 输入框 `/permission` 菜单的「Agent 审批」预设 + `/agent-approval on|off` 命令为当前会话开关（**刻意没有 composer chip**——开关本就属于权限菜单，菜单旁边再放一个属冗余，已移除）；关闭时**恢复开启前的权限旋钮**（沙箱模式 + 审批策略）。

## 目录结构

```
dsh-agent-approval/
├── package.json          # ESM 双面包：dsh.client: {platform:"web"} + exports(., /client, /typert, /package.json)
├── index.js              # Host 半：AgentApprovalService（TypertRemoteService 子类，类插件）
├── lib/pure.js           # 无依赖纯逻辑：规则匹配/证据渲染/shortId（可离线单测，且被 files 收录）
├── client.js             # Client 半：window.__ModuleLoader__.load bundle（设置页 + Remote 调用）
├── typert.host.js        # Typert Host manifest：agentApproval Remote 服务的 schema/调用描述
├── cordis.patch.yml      # dsh bundle patch（挂载行 + permission 预设表覆盖）
├── test/pure.test.mjs    # node --test 单测（只依赖 lib/pure.js，不需要 DSH 包）
├── scripts/patch-glyph.mjs # 可选：权限菜单图标补丁（标准安装不自动执行）
├── .github/workflows/release.yml  # 打 v* 标签时构建并发布 GitHub Release
├── AGENTS.md             # 本文件
├── README.md
└── LICENSE               # MIT
```

`package.json` 的 `files` 收 `index.js` / `lib` / `client.js` / `typert.host.js` / `cordis.patch.yml` / `test` / `scripts`——**新增运行时代码必须同时加进 `files`**（漏了 `lib` 会让安装后的 `import "./lib/pure.js"` 直接 ERR_MODULE_NOT_FOUND）。`test`/`scripts` 一起随包分发是为了让 `npm test` / `npm run check` 在装了 tarball 的目录里也能跑。

## 关键机制

### 1. DSH 正式插件 = 三件套（Host / Client / Typert）

| 文件 | 作用 | 被谁加载 |
|---|---|---|
| `index.js` | Host 半：Cordis **类插件**（导出 Service 类），注册 `agentApproval` 服务 | cordis loader（composition `insert` 行） |
| `client.js` | Client 半：浏览器 UI bundle | `client-modules`（扫描 `dsh.client` 声明 → 注入 `window.__DSH_BOOT__`） |
| `typert.host.js` | 描述 `agentApproval` 服务的 Remote 方法（wire schema / invocation） | `typert-loader`（扫描包的 `./typert` 导出） |

三者的**关键名字必须一致**：
- `index.js` 导出的类名 → `AgentApprovalService`
- `typert.host.js` 的 `model.services[].key` / `exportName` → `agentApproval` / `AgentApprovalService`；每个 invocation 的 id/service/namespace/method 与 client 描述符一一对应
- `client.js` 的 `CLIENT_REMOTE` 描述符 id → `dsh-agent-approval#agentApproval/<method>`，调用走 `ctx.get("remote.agentApproval").<method>()`
- `package.json` 的 `exports`：`"."`、`"./client"`、`"./typert"`、`"./package.json"`（**必须**有 `./package.json`，否则 `require.resolve("<pkg>/package.json")` 失败）

### 2. Host 半：类插件 + Remote 方法

```js
export class AgentApprovalService extends TypertRemoteService {
  static inject = ["approval", "subagents", "agents"];
  constructor(ctx, config) { super(ctx, "agentApproval"); }  // 必须传精确服务键
  [Service.init]() {
    markRemoteMethod(this, "getState");
    // ...每个 Remote 方法都要标记（方法名即 wire 导出名，没有第二个参数）
  }
}
```

- **不要导出插件对象 `{apply}`**；导出 Service 类（loader 用 `new Callback(ctx, config)` 实例化，第二个参数是插件 config 不是服务键——这是 dsh-archive-manager 踩过的构造坑）。
- `Remote` 装饰器**不能直接写**（Node ESM 不支持 Stage 3 装饰器），用 `markRemoteMethod()` 手动驱动（同 token-stats / archive-manager）。
- `inject` 里是**硬依赖**（缺任何一个插件进入 waiting）：`approval`（审批瀑布 + setPolicy）、`subagents`（spawn provider）、`agents`（sessionId→Agent 查找）。**`timer` 已在 v1.6.0 移除**：裁决竞速改成自己 `setTimeout` + `finally` `clearTimeout`（原因见第 4 节"竞速"）。可选面（`llm`/`agentDefaultModel`/`systemPrompt`/`commands`）用 `this.ctx.get()` / `this.ctx.inject([...], scope => ...)` 挂载，缺席时优雅降级。

### 3. 核心：prepend 抢占 `approval/request` 瀑布（本插件最重要的机制）

- DSH 的审批流：工具提权 → `ctx.approval.request()` → 服务先应用 session policy（`ask` 才继续）→ 派发 `approval/request` **waterfall** → 组合的 answerer 链（web 端是 host-apiproxy 的**人工弹窗 answerer**，它在组合加载时就注册了）。
- Cordis waterfall 的 hook 顺序 = 注册顺序（先注册 = 最外层 = 最先执行）。本插件**晚于** apiproxy 注册，所以必须：

```js
this.ctx.on("approval/request", (req, next) => this._onApprovalRequest(req, next), { prepend: true });
```

`{ prepend: true }` 把监听器 **unshift 到队首**，从而先于人工 answerer 执行。已开启的会话：直接裁决并返回 outcome（`allowed-once`/`rejected`/...），**不调用 `next()`**（否决了后续链条）；未开启的会话：原样 `return await next()`，人工弹窗行为完全不变。
- **监听器为什么收得到所有会话的派发**：审批派发带 `scopeTarget(this, req.agent)` 过滤器，untagged 监听器（本插件挂在 profile 根组合，无 scope 标签）一律放行。**因此本插件必须挂在 HOST 平面**（`cordis.patch.yml` 的 `- insert:` 行），不要放进任何 isolate realm。
- **为什么开启时要切到 `ask`**：policy 为 `never` 时 `decide()` 在瀑布之前就直接返回 `rejected`，监听器根本不会执行。`_setEnabled(on)` 在开启时记住会话的**有效**旋钮值（override ?? 组合默认——一个活在 `never` 组合默认下的会话，关闭时必须回到 `never` 而不是"无覆盖"状态），然后：沙箱用 `session.append("sandbox/mode", { mode: "workspace-write" })`（与官方 `setSandboxMode` 完全同一事件形态）；审批策略用 `approval.setPolicy(agent, "ask")`（规范写路径：追加 `approval/policy` 事件 + 给模型注入切换通知）。关闭时经同一对规范 setter 恢复记住的值（值未变化时 setter 自动 no-op）。

### 4. 审批 Agent：一次性 `spawn` 子代理 + 结构化裁决

```js
const run = await this.ctx.subagents.start("spawn", {
  label: "approval-judge",
  prompt: [{ type: "text", text: judgePrompt }],
  parent: agent,              // 用于派生 workspace / lineage / 深度
  signal: req.signal,         // 请求取消 → 子代理取消
  agentOptions: { provider, model },   // 配置了审批模型时才传
  outputSchema: VERDICT_SCHEMA,        // { decision, riskLevel, rationale }
  toolFilter: { allow: [] },           // 全局工具全部空白（structured_output 是 scoped 注册，不受影响）
  persona: APPROVER_PERSONA,           // 独立安全审批员人格，fail-closed 倾向
});
```

- **裁决 schema 必须是 JSON-Schema 受限子集**（`assertObjectJsonSchema`）：只允许 `type/properties/required/additionalProperties/items/enum/const` + 注解。不要写 `pattern`、`format`、数值范围。
- **零工具**：`toolFilter: {allow: []}` 合法（空 allow 数组不是 no-op——no-op 判定只针对 allow/deny **都缺失**），审批员只能"看"和"判"，不能"做"。**唯一例外**：presentation mode 非 `native`（PTC）时官方会无条件把保留传输层 `run_code` 加回可见集——它只绑定"当前可见工具"（此处为空），所以到不了任何工具，但"全局工具全部空白"这句在 PTC 部署下要加限定。
- **不会递归审批**：DSH 委派机制自动把子代理的审批策略钉死为 `never`（`captureDelegatedPolicyOverrides`，**最后事件胜出**的日志覆盖），子代理自己提权会在派发前直接 `rejected`。v1.6.0 起本插件在 `agent/created` 里**跳过委派子会话**（`isDelegatedChildHeader()`，判据只有 `header.origin === "subagent"`），否则 fork 子会话 seed 里父级的 `permission/preset: agent-approval` 会让 `_enableCore` 把 `never` 改回 `ask`，静默推翻这条钉死（见第 8.5 节）。
- **结果读取**：`run.result`（Promise，不 reject 业务失败）→ `result.structured`（合法裁决）+ `result.stopReason === "completed"`（合法值只有 `completed/aborted/error/max-tokens/refusal`；干净跑完但没拿到结构化捕获时 `structured` **缺键**且 stopReason 被强制为 `error`）。任一不满足 → `unavailable`（fail-closed）。
- **竞速**：`Promise.race([run.result, abortRace, timeoutRace])`，`finally` 里 `clearTimeout` + `removeEventListener("abort", …)` + `run.dispose().catch(()=>{})`。**不要改回 `this.ctx.timeout(ms)`**：它返回的 promise 无法取消，竞速落败后那个 `setTimeout` 会一直武装到超时（最长 600s），且其 effect 属于 timer 服务的 fiber（插件卸载也不释放），teardown 时的 `reject` 还会变成未处理拒绝。超时/取消/基础设施故障分别映射 `unavailable`/`cancelled`。`run.dispose()` 刻意不 await：fail-closed 结论不应被"等子会话静默"拖延（子会话由父 agent 卸载兜底回收）。
- **给审批员看的材料**：从会话日志按 `callId` 倒查 `tool/call` 事件的 `arguments` 原始 JSON（**精确命令**，不是转述；已核实该字段是 string 且在 `startCall()` 里先于 dispatch 落盘，所以一定查得到）、`req.reason`（工具方的提权理由）、workspace cwd、以及**首条真实用户消息（原始任务陈述）+ 最近 3 条真实用户消息**（`user/message` 且 `source.kind === "user"`，每条截断 800——任务的 ground truth；短会话里首条已在最近列表中则去重）。审批提示词明确 APPROVE 条件与 REJECT 清单；v1.4.0 起**删除"存疑即拒"**——拒绝必须能指出该操作的**具体可信风险点**（毁什么/泄什么/越什么界），笼统不确定、没见过的命令、简略的理由都不是拒绝理由（误杀治理，见第 5 节规则表）。
- **证据截断必须"掐头留尾"+ 强制拒绝（v1.6.0 安全修复）**：参数一律用 `evidenceText()`（`lib/pure.js`）渲染——保留**头部与尾部**、中间以 `…[N chars omitted]…` 标记。**绝不要退回前缀截断**（`trunc(argsRaw, n)`）：请求方自己控制参数，可以拿无害前缀把危险尾部顶出可见范围，而 harness 执行的仍是完整串；审计侧的 `args` 同样走 `evidenceText`（预算 2000），否则人工复核也看不到尾部。提示词 + persona 都写明：参数缺失、为空、或带省略标记 → **证据不完整，必须 reject**（这是具体理由，不算"存疑即拒"）。副作用：超过 4000 字符的提权会被拒，属于有意的 fail-closed 取舍。
- **审批员自身约束消歧（v1.3.5 修复的真实误杀）**：审批员子会话被委派机制钉死 `approval/policy: never`，harness 会向它注入运行时上下文 "Approval prompts are disabled in this session…"。小模型（flash）曾把这句**关于审批员自己**的约束误读为**请求方会话**的属性，两次以此为由拒绝了本该批准的操作（见 records.jsonl 2026-08-21 / 2026-08-22 两条 rejected）。因此 persona 与提示词都显式声明："你自身的 never 策略与固定作用域只约束你自己，绝不可作为请求方会话的属性或拒绝理由"。改提示词时**不要删掉这句**。
- **裁决一致性口径**：判"操作 vs 用户任务"的**客观对齐**，不依赖请求方理由的措辞水平——理由只是辅助证据：操作本身明显安全且与任务相符时，理由写得简略**不拒**；但理由与实际参数造假/不符仍**照拒**（读过审核标准的 agent 不能靠文笔获得优待）。
- **开发流程口径**（端到端任务不被卡死的关键）：提权档位只有粗粒度两档，审批员**判实际操作而非档位名**——项目自带的安装/构建/部署脚本写其文档指定的安装路径（如工具自身 profile 目录）、覆盖自身已安装的文件（可从源码再生成）、读调试所需的工具自有配置/日志，都算"任务明确所需"可 approve；但**修改操作系统或其他应用的数据**仍一律 reject。

### 5. 规则表与会话内信任（v1.4.0 起，先于模型裁决）

提权进入 `_judge` 后按固定顺序短路，全部**零模型开销、零人工弹窗**：

1. **deny 规则命中 → 直接 `rejected`**（所有 deny 先于任何 allow 判定，后加的 deny 永远压过先加的 allow）；**allow 规则命中 → 直接 `allowed-once`**。规则形状 `{ id, effect, tool, match, note, createdAt }`，持久化在 config.json 的 `rules` 字段：`tool` 为精确工具名或 `"*"`；`match` 为空 = **该工具**全部调用（v1.6.0 起 `addRule` **拒绝** `allow + tool:"*" + match 为空或纯空白` 这种"全量放行"——`match:" "` 是每个含空格的参数 JSON 都命中的子串，等价于空 match；它等于一键关掉整个审批控制，且无确认、无审计。`deny` 的同形状仍然允许，手工编辑 config.json 也仍然会被加载），否则是**参数原始 JSON 的子串**或 `/pattern/flags` 正则。**正则形状有守卫（v1.6.0 修复）**：必须 `/` 开头、有闭合 `/`、且闭合斜杠后只能是合法 JS flags——否则按子串处理。修掉的是这一种坏结果：以 `/` 开头且含第二个 `/` 的**路径子串**（`/usr/bin`、`/tmp/x.log`、`/etc/passwd`、`/C:/Users/x`）在旧代码里会走到 `new RegExp(body, "bin")` → 抛错 → `null` → **永不命中**——于是 allow 规则静默失效、而 **deny 规则会静默漏放行**（差分测试确认：旧 `oldRe("/usr/bin")` 为 `null`，新为 substring）。**残留歧义（无法消除，别当 bug）**：`/usr/i`、`/tmp/g` 这类"路径尾部恰好是合法 flag"的写法**新旧都按正则**处理，因为 `/usr/i` 与"带 `i` 标志的正则 `usr`"完全同形。要精确匹配这种路径，别用斜杠包裹（直接写 `usr/i` 就是子串），或以后引入显式 `re:` 前缀。`ruleRegex` 编译失败 = 永不命中，`addRule` 时即校验拒绝。规则命中也写审计（model 列记 `rule`）。**匹配原语都在 `lib/pure.js`**（`ruleRegex`/`ruleMatches`/`matchRules`/`isBlanketAllow`），改它们必须同时改 `test/pure.test.mjs`。
2. **会话内信任缓存**：模型 approve 后把 `工具名 + "\n" + 参数原始 JSON` 指纹存入该会话的 Set（`_trusted` Map）；同一会话内**参数逐字节相同**的再次提权直接 `allowed-once`（审计 model 列记 `trust`）。**不跨会话、不泛化到相似参数**，随 `_enabled` 条目一起在三处删除点清空（preset 切走 / session disposed / `_disable`）。跨会话复用走规则表：会话窗口「审批」tab 审计行的「加白」按钮一键把已批准操作存成 allow 规则——**只在记录里的 args 完整时才允许**（`isTruncatedArgs`：含 `…[N chars omitted]…` 或旧版 `…[truncated]` 即拒绝并提示手填），因为拿一个被截断的前缀/头尾串生成的规则会顺带放行所有共享该片段的更长命令。
3. 都不命中才 spawn 审批模型。

- 设置页「放行 / 拒绝规则」卡片管理规则（Remote 方法 `addRule`/`removeRule`，整表返回；`getState` 带 `rules` 字段，client 对旧 Host 缺该字段时降级为 `[]`）。
- wire 变更照旧三处同步：index.js 构造、typert.host.js（`ruleSchema` + `rulesValueSchema` + 两个 invocation + `AgentApprovalRule`/`AgentApprovalRulesResult` 类型声明）、client.js（描述符 + UI）。

### 6. 审计记录（v1.5.1 起：会话目录内的独立旁路文件）

- 每条裁决由 Host `_record(session, entry)` 追加到**请求会话自己存储目录里的旁路文件** `<sessionDir>/agent-approval.jsonl`，目录经 `sessionPersistence.locate(session.header)` 解析（纯路径计算，活会话可用；返回 `{kind:"jsonl", path:<session.jsonl.zstd 绝对路径>}`，取 dirname）。**⚠️ `locate` 不是公开 API**：`SessionPersistence` 公开面只有 `create/open/flush/stat/list`，`stat()` 的 `SessionPersistenceSnapshot` **不含任何路径**；`locate` 只是 JSONL 后端类上的 `private` 方法（TS 的 `private` 运行时被擦除，所以今天能用）。上游改名/移除即失效——因此 v1.6.0 起降级路径会经 `_warnOnce()` 打到宿主日志（`ctx.logger`，回退 `console.warn`），**不要改回静默降级**：静默时"审计随会话保存"的承诺会悄悄失效而没人知道。降级文件在 `<DSH_HOME>/agent-approval/records/<sessionId>.jsonl`（重启仍安全，但删会话不随删）。语义上仍是"跟随会话保存"：随会话目录存在，删除会话即消失。
- **绝不要把审计写进会话事件日志（v1.5.0 的方案，半天即废弃）**。踩坑全过程：`dsh-session` 的 `append()` 运行时不校验事件类型枚举，`dsh-session-persistence-jsonl` 也按原样回放——但 **`dsh-session-persistence` seam 在加载时强制校验**：`KNOWN_SESSION_EVENT_TYPES` 之外的类型，事件信封必须带 `ignorable: true`，否则**整个日志拒绝加载**（"refusing to interpret"）。而活会话的写入口 `session.append(type, data)` 只接受 type/data/surface 元数据，**给不了 ignorable 标记**（类型签名也限死 `SessionEventType`）——所以一条审批记录就会让该会话永远无法恢复。另外日志压实（compaction）也可能丢弃 ignorable 外部事件。
- **"v1.5.0 零写入"的旧结论是假的，2026-09-06 已证伪并修复**。旧版 `check-session-log.mjs` 用朴素 magic 扫描切帧且带占位符 bug，只解出部分帧就报"零写入"——实际 session-886106a4 的日志里有 **3 条**未标 ignorable 的 `agent-approval/record`（seq 52022/117810/140809），会话历史加载被拒。注意官方机制本就给插件事件留了正门：`dsh-session` 的 `known-event-types.js` 明说 **`ignorable` 标记就是 repo 外插件事件的兼容机制**（只是 `session.append` 的活写入路径给不了它）。修复用 `scripts/repair-session-log.mjs`：按 `scanZstdFrames` 的结构化走帧（逐 block header 前进，不靠帧头 content size），**只给 3 个事件的信封补 `"ignorable":true` 并重压所在帧，其余帧字节不动**——绝不能删行，扫描器强制 seq 连续（`event.seq !== events.length` 即 seq gap）。写前快照 mtime/size 防并发写、写前备份、写后全帧解码验证。校验/扫描用重写后的 `check-session-log.mjs`（可 `import { auditLog }` 库用；注意 `text-chunks`/`reasoning-chunks`/`tool-call-chunks` 是存储行、`type:"session"` 是头记录，都不进事件类型校验；`zstdDecompressSync`/`createZstdDecompress` 对多帧拼接文件只会解出第一帧，必须逐帧解）。全库 194 个日志复扫，仅此一个会话中毒。seq 140809 写于 12:27:59（"重启"之后）——说明当时仍有旧构建的 Host 半在写日志；现装 v1.5.1 已验证只剩 `permission/preset`/`sandbox/mode` 两种已知类型的 `session.append`。
- **事件词表三级解析（2026-09-11 修正，词表已漂移过一次）**：`check-session-log.mjs` 的 `KNOWN_SESSION_EVENT_TYPES` 按权威度依次尝试 ① 裸导入 `@deepseek-ai/dsh-session`（`link:` 安装的插件解析不到，通常失败）；② **DSH profile 里那份真源码的绝对路径**（`$DSH_HOME/profiles/*/node_modules/@deepseek-ai/dsh-session/lib/types/known-event-types.js`，本机实际生效的就是这一份）；③ 包内快照。CLI 会打印实际用的是哪一份。**快照必须随 DSH 升级重新同步**：0.1.3-alpha.2 → 0.1.5-rc.1 时它已经错过一次——`tool/code-dispatch`/`tool/code-dispatch-start` 被改名为 `tool/ptc-dispatch`/`tool/ptc-dispatch-start`，并新增了 `deliverables/presented`、`subagent/catalog`、`system/message`；旧快照会把**现有日志误报成"拒绝加载"**（假警）同时把已改名的类型当成已知（漏警）。②的存在就是为了让升级后自动跟上，但快照仍是最后一道防线，升级后请人工核对一次。
- **最终裁定（2026-09-06，用户明确）**：zstd 会话日志里**不存、不读任何插件自定义数据**。v1.5.2 起 `sessionRecords` **只读旁路文件**（v1.5.1 的"防御性日志折叠"已删除，`RECORD_EVENT` 常量一并移除）。日志中遗留的 3 条 ignorable record 事件（seq 52022/117810/140809）为惰性历史，加载已验证安全；**物理删除不可行**——删行会破坏 seq 连续性（扫描器以 `event.seq !== events.length` 判 gap），修复需全日志重编号，风险远大于收益，不要尝试。
- 读取：Host `sessionRecords({ sessionId })` **只读旁路文件**（`_recordsFileOf`），按 `at` 正序返回，同时带 `enabled`（该会话当前是否开启）。Client「审批」tab 挂载 + 每 10s 轮询（tab 未激活时不渲染、不轮询）。
- 每条：时间、会话、工具、结论、风险等级、审批模型、耗时、理由（截断 600）、**工具参数**（v1.6.0 起 `evidenceText` 头+尾渲染、预算 2000；`…[N chars omitted]…` 表示该记录的参数不完整，「加白」按钮对这类记录直接不出现）、`childSessionId`（审批 Agent 自己的会话短 id——在会话列表里能找到完整推理记录）。
- **追加必须吞错**：`_record` 是 fire-and-forget 且全链 try/catch——审计失败绝不影响审批主流程。没有"清空记录"：随会话存储的事实源，且权威审计（`approval/asked`+`approval/decided` 事件对）本就不归我们管。
- **v1.4 → v1.5 迁移**：`scripts/migrate-records.mjs`（`--dry-run` 可预览）把旧全局 `records.jsonl` 按短 sessionId（UUID 前 8 字符）匹配到 `~/.dsh/sessions/<workspace>/<session-id>/`，追加写入各会话的 `agent-approval.jsonl`（幂等去重），最后把旧文件改名为 `records.jsonl.migrated` 防止重复迁移。历史 bug 行（`sessionId` 为字面 `"session-"`）无法归属，直接跳过。本机已迁移：157 条 → 8 个会话，56 条无法归属。
- **必须整形状构造**（`typert.host.js` 的 result schema 是 strict）：每个字段都在、类型正确，数组用 `.readonly()`。新增字段要同步改三处（index.js 构造、typert schema、client 展示）。
- **短 id 切片必须跳过 `session-` 前缀**：DSH 的 sessionId 是 `session-${randomUUID()}` 格式（见 `dsh-host-apiproxy/lib/index.js` 的 `session create`：`session-${randomUUID()}`），前缀正好 8 字符，`String(id).slice(0, 8)` 只会切到那个无意义的前缀——历史 bug：所有审计行的 `sessionId` 全是 `"session-"`，已开启会话 chip 显示也是。Host 的 `shortId()`（现在在 `lib/pure.js`）/ Client 的 `shortSessionId()` 都必须先剥掉前缀再取 8 字符；`childSessionId` 来自 `run.id`（= 子会话 id，形如 `session-<uuid>`，同一函数兼容）。**不要**改回 naive slice——会再次触发。

### 7. Client 半：bundle 格式

- 必须 `window.__ModuleLoader__.load({ id, factory })`，`exports.inject = ["slots", "remote"]`。
- **按钮一律用官方 Button 原子**：`const ui = require("@deepseek-ai/dsh-client-ui-primitives")`，`h(ui.Button, { variant: "primary"|"ghost"|"outline", size: "sm", onClick }, "…")`。自定义 `.aapr-btn` 按钮样式已移除——它不跟 `--dsw-alias-button-*` token 家族，深色模式下难看（与 dsh-memory-manager 踩过的同一个坑，同一个修法）。
- **Remote 命名空间必须自挂载**：`await ctx.remote.$mount(CLIENT_REMOTE)`（dsh-api-remotes 只挂载官方命名空间），然后 `ctx.get("remote.agentApproval")`。描述符与 `typert.host.js` 的 invocation 一一对应；浏览器没有 zod，用 passthrough schema（`{ parse: (v) => v }`）。
- **返回值双层信封**：gateway 返回 `res.value` = Host 方法的 `{ ok, value }` 信封，client 的 `pick()` 做容忍双形状解包 + 双层错误上抛（token-stats 踩过"多包一层"的坑）。
- **CSS 注入**用 `document.createElement("style")` + `ctx.effect(() => () => styleTag.remove())`；样式一律用 `--dsw-alias-*` 主题变量。
- 两个 Slot：`settings.section`（id `agent-approval`，order 30，label `() => SETTINGS_LABEL`）+ `conversation.view`（id `agent-approval-audit`，**order 11**——chat=0、trajectory=10，紧邻轨迹；label `() => "审批"`）。conversation.view 是 **session-scoped list slot**：组件经标准 kit 拿到 `useSession` hook，`useSession((s) => s)` 的快照读 `sessionId` 叶子字段即可，无需 inject；组件只在 tab 激活时渲染（`renderSlot(..., { only: active.id })`），轮询因此零闲置开销。tab 栏渲染条件是 `tabs.length > 1`，注册即出现。曾有过 `conversation.input.left` 的「🛡 审批」chip（id `agent-approval-toggle`，order 15，InputZone owner props 传 `props.session`，只读 `sessionId` 叶子字段），已移除——开关本就属于 /permission 菜单，菜单旁边再放一个开关是冗余。
- **设置导航图标**：DSH 0.1.x 的 `settings.section` 只投影 `id/order/label`，设置壳对每个外部 section 统一画通用齿轮（`client-ui-settings-general` 的 `navIcon()`，没有公开图标字段）。client.js 里 `registerSettingsNavIcon(SETTINGS_LABEL)` 用 MutationObserver 给 `[role="dialog"] nav button` 中文本等于 section label 的行打 `data-dsh-agent-approval-settings-nav` 标记，CSS 再隐藏 `>svg:first-child` 齿轮、用 `currentColor` mask 画 shield-check Lucide 图标（16px，跟随原生 hover/active 颜色）。换图标只需替换 CSS 里 data URI 的 SVG path（Lucide，24×24，stroke-width 2，stroke 用 black——mask 只取 alpha）。
- **MutationObserver 必须合帧（v1.6.0 性能修复）**：两个注册器都监听 `document.body` 且带 `characterData`，流式输出时**每个 token 都会触发一次** mutation；v1.6.0 前每次都在回调里同步跑全文档 `querySelectorAll`（含 `document.querySelectorAll("button")` 逐按钮 `:scope > span` + `closest('[role="dialog"]')`），造成明显掉帧。现在统一走 `frameCoalesced(run)`：每帧最多扫一次（rAF，回退 `setTimeout(…,16)`）。**新增观察者请复用 `frameCoalesced`，不要在回调里直接 sync。**
- client.js 里**不要用 `?.` / `??`**（与 token-stats 保持一致的保守写法），用 `&&`/`||`；不要 `import`，用 `require("react")`。

### 8. 权限菜单集成（`permission` 行覆盖 + `permission/preset` 事件联动）

权限菜单（输入框 `/permission` 控件）的选项来自 **`dsh-permission-presets` 的 Config 预设表**；Web 端切换 = 执行 `/permission <preset>` 命令 → 追加 `permission/preset` 事件 + 旋钮事件。要让「Agent 审批」出现在菜单里：

1. **包的 `cordis.patch.yml`（bundle patch）里写 `- id: permission` 覆盖行**，把 `agent-approval`（bundle = workspace-write + ask）加进预设表。**patch 语义是整行替换 config（不合并）**，所以必须重述全表（read-only / workspace-write / **agent-approval** / danger-full-access）——**声明顺序即菜单顺序**，agent-approval 排在 Full access 上面；DSH 升级若改了基础表要手动同步。
2. **菜单图标（v1.3.2+ 由插件内置，无需 patch）**：菜单行 + 触发按钮的图标来自编译进官方 `dsh-client-ui-conversation` 的硬编码映射 `permissionGlyphs`（源码注释明说 "host-configured names outside the design set get none"），**没有公开注册口**，外部预设整行不渲染图标元素。client.js 的 `registerPermissionGlyphIcon(SETTINGS_LABEL)` 用 MutationObserver 给「Agent 审批」的 `/permission` 菜单行（`[role="menu"] button[role="menuitem"]` 中文本等于 label 者）和输入框旁触发按钮（非 menuitem、不在 `[role="dialog"]` 内、首 span 文本等于 label 且含 svg 者）分别打 `data-dsh-agent-approval-perm-item` / `data-dsh-agent-approval-perm-trigger` 标记，CSS 再用 `currentColor` mask 画盾牌 + AI 星形（16×16，与出厂图标同风格）。**菜单行有 glyph-set 守卫**：只在"兄弟行已带官方图标"的菜单里打标——判定为菜单内存在 `span[class*="_itemIcon_"]`（CSS-modules 编译保留源类名子串；选中行的对勾是 `_check_`，不会误判）。设置页 → 通用 → 「权限」行的默认预设下拉（`Menu portal:true` 传送到 `<body>`，所有预设都无图标）因此**不再**被误标——否则「Agent 审批」会成为那里唯一带图标的行。历史方案 `scripts/patch-glyph.mjs`（直接补丁官方编译产物）已被取代——插件内置版随包分发、DSH 升级不丢；脚本保留作参考，新安装**不再需要**跑它。
3. **同 bundle 歧义规则**：`agent-approval` 与 `workspace-write` 的旋钮值完全相同；`derive()` 里"仍匹配的最后选中预设"赢得平局，所以**菜单显示什么完全由最后的 `permission/preset` 事件决定**。因此：命令开启时也追加 `permission/preset: agent-approval`（菜单同步显示）；命令关闭时按恢复的旋钮值回写正确的预设事件（跳过我们自己的条目），否则菜单会卡在「Agent 审批」。
4. **事件联动**（`session/event` 监听 `permission/preset`）：
   - 选中 `agent-approval` → `_enableCore`（此刻旋钮事件还没落，捕获的 prev 恰是切换前的值；我们写的旋钮值与预设服务随后要写的相同，它检查后跳过，无重复事件）。
   - 选中其他预设 → 只删 bookkeeping，**不恢复旋钮**（预设服务马上写自己的旋钮，恢复会打架）。
5. **跨重启存活（v1.6.0 起不含委派子会话）**：`agent/created` 监听在（重）发布时折叠日志——`permission/preset` 折出 `agent-approval` 就重新启用。**但是**：spawn 的审批员子会话不带 preset 事件（无 seed）；fork 子会话的 seed 里**带**父级的 preset 事件，而 `pinInitialPermission` 不会为它改写（`selected !== null`）——若不拦截，`_enableCore` 会执行 `approval.setPolicy(agent, "ask")`，**把委派机制钉死的 `never` 覆盖掉**，等于让被委派的子代理拿到它本不该有的提权通道。因此 v1.6.0 起判据是 `_isDelegatedChild(session)`（纯函数 `isDelegatedChildHeader()`）：**只认 `header.origin === "subagent"`**，命中就 return，不自动启用。用户在某个活着的子会话里**显式**选预设仍会生效（`session/event` 路径不动，用户意图优先）。
   **⚠️ 绝对不要改成 `|| header.parentSession !== undefined`（v1.6.0 第一版踩过，已修）**：只有委派会写 `origin: "subagent"`（`dsh-subagent` 的 `childSessionMeta` 每个子会话都写），而**用户自己的 fork**（`dsh-api-session-controller` 的 session fork）只写 `meta.parentSession` + `isSeeded`、**不写 origin**，也不会被 `pinInitialPermission` 钉成 `never`。用 `parentSession` 当判据会把用户 fork 误判成委派子会话，于是它 seed 里的 `agent-approval` **永远不会**重新启用——而 `/permission` 菜单仍显示该预设为选中态、审计页却写"未开启"，每次提权都退回人工弹窗。harness 自己的判据也是 `origin === "subagent"`（`hasApiSessionSubagentOwner`）。测试已固定该行为（`isDelegatedChildHeader` 用例）。
6. **防御**：`_presetRegistered()` 先确认表里有 `agent-approval` 才追加 preset 事件——没装覆盖行时，追加会被会话不变量（unknown preset）直接抛错。
7. **宿主 Session API 兼容（v1.4.2 修复的真实故障）**：DSH 0.1.2-rc.1 **删除了 `session.events` 公开快照数组**，改为 `snapshotEvents(from?, to?)` / `eventAt(seq)` / `seq`。插件所有日志折叠（`_lastKnob` / `_callArgsOf` / `_recentUserContext`）必须走 `_eventsOf(session)`（新 API 优先，legacy 数组兜底）。0.1.1→0.1.2-rc.1 升级后的症状极具欺骗性：监听器 try/catch 把 TypeError 吞掉，`_enableCore` 静默失败，没有任何会话能进入 `_enabled`，于是每个提权都 `next()` 落回人工弹窗——看起来"插件在运行但就是不审批"。**改任何读日志的代码前先确认没用裸 `session.events`。**
8. （已随 composer chip 的移除而作废）曾有的 chip 每 10s 轮询一次 enabled 状态；若未来重加 chip，注意 InputZone 的 ConversationSnapshot **没有** projections 字段，读不了 `permissions` 投影，只能轮询。

### 9. 标准安装 = dsh bundle（package.json 声明 + 包内 cordis.patch.yml）

本插件是**标准 DSH bundle**：`package.json` 的 `dsh.bundle.patch` 指向包内 `cordis.patch.yml`，用官方 `dsh plugin` 命令安装：

1. `dsh plugin --profile web add <本地路径或包>`：pnpm 把插件装成 profile 的 npm 依赖（本地路径走 `link:` 软链，改代码即生效），并把包名追加到 profile `package.json` 的 `dsh.profile.bundles`。**`link:` 安装的前提：插件目录里必须已经 `npm install` 出 `node_modules`**——loader 从链接的**真实路径**加载 `index.js`，其裸导入（`@deepseek-ai/cordis`、`@deepseek-ai/dsh-typert-protocol`、`zod`）从插件自己的 `node_modules` 解析；缺了会在启动时 `ERR_MODULE_NOT_FOUND`，**整个 DSH 起不来**（2026-08-27 实踩）。对齐宿主版本避免双副本漂移：`npm install --no-save --registry=https://registry.npmjs.org @deepseek-ai/cordis@<宿主版本> @deepseek-ai/dsh-typert-protocol@<宿主版本> zod@^4.4.3`（宿主版本从桌面安装目录的 `.pnpm` 仓查）。
2. 启动时 DSH 应用包内 `cordis.patch.yml`，做两件事：**`- insert:`** 新增插件挂载行（**不要**对不存在的 id 用普通 `- id:`，会报 "entry not found"）；**`- id: permission`** 覆盖预设表行（该 id 已存在，覆盖合法）：

```yaml
# cordis.patch.yml（随包分发）
- insert:
  - id: agent-approval
    name: '@duke-dsh-plugins/dsh-agent-approval'

- id: permission
  name: '@deepseek-ai/dsh-permission-presets'
  config:
    presets:
      read-only: { sandbox: read-only, approval: ask }
      workspace-write: { sandbox: workspace-write, approval: ask }
      agent-approval:
        sandbox: workspace-write
        approval: ask
        name: Agent 审批
        description: workspace-write base; an independent approval agent judges every escalation, risky ones are rejected.
      danger-full-access: { sandbox: danger-full-access, approval: never }
```

3. **不要**再在 profile 的 `cordis.patch.yml` 里手工插这些行，否则同一 id 重复挂载、permission 表重复覆盖。
4. 重启 DSH。**必须重启**，Host 加载、typert 注册、client bundle 注入都在启动时发生。
5. 卸载：`dsh plugin --profile web remove dsh-agent-approval`（自动从 bundles 列表移除）。**注意卸载的副作用**：历史会话日志里已经写着 `permission/preset: agent-approval`，而 `dsh-permission-presets` 的 invariant 会在安装时**重放校验全部会话日志**并对未知预设名 fail（`permission/preset names unknown preset "agent-approval"`）。所以卸载/去掉 `permission` 覆盖行后，那些会话会在下次启动报不变量错误。当前没有安全的自清洁手段（**不要**去改会话日志去重编号 seq），只能：先在各会话里切回其他预设再卸载，或接受这些会话的报错。
6. **可选（权限菜单图标）**：菜单图标在官方 bundle 的硬编码映射里，标准安装不会补——本地开发想要图标就 `npm run patch:glyph`（见第 8 节）。

## 开发 / 验证

```bash
npm run check            # node --check：index.js / lib/pure.js / client.js / typert.host.js / scripts/*.mjs
npm test                 # node --test：lib/pure.js 的纯逻辑单测（不需要 node_modules）
npm run verify           # check + test（CI 跑这个）
dsh plugin --profile web add /path/to/dsh-agent-approval   # 安装/重装到本机 DSH profile
npm run patch:glyph      # 可选：权限菜单图标（幂等）
```

> `npm test` 用 `node --test test/`，它**会为每个测试文件 spawn 子进程**。在带严格沙箱的环境里（子进程管道 stdio 被禁）会报 `EPERM`，此时用 `node --test --test-isolation=none "test/**/*.test.mjs"` 在单进程内跑——这是环境限制，不是测试失败。

改插件后**必须重启 DSH 进程**才生效。**手工验证清单（⚠️ 截至 2026-09-11 在本机一次都没执行过——本机 profile 未安装本插件；状态见下方"宿主版本与验证状态"）**：
1. 输入框 `/permission` 菜单出现第四项 **Agent 审批**；设置 → 侧栏导航出现 **Agent 审批** 页（模型/超时可保存）。
2. 用 `/agent-approval on` 或菜单选 **Agent 审批** 为会话开启（两条路径等价）；输入框左侧**不再有**「🛡 审批」chip。
3. 开启后让工作区内命令触发一次提权重试（`sandbox_permissions`）：**不弹人工审批**，片刻后工具结果即为批准/拒绝；会话窗口顶部出现**「审批」标签页**（轨迹旁），点开能看到这条记录（含风险等级与理由；10s 内自动刷新，也可手动点「刷新」）。
4. `/agent-approval off` 关闭：沙箱模式与审批策略恢复开启前的值，菜单同步切回对应预设；再次提权回到人工弹窗（ask）或原策略行为。
5. 菜单切到 danger-full-access：模式自动关闭（`permission/preset` 事件联动，立即生效）；菜单切回 Agent 审批：模式自动开启，无需手动执行命令。
6. 把审批超时调成 30000ms、审批模型指向一个不存在的路由 → 提权应 fail-closed 拒绝并记录 `unavailable`。
7. 设置页加一条 allow 规则（如工具 `pwsh` + match 子串）→ 命中的提权**不再起审批子代理**，审计 model 列显示 `rule`；模型批准的提权在同一会话内以完全相同参数再次发起 → 直接放行，model 列显示 `trust`；「审批」tab 审计行点「加白」→ 规则表新增对应 allow 规则。
8. **全量放行被拒（v1.6.0）**：设置页填 `effect=放行`、`tool=*`、`match` 留空（或只填空格）→ 保存应报错 `invalid-rule`（同样的形状选「拒绝」则允许）。
9. **委派子会话不被自动开启，用户 fork 仍会被自动开启（v1.6.0，两者别搞混）**：由 subagent 委派产生的 fork 子会话（`header.origin === "subagent"`）在重启后审批策略应仍是 `never`（日志里最后一次 `approval/policy` 仍是 `source: "delegation"`），不会出现插件写的 `ask`；而**用户在侧栏 fork 出来的会话**（只有 `parentSession`、没有 origin）继承 seed 里的 `agent-approval` preset 后，必须照旧被 `agent/created` 自动开启（否则菜单显示已选中、实际不裁决）。

## 宿主版本与验证状态（2026-09-11 起，先读）

本机环境：DSH profile 只有 **`desktop`**（**没有** `web`），宿主 **0.1.5-rc.1**，cordis **4.0.2**，zod **4.5.4**；`0.1.3-alpha.2` 的 tarball 已随本次升级从 `desktop-packages/` 删除。下面这份"某行为是否可用"的结论，权威来源永远是 `~/.dsh/profiles/desktop/node_modules/@deepseek-ai/*/lib/*.js` 的真源码，不是本文档。

**⚠️ 本插件至今从未在真实 DSH 里加载运行过。** 本机 profile 没装它，下面所有结论都来自**离线**检查；写提交信息/文档/PR 时不要声称做过运行时验证。

| 已做（可复现） | 结论 |
|---|---|
| `npm run check` | 全部 `.js` / `.mjs` 语法通过 |
| `node --test --test-isolation=none "test/**/*.test.mjs"` | **24/24** 通过 |
| 离线集成检查（跑真业务代码 + typert-loader 校验规则 + strict wire schema `.parse()`） | **120/120** 通过 |
| `scripts/check-session-log.mjs` 打真实会话日志 | 正常（词表解析到 profile 内真源码） |
| **0.1.3-alpha.2 → 0.1.5-rc.1 静态漂移审计**（逐条对照安装版源码） | 插件依赖的宿主 API **全部仍在、形状兼容** |
| 真实 DSH 加载 / 端到端审批 / 浏览器 UI / release workflow | **未验证** |

**漂移审计覆盖的宿主面**（下列每一条都在 0.1.5-rc.1 安装版源码里核对过，升级后仍然成立）：

- 审批：`approval/request` 以 `scopeTarget(req.agent, req.agent)` 派发（**untagged 监听器一律放行**，`hook.global || !filter || filter(...)`），`OUTCOMES` 仍是四元组、`allowed-once` 仍是唯一授权值；`overrideOf(session)` / `config.policy` / `setPolicy(agent, policy)` 均在；`never` 仍在瀑布之前短路为 `rejected`。
- 会话：`snapshotEvents(from, to)` / `append(type, data)` / `header` 均在；`validateSessionHeader` 里 **`origin` 仍只允许 `"subagent"`**、`parentSession` 仍可单独存在（这正是用户 fork 的判据基础，见 8.5）；`session/event`、`agent/created`（载荷 `{agent}`）、`session/disposed`（参数 `[session]`）、`agents.get(id)` 形状不变。
- 权限表：基础组合的 `- id: permission` 行**未改名**（`@deepseek-ai/dsh-permission-presets`），Config 字段仍是 `sandbox`/`approval`/`name`/`description`，`SANDBOX_MODES` 仍含 `read-only`——所以包内 `cordis.patch.yml` 的整表覆盖照旧合法。
- 子代理：`subagents.start("spawn", …)` 仍接受 `outputSchema`/`toolFilter`/`persona`/`agentOptions`，`assertObjectJsonSchema` 仍在；返回 `{id, result, dispose}`，`result.{structured, stopReason}`；干净跑完但没有结构化捕获时 stopReason 被**强制成 `error`**。
- 可选面：`sessionPersistence.locate(meta)` 仍在 JSONL 后端原型上（**依然不是公开 API**）；`sessionTitle.get`、`agentDefaultModel.currentSelection`、`llm.listProviders/listModels`、`systemPrompt.context({name,order,text})`、`commands.register`（invocation 有 `rawInput`/`agent`）全部在位。
- Typert / Client：manifest 校验规则（`package`/`face`/`schemas`/`model.services|events|objects`/`invocations` + strict codec `{mode:"strict",typeSymbol,schema}`）不变，本包 manifest 逐条合规；`./typert` 导出、`window.__ModuleLoader__`、`ctx.remote.$mount`、`dsh.client.platform` 均在；`conversation.view` 仍是 chat=0 / trajectory=10、tab 栏条件仍是 `tabs.length > 1`；官方 `permissionGlyphs` 仍**不含** `agent-approval`（所以内置 MutationObserver 方案仍必需），`_itemIcon_` 类名仍在。

**重跑离线集成检查**（需要宿主包，跑完务必清理 `node_modules`，见第 9 节）：装 `cordis 4.0.2` + `dsh-typert-protocol 0.1.5-rc.1` + `zod 4.5.4`，**并且必须补 `@deepseek-ai/cosmokit`**（cordis 直接 import 它，缺了连 `import("@deepseek-ai/cordis")` 都 ERR_MODULE_NOT_FOUND）。两个坑：① **npm 11 会静默跳过** 以本地 tarball 路径给出的包（`added 1 package` 却什么都没装），用 `tar -xzf <tarball>` 直接解到 `node_modules/@deepseek-ai/<name>/` 最可靠；② 构造服务**不要用 `new Svc(ctx, {})`**（cordis `Service` 基类要真 Context，报 `Cannot read properties of undefined (reading 'provide')`），用 `Object.create(Svc.prototype)` + 手工填 `_rules`/`_trusted`/`_enabled`/`_warned`/`_model`/`_timeoutMs` 并把 `_persistConfig` 打成桩——这样跑的是真业务代码。**注意**：桩掉 `_record` 后就测不到真实审计写入，想测真 `_record` 要 `delete s._record` 让原型方法生效。

## 发布

打 `v*` 标签推送 GitHub，`.github/workflows/release.yml` 跑 `npm run verify` + `npm pack`，把 tarball 改名为 `dsh-agent-approval-<version>.tgz` 后发布 GitHub Release 并（Node 24 + Trusted Publishing）发 npm；Release 正文里的安装 URL 由 `github.repository` / `github.ref_name` / `needs.build.outputs.version` 拼出，不再手写版本号（历史坑：正文写死的 v1.3.4 链接指向了 1.3.2 的 tarball 名）。发布需要 `GH_TOKEN` secret（回退 `GITHUB_TOKEN`）。

## 常规注意事项

- **不要直接编辑 `~/.dsh/profiles/web/cordis.yml`**（生成文件，patch 写在 `cordis.patch.yml`）。
- 监听器**绝不能抛异常**：瀑布层的兜底会把异常归一为 `unavailable`，但要自己 catch 并记录，否则审计里看不到原因。
- 声称（claim）的范围是"该会话的**所有** approval 请求"——不止 pwsh/bash 提权，也包括任何 `tools/pre-execute` 产生的人工 ask。这是有意语义（"帮我审批"），提示词写成通用审批口径。
- `approval.setPolicy` 会在模型上下文里注入 "changed by the user" 通知——用户确实主动开了开关，语义可接受；不要绕开它手写 `approval/policy` 事件（会丢失通知）。
- 审批模型未配置时使用 **Harness 默认路由**（`agentDefaultModel.currentSelection()`；该可选服务缺席或解析为空时才退化为继承请求会话路由）；配置后走 `agentOptions` 精确覆盖。**刻意不跟随请求会话的模型**——审批口径必须稳定可预期，不随各会话的模型切换而漂移。
- 审计记录（v1.5.1 起）存在**会话存储目录内的旁路文件** `<sessionDir>/agent-approval.jsonl`（经 `sessionPersistence.locate` 定位，**该 hook 非公开 API**，失效时降级并在宿主日志告警；v1.4→v1.5 迁移用 `scripts/migrate-records.mjs`，见第 6 节）；插件只持久化**设置**——审批模型、超时与规则在 `<DSH_HOME>/agent-approval/config.json`（重启恢复，不再回落默认；写盘用 tmp+rename，避免半截 JSON 让 `_loadPersisted` 静默丢表）。持久化失败是 best-effort 静默降级，绝不影响审批主流程。DSH 的权威审计仍在会话日志的 `approval/asked` + `approval/decided` 事件对（本插件不破坏该配对，只在瀑布层给结论）。
- **规则表与审批模型是全局的**（不区分 workspace / session），且规则增删**不进审计**。加规则时要意识到它会影响所有开启本模式的会话；这也是 v1.6.0 拒绝"全量放行"规则的原因。
- **Remote 面按"可信客户端"对待**：`toggle` / `sessionRecords` / `addRule` / `setModel` 都没有调用方归属校验（任意能到达 gateway 的客户端可读任意活会话的审计、改全局规则）。今天 Web 客户端与人工审批者同属一个信任域（能弹窗批准的人本来就能放行一切），所以不构成提权；但**不要**把它当成跨信任域的接口暴露出去。
- **这个模式是风险削减，不是沙箱边界**：裁决者是 LLM，请求方控制操作内容与理由。真正的隔离边界始终是 OS 级沙箱（`workspace-write` / `danger-full-access`）；不要把"有审批 Agent"当成分权或多租户隔离手段。
- 开启本模式会**同时**做两件影响权限的事：把沙箱基线钉到 `workspace-write`（从 `read-only` 起算就是放宽），并把人工弹窗换成模型裁决。文档/UI 文案必须如实说明，不要只描述机制。
