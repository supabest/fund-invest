#!/bin/bash
# 测试 daily-update 函数 —— 生成并发送邮件报告
#
# 凭据只走环境变量，不落文件（本脚本曾硬编码真实 DAILY_UPDATE_TOKEN，2026-10-18 清理并轮换）。
# 用法：
#   export SUPABASE_URL="https://<project-ref>.supabase.co"
#   export DAILY_UPDATE_TOKEN="<与函数 secret 同值，见 Supabase Dashboard → Functions → Secrets>"
#   ./test-email.sh
set -euo pipefail

SUPABASE_URL="${SUPABASE_URL:?请设置 SUPABASE_URL（例如 https://xxx.supabase.co）}"
TOKEN="${DAILY_UPDATE_TOKEN:?请设置 DAILY_UPDATE_TOKEN（与 daily-update 函数 secret 同值）}"
# publishable key 设计上可公开（读路径靠 RLS 兜底）；如需覆盖用环境变量
API_KEY="${SUPABASE_PUBLISHABLE_KEY:-sb_publishable_ogx_OZOqR0tEgr24Dt1DSg_VZasrzuM}"

echo "📧 测试定投信号台邮件报告（force=true：无变化也会发信）..."
echo ""

RESPONSE=$(curl -s -X POST "${SUPABASE_URL}/functions/v1/daily-update" \
  -H "apikey: ${API_KEY}" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"force": true}' \
  --max-time 180)

echo "✅ 响应结果:"
echo "$RESPONSE" | python3 -m json.tool

echo ""
echo "📬 检查你的邮箱，应该收到一封详细的邮件报告！"
echo ""
echo "邮件内容将包含："
echo "  📊 基金信号详情（净值、偏离度、估值分位、对比基准）"
echo "  💹 股票信号详情"
echo "  💡 策略说明（五档信号含义、偏离度解释、止盈策略）"
