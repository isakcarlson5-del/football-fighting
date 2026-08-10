/**
 * Dev tool: renders every game sprite (all 4 run frames) at high zoom on a
 * neutral background for art review. Captured by scripts/make-art.mjs or
 * manually via the dev server at /tools/sprites.html.
 */

import { bossAtlas, enemyAtlas, guardAtlas, playerAtlas, FW, FH } from '../src/core/sprites';
import { ENEMIES, PLAYERS } from '../src/game/data';

const SCALE = 5;
const LABEL = 26;
const COLS_W = FW * SCALE * 4; // 4 frames per row-set
const entries: { label: string; atlas: ReturnType<typeof playerAtlas> }[] = [
  ...PLAYERS.map((p) => ({ label: p.name, atlas: playerAtlas(p) })),
  ...Object.keys(ENEMIES).map((id) => ({ label: id, atlas: enemyAtlas(id as keyof typeof ENEMIES) })),
  { label: 'BOSS referee', atlas: bossAtlas('official') },
  { label: 'BOSS captain', atlas: bossAtlas('captain') },
  { label: 'bodyguard', atlas: guardAtlas() },
];

const canvas = document.getElementById('sheet') as HTMLCanvasElement;
const rowH = FH * SCALE + LABEL + 20;
canvas.width = COLS_W + 40;
canvas.height = entries.length * rowH + 20;
const ctx = canvas.getContext('2d')!;
ctx.imageSmoothingEnabled = false;

let y = 10;
for (const e of entries) {
  // checker floor strip for shadow read
  ctx.fillStyle = '#1b2233';
  ctx.fillRect(10, y + FH * SCALE - 30, COLS_W, 12);
  for (let f = 0; f < 4; f++) {
    ctx.drawImage(e.atlas.canvas, f * FW, 0, FW, FH, 20 + f * FW * SCALE, y, FW * SCALE, FH * SCALE);
  }
  ctx.fillStyle = '#f5f1e6';
  ctx.font = 'bold 20px system-ui, sans-serif';
  ctx.textBaseline = 'top';
  ctx.fillText(e.label, 20, y + FH * SCALE - 12);
  y += rowH;
}

(window as unknown as { __ART_READY: boolean }).__ART_READY = true;
