# Audio provenance

## Sound effects

Most files in `sfx/` are user-requested ElevenLabs Sound Effects generations.
Their source names, hashes and runtime trims are recorded in
`AI-PROMPTS/elevenlabs-sfx-import-2026-08-23.md` and
`AI-PROMPTS/elevenlabs-full-sfx-provenance-2026-08-25.json`.

The following runtime cues were revised on 2026-08-26:

- `match-whistle.mp3` and `captains-whistle.mp3` are two trims of the real
  recorded **Referee whistle blow, gymnasium.wav** by SpliceSound.
  Source: https://freesound.org/people/SpliceSound/sounds/218318/
  License: CC0. Source preview SHA-256:
  `7392e39a07d47ffbbf174677e7b82ab91fe936dbcf17a9c8d947ca763d1ad0b3`.
- `player-step-left.mp3` and `player-step-right.mp3` are quieter, low-passed
  trims of the existing ElevenLabs grass-footstep sources. Runtime playback
  also uses a lower gain so repeated steps remain subtle.
- `drone-charge.mp3`, `drone-shot.mp3` and `var-scan-launch.mp3` are distinct
  short runtime treatments derived from the existing authored drone source.
  They separate wind-up, close electric fire and the slower VAR scan volley.
- `enemy-attack-grunt-1.mp3`, `enemy-attack-grunt-2.mp3`,
  `enemy-attack-grunt-3.mp3` and `enemy-heavy-groan.mp3` are short trims from
  **Male Grunt/Yelling sounds** by HaelDB. Source:
  https://opengameart.org/content/male-gruntyelling-sounds — CC0 option listed
  on the source page. The four cues are randomized at real hostile contact
  frames and globally throttled so a crowd cannot become a voice wall.
- `enemy-step-light.mp3` and `enemy-step-heavy.mp3` are compact treatments of
  the existing authored movement cues. Runtime mixes only the nearest moving
  hostile group by distance and mass; aerial machines keep their dedicated
  rotor/charge/shot language instead of receiving human footsteps.

Exact source/output hashes and processing notes for this pass are in
`AI-PROMPTS/audio-polish-provenance-2026-08-26.json` and
`AI-PROMPTS/enemy-audio-provenance-2026-08-26.json`.

## Music

`music/stadium-drive-loop.mp3` is a web-optimized runtime copy of
**Just Saying Tho** by hernandack from the Short Loops Background Music Pack.

- Source: https://opengameart.org/content/short-loops-background-music-pack
- License: CC0 (attribution optional)
- Original file: `Just Saying Tho.ogg`
- Original SHA-256: `687aa35987b89797af14735348c5b2f1b766ac0ba528dc001746aaf4ca1cc82f`
- Runtime SHA-256: `caf717fc2509fad5fbaefd7deb5e008c206b033dd4b64dd92e2a13c8dbe4cb29`
- Runtime encoding: stereo 48 kHz MP3, 112 kbps, -22 LUFS target

The original OGG is not bundled in the production payload. The previous
`stadium-chill-loop.mp3` is retained under `work/audio-source-2026-08-26/`
as a recovery asset and is not copied into the portal build.

During matches the runtime plays the loop at 1.04x and adds a quiet 138 BPM
tonal kick/bass pulse. The pulse contains no synthesized noise or continuous
crowd bed, avoiding the radio-static character rejected in live QA. Menu
playback remains calmer at 0.98x without the pulse.
