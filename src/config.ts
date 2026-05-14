import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

// ============================================================
// Types
// ============================================================
export type Tier = "simple" | "medium" | "complex" | "reasoning";

export type TierConfig = {
  maxScore?: number; // upper bound (strict <) for this tier; undefined for reasoning
  model: string;     // "provider/model-id"
};

export type OverrideConfig = {
  reasoningKeywordThreshold: number;
  structuredOutputMinTier: string;
  largeContextChars: number;
};

export type RouterConfig = {
  tiers: Record<Tier, TierConfig>;
  overrides: OverrideConfig;
};

// ============================================================
// Default config (hardcoded fallback)
// ============================================================
const DEFAULT_CONFIG: RouterConfig = {
  tiers: {
    simple:    { maxScore: -0.3, model: "deepseek-v4-flash" },
    medium:    { maxScore: 0.15, model: "deepseek-v4-flash" },
    complex:   { maxScore: 0.5,  model: "deepseek-v4-pro" },
    reasoning: {                   model: "deepseek-v4-pro" },
  },
  overrides: {
    reasoningKeywordThreshold: 2,
    structuredOutputMinTier: "medium",
    largeContextChars: 8000,
  },
};

// ============================================================
// Config loading with mtime-based caching
// ============================================================
let cachedConfig: RouterConfig | null = null;
let cachedMtime: number = 0;
let configFilePath: string | null = null;
let lastStatTime = 0;
const STAT_THROTTLE_MS = 2000; // skip statSync for 2s after last check

function readAndValidateConfig(filePath: string): RouterConfig {
  const now = Date.now();
  // Throttle statSync: during bursts of concurrent messages, only the first
  // call hits the disk; the rest return the cached config immediately.
  if (cachedConfig && (now - lastStatTime) < STAT_THROTTLE_MS) {
    return cachedConfig;
  }

  try {
    if (existsSync(filePath)) {
      lastStatTime = now;
      const mtime = statSync(filePath).mtimeMs;
      if (cachedConfig && cachedMtime === mtime) {
        return cachedConfig;
      }
      cachedMtime = mtime;

      const raw = readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(raw);
      cachedConfig = validateAndMerge(parsed);
      return cachedConfig!;
    }
  } catch (err) {
    // config missing or malformed — use defaults
  }
  lastStatTime = now;
  cachedConfig = DEFAULT_CONFIG;
  return cachedConfig;
}

/**
 * Load router config from config.json.
 * Uses mtime-based cache: re-reads only when file has changed.
 * Falls back to DEFAULT_CONFIG if file is missing or malformed.
 */
export function loadConfig(pluginRootDir: string): RouterConfig {
  const filePath = join(pluginRootDir, "config.json");
  configFilePath = filePath;
  return readAndValidateConfig(filePath);
}

/**
 * Force reload config (call this when mtime check is insufficient).
 */
export function reloadConfig(): RouterConfig {
  cachedMtime = 0;
  if (!configFilePath) return DEFAULT_CONFIG;
  return readAndValidateConfig(configFilePath);
}

// ============================================================
// Validation & merge
// ============================================================
function validateAndMerge(raw: Record<string, unknown>): RouterConfig {
  const config: RouterConfig = {
    tiers: { ...DEFAULT_CONFIG.tiers },
    overrides: { ...DEFAULT_CONFIG.overrides },
  };

  // Merge tiers
  if (raw.tiers && typeof raw.tiers === "object" && !Array.isArray(raw.tiers)) {
    const rawTiers = raw.tiers as Record<string, unknown>;
    for (const tierName of ["simple", "medium", "complex", "reasoning"] as const) {
      const rawTier = rawTiers[tierName];
      if (rawTier && typeof rawTier === "object" && !Array.isArray(rawTier)) {
        const t = rawTier as Record<string, unknown>;
        if (typeof t.model === "string" && t.model.trim()) {
          config.tiers[tierName] = {
            maxScore: typeof t.maxScore === "number" ? t.maxScore : config.tiers[tierName].maxScore,
            model: t.model.trim(),
          };
        }
        if (tierName !== "reasoning" && typeof t.maxScore === "number") {
          config.tiers[tierName].maxScore = t.maxScore;
        }
      }
    }
  }

  // Merge overrides
  if (raw.overrides && typeof raw.overrides === "object" && !Array.isArray(raw.overrides)) {
    const rawOv = raw.overrides as Record<string, unknown>;
    if (typeof rawOv.reasoningKeywordThreshold === "number") {
      config.overrides.reasoningKeywordThreshold = Math.max(1, Math.floor(rawOv.reasoningKeywordThreshold));
    }
    if (typeof rawOv.structuredOutputMinTier === "string" &&
        ["simple", "medium", "complex"].includes(rawOv.structuredOutputMinTier)) {
      config.overrides.structuredOutputMinTier = rawOv.structuredOutputMinTier;
    }
    if (typeof rawOv.largeContextChars === "number") {
      config.overrides.largeContextChars = Math.max(100, Math.floor(rawOv.largeContextChars));
    }
  }

  return config;
}

/**
 * Resolve model string for a given tier.
 */
export function resolveModel(tier: Tier, config: RouterConfig): string {
  return config.tiers[tier].model;
}

export { DEFAULT_CONFIG };
