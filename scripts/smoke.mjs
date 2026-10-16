// Local smoke run of the agent in mock mode, no Worker runtime needed.
import { createQlooClient } from '../src/qloo/client.js';
import { runAgent, validateRequest } from '../src/agent/agent.js';

const body = JSON.parse(process.argv[2] || JSON.stringify({
  members: [
    { name: 'Dana', favourites: ['Radiohead', 'Parasite', 'Bon Iver'] },
    { name: 'Marco', favourites: ['Taylor Swift', 'The Office', 'Pizza'] },
    { name: 'Yuki', favourites: ['Miles Davis', 'Kiku', 'Haruki Murakami'] },
  ],
  occasion: 'dinner',
  location: 'Tokyo',
  constraints: { budget: 'medium', dietary: ['vegetarian'], accessibility: [], family: false },
}));
const req = validateRequest(body);
const qloo = createQlooClient({ apiKey: process.env.QLOO_API_KEY });
const result = await runAgent(req, { qloo, llm: null });
console.log(JSON.stringify({
  mode: result.mode, summary: result.summary, tags: result.tags.map(t => t.id), relaxations: result.relaxations,
  picks: result.picks.map(p => ({ name: p.name, min: p.min.toFixed(2), mean: p.mean.toFixed(2), sat: p.sat, compromise: p.compromise.map(c => c.member + ':' + c.level), headline: p.headline, explanations: p.explanations })),
  meanTop: result.meanTop && { name: result.meanTop.name, min: result.meanTop.min.toFixed(2) },
  steps: result.trace.steps.map(s => `${s.n} ${s.actor} ${s.tool} ${s.error ? 'ERR ' + s.error : 'ok'} ${s.ms}ms`),
  qlooCalls: result.trace.qlooCalls, qloo: result.trace.qloo.map(q => `${q.path} ${q.purpose} -> ${q.ok ? q.summary.count : q.error}`),
  warnings: result.warnings,
}, null, 1));
