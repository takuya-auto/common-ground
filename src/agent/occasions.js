// Occasion -> Qloo query shape. Each occasion says which filter.type we ask
// Qloo for, which base tags constrain the candidate pool, and how constraints
// (budget, dietary, accessibility, family) translate into Qloo parameters.

import { ENTITY } from '../qloo/params.js';

export const OCCASIONS = Object.freeze({
  dinner: {
    label: 'Dinner',
    type: ENTITY.PLACE,
    needsLocation: true,
    baseTags: ['urn:tag:genre:place:restaurant'],
    tagOperator: 'union',
    unit: 'restaurant',
  },
  night_out: {
    label: 'Night out',
    type: ENTITY.PLACE,
    needsLocation: true,
    baseTags: ['urn:tag:genre:place:bar', 'urn:tag:genre:place:night_club', 'urn:tag:genre:place:live_music_venue'],
    tagOperator: 'union',
    unit: 'venue',
  },
  movie_night: {
    label: 'Movie night',
    type: ENTITY.MOVIE,
    needsLocation: false,
    baseTags: [],
    unit: 'film',
  },
  tv_night: {
    label: 'TV night',
    type: ENTITY.TV_SHOW,
    needsLocation: false,
    baseTags: [],
    unit: 'show',
  },
  weekend_trip: {
    label: 'Weekend trip',
    type: ENTITY.DESTINATION,
    needsLocation: false,
    baseTags: [],
    unit: 'destination',
  },
});

// Budget levels map to Qloo's 1-4 price_level (places only).
export const BUDGET_TO_PRICE_LEVEL = Object.freeze({ low: 1, medium: 2, high: 3, any: null });

// Dietary / accessibility constraints are resolved to tags via /v2/tags at run
// time; these are the search phrases we send. (Tag ids are never hard-coded for
// live mode, because the real tag URNs must come from Qloo.)
export const CONSTRAINT_QUERIES = Object.freeze({
  vegetarian: { query: 'vegetarian', appliesTo: [ENTITY.PLACE] },
  vegan: { query: 'vegan', appliesTo: [ENTITY.PLACE] },
  gluten_free: { query: 'gluten free', appliesTo: [ENTITY.PLACE] },
  halal: { query: 'halal', appliesTo: [ENTITY.PLACE] },
  wheelchair: { query: 'wheelchair accessible', appliesTo: [ENTITY.PLACE] },
  family: { query: 'family', appliesTo: [ENTITY.PLACE, ENTITY.MOVIE, ENTITY.TV_SHOW, ENTITY.DESTINATION] },
});

// Family-friendly screen content: MPAA / TV ratings we allow.
export const FAMILY_CONTENT_RATINGS = Object.freeze({
  [ENTITY.MOVIE]: ['G', 'PG', 'PG-13'],
  [ENTITY.TV_SHOW]: ['TV-Y', 'TV-Y7', 'TV-G', 'TV-PG', 'TV-14'],
});

export function getOccasion(key) {
  const o = OCCASIONS[key];
  if (!o) throw new Error(`Unknown occasion: ${key}`);
  return { key, ...o };
}
