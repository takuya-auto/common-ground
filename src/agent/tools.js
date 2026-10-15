// Agent tools. Each tool is a coarse, idempotent step over shared state. The
// same tools are invoked either by the LLM (tool-calling loop) or by the
// deterministic autopilot, and every invocation is appended to `state.steps`
// so the UI can show how the decision was made.

import { ENTITY, SEARCHABLE_TYPES } from '../qloo/params.js';
import { BUDGET_TO_PRICE_LEVEL, CONSTRAINT_QUERIES, FAMILY_CONTENT_RATINGS } from './occasions.js';
import { rankForGroup } from '../scoring/fairness.js';

export const MAX_POOL = 50; // Qloo `take` max and filter.results.entities budget per call
export const MIN_POOL = 3;  // below this, constraints get relaxed
const GROUP_TAKE = 20;
const MEMBER_TAKE = 10;

export function createState(request, occasion) {
  return {
    request,
    occasion,
    members: request.members.map((m, i) => ({
      id: `m${i + 1}`,
      name: m.name,
      favourites: m.favourites.map((text) => ({ input: text, entity: null, alternatives: [], typeHint: null })),
    })),
    tags: [],            // [{id, name, source}]
    excludeTags: [],
    priceLevelMax: null,
    contentRating: null,
    pool: new Map(),     // entityId -> candidate
    affinities: {},      // memberId -> { entityId -> affinity }
    drivers: {},         // memberId -> { entityId -> [{id, name, score}] }
    ranking: null,
    steps: [],
    warnings: [],
    relaxations: [],
  };
}

function step(state, actor, tool, args, fn) {
  const started = Date.now();
  const entry = { n: state.steps.length + 1, actor, tool, args };
  state.steps.push(entry);
  return Promise.resolve()
    .then(fn)
    .then((result) => {
      entry.ms = Date.now() - started;
      entry.result = result;
      return result;
    })
    .catch((err) => {
      entry.ms = Date.now() - started;
      entry.error = err.message;
      throw err;
    });
}

function memberById(state, id) {
  const m = state.members.find((x) => x.id === id || x.name.toLowerCase() === String(id).toLowerCase());
  if (!m) throw new Error(`Unknown member ${id}`);
  return m;
}

function allSignalIds(state) {
  return [...new Set(state.members.flatMap((m) => m.favourites.map((f) => f.entity?.id).filter(Boolean)))];
}

function memberSignalIds(member) {
  return [...new Set(member.favourites.map((f) => f.entity?.id).filter(Boolean))];
}

function toCandidate(e) {
  return {
    id: e.id,
    name: e.name,
    type: e.type,
    subtype: e.subtype,
    properties: pickProps(e.properties),
    tags: (e.tags || []).slice(0, 8).map((t) => ({ id: t.id, name: t.name })),
    popularity: e.popularity,
    groupAffinity: e.affinity ?? null,
    sources: [],
  };
}

function pickProps(p = {}) {
  const out = {};
  for (const k of ['address', 'price_level', 'business_rating', 'release_year', 'content_rating', 'description', 'website', 'phone', 'image']) {
    if (p[k] != null) out[k] = typeof p[k] === 'object' && k !== 'image' ? undefined : p[k];
  }
  if (p.image?.url) out.image = p.image.url;
  if (p.geocode?.name) out.locality = p.geocode.name;
  if (p.geocode?.country_code) out.country = p.geocode.country_code;
  return out;
}

export function createTools({ qloo, state }) {
  const occ = state.occasion;

  /** Resolve free-text favourites to Qloo entities via /search. */
  async function resolve_favourites({ hints = [] } = {}, actor = 'autopilot') {
    return step(state, actor, 'resolve_favourites', { hints: hints.length }, async () => {
      const hintMap = new Map(hints.map((h) => [`${String(h.member).toLowerCase()}|${String(h.text).toLowerCase()}`, h.type]));
      const resolved = [];
      for (const m of state.members) {
        for (const f of m.favourites) {
          if (f.entity) continue;
          const hint = hintMap.get(`${m.id}|${f.input.toLowerCase()}`) || hintMap.get(`${m.name.toLowerCase()}|${f.input.toLowerCase()}`);
          const types = hint && SEARCHABLE_TYPES.includes(hint) ? [hint] : undefined;
          f.typeHint = types ? hint : null;
          try {
            let results = await qloo.search(f.input, { types, take: 3, purpose: `resolve ${m.name}'s "${f.input}"` });
            if (!results.length && types) {
              results = await qloo.search(f.input, { take: 3, purpose: `retry "${f.input}" without type hint` });
            }
            if (results.length) {
              const best = results[0];
              f.entity = { id: best.id, name: best.name, type: best.type, subtype: best.subtype, disambiguation: best.disambiguation, tags: (best.tags || []).slice(0, 10).map((t) => ({ id: t.id, name: t.name })) };
              f.alternatives = results.slice(1, 3).map((r) => ({ id: r.id, name: r.name, type: r.type }));
              resolved.push({ member: m.name, input: f.input, resolved: best.name, type: best.type });
            } else {
              state.warnings.push(`Could not resolve "${f.input}" for ${m.name}`);
            }
          } catch (err) {
            state.warnings.push(`Search failed for "${f.input}" (${err.message})`);
          }
        }
      }
      for (const m of state.members) {
        if (!memberSignalIds(m).length) state.warnings.push(`${m.name} has no resolvable favourites; they cannot be scored.`);
      }
      return { resolved: resolved.length, unresolved: state.warnings.filter((w) => w.startsWith('Could not')).length, entities: resolved };
    });
  }

  /** Translate constraints into Qloo tags / filters, using /v2/tags for dietary & accessibility. */
  async function resolve_constraints({ pickFirst = true } = {}, actor = 'autopilot') {
    return step(state, actor, 'resolve_constraints', state.request.constraints || {}, async () => {
      const c = state.request.constraints || {};
      state.tags = occ.baseTags.map((id) => ({ id, name: id.split(':').pop().replace(/_/g, ' '), source: 'occasion' }));
      state.priceLevelMax = occ.type === ENTITY.PLACE ? BUDGET_TO_PRICE_LEVEL[c.budget || 'any'] ?? null : null;
      state.contentRating = c.family && FAMILY_CONTENT_RATINGS[occ.type] ? FAMILY_CONTENT_RATINGS[occ.type] : null;

      const wanted = [...(c.dietary || []), ...(c.accessibility || []), ...(c.family && occ.type === ENTITY.PLACE ? ['family'] : [])];
      const found = [];
      for (const key of wanted) {
        const def = CONSTRAINT_QUERIES[key];
        if (!def || !def.appliesTo.includes(occ.type)) continue;
        try {
          const tags = await qloo.searchTags(def.query, { parentTypes: [occ.type], take: 5, purpose: `tag for constraint "${key}"` });
          if (tags.length) {
            const chosen = pickFirst ? tags[0] : tags[tags.length - 1];
            state.tags.push({ id: chosen.id, name: chosen.name, source: `constraint:${key}`, required: true });
            found.push({ constraint: key, tag: chosen.id, options: tags.map((t) => t.id) });
          } else {
            state.warnings.push(`No Qloo tag found for constraint "${key}"; it was not applied.`);
          }
        } catch (err) {
          state.warnings.push(`Tag lookup failed for "${key}" (${err.message})`);
        }
      }
      return { tags: state.tags.map((t) => t.id), priceLevelMax: state.priceLevelMax, contentRating: state.contentRating, constraintTags: found };
    });
  }

  function insightsOpts(signalIds, take) {
    const occasionTags = state.tags.filter((t) => t.source === 'occasion').map((t) => t.id);
    const requiredTags = state.tags.filter((t) => t.required).map((t) => t.id);
    const opts = {
      signalEntities: signalIds,
      take,
      excludeTags: state.excludeTags,
    };
    // Occasion tags are a union ("restaurant OR bar"); required constraint tags
    // must all hold. Qloo has one operator per request, so when both exist we
    // use intersection with the constraint tags and keep the occasion tag only
    // if there is exactly one of them.
    if (requiredTags.length) {
      opts.filterTags = occasionTags.length === 1 ? [...occasionTags, ...requiredTags] : requiredTags;
      opts.filterTagsOperator = 'intersection';
    } else if (occasionTags.length) {
      opts.filterTags = occasionTags;
      opts.filterTagsOperator = 'union';
    }
    if (occ.needsLocation) opts.locationQuery = state.request.location;
    if (state.priceLevelMax) opts.priceLevelMax = state.priceLevelMax;
    if (state.contentRating) opts.contentRating = state.contentRating;
    return opts;
  }

  function addToPool(entities, source) {
    let added = 0;
    for (const e of entities) {
      if (!e.id) continue;
      let c = state.pool.get(e.id);
      if (!c) {
        if (state.pool.size >= MAX_POOL) break;
        c = toCandidate(e);
        state.pool.set(e.id, c);
        added++;
      }
      if (!c.sources.includes(source)) c.sources.push(source);
    }
    return added;
  }

  /** Candidate generation: one group query plus one per member so minority tastes are represented. */
  async function find_candidates({ groupTake = GROUP_TAKE, memberTake = MEMBER_TAKE } = {}, actor = 'autopilot') {
    return step(state, actor, 'find_candidates', { groupTake, memberTake }, async () => {
      const signal = allSignalIds(state);
      if (!signal.length) throw new Error('No resolved favourites; cannot query insights.');
      const report = { group: 0, perMember: {}, poolSize: 0 };
      try {
        const res = await qloo.insights(occ.type, { ...insightsOpts(signal, groupTake), purpose: `group candidates (${state.members.length} members' tastes combined)` });
        report.group = addToPool(res.entities, 'group');
        if (res.locality) state.locality = res.locality.name || res.locality;
      } catch (err) {
        state.warnings.push(`Group insights failed: ${err.message}`);
        if (err.status === 400 && occ.needsLocation) throw new Error(`Qloo could not find the location "${state.request.location}".`);
      }
      for (const m of state.members) {
        const ids = memberSignalIds(m);
        if (!ids.length) continue;
        try {
          const res = await qloo.insights(occ.type, { ...insightsOpts(ids, memberTake), purpose: `candidates ${m.name} alone would love` });
          report.perMember[m.name] = addToPool(res.entities, m.id);
        } catch (err) {
          state.warnings.push(`Insights for ${m.name} failed: ${err.message}`);
        }
      }
      report.poolSize = state.pool.size;
      return report;
    });
  }

  /** Score every candidate for every member with filter.results.entities + explainability. */
  async function score_pool(_args = {}, actor = 'autopilot') {
    return step(state, actor, 'score_pool', { poolSize: state.pool.size }, async () => {
      const ids = [...state.pool.keys()];
      if (!ids.length) throw new Error('Candidate pool is empty.');
      const report = {};
      for (const m of state.members) {
        const signal = memberSignalIds(m);
        if (!signal.length) continue;
        state.affinities[m.id] = {};
        state.drivers[m.id] = {};
        try {
          const res = await qloo.insights(occ.type, {
            signalEntities: signal,
            resultsEntities: ids,
            take: Math.min(MAX_POOL, ids.length),
            explainability: true,
            purpose: `score ${ids.length} candidates for ${m.name}`,
          });
          for (const e of res.entities) {
            if (typeof e.affinity === 'number') state.affinities[m.id][e.id] = e.affinity;
            state.drivers[m.id][e.id] = parseDrivers(e.explainability, m);
          }
          report[m.name] = { scored: res.entities.length, of: ids.length };
        } catch (err) {
          state.warnings.push(`Scoring for ${m.name} failed: ${err.message}`);
          report[m.name] = { scored: 0, of: ids.length, error: err.message };
        }
      }
      return report;
    });
  }

  /** Fairness ranking (pure computation, no Qloo call). */
  async function rank({ k = 3 } = {}, actor = 'autopilot') {
    return step(state, actor, 'rank', { k, strategy: 'maximin (0.6*min + 0.4*mean) + diversity' }, async () => {
      const memberIds = state.members.filter((m) => state.affinities[m.id]).map((m) => m.id);
      if (!memberIds.length) throw new Error('No member could be scored.');
      const candidates = [...state.pool.values()].map((c) => ({
        ...c,
        affinities: Object.fromEntries(memberIds.map((mid) => [mid, state.affinities[mid]?.[c.id]])),
        drivers: Object.fromEntries(memberIds.map((mid) => [mid, state.drivers[mid]?.[c.id] || []])),
      }));
      state.ranking = rankForGroup(candidates, memberIds, { k });
      return {
        picks: state.ranking.picks.map((p) => ({ name: p.name, min: round(p.min), mean: round(p.mean), lowest: nameOf(state, p.lowest) })),
        meanTop: state.ranking.meanTop ? { name: state.ranking.meanTop.name, min: round(state.ranking.meanTop.min) } : null,
      };
    });
  }

  /** Relax a constraint when the pool is empty/too small, then rebuild. */
  async function relax({ what, force = false } = {}, actor = 'autopilot') {
    return step(state, actor, 'relax', { what }, async () => {
      // Guardrail: never loosen the user's constraints while the pool is healthy.
      if (!force && state.pool.size >= MIN_POOL) {
        return { changed: false, reason: `pool has ${state.pool.size} candidates (>= ${MIN_POOL}); constraints kept` };
      }
      let changed = false;
      if (what === 'budget' && state.priceLevelMax) { state.priceLevelMax = Math.min(4, state.priceLevelMax + 1); changed = true; }
      else if (what === 'constraint_tags' && state.tags.some((t) => t.required)) { state.tags = state.tags.filter((t) => !t.required); changed = true; }
      else if (what === 'content_rating' && state.contentRating) { state.contentRating = null; changed = true; }
      else if (what === 'occasion_tags' && state.tags.some((t) => t.source === 'occasion')) { state.tags = state.tags.filter((t) => t.source !== 'occasion'); changed = true; }
      if (!changed) return { changed: false };
      state.relaxations.push(what);
      state.pool.clear();
      state.affinities = {};
      state.drivers = {};
      state.ranking = null;
      return { changed: true, relaxations: state.relaxations };
    });
  }

  return { resolve_favourites, resolve_constraints, find_candidates, score_pool, rank, relax };
}

function parseDrivers(explainability, member) {
  if (!explainability) return [];
  let list = explainability['signal.interests.entities'] ?? explainability.signal?.interests?.entities ?? explainability.entities ?? [];
  if (!Array.isArray(list) && typeof list === 'object') list = Object.entries(list).map(([entity_id, score]) => ({ entity_id, score }));
  if (!Array.isArray(list)) return [];
  const byId = new Map(member.favourites.filter((f) => f.entity).map((f) => [f.entity.id, f]));
  return list
    .map((d) => {
      const id = d.entity_id || d.id;
      const fav = byId.get(id);
      return { id, name: fav ? fav.entity.name : (d.name || 'unknown'), input: fav?.input, score: Number(d.score ?? d.value ?? 0) };
    })
    .filter((d) => d.id)
    .sort((a, b) => b.score - a.score);
}

function nameOf(state, memberId) {
  return state.members.find((m) => m.id === memberId)?.name || memberId;
}

function round(x) { return Math.round(x * 100) / 100; }

/** Tool schemas presented to the LLM (OpenAI-style function definitions). */
export const TOOL_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'resolve_favourites',
      description: 'Resolve every member\'s free-text favourites to Qloo entities via /search. Provide a type hint per favourite when you can tell what it is.',
      parameters: {
        type: 'object',
        properties: {
          hints: {
            type: 'array',
            description: 'Optional entity type hints for ambiguous favourites.',
            items: {
              type: 'object',
              properties: {
                member: { type: 'string', description: 'member id, e.g. m1' },
                text: { type: 'string', description: 'the favourite exactly as typed' },
                type: { type: 'string', enum: SEARCHABLE_TYPES },
              },
              required: ['member', 'text', 'type'],
            },
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'resolve_constraints',
      description: 'Turn the occasion and constraints (budget, dietary, accessibility, family) into Qloo filter tags using /v2/tags.',
      parameters: { type: 'object', properties: { pickFirst: { type: 'boolean', description: 'Use the top tag match (true) or the broadest (false).' } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_candidates',
      description: 'Query /v2/insights once for the whole group and once per member to build a candidate pool.',
      parameters: { type: 'object', properties: { groupTake: { type: 'integer', minimum: 5, maximum: 30 }, memberTake: { type: 'integer', minimum: 3, maximum: 15 } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'score_pool',
      description: 'Ask Qloo for every member\'s affinity to every pooled candidate (filter.results.entities + explainability).',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'rank',
      description: 'Rank candidates by group fairness (maximize the least-satisfied member) and return the top picks.',
      parameters: { type: 'object', properties: { k: { type: 'integer', minimum: 1, maximum: 5 } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'relax',
      description: `Only when find_candidates reports poolSize below ${MIN_POOL}: relax one constraint and run find_candidates again. Refused while the pool is healthy.`,
      parameters: { type: 'object', properties: { what: { type: 'string', enum: ['budget', 'constraint_tags', 'content_rating', 'occasion_tags'] } }, required: ['what'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'finish',
      description: 'Call when ranking is done. Provide a one-sentence summary for the group.',
      parameters: { type: 'object', properties: { summary: { type: 'string' } } },
    },
  },
];
