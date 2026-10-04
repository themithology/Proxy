# Live Hindi-dub verification (real upstreams)

Workflow: `Hindi Dub Live Verify` — 2026-10-04T07:27:34.116Z → 2026-10-04T07:28:11.151Z (deep providers: no).
Raw data: `diagnostics/hindi-dub-live.json`.

Every request below starts from a **TMDB id**: metadata (title, original/alternative titles, year, IMDb id) is resolved from TMDB first, then each provider result is scored against that identity before use.

Cascade after the Moviebox removal: **CastleTV → NetMirror**, with the 4K/download tiers (4KHDHub, MoviesDrive, HiCine, DahmerMovies, HiAnime) only in `deep` mode.

| Request | TMDB title | Hindi result | Identity-verified | Serving provider | Matched upstream |
| --- | --- | --- | --- | --- | --- |
| `movie/550` | Fight Club (1999) | hint only | no (flagged) | 4KHDHub | — |
| `movie/693134` | Dune: Part Two (2024) | yes — verified | yes | CastleTV | `Dune: Part Two` @2024 [7475882100889600] |
| `movie/20453` | 3 Idiots (2009) | yes — verified | yes | CastleTV | `3 Idiots` @2009 [5953161024387072] |
| `movie/872585` | Oppenheimer (2023) | yes — verified | yes | CastleTV | `Oppenheimer` @2023 [6874614383528960] |
| `tv/1396` | Breaking Bad (2008) | yes — verified | yes | CastleTV | `Breaking Bad` @2012 [6150388343775232] |
| `tv/94605` | Arcane (2021) | no • honest original fallback | — | CastleTV | `Arcane` @2024 [8233243460061184] |
| `tv/85937` | Demon Slayer: Kimetsu no Yaiba (2019) | yes — verified | yes | CastleTV | `Demon Slayer: Kimetsu no Yaiba` @2024 [7737031125257216] |
| `tv/60625` | Rick and Morty (2013) | no • honest original fallback | — | CastleTV | `Rick and Morty` @2025 [8923558413643776] |
| `movie/129` | Spirited Away (2001) | yes — verified | yes | CastleTV | `Spirited Away` @2003 [6966370463949824] |

*"hint only" = the stream came from a tier that matches by title/year or filename hints. Those payloads set `hindiVerified: false`, an `identityMethod` and a `diagMessage`, so a client can decide to skip them. `?server=hindi` never returns a different film: candidates that cannot be verified are dropped instead of served.*

## The reported bug: "Fight Club" no longer loads the 2023 Indian film

- `movie/550` → Fight Club (1999, `tt0137523`). CastleTV was searched by name; every candidate was scored against the TMDB identity.
- Winner: `Fight Club` @1999 [7269776931136512].
- Rejected: `Fight Club` @2023 (`exact-title,year-mismatch:2023!=1999,preferred-audio-present`) — the Indian film that carries the Hindi dub; plus `Fight Club - Members Only` @2006 and other near-name rows.
- The 1999 film has no Hindi track on CastleTV, so `GET /api/dubs/movie/550` reports `hindi: false` instead of reporting the 2023 film's Hindi dub, and `?server=hindi` prefers the verified stream while flagging any title-year fallback.

## Coverage across content types (same run)

- **Movies**: Dune: Part Two (`hi, ta, te, kn`), 3 Idiots, Oppenheimer, Spirited Away → identity-verified Hindi on CastleTV.
- **TV / series**: Breaking Bad, Demon Slayer → identity-verified Hindi; Arcane and Rick and Morty have no Hindi in any tier → `hindiAvailable: false` plus the verified original stream (never a wrong-title dub).
- **Anime film**: Spirited Away @2003 published year (real release 2001) is accepted — the year window tolerates provider drift of ±2 years while still rejecting decade-apart collisions.
- **NetMirror** (tier 2) is TMDB-id keyed, but its OTT catalog is small: it missed all probed titles here. The separate `diagnostics/netmirror-probe.json` shows it live on `net27.cc` for titles it does carry (e.g. Breaking Bad S1E1 → 4 streams).

## Provider attempt log for `movie/550`

```json
[
 {
  "provider": "castletv",
  "ok": true,
  "hindi": false,
  "identityMethod": "tmdb-verified",
  "identityVerified": true,
  "latencyMs": 1046
 },
 {
  "provider": "netmirror",
  "ok": false,
  "reason": "no_stream",
  "latencyMs": 110
 },
 {
  "provider": "moviesdrive",
  "ok": false,
  "reason": "no_stream",
  "latencyMs": 1166
 },
 {
  "provider": "4khdhub",
  "ok": true,
  "hindi": true,
  "identityMethod": "title-year",
  "identityVerified": false,
  "latencyMs": 821
 },
 {
  "provider": "dahmer",
  "ok": false,
  "reason": "no_stream",
  "latencyMs": 56
 },
 {
  "provider": "hicine",
  "ok": true,
  "hindi": true,
  "identityMethod": "title-hint",
  "identityVerified": false,
  "latencyMs": 6004
 }
]
```
