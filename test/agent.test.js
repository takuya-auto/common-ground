import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createQlooClient } from '../src/qloo/client.js';
import { runAgent, validateRequest } from '../src/agent/agent.js';
import { mockSearch, mockInsights, mockTags, mockUuid } from '../src/qloo/mock.js';
import { normalize, extractJson, createLLM } from '../src/llm/workersai.js';

const GROUP = {
  members: [
    { name: 'Dana', favourites: ['Radiohead', 'Parasite'] },
    { name: 'Marco', favourites: ['Taylor Swift', 'Pizza'] },
  ],
  occasion: 'dinner',
  location: 'Tokyo',
  constraints: { budget: 'medium', dietary: ['vegetarian'] },
};

test('validateRequest normalizes and rejects bad input', () => {
  const r = validateRequest({ ...GROUP, constraints: { budget: 'bogus', dietary: ['vegetarian', 'nope'], family: 1 } });
  assert.equal(r.constraints.budget, 'any');
  assert.deepEqual(r.constraints.dietary, ['vegetarian']);
  assert.equal(r.constraints.family, true);
  assert.throws(() => validateRequest({ members: [] }), /1 to 6 members/);
  assert.throws(() => validateRequest({ members: [{ name: 'A', favourites: [] }] }), /at least 1 favourite/);
  assert.throws(() => validateRequest({ ...GROUP, location: '' }), /needs a city/);
  assert.throws(() => validateRequest({ ...GROUP, occasion: 'brunch' }), /occasion must be/);
  assert.throws(() => validateRequest({ members: [{ name: 'A', favourites: ['x'] }, { name: 'a', favourites: ['y'] }], occasion: 'movie_night' }), /Duplicate/);
  assert.ok(validateRequest({ members: [{ name: 'A', favourites: ['x'] }], occasion: 'movie_night' }), 'movie night needs no location');
});

test('mock mode: full run produces ranked picks, explanations and a complete trace', async () => {
  const qloo = createQlooClient({});
  const result = await runAgent(validateRequest(GROUP), { qloo, llm: null });
  assert.equal(result.mode.qloo, 'mock');
  assert.equal(result.mode.llm.tier, 'off');
  assert.equal(result.picks.length, 3);
  const top = result.picks[0];
  assert.ok(top.min >= result.picks[1].min - 1e-9 || top.fairScore >= result.picks[1].fairScore - 0.2, 'top pick ranks first by fairness');
  for (const m of result.members) {
    assert.ok(typeof top.sat[m.id] === 'number');
    assert.match(top.explanations[m.id], new RegExp(m.name));
  }
  // every candidate honours the vegetarian constraint tag in the mock
  assert.ok(result.tags.some((t) => t.source === 'constraint:vegetarian'));
  // trace: 4 searches + 1 tag + 1 group + 2 member + 2 scoring = 10 Qloo calls
  assert.equal(result.trace.qlooCalls, 10);
  assert.deepEqual(result.trace.steps.map((s) => s.tool), ['resolve_favourites', 'resolve_constraints', 'find_candidates', 'score_pool', 'rank']);
  assert.ok(result.trace.qloo.every((q) => q.ok));
  const scoring = result.trace.qloo.filter((q) => q.params['filter.results.entities']);
  assert.equal(scoring.length, 2);
  assert.equal(scoring[0].params['feature.explainability'], 'true');
  assert.ok(result.summary.length > 10);
});

test('movie night and weekend trip use the right filter.type and no location', async () => {
  for (const [occasion, type] of [['movie_night', 'urn:entity:movie'], ['tv_night', 'urn:entity:tv_show'], ['weekend_trip', 'urn:entity:destination']]) {
    const qloo = createQlooClient({});
    const result = await runAgent(validateRequest({ members: GROUP.members, occasion, constraints: { family: true } }), { qloo, llm: null });
    const insights = qloo.trace.filter((q) => q.path === '/v2/insights');
    assert.ok(insights.length >= 3, `${occasion} queried insights`);
    assert.ok(insights.every((q) => q.params['filter.type'] === type));
    assert.ok(insights.every((q) => !q.params['filter.location.query']));
    const generating = insights.filter((q) => !q.params['filter.results.entities']);
    if (occasion !== 'weekend_trip') assert.ok(generating.every((q) => q.params['filter.content_rating']), `${occasion} applies family content ratings`);
    assert.ok(result.picks.length > 0);
  }
});

test('relaxation ladder kicks in when constraints empty the pool', async () => {
  // halal + vegan + gluten-free + low budget together leave nothing in the synthetic catalog
  const qloo = createQlooClient({});
  const result = await runAgent(validateRequest({ ...GROUP, constraints: { budget: 'low', dietary: ['vegan', 'halal', 'gluten_free'] } }), { qloo, llm: null });
  assert.ok(result.relaxations.length >= 1, 'at least one relaxation recorded');
  assert.ok(result.picks.length > 0);
  assert.ok(result.trace.steps.some((s) => s.tool === 'relax'));
});

test('live client sends X-Api-Key and parses insights response', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, init });
    return new Response(JSON.stringify({ success: true, results: { entities: [{ name: 'X', entity_id: mockUuid('x'), type: 'urn:entity:place', query: { affinity: 0.8 }, tags: [] }] }, query: { locality: { signal: { name: 'Tokyo' } } } }), { status: 200 });
  };
  const qloo = createQlooClient({ apiKey: 'k', fetchImpl });
  const res = await qloo.insights('urn:entity:place', { signalEntities: [mockUuid('a')], locationQuery: 'Tokyo' });
  assert.equal(qloo.mode, 'live');
  assert.equal(seen[0].init.headers['X-Api-Key'], 'k');
  assert.ok(seen[0].url.startsWith('https://hackathon.api.qloo.com/v2/insights?'));
  assert.equal(res.entities[0].affinity, 0.8);
  assert.equal(res.locality.name, 'Tokyo');
  assert.equal(qloo.trace[0].summary.locality, 'Tokyo');
});

test('live client surfaces HTTP errors with status', async () => {
  const qloo = createQlooClient({ apiKey: 'k', fetchImpl: async () => new Response('{"error":"no"}', { status: 400 }) });
  await assert.rejects(qloo.search('anything'), (e) => e.status === 400 && /400/.test(e.message));
  assert.equal(qloo.trace[0].ok, false);
});

test('mock endpoints behave like Qloo shapes', () => {
  const s = mockSearch({ query: 'Radiohead', take: 3 });
  assert.equal(s.results[0].name, 'Radiohead');
  assert.match(s.results[0].entity_id, /^[0-9a-f-]{36}$/);
  const unknown = mockSearch({ query: 'Zzyzx Quartet' });
  assert.equal(unknown.results.length, 1, 'unknown names still resolve to a mock entity');
  const t = mockTags({ 'filter.query': 'gluten free', 'filter.parents.types': 'urn:entity:place' });
  assert.ok(t.results.tags.length >= 1);
  const ins = mockInsights({ 'filter.type': 'urn:entity:place', 'signal.interests.entities': s.results[0].entity_id, 'filter.location.query': 'Osaka', take: '5', 'feature.explainability': 'true' });
  assert.equal(ins.results.entities.length, 5);
  assert.equal(ins.query.locality.signal.name, 'Osaka');
  assert.ok(ins.results.entities[0].query.affinity >= ins.results.entities[1].query.affinity);
  assert.ok(ins.results.entities[0].query.explainability['signal.interests.entities'].length >= 1);
  const bad = mockInsights({ 'filter.type': 'urn:entity:brand', 'signal.interests.entities': s.results[0].entity_id });
  assert.equal(bad.success, false);
});

test('LLM response normalization and JSON extraction', () => {
  assert.deepEqual(normalize({ response: 'hi', tool_calls: [{ name: 'rank', arguments: { k: 2 } }] }).toolCalls, [{ id: undefined, name: 'rank', arguments: { k: 2 } }]);
  const oa = normalize({ choices: [{ message: { content: '', tool_calls: [{ id: 'c1', function: { name: 'finish', arguments: '{"summary":"ok"}' } }] } }] });
  assert.equal(oa.toolCalls[0].arguments.summary, 'ok');
  assert.deepEqual(extractJson('Sure! ```json\n{"a":1}\n```'), { a: 1 });
  assert.equal(extractJson('no json here'), null);
});

test('daily cap blocks LLM calls and reports status', async () => {
  const store = new Map();
  const kv = { get: async (k) => store.get(k) ?? null, put: async (k, v) => { store.set(k, v); } };
  let runs = 0;
  const ai = { run: async () => { runs++; return { response: 'ok' }; } };
  const llm = createLLM({ AI: ai, CAP_KV: kv, LLM_DAILY_CAP: '2', LLM_PER_REQUEST_CAP: '10' });
  assert.equal(await llm.available(), true);
  await llm.chat([{ role: 'user', content: 'a' }]);
  await llm.chat([{ role: 'user', content: 'b' }]);
  assert.equal(await llm.available(), false);
  await assert.rejects(llm.chat([{ role: 'user', content: 'c' }]), /daily cap/);
  assert.equal(runs, 2);
  const st = await llm.status();
  assert.equal(st.usedToday, 2);
  assert.equal(st.remaining, 0);
  const off = createLLM({ AI: ai, LLM_MODE: 'off' });
  assert.equal(await off.available(), false);
});

test('agent falls back to autopilot when the LLM loop throws, and still completes', async () => {
  const llm = {
    model: 'fake',
    lastReason: null,
    available: async () => true,
    status: async () => ({ remaining: 100, cap: 150 }),
    chat: async () => { throw new Error('boom'); },
  };
  const qloo = createQlooClient({});
  const result = await runAgent(validateRequest(GROUP), { qloo, llm });
  assert.equal(result.mode.llm.tier, 'loop');
  assert.equal(result.mode.llm.fallback, true);
  assert.equal(result.picks.length, 3);
  assert.ok(result.warnings.some((w) => /fell back to autopilot/.test(w)));
});

test('agent follows a scripted LLM tool loop and records llm-attributed steps', async () => {
  const script = [
    { toolCalls: [{ id: '1', name: 'resolve_favourites', arguments: { hints: [{ member: 'm1', text: 'Parasite', type: 'urn:entity:movie' }] } }] },
    { toolCalls: [{ id: '2', name: 'resolve_constraints', arguments: {} }] },
    { toolCalls: [{ id: '3', name: 'find_candidates', arguments: { groupTake: 15, memberTake: 5 } }] },
    { toolCalls: [{ id: '4', name: 'score_pool', arguments: {} }] },
    { toolCalls: [{ id: '5', name: 'rank', arguments: { k: 3 } }] },
    // the loop ends after rank; the next call is the narration request
    { text: '{"summary":"Narrated.","picks":[]}', toolCalls: [] },
  ];
  let i = 0;
  const llm = { model: 'fake', lastReason: null, available: async () => true, status: async () => ({ remaining: 100, cap: 150 }), chat: async () => script[i++] || { text: '', toolCalls: [] } };
  const qloo = createQlooClient({});
  const result = await runAgent(validateRequest(GROUP), { qloo, llm });
  assert.equal(result.mode.llm.tier, 'loop');
  assert.ok(!result.mode.llm.fallback);
  assert.ok(result.trace.steps.every((s) => s.actor === 'llm'), 'all steps attributed to the LLM');
  assert.equal(result.summary, 'Narrated.');
  const search = qloo.trace.find((q) => q.path === '/search' && q.params.query === 'Parasite');
  assert.equal(search.params.types, 'urn:entity:movie', 'type hint reached the search call');
  assert.equal(result.picks.length, 3);
  assert.equal(result.mode.llm.calls, 6, '5 tool turns + 1 narration call');
});

test('relax is refused while the pool is healthy', async () => {
  const script = [
    { toolCalls: [{ id: '1', name: 'resolve_favourites', arguments: {} }] },
    { toolCalls: [{ id: '2', name: 'resolve_constraints', arguments: {} }] },
    { toolCalls: [{ id: '3', name: 'find_candidates', arguments: {} }] },
    { toolCalls: [{ id: '4', name: 'relax', arguments: { what: 'constraint_tags' } }] },
    { toolCalls: [{ id: '5', name: 'score_pool', arguments: {} }] },
    { toolCalls: [{ id: '6', name: 'rank', arguments: {} }] },
    { text: 'not json', toolCalls: [] },
  ];
  let i = 0;
  const llm = { model: 'fake', lastReason: null, available: async () => true, status: async () => ({ remaining: 100, cap: 150 }), chat: async () => script[i++] || { text: '', toolCalls: [] } };
  const qloo = createQlooClient({});
  const result = await runAgent(validateRequest(GROUP), { qloo, llm });
  const relaxStep = result.trace.steps.find((s) => s.tool === 'relax');
  assert.equal(relaxStep.result.changed, false);
  assert.deepEqual(result.relaxations, []);
  assert.ok(result.tags.some((t) => t.required), 'vegetarian constraint still applied');
  assert.ok(result.warnings.some((w) => /Narration fell back/.test(w)));
});
