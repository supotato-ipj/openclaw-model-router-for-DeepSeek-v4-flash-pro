# Smart Model Router — 安装故障记录

## 故障 1: 插件路径解析错误

**现象**: Gateway 启动失败，日志反复出现：

```
Gateway failed to start: Error: Invalid config at ~/.openclaw/openclaw.json.
plugins.load.paths: plugin: plugin path not found: ~/plugins/model-router
```

**原因**: `openclaw.json` 中配置了相对路径 `"./plugins/model-router"`，Gateway 将其从工作目录解析为 `~/plugins/model-router`（漏了 `.openclaw` 中间路径），导致找不到插件。

**修复**: 改为 `"./.openclaw/plugins/model-router"`

```jsonc
// openclaw.json
"plugins": {
  "load": {
    "paths": ["./.openclaw/plugins/model-router"]  // 注意 .openclaw
  }
}
```

---

## 故障 2: 缺少 configSchema

**现象**: 修复路径后仍启动失败：

```
plugins: plugin: plugin manifest requires configSchema
```

**原因**: Gateway 要求每个插件的 `openclaw.plugin.json` 必须包含 `configSchema` 字段，即使是空 schema。

**修复**: 在 `openclaw.plugin.json` 中添加：

```jsonc
{
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {}
  }
}
```

---

## 故障 3: modelOverride 格式错误 — API 400 拒绝

**现象**: 插件加载成功，路由日志正常，但对话返回错误：

```
Embedded agent failed before reply: LLM request failed: provider rejected the request schema or tool payload.
rawError=400 The supported API model names are deepseek-v4-pro or deepseek-v4-flash,
but you passed deepseek/deepseek-v4-pro.
```

**原因**: `config.json` 中配置的 model 字符串是 `"deepseek/deepseek-v4-pro"`（带 provider 前缀），`modelOverride` 会原样传给 API。DeepSeek API 只接受纯 model id（`"deepseek-v4-pro"`），不接受 `"deepseek/deepseek-v4-pro"`。

**修复**: `config.json` 和 `src/config.ts`（DEFAULT_CONFIG）中的 model 字段去掉 `deepseek/` 前缀：

```jsonc
// config.json
"simple":    { "maxScore": -0.3, "model": "deepseek-v4-flash" },
"medium":    { "maxScore": 0.15, "model": "deepseek-v4-flash" },
"complex":   { "maxScore": 0.5,  "model": "deepseek-v4-pro" },
"reasoning": {                    "model": "deepseek-v4-pro" }
```

---

## 验证

三个问题修复后：

1. `systemctl --user reset-failed openclaw-gateway`（systemd 重试次数耗尽时）
2. `systemctl --user restart openclaw-gateway`
3. 确认日志：`model-router: registered before_model_resolve hook`

启动后第一条消息即生效，日志中出现 `model_router_scored` 事件。

---

## 故障 4: 所有消息都被路由到 complex/reasoning，没有 simple/medium

**现象**: 插件正常加载，但即使发送 "你好"、"hi" 等简单消息，也都被判定为 complex/reasoning。

日志示例：
```json
{
  "tier": "reasoning",
  "score": 0.6533,
  "dimensions": {
    "codePresence": 0.5,
    "tokenCount": 0.02,
    "outputFormat": 0.1333
  }
}
```

**原因**: `before_model_resolve` 的 `event.prompt` 包含 Feishu 的 body prompt 包装，其中有两段 JSON 代码块：
```
System: [timestamp] Feishu[agent] DM | user_id [msg:xxx]

Conversation info (untrusted metadata):
```json {...} ```

Sender (untrusted metadata):
```json {...} ```

[用户消息]
```

即使消息内容是 "你好"，两个 JSON 代码块中的 ` ``` ` 和 `"json"` 等关键词仍会触发 `codePresence` (+0.5) 和 `outputFormat` (+0.13)，基线分就超过 0.65。

**修复**: 在 `classifier.ts` 添加 `stripSystemWrapper()` 函数，评分前删除所有系统包装：
- `System: [...]` 行
- 所有 `(untrusted ...):` 标签行
- 所有 ` ```json ... ``` ` 代码块

```typescript
// classifier.ts
function stripSystemWrapper(prompt: string): string {
  let cleaned = prompt;
  cleaned = cleaned.replace(/^System:\s*\[.*?\].*$/gm, "");
  cleaned = cleaned.replace(/^[A-Z][^:]*\s*\(untrusted[^)]*\):\s*$/gm, "");
  cleaned = cleaned.replace(/```json[\s\S]*?```/g, ""); // global — 清除所有
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n").trim();
  return cleaned || prompt;
}
```

---

## 故障 5: 多 agent 同时发消息时响应缓慢（排队等待）

**现象**: 给多个 agent 同时发送消息，处理变成串行 — A 完成后 B 才显示「正在回复」。

**原因**: `config.ts` 中每次消息都调用 `statSync()` 检查 `config.json` 的 mtime。虽然是基于 mtime 的缓存，但并发消息会排队等待 `statSync` 这个同步 I/O 调用。

**修复**: 在 `readAndValidateConfig` 中添加 2 秒的 stat 节流：

```typescript
let lastStatTime = 0;
const STAT_THROTTLE_MS = 2000;

function readAndValidateConfig(filePath: string): RouterConfig {
  const now = Date.now();
  // 2 秒内的并发消息跳过 statSync，直接返回缓存
  if (cachedConfig && (now - lastStatTime) < STAT_THROTTLE_MS) {
    return cachedConfig;
  }
  // ... 正常 mtime 检查
}
```

配置热重载最多有 2 秒延迟，比原来的 30 秒更灵敏。
