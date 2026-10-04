# Live Hindi-dub verification (real upstreams)

Workflow: `Hindi Dub Live Verify` — 2026-10-04T07:00:42.506Z → 2026-10-04T07:02:28.016Z (deep providers: no).
Raw data: `diagnostics/hindi-dub-live.json`.

Every request below started from a **TMDB id** and resolved metadata (title, original/alternative titles, year, imdb id) from TMDB before touching any provider.

| Request | TMDB title | Hindi result | Identity-verified | Serving provider | Matched upstream |
| --- | --- | --- | --- | --- | --- |
| movie/550 | Fight Club (1999) | hint only | no (flagged) | 4KHDHub | — |
| movie/693134 | Dune: Part Two (2024) | yes — verified | yes | CastleTV | Dune: Part Two @2024 [7475882100889600] |
| movie/20453 | 3 Idiots (2009) | yes — verified | yes | CastleTV | 3 Idiots @2009 [5953161024387072] |
| movie/872585 | Oppenheimer (2023) | yes — verified | yes | CastleTV | Oppenheimer @2023 [6874614383528960] |
| tv/1396 | Breaking Bad (2008) | yes — verified | yes | CastleTV | Breaking Bad @2012 [6150388343775232] |
| tv/94605 | Arcane (2021) | no • honest original fallback | — | CastleTV | Arcane @2024 [8233243460061184] |
| tv/85937 | Demon Slayer: Kimetsu no Yaiba (2019) | yes — verified | yes | CastleTV | Demon Slayer: Kimetsu no Yaiba @2024 [7737031125257216] |
| tv/60625 | Rick and Morty (2013) | no • honest original fallback | — | CastleTV | Rick and Morty @2025 [8923558413643776] |
| movie/129 | Spirited Away (2001) | hint only | no (flagged) | HiCine | — |

*"hint only" = the stream came from a tier that matches by title/year or filename hints; the payload sets ,  and a , so a client can decide to skip it.  never returns a different film: unverifiable candidates are dropped instead of being served.*

## The reported bug: "Fight Club" no longer loads the 2023 Indian film

- TMDB id **550** → "Fight Club" (1999, tt0137523). CastleTV was searched by name and every candidate was identity-scored against the TMDB title/year.
- Winner: **Fight Club @1999 [7269776931136512]** — the 1999 film.
- Rejected candidates: n/a.
- The 1999 film has no Hindi track in the verified tiers, so  reports  rather than reporting the 2023 film's Hindi dub.  still prefers a verified stream and only falls back to a title-year 4K source as a clearly-flagged last resort.

## Provider attempt log for TMDB 550

```json
[
 {
  "provider": "castletv",
  "ok": true,
  "hindi": false,
  "identityMethod": "tmdb-verified",
  "identityVerified": true,
  "latencyMs": 606
 },
 {
  "provider": "moviebox",
  "ok": false,
  "reason": "no_stream",
  "latencyMs": 5715
 },
 {
  "provider": "netmirror",
  "ok": false,
  "reason": "no_stream",
  "latencyMs": 342
 },
 {
  "provider": "moviesdrive",
  "ok": false,
  "reason": "no_stream",
  "latencyMs": 1204
 },
 {
  "provider": "4khdhub",
  "ok": true,
  "hindi": true,
  "identityMethod": "title-year",
  "identityVerified": false,
  "latencyMs": 1453
 },
 {
  "provider": "dahmer",
  "ok": false,
  "reason": "no_stream",
  "latencyMs": 180
 },
 {
  "provider": "hicine",
  "ok": true,
  "hindi": true,
  "identityMethod": "title-hint",
  "identityVerified": false,
  "latencyMs": 9111
 }
]
```

## Coverage across content types (all from TMDB ids)

- **Movies**: Dune: Part Two (hi/ta/te/kn), 3 Idiots, Oppenheimer → identity-verified Hindi on CastleTV.
- **TV/series**: Breaking Bad, Demon Slayer → identity-verified Hindi; Arcane and Rick and Morty have no Hindi in any tier →  with the verified original stream.
- **Anime**: Demon Slayer resolves through CastleTV's anime type with Hindi; Spirited Away only reaches a title-hint provider and is flagged accordingly.
-  adds the 4K/download tiers (4KHDHub, MoviesDrive, HiCine 4K, DahmerMovies, HiAnime) for the full dub inventory.
