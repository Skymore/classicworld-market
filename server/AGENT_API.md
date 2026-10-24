# 市场 Agent 与数据工具

网页入口 `/agent` 支持买入、卖出定价和行情查询，保留当前页面内的多轮对话。助手可自己选择工具、读取结果、继续查询，再回答；最多 5 次模型请求、10 次工具调用。只开放查询，不能下单、上架或修改数据库。用户背包不在公开数据中。

## OpenRouter 配置

服务进程环境变量：

```powershell
$env:OPENROUTER_API_KEY = '<你的 OpenRouter API key>'
$env:OPENROUTER_MODEL = 'openrouter/free'
# 然后以原来的方式启动 market-web 或 supervisor
```

也支持私有文件 `shared_data/openrouter.json`：`{"api_key":"...","model":"openrouter/free"}`。从仓库根目录启动时自动读取；其他目录启动可设置 `OPENROUTER_CONFIG` 为该文件的绝对路径。部署器和 supervisor 会把该路径传给服务，密钥不放进发布包。`OPENROUTER_API_KEY` 优先于文件，`OPENROUTER_MODEL` 优先于文件中的模型设置。

Docker Compose 用户在本机 `server/.env` 中设置这两个变量，再启动 `web` 服务。密钥只在服务端使用，不放进网页或 Git。默认 `openrouter/free`，也可指定以 `:free` 结尾的模型；服务拒绝付费模型，并向 OpenRouter 发送输入/输出价格上限 0。免费路由会匹配支持工具调用的免费模型，额度和可用性由 OpenRouter 决定。没有密钥时，对话返回 `agent_not_configured`，数据接口仍可用。

参考：[免费路由](https://openrouter.ai/openrouter/free)、[工具调用](https://openrouter.ai/docs/guides/features/tool-calling)、[额度](https://openrouter.ai/docs/api/reference/limits)。

## 供其他 agent 调用

`GET /api/v1/agent/tools` 返回 OpenAI 兼容的 `tools` function schemas、`read_only`、对话是否启用及当前模型。把 `tools` 原样提供给支持 function calling 的模型，然后将其 `function.arguments` 解析为 JSON，POST 到 `/api/v1/agent/tools/{function.name}`。将返回 JSON 作为对应 `tool_call_id` 的 tool message 发回模型；按需重复。

| 工具 | 参数 | 内容 |
|---|---|---|
| `search_items` | `query` | 中英文名或物品 ID，最多 12 项；重名时澄清 |
| `get_item` | `item_id` | 物品信息、NPC 买入渠道与地图、卖给 NPC 的参考价 |
| `get_listings` | `item_id`, `limit?`, `channel?`, `max_unit_price?` | 近 72 小时报价，由便宜到贵，保留位置、库存、装备、来源、观察时间 |
| `get_recent_sales` | `item_id?`, `limit?`, `hours?` | 按时间倒序的推定成交证据 |
| `get_price_advice` | `item_id`, `hours?` | 站内快卖/正常卖建议、报价摘要、指定时段的成交中位/四分位与样本数 |
| `get_market_overview` | `limit?`, `sort?` | `active` 近期活跃或 `falling` 24 小时跌价的物品概览 |

`limit` 默认 10、范围 1–20；`hours` 默认 72、范围 1–720，按当前时间截取。定价建议使用站内原有 72 小时统计，与自选时段的证据分开返回。所有工具返回 `generated_at` 和数据局限说明，缺失值保持 `null`，无样本不推测卖价。`unit_basis=item|set` 区分按个/组；飞镖按组。

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

查询接口沿用现有 `PUBLIC_READ`、采集令牌/登录 cookie 和每分钟 60 次读取限制；对话额外限制每 IP 每分钟 4 次、全站同时 2 次，单次总超时 150 秒。工具不允许任意 URL、SQL 或写入。上游错误、密钥不会回传浏览器。聊天记录只保存在页面内存中，刷新后清空；当前问题、历史和工具结果会发送给 OpenRouter。

常见错误：`agent_not_configured` 尚未配置密钥；`agent_free_quota_exceeded` 免费额度/速率受限；`agent_busy`/`agent_rate_limited` 稍后重试；`agent_provider_configuration` 检查密钥与账号；`agent_timeout` 超时；`market_data_unavailable` 数据查询失败。没有付费模型回退。
