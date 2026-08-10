/**
 * Entry point: state machine, fixed-timestep loop, input routing,
 * sim-event -> audio/FX wiring, touch joystick, debug hooks.
 */

import './styles.css';
import { AudioEngine } from './core/audio';
import { Input } from './core/input';
import { loadStripAtlas, primePlayerStrips } from './core/sprites';
import { ABILITIES, PLAYERS, META_TRACKS, metaCost, type AbilityId, type MetaTrackId } from './game/data';
import { Save } from './game/meta';
import { Renderer } from './game/render';
import { Sim, type UpgradeOption } from './game/sim';
import { UI } from './game/ui';

type AppState = 'menu' | 'select' | 'club' | 'run';
type RunState = 'playing' | 'levelup' | 'paused' | 'over';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const uiRoot = document.getElementById('ui') as HTMLElement;

const save = new Save(typeof localStorage !== 'undefined' ? localStorage : null);
const audio = new AudioEngine();
audio.muted = save.data.muted;
audio.setVolumes({ ...save.data.volume });
const input = new Input(window);
const renderer = new Renderer(canvas);

let appState: AppState = 'menu';
let runState: RunState = 'playing';
let sim: Sim | null = null;
let playerDef = PLAYERS[0];
let overTimer = -1;
let resultShown = false;
let menuArtUrl: string | null = null;
const debug = new URLSearchParams(location.search).has('debug');

// Try to load generated menu art (public/art/menu-key-art.jpg); fallback: gradient.
{
  const img = new Image();
  img.onload = () => {
    menuArtUrl = 'art/menu-key-art.jpg';
    const el = document.getElementById('menu-art');
    if (el) (el as HTMLElement).style.backgroundImage = `url('${menuArtUrl}')`;
  };
  img.src = 'art/menu-key-art.jpg';
}

// Arena plate: swap the gameplay world's base when the generated art is ready.
{
  const img = new Image();
  img.onload = () => renderer.setArenaImage(img);
  img.src = 'art/arena/gameplay-pitch-v1.webp';
}

const sfxThrottle = new Map<string, number>();
function throttled(key: string, minMs: number): boolean {
  const now = performance.now();
  const last = sfxThrottle.get(key) ?? -1e9;
  if (now - last < minMs) return false;
  sfxThrottle.set(key, now);
  return true;
}

const ui = new UI(uiRoot, {
  onPlay(playerId) {
    playerDef = PLAYERS.find((p) => p.id === playerId) ?? PLAYERS[0];
    startRun();
  },
  onOpenClub() {
    appState = 'club';
    ui.showClub('upgrades');
  },
  onCloseClub() {
    appState = 'menu';
    ui.showMenu(menuArtUrl);
  },
  onResume() {
    if (appState !== 'run') return;
    if (runState === 'paused') {
      runState = 'playing';
      ui.hidePause();
    }
  },
  onRestart() {
    startRun();
  },
  onQuitToMenu() {
    appState = 'menu';
    runState = 'playing';
    sim = null;
    audio.stopMusic();
    ui.showMenu(menuArtUrl);
  },
  onUpgradePicked(opt: UpgradeOption) {
    if (!sim) return;
    sim.applyUpgrade(opt);
    sim.pendingLevelups = Math.max(0, sim.pendingLevelups - 1);
    if (sim.pendingLevelups > 0) {
      ui.showLevelUp(sim.rollUpgrades(), () => sim!.rollUpgrades());
    } else {
      runState = 'playing';
    }
  },
  onBuyTrack(id: MetaTrackId) {
    const track = META_TRACKS.find((t) => t.id === id);
    if (track) save.buyRank(id, metaCost(track, save.rank(id)));
    ui.showClub('upgrades');
  },
  onBuySkin(id: string) {
    save.buySkin(id);
    ui.showClub('skins');
  },
  onEquipSkin(playerId: string, skinId: string | null) {
    save.equipSkin(playerId, skinId);
    if (appState === 'club') ui.showClub('skins');
  },
  onToggleMute() {
    audio.unlock();
    save.data.muted = !save.data.muted;
    save.persist();
    audio.setMuted(save.data.muted);
    if (appState === 'menu') ui.showMenu(menuArtUrl);
    if (runState === 'paused') {
      ui.hidePause();
      ui.showPause();
    }
  },
  onVolume(kind, value) {
    save.data.volume[kind] = value;
    save.persist();
    audio.setVolumes({ ...save.data.volume });
  },
},
save,
);

function startRun(): void {
  audio.unlock();
  audio.stopMusic();
  audio.startMusic();
  sim = new Sim(playerDef, save);
  appState = 'run';
  runState = 'playing';
  overTimer = -1;
  resultShown = false;
  ui.buildHud();
  ui.banner('Kick Off!');
}

function endRun(won: boolean): void {
  if (!sim || resultShown) return;
  resultShown = true;
  const r = sim.result(won);
  save.addCoins(r.coins + r.bonus);
  save.recordRun({ kills: r.kills, time: r.time, level: r.level, won });
  audio.stopMusic();
  ui.showResult(won, sim, playerDef);
}

function drainEvents(): void {
  if (!sim) return;
  for (const ev of sim.events) {
    switch (ev.type) {
      case 'kick':
        if (throttled('kick', 90)) audio.kick();
        break;
      case 'hit':
        if (throttled(ev.crit ? 'critHit' : ev.heavy ? 'heavyHit' : 'hit', ev.crit ? 45 : ev.heavy ? 65 : 85)) {
          audio.hit(ev.heavy, ev.crit);
        }
        break;
      case 'kill':
        renderer.addShake(ev.elite ? 5 : 1.6);
        if (ev.elite && throttled('elite', 300)) audio.roar(0.7);
        // hit-stop: brief freeze sells the knockout (longer for bosses/elites)
        hitStop = Math.max(hitStop, ev.elite ? 0.12 : 0.028);
        break;
      case 'xp':
        if (throttled('xp', 70)) audio.xp();
        break;
      case 'coin':
        if (throttled('coin', 100)) audio.coin();
        break;
      case 'trophy':
        audio.levelup();
        renderer.addShake(3 + ev.tier);
        ui.banner(`Trophy secured! +${ev.coins} coins`);
        break;
      case 'levelup':
        audio.levelup();
        audio.roar(0.5);
        ui.banner(`Level ${sim.player.level}`);
        break;
      case 'whistle':
        if (throttled('whistle', 150)) audio.shockwave();
        renderer.addShake(2.5);
        break;
      case 'pressure':
        if (throttled('pressure', 200)) audio.shockwave();
        renderer.addShake(1.5);
        break;
      case 'blast':
        if (throttled('blast', 180)) audio.blast();
        renderer.addShake(4.5);
        break;
      case 'wave':
        if (throttled('wave', 500)) audio.roar(0.42);
        ui.banner(`Wave ${ev.number} · ${ev.name}`);
        break;
      case 'lobLand':
        if (throttled('lobLand', 90)) audio.punch();
        renderer.addShake(1.2);
        break;
      case 'vuvuzela':
        if (throttled('vuvuzela', 250)) audio.horn();
        renderer.addShake(2);
        break;
      case 'flash':
        audio.cameraFlash();
        renderer.flashWhite();
        break;
      case 'chant':
        if (throttled('chant', 400)) audio.chant();
        break;
      case 'dash':
        audio.dash();
        break;
      case 'hurt':
        audio.hurt();
        renderer.warnFlash();
        renderer.addShake(7);
        break;
      case 'punch':
        if (throttled('punch', 120)) audio.punch();
        break;
      case 'bossSpawn':
        audio.bossHorn();
        audio.roar(1);
        renderer.addShake(9);
        ui.banner(`${ev.title}: ${ev.name}`);
        break;
      case 'bossDie':
        audio.roar(1);
        renderer.addShake(10);
        ui.banner(`Boss down! +${ev.coins} coins`);
        break;
      case 'flare':
        if (throttled('flare', 200)) audio.hit();
        break;
      case 'victory':
        audio.victory();
        break;
      case 'defeat':
        audio.defeat();
        break;
    }
  }
  sim.events.length = 0;
}

/* ---------------- touch joystick ---------------- */

const joy = { active: false, id: -1, cx: 0, cy: 0 };
const joyEl = () => document.getElementById('joystick');

window.addEventListener('pointerdown', (e) => {
  audio.unlock();
  if (e.pointerType !== 'touch' || appState !== 'run' || runState !== 'playing') return;
  if (e.clientX > window.innerWidth * 0.62) return; // right side reserved for buttons
  joy.active = true;
  joy.id = e.pointerId;
  joy.cx = e.clientX;
  joy.cy = e.clientY;
  document.body.classList.add('touch');
  const el = joyEl();
  if (el) {
    el.style.display = 'block';
    el.style.left = `${joy.cx}px`;
    el.style.top = `${joy.cy}px`;
  }
});
window.addEventListener('pointermove', (e) => {
  if (!joy.active || e.pointerId !== joy.id) return;
  const dx = e.clientX - joy.cx;
  const dy = e.clientY - joy.cy;
  const max = 52;
  const l = Math.hypot(dx, dy);
  const cl = Math.min(l, max);
  const nx = l > 0 ? (dx / l) * (cl / max) : 0;
  const ny = l > 0 ? (dy / l) * (cl / max) : 0;
  input.joyActive = true;
  input.joyX = nx;
  input.joyY = ny;
  const el = joyEl();
  if (el) {
    const nub = el.querySelector('.nub') as HTMLElement;
    nub.style.transform = `translate(calc(-50% + ${(dx / (l || 1)) * cl}px), calc(-50% + ${(dy / (l || 1)) * cl}px))`;
  }
});
function endJoy(e: PointerEvent): void {
  if (!joy.active || e.pointerId !== joy.id) return;
  joy.active = false;
  input.joyActive = false;
  input.joyX = 0;
  input.joyY = 0;
  const el = joyEl();
  if (el) el.style.display = 'none';
}
window.addEventListener('pointerup', endJoy);
window.addEventListener('pointercancel', endJoy);

/* ---------------- keyboard shortcuts ---------------- */

window.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if (appState === 'run') {
    if (k === 'escape' || k === 'p') {
      if (runState === 'playing') {
        runState = 'paused';
        ui.showPause();
      } else if (runState === 'paused') {
        runState = 'playing';
        ui.hidePause();
      }
    }
    if (runState === 'levelup' && sim && ['1', '2', '3'].includes(k)) {
      const idx = Number(k) - 1;
      const cards = document.querySelectorAll('#levelup-screen .upgrade-card');
      const card = cards[idx] as HTMLElement | undefined;
      card?.click();
    }
  } else if (appState === 'menu' && k === 'enter') {
    ui.showSelect();
    appState = 'select';
  }
});

/* ---------------- main loop ---------------- */

const STEP = 1 / 60;
let acc = 0;
let last = performance.now();
let fps = 60;
let fpsAcc = 0;
let fpsN = 0;
let hitStop = 0; // brief sim freeze on knockouts (combat feel)

function frame(now: number): void {
  requestAnimationFrame(frame);
  const dt = Math.min(0.25, (now - last) / 1000);
  last = now;
  fpsAcc += dt;
  fpsN++;
  if (fpsAcc >= 0.5) {
    fps = fpsN / fpsAcc;
    fpsAcc = 0;
    fpsN = 0;
  }

  input.update();

  if (appState === 'run' && sim) {
    if (runState === 'playing') {
      if (hitStop > 0) {
        hitStop -= dt; // frozen sim, live renderer (shake/flash still animate)
      } else {
        acc += dt;
        let steps = 0;
        while (acc >= STEP && steps < 5) {
          sim.update(STEP, input.ax, input.ay);
          steps++;
          acc -= STEP;
        }
        if (steps === 5) acc = 0; // drop time under heavy load
      }
      drainEvents();
      if (sim.pendingLevelups > 0 && runState === 'playing') {
        runState = 'levelup';
        ui.showLevelUp(sim.rollUpgrades(), () => sim!.rollUpgrades());
      }
      if (sim.over !== 'playing') {
        // a level-up overlay must never block the end-of-run flow
        if (runState === 'levelup') {
          runState = 'playing';
          document.getElementById('levelup-screen')?.remove();
        }
        if (overTimer < 0) {
          overTimer = 1.4; // let the final whistle moment breathe
        }
      }
    }
    if (overTimer > 0) {
      overTimer -= dt;
      if (overTimer <= 0) endRun(sim.over === 'won');
    }
    renderer.draw(sim, playerDef, save, now / 1000, debug);
    ui.updateHud(sim);
  }

  input.endFrame();
}

function onResize(): void {
  renderer.resize();
}
window.addEventListener('resize', onResize);
window.addEventListener('orientationchange', onResize);

// unlock audio on any first interaction
window.addEventListener('pointerdown', () => audio.unlock(), { once: true });
window.addEventListener('keydown', () => audio.unlock(), { once: true });

// boot
onResize();
primePlayerStrips(PLAYERS.map((p) => p.id));
// when generated strips arrive, refresh the select screen portraits if open
Promise.all(PLAYERS.map((p) => loadStripAtlas(p.id, `art/players/${p.id}.png`))).then(() => {
  if (document.querySelector('.char-grid')) ui.showSelect();
});
ui.showMenu(menuArtUrl);
requestAnimationFrame(frame);

/* ---------------- debug / e2e hooks ---------------- */

interface FfDebug {
  getState(): { app: AppState; run: RunState };
  getSim(): Sim | null;
  startRun(playerId?: string): void;
  setTime(t: number): void;
  giveXp(n: number): void;
  hurt(n: number): void;
  addCoins(n: number): void;
  getSave(): Save;
  getFps(): number;
  pickUpgrade(i: number): void;
  skipToBoss(n: 1 | 2): void;
  debugSpawn(id: string, dx: number, dy: number, elite?: boolean): void;
  showAbilityCards(ids: AbilityId[]): void;
}
const ff: FfDebug = {
  getState: () => ({ app: appState, run: runState }),
  getSim: () => sim,
  startRun: (playerId?: string) => {
    playerDef = PLAYERS.find((p) => p.id === playerId) ?? PLAYERS[0];
    startRun();
  },
  setTime: (t: number) => {
    if (sim) sim.time = t;
  },
  giveXp: (n: number) => {
    if (sim) sim.debugGiveXp(n);
  },
  hurt: (n: number) => {
    if (sim) {
      sim.player.iframes = 0;
      sim.player.hp -= n;
      if (sim.player.hp <= 0) {
        sim.player.hp = 0;
        sim.over = 'lost';
      }
    }
  },
  addCoins: (n: number) => save.addCoins(n),
  getSave: () => save,
  getFps: () => fps,
  pickUpgrade: (i: number) => {
    const cards = document.querySelectorAll('#levelup-screen .upgrade-card');
    (cards[i] as HTMLElement | undefined)?.click();
  },
  skipToBoss: (n: 1 | 2) => {
    if (sim) sim.time = n === 1 ? 299.5 : 539.5;
  },
  debugSpawn: (id: string, dx: number, dy: number, elite = false) => {
    if (!sim) return;
    sim.debugSpawn(id as 'invader', sim.player.x + dx, sim.player.y + dy, elite);
  },
  showAbilityCards: (ids: AbilityId[]) => {
    if (!sim) return;
    const options: UpgradeOption[] = ids.slice(0, 3).map((id) => {
      const def = ABILITIES[id];
      const level = Math.min((sim!.player.abilities[id] ?? 0) + 1, def.levels.length);
      return { kind: 'ability', id, name: def.name, desc: def.levels[level - 1].desc, color: def.color, level };
    });
    sim.pendingLevelups = 1;
    runState = 'levelup';
    ui.showLevelUp(options, () => options);
  },
};
(window as unknown as { __FF: FfDebug }).__FF = ff;
