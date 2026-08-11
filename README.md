# Football Fighting — Terrace Survivor

A 2.5D arena-survivor roguelite for the browser. Pick one of four footballers —
**Lionel Messi, Cristiano Ronaldo, Neymar Jr or Lamine Yamal** — and survive the
terrace invasion on the pitch until full time (90'). Attacks and abilities fire
automatically; you steer the movement. Earn XP from fallen opponents, draft
upgrades each level, beat the 4:00, 7:00 and 9:00 bosses, and spend your
winnings on permanent upgrades and cosmetic kits between runs.

The current pace pass runs players at 130% and enemies at 125% of the original
movement baseline. Enemy attack cadence is unchanged, preserving reaction time
while making positioning, pursuit and the continuously rising pressure more immediate.

Built with TypeScript + Vite + Canvas 2D. The four player characters use
generated 2.5D idle/run/kick sprite strips (`public/art/players/`, with a
procedural in-code fallback). The kick wind-up releases its aerial ball on the
drawn contact frame. All 15 regular enemies use generated semantic
idle/attack/hurt strips plus dedicated six-frame locomotion cycles. All 3
bosses retain those semantic states and add eight authored movement directions
with 12 concrete frames each (288 directional boss poses total); the original
six-frame boss strips remain as automatic loading fallbacks. Directional boss
atlases are loaded on demand, skip unused flash/frost copies and use a six-entry
LRU cache so the richer animation remains mobile-safe.
Three XP tiers, coins, healing drinks, boss trophies and the rare Full-Pitch
Magnet, Matchday Wipeout and Stoppage-Time Freeze drops use dedicated generated
pickup art. The magnet vacuums every ground collectible, the bomb clears regular
threats while chunking bosses and now plays a six-stage AI-authored full-pitch
explosion instead of the old procedural ring, and the freeze pauses the hostile
layer for 5.5s.
Directional contact
sparks and distinct aerial landing bursts use pooled, mobile-safe rendering
with layered light/heavy/critical hit audio. Curveball Swarm and Golden Boot
Seekers add damage-reserving, live-retargeting long-range projectiles with
dedicated generated card and projectile art. Menu and arena art are generated
and shipped as local files. Security Detail uses its
own generated idle/move/punch/intercept bodyguard strip. Every ability draft
card uses dedicated generated art whose composition communicates its AERIAL or
GROUND delivery at a glance; compact procedural icons remain in the combat HUD.
Bosses now leave a tiered trophy pickup with a bonus coin payout and celebration.
Every enemy has a segmented in-world health bar: compact steel for regular
threats, gold with numeric HP for elites, and a larger red boss treatment.
No paid APIs, no paid assets, no network calls at runtime.

### Arena asset research

The official [Kenney Sports Pack](https://kenney.nl/assets/sports-pack) was
evaluated as the safest ready-made fallback: it is free, CC0, attribution-free
and suitable for commercial browser games. Its top-down field tiles are much
simpler than the game's current authored 2.5D stadium plate, however, so they
were not substituted merely for being external. The shipped arena remains the
sharper local generated asset; Kenney is the documented zero-cost fallback if a
future redesign needs modular field geometry.

## Run it locally

```bash
npm install        # once
npm run dev        # dev server -> http://localhost:5173
```

## Production build

```bash
npm run build      # type-check + bundle to dist/
npm run preview    # serve the production build -> http://localhost:4173
```

## Tests

```bash
npm test           # unit tests (vitest): data integrity, pacing curves, meta, sim
npm run test:e2e   # full browser flow tests (playwright, starts its own dev server)
```

Playwright browsers install into the project-local `.pw-browsers/` folder:
`PLAYWRIGHT_BROWSERS_PATH=.pw-browsers npx playwright install chromium`

## Controls

- **Desktop:** WASD / arrow keys to move. `1/2/3` pick level-up cards. `Esc`/`P` pause.
- **Mobile/touch:** drag on the left side of the screen — a virtual joystick appears.

## Game structure

- **Run length:** 600s, shown as a football match clock (0' → 90'). Half-time boss
  (The Referee) at 45', final boss (The Ultra Captain) near full time. Survive to 90' to win.
- **Enemies:** 15 regular archetypes with chase, leap, ranged, support, control,
  charger, aerial, summoner and wall behaviours, plus 3 bosses and glowing elite
  variants. The pitch opens quiet, then threats enter naturally one at a time
  from changing edges through a fractional spawn budget, never discrete waves.
  Smoothstep checkpoints ramp from 0.6 enemies/s at kickoff to 1.9 at 2:00,
  6.5 at 5:00, 14 at 7:30 and a browser-safe 24 at full time. HP, damage and
  speed have their own checkpoint curves; ranged threats (6), drones (4), bulls
  (3) and summoners (2) have hard alive caps. Elites begin at 55s, use 8x HP,
  always drop a rare pickup, and tighten from roughly 49s to a 22s interval.
- **Abilities (5 levels each):** Precision Strike, Curveball Swarm, Golden Boot
  Seekers, Orbiting Press, Captain's Whistle, Nutmeg Dash, Security Detail,
  Pitch Pressure and the hybrid First Touch Blast. Level-up offers 3 cards;
  abilities combine with stat trainings
  (power, speed, max HP, regen, magnet, armor).
- **Players:** distinct speed/health/power plus a signature trait and starting ability.
- **Meta (The Club):** permanent Power / Pace / Ball-Control (XP pickup) / Security-Budget
  tracks and purchasable alternate kits per player. Coins, purchases, equipped skins
  and best stats persist in `localStorage`.

## Project layout

```
src/core/    engine: rng, math, input, synthesized audio, procedural sprite fallback
src/game/    data (players/abilities/enemies/shop), sim (pure logic), render (2.5D), ui (DOM), meta (save)
public/art/  generated runtime images: backgrounds, sprite strips and icons
art-source/  original generated source plates retained for asset provenance
tools/       dev-only art composer + sprite sheet viewer (not in the bundle)
tests/       vitest unit tests + playwright e2e
scripts/     playtest + art generation, chroma-key normalization and runtime encoding
```

## Verification evidence

- `npm test` — 151 unit tests green (rng, data, pacing, meta/save, combat lanes,
  eight-way boss direction selection, stateful poses, generated PNG/WebP asset
  headers, Wipeout ring removal, rare pickups and simulation behaviours).
- `npm run test:e2e` — 16 browser tests cover menu, selection, combat, level-up,
  persistence, boss loot, dense late-game performance and sustained live play
  without a crash or an unintended return to the menu. The suite also covers
  all generated ability-card images, mobile card scrolling, death, victory,
  boss nameplates, shop/skin persistence and pause/resume.
- Live playtest screenshots: `evidence/shots/` (menu/select/gameplay/level-up,
  all ability galleries, enemy lineups, semantic poses, bosses, mobile and victory).
- In-app browser QA at 1280×720 verified three simultaneous directional bosses,
  the full six-stage Matchday Wipeout sequence and zero console warnings/errors.
- Sound: autoplay-safe synthesized WebAudio SFX, crowd bed and adaptive music;
  mute and separate master/SFX/music levels persist locally.
