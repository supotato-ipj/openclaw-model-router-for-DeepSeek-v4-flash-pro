# Smart Model Router

OpenClaw 智能模型路由插件 — 根据用户消息复杂度自动选择模型，简单任务用 Flash（便宜），复杂任务用 Pro（强力）。

## 解决的问题

OpenClaw 的模型切换机制（Model Fallback / Per-agent Model / `/model` 命令）都做不到「根据任务复杂程度自动切换」。以 DeepSeek 为例，v4-pro 的价格是 v4-flash 的约 **12 倍**，但日常对话中 60-75% 是简单任务（问候、翻译、查询），全部用 Pro 是严重浪费。

本插件在 Gateway 内部拦截每条消息，用 14 维关键词评分器在 **<1ms** 内判断复杂度，自动路由：

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
  → 空消息？跳过
  → 硬覆盖规则 1：包含 ≥2 个推理关键词？→ 直接推理
  → 14 维关键词评分（纯 CPU，<1ms）
  → 硬覆盖规则 2/3：结构化输出 / 超长上下文修正
  → Score → Tier 映射 → 返回 modelOverride
```

评分器参考 FreeRouter/ClawRouter 的 14 维加权关键词方案，覆盖中英文，纯规则、零训练、零外部依赖。

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

Private — 个人使用。
