# Smart Model Router — 代码审查报告

> 审查日期：2026-05-12 | 审查人：Architect  
> 代码版本：1.0.0 | OpenClaw 版本：2026.5.6

---

## 总体评价

插件整体架构清晰，14 维评分器 + 硬覆盖规则 + 降级保障的设计思路合理。代码质量不错，防御性编程到位。以下按严重程度列出问题和优化建议。

---

## 🐛 Bug（需修复）

### 1. `reloadConfig()` 路径拼接错误 — **严重**

**文件**: `src/config.ts`  
**位置**: `reloadConfig()` 函数

```ts
export function reloadConfig(): RouterConfig {
  cachedMtime = 0;
  if (!configFilePath) return DEFAULT_CONFIG;
  return loadConfig(configFilePath);  // ❌ configFilePath 已是完整路径
}

export function loadConfig(pluginRootDir: string): RouterConfig {
  const filePath = join(pluginRootDir, "config.json");  // ❌ 二次拼接！
  // ...
}
```

**问题**: `configFilePath` 保存的是 `join(pluginRootDir, "config.json")` 的完整路径，但 `loadConfig()` 内部又做了 `join(pluginRootDir, "config.json")`，导致路径变成 `.../config.json/config.json`，必定找不到文件。

**修复**:

```ts
// 方案 A：拆分内部读取逻辑
export function reloadConfig(): RouterConfig {
  cachedMtime = 0;
  if (!configFilePath) return DEFAULT_CONFIG;
  return readAndValidateConfig(configFilePath);
}

// 方案 B：loadConfig 接收完整文件路径而非目录
export function loadConfig(pluginRootOrFilePath: string): RouterConfig {
  const filePath = pluginRootOrFilePath.endsWith("config.json")
    ? pluginRootOrFilePath
    : join(pluginRootOrFilePath, "config.json");
  // ...
}
```

建议采用方案 B，保持单一入口更简洁。

---

### 2. `structuredOutputMinTier` 配置项未被使用 — **中等**

**文件**: `src/config.ts` + `src/classifier.ts`

配置中定义了 `structuredOutputMinTier: "medium"`，`validateAndMerge` 也正确解析并合并了该字段，但 `classifier.ts` 中的结构化输出覆盖规则使用了**硬编码阈值**：

```ts
// classifier.ts - 当前代码（硬编码）
if (outputHits > 0 && weightedScore < -0.3) {
  weightedScore = -0.2;
  reason = "structured_output";
}
```

**修复**:

```ts
// 应该根据配置的 structuredOutputMinTier 动态计算阈值
const minTierThreshold = {
  simple: -0.3,
  medium: 0.15,
  complex: 0.5,
}[config.overrides.structuredOutputMinTier];
// 将 score 至少提升到该 tier 的边界
if (outputHits > 0 && weightedScore < minTierThreshold) {
  weightedScore = minTierThreshold;
  reason = "structured_output";
}
```

---

## ⚠️ 潜在问题（建议修复）

### 3. `pluginRoot` fallback 不可靠

**文件**: `src/index.ts`

```ts
const pluginRoot = api.rootDir || ".";
```

当 `api.rootDir` 为 `undefined` 时，fallback 为 `"."`（当前工作目录）。Gateway 的工作目录不一定是插件目录，这会导致找不到 `config.json`。

**修复**:

```ts
const pluginRoot = api.rootDir;
if (!pluginRoot) {
  api.logger.warn("model-router: api.rootDir not available, using defaults");
  // 此时 getConfig 会 fallback 到 DEFAULT_CONFIG，已足够安全
}
```

实际上因为有 `DEFAULT_CONFIG` 降级，这个问题不会导致崩溃，但会产生误导性的日志或不正确的路由行为。建议至少加一个 warning 日志。

---

### 4. 双层配置缓存冗余

**文件**: `src/index.ts` + `src/config.ts`

`index.ts` 有一个 30 秒定时重新检查：
```ts
const CONFIG_RELOAD_INTERVAL_MS = 30_000;
if (!configCache || now - lastConfigCheck > CONFIG_RELOAD_INTERVAL_MS) {
  configCache = loadConfig(pluginRoot);
}
```

`config.ts` 内部已有基于 mtime 的缓存：
```ts
if (cachedConfig && cachedMtime === mtime) {
  return cachedConfig;
}
```

双重缓存导致即使文件未修改，每 30 秒也会做一次 `statSync` + mtime 比较。虽然开销极小，但逻辑存在冗余。

**建议**: 移除 `index.ts` 中的缓存逻辑，直接每次调用 `loadConfig()`（其内部 mtime 缓存已足够高效）。

---

### 5. 死依赖 `@sinclair/typebox`

**文件**: `package.json`

```json
"dependencies": {
  "@sinclair/typebox": "0.34.48"
}
```

代码中没有任何地方 `import` TypeBox。这会增加安装体积，且 `npm install` 会下载一个无用包。

**修复**: 从 `package.json` 中移除 `@sinclair/typebox` 依赖。

---

### 6. 缺少 `attachments` 维度利用

**文件**: `src/classifier.ts`

`before_model_resolve` 事件包含 `attachments?: PluginHookBeforeModelResolveAttachment[]` 字段（图像、视频、音频等），但分类器完全忽略它。

**影响**: 用户发送图片让模型分析时，可能仍路由到 Flash，而图像理解更适合 Pro。

**建议**: 在评分函数中增加基于 attachment 的维度：

```ts
export function classify(
  prompt: string,
  config: RouterConfig,
  attachments?: PluginHookBeforeModelResolveAttachment[],
): ClassificationResult | null {
  // 有图像/视频附件时直接提升权重
  if (attachments?.some(a => a.kind === "image" || a.kind === "video")) {
    if (weightedScore < 0.15) {
      weightedScore = 0.15;
      reason = "attachments_present";
    }
  }
}
```

同时更新 `index.ts` 中的 hook 调用：

```ts
const result = classify(event.prompt, config, event.attachments);
```

---

### 7. `outputHits` 在循环内重复计算

**文件**: `src/classifier.ts`

```ts
let outputHits = 0;
for (const [name, val] of Object.entries(dims)) {
  weightedScore += val;
  if (name === "outputFormat") outputHits = countHits(normalized, outputFormatKeywords);
}
```

`outputHits` 在第 4.13 步已经计算过了（`dims.outputFormat = dimScore(...)`），此处重复计算。虽然函数是纯函数、结果相同，但额外执行了 `countHits` 和字符串匹配。

**修复**: 在循环前直接复用已计算的值，或从 dims 推算：

```ts
// 直接用 earlier 计算的值
const outputHits = countHits(normalized, outputFormatKeywords);
// ...后面直接使用
```

---

## 💡 优化建议

### 8. 关键词列表应可外部化

目前关键词在 `keywords.ts` 中硬编码，用户无法调整。建议将关键词列表作为 `config.json` 的可选字段，允许用户自定义。

```jsonc
{
  "keywords": {
    "reasoningMarkers": ["证明", "推理", ...],
    "technicalTerms": ["分布式", "k8s", ...]
  }
}
```

可以在 `validateAndMerge` 中合并用户自定义关键词到默认列表。

---

### 9. 支持 per-agent 路由策略

不同 agent（如 Coder vs Writer）对模型需求不同。建议支持在 `config.json` 中按 agent 定制路由：

```jsonc
{
  "agentOverrides": {
    "coder": { "alwaysUseTier": "complex" },
    "writer": { "alwaysUseTier": "simple" }
  }
}
```

在 hook handler 中通过 `ctx.agentId` 检查。

---

### 10. 添加路由统计指标

当前只有结构化日志，建议增加内存计数器：

- 每次路由后更新 `{tier}_count` 
- 每 N 次路由输出聚合统计日志
- 辅助用户判断阈值是否需要调整

---

### 11. 简单指示词「怎么」「如何」过于宽泛

**文件**: `src/keywords.ts`

```ts
export const simpleIndicators = [
  // ...
  "怎么", "如何",
];
```

「怎么排查 Kafka 消费者延迟问题」会被命中 `simpleIndicators`（含「怎么」），但同时也有大量 `technicalTerms`。虽然组合评分能一定程度纠正，但建议将这类过于通用的词降低权重或移除，改用更具体的短语匹配。

可以考虑对 `simpleIndicators` 添加负向排除规则：如果同时命中 ≥2 个技术维度关键词，则忽略 `simpleIndicators` 的降分。

---

### 12. TokenCount 维度阈值可配置化

**文件**: `src/keywords.ts`

```ts
export function scoreTokenCount(prompt: string): number {
  const len = prompt.length;
  if (len < 30) return -0.04;
  if (len < 200) return 0;
  if (len < 2000) return 0.02;
  return 0.04;
}
```

这些字符长度阈值是硬编码的，建议移到 `config.json` 的 `overrides` 中。

---

### 13. `config.json` 的 `$schema` 建议

在 `config.json` 中添加 `$schema` 引用可以让编辑器提供自动补全和校验（如果有 schema 的话）：

```jsonc
{
  "$schema": "./schema.json",
  "tiers": { ... }
}
```

---

## ✅ 优点总结

以下方面做得很好，值得保留：

| 方面 | 说明 |
|------|------|
| **防御性编程** | try-catch 包裹整个分类过程，出错时 fall through 到默认模型，不阻塞消息 |
| **配置降级** | config.json 缺失/损坏时自动使用 DEFAULT_CONFIG |
| **mtime 缓存** | config.ts 基于文件修改时间缓存，避免每次请求都读文件 |
| **Unicode 规范化** | NFKC 归一化处理全角/半角字符 |
| **结构化日志** | JSON 格式日志，包含维度分解、置信度、路由原因 |
| **无外部 API 依赖** | 纯 CPU 关键词匹配，零网络调用，延迟 <1ms |
| **中英文双语支持** | 关键词覆盖中文和英文 |
| **14 维去重** | 维度之间关键词无交叉重叠 |
| **README 完善** | 清晰的问题描述、工作原理、配置指南 |
| **硬覆盖规则** | 推理关键词预检查 + 结构化输出修正 + 长上下文修正 |

---

## 🔧 修复优先级

| 优先级 | 编号 | 问题 | 影响 |
|:---:|:---:|------|------|
| 🔴 P0 | #1 | `reloadConfig()` 路径拼接 Bug | 手动 reload 功能完全失效 |
| 🟡 P1 | #2 | `structuredOutputMinTier` 未使用 | 配置项形同虚设 |
| 🟡 P1 | #6 | 忽略 attachments 维度 | 图像/视频任务误路由到 Flash |
| 🟢 P2 | #5 | 死依赖 TypeBox | 安装体积浪费 |
| 🟢 P2 | #3 | pluginRoot fallback | 边缘情况可能出错 |
| 🔵 P3 | #4 | 双层缓存冗余 | 代码可维护性 |
| 🔵 P3 | #7 | outputHits 重复计算 | 微小性能浪费 |
| ⚪ Nice-to-have | #8-13 | 优化建议 | 功能增强 |

---

## 📊 架构合规性检查

对照 OpenClaw 插件 SDK 规范（基于 `hook-before-agent-start.types.ts` + `hooks.ts` 源码审查）：

| 检查项 | 状态 | 备注 |
|--------|:----:|------|
| 使用 `definePluginEntry()` 标准入口 | ❌ | 使用了 `export default plugin` 裸对象，非推荐方式 |
| `openclaw.plugin.json` manifest 格式正确 | ✅ | `id` + `entry` 字段符合规范 |
| `package.json` `openclaw.extensions` 冗余 | ⚠️ | `openclaw.plugin.json` 已足够，`package.json` 中的配置是多余/legacy |
| Hook 类型 `before_model_resolve` 正确 | ✅ | 事件和返回值类型匹配 |
| Hook 返回 `{ modelOverride }` 格式 | ✅ | 符合 `PluginHookBeforeModelResolveResult` |
| `priority: 100` 语义正确 | ✅ | 高优先级先执行，`firstDefined` 保高去低 |
| TypeScript 源文件可被加载 | ✅ | OpenClaw 原生支持 `.ts` 插件 |
| Error handling 不抛异常 | ✅ | try-catch 包裹，出错返回 undefined |

---

## 📝 与 OpenClaw 配置的兼容性

路由模型字符串格式 `"deepseek/deepseek-v4-pro"` 符合 OpenClaw 的 `provider/model-id` 规范。但需确认：

1. **DeepSeek Provider 已注册**: 检查 `openclaw.json` 中 `models.providers.deepseek` 是否包含 `deepseek-v4-flash` 和 `deepseek-v4-pro` 两个 model id
2. **Model Fallback**: 如果路由到的模型不可用，OpenClaw 的 Model Fallback 机制会接管
3. **`/model` 手动覆盖**: README 提到「开发中」，当前代码确实未实现。用户在对话中用 `/model` 切换后，下一个 hook 周期此插件仍会覆盖。**建议尽快实现**：

```ts
// 伪代码
if (event.__userModelOverride) return; // 跳过路由
```

可以通过监听 `before_model_resolve` 时检查上下文标记，或使用更高优先级的 `before_agent_start` legacy hook。

---

## 🔄 总结

插件设计思路优秀，核心评分算法实现正确。**4 个必修问题**（#1, #2, #5, #6）需要优先处理，其中 #1 是导致 `reloadConfig` 完全失效的严重 Bug。修复后即可稳定使用。

长期建议：增加 per-agent 策略、关键词外部化、路由统计面板，让插件从「能用」变「好用」。
