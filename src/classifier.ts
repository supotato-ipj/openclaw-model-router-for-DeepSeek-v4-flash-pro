import type { RouterConfig, Tier } from "./config.js";
import {
  CAPS,
  reasoningMarkers,
  technicalTerms,
  codeKeywords,
  multiStepKeywords,
  domainSpecificTerms,
  simpleIndicators,
  imperativeVerbs,
  creativeMarkers,
  constraintKeywords,
  agenticTaskKeywords,
  toolCallKeywords,
  outputFormatKeywords,
  countCodeBlocks,
  countNumberedItems,
  countQuestions,
  scoreTokenCount,
  scoreReferenceComplexity,
} from "./keywords.js";

// ============================================================
// Types
// ============================================================
export type OverrideReason =
  | "scoring"
  | "llm"
  | "reasoning_override"
  | "structured_output"
  | "large_context"
  | "tool_calling_intensity"
  | "continuity_bias";

export type ClassificationResult = {
  tier: Tier;
  score: number;
  confidence: number;
  dimensions: Record<string, number>;
  reason: OverrideReason;
};

// ============================================================
// Helpers
// ============================================================
function countHits(prompt: string, keywords: readonly string[]): number {
  const lower = prompt.toLowerCase();
  let hits = 0;
  for (const kw of keywords) {
    if (lower.includes(kw.toLowerCase())) hits++;
  }
  return hits;
}

/** Standard saturation: hits/3, capped at 1.0 */
function dimScore(hits: number, cap: number): number {
  if (hits === 0) return 0;
  return Math.min(hits / 3, 1.0) * cap;
}

/** SimpleIndicators saturation: hits/1, capped at 1.0 (1 hit = full neg cap) */
function simpleScore(hits: number, cap: number): number {
  if (hits === 0) return 0;
  return Math.min(hits / 1, 1.0) * cap;
}

function clampScore(score: number): number {
  return Math.max(-1.5, Math.min(3.0, score));
}

// ============================================================
// Sigmoid confidence
// ============================================================
function computeConfidence(score: number, tier: Tier): number {
  let distance: number;
  switch (tier) {
    case "simple":
      distance = Math.abs(score - (-0.3));
      break;
    case "medium":
      distance = Math.min(Math.abs(score - (-0.3)), Math.abs(score - 0.15));
      break;
    case "complex":
      distance = Math.min(Math.abs(score - 0.15), Math.abs(score - 0.5));
      break;
    case "reasoning":
      distance = Math.abs(score - 0.5);
      break;
  }
  return 1 / (1 + Math.exp(-distance * 15));
}

// ============================================================
// Score → Tier mapping (strict less-than)
// ============================================================
function scoreToTier(score: number): Tier {
  if (score < -0.3) return "simple";
  if (score < 0.15) return "medium";
  if (score < 0.5) return "complex";
  return "reasoning";
}

// ============================================================
// System wrapper stripping
// ============================================================
/**
 * Strip OpenClaw body-prompt system wrapper to isolate the user message.
 * The body prompt format is:
 *   System: [timestamp] Channel[agent] ... [msg:xxx]
 *   Conversation info (untrusted metadata):
 *   ```json\n{...}\n```
 *   [user message]
 */
export function stripSystemWrapper(prompt: string): string {
  let cleaned = prompt;
  // Remove system header line (e.g. "System: [2026-05-13 ...] Feishu[architect] DM | ...")
  cleaned = cleaned.replace(/^System:\s*\[.*?\].*$/gm, "");
  // Remove all untrusted-metadata code blocks:
  //   Conversation info (untrusted metadata):\n```json\n{...}\n```
  //   Sender (untrusted metadata):\n```json\n{...}\n```
  //   Tool transcript summary (untrusted, for context):\n```json\n{...}\n```
  cleaned = cleaned.replace(/^[A-Z][^:]*\s*\(untrusted[^)]*\):\s*$/gm, "");
  // Remove all ```json ... ``` code blocks (global — there can be multiple)
  cleaned = cleaned.replace(/```json[\s\S]*?```/g, "");
  // Collapse multiple blank lines and trim
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n").trim();
  return cleaned || prompt; // fallback to original if we stripped everything
}

// ============================================================
// Main classify function
// ============================================================
export function classify(
  prompt: string,
  config: RouterConfig,
): ClassificationResult | null {
  // Step 1: Empty/whitespace check
  if (!prompt || !prompt.trim()) return null;

  // Step 2: Strip system wrapper to isolate user message
  const userMessage = stripSystemWrapper(prompt);

  // Normalize and score
  const normalized = userMessage.normalize("NFKC");

  // Step 3: Rule 1 — reasoningMarkers pre-check (BEFORE scoring)
  const reasoningHits = countHits(normalized, reasoningMarkers);
  if (reasoningHits >= config.overrides.reasoningKeywordThreshold) {
    const tier: Tier = "reasoning";
    // score estimate: full reasoning cap + bonus for extra hits
    const score = CAPS.reasoningMarkers + (reasoningHits - 2) * 0.15;
    const distance = 0.2; // minimum distance for reasoning tier
    const confidence = 1 / (1 + Math.exp(-distance * 15));
    return {
      tier,
      score: clampScore(score),
      confidence,
      dimensions: {
        reasoningMarkers: dimScore(reasoningHits, CAPS.reasoningMarkers),
      },
      reason: "reasoning_override",
    };
  }

  // Step 4: Score all 14 dimensions
  const dims: Record<string, number> = {};

  // 4.1: reasoningMarkers (standard saturation)
  dims.reasoningMarkers = dimScore(reasoningHits, CAPS.reasoningMarkers);

  // 4.2: technicalTerms
  dims.technicalTerms = dimScore(
    countHits(normalized, technicalTerms),
    CAPS.technicalTerms,
  );

  // 4.3: codePresence (keywords + code block bonus)
  const codeKwHits = countHits(normalized, codeKeywords);
  const codeBlocks = countCodeBlocks(normalized);
  dims.codePresence = dimScore(
    codeKwHits + (codeBlocks >= 2 ? codeBlocks : 0),
    CAPS.codePresence,
  );

  // 4.4: multiStepPatterns (keywords + numbered items)
  const mstepKwHits = countHits(normalized, multiStepKeywords);
  const numItems = countNumberedItems(normalized);
  dims.multiStepPatterns = dimScore(
    mstepKwHits + numItems,
    CAPS.multiStepPatterns,
  );

  // 4.5: domainSpecificity
  dims.domainSpecificity = dimScore(
    countHits(normalized, domainSpecificTerms),
    CAPS.domainSpecificity,
  );

  // 4.6: simpleIndicators (special: divisor-1 saturation)
  dims.simpleIndicators = simpleScore(
    countHits(normalized, simpleIndicators),
    CAPS.simpleIndicators,
  );

  // 4.7: imperativeVerbs
  dims.imperativeVerbs = dimScore(
    countHits(normalized, imperativeVerbs),
    CAPS.imperativeVerbs,
  );

  // 4.8: creativeMarkers
  dims.creativeMarkers = dimScore(
    countHits(normalized, creativeMarkers),
    CAPS.creativeMarkers,
  );

  // 4.9: questionComplexity
  dims.questionComplexity = dimScore(
    countQuestions(normalized),
    CAPS.questionComplexity,
  );

  // 4.10: tokenCount
  dims.tokenCount = scoreTokenCount(normalized);

  // 4.11: constraintCount
  dims.constraintCount = dimScore(
    countHits(normalized, constraintKeywords),
    CAPS.constraintCount,
  );

  // 4.12: agenticTask
  dims.agenticTask = dimScore(
    countHits(normalized, agenticTaskKeywords),
    CAPS.agenticTask,
  );

  // 4.13: toolCallIntensity
  const toolCallHits = countHits(normalized, toolCallKeywords);
  dims.toolCallIntensity = dimScore(toolCallHits, CAPS.toolCallIntensity);

  // 4.14: outputFormat
  const outputHits = countHits(normalized, outputFormatKeywords);
  dims.outputFormat = dimScore(outputHits, CAPS.outputFormat);

  // 4.15: referenceComplexity
  dims.referenceComplexity = dimScore(
    scoreReferenceComplexity(normalized),
    CAPS.referenceComplexity,
  );

  // Step 5: Compute weighted score
  let weightedScore = 0;
  for (const [, val] of Object.entries(dims)) {
    weightedScore += val;
  }
  weightedScore = clampScore(weightedScore);

  // Step 6: Rule 2 — structured output override
  const minTierThreshold = {
    simple: -0.3,
    medium: 0.15,
    complex: 0.5,
  }[config.overrides.structuredOutputMinTier] ?? 0.15;
  let reason: OverrideReason = "scoring";
  if (outputHits > 0 && weightedScore < minTierThreshold) {
    weightedScore = minTierThreshold;
    reason = "structured_output";
  }

  // Step 7: Rule 3 — large context override
  if (normalized.length > config.overrides.largeContextChars && weightedScore < 0.15) {
    weightedScore = 0.15;
    reason = "large_context";
  }

  // Step 8: Rule 4 — tool-calling intensity override
  // When 2+ tool-calling keywords are detected, ensure at least complex tier.
  // This catches multi-tool / multi-round scenarios that other dimensions missed.
  if (toolCallHits >= 2 && weightedScore < 0.15) {
    weightedScore = 0.15;
    reason = "tool_calling_intensity";
  }

  // Soft rule: if reasoning keywords detected with no simple indicators,
  // ensure at least complex tier (prevents short proofs from going to Flash)
  if (
    reason === "scoring" &&
    reasoningHits > 0 &&
    dims.simpleIndicators === 0 &&
    weightedScore < 0.15
  ) {
    weightedScore = 0.15;
  }

  // Step 9: Score → Tier
  const tier = scoreToTier(weightedScore);

  // Step 10: Confidence
  const confidence = computeConfidence(weightedScore, tier);

  return { tier, score: weightedScore, confidence, dimensions: dims, reason };
}
