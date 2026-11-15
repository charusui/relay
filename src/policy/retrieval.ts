// Policy retrieval: BM25 keyword search over the store policy documents,
// chunked by "##" section. No embeddings service is needed, and results are
// deterministic, which keeps the eval suite repeatable. An embeddings index
// can replace this behind the same searchPolicies() signature later.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Bump when retrieval behaviour changes, so eval runs on different retrieval are never compared silently. */
export const RETRIEVAL_VERSION = 'bm25-stem-v2'; // v1 = original stemmer (before failure 04)

export type PolicyPassage = { id: string; doc: string; section: string; text: string };

const here = path.dirname(fileURLToPath(import.meta.url));
const POLICY_DIR = path.resolve(here, '../../data/policies');

const STOP = new Set(
  'a an and are as at be by can do does for from has have how i if in is it its my of on or our that the this to was we what when where which will with you your me can\'t cannot'.split(' '),
);

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9$ ]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t && !STOP.has(t))
    .map(stem);
}

// Tiny suffix stemmer: enough to match "returns"/"returned"/"returning".
// Stripping -ing/-ed can leave a doubled consonant ("shipping" -> "shipp"),
// which then never matches "ship"; undouble it, as the Porter stemmer does.
// (Failure 04: "shipping" queries missed the "Where we ship" passage.)
export function stem(t: string): string {
  const s = t.replace(/(ing|ed|es|s)$/, '') || t;
  return /([b-df-hj-np-tv-z])\1$/.test(s) && !/(ll|ss|zz)$/.test(s) ? s.slice(0, -1) : s;
}

let cache: { passages: PolicyPassage[]; tokens: string[][]; df: Map<string, number>; avgLen: number } | null = null;

export function loadPassages(): PolicyPassage[] {
  return index().passages;
}

function index() {
  if (cache) return cache;
  const passages: PolicyPassage[] = [];
  for (const file of readdirSync(POLICY_DIR).filter((f) => f.endsWith('.md')).sort()) {
    const raw = readFileSync(path.join(POLICY_DIR, file), 'utf8');
    const doc = (raw.match(/^# (.+)$/m)?.[1] ?? file).trim();
    const parts = raw.split(/^## /m).slice(1);
    for (const part of parts) {
      const [heading, ...body] = part.split('\n');
      const section = heading.trim();
      passages.push({
        id: `${file.replace(/\.md$/, '')}#${section.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
        doc,
        section,
        text: body.join('\n').trim(),
      });
    }
  }
  const tokens = passages.map((p) => tokenize(`${p.section} ${p.section} ${p.text}`));
  const df = new Map<string, number>();
  for (const ts of tokens) for (const t of new Set(ts)) df.set(t, (df.get(t) ?? 0) + 1);
  const avgLen = tokens.reduce((s, t) => s + t.length, 0) / tokens.length;
  cache = { passages, tokens, df, avgLen };
  return cache;
}

export type Bm25Params = { k1: number; b: number };
export const DEFAULT_BM25: Bm25Params = { k1: 1.4, b: 0.75 };

export function searchPolicies(query: string, k = 3, params: Bm25Params = DEFAULT_BM25): (PolicyPassage & { score: number })[] {
  const { passages, tokens, df, avgLen } = index();
  const q = tokenize(query);
  const N = passages.length;
  const { k1, b } = params;
  const scored = passages.map((p, i) => {
    const ts = tokens[i];
    let score = 0;
    for (const term of new Set(q)) {
      const f = ts.filter((t) => t === term).length;
      if (!f) continue;
      const n = df.get(term) ?? 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * ts.length) / avgLen)));
    }
    return { ...p, score: Math.round(score * 100) / 100 };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}
