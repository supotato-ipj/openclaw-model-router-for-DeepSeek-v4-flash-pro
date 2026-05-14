import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { classify } from "./classifier.js";
import { classifyWithLLM } from "./llm-classifier.js";
import { loadConfig, type RouterConfig, type Tier } from "./config.js";

function getConfig(pluginRoot: string): RouterConfig {
  return loadConfig(pluginRoot);
}

// Per-session router toggle state (default: enabled)
const sessionEnabled = new Map<string, boolean>();

// Per-session classification history (last 5 tiers)
const sessionHistory = new Map<string, Tier[]>();
const MAX_HISTORY = 5;

function buildHistoryContext(sessionKey: string | undefined): string | undefined {
  if (!sessionKey) return undefined;
  const tiers = sessionHistory.get(sessionKey);
  if (!tiers || tiers.length === 0) return undefined;
  const recent = tiers.slice(-3);
  return `Conversation context: the last ${recent.length} messages were classified as "${recent.join('" → "')}". Use this to decide if the current message is a follow-up in an ongoing complex discussion.`;
}

function applyContinuityBias(
  tier: Tier,
  sessionKey: string | undefined,
): { tier: Tier; biased: boolean } {
  if (!sessionKey) return { tier, biased: false };
  const tiers = sessionHistory.get(sessionKey);
  if (!tiers || tiers.length < 2) return { tier, biased: false };
  const last2 = tiers.slice(-2);
  const isHigh = (t: string) => t === "complex" || t === "reasoning";
  if (last2.every(isHigh) && (tier === "simple" || tier === "medium")) {
    return { tier: "complex", biased: true };
  }
  return { tier, biased: false };
}

// Quick strip of system wrapper for command detection
function quickStrip(prompt: string): string {
  let cleaned = prompt;
  cleaned = cleaned.replace(/^System:\s*\[.*?\].*$/gm, "");
  cleaned = cleaned.replace(/```json[\s\S]*?```/g, "");
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n").trim();
  return cleaned;
}

// ============================================================
// Plugin definition
// ============================================================
const plugin = {
  id: "model-router",
  name: "Smart Model Router",
  description:
    "Auto-route simple/medium tasks to DeepSeek Flash and complex/reasoning tasks to DeepSeek Pro. " +
    "Saves ~72% API cost via 14-dimension keyword scoring at <1ms per message.",

  register(api: OpenClawPluginApi) {
    const pluginRoot = api.rootDir;
    api.logger.info(
      `model-router: REGISTER called rootDir=${pluginRoot || "<none>"}`,
    );
    if (!pluginRoot) {
      api.logger.warn(
        "model-router: api.rootDir not available, config hot-reload may not work; using defaults",
      );
    }
    const rootDir = pluginRoot || ".";
    getConfig(rootDir); // initial load

    api.on(
      "before_model_resolve",
      async (event, ctx) => {
        // Diagnostic: log EVERY hook call to see which agents trigger it
        api.logger.info(
          `model-router: HOOK_CALLED agentId=${ctx.agentId} trigger=${ctx.trigger} promptLen=${event.prompt?.length ?? 0}`,
        );
        try {
          // Check for /modelauto command (session toggle)
          const sessionKey = ctx.sessionKey;
          if (sessionKey) {
            const stripped = quickStrip(event.prompt);
            if (/^\/modelauto\s+on\b/i.test(stripped)) {
              sessionEnabled.set(sessionKey, true);
              api.logger.info(
                `model-router: /modelauto on → routing enabled for ${sessionKey}`,
              );
              return;
            }
            if (/^\/modelauto\s+off\b/i.test(stripped)) {
              sessionEnabled.set(sessionKey, false);
              api.logger.info(
                `model-router: /modelauto off → routing disabled for ${sessionKey}`,
              );
              return;
            }
          }

          // Skip routing if session is disabled
          if (sessionKey && sessionEnabled.get(sessionKey) === false) {
            return;
          }

          const config = getConfig(rootDir);
          const historyContext = buildHistoryContext(sessionKey);

          // Try LLM classification first, fall back to keyword on failure
          let result = await classifyWithLLM(event.prompt, config, historyContext);
          let classifier = "llm";

          if (!result) {
            result = classify(event.prompt, config);
            classifier = "keyword";
          }

          if (!result) {
            // Empty prompt — skip routing
            return;
          }

          // Continuity bias: prevent mid-conversation downgrades
          // If last 2 messages were complex/reasoning, stay at least complex
          const bias = applyContinuityBias(result.tier, sessionKey);
          if (bias.biased) {
            result = { ...result, tier: bias.tier, reason: "continuity_bias" };
          }

          // Store classification in session history
          if (sessionKey) {
            const tiers = sessionHistory.get(sessionKey) || [];
            tiers.push(result.tier);
            if (tiers.length > MAX_HISTORY) tiers.shift();
            sessionHistory.set(sessionKey, tiers);
          }

          const model = config.tiers[result.tier]?.model;

          // Structured routing decision log
          const nonZeroDims = Object.fromEntries(
            Object.entries(result.dimensions).filter(([, v]) => v !== 0),
          );

          api.logger.info(
            JSON.stringify({
              event: "model_router_scored",
              timestamp: Date.now(),
              promptSnippet: event.prompt.slice(0, 80),
              promptLength: event.prompt.length,
              tier: result.tier,
              score: Number(result.score.toFixed(4)),
              confidence: Number(result.confidence.toFixed(4)),
              dimensions: nonZeroDims,
              reason: result.reason,
              classifier,
              modelOverride: model,
              agentId: ctx.agentId,
              trigger: ctx.trigger,
            }),
          );

          return { modelOverride: model };
        } catch (err) {
          // Defensive: on any error, fall through to default model
          api.logger.warn(
            `model-router: classification error, using default model: ${String(err)}`,
          );
          return;
        }
      },
      { priority: 100 },
    );

    api.logger.info("model-router: registered before_model_resolve hook");
  },
};

export default plugin;
