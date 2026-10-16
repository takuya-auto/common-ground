// The Common Ground agent.
//
// Three tiers, chosen by LLM availability and remaining daily budget:
//   loop  - the LLM drives a tool-calling loop over the Qloo tools (max steps),
//           then narrates. The autopilot finishes any step the model skipped.
//   light - the LLM only hints entity types up front and narrates at the end;
//           the autopilot runs the Qloo plan deterministically (2 LLM calls).
//   off   - fully deterministic: autopilot plan + templated explanations.
// Every tier produces the same result shape and the same transparent trace.

import { getOccasion } from './occasions.js';
import { createState, createTools, TOOL_SCHEMAS, MIN_POOL } from './tools.js';
import { templateExplanation, templateHeadline, templateSummary, factsFor } from '../llm/explain.js';
import { extractJson } from '../llm/workersai.js';
import { SEARCHABLE_TYPES } from '../qloo/params.js';

const MAX_LLM_STEPS = 9;
const LOOP_MIN_REMAINING = 40; // below this many calls left today, use the light tier

export const OCCASION_KEYS = ['dinner', 'night_out', 'movie_night', 'tv_night', 'weekend_trip'];

/** Validate and normalize the API request body. Throws Error with .status=400. */
export function validateRequest(body) {
  const bad = (msg) => { const e = new Error(msg); e.status = 400; return e; };
  if (!body || typeof body !== 'object') throw bad('Body must be a JSON object');
  const members = Array.isArray(body.members) ? body.members : [];
  if (members.length < 1 || members.length > 6) throw bad('Provide 1 to 6 members');
  const seen = new Set();
  const cleanMembers = members.map((m, i) => {
    const name = String(m?.name || '').trim().slice(0, 40) || `Member ${i + 1}`;
    const favourites = (Array.isArray(m?.favourites) ? m.favourites : [])
      .map((f) => String(f || '').trim().slice(0, 80)).filter(Boolean).slice(0, 5);
    if (favourites.length < 1) throw bad(`${name} needs at least 1 favourite (max 5)`);
    const key = name.toLowerCase();
    if (seen.has(key)) throw bad(`Duplicate member name "${name}"`);
    seen.add(key);
    return { name, favourites };
  });
  const occasion = String(body.occasion || 'dinner');
  if (!OCCASION_KEYS.includes(occasion)) throw bad(`occasion must be one of ${OCCASION_KEYS.join(', ')}`);
  const occ = getOccasion(occasion);
  const location = String(body.location || '').trim().slice(0, 80);
  if (occ.needsLocation && !location) throw bad(`${occ.label} needs a city or area`);
  const c = body.constraints || {};
  const budget = ['low', 'medium', 'high', 'any'].includes(c.budget) ? c.budget : 'any';
  const dietary = (Array.isArray(c.dietary) ? c.dietary : []).filter((x) => ['vegetarian', 'vegan', 'gluten_free', 'halal'].includes(x));
  const accessibility = (Array.isArray(c.accessibility) ? c.accessibility : []).filter((x) => ['wheelchair'].includes(x));
  return {
    members: cleanMembers,
    occasion,
    location,
    constraints: { budget, dietary, accessibility, family: !!c.family },
    compare: !!body.compare,
  };
}

/**
 * Run the agent.
 * @param {object} request validated request
 * @param {{qloo:object, llm:object|null}} deps
 */
export async function runAgent(request, { qloo, llm }) {
  const occasion = getOccasion(request.occasion);
  const state = createState(request, occasion);
  const tools = createTools({ qloo, state });
  const llmInfo = { tier: 'off', model: llm?.model || null, calls: 0, reason: null };

  // ---- choose tier --------------------------------------------------------
  if (llm && await llm.available()) {
    const st = await llm.status();
    llmInfo.tier = st.remaining >= LOOP_MIN_REMAINING ? 'loop' : 'light';
    llmInfo.reason = `remaining today: ${st.remaining}/${st.cap}`;
  } else {
    llmInfo.reason = llm ? llm.lastReason : 'no LLM configured';
  }

  // ---- run -----------------------------------------------------------------
  let llmSummary = null;
  try {
    if (llmInfo.tier === 'loop') {
      llmSummary = await runLlmLoop({ state, tools, llm, llmInfo });
    } else if (llmInfo.tier === 'light') {
      const hints = await llmTypeHints({ state, llm, llmInfo });
      await tools.resolve_favourites({ hints }, 'autopilot');
    }
  } catch (err) {
    state.warnings.push(`LLM tier "${llmInfo.tier}" fell back to autopilot: ${err.message}`);
    llmInfo.fallback = true;
  }
  await autopilotComplete({ state, tools });

  // ---- explanations --------------------------------------------------------
  const result = assembleResult({ state, qloo, llmInfo, llmSummary });
  if (llmInfo.tier !== 'off' && result.picks.length) {
    try {
      await narrate({ result, state, llm, llmInfo });
    } catch (err) {
      result.warnings.push(`Narration fell back to templates: ${err.message}`);
    }
  }
  if (request.compare) {
    result.compare = await llmOnlyComparison({ request, occasion, llm, llmInfo });
  }
  result.mode.llm = llmInfo;
  return result;
}

// ---------------------------------------------------------------------------
// Deterministic plan: runs whatever is still missing.
async function autopilotComplete({ state, tools }) {
  const unresolved = state.members.some((m) => m.favourites.some((f) => !f.entity));
  if (unresolved && !state.steps.some((s) => s.tool === 'resolve_favourites' && !s.error)) {
    await tools.resolve_favourites({}, 'autopilot');
  }
  if (!state.steps.some((s) => s.tool === 'resolve_constraints' && !s.error)) await tools.resolve_constraints({}, 'autopilot');
  if (state.pool.size === 0) await tools.find_candidates({}, 'autopilot');
  // Relaxation ladder when the pool is too thin.
  const ladder = ['budget', 'constraint_tags', 'content_rating', 'occasion_tags'];
  for (const what of ladder) {
    if (state.pool.size >= MIN_POOL) break;
    const r = await tools.relax({ what }, 'autopilot');
    if (r.changed) await tools.find_candidates({}, 'autopilot');
  }
  if (state.pool.size === 0) throw Object.assign(new Error('Qloo returned no candidates for this request, even after relaxing constraints.'), { status: 422 });
  if (!Object.keys(state.affinities).length) await tools.score_pool({}, 'autopilot');
  if (!state.ranking) await tools.rank({ k: 3 }, 'autopilot');
}

// ---------------------------------------------------------------------------
// LLM tool-calling loop.
async function runLlmLoop({ state, tools, llm, llmInfo }) {
  const system = `You are Common Ground, an agent that finds the fairest shared choice for a group using the Qloo taste graph.
Procedure: 1) resolve_favourites (add type hints for ambiguous names, e.g. "Dune" could be urn:entity:movie or urn:entity:book; when a title exists in the occasion's own type, hint that type, because Qloo scores same-type signals most reliably), 2) resolve_constraints, 3) find_candidates, 4) score_pool, 5) rank, 6) finish with a one-sentence summary.
If find_candidates reports a poolSize below ${MIN_POOL}, call relax (budget first, then constraint_tags) and find_candidates again.
Always call exactly one tool per turn. Do not answer in prose until finish.`;
  const user = `Group request:\n${JSON.stringify(briefRequest(state), null, 0)}`;
  const messages = [{ role: 'system', content: system }, { role: 'user', content: user }];
  let summary = null;

  for (let i = 0; i < MAX_LLM_STEPS; i++) {
    const out = await llm.chat(messages, { tools: TOOL_SCHEMAS, maxTokens: 400 });
    llmInfo.calls++;
    const call = out.toolCalls[0];
    if (!call) {
      // Model answered in prose: treat it as done if ranking exists, else stop the loop.
      if (state.ranking) { summary = out.text?.trim() || null; break; }
      messages.push({ role: 'assistant', content: out.text || '' });
      messages.push({ role: 'user', content: 'Please call the next tool.' });
      continue;
    }
    if (call.name === 'finish') { summary = String(call.arguments?.summary || '').trim() || null; break; }
    const fn = tools[call.name];
    let toolResult;
    if (!fn) {
      toolResult = { error: `unknown tool ${call.name}` };
    } else {
      try {
        toolResult = await fn(sanitizeArgs(call.name, call.arguments), 'llm');
      } catch (err) {
        toolResult = { error: err.message };
      }
    }
    messages.push({ role: 'assistant', content: '', tool_calls: [{ id: call.id || `call_${i}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments || {}) } }] });
    messages.push({ role: 'tool', tool_call_id: call.id || `call_${i}`, name: call.name, content: JSON.stringify(toolResult).slice(0, 3000) });
    // Ranking is the last Qloo-dependent step; the narration call that follows
    // writes the summary, so we save a model turn by ending the loop here.
    if (state.ranking && call.name === 'rank') break;
  }
  return summary || null;
}

function sanitizeArgs(name, args) {
  const a = args && typeof args === 'object' ? args : {};
  if (name === 'resolve_favourites') {
    const hints = Array.isArray(a.hints) ? a.hints.filter((h) => h && SEARCHABLE_TYPES.includes(h.type)) : [];
    return { hints };
  }
  if (name === 'find_candidates') return { groupTake: clampInt(a.groupTake, 5, 30, 20), memberTake: clampInt(a.memberTake, 3, 15, 10) };
  if (name === 'rank') return { k: clampInt(a.k, 1, 5, 3) };
  if (name === 'relax') return { what: a.what }; // `force` is never exposed to the model
  if (name === 'resolve_constraints') return { pickFirst: a.pickFirst !== false };
  return {};
}

function clampInt(v, lo, hi, dflt) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
}

function briefRequest(state) {
  return {
    occasion: state.occasion.key,
    target_type: state.occasion.type,
    location: state.request.location || null,
    constraints: state.request.constraints,
    members: state.members.map((m) => ({ id: m.id, name: m.name, favourites: m.favourites.map((f) => f.input) })),
  };
}

// ---------------------------------------------------------------------------
// Light tier: one JSON call to get entity-type hints.
async function llmTypeHints({ state, llm, llmInfo }) {
  const prompt = `Classify each favourite into one Qloo entity type from this list: ${SEARCHABLE_TYPES.join(', ')}.
Return ONLY JSON: {"hints":[{"member":"m1","text":"<as typed>","type":"urn:entity:..."}]}. Skip items you are unsure about.
Favourites:\n${state.members.map((m) => m.favourites.map((f) => `${m.id} | ${f.input}`).join('\n')).join('\n')}`;
  const out = await llm.chat([{ role: 'user', content: prompt }], { maxTokens: 400 });
  llmInfo.calls++;
  const json = extractJson(out.text);
  const hints = Array.isArray(json?.hints) ? json.hints.filter((h) => h && SEARCHABLE_TYPES.includes(h.type)) : [];
  state.steps.push({ n: state.steps.length + 1, actor: 'llm', tool: 'classify_favourites', args: {}, result: { hints: hints.length }, ms: 0 });
  return hints;
}

// ---------------------------------------------------------------------------
function assembleResult({ state, qloo, llmInfo, llmSummary }) {
  const occ = state.occasion;
  const members = state.members.map((m) => ({ id: m.id, name: m.name, favourites: m.favourites }));
  const picks = (state.ranking?.picks || []).map((p) => ({
    id: p.id,
    name: p.name,
    subtype: p.subtype,
    properties: p.properties,
    tags: p.tags,
    sources: p.sources,
    groupAffinity: p.groupAffinity,
    affinities: p.affinities,
    sat: p.sat,
    regret: p.regret,
    estimated: p.estimated,
    min: p.min,
    mean: p.mean,
    spread: p.spread,
    lowest: p.lowest,
    highest: p.highest,
    fairScore: p.fairScore,
    compromise: p.compromise,
    drivers: p.drivers,
    headline: templateHeadline(p, members, occ.unit),
    explanations: Object.fromEntries(members.map((m) => [m.id, templateExplanation(p, m, occ.unit)])),
    explanationSource: 'template',
  }));
  const meanTop = state.ranking?.meanTop ? { id: state.ranking.meanTop.id, name: state.ranking.meanTop.name, min: state.ranking.meanTop.min, mean: state.ranking.meanTop.mean, lowest: state.ranking.meanTop.lowest } : null;
  const result = {
    mode: { qloo: qloo.mode, llm: llmInfo },
    occasion: { key: occ.key, label: occ.label, type: occ.type, unit: occ.unit },
    location: state.request.location || null,
    locality: state.locality || null,
    constraints: state.request.constraints,
    tags: state.tags,
    relaxations: state.relaxations,
    members,
    picks,
    meanTop,
    pool: (state.ranking?.pool || []).map((c) => ({ id: c.id, name: c.name, sat: c.sat, min: c.min, mean: c.mean, fairScore: c.fairScore, sources: c.sources })).sort((a, b) => b.fairScore - a.fairScore),
    summary: llmSummary || templateSummary({ picks, members, occasion: occ, meanTop }),
    summarySource: llmSummary ? 'llm' : 'template',
    trace: { steps: state.steps, qloo: qloo.trace, qlooCalls: qloo.trace.length },
    warnings: state.warnings,
    compare: null,
  };
  return result;
}

// ---------------------------------------------------------------------------
// Narration: the LLM rephrases templated facts; it may not add new claims.
async function narrate({ result, state, llm, llmInfo }) {
  if (!(await llm.available())) return;
  const facts = result.picks.map((p) => ({
    id: p.id,
    name: p.name,
    headline: p.headline,
    members: result.members.map((m) => ({ id: m.id, name: m.name, favourites: m.favourites.map((f) => f.entity?.name || f.input), ...factsFor(p, m) })),
  }));
  const prompt = `You write short, specific explanations for a group deciding on a ${result.occasion.label.toLowerCase()}.
Rules:
- Use ONLY the facts below: sat (satisfaction 0-1), level, driverNames (the member's own favourites that Qloo linked to this pick), sharedTags, regret. Never invent venues, dishes, plots, prices or facts.
- Speak to each member in second person, but do NOT open with "You, Name". Vary the phrasing. One sentence, two at most. Name at least one driver favourite when available.
- Write natural English. Never use the words "driver", "level", "happy", "sat" or "regret" in the text; those are field names, not words for the reader. Say the satisfaction as a whole-number percentage (e.g. 94%, never 94.5%).
- Good example: "Your love of Bon Iver and Radiohead is what Qloo connects this film to: a strong 95% fit." Bad example: "Bon Iver is a driver, you're happy."
- If level is "compromises", say so kindly and what they give up (their regret vs their own top pick). If "okay", be honest that it is a fair-but-not-perfect fit.
- Cover EVERY pick and EVERY member. Keep each text under 200 characters.
Return ONLY JSON, no prose: {"summary": "<one sentence for the whole group>", "picks": [{"id": "<pick id>", "headline": "<one sentence>", "perMember": {"<member id>": "<text>"}}]}
Facts:
${JSON.stringify({ summary: result.summary, picks: facts })}`;
  const out = await llm.chat([{ role: 'user', content: prompt }], { maxTokens: 1600, temperature: 0.4 });
  llmInfo.calls++;
  const json = extractJson(out.text);
  if (!json || !Array.isArray(json.picks)) throw new Error('narration JSON missing');
  for (const p of result.picks) {
    const n = json.picks.find((x) => x.id === p.id || x.name === p.name);
    if (!n) continue;
    if (typeof n.headline === 'string' && n.headline.trim()) p.headline = n.headline.trim().slice(0, 300);
    for (const m of result.members) {
      const t = n.perMember?.[m.id] ?? n.perMember?.[m.name];
      if (typeof t === 'string' && t.trim()) { p.explanations[m.id] = t.trim().slice(0, 500); p.explanationSource = 'llm'; }
    }
  }
  if (typeof json.summary === 'string' && json.summary.trim()) { result.summary = json.summary.trim().slice(0, 400); result.summarySource = 'llm'; }
}

// ---------------------------------------------------------------------------
// "Without Qloo" comparison: same request, LLM only, no taste graph.
async function llmOnlyComparison({ request, occasion, llm, llmInfo }) {
  if (!llm || !(await llm.available())) {
    return { available: false, reason: llm ? llm.lastReason : 'no LLM configured' };
  }
  // Same inputs the agent actually used: location and food/budget filters only apply to places.
  const isPlace = occasion.type === 'urn:entity:place';
  const where = isPlace && request.location ? ` in ${request.location}` : '';
  const constraints = isPlace ? request.constraints : { family: !!request.constraints?.family };
  const prompt = `A group needs a ${occasion.label.toLowerCase()}${where}. Constraints: ${JSON.stringify(constraints)}.
Members and favourites:\n${request.members.map((m) => `- ${m.name}: ${m.favourites.join(', ')}`).join('\n')}
Suggest 3 specific ${occasion.unit}s and one sentence each on why. Return ONLY JSON: {"picks":[{"name":"...","reason":"..."}]}`;
  try {
    const out = await llm.chat([{ role: 'user', content: prompt }], { maxTokens: 500, temperature: 0.7 });
    llmInfo.calls++;
    const json = extractJson(out.text);
    const picks = Array.isArray(json?.picks) ? json.picks.slice(0, 3).map((p) => ({ name: String(p.name || '').slice(0, 120), reason: String(p.reason || '').slice(0, 300) })) : [];
    return { available: true, picks, raw: picks.length ? undefined : (out.text || '').slice(0, 800), note: 'Generated by the LLM alone, with no access to Qloo. Names may be invented; nothing here is verified or scored per person.' };
  } catch (err) {
    return { available: false, reason: err.message };
  }
}
