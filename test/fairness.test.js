import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePerMember, scoreFairness, attachRegret, pickTopK, compromiseReport, rankForGroup } from '../src/scoring/fairness.js';

const members = ['a', 'b', 'c'];
const cand = (id, affs, tags = []) => ({ id, name: id, affinities: Object.fromEntries(members.map((m, i) => [m, affs[i]])), tags: tags.map((t) => ({ id: t, name: t })) });

test('normalization divides by each member\'s best affinity', () => {
  const [x, y] = normalizePerMember([cand('x', [0.9, 0.3, 0.6]), cand('y', [0.45, 0.6, 0.3])], members);
  assert.equal(x.sat.a, 1);
  assert.equal(y.sat.a, 0.5);
  assert.equal(x.sat.b, 0.5);
  assert.equal(y.sat.b, 1);
  assert.equal(y.sat.c, 0.5);
});

test('missing affinities are scored as 0 and flagged as estimated', () => {
  const [x] = normalizePerMember([cand('x', [0.9, undefined, 0.6])], members);
  assert.equal(x.sat.b, 0);
  assert.equal(x.estimated.b, true);
  assert.equal(x.estimated.a, undefined);
});

test('maximin prefers the option that lifts the least-happy member over the highest average', () => {
  // "avg" is loved by two and hated by one; "fair" is decent for everyone.
  const pool = [cand('avg', [1.0, 1.0, 0.45]), cand('fair', [0.75, 0.75, 0.75])];
  const { picks, meanTop } = rankForGroup(pool, members, { k: 1 });
  assert.equal(picks[0].id, 'fair');
  assert.equal(meanTop.id, 'avg');
  assert.ok(picks[0].min > meanTop.min);
});

test('fairness score is 0.6*min + 0.4*mean and lowest/highest members are identified', () => {
  const [s] = scoreFairness(normalizePerMember([cand('x', [1, 0.5, 0.8]), cand('y', [0.5, 1, 0.8])], members), members);
  assert.ok(Math.abs(s.fairScore - (0.6 * 0.5 + 0.4 * (1 + 0.5 + 1) / 3)) < 1e-9);
  assert.equal(s.lowest, 'b');
  assert.equal(s.highest, 'a');
});

test('regret is distance from each member\'s best candidate', () => {
  const scored = attachRegret(scoreFairness(normalizePerMember([cand('x', [1, 0.5, 0.8]), cand('y', [0.5, 1, 0.8])], members), members), members);
  const x = scored.find((c) => c.id === 'x');
  assert.equal(x.regret.a, 0);
  assert.equal(x.regret.b, 0.5);
  assert.equal(x.regret.c, 0);
});

test('diversity penalty avoids three options of the same kind', () => {
  const pool = [
    cand('italian1', [0.9, 0.9, 0.9], ['urn:tag:genre:place:restaurant:italian']),
    cand('italian2', [0.89, 0.89, 0.89], ['urn:tag:genre:place:restaurant:italian']),
    cand('thai', [0.8, 0.8, 0.8], ['urn:tag:genre:place:restaurant:thai']),
    cand('italian3', [0.88, 0.88, 0.88], ['urn:tag:genre:place:restaurant:italian']),
  ];
  const { picks } = rankForGroup(pool, members, { k: 3 });
  assert.equal(picks[0].id, 'italian1');
  assert.ok(picks.map((p) => p.id).includes('thai'), 'a different cuisine should make the top 3');
});

test('compromise report levels', () => {
  const pick = { sat: { a: 0.95, b: 0.7, c: 0.4 }, regret: { a: 0, b: 0.25, c: 0.6 }, estimated: {} };
  const rep = compromiseReport(pick, members);
  assert.deepEqual(rep.map((r) => r.level), ['happy', 'okay', 'compromises']);
});

test('pickTopK handles k larger than pool and empty pool', () => {
  assert.equal(pickTopK([], 3).length, 0);
  const scored = scoreFairness(normalizePerMember([cand('x', [1, 1, 1])], members), members);
  assert.equal(pickTopK(scored, 3).length, 1);
  assert.deepEqual(rankForGroup([], members), { picks: [], pool: [] });
});

test('single member group degenerates to their own ranking', () => {
  const one = ['a'];
  const pool = [{ id: 'p', name: 'p', affinities: { a: 0.5 } }, { id: 'q', name: 'q', affinities: { a: 0.9 } }];
  const { picks } = rankForGroup(pool, one, { k: 2 });
  assert.equal(picks[0].id, 'q');
  assert.equal(picks[0].min, 1);
});
