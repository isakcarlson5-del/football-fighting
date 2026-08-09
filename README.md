# Football Fighting — Terrace Survivor

A 2.5D arena-survivor roguelite for the browser. Pick one of four footballers —
**Lionel Messi, Cristiano Ronaldo, Neymar Jr or Lamine Yamal** — and survive the
terrace invasion on the pitch until full time (90'). Attacks and abilities fire
automatically; you steer the movement. Earn XP from fallen opponents, draft
upgrades each level, beat the half-time and final bosses, and spend your
winnings on permanent upgrades and cosmetic kits between runs.

Built with TypeScript + Vite + Canvas 2D. All sprites are procedural (drawn in
code at boot); menu/background art is generated and shipped as local files.
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
- **Enemies:** Hooligan, Ultra (fast), Bottle Thrower (ranged), Rogue Steward (tank),
  Rival Mascot (bruiser), plus glowing elite variants. Waves intensify continuously.
- **Abilities (5 levels each):** Precision Strike, Orbiting Press, Captain's Whistle,
  Nutmeg Dash, Security Detail. Level-up offers 3 cards; abilities combine with
  stat trainings (power, speed, max HP, regen, magnet, armor).
- **Players:** distinct speed/health/power plus a signature trait and starting ability.
- **Meta (The Club):** permanent Power / Pace / Ball-Control (XP pickup) / Security-Budget
  tracks and purchasable alternate kits per player. Coins, purchases, equipped skins
  and best stats persist in `localStorage`.

## Project layout

```
src/core/    engine: rng, math, input, audio (muted), procedural sprite painter
src/game/    data (players/abilities/enemies/shop), sim (pure logic), render (2.5D), ui (DOM), meta (save)
public/art/  generated background art (menu / select / victory)
tools/       dev-only art composer + sprite sheet viewer (not in the bundle)
tests/       vitest unit tests + playwright e2e
scripts/     playtest + art generation harnesses
```

## Verification evidence

- `npm test` — 29 unit tests green (rng, data, pacing, meta/save, sim behaviours).
- `npm run test:e2e` — 11 browser tests green: menu, select, combat kills, level-up
  pause/pick, death result, victory result, boss nameplate, shop persistence across
  reload, skin purchase/equip persistence, pause, horde performance (>45fps).
- Live playtest screenshots: `test-results/shots/` (menu/select/gameplay/level-up/
  bosses/mobile/victory, dev and production build).
- Sound: intentionally disabled build-wide (`AUDIO_ENABLED = false` in
  `src/core/audio.ts`) until the user asks for it.
