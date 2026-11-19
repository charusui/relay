// List the model IDs a free provider key can use.
//   npm run models -- gemini
//   npm run models -- groq

import { loadEnv } from '../config.ts';
import { OpenAIChatModel } from '../agent/openaiCompat.ts';
import { parseProvider, providerConfig } from '../agent/providers.ts';

loadEnv();
const provider = parseProvider(process.argv[2]);
if (provider === 'anthropic') {
  console.log('Anthropic is paid and not used by default. Model IDs: see https://docs.claude.com/en/docs/about-claude/models');
  process.exit(0);
}
// A placeholder model id is fine here: listing does not use it.
const client = new OpenAIChatModel(providerConfig(provider, 'list-only'));
try {
  const ids = await client.listModels();
  console.log(`${ids.length} models available to your ${provider} key:\n`);
  for (const id of ids) console.log(`  ${id}`);
  console.log(`\nSet one in .env as RELAY_${provider.toUpperCase()}_MODEL=<id>. Pick one that supports tool (function) calling.`);
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
