import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildInsightsParams, buildSearchParams, buildTagSearchParams, toQueryString, ENTITY, QlooParamError, ALLOWED_PARAMS } from '../src/qloo/params.js';

const ID_A = '636e1b95-6232-43e1-bdfe-37cd209c2ce3';
const ID_B = '7d2b1dff-9d5d-44de-970e-46b80c76cfa6';

test('place insights request carries location, tags, price and explainability', () => {
  const p = buildInsightsParams(ENTITY.PLACE, {
    signalEntities: [ID_A, ID_B],
    locationQuery: 'Tokyo',
    filterTags: ['urn:tag:genre:place:restaurant', 'urn:tag:keyword:place:vegetarian_options'],
    filterTagsOperator: 'intersection',
    priceLevelMax: 2,
    explainability: true,
    take: 30,
  });
  assert.equal(p['filter.type'], 'urn:entity:place');
  assert.equal(p['signal.interests.entities'], `${ID_A},${ID_B}`);
  assert.equal(p['filter.location.query'], 'Tokyo');
  assert.equal(p['filter.tags'], 'urn:tag:genre:place:restaurant,urn:tag:keyword:place:vegetarian_options');
  assert.equal(p['operator.filter.tags'], 'intersection');
  assert.equal(p['filter.price_level.max'], '2');
  assert.equal(p['feature.explainability'], 'true');
  assert.equal(p.take, '30');
});

test('take is clamped to Qloo maximum of 50', () => {
  const p = buildInsightsParams(ENTITY.MOVIE, { signalEntities: [ID_A], take: 500 });
  assert.equal(p.take, '50');
});

test('params invalid for the entity type are rejected, not silently sent', () => {
  assert.throws(() => buildInsightsParams(ENTITY.MOVIE, { signalEntities: [ID_A], locationQuery: 'Tokyo' }), QlooParamError);
  assert.throws(() => buildInsightsParams(ENTITY.MOVIE, { signalEntities: [ID_A], priceLevelMax: 2 }), QlooParamError);
  assert.throws(() => buildInsightsParams(ENTITY.PLACE, { signalEntities: [ID_A], contentRating: ['PG'] }), QlooParamError);
  assert.throws(() => buildInsightsParams(ENTITY.ARTIST, { signalEntities: [ID_A], releaseYearMin: 1990 }), QlooParamError);
});

test('movie and tv accept content_rating and release_year; destination requires an entity signal', () => {
  const m = buildInsightsParams(ENTITY.MOVIE, { signalEntities: [ID_A], contentRating: ['G', 'PG'], releaseYearMin: 2000 });
  assert.equal(m['filter.content_rating'], 'G,PG');
  assert.equal(m['filter.release_year.min'], '2000');
  assert.throws(() => buildInsightsParams(ENTITY.DESTINATION, { filterTags: ['urn:tag:genre:destination:beach'] }), /requires signal.interests.entities/);
  assert.ok(buildInsightsParams(ENTITY.DESTINATION, { signalEntities: [ID_A] }));
});

test('rejects non-UUID signal ids, bad price levels and empty requests', () => {
  assert.throws(() => buildInsightsParams(ENTITY.PLACE, { signalEntities: ['Radiohead'] }), /not a Qloo UUID/);
  assert.throws(() => buildInsightsParams(ENTITY.PLACE, { signalEntities: [ID_A], priceLevelMax: 7 }), /price_level/);
  assert.throws(() => buildInsightsParams(ENTITY.PLACE, {}), /at least one signal/);
  assert.throws(() => buildInsightsParams('urn:entity:actor', { signalEntities: [ID_A] }), /Unsupported/);
});

test('filter.results.entities alone is a valid request (affinity assessment)', () => {
  const p = buildInsightsParams(ENTITY.PLACE, { signalEntities: [ID_A], resultsEntities: [ID_B] });
  assert.equal(p['filter.results.entities'], ID_B);
});

test('search params: types restricted to searchable set, take clamped', () => {
  const p = buildSearchParams('Radiohead', { types: [ENTITY.ARTIST], take: 99 });
  assert.deepEqual(p, { query: 'Radiohead', take: '20', types: 'urn:entity:artist' });
  assert.throws(() => buildSearchParams('x', { types: ['urn:entity:album'] }), /Unsupported search type/);
  assert.throws(() => buildSearchParams('   '), /empty/);
});

test('tag search params', () => {
  const p = buildTagSearchParams('vegetarian', { parentTypes: [ENTITY.PLACE], take: 5 });
  assert.deepEqual(p, { 'filter.query': 'vegetarian', take: '5', 'filter.parents.types': 'urn:entity:place' });
});

test('query string encodes commas and spaces safely', () => {
  const qs = toQueryString({ 'filter.location.query': 'New York City', 'filter.tags': 'a,b' });
  assert.equal(qs, 'filter.location.query=New+York+City&filter.tags=a%2Cb');
});

test('allowlist matches the entity-type guide for a few spot checks', () => {
  assert.ok(ALLOWED_PARAMS[ENTITY.PLACE].has('filter.location.query'));
  assert.ok(!ALLOWED_PARAMS[ENTITY.MOVIE].has('filter.location.query'));
  assert.ok(ALLOWED_PARAMS[ENTITY.TV_SHOW].has('filter.finale_year.min'));
  assert.ok(ALLOWED_PARAMS[ENTITY.BOOK].has('filter.publication_year.min'));
  assert.ok(!ALLOWED_PARAMS[ENTITY.BOOK].has('filter.release_year.min'));
});
