/**
 * Entry point: state machine, fixed-timestep loop, input routing,
 * sim-event -> audio/FX wiring, touch joystick, debug hooks.
 */

import './styles.css';
import { AudioEngine } from './core/audio';
import { Input } from './core/input';
import { loadStripAtlas, primePlayerStrips } from './core/sprites';
import { ABILITIES, BOSS1_AT, BOSS2_AT, PLAYERS, META_TRACKS, STATS, metaCost, type AbilityId, type MetaTrackId, type StatId } from './game/data';
import { Save } from './game/meta';
import { Renderer } from './game/render';
import { Sim, type UpgradeOption } from './game/sim';
import { UI } from './game/ui';

type AppState = 'menu' | 'select' | 'club' | 'run';
type RunState = 'playing' | 'levelup' | 'paused' | 'over';
type RewardMode = 'levelup' | 'boss';

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
let rewardMode: RewardMode = 'levelup';
let sim: Sim | null = null;
let playerDef = PLAYERS[0];
let overTimer = -1;
let resultShown = false;
let menuArtUrl: string | null = null;
const debug = new URLSearchParams(location.search).has('debug');
const debugMoveKey = debug ? new URLSearchParams(location.search).get('move') : null;
const debugMoveVectors: Record<string, readonly [number, number]> = {
  n: [0, -1],
  ne: [Math.SQRT1_2, -Math.SQRT1_2],
  e: [1, 0],
  se: [Math.SQRT1_2, Math.SQRT1_2],
  s: [0, 1],
  sw: [-Math.SQRT1_2, Math.SQRT1_2],
  w: [-1, 0],
  nw: [-Math.SQRT1_2, -Math.SQRT1_2],
};
const debugMove = debugMoveKey ? debugMoveVectors[debugMoveKey] : undefined;

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
  img.src = 'art/arena/gameplay-pitch-v2.webp';
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
    if (rewardMode === 'boss') {
      sim.pendingBossAbilities = Math.max(0, sim.pendingBossAbilities - 1);
      if (sim.pendingBossAbilities > 0) {
        ui.showLevelUp(
          sim.rollBossAbilities(),
          () => sim!.rollBossAbilities(),
          'boss',
          sim.pendingBossAbilities,
        );
      } else if (sim.pendingLevelups > 0) {
        rewardMode = 'levelup';
        ui.showLevelUp(sim.rollUpgrades(), () => sim!.rollUpgrades());
      } else {
        runState = 'playing';
      }
      return;
    }
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
  rewardMode = 'levelup';
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
        ui.banner(`Boss loot! +${ev.coins} coins · ${ev.abilityPicks} ability picks`);
        break;
      case 'magnet':
        audio.magnet();
        renderer.addShake(2.5);
        ui.banner('FULL-PITCH MAGNET');
        break;
      case 'bomb':
        audio.arenaBomb();
        renderer.playMatchdayWipeout();
        renderer.addShake(14);
        hitStop = Math.max(hitStop, 0.16);
        ui.banner(ev.defeated > 0 ? `MATCHDAY WIPEOUT · ${ev.defeated} DOWN` : 'MATCHDAY WIPEOUT');
        break;
      case 'freeze':
        audio.timeFreeze();
        renderer.addShake(3);
        ui.banner(`STOPPAGE-TIME FREEZE · ${ev.duration.toFixed(1)}s`);
        break;
      case 'levelup':
        audio.levelup();
        audio.roar(0.5);
        ui.banner(`Level ${sim.player.level}`);
        break;
      case 'maxAbility':
        audio.levelup();
        audio.roar(0.8);
        renderer.addShake(5);
        ui.banner(`MAX EVOLUTION · ${ev.name}`);
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
      case 'lobLand':
        if (throttled('lobLand', 90)) audio.punch();
        renderer.addShake(1.2);
        break;
      case 'seekerLaunch':
        if (throttled(`seekerLaunch-${ev.kind}`, 120)) {
          if (ev.kind === 'curveball') audio.curveball();
          else audio.goldenBoot();
        }
        renderer.addShake(ev.kind === 'curveball' ? 0.8 : 1.8);
        break;
      case 'seekerHit':
        if (throttled(`seekerHit-${ev.kind}`, ev.kind === 'curveball' ? 70 : 110)) audio.seekerImpact(ev.kind);
        renderer.addShake(ev.kind === 'curveball' ? 0.9 : 2.6);
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
      case 'zap':
        if (throttled('zap', 110)) audio.zap();
        renderer.addShake(0.7);
        break;
      case 'bullCharge':
        if (throttled('bullCharge', 280)) audio.bullCharge();
        renderer.addShake(3.5);
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
          sim.update(STEP, debugMove?.[0] ?? input.ax, debugMove?.[1] ?? input.ay);
          steps++;
          acc -= STEP;
        }
        if (steps === 5) acc = 0; // drop time under heavy load
      }
      drainEvents();
      if (sim.pendingBossAbilities > 0 && runState === 'playing') {
        runState = 'levelup';
        rewardMode = 'boss';
        ui.showLevelUp(
          sim.rollBossAbilities(),
          () => sim!.rollBossAbilities(),
          'boss',
          sim.pendingBossAbilities,
        );
      } else if (sim.pendingLevelups > 0 && runState === 'playing') {
        runState = 'levelup';
        rewardMode = 'levelup';
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
  debugDropPickup(kind: 'xp' | 'coin' | 'heal' | 'trophy' | 'magnet' | 'bomb' | 'freeze', dx: number, dy: number): void;
  showAbilityCards(ids: AbilityId[]): void;
  showTrainingCards(ids: Array<StatId | 'heal' | 'coins'>): void;
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
    sim?.debugHurt(n);
  },
  addCoins: (n: number) => save.addCoins(n),
  getSave: () => save,
  getFps: () => fps,
  pickUpgrade: (i: number) => {
    const cards = document.querySelectorAll('#levelup-screen .upgrade-card');
    (cards[i] as HTMLElement | undefined)?.click();
  },
  skipToBoss: (n: 1 | 2) => {
    if (sim) sim.time = (n === 1 ? BOSS1_AT : BOSS2_AT) - 0.5;
  },
  debugSpawn: (id: string, dx: number, dy: number, elite = false) => {
    if (!sim) return;
    sim.debugSpawn(id as 'invader', sim.player.x + dx, sim.player.y + dy, elite);
  },
  debugDropPickup: (kind, dx, dy) => {
    if (!sim) return;
    sim.debugDropPickup(kind, sim.player.x + dx, sim.player.y + dy);
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
  showTrainingCards: (ids: Array<StatId | 'heal' | 'coins'>) => {
    if (!sim) return;
    const options: UpgradeOption[] = ids.slice(0, 3).map((id) => {
      if (id === 'heal') return { kind: 'heal', id, name: 'Orange Slices', desc: 'Recover 30 HP right now.', color: '#80ed99', level: 0 };
      if (id === 'coins') return { kind: 'coins', id, name: 'Signing Bonus', desc: '+25 coins, straight into the club account.', color: '#ffd23f', level: 0 };
      const def = STATS[id];
      return { kind: 'stat', id, name: def.name, desc: def.desc, color: def.color, level: 0 };
    });
    sim.pendingLevelups = 1;
    runState = 'levelup';
    ui.showLevelUp(options, () => options);
  },
};
(window as unknown as { __FF: FfDebug }).__FF = ff;

// URL-addressable visual fixture for real-browser QA. It is excluded from
// normal play and keeps screenshots deterministic without changing balance.
const debugStage = debug ? new URLSearchParams(location.search).get('stage') : null;
if (debugStage === 'damage') {
  ff.startRun('messi');
  const stagedSim = ff.getSim();
  if (stagedSim) {
    stagedSim.player.abilities = {};
    stagedSim.player.maxHp = 9999;
    stagedSim.player.hp = 9999;
    stagedSim.debugSpawn('steward', stagedSim.player.x + 54, stagedSim.player.y);
  }
} else if (debugStage === 'death-vfx') {
  ff.startRun('messi');
  const stagedSim = ff.getSim();
  if (stagedSim) {
    stagedSim.player.abilities = {};
    stagedSim.player.maxHp = 9999;
    stagedSim.player.hp = 0;
    stagedSim.over = 'lost';
    const corpseIds = ['invader', 'sprinter', 'steward', 'bull', 'drone', 'boss-captain'] as const;
    corpseIds.forEach((id, index) => {
      const corpse = stagedSim.corpses[index];
      corpse.active = true;
      corpse.x = stagedSim.player.x - 330 + index * 132;
      corpse.y = stagedSim.player.y + 150;
      corpse.enemyId = id === 'boss-captain' ? 'invader' : id;
      corpse.variant = 0;
      corpse.boss = id === 'boss-captain' ? 'captain' : '';
      corpse.elite = id === 'bull';
      corpse.face = index % 2 === 0 ? 1 : -1;
      corpse.max = 10;
      corpse.t = (index / corpseIds.length) * 7.2;
    });
    document.getElementById('banner')?.classList.remove('show');
  }
} else if (debugStage === 'pickups') {
  ff.startRun('messi');
  const stagedSim = ff.getSim();
  if (stagedSim) {
    stagedSim.player.abilities = {};
    const lootLineup: Array<['xp' | 'coin' | 'heal' | 'trophy' | 'magnet' | 'bomb' | 'freeze', number, number]> = [
      ['xp', -390, -70],
      ['coin', -270, 145],
      ['heal', -140, 265],
      ['trophy', 0, 305],
      ['magnet', 140, 265],
      ['bomb', 270, 145],
      ['freeze', 390, -70],
    ];
    for (const [kind, dx, dy] of lootLineup) {
      stagedSim.debugDropPickup(kind, stagedSim.player.x + dx, stagedSim.player.y + dy);
    }
    document.getElementById('banner')?.classList.remove('show');
  }
} else if (debugStage === 'projectiles') {
  ff.startRun('messi');
  const stagedSim = ff.getSim();
  if (stagedSim) {
    stagedSim.player.abilities = { curveball: 5, bootseekers: 5 };
    stagedSim.player.maxHp = 9999;
    stagedSim.player.hp = 9999;
    stagedSim.player.curveballCd = 0;
    stagedSim.player.bootseekersCd = 0;
    const targets: Array<[string, number, number]> = [
      ['drone', -430, -210],
      ['paparazzo', 430, -210],
      ['flag', -480, 90],
      ['vuvuzela', 480, 90],
      ['steward', -360, 280],
      ['bull', 360, 280],
    ];
    for (const [id, dx, dy] of targets) {
      stagedSim.debugSpawn(id as 'invader', stagedSim.player.x + dx, stagedSim.player.y + dy);
      const enemy = [...stagedSim.enemies].reverse().find((entry) => entry.active && entry.def.id === id);
      if (enemy) {
        enemy.damage = 0;
        enemy.speed = 0;
        enemy.stun = 999;
        enemy.maxHp = 9999;
        enemy.hp = 9999;
      }
    }
    document.getElementById('banner')?.classList.remove('show');
  }
} else if (debugStage === 'director') {
  ff.startRun('messi');
  const stagedSim = ff.getSim();
  if (stagedSim) {
    stagedSim.time = 570;
    stagedSim.boss0Spawned = true;
    stagedSim.boss1Spawned = true;
    stagedSim.boss2Spawned = true;
    stagedSim.player.maxHp = 9999;
    stagedSim.player.hp = 9999;
    stagedSim.player.xp = 0;
    stagedSim.player.xpNext = 999999;
    stagedSim.player.abilities = { strike: 3, orbit: 3, whistle: 2, blast: 2 };
    document.getElementById('banner')?.classList.remove('show');
  }
} else if (debugStage === 'orbit-reactions') {
  ff.startRun('yamal');
  const stagedSim = ff.getSim();
  if (stagedSim) {
    stagedSim.player.abilities = { orbit: 5 };
    stagedSim.player.maxHp = 9999;
    stagedSim.player.hp = 9999;
    stagedSim.player.orbitAngle = 0;
    stagedSim.player.orbitBreakCd = 999;
    for (let slot = 0; slot < 6; slot++) {
      const a = (slot / 6) * Math.PI * 2;
      stagedSim.debugSpawn('invader', stagedSim.player.x + Math.cos(a) * 140, stagedSim.player.y + Math.sin(a) * 140);
      const enemy = [...stagedSim.enemies].reverse().find((entry) => entry.active && entry.def.id === 'invader' && entry.maxHp < 9999);
      if (enemy) {
        enemy.damage = 0;
        enemy.speed = 0;
        enemy.maxHp = 9999;
        enemy.hp = 9999;
        enemy.barHp = 9999;
      }
    }
    document.getElementById('banner')?.classList.remove('show');
  }
} else if (debugStage === 'enemy-attacks') {
  ff.startRun('messi');
  const stagedSim = ff.getSim();
  if (stagedSim) {
    stagedSim.player.abilities = {};
    stagedSim.player.maxHp = 9999;
    stagedSim.player.hp = 9999;
    const attackers: Array<[string, number, number, 'melee' | 'throw' | 'charge' | 'electric']> = [
      ['invader', -250, 80, 'melee'],
      ['steward', -90, 120, 'melee'],
      ['lobber', 250, 80, 'throw'],
      ['bull', -300, -170, 'charge'],
      ['drone', 300, -170, 'electric'],
    ];
    for (const [id, dx, dy, attack] of attackers) {
      stagedSim.debugSpawn(id as 'invader', stagedSim.player.x + dx, stagedSim.player.y + dy);
      const enemy = [...stagedSim.enemies].reverse().find((entry) => entry.active && entry.def.id === id);
      if (!enemy) continue;
      enemy.damage = 0;
      enemy.speed = 0;
      enemy.maxHp = 9999;
      enemy.hp = 9999;
      enemy.barHp = 9999;
      if (attack === 'throw') {
        enemy.casting = 'bottle';
        enemy.windup = 0.42;
      } else if (attack === 'charge') {
        const dxToPlayer = stagedSim.player.x - enemy.x;
        const dyToPlayer = stagedSim.player.y - enemy.y;
        const d = Math.hypot(dxToPlayer, dyToPlayer) || 1;
        enemy.chargeDx = dxToPlayer / d;
        enemy.chargeDy = dyToPlayer / d;
        enemy.casting = 'charge';
        enemy.windup = 0.72;
        enemy.telegraph = 0.72;
      } else if (attack === 'electric') {
        enemy.casting = 'electric';
        enemy.windup = 0.46;
        enemy.telegraph = 0.46;
      } else {
        enemy.windup = 0.34;
      }
    }
    document.getElementById('banner')?.classList.remove('show');
  }
} else if (debugStage === 'lobber-scale') {
  ff.startRun('messi');
  const stagedSim = ff.getSim();
  if (stagedSim) {
    stagedSim.player.abilities = {};
    stagedSim.player.maxHp = 9999;
    stagedSim.player.hp = 9999;
    stagedSim.debugSpawn('lobber', stagedSim.player.x - 190, stagedSim.player.y + 110);
    stagedSim.debugSpawn('lobber', stagedSim.player.x + 190, stagedSim.player.y + 110);
    const lobbers = stagedSim.enemies.filter((enemy) => enemy.active && enemy.def.id === 'lobber');
    for (const enemy of lobbers) {
      enemy.damage = 0;
      enemy.speed = 0;
      enemy.maxHp = 9999;
      enemy.hp = 9999;
      enemy.barHp = 9999;
      enemy.rangedCd = 9999;
    }
    if (lobbers[1]) {
      // Hold the semantic throw pose beside the idle pose. Infinity is used
      // only by this deterministic debug fixture; gameplay casts stay finite.
      lobbers[1].casting = 'bottle';
      lobbers[1].windup = Number.POSITIVE_INFINITY;
    }
    document.getElementById('banner')?.classList.remove('show');
  }
} else if (debugStage === 'drone-motion') {
  ff.startRun('messi');
  const stagedSim = ff.getSim();
  if (stagedSim) {
    stagedSim.player.abilities = {};
    stagedSim.player.maxHp = 9999;
    stagedSim.player.hp = 9999;
    stagedSim.debugSpawn('drone', stagedSim.player.x + 320, stagedSim.player.y - 80);
    const drone = stagedSim.enemies.find((entry) => entry.active && entry.def.id === 'drone');
    if (drone) {
      drone.damage = 0;
      drone.maxHp = 9999;
      drone.hp = 9999;
      drone.barHp = 9999;
      drone.rangedCd = 999;
    }
    document.getElementById('banner')?.classList.remove('show');
  }
} else if (debugStage === 'healthbars') {
  ff.startRun('messi');
  const stagedSim = ff.getSim();
  if (stagedSim) {
    stagedSim.player.abilities = {};
    stagedSim.player.maxHp = 9999;
    stagedSim.player.hp = 9999;
    const lineup: Array<[string, number, number, number, boolean]> = [
      ['invader', -340, 165, 0.82, false],
      ['sprinter', -170, 165, 0.58, false],
      ['steward', 0, 165, 0.34, true],
      ['bull', 170, 165, 0.2, false],
      ['drone', 340, 165, 0.66, false],
    ];
    for (const [id, dx, dy, ratio, elite] of lineup) {
      stagedSim.debugSpawn(id as 'invader', stagedSim.player.x + dx, stagedSim.player.y + dy, elite);
      const enemy = [...stagedSim.enemies].reverse().find((e) => e.active && e.def.id === id);
      if (enemy) {
        enemy.speed = 0;
        enemy.stun = 999;
        enemy.hp = enemy.maxHp * ratio;
      }
    }
  }
} else if (debugStage === 'heart-vfx') {
  ff.startRun('messi');
  const stagedSim = ff.getSim();
  if (stagedSim) {
    stagedSim.player.abilities = {};
    stagedSim.player.maxHp = 9999;
    stagedSim.player.hp = 9999;
    // Infinity freezes the generated clip on its strongest readable frame for
    // deterministic visual QA. Normal upgrade activations always use 0.9s.
    stagedSim.player.heartFxT = Number.POSITIVE_INFINITY;
    document.getElementById('banner')?.classList.remove('show');
  }
} else if (debugStage === 'aim-kick') {
  ff.startRun('messi');
  const stagedSim = ff.getSim();
  if (stagedSim) {
    stagedSim.player.abilities = { strike: 1 };
    stagedSim.player.maxHp = 9999;
    stagedSim.player.hp = 9999;
    stagedSim.debugSpawn('steward', stagedSim.player.x + 330, stagedSim.player.y + 115);
    const target = stagedSim.enemies.find((enemy) => enemy.active);
    if (target) {
      target.speed = 0;
      target.damage = 0;
      target.stun = 9999;
      target.maxHp = 999999;
      target.hp = target.maxHp;
    }
    stagedSim.player.strikeCd = 0;
    document.getElementById('banner')?.classList.remove('show');
  }
} else if (debugStage === 'target-marker') {
  ff.startRun('messi');
  const stagedSim = ff.getSim();
  if (stagedSim) {
    stagedSim.player.abilities = {};
    stagedSim.player.maxHp = 9999;
    stagedSim.player.hp = 9999;
    const marker = stagedSim.reticles[0];
    marker.active = true;
    marker.x = stagedSim.player.x + 230;
    marker.y = stagedSim.player.y + 135;
    marker.t = 45_000;
    marker.max = 100_000;
    marker.targetIdx = -1;
    marker.phase = 'landing';
    document.getElementById('banner')?.classList.remove('show');
  }
} else if (debugStage === 'freeze-field') {
  ff.startRun('messi');
  const stagedSim = ff.getSim();
  if (stagedSim) {
    stagedSim.player.abilities = {};
    stagedSim.player.maxHp = 9999;
    stagedSim.player.hp = 9999;
    const lineup: Array<[string, number, number]> = [
      ['invader', -520, -260],
      ['bull', -265, 195],
      ['steward', 0, -285],
      ['drone', 285, -190],
      ['sprinter', 520, 210],
    ];
    for (const [id, dx, dy] of lineup) {
      stagedSim.debugSpawn(id as 'invader', stagedSim.player.x + dx, stagedSim.player.y + dy);
      const enemy = [...stagedSim.enemies].reverse().find((entry) => entry.active && entry.def.id === id);
      if (enemy) {
        enemy.damage = 0;
        enemy.maxHp = 9999;
        enemy.hp = 9999;
        enemy.barHp = 9999;
      }
    }
    // Hold the field in a deterministic frozen state for visual QA. Real
    // freeze pickups still use their normal finite gameplay duration.
    stagedSim.freezeT = Number.POSITIVE_INFINITY;
    document.getElementById('banner')?.classList.remove('show');
  }
} else if (debugStage === 'boss-summon') {
  ff.startRun('messi');
  const stagedSim = ff.getSim();
  if (stagedSim) {
    stagedSim.player.abilities = {};
    stagedSim.player.maxHp = 9999;
    stagedSim.player.hp = 9999;
    stagedSim.debugSpawnBoss('official');
    const boss = stagedSim.enemies.find((enemy) => enemy.active && enemy.boss === 'official');
    if (boss) {
      boss.x = stagedSim.player.x + 390;
      boss.y = stagedSim.player.y + 70;
      boss.speed = 0;
      boss.damage = 0;
      boss.bossCd = 999;
      boss.bossCd2 = 0;
      boss.rangedCd = 999;
    }
    document.getElementById('banner')?.classList.remove('show');
  }
} else if (debugStage === 'player-directions') {
  const playerId = new URLSearchParams(location.search).get('player') ?? 'messi';
  ff.startRun(playerId);
  const stagedSim = ff.getSim();
  if (stagedSim) {
    stagedSim.player.abilities = {};
    stagedSim.player.maxHp = 99_999;
    stagedSim.player.hp = 99_999;
    stagedSim.player.xpNext = 999_999;
    stagedSim.boss0Spawned = true;
    stagedSim.boss1Spawned = true;
    stagedSim.boss2Spawned = true;
    stagedSim.events.length = 0;
    document.getElementById('banner')?.classList.remove('show');
  }
} else if (debugStage === 'boss-directions') {
  ff.startRun('messi');
  const stagedSim = ff.getSim();
  if (stagedSim) {
    stagedSim.player.abilities = {};
    stagedSim.player.maxHp = 99_999;
    stagedSim.player.hp = 99_999;
    stagedSim.player.xpNext = 999_999;
    stagedSim.boss0Spawned = true;
    stagedSim.boss1Spawned = true;
    stagedSim.boss2Spawned = true;
    const lineup: Array<['drumboss' | 'official' | 'captain', number]> = [
      ['drumboss', -2.45],
      ['official', -0.55],
      ['captain', 1.35],
    ];
    for (const [bossId, angle] of lineup) {
      stagedSim.debugSpawnBoss(bossId);
      const boss = [...stagedSim.enemies].reverse().find((enemy) => enemy.active && enemy.boss === bossId);
      if (!boss) continue;
      boss.x = stagedSim.player.x + Math.cos(angle) * 440;
      boss.y = stagedSim.player.y + Math.sin(angle) * 440;
      boss.damage = 0;
      boss.hp = boss.maxHp = boss.barHp = 99_999;
      boss.bossCd = 999;
      boss.bossCd2 = 999;
      boss.rangedCd = 999;
    }
    stagedSim.events.length = 0;
    document.getElementById('banner')?.classList.remove('show');
  }
} else if (debugStage === 'wipeout-vfx') {
  ff.startRun('messi');
  const stagedSim = ff.getSim();
  if (stagedSim) {
    stagedSim.player.abilities = {};
    stagedSim.player.maxHp = 99_999;
    stagedSim.player.hp = 99_999;
    stagedSim.player.xpNext = 999_999;
    stagedSim.boss0Spawned = true;
    stagedSim.boss1Spawned = true;
    stagedSim.boss2Spawned = true;
    const stageTargets = () => {
      for (let index = 0; index < 14; index++) {
        const angle = (index / 14) * Math.PI * 2;
        const radius = 240 + (index % 2) * 95;
        stagedSim.debugSpawn(
          index % 4 === 0 ? 'steward' : index % 3 === 0 ? 'sprinter' : 'invader',
          stagedSim.player.x + Math.cos(angle) * radius,
          stagedSim.player.y + Math.sin(angle) * radius,
        );
      }
      stagedSim.debugDropPickup('bomb', stagedSim.player.x, stagedSim.player.y);
    };
    window.setTimeout(stageTargets, 350);
    window.setInterval(stageTargets, 1_800);
    document.getElementById('banner')?.classList.remove('show');
  }
} else if (debugStage === 'variants') {
  ff.startRun('messi');
  const stagedSim = ff.getSim();
  if (stagedSim) {
    stagedSim.player.maxHp = 9999;
    stagedSim.player.hp = 9999;
    stagedSim.debugSetGuardDamageMultiplier(0);
    for (let level = 1; level <= 5; level++) {
      stagedSim.applyUpgrade({ kind: 'ability', id: 'guard', name: '', desc: '', color: '', level });
    }
    for (let i = 0; i < 12; i++) {
      const angle = (i / 12) * Math.PI * 2;
      const radius = 190 + (i % 2) * 75;
      stagedSim.debugSpawn('invader', stagedSim.player.x + Math.cos(angle) * radius, stagedSim.player.y + Math.sin(angle) * radius);
    }
    stagedSim.debugSpawnBoss('captain');
    const boss = stagedSim.enemies.find((enemy) => enemy.active && enemy.boss === 'captain');
    if (boss) {
      boss.x = stagedSim.player.x + 420;
      boss.y = stagedSim.player.y + 100;
    }
    for (const enemy of stagedSim.enemies) {
      if (!enemy.active) continue;
      enemy.damage = 0;
      enemy.stun = 999;
    }
  }
} else if (debugStage === 'guard-targeting') {
  ff.startRun('messi');
  const stagedSim = ff.getSim();
  if (stagedSim) {
    stagedSim.player.abilities = {};
    stagedSim.player.maxHp = 9999;
    stagedSim.player.hp = 9999;
    stagedSim.debugSetGuardDamageMultiplier(0);
    stagedSim.applyUpgrade({ kind: 'ability', id: 'guard', name: '', desc: '', color: '', level: 3 });
    stagedSim.debugSpawn('invader', stagedSim.player.x - 290, stagedSim.player.y + 70);
    stagedSim.debugSpawn('steward', stagedSim.player.x + 290, stagedSim.player.y + 70);
    stagedSim.debugSpawn('drone', stagedSim.player.x, stagedSim.player.y - 250);
    for (const enemy of stagedSim.enemies) {
      if (!enemy.active) continue;
      enemy.speed = 0;
      enemy.damage = 0;
      enemy.hp = enemy.maxHp = 999999;
      enemy.barHp = enemy.hp;
    }
    document.getElementById('banner')?.classList.remove('show');
  }
} else if (debugStage === 'guards') {
  ff.startRun('messi');
  const stagedSim = ff.getSim();
  if (stagedSim) {
    stagedSim.player.abilities = {};
    stagedSim.player.maxHp = 9999;
    stagedSim.player.hp = 9999;
    stagedSim.debugSetGuardDamageMultiplier(0);
    for (let level = 1; level <= 5; level++) {
      stagedSim.applyUpgrade({ kind: 'ability', id: 'guard', name: '', desc: '', color: '', level });
    }
    stagedSim.events.length = 0;
    stagedSim.guards.forEach((guard, index) => {
      guard.x = stagedSim.player.x - 150;
      guard.y = stagedSim.player.y - 85 + index * 85;
    });
    stagedSim.debugSpawn('drone', stagedSim.player.x + 285, stagedSim.player.y);
    const drone = stagedSim.enemies.find((enemy) => enemy.active && enemy.def.id === 'drone');
    if (drone) {
      drone.damage = 0;
      drone.stun = 999;
    }
    document.getElementById('banner')?.classList.remove('show');
  }
} else if (debugStage === 'boss-tiers') {
  ff.startRun('messi');
  const stagedSim = ff.getSim();
  if (stagedSim) {
    stagedSim.player.abilities = {};
    stagedSim.player.maxHp = 9999;
    stagedSim.player.hp = 9999;
    stagedSim.debugSpawnBoss('drumboss');
    const minor = stagedSim.enemies.find((enemy) => enemy.active && enemy.boss === 'drumboss');
    stagedSim.debugSpawnBoss('captain');
    const major = stagedSim.enemies.find((enemy) => enemy.active && enemy.boss === 'captain');
    if (minor) {
      minor.x = stagedSim.player.x - 380;
      minor.y = stagedSim.player.y + 70;
      minor.damage = 0;
      minor.stun = 999;
    }
    if (major) {
      major.x = stagedSim.player.x + 390;
      major.y = stagedSim.player.y + 70;
      major.damage = 0;
      major.stun = 999;
    }
    stagedSim.events.length = 0;
    document.getElementById('banner')?.classList.remove('show');
  }
} else if (debugStage === 'boss-loot') {
  ff.startRun('messi');
  const stagedSim = ff.getSim();
  if (stagedSim) {
    stagedSim.pendingBossAbilities = 2;
    runState = 'levelup';
    rewardMode = 'boss';
    ui.showLevelUp(stagedSim.rollBossAbilities(), () => stagedSim.rollBossAbilities(), 'boss', 2);
  }
} else if (debugStage === 'training-cards') {
  ff.startRun('messi');
  ff.showTrainingCards(['maxhp', 'armor', 'magnet']);
}
