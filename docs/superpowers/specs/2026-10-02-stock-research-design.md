# 产业研究员（个股基本面景气度 AI 研究）设计文档

> 状态：设计评审稿 · 2026-10-02
> 前身：同名功能曾在另一仓库实现（8 commits），因远端账号丢失全部不可恢复；本文是重建的唯一设计依据（原设计存档 + 本轮三点修订）。

## 1. 背景与目标

为**用户指定的任意股票**（A股6位/港股5位代码，不限于持仓股或精选池）提供**基于 AI 联网搜索的基本面景气度研究**：搜索研报、业绩说明会/财报电话会、行业新闻，归纳行业需求/供给/价格/扩产/管理层措辞五类信号，输出六段式报告和一个**景气度状态标记**。若研究对象恰好是持仓股，其报告与胶囊同步展示在持仓卡片上。

与既有系统的关系（刻意分立、互为对照）：
- 多因子评分：数字面（全 A 池、量化、每日批次）
- 板块轮动：技术面（110 行业 ETF 均线）
- 产业研究员（本篇）：定性面（个股所在行业生意是否在变好/变坏）

**非目标**：不产生买卖建议；不自动批量研究（成本不可控）；不参与评分/轮动的任何计算。

## 2. 本轮相对存档设计的三点修订（用户裁定）

1. **密钥不固化**：任何 LLM 密钥不进 Supabase Secrets / localStorage / 数据库 / 日志，改为**随用随贴**（sessionStorage，关标签页即灭）。
2. **服务商收敛为两家两模型**：智谱 `glm-5.3-flash`、阿里百炼 `qwen3.8-flash`。DeepSeek 整体移除——官方 Responses API 兼容性表明确 `web_search` 内置工具**被忽略**（api-docs.deepseek.com，2026-09 版），无真联网能力，与本功能核心诉求冲突。
3. **模型名以官网核实为准**（2026-09 下旬公开信息）：
   - 智谱：`glm-5.3-flash`（2026-08-26 上线开源、API 同步开放；另有提速款 `GLM-5.3-FlashX`，暂不采用）
   - 阿里：`qwen3.8-flash`（百炼模型 ID：推理+视觉理解+文本生成；Qwen3.8 系列联网搜索不支持 agent 策略，用 turbo/max）

## 3. 服务商适配层

统一接口 `researchProvider`，两个实现，各自封装端点/鉴权头/联网参数/响应解析差异：

| 项 | 智谱 | 阿里百炼 |
|---|---|---|
| 端点 | `https://open.bigmodel.cn/api/paas/v4/chat/completions` | `https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions` |
| 鉴权 | `Authorization: Bearer <用户粘贴 key>` | 同左 |
| 模型 | `glm-5.3-flash` | `qwen3.8-flash` |
| 联网搜索 | 平台 `web_search` 工具参数（精确参数形态在实现期 curl 实测敲定） | `enable_search: true` + `search_options.search_strategy: "max"`；若 3.8 系列要求多模态端点或 Responses API，按官方文档切换实现，**接口对外形态不变** |
| 失败 | 直接返回「数据获取失败」+ 服务商错误码，**不得**换服务商、不得换渠道取数、不得静默降级为无搜索 | 同左 |

实测项（实现期第一个可联调的任务内完成，写进交付记录）：两家模型名有效性、联网是否真实生效（回答含时效性信息与来源角标为过）、Edge Function 对服务商域名的出网连通性、前端→函数调用的 CORS 处理（沿用既有函数 OPTIONS 先例）、单次研究 token 消耗量级。

## 4. 密钥生命周期

- 前端「生成研究」时若本会话无 key：弹内联小表单——服务商二选一 + key 粘贴框（`type=password`，不回显明文）+ 模型名只读展示。
- key 存 `sessionStorage`（键 `dinvest_research_cred`，JSON `{provider, key}`）；每次请求体透传给 Edge Function；函数仅在内存使用，**不写库、不进日志、不进响应体**。
- 换服务商研究时要求重新贴对应家 key（两把 key 互不通用）。
- 函数鉴权不沿用既有函数的 verify_jwt:false+自定义 token 模式（那会把守卫 token 埋进前端，违背密钥不固化精神）：stock-research 以 **verify_jwt:true** 部署，由 supabase-js 自动附登录用户 JWT，**不新增任何 Secret**；因此使用研究功能需已登录云同步（未登录时入口提示先登录）。

## 5. 数据模型

新表 `stock_fundamental`，迁移脚本 `scripts/migrate_stock_research.sql`（DDL + RLS 成对，照搬 sector_rotation 三表先例：`enable rowsecurity` + 每表恰一条 permissive SELECT to anon, authenticated；写路径 service_role 旁路）：

```sql
create table if not exists stock_fundamental (
  code        text not null,            -- 与 stocks.code 同口径（A股6位/港股5位）
  provider    text not null,            -- 'zhipu' | 'bailian'
  model       text not null,
  status      text not null,            -- 'running' | 'done' | 'failed'
  verdict     text,                     -- 景气温度：升温|平稳|降温|恶化（异常标记性质，非建议）
  summary     text,                     -- 胶囊概要行（一句话）
  report      jsonb,                    -- 六段式 [{title, body}]，body 含来源标注
  sources     jsonb,                    -- [{title,url,date}] 去重后的来源清单
  error       text,                     -- failed 时的原因（不含 key）
  started_at  timestamptz not null,
  finished_at timestamptz,
  primary key (code)
);
```

防重（双保险）：同 code 若 `status='running'` 且 `started_at` 距今 <10 分钟 → 直接返回现有行（防并发双击）；若 `status='done'` 且 `finished_at` 距今 <1 小时 → 返回缓存不重跑。历史只保留每 code 最新一行（主键即 code，覆盖式更新；报告时间戳展示给用户）。

## 6. 函数设计 `supabase/functions/stock-research/`

沿用 build.ts 拼接 → deploy.ts 单文件部署模式（同 stock-score/sector-trend）。

**POST /stock-research**（verify_jwt:true，平台 JWT 守卫，函数内不再自校 token），body `{action, code, provider?, model?, api_key?}`：

- `action:"generate"`：按 §5 防重检查 → 写 `running` 行 → 组装提示词（§7）→ 调服务商（同步等待，Edge `--timeout` 部署参数上调至 300s）→ 解析六段 JSON（解析失败重试一次，仍失败记 `failed`）→ 落 `done/failed` 行 → 返回整行。
- `action:"status"`：纯读，返回该 code 行（前端刷新/轮询用）。
- 非本函数职责：定时批量——**不做**，全按需。

## 7. 研究员提示词（沿用存档，逐条为硬约束）

- 角色：产业研究员；对象：`<股票名/代码>` 所在行业近 6 个月景气度变化。
- **五类信号**必须逐一覆盖：需求端、供给端、价格（产品/原料）、扩产/资本开支、管理层措辞（业绩会/年报表述变化）。
- 财务锚点：结合**近 4 季度营收/净利同比与环比**（调用方在 prompt 中注入本库既有数据：stock_score 最新行 + stock_business_mix 主营结构，缺则注明无）。
- **结论必附来源**（链接或「财报电话会 2026-08-29」式指称）；每个信号给出处。
- **禁止词表**：不得凭「供不应求/景气度回升」等关键词直接判看涨；温度判定必须给出至少两条独立证据。
- 输出：六段式 JSON（需求 / 供给 / 价格与盈利 / 竞争格局与扩产 / 管理层与市场信号 / 结论与温度），外加 `verdict` 枚举与 `summary` 一句话。

## 8. 前端（单文件 index.html，README:3 约束）

- **研究入口（主路径，面向任意代码）**：股票页顶部「+ 添加股票」按钮旁加「🔍 研究指定股票」→ 弹内联小表单：代码输入框（校验口径与添加股票一致：A股6位/港股5位）+ 服务商二选一 + key 粘贴框（本会话已配则显示脱敏摘要可改）→ 提交后立即在股票列表上方出现「研究报告」结果卡：running=进度的「研究中…」；done=六段报告；failed=「数据获取失败」+重试。
- **胶囊（从属展示，仅持仓卡）**：股票卡 `signal-strip`（现 ~1900 行，`scorePillHtml` 旁）加景气度胶囊：无记录=不显示胶囊（避免非研究股满屏灰胶囊）；`running`=「研究中…」；`done`= 温度四态各配色（升温jade/平稳灰/降温amber/恶化brick）+ `title` 显示研究时间；`failed`= 红「研究失败」。点击胶囊展开卡片并滚动到报告区。
- **展开体（持仓卡若恰好被研究过）**：`stockFormHtml`（现 ~1924 行）评分明细之后插入与结果卡同构的六段报告区：概要、六段正文（markdown-lite 渲染沿用现有 escapeHtml 纪律）、来源列表、「重新研究（1 小时后可用）」按钮 → 触发 §6 generate 流程；running 状态每 10s 轮询 status。
- 不做：板块页不加胶囊；精选池行不加胶囊/研究按钮（想研究池内某股就用顶部入口输代码）；无自动批量。

## 9. 测试策略

- **单测（fixture，无需 key）**：提示词组装（五类信号段落齐全、注入的财务锚点缺数据时注明、禁止词表在位）、六段 JSON 解析器（正常/残缺/多余字段/非 JSON）、防重判定矩阵（running<10min、done<1h、failed 立即可重试）、胶囊状态映射（含 `pos52=0` 式 falsy 陷阱自查：时间戳 0/空串区分）、密钥不落日志断言（错误信息构造中无 api_key 子串）。
- **联调（需真实 key，由用户第一次贴入时进行）**：两家模型名 + 联网生效验证、Edge 出网、timeout 实测、前端全链路（浏览器验证 + 截图）。

## 10. 风险与遗留

| 风险 | 处置 |
|---|---|
| 智谱 web_search 参数形态与文档有出入 | 实现期第一个 curl 实测项；不通则改走其 Responses API（若有）；仍不通则该 provider 标记不可用，不影响另一家 |
| qwen3.8-flash 需多模态端点/Responses API 才能联网 | 同上，适配层内部消化，接口不变 |
| 联网搜索结果质量不足以判定五类信号 | 属产品效果风险，不阻塞上线；报告里要求模型自报「信息不足」段位，前端如实展示 |
| Edge 300s 仍不够 | 拆两步（搜索与成文分离）留作 V1.1，不预设计 |
| key 经请求体进入函数日志的可能性 | Supabase 默认不记录请求体；测试断言 + 文档告知用户 key 责任边界 |

## 11. 交付切分（供 writing-plans 展开）

1. 迁移脚本（表+RLS）+ Management API 执行 + 验证 SQL
2. Edge Function：纯函数（提示词/解析/防重）TDD + 编排 + build/deploy
3. 前端：顶部研究入口（任意代码）+ 结果卡 + 持仓卡胶囊/展开报告 + key 表单 + 轮询（零副本门面照 sector_render_logic 先例）
4. 联调验证（用户贴 key 后）+ 交付记录
