/**
 * 14-dimension keyword dictionaries for the Smart Model Router.
 *
 * Design constraints:
 * - Chinese + English keywords per dimension
 * - 5-20 keywords per dimension
 * - NO cross-dimension keyword overlap (de-conflicted)
 * - Short/substring keywords preferred (matching uses .includes())
 * - Sorted by relevance within each dimension
 *
 * Cap values use "正向 max" from spec: most dimensions cap at 1.0.
 * The "weight" column (0.25, 0.18, ...) is for future config.json tuning.
 */

// ============================================================
// Dimension capability caps (match spec "正向 max" column)
// simpleIndicators uses divisor-1 saturation (1 hit = full neg cap)
// ============================================================
// Caps calibrated so 1 keyword hit (~0.17) stays in medium range,
// 2+ hits from different dims push to complex, 3+ to reasoning.
// simpleIndicators uses saturation divisor 1 (1 hit = full -0.30).
export const CAPS = {
  reasoningMarkers: 0.50,
  technicalTerms: 0.50,
  codePresence: 0.50,
  multiStepPatterns: 0.50,
  domainSpecificity: 0.50,
  simpleIndicators: -0.30,   // special: divisor-1 saturation
  imperativeVerbs: 0.30,
  creativeMarkers: 0.50,
  questionComplexity: 0.50,  // special: 0.5 cap
  tokenCount: 0.04,          // special: ±0.04 cap
  constraintCount: 0.50,
  agenticTask: 0.40,
  toolCallIntensity: 0.35,
  outputFormat: 0.40,
  referenceComplexity: 0.50,
} as const;

// ============================================================
// Dimension 1: reasoningMarkers (cap 1.0)
// Keywords indicating proof, analysis, rigorous reasoning
// ============================================================
export const reasoningMarkers = [
  "证明", "推理", "推导", "归纳", "演绎",
  "论证", "求证", "逻辑", "反证", "设计",
  "分析", "评估", "对比", "权衡",
  "prove", "proof", "deduce", "reason",
  "inductive", "deductive", "logical",
  "theorem", "lemma", "corollary", "design",
  "analyze", "analysis", "evaluate",
];

// ============================================================
// Dimension 2: technicalTerms (cap 1.0)
// Technical/engineering terms indicating domain complexity
// ============================================================
export const technicalTerms = [
  "分布式", "微服务", "容器化", "数据库",
  "缓存", "并发", "编译", "内存",
  "k8s", "docker", "kubernetes",
  "kafka", "延迟", "消费者",
  "性能", "瓶颈", "算法", "复杂度",
  "架构", "负载均衡", "高可用",
  "distributed", "microservice", "database",
  "cache", "algorithm", "complexity",
  "concurrency", "latency", "throughput",
  "architecture", "performance", "consumer",
  "scalability",
];

// ============================================================
// Dimension 3: codePresence (cap 1.0)
// Code-related keywords + code block detection
// ============================================================
export const codeKeywords = [
  "function", "class ", "def ", "import ",
  "const ", "let ", "var ", "return ",
  "async", "await", "export",
  "```", "=>", "interface",
  "try {", "catch", "代码",
  "python", "java", "golang", "rust",
  "函数", "编程",
];

export function countCodeBlocks(prompt: string): number {
  const matches = prompt.match(/```/g);
  if (!matches) return 0;
  return Math.floor(matches.length / 2);
}

// ============================================================
// Dimension 4: multiStepPatterns (cap 1.0)
// ============================================================
export const multiStepKeywords = [
  "step", "步骤",
  "第一步", "第二步", "第三步",
  "首先", "然后", "接着", "最后",
  "先", "再", "其次",
  "first", "next", "then", "finally",
];

export function countNumberedItems(prompt: string): number {
  const matches = prompt.match(/(?:^|\n)\s*\d+[\.、)）]\s/gm);
  return matches ? matches.length : 0;
}

// ============================================================
// Dimension 5: domainSpecificity (cap 1.0)
// ============================================================
export const domainSpecificTerms = [
  "量子", "密码学", "基因组", "神经网络",
  "深度学习", "强化学习", "加密",
  "编译器", "操作系统", "区块链",
  "quantum", "cryptography", "genomics",
  "neural network", "deep learning",
  "reinforcement learning", "blockchain",
  "compiler", "operating system",
];

// ============================================================
// Dimension 6: simpleIndicators (cap -0.30, saturation divisor 1)
// NEGATIVE cap — pulls score DOWN. 1 hit = full -0.30.
// ============================================================
export const simpleIndicators = [
  "你好", "在吗", "谢谢", "好的", "知道了",
  "天气", "翻译", "什么是", "怎么样",
  "帮我查", "告诉我", "解释一下",
  "介绍一下", "怎么", "如何",
  "hello", "hi ", "hey", "thanks", "ok",
  "weather", "translate", "what is",
  "how are you", "good morning",
];

// ============================================================
// Dimension 7: imperativeVerbs (cap 1.0)
// DECONFLICTED: "部署","实现"→imperativeVerbs
//               "修复","重构","迁移","排查","调试"→agenticTask
// ============================================================
export const imperativeVerbs = [
  "构建", "创建", "生成", "编写",
  "开发", "部署", "配置", "实现",
  "build", "create", "write", "generate",
  "make", "develop", "configure", "setup",
  "implement",
];

// ============================================================
// Dimension 8: creativeMarkers (cap 1.0)
// ============================================================
export const creativeMarkers = [
  "写诗", "故事", "剧本", "小说", "诗歌",
  "创作", "角色", "剧情", "虚构",
  "poem", "story", "script", "novel",
  "creative", "fiction", "character", "plot",
];

// ============================================================
// Dimension 9: questionComplexity (cap 0.50)
// ============================================================
export function countQuestions(prompt: string): number {
  const matches = prompt.match(/[?？]/g);
  return matches ? matches.length : 0;
}

// ============================================================
// Dimension 10: tokenCount (cap ±0.04)
// ============================================================
export function scoreTokenCount(prompt: string): number {
  const len = prompt.length;
  if (len < 30) return -0.04;
  if (len < 200) return 0;
  if (len < 2000) return 0.02;
  return 0.04;
}

// ============================================================
// Dimension 11: constraintCount (cap 1.0)
// ============================================================
export const constraintKeywords = [
  "不超过", "至少", "最多", "最少",
  "严格", "必须", "不得", "精确",
  "限制", "要求", "约束",
  "at most", "at least", "must", "require",
  "exactly", "limit", "constraint",
];

// ============================================================
// Dimension 12: agenticTask (cap 1.0)
// DECONFLICTED: see imperativeVerbs above
// ============================================================
export const agenticTaskKeywords = [
  "修复", "重构", "迁移", "优化",
  "升级", "排查", "调试",
  "集成", "测试", "fix", "refactor",
  "migrate", "optimize", "upgrade", "debug",
  "integrate", "test",
];

// ============================================================
// Dimension 13: toolCallIntensity (cap 0.35)
// Keywords indicating tool usage, multi-source aggregation, research
// DECONFLICTED: no overlap with multiStepKeywords, agenticTask, or imperativeVerbs
// ============================================================
export const toolCallKeywords = [
  // Chinese — search/research
  "搜索", "查找", "查询", "检索", "调研",
  // Chinese — aggregation/collection (implies multi-tool)
  "收集", "汇总", "整理", "抓取",
  // Chinese — multi-source
  "全面了解",
  // English — search/research
  "search for", "look up", "look into",
  "research", "investigate",
  // English — aggregation
  "gather", "collect",
];

// ============================================================
// Dimension 14: outputFormat (cap 0.40)
// ============================================================
export const outputFormatKeywords = [
  "json", "yaml", "table", "表格",
  "csv", "xml", "markdown", "列表",
  "format", "格式", "结构化",
];

// ============================================================
// Dimension 15: referenceComplexity (cap 0.50)
// ============================================================
export function scoreReferenceComplexity(prompt: string): number {
  let hits = 0;
  const quoteMatches = prompt.match(/(?:^|\n)[>](?:[\s>])*/gm);
  if (quoteMatches) hits += Math.min(quoteMatches.length, 3);
  const mentionMatches = prompt.match(/@\w+/g);
  if (mentionMatches) hits += Math.min(mentionMatches.length, 2);
  const urlMatches = prompt.match(/https?:\/\/\S+/g);
  if (urlMatches) hits += Math.min(urlMatches.length, 2);
  return hits;
}

// ============================================================
// All keyword-based dims for iteration during scoring
// ============================================================
export const KEYWORD_DIMS = [
  { name: "reasoningMarkers", keywords: reasoningMarkers },
  { name: "technicalTerms", keywords: technicalTerms },
  { name: "domainSpecificity", keywords: domainSpecificTerms },
  { name: "imperativeVerbs", keywords: imperativeVerbs },
  { name: "creativeMarkers", keywords: creativeMarkers },
  { name: "constraintCount", keywords: constraintKeywords },
  { name: "agenticTask", keywords: agenticTaskKeywords },
  { name: "toolCallIntensity", keywords: toolCallKeywords },
  { name: "outputFormat", keywords: outputFormatKeywords },
] as const;
