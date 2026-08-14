# Football Fight Art Direction

This is the production rendering contract. Its numeric parts live in
`ART_DIRECTION_PROFILE` in `src/game/render.ts` and are covered by tests.

## Camera and ground

- One oblique top-down projection at a `0.62` vertical tilt.
- Every ground actor uses the delivered feet baseline as its world contact.
- Pickup art sits on the turf without selection rings.
- Aerial actors use a consistent 38 px base lift, a small hover cycle and a
  separated soft shadow. Temporary airborne states use the same depth logic.

## Light and edge treatment

- The key light casts all material shadows toward screen lower-right at
  `(0.78, 0.56)`.
- Every actor uses a tight contact shadow plus a longer directional cast.
- Bosses keep a stronger contact shadow; aerial actors never receive a feet
  ring.
- Maximum white contrast belongs to the player silhouette, avoidable threats
  and confirmed heavy hits. Routine effects remain subordinate.

## Proportion and scale

- Player base scale: `1.68`.
- Standard enemy base scale: `1.52`.
- Ally base scale: `1.56`.
- Elites multiply their class by `1.22`.
- Boss art is limited to the authored `2.08–3.0` range and must retain a
  visible ground contact rather than reading as a pasted portrait.

The large-headed player design is the readability anchor. Human supporters
and guards can be less chibi, but their feet, camera angle, edge contrast and
light direction must obey the same world rules. Realistic detail alone is not
rejected; front-facing poster poses or conflicting light are.

## Palette and effects

- Gameplay actors stay in a restrained `0.72–1.08` saturation envelope.
- Ground abilities use compressed pitch-hugging ellipses and turf response.
- Aerial abilities use lifted arcs, trails and a separate landing point.
- Red is reserved for hostile contact danger and player damage.
- Cyan/ice language is reserved for freeze and electrical control.
- Gold is reserved for high-value loot, boss rewards and max evolutions.

## Acceptance scene

`?debug=1&stage=art-direction&arena=world-cup-hybrid-25d` always stages the
player, an ordinary supporter, one guard, a drone, a bull and the final boss in
one live scene. Any new actor class must pass that scene at desktop and mobile
scale before release.
