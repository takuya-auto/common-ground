// Group fairness scoring. Pure functions, no I/O.
//
// Input: a candidate pool where each candidate carries one Qloo affinity per
// member (from /v2/insights with filter.results.entities + that member's
// signal.interests.entities). Output: candidates ranked by a maximin-style
// fairness score, with per-member satisfaction, regret and compromise flags.

export const DEFAULT_WEIGHTS = Object.freeze({ min: 0.6, mean: 0.4 });

/**
 * Normalize each member's affinities across the pool to [0,1] by dividing by
 * that member's best affinity in the pool. Qloo affinities are relative
 * scores, and one member's generally lower scale must not dominate the
 * group minimum. Returns new candidates with `sat[member]`.
 */
export function normalizePerMember(candidates, memberIds) {
  const best = {};
  for (const m of memberIds) {
    const vals = candidates.map((c) => c.affinities?.[m]).filter((v) => typeof v === 'number' && v > 0);
    best[m] = vals.length ? Math.max(...vals) : 0;
  }
  return candidates.map((c) => {
    const sat = {};
    const estimated = {};
    for (const m of memberIds) {
      const v = c.affinities?.[m];
      if (typeof v !== 'number' || best[m] <= 0) {
        // Qloo did not return this candidate for this member: score it as the
        // worst case and say so, rather than pretending to know.
        sat[m] = 0;
        estimated[m] = true;
      } else {
        sat[m] = Math.min(1, Math.max(0, v / best[m]));
      }
    }
    return { ...c, sat, estimated };
  });
}

/** Attach fairness metrics to normalized candidates. */
export function scoreFairness(candidates, memberIds, weights = DEFAULT_WEIGHTS) {
  if (!memberIds.length) throw new Error('scoreFairness needs at least one member');
  return candidates.map((c) => {
    const sats = memberIds.map((m) => c.sat[m]);
    const min = Math.min(...sats);
    const mean = sats.reduce((a, b) => a + b, 0) / sats.length;
    const max = Math.max(...sats);
    const lowest = memberIds[sats.indexOf(min)];
    const highest = memberIds[sats.indexOf(max)];
    const fairScore = weights.min * min + weights.mean * mean;
    return { ...c, min, mean, max, spread: max - min, lowest, highest, fairScore };
  });
}

/**
 * Per-member regret: how much worse this candidate is for a member than their
 * personal best candidate in the pool (0 = this is their favourite).
 */
export function attachRegret(candidates, memberIds) {
  const best = {};
  for (const m of memberIds) best[m] = Math.max(...candidates.map((c) => c.sat[m]));
  return candidates.map((c) => {
    const regret = {};
    for (const m of memberIds) regret[m] = Math.max(0, best[m] - c.sat[m]);
    return { ...c, regret };
  });
}

/**
 * Greedy top-k with a diversity penalty: candidates sharing a "flavour" key
 * (e.g. cuisine / genre) with an already-chosen pick are penalized so the
 * shortlist offers genuinely different options.
 */
export function pickTopK(scored, k = 3, { keyOf = defaultFlavourKey, penalty = 0.12 } = {}) {
  const remaining = scored.slice().sort((a, b) => b.fairScore - a.fairScore);
  const picks = [];
  const usedKeys = new Map();
  while (picks.length < k && remaining.length) {
    let bestIdx = 0;
    let bestVal = -Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const c = remaining[i];
      const dup = (keyOf(c) || []).reduce((n, key) => n + (usedKeys.get(key) || 0), 0);
      const val = c.fairScore - penalty * dup;
      if (val > bestVal) { bestVal = val; bestIdx = i; }
    }
    const [chosen] = remaining.splice(bestIdx, 1);
    for (const key of keyOf(chosen) || []) usedKeys.set(key, (usedKeys.get(key) || 0) + 1);
    picks.push(chosen);
  }
  return picks;
}

export function defaultFlavourKey(c) {
  // genre-ish tags identify the "flavour" (cuisine, film genre, destination type)
  const genre = (c.tags || []).filter((t) => /^urn:tag:genre:/.test(t.id)).map((t) => t.id);
  return genre.length ? genre.slice(0, 2) : [c.subtype || 'none'];
}

/**
 * Who compromises on this pick? A member compromises when their satisfaction
 * is clearly below the group's, or their regret is large.
 */
export function compromiseReport(pick, memberIds, { satThreshold = 0.55, regretThreshold = 0.4 } = {}) {
  return memberIds.map((m) => {
    const sat = pick.sat[m];
    const regret = pick.regret?.[m] ?? 0;
    let level = 'happy';
    if (sat < satThreshold || regret > regretThreshold) level = 'compromises';
    else if (sat < 0.75 || regret > 0.2) level = 'okay';
    return { member: m, sat, regret, estimated: !!pick.estimated?.[m], level };
  });
}

/**
 * Full pipeline: candidates with `affinities` -> ranked shortlist with metrics.
 */
export function rankForGroup(candidates, memberIds, { k = 3, weights = DEFAULT_WEIGHTS, keyOf } = {}) {
  if (!candidates.length) return { picks: [], pool: [] };
  const normalized = normalizePerMember(candidates, memberIds);
  const scored = attachRegret(scoreFairness(normalized, memberIds, weights), memberIds);
  const picks = pickTopK(scored, k, keyOf ? { keyOf } : {}).map((p) => ({ ...p, compromise: compromiseReport(p, memberIds) }));
  // For comparison in the UI: what plain "average" ranking would have chosen.
  const byMean = scored.slice().sort((a, b) => b.mean - a.mean);
  return { picks, pool: scored, meanTop: byMean[0] || null };
}
