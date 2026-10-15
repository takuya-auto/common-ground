// Qloo Insights parameter allowlist and request builders.
//
// Qloo silently ignores parameters that are not valid for the chosen
// filter.type, so a typo or a misplaced filter degrades results without any
// error. Everything we send to /v2/insights goes through `buildInsightsParams`,
// which validates against the Entity Type Parameter Guide
// (docs/doc-available-parameters-by-entity-type.md) and throws on misuse.

export const ENTITY = Object.freeze({
  ARTIST: 'urn:entity:artist',
  BOOK: 'urn:entity:book',
  BRAND: 'urn:entity:brand',
  DESTINATION: 'urn:entity:destination',
  MOVIE: 'urn:entity:movie',
  PERSON: 'urn:entity:person',
  PLACE: 'urn:entity:place',
  PODCAST: 'urn:entity:podcast',
  TV_SHOW: 'urn:entity:tv_show',
  VIDEOGAME: 'urn:entity:videogame',
  LOCALITY: 'urn:entity:locality',
});

// Types that /search accepts for resolving free-text favourites. We never
// use the deprecated search-only types (actor/album/author/director).
export const SEARCHABLE_TYPES = Object.freeze([
  ENTITY.ARTIST, ENTITY.BOOK, ENTITY.BRAND, ENTITY.MOVIE, ENTITY.PERSON,
  ENTITY.PLACE, ENTITY.PODCAST, ENTITY.TV_SHOW, ENTITY.VIDEOGAME,
]);

const COMMON = [
  'filter.type', 'bias.trends', 'filter.exclude.entities', 'filter.exclude.tags',
  'operator.exclude.tags', 'filter.external.exists', 'operator.filter.external.exists',
  'filter.parents.types', 'filter.popularity.min', 'filter.popularity.max',
  'filter.results.entities', 'filter.results.entities.query', 'filter.tags',
  'operator.filter.tags', 'offset', 'take', 'page',
  'signal.demographics.age', 'signal.demographics.audiences',
  'signal.demographics.audiences.weight', 'signal.demographics.gender',
  'signal.interests.entities', 'signal.interests.tags',
  'signal.interests.entities.weight', 'signal.interests.tags.weight',
  'operator.signal.interests.tags', 'feature.explainability',
];

// Per-type allowlist, transcribed from the Entity Type Parameter Guide.
export const ALLOWED_PARAMS = Object.freeze({
  [ENTITY.ARTIST]: new Set(COMMON),
  [ENTITY.BOOK]: new Set([...COMMON, 'filter.publication_year.min', 'filter.publication_year.max']),
  [ENTITY.BRAND]: new Set(COMMON),
  [ENTITY.DESTINATION]: new Set([...COMMON,
    'filter.geocode.name', 'filter.geocode.admin1_region', 'filter.geocode.admin2_region',
    'filter.geocode.country_code', 'filter.location', 'filter.location.radius',
    'filter.location.geohash', 'filter.exclude.location.geohash']),
  [ENTITY.MOVIE]: new Set([...COMMON, 'filter.content_rating', 'filter.release_year.min',
    'filter.release_year.max', 'filter.release_country', 'operator.filter.release_country',
    'filter.rating.min', 'filter.rating.max']),
  [ENTITY.PERSON]: new Set([...COMMON, 'filter.date_of_birth.min', 'filter.date_of_birth.max',
    'filter.date_of_death.min', 'filter.date_of_death.max', 'filter.gender']),
  [ENTITY.PLACE]: new Set([...COMMON, 'bias.quality', 'filter.address',
    'filter.external.tripadvisor.rating.count.max', 'filter.external.tripadvisor.rating.count.min',
    'filter.external.tripadvisor.rating.max', 'filter.external.tripadvisor.rating.min',
    'filter.geocode.name', 'filter.geocode.admin1_region', 'filter.geocode.admin2_region',
    'filter.geocode.country_code', 'filter.hotel_class.max', 'filter.hotel_class.min',
    'filter.hours', 'filter.location', 'filter.location.query', 'filter.location.geohash',
    'filter.exclude.location.geohash', 'filter.location.radius', 'filter.price_level.min',
    'filter.price_level.max', 'filter.price_range.from', 'filter.price_range.to',
    'filter.properties.business_rating.min', 'filter.properties.business_rating.max',
    'filter.properties.resy.rating.min', 'filter.properties.resy.rating.max',
    'filter.references_brand', 'filter.resy.rating_count.min', 'filter.resy.rating_count.max',
    'filter.resy.rating.party.min', 'filter.resy.rating.party.max', 'sort_by']),
  [ENTITY.PODCAST]: new Set(COMMON),
  [ENTITY.TV_SHOW]: new Set([...COMMON, 'filter.content_rating', 'filter.finale_year.max',
    'filter.finale_year.min', 'filter.latest_known_year.max', 'filter.latest_known_year.min',
    'filter.release_year.max', 'filter.release_year.min', 'filter.release_country',
    'operator.filter.release_country', 'filter.rating.max', 'filter.rating.min']),
  [ENTITY.VIDEOGAME]: new Set(COMMON),
});

// Required params beyond filter.type. Destination needs an interest signal.
const REQUIRED = Object.freeze({
  [ENTITY.DESTINATION]: ['signal.interests.entities'],
});

export class QlooParamError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'QlooParamError';
    this.details = details;
  }
}

const MAX_TAKE = 50;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toList(v) {
  if (v == null) return [];
  if (Array.isArray(v)) return v.filter((x) => x != null && x !== '');
  return String(v).split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * Build a validated, flat params object for GET /v2/insights.
 * @param {string} type one of ENTITY.*
 * @param {object} opts
 * @returns {Record<string,string>} query params (all string values)
 */
export function buildInsightsParams(type, opts = {}) {
  const allowed = ALLOWED_PARAMS[type];
  if (!allowed) throw new QlooParamError(`Unsupported filter.type: ${type}`);

  const out = { 'filter.type': type };
  const set = (k, v) => {
    if (v == null || v === '' || (Array.isArray(v) && v.length === 0)) return;
    if (!allowed.has(k)) {
      throw new QlooParamError(`Parameter ${k} is not valid for ${type}`, { param: k, type });
    }
    out[k] = Array.isArray(v) ? v.join(',') : String(v);
  };

  const signalEntities = toList(opts.signalEntities);
  for (const id of signalEntities) {
    if (!UUID_RE.test(id)) throw new QlooParamError(`signal entity is not a Qloo UUID: ${id}`);
  }
  set('signal.interests.entities', signalEntities);
  set('signal.interests.tags', toList(opts.signalTags));
  set('filter.tags', toList(opts.filterTags));
  if (opts.filterTags && opts.filterTagsOperator) set('operator.filter.tags', opts.filterTagsOperator);
  set('filter.exclude.tags', toList(opts.excludeTags));
  set('filter.exclude.entities', toList(opts.excludeEntities));
  set('filter.results.entities', toList(opts.resultsEntities));
  set('filter.location.query', opts.locationQuery);
  set('filter.location', opts.location);
  if (opts.locationRadius != null) set('filter.location.radius', Math.max(0, Math.round(opts.locationRadius)));
  if (opts.priceLevelMax != null) {
    const n = Number(opts.priceLevelMax);
    if (!(n >= 1 && n <= 4)) throw new QlooParamError('filter.price_level.max must be 1-4');
    set('filter.price_level.max', n);
  }
  if (opts.priceLevelMin != null) {
    const n = Number(opts.priceLevelMin);
    if (!(n >= 1 && n <= 4)) throw new QlooParamError('filter.price_level.min must be 1-4');
    set('filter.price_level.min', n);
  }
  set('filter.content_rating', toList(opts.contentRating));
  if (opts.releaseYearMin != null) set('filter.release_year.min', opts.releaseYearMin);
  if (opts.releaseYearMax != null) set('filter.release_year.max', opts.releaseYearMax);
  if (opts.popularityMin != null) set('filter.popularity.min', opts.popularityMin);
  if (opts.businessRatingMin != null) set('filter.properties.business_rating.min', opts.businessRatingMin);
  set('sort_by', opts.sortBy);
  if (opts.explainability) set('feature.explainability', 'true');
  if (opts.take != null) {
    const n = Math.floor(Number(opts.take));
    if (!(n >= 1)) throw new QlooParamError('take must be >= 1');
    set('take', Math.min(n, MAX_TAKE));
  }
  if (opts.page != null) set('page', opts.page);

  for (const req of REQUIRED[type] || []) {
    if (!out[req]) throw new QlooParamError(`${type} requires ${req}`, { param: req, type });
  }
  if (!out['signal.interests.entities'] && !out['signal.interests.tags'] && !out['filter.tags'] && !out['filter.results.entities']) {
    throw new QlooParamError('Insights request needs at least one signal or filter besides filter.type');
  }
  return out;
}

/** Build params for GET /search. */
export function buildSearchParams(query, { types, take = 5, location, radius } = {}) {
  const q = String(query || '').trim();
  if (!q) throw new QlooParamError('search query is empty');
  const out = { query: q, take: String(Math.min(Math.max(1, take | 0), 20)) };
  const ts = toList(types);
  for (const t of ts) {
    if (!SEARCHABLE_TYPES.includes(t)) throw new QlooParamError(`Unsupported search type: ${t}`);
  }
  if (ts.length) out.types = ts.join(',');
  if (location) out['filter.location'] = String(location);
  if (radius != null) out['filter.radius'] = String(radius);
  return out;
}

/** Build params for GET /v2/tags (tag search). */
export function buildTagSearchParams(query, { parentTypes, tagTypes, take = 10 } = {}) {
  const q = String(query || '').trim();
  if (!q) throw new QlooParamError('tag query is empty');
  const out = { 'filter.query': q, take: String(Math.min(Math.max(1, take | 0), 50)) };
  const pts = toList(parentTypes);
  if (pts.length) out['filter.parents.types'] = pts.join(',');
  const tts = toList(tagTypes);
  if (tts.length) out['filter.tag.types'] = tts.join(',');
  return out;
}

export function toQueryString(params) {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== '') usp.set(k, String(v));
  }
  return usp.toString();
}
