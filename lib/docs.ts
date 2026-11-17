// Renders the committed write-ups (docs/results/*.md, docs/failures/*.md) inside the
// dashboard, so a reviewer can read them without access to the repository.
// Only those two folders are readable, by exact file name; nothing else on disk is.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Marked } from 'marked';
import { fromRoot } from '../src/paths.ts';

const FOLDERS = ['results', 'failures'] as const;
export type DocFolder = (typeof FOLDERS)[number];

function allowed(folder: string, name: string): string | null {
  if (!(FOLDERS as readonly string[]).includes(folder)) return null;
  if (!/^[a-z0-9-]+$/i.test(name)) return null;
  const dir = fromRoot('docs', folder);
  if (!existsSync(dir)) return null;
  const file = readdirSync(/*turbopackIgnore: true*/ dir).find((f) => f === `${name}.md`);
  return file ? path.join(/*turbopackIgnore: true*/ dir, file) : null;
}

/** docs/<folder>/<name>.md → /evals/docs/<folder>/<name>; other repo links become plain text. */
function rewriteHref(href: string, fromFolder: string): string | null {
  if (/^https?:\/\//.test(href)) return href;
  const clean = href.split('#')[0];
  const resolved = path.posix.normalize(path.posix.join('docs', fromFolder, clean));
  const m = resolved.match(/^docs\/(results|failures)\/([a-z0-9-]+)\.md$/i);
  return m ? `/evals/docs/${m[1]}/${m[2]}` : null;
}

export function readDoc(folder: string, name: string): { title: string; html: string; source: string } | null {
  const file = allowed(folder, name);
  if (!file) return null;
  // The ignore comment stops the bundler tracing the whole folder; next.config.ts includes docs/*.
  const md = readFileSync(/*turbopackIgnore: true*/ file, 'utf8');
  const title = (md.match(/^#\s+(.+)$/m)?.[1] ?? name).replace(/`/g, '');
  const marked = new Marked({ gfm: true });
  marked.use({
    renderer: {
      link({ href, tokens }) {
        const text = this.parser.parseInline(tokens);
        const to = rewriteHref(href, folder);
        if (!to) return `<span class="doc-ref">${text}</span>`;
        const external = /^https?:/.test(to);
        return `<a href="${to}"${external ? ' target="_blank" rel="noreferrer"' : ''}>${text}</a>`;
      },
      html() {
        return ''; // the write-ups are plain markdown; never pass raw HTML through
      },
    },
  });
  const body = md.replace(/^#\s+.+\n/, ''); // the page renders the title itself
  return { title, html: marked.parse(body, { async: false }) as string, source: `docs/${folder}/${name}.md` };
}
