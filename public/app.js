/* Common Ground front end. Plain JS, no build step. */
(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const el = (tag, attrs = {}, ...children) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'html') node.innerHTML = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      node.append(c.nodeType ? c : document.createTextNode(String(c)));
    }
    return node;
  };
  const pct = (x) => `${Math.round((x || 0) * 100)}%`;
  const AVATAR_COLORS = ['#d9743a', '#2a9d8f', '#6b5bd2', '#c9503f', '#4a6fa5', '#b8860b'];

  const EXAMPLE = {
    occasion: 'dinner',
    location: 'Tokyo',
    members: [
      { name: 'Dana', favourites: ['Radiohead', 'Parasite', 'Bon Iver'] },
      { name: 'Marco', favourites: ['Taylor Swift', 'The Office', 'Pizza'] },
      { name: 'Yuki', favourites: ['Miles Davis', 'Haruki Murakami', 'Sushi'] },
    ],
    constraints: { budget: 'medium', dietary: ['vegetarian'] },
  };

  const form = $('#plan-form');
  const membersEl = $('#members');
  const tpl = $('#member-template');
  let health = null;

  // ---- members / chips ----------------------------------------------------
  function addMember(data = {}) {
    if (membersEl.children.length >= 6) return;
    const node = tpl.content.firstElementChild.cloneNode(true);
    const idx = membersEl.children.length;
    const avatar = $('.avatar', node);
    avatar.style.background = AVATAR_COLORS[idx % AVATAR_COLORS.length];
    const nameInput = $('.member-name', node);
    nameInput.value = data.name || '';
    const refreshAvatar = () => { avatar.textContent = (nameInput.value.trim()[0] || '?').toUpperCase(); };
    nameInput.addEventListener('input', refreshAvatar);
    refreshAvatar();
    const chips = $('.chips', node);
    const input = $('.chip-input', chips);
    const addChip = (text) => {
      const t = text.trim().slice(0, 80);
      if (!t) return;
      const existing = $$('.chip', chips).map((c) => c.dataset.value.toLowerCase());
      if (existing.includes(t.toLowerCase()) || existing.length >= 5) return;
      const chip = el('span', { class: 'chip', 'data-value': t }, t, el('button', { type: 'button', 'aria-label': `Remove ${t}`, onclick: () => chip.remove() }, '×'));
      chips.insertBefore(chip, input);
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addChip(input.value); input.value = ''; }
      else if (e.key === 'Backspace' && !input.value) { const last = input.previousElementSibling; if (last?.classList.contains('chip')) last.remove(); }
    });
    input.addEventListener('blur', () => { if (input.value.trim()) { addChip(input.value); input.value = ''; } });
    chips.addEventListener('click', (e) => { if (e.target === chips) input.focus(); });
    (data.favourites || []).forEach(addChip);
    $('.remove-member', node).addEventListener('click', () => { node.remove(); if (!membersEl.children.length) addMember(); });
    membersEl.append(node);
    return node;
  }

  function readMembers() {
    return $$('.member', membersEl).map((m) => ({
      name: $('.member-name', m).value.trim(),
      favourites: $$('.chip', m).map((c) => c.dataset.value),
    }));
  }

  function loadExample() {
    membersEl.innerHTML = '';
    EXAMPLE.members.forEach(addMember);
    $(`input[name="occasion"][value="${EXAMPLE.occasion}"]`).checked = true;
    $('#location').value = EXAMPLE.location;
    $('#budget').value = EXAMPLE.constraints.budget;
    $$('input[name="dietary"]').forEach((c) => { c.checked = EXAMPLE.constraints.dietary.includes(c.value); });
    syncOccasion();
  }

  // ---- occasion-dependent fields -----------------------------------------
  function currentOccasion() { return $('input[name="occasion"]:checked').value; }
  function syncOccasion() {
    const key = currentOccasion();
    const info = health?.occasions?.find((o) => o.key === key);
    const needsLocation = info ? info.needsLocation : (key === 'dinner' || key === 'night_out');
    $('#location-field').classList.toggle('disabled', !needsLocation);
    const isPlace = needsLocation;
    $('#budget-field').classList.toggle('disabled', !isPlace);
    $('#dietary-field').classList.toggle('disabled', !isPlace);
    $('#wheelchair-field').classList.toggle('disabled', !isPlace);
  }
  $('#occasion').addEventListener('change', syncOccasion);

  // ---- health / mode chips ------------------------------------------------
  async function loadHealth() {
    try {
      const r = await fetch('/api/health');
      health = await r.json();
    } catch { health = null; }
    renderModeChips();
    syncOccasion();
  }
  function renderModeChips(result) {
    const box = $('#mode-chips');
    box.innerHTML = '';
    const qlooMode = result?.mode?.qloo || health?.qloo?.mode;
    if (qlooMode) box.append(el('span', { class: `chip chip-${qlooMode}`, title: qlooMode === 'mock' ? 'No Qloo API key configured: synthetic fixtures, not Qloo data' : 'Live Qloo API' }, qlooMode === 'live' ? 'Qloo: live' : 'Qloo: mock data'));
    const llm = result?.mode?.llm;
    if (llm) {
      const label = llm.tier === 'off' ? 'LLM: off (deterministic)' : `LLM: ${llm.tier} · ${llm.calls} call${llm.calls === 1 ? '' : 's'}`;
      box.append(el('span', { class: `chip ${llm.tier === 'off' ? 'chip-auto' : 'chip-llm'}`, title: llm.reason || '' }, label));
    } else if (health?.llm) {
      const h = health.llm;
      const on = h.mode !== 'off' && h.bound && h.remaining > 0;
      box.append(el('span', { class: `chip ${on ? 'chip-llm' : 'chip-auto'}`, title: `${h.model || ''} · ${h.usedToday}/${h.cap} calls used today` }, on ? `LLM: ready (${h.remaining} left today)` : 'LLM: off'));
    }
    $('#footer-mock-note').textContent = qlooMode === 'mock' ? 'Currently running on synthetic mock fixtures (no Qloo key configured); nothing shown is real Qloo data.' : '';
  }

  // ---- submit -------------------------------------------------------------
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#form-error');
    err.hidden = true;
    const members = readMembers().filter((m) => m.name || m.favourites.length);
    const occasion = currentOccasion();
    const body = {
      members,
      occasion,
      location: $('#location').value.trim(),
      constraints: {
        budget: $('#budget').value,
        dietary: $$('input[name="dietary"]:checked').map((c) => c.value),
        accessibility: $$('input[name="accessibility"]:checked').map((c) => c.value),
        family: $('input[name="family"]').checked,
      },
      compare: $('#compare').checked,
    };
    const problems = [];
    if (!members.length) problems.push('Add at least one person.');
    members.forEach((m, i) => { if (!m.name) problems.push(`Person ${i + 1} needs a name.`); if (m.favourites.length < 1) problems.push(`${m.name || 'Person ' + (i + 1)} needs at least one favourite.`); });
    if (!$('#location-field').classList.contains('disabled') && !body.location) problems.push('Enter a city or area.');
    if (problems.length) { err.textContent = problems.join(' '); err.hidden = false; return; }

    const submit = $('#submit');
    submit.disabled = true;
    $('#results').hidden = true;
    $('#status').hidden = false;
    $('#status-title').textContent = 'Asking Qloo…';
    $('#status-detail').textContent = `Resolving ${members.reduce((n, m) => n + m.favourites.length, 0)} favourites, building the candidate pool, scoring every ${members.length > 1 ? 'person' : 'option'}.`;
    try {
      const r = await fetch('/api/plan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`);
      renderResults(data);
      renderModeChips(data);
      $('#results').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
    } finally {
      submit.disabled = false;
      $('#status').hidden = true;
    }
  });

  // ---- results ------------------------------------------------------------
  function renderResults(r) {
    const root = $('#results');
    root.innerHTML = '';
    const unit = r.occasion.unit;
    const memberName = (id) => r.members.find((m) => m.id === id)?.name || id;

    // summary
    const meta = el('div', { class: 'meta-row' },
      el('span', { class: 'chip chip-tag' }, `${r.occasion.label}${r.location ? ` · ${r.locality || r.location}` : ''}`),
      el('span', { class: 'chip chip-tag' }, `${r.trace.qlooCalls} Qloo calls`),
      el('span', { class: 'chip chip-tag' }, `${r.pool.length} candidates scored × ${r.members.length} ${r.members.length === 1 ? 'person' : 'people'}`),
      r.relaxations.length ? el('span', { class: 'chip chip-mock' }, `relaxed: ${r.relaxations.join(', ')}`) : null,
      el('span', { class: `chip ${r.mode.qloo === 'mock' ? 'chip-mock' : 'chip-live'}` }, r.mode.qloo === 'mock' ? 'mock data' : 'live Qloo'),
    );
    root.append(el('section', { class: 'card summary-card' }, el('h2', {}, 'The verdict'), el('p', {}, r.summary), meta));

    // picks
    const picks = el('div', { class: 'picks' });
    r.picks.forEach((p, i) => picks.append(renderPick(p, i, r, unit, memberName)));
    root.append(picks);

    // fairness vs average
    if (r.meanTop && r.picks[0] && r.meanTop.id !== r.picks[0].id) {
      root.append(el('section', { class: 'card callout' },
        el('h3', {}, 'Why not just average everyone\'s taste?'),
        el('p', {}, `Ranking by average affinity would pick ${r.meanTop.name} (average ${pct(r.meanTop.mean)}), but it leaves ${memberName(r.meanTop.lowest)} at ${pct(r.meanTop.min)}. ${r.picks[0].name} lifts the least-happy person to ${pct(r.picks[0].min)} for an average of ${pct(r.picks[0].mean)}. Common Ground optimises the floor, not the mean.`)));
    } else if (r.meanTop && r.picks[0]) {
      root.append(el('section', { class: 'card callout' },
        el('h3', {}, 'Fair and popular'),
        el('p', {}, `Here the fairest option is also the one with the highest average affinity, so nobody has to trade off. The ranking still checked every candidate against every person.`)));
    }

    // compare
    if (r.compare) root.append(renderCompare(r));

    // trace
    root.append(renderTrace(r, memberName));

    if (r.warnings?.length) {
      root.append(el('section', { class: 'card warnings' }, el('strong', {}, 'Notes'), el('ul', {}, r.warnings.map((w) => el('li', {}, w)))));
    }
    root.hidden = false;
  }

  function renderPick(p, i, r, unit, memberName) {
    const props = p.properties || {};
    const metaBits = [];
    if (props.price_level) metaBits.push('$'.repeat(Math.max(1, Math.min(4, props.price_level))));
    if (props.business_rating) metaBits.push(`★ ${Number(props.business_rating).toFixed(1)}`);
    if (props.release_year) metaBits.push(props.release_year);
    if (props.content_rating) metaBits.push(props.content_rating);
    if (props.address) metaBits.push(props.address);
    else if (props.locality) metaBits.push(props.locality);
    if (props.country) metaBits.push(props.country);
    const genreTags = (p.tags || []).filter((t) => /^urn:tag:genre/.test(t.id)).slice(0, 3).map((t) => t.name);

    const bars = el('div', { class: 'bars' }, r.members.map((m) => {
      const c = (p.compromise || []).find((x) => x.member === m.id) || { level: 'okay', sat: p.sat?.[m.id] || 0 };
      const estimated = p.estimated?.[m.id];
      return el('div', { class: 'bar-row' },
        el('span', { class: 'who', title: m.name }, m.name),
        el('div', { class: `bar ${c.level}${estimated ? ' estimated' : ''}`, role: 'meter', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round((p.sat?.[m.id] || 0) * 100), 'aria-label': `${m.name} satisfaction` }, el('i', { style: `width:${pct(p.sat?.[m.id])}` })),
        el('span', { class: `level ${c.level}` }, estimated ? 'no data' : c.level === 'compromises' ? `${pct(p.sat?.[m.id])} · compromises` : pct(p.sat?.[m.id])),
      );
    }));

    const explain = el('div', { class: 'explain' }, r.members.map((m) => {
      const text = p.explanations?.[m.id] || '';
      const drivers = (p.drivers?.[m.id] || []).filter((d) => d.score >= 0.1).slice(0, 3);
      return el('div', {},
        el('p', {}, el('span', { class: 'who' }, `${m.name}: `), text.replace(new RegExp(`^${m.name}:\\s*`), '')),
        drivers.length ? el('div', { class: 'drivers' }, el('span', { class: 'hint' }, 'Qloo linked via '), drivers.map((d) => el('span', { class: 'chip chip-tag', title: `explainability score ${d.score}` }, `${d.name} ${Math.round(d.score * 100)}%`))) : null,
      );
    }));

    return el('article', { class: 'card pick' },
      el('span', { class: 'pick-rank' }, i === 0 ? 'Fairest pick' : `Option ${i + 1}`),
      el('div', { class: 'pick-head' },
        el('div', {}, el('h3', {}, p.name), el('div', { class: 'pick-meta' }, [genreTags.join(' · '), metaBits.join(' · ')].filter(Boolean).join('  —  '))),
        el('div', { class: 'score-pill' }, el('b', {}, pct(p.min)), el('small', {}, 'lowest satisfaction'), el('br'), el('small', {}, `avg ${pct(p.mean)}`)),
      ),
      el('p', { class: 'headline' }, p.headline),
      bars,
      explain,
      p.explanationSource === 'llm' ? el('div', { class: 'hint' }, 'Explanations phrased by the LLM from Qloo-derived facts only.') : null,
    );
  }

  function renderCompare(r) {
    const c = r.compare;
    const ours = el('div', { class: 'compare-col' }, el('h4', {}, 'With Qloo (this agent)'), el('ol', {}, r.picks.map((p) => el('li', {}, el('strong', {}, p.name), ` — floor ${pct(p.min)}, avg ${pct(p.mean)}; every person scored against their own favourites.`))));
    let theirs;
    if (!c.available) {
      theirs = el('div', { class: 'compare-col' }, el('h4', {}, 'LLM only (no Qloo)'), el('p', { class: 'hint' }, `Unavailable: ${c.reason || 'LLM not configured'}.`));
    } else if (c.picks?.length) {
      theirs = el('div', { class: 'compare-col' }, el('h4', {}, 'LLM only (no Qloo)'), el('ol', {}, c.picks.map((p) => el('li', {}, el('strong', {}, p.name), p.reason ? ` — ${p.reason}` : ''))), el('span', { class: 'hint' }, c.note));
    } else {
      theirs = el('div', { class: 'compare-col' }, el('h4', {}, 'LLM only (no Qloo)'), el('p', { class: 'hint' }, c.raw || 'The model returned nothing usable.'));
    }
    return el('section', { class: 'card' }, el('h3', { style: 'margin:0 0 10px' }, 'Same request, without the taste graph'), el('div', { class: 'compare-grid' }, ours, theirs));
  }

  function renderTrace(r, memberName) {
    const steps = el('ol', { class: 'steps' }, r.trace.steps.map((s) => el('li', { class: 'step' },
      el('span', { class: 'n' }, s.n),
      el('div', { class: 'body' },
        el('code', {}, s.tool), el('span', { class: `actor ${s.actor}` }, s.actor === 'llm' ? 'LLM decided' : 'autopilot'),
        el('div', { class: 'detail' }, s.error ? `failed: ${s.error}` : describeStep(s, memberName)),
      ))));

    const calls = el('div', { class: 'table-wrap' }, el('table', { class: 'calls' },
      el('thead', {}, el('tr', {}, ['#', 'Endpoint', 'Purpose', 'Key parameters', 'Result'].map((h) => el('th', {}, h)))),
      el('tbody', {}, r.trace.qloo.map((q) => el('tr', {},
        el('td', {}, q.id),
        el('td', {}, el('code', {}, q.path)),
        el('td', {}, q.purpose || ''),
        el('td', {}, el('code', {}, keyParams(q.params))),
        el('td', {}, q.ok ? describeCall(q) : `error: ${q.error}`),
      )))));

    const resolved = el('div', { class: 'resolved' }, r.members.flatMap((m) => m.favourites.map((f) => el('div', {},
      el('strong', {}, m.name), ' typed ', el('em', {}, `"${f.input}"`), el('span', { class: 'arrow' }, ' → '),
      f.entity ? el('span', {}, `${f.entity.name} `, el('span', { class: 'hint' }, `(${(f.entity.type || '').replace('urn:entity:', '')}${f.entity.disambiguation ? ', ' + f.entity.disambiguation : ''})`)) : el('span', { class: 'hint' }, 'unresolved'),
    ))));

    const pool = el('ol', { class: 'pool-list' }, r.pool.slice(0, 50).map((c) => el('li', {}, `${c.name} — floor ${pct(c.min)}, avg ${pct(c.mean)}`)));

    return el('details', { class: 'card trace' },
      el('summary', {}, `How the agent decided (${r.trace.steps.length} steps, ${r.trace.qlooCalls} Qloo calls${r.mode.llm.calls ? `, ${r.mode.llm.calls} LLM calls` : ''})`),
      el('div', { class: 'trace-body' },
        el('div', {}, el('h4', {}, 'Agent steps'), steps),
        el('div', {}, el('h4', {}, 'Favourites resolved via /search'), resolved),
        el('div', {}, el('h4', {}, 'Qloo requests'), calls),
        el('div', {}, el('h4', {}, `Full candidate pool, ranked by fairness (${r.pool.length})`), pool),
        el('p', { class: 'hint' }, 'Fairness score = 0.6 × lowest member satisfaction + 0.4 × mean, with a diversity penalty so the three options differ in kind. Satisfaction is each member\'s Qloo affinity relative to their best candidate in the pool.'),
      ));
  }

  function describeStep(s, memberName) {
    const r = s.result || {};
    switch (s.tool) {
      case 'resolve_favourites': return `${r.resolved ?? 0} favourites resolved${r.unresolved ? `, ${r.unresolved} unresolved` : ''}${s.args?.hints ? `, ${s.args.hints} type hints from the LLM` : ''}.`;
      case 'classify_favourites': return `LLM suggested entity types for ${r.hints ?? 0} favourites.`;
      case 'resolve_constraints': return `Filter tags: ${(r.tags || []).join(', ') || 'none'}${r.priceLevelMax ? `; max price level ${r.priceLevelMax}` : ''}${r.contentRating ? `; ratings ${r.contentRating.join('/')}` : ''}.`;
      case 'find_candidates': return `Group query added ${r.group ?? 0}; per-member queries added ${Object.entries(r.perMember || {}).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}; pool = ${r.poolSize ?? 0}.`;
      case 'score_pool': return Object.entries(r).map(([k, v]) => `${k}: ${v.scored}/${v.of}`).join(' · ');
      case 'rank': return `Top: ${(r.picks || []).map((p) => `${p.name} (floor ${pct(p.min)}, lowest ${p.lowest})`).join('; ')}.`;
      case 'relax': return r.changed ? `Relaxed ${s.args?.what}; rebuilding the pool.` : `Nothing to relax for ${s.args?.what}.`;
      default: return JSON.stringify(r).slice(0, 200);
    }
  }
  function keyParams(p = {}) {
    const keep = ['query', 'types', 'filter.query', 'filter.type', 'filter.location.query', 'filter.tags', 'operator.filter.tags', 'filter.price_level.max', 'filter.content_rating', 'feature.explainability', 'take'];
    const out = [];
    for (const k of keep) if (p[k] != null) out.push(`${k}=${String(p[k]).slice(0, 60)}`);
    if (p['signal.interests.entities']) out.push(`signal.interests.entities=${p['signal.interests.entities'].split(',').length} ids`);
    if (p['filter.results.entities']) out.push(`filter.results.entities=${p['filter.results.entities'].split(',').length} ids`);
    return out.join('\n');
  }
  function describeCall(q) {
    const s = q.summary || {};
    const top = (s.top || []).map((t) => t.name + (t.affinity != null ? ` (${Number(t.affinity).toFixed(2)})` : '')).join(', ');
    return `${s.count ?? 0} result${s.count === 1 ? '' : 's'}${s.locality ? ` in ${s.locality}` : ''}${top ? `: ${top}${s.count > 3 ? '…' : ''}` : ''} · ${q.ms} ms`;
  }

  // ---- boot ---------------------------------------------------------------
  $('#add-member').addEventListener('click', () => addMember());
  $('#load-example').addEventListener('click', loadExample);
  loadExample();
  loadHealth();
})();
