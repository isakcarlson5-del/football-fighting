# Football Fighting release verification

Verification date: 2026-08-14

## Verified locally

- TypeScript validation: `npm run check` passed.
- Unit and integration tests: 291 tests passed across assets, core systems, lanes, simulation, and the community server.
- Browser tests: 71 active Playwright tests passed; one opt-in natural-match endurance test remained skipped by design.
- Final focused browser regression: all 32 player directions, player locomotion, enemy movement review, captain charge, First Touch Blast, kick commitment, and curved Orbiting Press trails all passed (7 tests).
- Production build: `npm run build` passed.
- Portal payload gate: 47.43 MiB of a 50 MiB limit.
- Production server: the game root and the new clean guard asset returned HTTP 200; an unknown static asset returned HTTP 404.
- Live browser inspection covered all player directions, Messi's repaired white shorts, the other three players' consistent kits, curved orbit trails, Keeper's Halo, the VAR Skycam aerial enemy, authored ability-upgrade VFX, clean guard sprites, and grounded boss rendering.
- A fresh production capture covered all 4 players in all 8 directions after 1.45 seconds of real movement per direction. Every source strip also met the common feet baseline at y=311-312 px.
- Captain's Whistle was inspected in a locked mid-pulse frame and kept a soft, authored shockwave. Matchday Wipeout was inspected as a 14-frame live sequence; the player, hostile silhouettes, and warning information stayed readable through the effect.
- Mobile layouts and joystick input were covered by the Playwright suite at portrait and landscape viewports.

## Evidence

Evidence is stored in `work/release-audit-evidence/current-request/`, including:

- `player-directions-production.png`
- `messi-pants-states.png`
- `neymar-pants-states.png`
- `ronaldo-pants-states.png`
- `yamal-pants-states.png`
- `orbit-curved-trails-production.png`
- `aerial-defence-production.png`
- `upgrade-vfx-production.png`
- `guards-clean-production.png`
- `bosses-grounded-production.png`
- `select-390x844-fixed.png`
- `select-844x390.png`
- `select-844x390-scrolled.png`

The final all-direction and scene evidence is stored in `work/goal-all-directions/`:

- `live-32/all-players-32-directions.png`
- `live-32/{messi,ronaldo,neymar,yamal}-live-contact-sheet.png`
- `live-32-full/{player}-{direction}.png`
- `source-contact-sheets/{messi,ronaldo,neymar,yamal}-all-directions.png`
- `scenes/whistle-progress-052.png`
- `scenes/wipeout-contact-sheet.png`

## Preservation

- A readable pre-audit archive exists at `work/checkpoints/2026-08-14-before-release-audit-ui.tar.gz`.
- The final release-audit implementation is preserved in the local git history after verification.
- Original guard source assets remain in `public/art/allies/`; cleaned runtime copies are separate files.

## Not verified

- Physical iOS or Android hardware was not tested in this run.
- Public hosting, CrazyGames review/approval, real-player retention, and production leaderboard infrastructure were not verified.
- The opt-in full natural-match endurance scenario was not part of the active 71-test Playwright run.

## Local commands

```bash
npm install
npm run dev
```

Production build and server:

```bash
npm run build
npm run serve
```
