// Mock Qloo API used when QLOO_API_KEY is not configured.
//
// It serves the same three endpoints the live client uses (/search, /v2/tags,
// /v2/insights) from SYNTHETIC fixtures (see fixtures/README.md). Affinities
// are computed locally from tag overlap so that any input produces plausible,
// deterministic, explainable output. Nothing here is Qloo data.

import tagDims from '../../fixtures/tag-dimensions.json' with { type: 'json' };
import favourites from '../../fixtures/favourites.json' with { type: 'json' };
import places from '../../fixtures/places.json' with { type: 'json' };
import movies from '../../fixtures/movies.json' with { type: 'json' };
import tv from '../../fixtures/tv.json' with { type: 'json' };
import destinations from '../../fixtures/destinations.json' with { type: 'json' };
import tagCatalog from '../../fixtures/tags.json' with { type: 'json' };

const DIMS = tagDims.dimensions;
const TAGS = tagDims.tags;

// ---- deterministic hashing -------------------------------------------------

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function hex(n, width) {
  return (n >>> 0).toString(16).padStart(width, '0').slice(-width);
}

/** Deterministic fake UUID for a string. Prefix "m0ck" makes mock ids recognisable. */
export function mockUuid(seed) {
  const a = fnv1a('a:' + seed), b = fnv1a('b:' + seed), c = fnv1a('c:' + seed), d = fnv1a('d:' + seed);
  return `${hex(a, 8)}-${hex(b, 4)}-4${hex(b >>> 16, 3)}-a${hex(c, 3)}-${hex(c >>> 8, 4)}${hex(d, 8)}`.toLowerCase();
}

function norm(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// ---- taste vectors ---------------------------------------------------------

export function vectorFromTags(tags) {
  const v = new Array(DIMS.length).fill(0);
  for (const t of tags || []) {
    const def = TAGS[t];
    if (!def) continue;
    for (const [dim, w] of Object.entries(def.dims)) {
      const i = DIMS.indexOf(dim);
      if (i >= 0) v[i] += w;
    }
  }
  return v;
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (!na || !nb) return 0;
  return dot / Math.sqrt(na * nb);
}

function addInto(acc, v) { for (let i = 0; i < acc.length; i++) acc[i] += v[i]; return acc; }

function tagObj(id) {
  const def = TAGS[id];
  const type = id.split(':').slice(0, 3).join(':');
  return { id, name: def ? def.label : id.split(':').pop().replace(/_/g, ' '), type };
}

// ---- catalog ---------------------------------------------------------------

function makeEntity(raw, type, subtype) {
  const id = mockUuid(type + '|' + raw.name);
  const props = {};
  if (raw.price_level) props.price_level = raw.price_level;
  if (raw.rating) props.business_rating = raw.rating;
  if (raw.year) props.release_year = raw.year;
  if (raw.content_rating) props.content_rating = raw.content_rating;
  if (raw.country) props.geocode = { country_code: raw.country };
  return {
    name: raw.name,
    entity_id: id,
    type,
    subtype: subtype || raw.subtype || type,
    properties: props,
    tags: raw.tags.map(tagObj),
    popularity: 0.5 + ((fnv1a('pop' + raw.name) % 450) / 1000),
    _tags: raw.tags,
    _vec: vectorFromTags(raw.tags),
    _mock: true,
  };
}

const CATALOG = {
  'urn:entity:place': places.entities.map((e) => makeEntity(e, 'urn:entity:place')),
  'urn:entity:movie': movies.entities.map((e) => makeEntity(e, 'urn:entity:movie')),
  'urn:entity:tv_show': tv.entities.map((e) => makeEntity(e, 'urn:entity:tv_show')),
  'urn:entity:destination': destinations.entities.map((e) => makeEntity(e, 'urn:entity:destination')),
};

const FAVOURITES = favourites.entities.map((e) => makeEntity(e, e.type));

// id -> entity, for signal and results lookups
const REGISTRY = new Map();
for (const list of Object.values(CATALOG)) for (const e of list) REGISTRY.set(e.entity_id, e);
for (const e of FAVOURITES) REGISTRY.set(e.entity_id, e);

const ALL_TAG_IDS = Object.keys(TAGS).filter((t) => Object.keys(TAGS[t].dims).length > 0);

/** For a name the mock has never seen, synthesise an entity whose tags derive from the id hash. */
function synthesiseEntity(name, typeHint) {
  const type = typeHint || guessType(name);
  const id = mockUuid('synth|' + norm(name));
  const h = fnv1a(id);
  const tags = [ALL_TAG_IDS[h % ALL_TAG_IDS.length], ALL_TAG_IDS[(h >>> 8) % ALL_TAG_IDS.length], ALL_TAG_IDS[(h >>> 16) % ALL_TAG_IDS.length]];
  const e = makeEntity({ name, tags: [...new Set(tags)] }, type);
  e.entity_id = id;
  e.disambiguation = 'mock entity (not in synthetic catalog)';
  REGISTRY.set(id, e);
  return e;
}

function guessType(name) {
  const n = norm(name);
  if (/\b(bar|pub|restaurant|cafe|sushi|ramen|pizza|taco|burger|grill|bistro)\b/.test(n)) return 'urn:entity:place';
  if (/\b(season|show|series)\b/.test(n)) return 'urn:entity:tv_show';
  if (/\b(the|of|part|movie|film)\b/.test(n)) return 'urn:entity:movie';
  return 'urn:entity:artist';
}

function lookupEntity(id) {
  if (REGISTRY.has(id)) return REGISTRY.get(id);
  // Unknown id (e.g. synthesised in another isolate): regenerate tags from the id hash.
  const h = fnv1a(id);
  const tags = [ALL_TAG_IDS[h % ALL_TAG_IDS.length], ALL_TAG_IDS[(h >>> 8) % ALL_TAG_IDS.length]];
  const e = makeEntity({ name: 'unknown', tags }, 'urn:entity:artist');
  e.entity_id = id;
  return e;
}

// ---- endpoint: /search -----------------------------------------------------

function scoreMatch(query, name) {
  const q = norm(query), n = norm(name);
  if (!q || !n) return 0;
  if (q === n) return 1;
  if (n.startsWith(q) || q.startsWith(n)) return 0.9;
  if (n.includes(q) || q.includes(n)) return 0.75;
  const qw = new Set(q.split(' ')), nw = n.split(' ');
  const overlap = nw.filter((w) => qw.has(w)).length;
  return overlap ? 0.4 + 0.3 * (overlap / Math.max(qw.size, nw.length)) : 0;
}

export function mockSearch(params) {
  const query = params.query || '';
  const types = params.types ? String(params.types).split(',') : null;
  const take = Math.max(1, Math.min(20, Number(params.take) || 5));
  let pool = [...FAVOURITES, ...Object.values(CATALOG).flat()];
  if (types) pool = pool.filter((e) => types.includes(e.type));
  const ranked = pool
    .map((e) => ({ e, s: scoreMatch(query, e.name) }))
    .filter((x) => x.s >= 0.5)
    .sort((a, b) => b.s - a.s || b.e.popularity - a.e.popularity)
    .slice(0, take)
    .map((x) => x.e);
  if (ranked.length === 0) {
    const hint = types && types.length === 1 ? types[0] : null;
    ranked.push(synthesiseEntity(query, hint));
  }
  return { success: true, duration: 0.01, results: ranked.map(publicEntity), _mock: true };
}

// ---- endpoint: /v2/tags ----------------------------------------------------

export function mockTags(params) {
  const q = norm(params['filter.query'] || '');
  const parents = params['filter.parents.types'] ? String(params['filter.parents.types']).split(',') : null;
  const take = Math.max(1, Math.min(50, Number(params.take) || 10));
  const hits = tagCatalog.tags
    .map((t) => {
      let s = 0;
      if (q) {
        if (norm(t.name) === q || t.aliases.some((a) => norm(a) === q)) s = 1;
        else if (norm(t.name).includes(q) || t.aliases.some((a) => norm(a).includes(q) || q.includes(norm(a)))) s = 0.7;
      }
      return { t, s };
    })
    .filter((x) => x.s > 0 && (!parents || x.t.parents.some((p) => parents.includes(p))))
    .sort((a, b) => b.s - a.s)
    .slice(0, take)
    .map(({ t }) => ({ id: t.id, name: t.name, type: t.type, parents: t.parents.map((p) => ({ type: p })) }));
  return { success: true, duration: 0.01, results: { tags: hits }, _mock: true };
}

// ---- endpoint: /v2/insights ------------------------------------------------

function tagMatches(entityTags, filterTag) {
  return entityTags.some((t) => t === filterTag || t.startsWith(filterTag + ':'));
}

export function mockInsights(params) {
  const type = params['filter.type'];
  const pool = CATALOG[type];
  if (!pool) {
    return { success: false, error: { code: 400, message: `mock: unsupported filter.type ${type}` } };
  }
  const signalIds = (params['signal.interests.entities'] || '').split(',').filter(Boolean);
  const signalEntities = signalIds.map(lookupEntity);
  const memberVec = signalEntities.reduce((acc, e) => addInto(acc, e._vec), new Array(DIMS.length).fill(0));

  const filterTags = (params['filter.tags'] || '').split(',').filter(Boolean);
  const tagOp = params['operator.filter.tags'] === 'intersection' ? 'intersection' : 'union';
  const excludeTags = (params['filter.exclude.tags'] || '').split(',').filter(Boolean);
  const excludeIds = new Set((params['filter.exclude.entities'] || '').split(',').filter(Boolean));
  const resultsIds = (params['filter.results.entities'] || '').split(',').filter(Boolean);
  const priceMax = params['filter.price_level.max'] ? Number(params['filter.price_level.max']) : null;
  const priceMin = params['filter.price_level.min'] ? Number(params['filter.price_level.min']) : null;
  const contentRatings = (params['filter.content_rating'] || '').split(',').filter(Boolean);
  const locality = params['filter.location.query'] || null;
  const take = Math.max(1, Math.min(50, Number(params.take) || 20));
  const explain = params['feature.explainability'] === 'true';

  if (params['filter.location.query'] !== undefined && !String(locality || '').trim()) {
    return { success: false, error: { code: 400, message: 'mock: no locality found for filter.location.query' } };
  }

  let cands = pool;
  if (resultsIds.length) {
    const set = new Set(resultsIds);
    cands = pool.filter((e) => set.has(e.entity_id));
  }
  if (filterTags.length) {
    cands = cands.filter((e) => tagOp === 'union'
      ? filterTags.some((t) => tagMatches(e._tags, t))
      : filterTags.every((t) => tagMatches(e._tags, t)));
  }
  if (excludeTags.length) cands = cands.filter((e) => !excludeTags.some((t) => tagMatches(e._tags, t)));
  if (excludeIds.size) cands = cands.filter((e) => !excludeIds.has(e.entity_id));
  if (priceMax != null) cands = cands.filter((e) => (e.properties.price_level || 2) <= priceMax);
  if (priceMin != null) cands = cands.filter((e) => (e.properties.price_level || 2) >= priceMin);
  if (contentRatings.length) cands = cands.filter((e) => contentRatings.includes(e.properties.content_rating));

  const signalKey = signalIds.slice().sort().join('|');
  const scored = cands.map((e) => {
    const cos = signalEntities.length ? cosine(memberVec, e._vec) : 0.5;
    const jitter = ((fnv1a(e.entity_id + '#' + signalKey) % 1000) / 1000 - 0.5) * 0.08;
    const affinity = Math.min(0.99, Math.max(0.05, 0.3 + 0.65 * cos + jitter));
    const out = publicEntity(e);
    if (locality) out.properties = { ...out.properties, address: `${e.name} St, ${locality}`, geocode: { name: locality } };
    out.query = { affinity: Number(affinity.toFixed(4)) };
    if (explain && signalEntities.length) {
      const contribs = signalEntities.map((s) => ({ entity_id: s.entity_id, raw: Math.max(0, cosine(s._vec, e._vec)) }));
      const total = contribs.reduce((a, c) => a + c.raw, 0) || 1;
      out.query.explainability = {
        'signal.interests.entities': contribs
          .map((c) => ({ entity_id: c.entity_id, score: Number((c.raw / total).toFixed(3)) }))
          .filter((c) => c.score >= 0.1 || contribs.length <= 2)
          .sort((a, b) => b.score - a.score),
      };
    }
    return out;
  });
  scored.sort((a, b) => b.query.affinity - a.query.affinity);
  const entities = scored.slice(0, take);

  const response = { success: true, duration: 0.02, results: { entities }, query: {}, _mock: true };
  if (locality) response.query.locality = { signal: { name: locality, entity_id: mockUuid('locality|' + norm(locality)), type: 'urn:entity:locality' } };
  return response;
}

function publicEntity(e) {
  return {
    name: e.name,
    entity_id: e.entity_id,
    type: e.type,
    subtype: e.subtype,
    properties: { ...e.properties },
    tags: e.tags.map((t) => ({ ...t })),
    popularity: Number(e.popularity.toFixed(3)),
    ...(e.disambiguation ? { disambiguation: e.disambiguation } : {}),
  };
}

/** Dispatch a mock request by path. */
export function mockRequest(path, params) {
  switch (path) {
    case '/search': return mockSearch(params);
    case '/v2/tags': return mockTags(params);
    case '/v2/insights': return mockInsights(params);
    default: return { success: false, error: { code: 404, message: `mock: unknown path ${path}` } };
  }
}
