# 🧪 Supabase Dashboard 测试步骤

## 方法一：使用 Dashboard 内置 Test 功能

### 步骤：

1. **进入 daily-update 函数页面**
   - 你已经在这个页面了 ✅

2. **点击顶部的 "Test" 按钮**
   - 在 "Docs"、"Download" 右侧有一个灰色的 "Test" 按钮
   - 点击它

3. **配置测试请求**
   - Method: POST
   - Body (JSON):
     ```json
     {
       "force": true
     }
     ```

4. **点击 "Run Test"**

5. **查看结果**
   - 成功会返回 JSON 数据
   - 失败会显示错误信息

---

## 方法二：检查 Logs 查看之前的调用

1. **点击 "Logs" 标签**
   - 在 Overview、Invocations、Code、Settings 旁边

2. **查看最近的日志**
   - 搜索 "unauthorized" 或 "error"
   - 查看具体的错误原因

3. **确认环境变量是否生效**
   - 日志中应该会显示环境变量加载情况

---

## 可能的原因分析

从你的截图看，4XX 错误率 100%，说明：
- ✅ 代码本身没有语法错误
- ❌ 认证失败（token 不匹配或环境变量未生效）

### 需要确认：

1. **环境变量是否正确保存**
   - 回到 Secrets 页面
   - 确认 DAILY_UPDATE_TOKEN 的值是你刚才生成的：
     `767f27fb2c6f43538a18764f48f211ce5fb140674a2cbb5c01d29e30a9dbbf0c`

2. **函数是否使用了最新的环境变量**
   - 有时候需要重新部署才能生效
   - 点击 "Redeploy" 或 "Deploy to production"

3. **Token 是否被修改过**
   - 如果之前设置过其他 token，需要完全替换

---

## 建议操作顺序

1. **先点击 "Logs" 标签查看错误详情**
2. **然后回到 Secrets 确认 token 值**
3. **最后点击 "Code" 标签，找到 "Redeploy" 按钮**

完成后告诉我结果！
