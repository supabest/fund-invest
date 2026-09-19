#!/bin/bash
# 测试 daily-update 函数 - 生成邮件报告

echo "📧 测试定投信号台邮件报告..."
echo ""
echo "请在 Supabase Dashboard 中先完成以下步骤："
echo "1. 设置环境变量 DAILY_UPDATE_TOKEN"
echo "2. 部署更新后的 daily-update 函数"
echo ""

# 配置变量
SUPABASE_URL="https://sfauluwxmdginezbluvo.supabase.co"
API_KEY="sb_publishable_ogx_OZOqR0tEgr24Dt1DSg_VZasrzuM"
TOKEN="767f27fb2c6f43538a18764f48f211ce5fb140674a2cbb5c01d29e30a9dbbf0c"

echo "🔍 正在测试..."
echo ""

# 执行测试
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
echo "  📊 基金信号详情（净值、偏离度、对比基准）"
echo "  💹 股票信号详情"
echo "  💡 策略说明（五档信号含义、偏离度解释、止盈策略）"
