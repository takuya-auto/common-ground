# Common Ground

**A group taste mediator agent, grounded in Qloo's taste graph.**
Built for the Qloo Agentic Hackathon 2026.

**Live demo:** https://common-ground.zaresusan1.workers.dev (live Qloo API; click "Load an example group", then "Find common ground". A run takes 20–60 s.)

Three friends, one dinner, three different tastes. A generic LLM says
"something for everyone" and means nothing. Common Ground resolves each
person's favourites to entities in Qloo's taste graph, asks Qloo how every
candidate scores **for each person**, and picks the option that lifts the
**least-satisfied** member rather than the average. It explains to each person
why the pick fits *them* (citing their own favourites via Qloo's explainability
output), says who is compromising, and shows every tool call it made.

Occasions: dinner, night out, movie night, TV night, weekend trip.
Constraints: budget, vegetarian/vegan/gluten-free/halal, wheelchair access,
family-friendly.

## Why it only works with Qloo

| Step | What Qloo provides | Endpoint |
| --- | --- | --- |
| Resolve "Radiohead", "Parasite", "Ted Lasso" into typed entities with tags | `/search` with `types` hints |
| Turn "vegetarian" or "wheelchair" into real filter tags | `/v2/tags` with `filter.query`, `filter.parents.types` |
| Candidates for the whole group and for each person alone (so minority tastes get candidates too) | `/v2/insights` with `signal.interests.entities`, `filter.type`, `filter.location.query`, `filter.tags`, `filter.price_level.max`, `filter.content_rating` |
| **Per-person affinity for every pooled candidate** and *which favourite drove it* | `/v2/insights` with `filter.results.entities` + `feature.explainability=true` |

The last row is the core. Cross-domain affinity (a person who loves Bon Iver and
Parasite → how much will they like *this* izakaya?) is something an LLM can only
guess at. Qloo answers it per person, which is what makes a fairness ranking
possible at all. The optional "LLM only" comparison panel runs the same request
without Qloo so you can see the difference: unverified names, no per-person
scores, no accountability.

## How the agent works

```
UI (public/)  ──POST /api/plan──▶  Worker (src/worker.js)
                                     │
                                     ▼
                              runAgent (src/agent/agent.js)
                                     │  picks a tier by LLM budget
                   ┌─────────────────┼─────────────────┐
                 loop              light              off
     LLM drives tool calls   LLM hints types +    deterministic
     (Workers AI, function   narrates; autopilot  autopilot +
      calling, ≤9 turns)     runs the Qloo plan   templated text
                   └─────────────────┼─────────────────┘
                                     ▼
                     tools (src/agent/tools.js), same for all tiers
        resolve_favourites → resolve_constraints → find_candidates
                 → score_pool → rank   (relax if the pool is thin)
                                     │
                                     ▼
              Qloo client (src/qloo/client.js) ── live or mock
              params validated against the entity-type guide
                                     │
                                     ▼
              fairness ranking (src/scoring/fairness.js, pure functions)
```

**Fairness.** Each member's affinities are normalised by their own best
candidate (so one person's lower affinity scale does not dominate). Score =
`0.6 × min + 0.4 × mean`, with a diversity penalty so the three options differ
in kind (cuisine / genre). Per-member *regret* (distance from their personal
favourite) drives the compromise flags. The UI also shows what a plain
average-affinity ranking would have chosen and whom it would have left behind.

**Transparency.** Every result carries a trace: agent steps (and whether the
LLM or the autopilot decided them), every Qloo request with its key parameters,
and the resolved entities. Explanations only use facts derived from Qloo; the
LLM is allowed to rephrase them, never to add claims.

**Graceful degradation.** Workers AI calls are counted per UTC day in KV. Over
the cap (`LLM_DAILY_CAP`) the agent runs fully deterministically with templated
explanations, so the product never breaks when the free allocation runs out.
Parameters are validated against Qloo's Entity Type Parameter Guide before any
request, because Qloo silently ignores invalid parameters.

## Repository layout

```
src/worker.js            Worker entry: static assets + /api/health, /api/plan
src/agent/agent.js       tiers, LLM tool loop, autopilot, narration, comparison
src/agent/tools.js       the agent's tools over shared state + tool schemas
src/agent/occasions.js   occasion → filter.type, base tags, constraint mapping
src/qloo/client.js       live/mock Qloo client with request trace
src/qloo/params.js       parameter allowlist per entity type, request builders
src/qloo/mock.js         synthetic Qloo (search/tags/insights) for mock mode
src/scoring/fairness.js  maximin ranking, regret, diversity, compromise report
src/llm/workersai.js     Workers AI wrapper with KV daily cap
src/llm/explain.js       templated explanations (facts the LLM may rephrase)
public/                  UI: index.html, styles.css, app.js (no build step)
fixtures/                SYNTHETIC data for mock mode (see fixtures/README.md)
test/                    node --test unit tests
scripts/smoke.mjs        run the agent in Node without the Worker runtime
```

## Running locally

Requirements: Node 20+, `wrangler` 4.x (`npm i -g wrangler`), a Cloudflare
account logged in with `wrangler login` (for Workers AI during dev).

```bash
cp .dev.vars.example .dev.vars   # leave QLOO_API_KEY empty for mock mode
npm test                          # unit tests
node scripts/smoke.mjs            # agent run in Node, mock Qloo, no LLM
wrangler dev                      # http://127.0.0.1:8787
```

Without `QLOO_API_KEY` the app runs in **mock mode** on synthetic fixtures and
labels everything as such. Set the key in `.dev.vars` (dev) or
`wrangler secret put QLOO_API_KEY` (production) to use the live API.

Try it with curl:

```bash
curl -s http://127.0.0.1:8787/api/plan -H 'content-type: application/json' -d '{
  "members": [
    {"name": "Dana",  "favourites": ["Radiohead", "Parasite", "Bon Iver"]},
    {"name": "Marco", "favourites": ["Taylor Swift", "The Office", "Ted Lasso"]},
    {"name": "Yuki",  "favourites": ["Miles Davis", "Haruki Murakami", "Spirited Away"]}
  ],
  "occasion": "dinner", "location": "Tokyo",
  "constraints": {"budget": "medium", "dietary": ["vegetarian"]},
  "compare": true
}'
```

## Deploying

```bash
wrangler kv namespace create CAP_KV      # paste the id into wrangler.jsonc
wrangler secret put QLOO_API_KEY
wrangler deploy
```

### Environment variables

| Name | Where | Meaning |
| --- | --- | --- |
| `QLOO_API_KEY` | secret | Qloo hackathon API key. Unset → mock mode. |
| `QLOO_BASE_URL` | var | Default `https://hackathon.api.qloo.com`. |
| `LLM_MODEL` | var | Workers AI model with function calling. Default `@cf/meta/llama-3.3-70b-instruct-fp8-fast`. |
| `LLM_MODE` | var | `auto` (default) or `off`. |
| `LLM_DAILY_CAP` | var | Hard cap on LLM calls per UTC day (default 60 — keeps a Llama-3.3-70B workload inside the Workers AI free daily allocation of 10,000 neurons). |
| `LLM_PER_REQUEST_CAP` | var | Max LLM calls one request may make (default 12). |

Bindings: `AI` (Workers AI), `CAP_KV` (KV, for the cap counter), `ASSETS`
(static UI). In `wrangler dev` KV is simulated locally; AI calls are remote.

## API

`POST /api/plan`

```json
{
  "members": [{ "name": "Dana", "favourites": ["Radiohead", "Parasite"] }],
  "occasion": "dinner | night_out | movie_night | tv_night | weekend_trip",
  "location": "Tokyo",
  "constraints": { "budget": "low|medium|high|any", "dietary": ["vegetarian"], "accessibility": ["wheelchair"], "family": false },
  "compare": false
}
```

Returns the ranked picks with per-member satisfaction, regret, compromise
flags, drivers (explainability), explanations, the full scored pool, the
agent trace and the Qloo request log. `GET /api/health` reports Qloo mode and
LLM budget.

## Data and privacy

No Qloo data is stored in this repository. `fixtures/` contains hand-written
synthetic metadata used only in mock mode. Nothing a user enters is persisted;
the only state is the daily LLM-call counter in KV.

## License

MIT, see `LICENSE`.
