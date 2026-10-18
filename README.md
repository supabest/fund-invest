# 定投信号台

基金定投信号工具，前端为单文件 `index.html`，通过 GitHub Pages 托管；数据经 Supabase 云端同步，并配套 6 个 Supabase Edge Functions 与 pg_cron 定时任务提供择时、选股、板块研究等后端能力。

## 功能

- **自动取数**：填 6 位场外基金代码，一键拉取天天基金全部历史净值，自动计算最新净值、MA60、MA120、连续站上60日线天数
- **市值自动计算**：录入持有份额，市值 = 份额 × 最新净值 自动更新
- **信号引擎**：按"净值较均线偏离 + 估值百分位"打分，给出 双倍/加强/正常/减半/暂停 五档建议金额
- **主题金额上限**：每个主题有"占20万目标的金额上限"（如机器人 ≤3万），到额自动停投
- **大盘参考指数（按基金选择）**：每只基金可选沪深300/纳斯达克/标普500/道琼斯/恒生指数/恒生科技作为参考，按各自指数给出档位系数（×0.5~×1.5）调节建议金额，选"不参考"豁免；顶部指数条汇总展示
- **止盈分档**：收益率达到档位（+20/40/60/80%）时提醒分批止盈
- **暂停/恢复**：手动暂停后，按"连续 N 日站上60日线（可叠加目标跌幅）"自动判断恢复

## 使用

打开 https://supabest.github.io/fund-invest/ ，建议在手机 Safari 里"分享 → 添加到主屏幕"。

## 数据与后端架构

- **云端同步**：组合数据存储在 Supabase `dingtou_state` 表中，按登录账号（auth.uid()）行级隔离（RLS）。页面用邮箱/密码登录（首次输入即自动注册），登录后各设备数据互通；localStorage 仅作为本地缓存，云端不可用或未登录时降级为纯本地模式。
- **Edge Functions**（位于 `supabase/functions/`，共 6 个）：
  - `daily-update` — 每日更新基金净值/均线、股票与指数行情，并生成分析报告
  - `stock-score` — 股票多因子评分
  - `sector-trend` — 板块趋势与轮动计算
  - `business-mix` — 主营构成与行业映射
  - `stock-research` — 产业研究员（LLM 深度研究）
  - `stock-value` — 个股价值腿（VQ 质量价值评分）
- **定时任务**：pg_cron 任务定义与数据库迁移脚本位于 `scripts/`（`cron_daily_update.sql`、`cron_stock_score.sql`、`cron_stock_value.sql`、`cron_business_mix.sql`、`cron_sector_trend.sql`、`reschedule_sector_trend_cron.sql` 及各 `migrate_*.sql`）。cron 模板里的 Bearer 是占位符，真值只存在生产库 `cron.job`。

## 本地校验门禁

推送/部署前依次跑（根目录 `deno task`）：

```bash
deno task test              # 全部单元测试（scripts/ + supabase/functions/）
deno task check-secrets     # 凭据泄漏扫描（git 跟踪文件；命中 exit 1，只打印脱敏预览）
deno task verify-bundles    # deploy.ts 构建产物逐字节一致性
```

- **`test`**：`scripts/` 下的前端纯逻辑门面（`scripts/*_logic.ts` 用正则从 `index.html` 的 `*_PURE` 标记块逐字抽取执行）与 Edge Functions 单测。其中 `scripts/signal_parity_test.ts` 是**双端信号一致性门禁**：`index.html` 的 `SIGNAL_PURE` 块与 `daily-update` 的服务端信号实现做穷举矩阵比对（档位合成、优先级顺序、大盘系数、默认常量、偏离度/成本口径），任何一侧改语义都必须同步另一侧，否则红灯。
- **`check-secrets`**：识别 64 位十六进制串 / `Bearer` 实值 / JWT / `apiKey=` 实值 / `sb_secret_`·`service_role` 明文。按设计放行的有 `sb_publishable_`（可公开，读路径靠 RLS）与 `deno.lock` 的 integrity 哈希；假阳性可在行内加 `secret-scan: allow` 注释（须写明原因）。仓库曾把真实 `DAILY_UPDATE_TOKEN` 写进 `test-email.sh`、`EMAIL_TEST_GUIDE.md`、`DASHBOARD_TEST.md`（2026-10-18 清理并加门禁）；若怀疑泄漏过真实凭据，先轮换（重建 token → 更新函数 Secrets → 改 `cron.job` 里的 Bearer），再提交文本清理。

## deploy.ts 拼接产物（verify-bundles 细节）

`supabase/functions/{sector-trend,stock-score,stock-research,business-mix,stock-value}/deploy.ts` 是各自目录 `build.ts` 把源模块拼接成的单文件部署产物（**不可手改**，部署推的就是它）。所有单元测试都从源模块导入，不覆盖 `deploy.ts`，因此改完源码务必重跑构建，并在部署前用仓库根命令入口校验产物与源码逐字节一致：

```bash
deno task verify-bundles                              # 等价于 deno run --allow-read --allow-write --allow-run scripts/verify_deploy_bundles.ts
# 漂移时按提示重跑构建：cd supabase/functions/<模块> && deno run --allow-read --allow-write build.ts
```

校验会重跑全部有拼接产物的模块（清单以 `scripts/verify_deploy_bundles.ts` 的 `MODULES` 为准）的构建并与已提交 `deploy.ts` 做字节级 diff：全部一致输出 ✅ 并以 0 退出；任一不一致输出 ❌ 漂移（指明首个差异的字节偏移与所在行）并以 1 退出。产物只写到系统临时目录，校验过程不改动仓库任何文件。`daily-update` 无拼接产物（直接部署 `index.ts`），不在校验范围内。

## 设计文档

各模块的权威设计规格见 [`docs/superpowers/specs/`](docs/superpowers/specs/)，包括股票评分（V1/V1.1）、板块轮动、产业研究员、板块景气展示、个股价值腿（VQ）等。实施计划与决策账（含实跑记录、被推翻的判断）见 [`docs/superpowers/plans/`](docs/superpowers/plans/)。
