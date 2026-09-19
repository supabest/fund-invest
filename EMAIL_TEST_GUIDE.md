# 📧 邮件报告测试指南

## ✅ 前置步骤（必须完成）

### 1. 在 Supabase Dashboard 设置环境变量

**访问地址**: https://supabase.com/dashboard/project/sfauluwxmdginezbluvo/functions/daily-update

**操作步骤**:
1. 点击左侧菜单 **Functions**
2. 找到并点击 `daily-update`
3. 点击 **Settings** 标签
4. 在 "Environment variables" 区域添加变量：

```
Key: DAILY_UPDATE_TOKEN
Value: 767f27fb2c6f43538a18764f48f211ce5fb140674a2cbb5c01d29e30a9dbbf0c
```

5. 点击 **"Add variable"**
6. 点击右上角 **"Save changes"**

### 2. 部署更新后的代码

由于我刚修改了邮件报告逻辑，需要重新部署：

**方式 A - Dashboard 部署（推荐）**
- 在 Functions 页面，点击右上角的 **"Deploy"** 按钮
- 等待部署成功提示

**方式 B - CLI 部署**
```bash
brew install supabase/tap/supabase
supabase login
supabase link --project-ref sfauluwxmdginezbluvo
supabase functions deploy daily-update
```

---

## 🔍 测试执行

### 方法一：使用测试脚本（最简单）

```bash
cd "/Users/alick/Documents/GitHub/fund invest"
chmod +x test-email.sh
./test-email.sh
```

### 方法二：手动 curl 命令

```bash
curl -X POST "https://sfauluwxmdginezbluvo.supabase.co/functions/v1/daily-update" \
  -H "apikey: sb_publishable_ogx_OZOqR0tEgr24Dt1DSg_VZasrzuM" \
  -H "Authorization: Bearer 767f27fb2c6f43538a18764f48f211ce5fb140674a2cbb5c01d29e30a9dbbf0c" \
  -H "Content-Type: application/json" \
  -d '{"force": true}' \
  --max-time 180
```

### 方法三：Supabase Dashboard 测试

1. 进入 Functions → daily-update
2. 点击顶部的 **"Test"** 按钮
3. 选择 **POST** 方法
4. 点击 **"Run Test"**

---

## 📬 预期结果

### 成功的响应

```json
{
  "ok": true,
  "at": "2026-09-19T07:46:40.123Z",
  "users": 1,
  "funds": [
    {
      "code": "020973",
      "ok": true,
      "nav_date": "2026-09-19",
      "nav": 1.2345,
      "dev": -5.2,
      "streak": 3
    }
  ],
  "stocks": [...],
  "indices": [...],
  "notifications": [
    {
      "userId": "abc12345",
      "items": 3,
      "sent": true
    }
  ]
}
```

### 检查邮箱

在 **5-10 分钟**内，你应该收到一封格式精美的邮件，包含：

#### 📊 基金信号详情
```
[020973] 某某新能源混合
净值 1.2345 (2026-09-19) · 偏离均线 -5.2% · 对比基准：沪深 300
[双倍] → 止盈档 +20% 达标
```

#### 💹 股票信号详情
```
【600519】贵州茅台：买入参考档位 加强（偏离 -3.5%）
```

#### 💡 策略说明（灰色背景框）
```
当前信号含义：
  双倍/加强 - 建议加大买入金额（×2 或×1.5），适合低位布局
  正常      - 按原计划金额定投
  减半      - 建议减少买入金额（×0.5），警惕回调风险
  暂停      - 暂时停止买入，等待明确信号

偏离度说明：
  负值表示低于均线（如 -5%），正值表示高于均线（如 +3%）
  偏离越大，信号越强（深度低位建议加倍，明显高位建议暂停）

止盈策略：
  收益率达到预设档位时，系统会提示分批卖出
  已触发但未执行的止盈档位会在信号中标注
```

---

## ⚠️ 常见问题排查

### 问题 1: 返回 401 unauthorized

**原因**: 环境变量未设置或未部署

**解决**:
1. 确认已在 Dashboard 中设置 `DAILY_UPDATE_TOKEN`
2. 确认已点击 "Deploy" 部署新代码

### 问题 2: 返回 500 error

**原因**: 函数内部错误

**解决**:
1. 查看 Supabase Dashboard 的 Logs
2. 检查是否有数据库权限问题
3. 确认 SMTP 配置正确

### 问题 3: 没有收到邮件

**可能原因**:
1. 邮件被归类到垃圾邮件
2. 用户没有任何基金/股票数据
3. SMTP 发送失败

**检查方法**:
```bash
# 查看响应中的 notifications 字段
# sent: true 表示发送成功
# sent: false 表示发送失败，查看 mailError
```

### 问题 4: 邮件内容不完整

**原因**: 
1. 数据库中无用户数据
2. 基金/股票列表为空

**验证**:
- 登录网页版应用
- 添加一些测试基金和股票
- 重新执行测试

---

## 🎯 测试清单

- [ ] 在 Dashboard 设置环境变量
- [ ] 部署更新后的代码
- [ ] 执行测试命令
- [ ] 检查 JSON 响应是否成功
- [ ] 查收邮件（包括垃圾邮件箱）
- [ ] 验证邮件内容完整性
  - [ ] 有基金信号详情
  - [ ] 有股票信号详情
  - [ ] 有策略说明
  - [ ] 显示了对比基准名称
  - [ ] 显示了偏离度数值

---

## 📞 需要帮助？

如果遇到问题，请提供：
1. 完整的错误信息
2. JSON 响应内容
3. Supabase Dashboard 的 Logs 截图

祝测试顺利！ 🎉
