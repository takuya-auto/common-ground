# Fixtures (SYNTHETIC — not Qloo data)

Everything in this folder is hand-written, synthetic metadata used only when the
app runs in **mock mode** (no `QLOO_API_KEY`). None of it was recorded from, or
derived from, the Qloo API. Entity IDs are deterministic fake UUIDs, tag URNs
follow the documented Qloo URN *format* but their assignment to entities is our
own guess, and every "affinity" the mock returns is computed locally by
`src/qloo/mock.js` from tag overlap. The UI labels all mock output as such.

| File | Purpose |
| --- | --- |
| `tag-dimensions.json` | Maps tag URNs to a small set of "taste dimensions" the mock uses to compute affinities. |
| `favourites.json` | Known names (artists, films, shows, books, brands, cuisines) the mock `/search` can resolve, with synthetic tags. Unknown names still resolve to a generated mock entity. |
| `places.json` | Synthetic restaurants, bars and venues (fictional names) returned by mock `/v2/insights` for `urn:entity:place`. |
| `movies.json`, `tv.json` | Well-known titles with our own genre/keyword tags, for movie/TV nights. |
| `destinations.json` | Cities/regions with our own tags, for weekend trips. |
| `tags.json` | Tag catalog for mock `/v2/tags` (dietary, accessibility, vibe tags). |

Do **not** add recorded Qloo responses here; the hackathon rules forbid storing
Qloo data in a public repository.
