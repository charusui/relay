// Where Relay's data files live (policies, prompts, prices).
//
// Run with tsx, each module knows its own location (import.meta.url). Inside a
// Next.js bundle it does not: modules are moved into .next/, so fall back to
// the project folder (process.cwd(), the project root in dev and on Vercel).
// RELAY_ROOT overrides both.

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function findRoot(): string {
  if (process.env.RELAY_ROOT) return process.env.RELAY_ROOT;
  try {
    const fromModule = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    if (existsSync(path.join(fromModule, 'data', 'policies'))) return fromModule;
  } catch {
    // import.meta.url is not a file: URL inside some bundles
  }
  return process.cwd();
}

export const RELAY_ROOT = findRoot();

/** Absolute path to a file under the project root. */
// The ignore comment stops the bundler tracing the whole folder; next.config.ts lists the files these paths need.
export const fromRoot = (...parts: string[]) => path.join(/*turbopackIgnore: true*/ RELAY_ROOT, ...parts);
