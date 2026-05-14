# Smart Model Router

OpenClaw 智能模型路由插件 — 根据用户消息复杂度自动选择模型，简单任务用 Flash（便宜），复杂任务用 Pro（强力）。

## 解决的问题

OpenClaw 的模型切换机制（Model Fallback / Per-agent Model / `/model` 命令）都做不到「根据任务复杂程度自动切换」。以 DeepSeek 为例，v4-pro 的价格是 v4-flash 的约 **12 倍**，但日常对话中 60-75% 是简单任务（问候、翻译、查询），全部用 Pro 是严重浪费。

本插件在 Gateway 内部拦截每条消息，先用 DeepSeek Flash 做 LLM 分类，失败时用 15 维关键词评分器在 **<1ms** 内兜底判断复杂度，自动路由：

| 任务复杂度 | 路由模型 | 示例 |
|:---:|------|------|
| 简单 | `deepseek-v4-flash` | 你好 / 今天天气 / 翻译 / OK |
| 中等 | `deepseek-v4-flash` | 什么是 Docker / SQL 优化 / 介绍微服务 |
| 复杂 | `deepseek-v4-pro` | 分析性能瓶颈 / 排查 Kafka 延迟 / 写快排 |
| 推理 | `deepseek-v4-pro` | 证明数学定理 / 设计分布式方案 / 多步骤任务 |

**预期节省：~72% API 成本**（按 45% 简单 + 25% 中等 + 20% 复杂 + 10% 推理消息分布计算）。

## 工作原理

每条消息经过以下管线：

```
用户消息
  → /modelauto 命令？→ 切换路由开关
  → 空消息？跳过
  → 会话历史注入（最近 3 条分类结果）
  → LLM 分类（DeepSeek Flash，3 秒超时）
     └─ 失败 → 15 维关键词评分（纯 CPU，<1ms）
  → 连续性偏差：前 2 条都是 complex/reasoning？→ 不降级
  → 硬覆盖规则：推理关键词 / 结构化输出 / 超长上下文 / 工具调用
  → Score → Tier 映射 → 返回 modelOverride
```

### 双层分类策略

**LLM 优先，关键词兜底。** 每次消息先用 DeepSeek Flash（分类专用，token 消耗约 200）判断复杂度。如果 API 超时或失败（3 秒），自动降级到 15 维关键词评分器，零延迟、零额外成本。

### 会话感知路由

插件在内存中维护每条会话最近 5 条消息的分类历史：
- **LLM 上下文注入**：分类时将最近 3 条消息的 tier 作为上下文传给 Flash，帮助它判断是否为复杂对话的延续
- **连续性偏差**：如果最后 2 条都是 complex/reasoning，即使当前消息被判定为 simple/medium，也会自动提升到 complex。避免「好的谢谢」等简短的复杂对话回复被错误降级

### 15 维关键词评分器

纯 CPU、<1ms、覆盖中英文：推理标记、技术术语、代码存在、多步骤模式、领域特异性、简单指示符、命令动词、创意标记、问题复杂度、Token 数量、约束条件、代理任务、工具调用强度、输出格式、引用复杂度。

## 安装

```bash
cd ~/.openclaw/plugins/model-router
npm install
```

确保 OpenClaw 配置中已注册 DeepSeek provider：

```jsonc
// openclaw.json 中
{
  "providers": {
    "deepseek": {
      "models": ["deepseek-v4-flash", "deepseek-v4-pro"]
    }
  }
}
```

重启 Gateway 加载插件：

```bash
openclaw gateway restart
```

## 配置

所有路由参数在 `config.json` 中，修改后 **无需重启**，30 秒内自动生效。

```jsonc
{
  "tiers": {
    "simple":    { "maxScore": -0.3, "model": "deepseek-v4-flash" },
    "medium":    { "maxScore": 0.15, "model": "deepseek-v4-flash" },
    "complex":   { "maxScore": 0.5,  "model": "deepseek-v4-pro" },
    "reasoning": {                    "model": "deepseek-v4-pro" }
  },
  "overrides": {
    "reasoningKeywordThreshold": 2,  // 推理关键词命中数阈值（触发规则 1）
    "largeContextChars": 8000         // 长文本自动升级为 complex（规则 3）
  }
}
```

### 自定义模型

修改 `model` 字段即可，如使用 MiniMax：

```json
"simple": { "maxScore": -0.3, "model": "minimax/MiniMax-M2.7" }
"complex": { "maxScore": 0.5, "model": "minimax/MiniMax-M1.5" }
```

Provider 必须在 OpenClaw 配置中已注册。

### 调整阈值

- 觉得太多消息走了 Pro → **提高** `complex.maxScore`（如 0.7）
- 觉得复杂消息走了 Flash → **降低** `complex.maxScore`（如 0.35）
- 简单消息被误判为中等 → **降低**（更负）`simple.maxScore`（如 -0.4）

### 会话路由开关

在对话中发送命令即可动态切换（无需重启）：

```
/modelauto on     → 启用智能路由
/modelauto off    → 关闭路由，走默认模型
```

开关状态仅限当前会话，新对话默认开启。

## 日志

每次路由决策以 JSON 形式输出到 Gateway 日志：

```json
{
  "event": "model_router_scored",
  "tier": "complex",
  "score": 0.327,
  "confidence": 0.931,
  "dimensions": { "reasoningMarkers": 0.17, "technicalTerms": 0.5, ... },
  "reason": "scoring",
  "classifier": "llm",
  "modelOverride": "deepseek-v4-pro"
}
```

查看实时路由日志：

```bash
journalctl --user -u openclaw-gateway -f | grep model_router_scored
```

## 降级保障

- **评分异常**：try-catch 包裹，出错时返回 undefined，走默认模型（不阻塞消息）
- **config.json 缺失/损坏**：使用硬编码默认值
- **Provider 未注册**：OpenClaw 自动 fallback 到默认模型
- **手动 `/model` 覆盖**：用户手动指定模型时跳过路由（开发中，需确认 API 字段）

## 许可证

MIT
