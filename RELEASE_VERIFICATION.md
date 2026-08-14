# Football Fighting release verification

Verification date: 2026-08-14

## Verified locally

- TypeScript validation: `npm run check` passed.
- Unit and integration tests: 290 tests passed across assets, core systems, lanes, simulation, and the community server.
- Browser tests: 71 active Playwright tests passed; one opt-in natural-match endurance test remained skipped by design.
- Final focused browser regression: movement review, all boss arrivals, split guard targets, and independent guard patrol all passed (4 tests).
- Production build: `npm run build` passed.
- Portal payload gate: 47.48 MiB of a 50 MiB limit.
- Production server: the game root and the new clean guard asset returned HTTP 200; an unknown static asset returned HTTP 404.
- Live browser inspection covered all player directions, Messi's consistent white shorts, curved orbit trails, Keeper's Halo, the VAR Skycam aerial enemy, authored ability-upgrade VFX, clean guard sprites, and grounded boss rendering.
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
