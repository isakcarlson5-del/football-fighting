# Football Fighting — Terrace Survivor

A 2.5D arena-survivor roguelite for the browser. Pick one of four footballers —
**Lionel Messi, Cristiano Ronaldo, Neymar Jr or Lamine Yamal** — and survive the
terrace invasion on the pitch until full time (90'). Attacks and abilities fire
automatically; you steer the movement. Earn XP from fallen opponents, draft
upgrades each level, beat the half-time and final bosses, and spend your
winnings on permanent upgrades and cosmetic kits between runs.

Built with TypeScript + Vite + Canvas 2D. The four player characters use
generated 2.5D idle/run/kick sprite strips (`public/art/players/`, with a
procedural in-code fallback). The kick wind-up releases its aerial ball on the
drawn contact frame. All 13 regular enemies and all 3 bosses use generated
semantic idle/move/attack/hurt strips. Three XP tiers, coins, healing drinks
and boss trophies use dedicated generated pickup art. Directional contact
sparks and distinct aerial landing bursts use pooled, mobile-safe rendering
with layered light/heavy/critical hit audio. Menu and arena art are generated
and shipped as local files. Security Detail uses its
own generated idle/move/punch/intercept bodyguard strip. Every ability draft
card uses dedicated generated art whose composition communicates its AERIAL or
GROUND delivery at a glance; compact procedural icons remain in the combat HUD.
Bosses now leave a tiered trophy pickup with a bonus coin payout and celebration.
No paid APIs, no paid assets, no network calls at runtime.

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
- **Enemies:** 13 regular archetypes with chase, leap, ranged, support, control,
  summoner and wall behaviours, plus 3 bosses and glowing elite variants.
  The pitch opens quiet, then named formation waves mix every unlocked role;
  pressure and wave size intensify continuously.
- **Abilities (5 levels each):** Precision Strike, Orbiting Press, Captain's
  Whistle, Nutmeg Dash, Security Detail, Pitch Pressure and the hybrid First
  Touch Blast. Level-up offers 3 cards; abilities combine with stat trainings
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
scripts/     playtest + art generation harnesses
```

## Verification evidence

- `npm test` — 45 unit tests green (rng, data, pacing, meta/save, combat lanes,
  stateful poses and simulation behaviours).
- `npm run test:e2e` — 13 browser tests green: menu, select, combat kills, level-up
  pause/pick, all generated ability-card images, mobile card scrolling, death,
  victory, boss nameplate, shop/skin persistence, pause and horde performance (>45fps).
- Live playtest screenshots: `evidence/shots/` (menu/select/gameplay/level-up,
  all ability galleries, enemy lineups, semantic poses, bosses, mobile and victory).
- Sound: autoplay-safe synthesized WebAudio SFX, crowd bed and adaptive music;
  mute and separate master/SFX/music levels persist locally.
