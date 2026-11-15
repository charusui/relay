// Token accounting. Relay runs on free tiers, so real spend is $0. To keep
// "cost per conversation" meaningful, reports show tokens and, when the model
// has a paid list price in data/prices.json, what the run would cost if paid.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

type Price = { input: number; output: number; cachedInput?: number };

const here = path.dirname(fileURLToPath(import.meta.url));
const table = JSON.parse(readFileSync(path.resolve(here, '../../data/prices.json'), 'utf8')) as {
  checked: string;
  models: Record<string, Price>;
};

export const PRICES_CHECKED = table.checked;

export type TokenUsage = {
  /** Uncached input tokens. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

export const zeroUsage = (): TokenUsage => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}

export const totalTokens = (u: TokenUsage) => u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens;

export const hasPrice = (model: string) => model in table.models;

/** What these tokens would cost at the model's paid list price, or null if no price is on file. */
export function paidEquivalentUsd(model: string, u: TokenUsage): number | null {
  const p = table.models[model];
  if (!p) return null;
  const usd =
    (u.inputTokens * p.input + u.cacheWriteTokens * p.input * 1.25 + u.cacheReadTokens * (p.cachedInput ?? p.input) + u.outputTokens * p.output) / 1_000_000;
  return Math.round(usd * 1_000_000) / 1_000_000;
}
