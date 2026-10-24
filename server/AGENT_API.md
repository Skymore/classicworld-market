# 冒险助手与只读数据工具

网页入口 `/agent` 面向 **Global MapleStory Classic World / 冒险岛经典世界国际服**，支持职业技能、加点建议、练级地图、任务、NPC、装备、掉落参考及市场买卖。使用 GPT‑6 Luna、真实流式输出和随账号保存的多轮对话。助手可自己选择工具、读取结果、继续查询，再回答；最多 5 次模型请求、10 次工具调用。只开放查询，不能下单、上架或修改游戏数据。用户背包、角色等级和已有技能点不在公开数据中。

## 游戏版本与攻略依据

`agent/adventure-data.json` 固定来自 [OSMS Data Explorer 的 2026-10-21 客户端提取提交](https://github.com/ohmi69/osms_datamine_dashboard/commit/63db09449642c4bf3414276223e4cb7d72af02d9)，包含 93 个新手/一转/二转技能、343 个任务、103 种非测试怪物、334 张非开发地图和 301 个 NPC。保留结构化技能效果、每级效果、前置技能、任务条件和奖励，不收录任务对话及图像。此来源是社区客户端提取，不能称为 Nexon 官方攻略；来源版本、日期和固定链接随工具结果返回。中文地图/怪物/NPC 别名只用旧目录的名称映射，不复制旧数值，不声称是国际服官方中文翻译。

正式版与 CoT2、现代 GMS、旧 v83、国台服、Artale/MapleLand、私服必须区分。职业与技能建议先调用技能工具；数值事实与建议的加点顺序分开，不能把建议说成官方最优加点。没有记录的等级效果不能外推。已保存的旧助手回答不作为事实依据，发现冲突要更正。客户端记录不保证服务器已开放相应任务，也不证明掉率、活动日历、制造/公民的服务器规则；缺失内容明确说明。

站内掉落表仍包含 CoT2 目录参考，`get_item` 和怪物详情把它放在单独的 `drop_reference` 中，明确标为尚未核对正式服，不能与新客户端属性混成“当前保证掉率”。原有价格工具继续查询本站实际采集记录。

多候选比较可在一轮请求多个工具；总执行数仍最多 10 次，超出预算的调用返回额度提示而不访问数据库，随后强制模型根据已有证据作答，不因候选较多丢弃整个推荐。

## 联网搜索与内置指南

新增 12 篇中文常见问题笔记，保存在 `agent/knowledge/*.md`，索引与核对信息在 `agent/knowledge/index.json`。范围包括版本与入门、转职、猎人技能、练级、任务、交易限制、KPQ、制造、公民、住房、装备买卖和活动。正文是重新整理的短笔记，来源标为官方、社区、客户端提取或本站方法；核对日期不是原文发布日期。修改正文后需一并核对索引日期与来源；新增文件还需加入 `knowledge.rs` 的编译清单。

常见问题先用 `search_guides`；返回相关短文全文，可再用 `get_guide` 读取指定 ID。过了索引中 `review_after_days` 的文档标记为 `needs_refresh`；活动始终要求查新。用户明确问最新、最近、当前开放状态或要求搜索时，模型必须调用 `search_web`，不能把本地文档说成刚联网核实的结果。

联网调用使用 [OpenRouter 的 `openrouter:web_search` 服务端工具](https://openrouter.ai/docs/guides/features/server-tools/web-search)，固定 Exa 引擎并沿用现有服务端配置。只发本轮生成的简短搜索词，不自动附带完整历史或账号凭据。每次检索至多 4 条、每条最多 4,000 字符，每轮助手对话至多 2 次检索；同查询缓存 5 分钟，最多 64 条。公共搜索工具接口另受 IP 限频和现有模型并发额度限制。搜索费用从现有 OpenRouter 额度计费，不需要另填搜索 API key。

搜索辅助请求的模型正文不作为证据，只采信搜索服务返回的 `url_citation` 中的地址、标题和摘录。结果限制在 Nexon、Steam 的 MapleStory 页面与选定 Classic World 社区；Reddit 仅接受 `r/MSClassicWorld`。不开放任意 URL 抓取、SQL 或本机访问。网页内容作为不可信资料处理。搜索结果标明 `searched_at`、`published_at`（未知保持空）和来源类型；搜索索引可能滞后，摘录不是整页阅读，更不能用检索时间冒充发表时间。搜索失败、无证据或超出次数时明确返回错误，助手只能使用有日期的已有资料并说明限制。

`GET /api/v1/agent/knowledge` 返回目录，`GET /api/v1/agent/knowledge/{id}` 返回笔记正文与来源，均只读；网页右上角“指南”可直接浏览、搜索。来源链接在本轮工具返回后才可作为外部引用点击。旧的账号历史、停止/重试及真实流式输出继续使用原接口。

## OpenRouter 配置

服务进程环境变量：

```powershell
$env:OPENROUTER_API_KEY = '<你的 OpenRouter API key>'
$env:OPENROUTER_MODEL = 'openrouter/free'
# 然后以原来的方式启动 market-web 或 supervisor
```

也支持私有文件 `shared_data/openrouter.json`：`{"api_key":"...","model":"openrouter/free"}`。从仓库根目录启动时自动读取；其他目录启动可设置 `OPENROUTER_CONFIG` 为该文件的绝对路径。部署器和 supervisor 会把该路径传给服务，密钥不放进发布包。`OPENROUTER_API_KEY` 优先于文件，`OPENROUTER_MODEL` 优先于文件中的模型设置。

Docker Compose 用户在本机 `server/.env` 中设置这两个变量，再启动 `web` 服务。密钥只在服务端使用，不放进网页或 Git。默认 `openrouter/free`，也可指定以 `:free` 结尾的模型；免费模式向 OpenRouter 发送输入/输出价格上限 0。另支持显式配置 `openai/gpt-6-luna`（按量收费），使用原生工具调用并设 `reasoning.effort=none`，不自动切换到其他模型。界面展示服务端实际模型。没有密钥时，对话返回 `agent_not_configured`，数据接口仍可用。

参考：[免费路由](https://openrouter.ai/openrouter/free)、[工具调用](https://openrouter.ai/docs/guides/features/tool-calling)、[额度](https://openrouter.ai/docs/api/reference/limits)。

## 供其他 agent 调用

`GET /api/v1/agent/tools` 返回 OpenAI 兼容的 `tools` function schemas、`read_only`、对话是否启用及当前模型。把 `tools` 原样提供给支持 function calling 的模型，然后将其 `function.arguments` 解析为 JSON，POST 到 `/api/v1/agent/tools/{function.name}`。将返回 JSON 作为对应 `tool_call_id` 的 tool message 发回模型；按需重复。

| 工具 | 参数 | 内容 |
|---|---|---|
| `search_guides` | `query?` | 检索内置中文 FAQ；空查询列目录，非空查询返回至多 3 篇相关全文与来源 |
| `get_guide` | `guide_id` | 读取指定笔记，返回核对日期、来源、刷新要求 |
| `search_web` | `query`, `official_only?` | 联网检索国际服资料；返回真实搜索来源、摘录和检索时间，默认允许精选社区，`true` 仅查官方 |
| `get_game_rules` | 无 | 游戏定位、职业列表、数据日期、覆盖和限制 |
| `get_skills` | `class_name?`, `query?`, `rank?` | 指定职业或名称的技能、上限、前置、首级/满级效果；可查某一级效果，不替用户虚构完整加点 |
| `search_game_data` | `kind`, `query?`, `min_level?`, `max_level?` | `monster/map/npc/quest` 搜索；怪物与任务可按等级筛选，最多 12 个候选 |
| `get_game_entity` | `kind`, `id` | 怪物数值/地图、地图刷怪/出口/NPC、NPC 地点、任务条件/奖励 |
| `search_items` | `query?`, `subcategory?`, `job?`, `min_level?`, `max_level?` | 名称或 ID 搜索，也可按装备部位、职业、等级筛选；包含该职业可用的通用装备，最多 12 个候选，带观察报价摘要 |
| `get_item` | `item_id` | 物品信息、NPC 买入渠道与地图、卖给 NPC 的参考价 |
| `get_listings` | `item_id`, `limit?`, `channel?`, `max_unit_price?` | 近 72 小时报价，由便宜到贵，保留位置、库存、装备、来源、观察时间 |
| `get_recent_sales` | `item_id?`, `limit?`, `hours?` | 按时间倒序的推定成交证据 |
| `get_price_advice` | `item_id`, `hours?` | 站内快卖/正常卖建议、报价摘要、指定时段的成交中位/四分位与样本数 |
| `get_market_overview` | `limit?`, `sort?` | `active` 近期活跃或 `falling` 24 小时跌价的物品概览 |

市场工具的 `limit` 默认 10、范围 1–20；`hours` 默认 72、范围 1–720，按当前时间截取。定价建议使用站内原有 72 小时统计，与自选时段的证据分开返回。所有工具返回 `generated_at` 和对应的数据局限说明，缺失值保持 `null`，无样本不推测卖价。`unit_basis=item|set` 区分按个/组；飞镖按组。怪物搜索的 EXP/HP 排序只做理论比较，不等于实测每小时经验；刷怪点数不等于在线怪物数量。任务详情保留职业、等级、前置、选择奖励等条件。

例如“40–50级弓手披风”使用 `search_items` 参数 `{"subcategory":"披风","job":"archer","min_level":40,"max_level":50}`；职业和等级不拼进物品名称。等级范围 0–250；`job` 可为 `beginner|warrior|magician|archer|thief|pirate`。至少提供一个名称或筛选条件。多个符合条件的装备是可比较的推荐候选，不要求用户预先知道具体物品名。

目录未记录职业限制的装备也保留为候选，并以 `job_compatibility=unknown_verify_in_game` 明确标注；空值不代表不适用，也不直接视为通用装备。已知职业限制不符的装备仍排除。推荐时提示在游戏内核对限制。

未指定的职业、部位、等级、频道、价格上限及成交物品筛选可省略或传 `null`。工具 schema 明确这些筛选可为空，避免模型将未指定条件填成新手职业、1 频道或 0 价格。`query`、`limit`、`hours`、`sort` 保留各自原有默认值。

模型偶尔输出的工具协议文本不再直接展示；完整、合法且位于白名单的 XML 调用会转换为真实查询，其余协议文本会要求模型重新生成自然语言回答。仍受同一参数校验、只读权限和调用次数限制。

挂单的 `purchase_details` 明确给出每组价格、每组物品数、剩余购买组数及按报价单位折算的剩余量。成交的 `sale_details` 单独给出推定物品数、购买组数和总金额，未知值不计算。工具接口省略旧界面使用的歧义字段 `stock`、`bundle`、`sale_price`，避免把组数当成物品数或把一组价格当成整笔金额。

```sh
curl https://mxd.ruit.me/api/v1/agent/tools/search_items \
  -H 'Content-Type: application/json' -d '{"query":"钢铁"}'

curl https://mxd.ruit.me/api/v1/agent/tools/get_price_advice \
  -H 'Content-Type: application/json' -d '{"item_id":4010001,"hours":72}'
```

以上为发布后的接口路径；本地开发将域名换成运行中的本地地址。名称与 ID 请以搜索结果为准。

## 对话接口

`POST /api/v1/agent/chat`：

```json
{"message":"我要卖钢铁，挂多少合适？","history":[],"language":"zh"}
```

`message` 1–2000 字符；`history` 最多 12 条 `{role: "user"|"assistant", content: "..."}`，每条最多 4000 字符；`language=zh|en`。请求体上限 32 KiB。响应包含 `answer`、`model`、实际执行的 `tool_calls`（名称、参数、是否成功）、来自成功工具的站内 `sources` 及 `generated_at`。

查询接口沿用现有 `PUBLIC_READ`、采集令牌/登录 cookie 和每分钟 60 次读取限制；旧 JSON 对话接口额外限制每 IP 每分钟 4 次、全站同时 2 次，单次总超时 150 秒。工具不允许任意 URL、SQL 或写入。上游错误、密钥不会回传浏览器。当前问题、必要历史和工具结果会发送给 OpenRouter。

## 账号历史与流式对话

网页采用 [Vercel AI SDK `useChat`](https://ai-sdk.dev/docs/reference/ai-sdk-ui/use-chat) 和 `DefaultChatTransport` 管理消息、流式状态、停止与重试。Rust 后端遵循 [UI Message Stream 协议](https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol)，不需要额外的 Node 服务。上游 `stream:true` 由 `eventsource-stream` 解码；文本增量直接发送，工具查询阶段发送进度事件。保留了工具协议文本拦截与最多 10 次工具执行预算。

`POST /api/v1/agent/stream` 接受 `{message,thread_id?,request_id?,language?,retry?,history?}`，返回 `text/event-stream`，带 `x-vercel-ai-ui-message-stream:v1`，以 `[DONE]` 结束。`request_id` 用于去重；仅最后一条失败或已停止回复可用 `retry:true` 重试。流式请求每账号或匿名 IP 每分钟 6 次，每 IP 合计 12 次；全站仍最多 2 个生成任务。

登录用户复用站点的账号 Cookie、Origin 与 `X-CSRF-Token`。历史存于 PostgreSQL 的 `agent_threads`、`agent_messages`，通过账号归属校验访问。服务端自行读取最近 12 条上下文，忽略登录客户端提供的历史，且不会将账号凭据附带给模型。刷新或换设备登录同一账号后可继续对话；切换账号清理旧账号的页面缓存。未登录用户仍可临时聊天，不保存服务端历史。

| 接口 | 内容 |
|---|---|
| `GET /api/v1/agent/threads?before=ID` | 当前账号的会话列表，每页 50 条，返回 `next_cursor` |
| `POST /api/v1/agent/threads` | 新建空会话；也可在首次流式提问时自动创建 |
| `GET /api/v1/agent/threads/ID?before_seq=N` | 读取消息，每页 100 条，返回 `has_more` |
| `PATCH /api/v1/agent/threads/ID` | `{title}` 重命名，1–80 字符 |
| `DELETE /api/v1/agent/threads/ID` | 删除会话及其所有消息 |
| `POST /api/v1/agent/threads/ID/stop` | 停止当前账号该会话的生成 |

生成前事务性保存用户消息并锁定会话；同一会话不能同时生成两个回复。生成过程中定期保存部分文本，完成后保存回复、来源与工具轨迹。停止或断线保留部分回复并标记 `aborted`，失败标记 `error`；进程中断的陈旧任务在读取时恢复为可重试状态。删除会话会级联删除消息，不影响其他账号。

调研还比较了 [assistant-ui](https://www.assistant-ui.com/docs/runtimes/custom/external-store)：它提供较完整的对话 UI 运行时；本项目选用 AI SDK 的传输与消息状态管理，界面沿用现有市集主题，账号和数据继续由现有 Rust/PostgreSQL 服务管理。持久化模式参考 [SDK 历史示例](https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-message-persistence)，账号权限校验由本站实现。

常见错误：`agent_not_configured` 尚未配置密钥；`agent_free_quota_exceeded` 上游额度/速率受限；`agent_busy`/`agent_rate_limited` 稍后重试；`agent_provider_configuration` 检查密钥与账号；`agent_timeout` 超时；`market_data_unavailable` 数据查询失败。没有跨模型自动回退。
