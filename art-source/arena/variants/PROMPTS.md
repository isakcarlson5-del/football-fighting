# Arena variant generation prompts

All three source plates were generated with the built-in image-generation tool. Runtime files are reconstructed to 3072x2048 WebP by `scripts/process_arena_variants.py`.

## Midnight Final

- Use case: stylized-concept
- Asset type: production background plate for a top-down 2.5D browser arena-survivor game
- Scene: full rectangular football pitch surrounded by a compact dark navy and brushed-gold stadium bowl, recessed top tunnel, restrained corner floodlights, technical apron and empty seating outside the turf
- Style: premium stylized 3D game render, crisp physically convincing materials and game-ready readability
- Camera: exact straight-down orthographic landscape view, centered, symmetrical, zero horizon, zero tilt and no perspective convergence
- Turf: one evenly lit solid plane with sharp short-grass grain, subtle mowing bands and natural high-traffic wear
- Constraints: no pitch markings, goals, text, logos, people, players, ball, props, UI or watermark; no objects or shadows on the grass

## Heritage Day

- Use case: stylized-concept
- Asset type: production background plate for a top-down 2.5D browser arena-survivor game
- Scene: full rectangular pitch surrounded by a classic European brick-and-steel stadium with forest-green seats, limestone concourses, dugout recesses and old-fashioned roof trusses
- Style: premium crisp stylized 3D sports environment with believable materials and clean readable forms
- Camera: exact straight-down orthographic landscape view, centered, symmetrical, zero horizon, zero tilt and no perspective convergence
- Turf: bright overcast exposure, sharp fine grass blades, subtle checker mowing and restrained natural wear
- Constraints: no pitch markings, goals, text, logos, people, players, ball, props, UI or watermark; no objects or shadows on the grass

## Electric Derby

- Use case: stylized-concept
- Asset type: production background plate for a top-down 2.5D browser arena-survivor game
- Scene: full rectangular pitch surrounded by a modern charcoal concrete-and-black-steel bowl with restrained cyan and crimson perimeter lighting outside the turf
- Style: extremely polished stylized 3D game render with sharp game-ready shapes and physically plausible surface detail
- Camera: exact straight-down orthographic landscape view, centered, symmetrical, zero horizon, zero tilt and no perspective convergence
- Turf: evenly exposed cool emerald grass with sharp diagonal-cross mowing grain, clippings and faint high-traffic compression
- Constraints: no pitch markings, goals, text, logos, people, players, ball, props, UI or watermark; no glow, objects, shadows or beams on the grass

The game draws its own coordinate-accurate markings and goals over the calibrated grass rectangle. This avoids AI-generated line geometry and keeps collisions, foot placement and field markings aligned for every plate.
