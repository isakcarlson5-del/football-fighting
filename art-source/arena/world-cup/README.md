# World Cup arena sources

All plates are original project assets and contain no tournament logo, sponsor,
team badge, text or watermark. The game adds its exact pitch markings and goals
at runtime after mapping the playable world to each recorded grass rectangle.

## World Cup Classic and World Cup Showpiece

`scripts/generate_world_cup_arenas.py` builds both 3072x2048 sources from Pillow
primitives with deterministic seeds. It authors the entire stadium, crowd,
apron and non-repeating turf texture locally. No external source art is used.

- Runtime grass rectangle: `x=390, y=322, w=2292, h=1404`.
- Runtime output: lossy WebP quality 95.
- Grass detail: per-pixel seeded variation, 75,000 micro-blades, clippings,
  subtle traffic compression and a crisp drainage/contact lip.

## World Cup Modern AI

Generated with the built-in image-generation tool using this production prompt:

```text
Use case: stylized-concept
Asset type: production background plate for a top-down 2.5D browser arena-survivor game
Primary request: Create one exceptionally detailed, premium, modern international football World Cup-style stadium background. The camera must be exact orthographic top-down at 90 degrees, centered and perfectly symmetrical, as if looking straight down from high above. A large pristine rectangular natural-grass football pitch occupies the central 74% width and 68% height of the image. Surround it with a narrow dark-blue runoff, technical areas, benches, camera bays, steward corridors, layered modern bowl seating, entrance tunnels and bright roof-edge floodlight structures. The stadium should feel like a major global final without using any real tournament branding.
Scene/backdrop: contemporary international championship stadium at golden-hour daylight, full but visually subdued multicolour crowd only in the stands, no open sky, no horizon, no perspective vanishing point
Style/medium: highly detailed realistic game environment render, premium sports-game asset, crisp physically based materials, readable at gameplay scale
Composition/framing: 3:2 landscape; exact orthographic top-down; all four sides visible; the playing grass must be one uninterrupted flat plane with a precise rectangular boundary; keep stands outside the pitch rectangle; zero perspective distortion
Lighting/mood: neutral daylight with soft stadium-roof shadows confined to seating and runoff; the entire grass plane evenly lit for gameplay readability
Color palette: deep natural emerald grass, restrained navy seating, neutral concrete and brushed metal, small warm-gold accents
Materials/textures: extremely crisp individual turf fibres, alternating 10-metre mowing stripes, subtle cross-cut grain, realistic but restrained cleat wear and groundskeeper roller variation, sharp drainage edge and curb materials, detailed seats and concrete
Constraints: NO field markings at all; NO touchlines, halfway line, centre circle, penalty boxes, goal boxes, arcs, spots, goals or nets on the grass; no people, objects, flags, confetti or props on the grass; no text; no letters; no numbers; no logos; no sponsors; no watermark. The flat empty pitch is reserved for exact game-rendered markings and characters. The grass boundary must be sharp and perfectly rectangular. Do not blur or use depth of field.
Avoid: oblique camera, broadcast camera, horizon, fisheye, tilt, perspective distortion, blurry grass, painterly texture, muddy grass, oversized decorative patterns, in-field shadows, baked-in markings, text, branding, watermark
```

- Source: `world-cup-modern-ai.png` at 1536x1024.
- Runtime grass rectangle after 2x reconstruction: `x=612, y=412, w=1828, h=1254`.
- Runtime output: 3072x2048 WebP created by `scripts/process_arena_variants.py`.
