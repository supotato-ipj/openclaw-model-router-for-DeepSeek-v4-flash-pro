import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RouterConfig, Tier } from "./config.js";
import type { ClassificationResult } from "./classifier.js";
import { stripSystemWrapper } from "./classifier.js";

// ============================================================
// API key resolution
// ============================================================
function getDeepSeekApiKey(): string | null {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;

  try {
    const home = process.env.HOME;
  if (!home) return null;
    const profilesPath = join(home, ".openclaw/agents/main/agent/auth-profiles.json");
    const raw = readFileSync(profilesPath, "utf-8");
    const profiles = JSON.parse(raw);
    return profiles.profiles?.["deepseek:default"]?.key || null;
  } catch {
    return null;
  }
}

// ============================================================
// Tier → score mapping (consistent with keyword classifier)
// ============================================================
const TIER_SCORE: Record<string, number> = {
  simple: -0.5,
  medium: 0.0,
  complex: 0.3,
  reasoning: 0.7,
};

// ============================================================
// Classification prompt
// ============================================================
function buildClassificationPrompt(userMessage: string, historyContext?: string): string {
  const contextLine = historyContext
    ? `${historyContext}\n\n`
    : "";

  return `${contextLine}Classify this user message into a task complexity tier.
Reply with ONLY a JSON object: {"tier":"simple|medium|complex|reasoning","confidence":0.0-1.0}

Tier definitions:
- simple: Greetings, casual chat, yes/no questions, translations, basic facts, simple lookups
- medium: General questions, explanations, simple code examples, basic writing, single-step tasks
- complex: Technical analysis, debugging, multi-step instructions, code generation, data processing, tasks requiring tool calls (search, file ops, web fetch)
- reasoning: Complex system design, architecture decisions, multi-tool orchestration, deep analysis, mathematical proofs, multi-round research

Rules:
- If the task requires web searches, file operations, or tool calls → at least complex
- If the task requires multiple tool calls or multi-round research → reasoning
- If the task is a simple question or greeting with no tool needs → simple or medium
- Consider both the task complexity AND the implied tool-calling needs
- If the conversation context shows complex/reasoning history, the current follow-up likely stays at that level even if brief

User message:
"""
${userMessage}
"""`;
}

// ============================================================
// LLM classification
// ============================================================
export async function classifyWithLLM(
  prompt: string,
  _config: RouterConfig,
  historyContext?: string,
): Promise<ClassificationResult | null> {
  const apiKey = getDeepSeekApiKey();
  if (!apiKey) {
    console.warn("model-router[llm]: no API key found");
    return null;
  }

  const userMessage = stripSystemWrapper(prompt);
  if (!userMessage || !userMessage.trim()) {
    console.warn("model-router[llm]: empty user message after strip");
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);

  try {
    const response = await fetch("https://api.deepseek.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "deepseek-v4-flash",
        messages: [
          { role: "user", content: buildClassificationPrompt(userMessage, historyContext) },
        ],
        max_tokens: 100,
        temperature: 0,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      console.warn(`model-router[llm]: API returned ${response.status} ${response.statusText}`);
      return null;
    }

    const data = await response.json() as {
      choices?: Array<{ message?: { content?: string; reasoning_content?: string } }>;
    };
    // deepseek-v4-flash is a reasoning model — output may be in reasoning_content
    const content = data.choices?.[0]?.message?.content
      || data.choices?.[0]?.message?.reasoning_content;
    if (!content) {
      console.warn(`model-router[llm]: empty content and reasoning_content`);
      return null;
    }

    // Parse JSON from response (handle markdown code blocks)
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn(`model-router[llm]: no JSON found in response: ${content.slice(0, 100)}`);
      return null;
    }

    const parsed = JSON.parse(jsonMatch[0]);
    const tier = parsed.tier;
    const llmConfidence = typeof parsed.confidence === "number" ? parsed.confidence : 0.5;

    if (!["simple", "medium", "complex", "reasoning"].includes(tier)) {
      console.warn(`model-router[llm]: invalid tier: ${tier}`);
      return null;
    }

    return {
      tier: tier as Tier,
      score: TIER_SCORE[tier] ?? 0,
      confidence: Math.max(0, Math.min(1, llmConfidence)),
      dimensions: {},
      reason: "llm",
    };
  } catch (err) {
    console.warn(`model-router[llm]: fetch error: ${String(err)}`);
    return null; // fall back to keyword classifier
  } finally {
    clearTimeout(timeout);
  }
}
