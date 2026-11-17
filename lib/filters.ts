// Time range and traffic filters, kept in the URL (?range=7d&traffic=demo) so every
// page shares them and a link reproduces exactly what was on screen.

import type { Traffic } from '../src/db/db.ts';

export const RANGES = [
  { id: '24h', label: 'Last 24 hours', short: '24h', hours: 24, days: 7 },
  { id: '7d', label: 'Last 7 days', short: '7d', hours: 24 * 7, days: 7 },
  { id: '30d', label: 'Last 30 days', short: '30d', hours: 24 * 30, days: 30 },
] as const;
export type Range = (typeof RANGES)[number];

export const TRAFFIC = [
  { id: 'all', label: 'All traffic', traffic: ['live', 'synthetic', 'demo'] as Traffic[] },
  { id: 'demo', label: 'Demo texts', traffic: ['demo'] as Traffic[] },
  { id: 'synthetic', label: 'Synthetic checks', traffic: ['synthetic'] as Traffic[] },
  { id: 'live', label: 'Live customers', traffic: ['live'] as Traffic[] },
] as const;
export type TrafficFilter = (typeof TRAFFIC)[number];

export type SearchParams = Record<string, string | string[] | undefined>;

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export function parseRange(sp: SearchParams): Range {
  return RANGES.find((r) => r.id === one(sp.range)) ?? RANGES[1];
}

export function parseTraffic(sp: SearchParams): TrafficFilter {
  return TRAFFIC.find((t) => t.id === one(sp.traffic)) ?? TRAFFIC[0];
}

export function param(sp: SearchParams, key: string): string | undefined {
  const v = one(sp[key]);
  return v && v.trim() ? v.trim() : undefined;
}

/** The current filters as a query string to carry across links (e.g. "?range=24h&traffic=demo"). */
export function filterQuery(sp: SearchParams): string {
  const q = new URLSearchParams();
  const r = one(sp.range);
  const t = one(sp.traffic);
  if (r && RANGES.some((x) => x.id === r) && r !== RANGES[1].id) q.set('range', r);
  if (t && TRAFFIC.some((x) => x.id === t) && t !== 'all') q.set('traffic', t);
  const s = q.toString();
  return s ? `?${s}` : '';
}
