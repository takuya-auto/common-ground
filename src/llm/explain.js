// Deterministic, templated explanations. Used when the LLM is off, capped or
// fails, and as the factual skeleton the LLM is asked to rephrase (so the
// model can never invent a reason that is not backed by Qloo data).

function listNames(items, max = 2) {
  const names = items.slice(0, max);
  if (names.length === 0) return '';
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function pct(x) { return `${Math.round(x * 100)}%`; }

/**
 * Facts the explanation is allowed to use for one member on one pick.
 * @param {object} pick   ranked candidate (with sat, regret, drivers, tags)
 * @param {object} member { id, name, favourites:[{input, entity}] }
 */
export function factsFor(pick, member) {
  const sat = pick.sat[member.id];
  const regret = pick.regret?.[member.id] ?? 0;
  const drivers = (pick.drivers?.[member.id] || []).filter((d) => d.score >= 0.1);
  const driverNames = drivers.map((d) => d.name);
  // Tags the member's favourites share with the pick (by tag id).
  const memberTagIds = new Set(member.favourites.flatMap((f) => (f.entity?.tags || []).map((t) => t.id)));
  const shared = (pick.tags || []).filter((t) => memberTagIds.has(t.id)).map((t) => t.name).filter(Boolean);
  const level = pick.compromise?.find((c) => c.member === member.id)?.level || 'okay';
  return { sat, regret, driverNames, sharedTags: [...new Set(shared)].slice(0, 3), level, estimated: !!pick.estimated?.[member.id] };
}

export function templateExplanation(pick, member, unit = 'option') {
  const f = factsFor(pick, member);
  const who = member.name;
  const parts = [];
  if (f.estimated) {
    parts.push(`${who}: Qloo returned no affinity for this ${unit} against your favourites, so we scored it conservatively.`);
    return parts.join(' ');
  }
  if (f.level === 'happy') parts.push(`${who}: a strong fit (${pct(f.sat)} satisfaction).`);
  else if (f.level === 'okay') parts.push(`${who}: a reasonable fit (${pct(f.sat)}).`);
  else parts.push(`${who}: this is your compromise (${pct(f.sat)}, ${pct(f.regret)} below your own top pick).`);

  if (f.driverNames.length) parts.push(`Qloo links it most to your taste for ${listNames(f.driverNames)}.`);
  if (f.sharedTags.length) parts.push(`Shared traits: ${f.sharedTags.join(', ')}.`);
  if (!f.driverNames.length && !f.sharedTags.length) parts.push('The link comes from cross-domain affinity rather than an obvious shared trait.');
  return parts.join(' ');
}

export function templateHeadline(pick, members, unit = 'option') {
  const names = members.map((m) => m.name);
  const lowest = members.find((m) => m.id === pick.lowest)?.name;
  const compromisers = (pick.compromise || []).filter((c) => c.level === 'compromises').map((c) => members.find((m) => m.id === c.member)?.name).filter(Boolean);
  let s = `${pick.name} keeps everyone at or above ${pct(pick.min)} satisfaction`;
  if (names.length > 1 && lowest) s += ` (lowest: ${lowest})`;
  s += '.';
  if (compromisers.length) s += ` ${listNames(compromisers)} ${compromisers.length === 1 ? 'gives' : 'give'} the most ground here.`;
  else if (names.length > 1) s += ' Nobody has to settle.';
  return s.replace('option', unit);
}

export function templateSummary(result) {
  const { picks, members, occasion, meanTop } = result;
  if (!picks.length) return 'No candidates survived the constraints. Try loosening budget or dietary filters.';
  const top = picks[0];
  let s = `For ${occasion.label.toLowerCase()}, the fairest choice is ${top.name}: minimum satisfaction ${pct(top.min)}, average ${pct(top.mean)}.`;
  if (meanTop && meanTop.id !== top.id) {
    const loser = members.find((m) => m.id === meanTop.lowest)?.name;
    s += ` A plain "average taste" ranking would have picked ${meanTop.name}, which drops ${loser || 'someone'} to ${pct(meanTop.min)}.`;
  }
  return s;
}
