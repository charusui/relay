// npm run eval -- [options]
//
//   --split test|dev|all     which cases (default test: the frozen set used for reported numbers)
//   --variant <id>           prompt variant (default: DEFAULT_VARIANT in src/agent/variants.ts)
//   --provider <p>           gemini | groq | ollama | anthropic (default RELAY_PROVIDER)
//   --model <id>             override the provider's model from .env
//   --offline                scripted stand-in model: free, no key, results marked SIMULATED
//   --limit <n>              only the first n cases (pilots, debugging)
//   --category "<name>"      only one category
//   --case <id,id>           only these cases
//   --repeat <n>             run each case n times (measures run-to-run noise)
//   --no-judge               skip the AI judge (saves free quota)
//   --judge-scope all|marked judge every conversation (default) or only policy cases
//   --resume <runId>         continue a run stopped by a quota limit
//   --label "<text>"         a note stored with the run

import { parseArgs } from 'node:util';
import { loadEnv } from '../config.ts';
import { createJudgeModel, createModel } from '../agent/providers.ts';
import { loadRun, runEval } from './runner.ts';
import { summarize, fmtRatio, writeReport } from './report.ts';
import { describeModelError } from '../agent/model.ts';
import { DEFAULT_VARIANT } from '../agent/variants.ts';

loadEnv();

const { values } = parseArgs({
  options: {
    split: { type: 'string', default: 'test' },
    variant: { type: 'string', default: DEFAULT_VARIANT },
    provider: { type: 'string' },
    model: { type: 'string' },
    offline: { type: 'boolean', default: false },
    limit: { type: 'string' },
    category: { type: 'string' },
    case: { type: 'string' },
    repeat: { type: 'string' },
    'no-judge': { type: 'boolean', default: false },
    'judge-scope': { type: 'string', default: 'all' },
    resume: { type: 'string' },
    label: { type: 'string' },
  },
});

try {
  let variant = values.variant!;
  let split = values.split as 'dev' | 'test' | 'all';
  let provider = values.provider;
  let model = values.model;
  let offline = values.offline!;
  let judgeOff = values['no-judge']!;
  let judgeScope: 'all' | 'marked' = values['judge-scope'] === 'marked' ? 'marked' : 'all';
  if (values.resume) {
    // A resumed run keeps its original settings.
    const { meta } = loadRun(values.resume);
    variant = meta.variant;
    split = meta.split;
    offline = meta.offline;
    provider = offline ? undefined : meta.provider;
    model = offline ? undefined : meta.model;
    judgeOff = !meta.judge; // a run started without the judge resumes without it
    judgeScope = meta.judgeScope ?? 'marked';
  }
  if (!['dev', 'test', 'all'].includes(split)) throw new Error('--split must be dev, test or all');

  const agent = createModel({ provider, model, offline });
  const judge = offline || judgeOff ? null : createJudgeModel();
  if (judge && judge.provider === agent.provider) {
    console.warn(`Note: the judge uses the same provider as the agent (${judge.provider}). A different provider avoids self-preference bias (PLAN.md 4.4).`);
  }

  const { meta, results } = await runEval({
    variant,
    model: agent,
    judge,
    judgeScope,
    split,
    limit: values.limit ? Number(values.limit) : undefined,
    category: values.category,
    caseIds: values.case?.split(',').map((s) => s.trim()),
    repeat: values.repeat ? Number(values.repeat) : undefined,
    label: values.label,
    resume: values.resume,
  });

  const { md } = writeReport(meta, results);
  const s = summarize(results);
  console.log(`\n${meta.offline ? 'SIMULATED (offline stub). ' : ''}${meta.complete ? 'Complete.' : 'INCOMPLETE.'}`);
  console.log(`  Resolution accuracy      ${fmtRatio(s.resolution)}   (agent alone ${fmtRatio(s.resolutionAgentOnly)})`);
  console.log(`  Correct tool use         ${fmtRatio(s.toolUse)}`);
  console.log(`  Unnecessary escalations  ${fmtRatio(s.unnecessaryEscalation)}`);
  console.log(`  Missed escalations       ${fmtRatio(s.missedEscalation)}`);
  console.log(`  Groundedness             ${fmtRatio(s.groundedness)}`);
  console.log(`  Tokens / conversation    ${s.tokensPerConversation ?? 'n/a'}`);
  console.log(`\nReport: ${md}`);
  if (!meta.complete) process.exitCode = 2;
} catch (err) {
  console.error(`\nEval failed: ${describeModelError(err)}`);
  process.exitCode = 1;
}
