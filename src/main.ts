/**
 * Entry point: state machine, fixed-timestep loop, input routing,
 * sim-event -> audio/FX wiring, touch joystick, debug hooks.
 */

import './styles.css';
import { AudioEngine } from './core/audio';
import { Input } from './core/input';
import { consumeFixedSteps } from './core/timing';
import { CommunityClient, normalizeLeaderboardName } from './core/community';
import { loadStripAtlas, primePlayerStrips } from './core/sprites';
import { ABILITIES, BOSS1_AT, BOSS2_AT, PLAYERS, META_TRACKS, RUN_LENGTH, metaCost, type AbilityId, type MetaTrackId, type StatId } from './game/data';
import { Save } from './game/meta';
import { Renderer, type ArenaGrassRect, type CombatPresentationMetrics, type EntityScreenRect } from './game/render';
import { ARENA_H, ARENA_W, BOSS_INTRO_DURATION, BOSS_MELEE_LUNGE_DURATION, DASH_ANTICIPATION_DURATION, DASH_RECOVERY_DURATION, ENEMY_MELEE_LUNGE_DURATION, KICK_CONTACT_DELAY, KICK_DURATION, MELEE_RECOVERY_DURATION, Sim, type UpgradeOption } from './game/sim';
import { UI } from './game/ui';

type AppState = 'menu' | 'select' | 'club' | 'run';
type RunState = 'playing' | 'levelup' | 'paused' | 'over';
type RewardMode = 'levelup' | 'boss';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const uiRoot = document.getElementById('ui') as HTMLElement;

const save = new Save(typeof localStorage !== 'undefined' ? localStorage : null);
// Sound is intentionally disabled at every launch, including for older saves
// that were last closed while unmuted. Players may still opt in for the current
// session with the existing Unmute control.
save.data.muted = true;
save.persist();
const community = new CommunityClient(typeof localStorage !== 'undefined' ? localStorage : null);
const audio = new AudioEngine();
audio.muted = save.data.muted;
audio.setVolumes({ ...save.data.volume });
const input = new Input(window);
const renderer = new Renderer(canvas);
const reducedMotionQuery = typeof window.matchMedia === 'function'
  ? window.matchMedia('(prefers-reduced-motion: reduce)')
  : null;
const effectiveReducedVfx = () => save.data.reducedVfx || reducedMotionQuery?.matches === true;
renderer.setReducedVfx(effectiveReducedVfx());

let appState: AppState = 'menu';
let runState: RunState = 'playing';
let rewardMode: RewardMode = 'levelup';
let sim: Sim | null = null;
let playerDef = PLAYERS[0];
let overTimer = -1;
let resultShown = false;
let menuArtUrl: string | null = null;
const debug = new URLSearchParams(location.search).has('debug');
const requestedMatchSeedRaw = new URLSearchParams(location.search).get('matchSeed');
const requestedMatchSeed = requestedMatchSeedRaw !== null && /^\d+$/.test(requestedMatchSeedRaw)
  ? Number(requestedMatchSeedRaw) >>> 0
  : undefined;
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

type ArenaVariantId = 'world-cup-classic' | 'world-cup-showpiece' | 'world-cup-hybrid-25d' | 'world-cup-modern-ai';
interface ArenaVariant {
  id: ArenaVariantId;
  path: string;
  grass: ArenaGrassRect;
  liveStadium?: boolean;
  hybridDepth?: boolean;
}
const arenaVariants: Record<ArenaVariantId, ArenaVariant> = {
  'world-cup-classic': {
    id: 'world-cup-classic',
    path: 'art/arena/world-cup/world-cup-classic.webp',
    grass: { x: 390, y: 322, w: 2292, h: 1404 },
  },
  'world-cup-showpiece': {
    id: 'world-cup-showpiece',
    path: 'art/arena/world-cup/world-cup-showpiece.webp',
    grass: { x: 390, y: 322, w: 2292, h: 1404 },
    liveStadium: true,
  },
  'world-cup-hybrid-25d': {
    id: 'world-cup-hybrid-25d',
    // Deliberately reuse the calibrated Showpiece plate. The original arena
    // remains available unchanged while this separate route adds live 2.5D
    // construction on top of the same visual baseline.
    path: 'art/arena/world-cup/world-cup-showpiece.webp',
    grass: { x: 390, y: 322, w: 2292, h: 1404 },
    liveStadium: true,
    hybridDepth: true,
  },
  'world-cup-modern-ai': {
    id: 'world-cup-modern-ai',
    path: 'art/arena/world-cup/world-cup-modern-ai.webp',
    // Measured on the 1536x1024 AI source and doubled for runtime output.
    grass: { x: 612, y: 412, w: 1828, h: 1254 },
  },
};
const requestedArena = new URLSearchParams(location.search).get('arena') as ArenaVariantId | null;
const arenaVariant = requestedArena && arenaVariants[requestedArena]
  ? arenaVariants[requestedArena]
  : arenaVariants['world-cup-showpiece'];

// Arena plate: swap the gameplay world's base when the selected generated art is ready.
{
  const img = new Image();
  img.onload = () => renderer.setArenaImage(
    img,
    arenaVariant.grass,
    arenaVariant.liveStadium ?? false,
    arenaVariant.hybridDepth ?? false,
  );
  img.src = arenaVariant.path;
}

const sfxThrottle = new Map<string, number>();
function throttled(key: string, minMs: number): boolean {
  const now = performance.now();
  const last = sfxThrottle.get(key) ?? -1e9;
  if (now - last < minMs) return false;
  sfxThrottle.set(key, now);
  return true;
}

function requestPlayerDash(): boolean {
  if (appState !== 'run' || runState !== 'playing' || !sim) return false;
  const dx = debugMove?.[0] ?? input.ax;
  const dy = debugMove?.[1] ?? input.ay;
  return sim.requestDash(dx, dy);
}

function haptic(pattern: number | number[]): void {
  if (!save.data.haptics || typeof navigator.vibrate !== 'function') return;
  if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return;
  try {
    navigator.vibrate(pattern);
  } catch {
    // Vibration support is optional and must never affect gameplay.
  }
}

async function refreshLeaderboard(): Promise<void> {
  const result = await community.getLeaderboard();
  if (appState === 'menu') ui.renderLeaderboard(result.entries, result.online);
}

function showMainMenu(): void {
  ui.showMenu(menuArtUrl);
  void refreshLeaderboard();
}

/** Open one draft against the run-wide reroll budget. The simulation owns
 * the counter; rebuilding the overlay for queued levels or boss loot can
 * therefore never grant an accidental refill. */
function showUpgradeDraft(
  options: UpgradeOption[],
  roll: () => UpgradeOption[],
  mode: RewardMode = 'levelup',
  remainingPicks = 0,
): void {
  const draftSim = sim;
  if (!draftSim) return;
  ui.showLevelUp(
    options,
    () => {
      if (sim !== draftSim || !draftSim.consumeReroll()) return null;
      return { options: roll(), remaining: draftSim.rerollsRemaining };
    },
    mode,
    remainingPicks,
    draftSim.rerollsRemaining,
  );
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
    showMainMenu();
  },
  onResume() {
    if (appState !== 'run') return;
    if (runState === 'paused') {
      runState = 'playing';
      ui.hidePause();
      audio.startMusic();
    } else if (runState === 'playing') {
      runState = 'paused';
      ui.showPause();
    }
  },
  onDash() {
    requestPlayerDash();
  },
  onRestart() {
    startRun();
  },
  onQuitToMenu() {
    appState = 'menu';
    runState = 'playing';
    sim = null;
    audio.stopMusic();
    showMainMenu();
  },
  onUpgradePicked(opt: UpgradeOption) {
    if (!sim) return;
    sim.applyUpgrade(opt);
    if (rewardMode === 'boss') {
      sim.pendingBossAbilities = Math.max(0, sim.pendingBossAbilities - 1);
      if (sim.pendingBossAbilities > 0) {
        showUpgradeDraft(
          sim.rollBossAbilities(),
          () => sim!.rollBossAbilities(),
          'boss',
          sim.pendingBossAbilities,
        );
      } else if (sim.pendingLevelups > 0) {
        rewardMode = 'levelup';
        showUpgradeDraft(sim.rollUpgrades(), () => sim!.rollUpgrades());
      } else {
        runState = 'playing';
      }
      return;
    }
    sim.pendingLevelups = Math.max(0, sim.pendingLevelups - 1);
    if (sim.pendingLevelups > 0) {
      showUpgradeDraft(sim.rollUpgrades(), () => sim!.rollUpgrades());
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
    if (appState === 'menu') showMainMenu();
    if (runState === 'paused') {
      ui.hidePause();
      ui.showPause();
    }
  },
  onToggleReducedVfx() {
    save.data.reducedVfx = !save.data.reducedVfx;
    save.persist();
    renderer.setReducedVfx(effectiveReducedVfx());
    if (runState === 'paused') {
      ui.hidePause();
      ui.showPause();
    }
  },
  onToggleHaptics() {
    save.data.haptics = !save.data.haptics;
    save.persist();
    if (save.data.haptics) haptic(12);
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
  onLeaderboardName(name) {
    const normalized = normalizeLeaderboardName(name);
    save.data.leaderboardName = normalized;
    save.persist();
    void community.updateName(normalized).then(() => refreshLeaderboard());
  },
  onLeaderboardRefresh() {
    void refreshLeaderboard();
  },
  onVipAuthenticate(token) {
    void community.getVipAdminStats(token).then((result) => {
      if (result.status === 'ok') {
        ui.renderVipAdmin(result.data ?? null);
      } else if (result.status === 'unauthorized') {
        ui.renderVipAdmin(null, 'Invalid VIP token.');
      } else {
        ui.renderVipAdmin(null, 'VIP stats unavailable. Start the community server and configure FF_ADMIN_TOKEN.');
      }
    });
  },
},
save,
);

function startRun(): void {
  audio.unlock();
  audio.stopMusic();
  audio.startMusic();
  sim = new Sim(
    playerDef,
    save,
    requestedMatchSeed,
    arenaVariant.hybridDepth
      ? { playerX: 112, playerY: 68, enemyX: 80, enemyY: 52 }
      : undefined,
  );
  if (arenaVariant.hybridDepth) renderer.resetCamera(sim.player.x, sim.player.y);
  appState = 'run';
  runState = 'playing';
  rewardMode = 'levelup';
  overTimer = -1;
  resultShown = false;
  acc = 0;
  simulatedStepTime = 0;
  discardedStepTime = 0;
  ui.buildHud();
  ui.banner('Kick Off!');
}

function endRun(won: boolean): void {
  if (!sim || resultShown) return;
  resultShown = true;
  const r = sim.result(won);
  save.addCoins(r.coins + r.bonus);
  save.recordRun({ kills: r.kills, time: r.time, level: r.level, won });
  void community.submitRun({
    name: save.data.leaderboardName,
    playerId: playerDef.id,
    kills: r.kills,
    time: r.time,
    level: r.level,
    won,
  });
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
        haptic([20, 18, 32]);
        break;
      case 'magnet':
        audio.magnet();
        renderer.addShake(2.5);
        ui.banner('MAGNET SURGE');
        break;
      case 'bomb':
        audio.arenaBomb();
        renderer.playMatchdayWipeout();
        renderer.addShake(7);
        hitStop = Math.max(hitStop, 0.08);
        ui.banner(ev.defeated > 0 ? `MATCHDAY WIPEOUT · ${ev.defeated} DOWN` : 'MATCHDAY WIPEOUT');
        haptic([18, 12, 28]);
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
        haptic(12);
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
      case 'keeperBlock':
        renderer.playKeeperBlock(ev.x, ev.y, ev.counter);
        renderer.addShake(ev.counter ? 1.5 : 0.6);
        break;
      case 'scanImpact':
        renderer.playScanImpact(ev.x, ev.y);
        renderer.addShake(1.4);
        break;
      case 'upgradeFx':
        renderer.playAbilityUpgrade(ev.max);
        break;
      case 'bullCharge':
        if (throttled('bullCharge', 280)) audio.bullCharge();
        renderer.addShake(3.5);
        break;
      case 'bossStep': {
        const impact = ev.boss === 'captain' ? 3.5 : ev.boss === 'official' ? 2.1 : 1.35;
        renderer.addShake(impact);
        if (throttled(`bossStep-${ev.boss}`, 190)) audio.punch();
        break;
      }
      case 'dash':
        audio.dash();
        haptic(16);
        break;
      case 'hurt':
        audio.hurt();
        renderer.warnFlash();
        renderer.addShake(7);
        haptic([22, 18, 34]);
        break;
      case 'punch':
        if (throttled('punch', 120)) audio.punch();
        break;
      case 'bossSpawn':
        audio.bossHorn();
        audio.roar(1);
        renderer.addShake(5);
        haptic([30, 24, 46]);
        // The persistent top HUD carries the arrival. A former 64px banner
        // covered the player, boss and summon telegraphs while combat stayed
        // live; the simulation now supplies a short fair hostile pause.
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
    el.style.setProperty('--joy-angle', `${Math.atan2(dy, dx)}rad`);
    el.style.setProperty('--joy-strength', `${cl / max}`);
  }
});
function endJoy(e: PointerEvent): void {
  if (!joy.active || e.pointerId !== joy.id) return;
  joy.active = false;
  input.joyActive = false;
  input.joyX = 0;
  input.joyY = 0;
  const el = joyEl();
  if (el) {
    el.style.display = 'none';
    el.style.setProperty('--joy-strength', '0');
  }
}
window.addEventListener('pointerup', endJoy);
window.addEventListener('pointercancel', endJoy);

/* ---------------- keyboard shortcuts ---------------- */

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
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
let simulatedStepTime = 0;
let discardedStepTime = 0;

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
      if (input.justPressed(' ')) requestPlayerDash();
      if (hitStop > 0) {
        hitStop -= dt; // frozen sim, live renderer (shake/flash still animate)
      } else {
        const timing = consumeFixedSteps(acc, dt, STEP, 8);
        acc = timing.remainder;
        discardedStepTime += timing.discarded;
        simulatedStepTime += timing.steps * STEP;
        for (let steps = 0; steps < timing.steps; steps++) {
          sim.update(STEP, debugMove?.[0] ?? input.ax, debugMove?.[1] ?? input.ay);
        }
      }
      drainEvents();
      if (sim.pendingBossAbilities > 0 && runState === 'playing') {
        runState = 'levelup';
        rewardMode = 'boss';
        showUpgradeDraft(
          sim.rollBossAbilities(),
          () => sim!.rollBossAbilities(),
          'boss',
          sim.pendingBossAbilities,
        );
      } else if (sim.pendingLevelups > 0 && runState === 'playing') {
        runState = 'levelup';
        rewardMode = 'levelup';
        showUpgradeDraft(sim.rollUpgrades(), () => sim!.rollUpgrades());
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
    const bossScreen = arenaVariant.hybridDepth && sim.bossAlive
      ? renderer.getEnemyScreenRect(sim.bossAlive)
      : undefined;
    ui.updateHud(sim, bossScreen);
  }

  input.endFrame();
}

function onResize(): void {
  renderer.resize();
}
window.addEventListener('resize', onResize);
window.addEventListener('orientationchange', onResize);

// Never let a hidden browser tab keep advancing an active match. Resuming is
// explicit so returning from an interruption cannot cost the player health.
function pauseForPageLifecycle(): void {
  if (appState === 'run' && runState === 'playing') {
    runState = 'paused';
    ui.showPause();
  }
  audio.stopMusic();
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') pauseForPageLifecycle();
});
window.addEventListener('pagehide', pauseForPageLifecycle);
reducedMotionQuery?.addEventListener('change', () => renderer.setReducedVfx(effectiveReducedVfx()));

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
showMainMenu();
void community.registerVisit(save.data.leaderboardName).then(() => refreshLeaderboard());
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
  getTimingMetrics(): { simulatedTime: number; discardedTime: number; tempoRatio: number };
  getInputState(): { ax: number; ay: number; joyActive: boolean; joyX: number; joyY: number };
  getArenaRenderMode(): { liveStadium: boolean; hybridDepth: boolean };
  getReducedVfx(): boolean;
  getCameraState(): { x: number; y: number; lookX: number; lookY: number; viewWorldH: number };
  getPlayerOcclusionStrength(): number;
  getBossScreenRect(): EntityScreenRect | null;
  getCombatPresentationMetrics(): CombatPresentationMetrics;
  pickUpgrade(i: number): void;
  skipToBoss(n: 1 | 2): void;
  debugSpawn(id: string, dx: number, dy: number, elite?: boolean): void;
  debugDropPickup(kind: 'xp' | 'coin' | 'heal' | 'trophy' | 'magnet' | 'bomb' | 'freeze', dx: number, dy: number): void;
  showAbilityCards(ids: AbilityId[]): void;
  showTrainingCards(ids: Array<StatId | 'heal' | 'coins'>): void;
  fireWhistleFx(): void;
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
  getTimingMetrics: () => ({
    simulatedTime: simulatedStepTime,
    discardedTime: discardedStepTime,
    tempoRatio: simulatedStepTime + discardedStepTime > 0
      ? simulatedStepTime / (simulatedStepTime + discardedStepTime)
      : 1,
  }),
  getInputState: () => ({
    ax: input.ax,
    ay: input.ay,
    joyActive: input.joyActive,
    joyX: input.joyX,
    joyY: input.joyY,
  }),
  getArenaRenderMode: () => renderer.getArenaRenderMode(),
  getReducedVfx: () => renderer.getReducedVfx(),
  getCameraState: () => renderer.getCameraState(),
  getPlayerOcclusionStrength: () => renderer.getPlayerOcclusionStrength(),
  getBossScreenRect: () => sim?.bossAlive ? renderer.getEnemyScreenRect(sim.bossAlive) : null,
  getCombatPresentationMetrics: () => renderer.getCombatPresentationMetrics(),
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
      const level = Math.min((sim!.player.abilities[id] ?? 0) + 1, ABILITIES[id].levels.length);
      return sim!.makeAbilityUpgradeOption(id, level);
    });
    sim.pendingLevelups = 1;
    runState = 'levelup';
    showUpgradeDraft(options, () => options);
  },
  showTrainingCards: (ids: Array<StatId | 'heal' | 'coins'>) => {
    if (!sim) return;
    const options: UpgradeOption[] = ids.slice(0, 3).map((id) => {
      if (id === 'heal') return { kind: 'heal', id, name: 'Orange Slices', desc: 'Recover 30 HP right now.', color: '#80ed99', level: 0 };
      if (id === 'coins') return { kind: 'coins', id, name: 'Signing Bonus', desc: '+25 coins, straight into the club account.', color: '#ffd23f', level: 0 };
      return sim!.makeStatUpgradeOption(id);
    });
    sim.pendingLevelups = 1;
    runState = 'levelup';
    showUpgradeDraft(options, () => options);
  },
  fireWhistleFx: () => {
    if (!sim) return;
    sim.player.whistlePulse = -1;
    sim.player.whistleCd = 0;
  },
};
(window as unknown as { __FF: FfDebug }).__FF = ff;

// URL-addressable visual fixture for real-browser QA. It is excluded from
// normal play and keeps screenshots deterministic without changing balance.
const debugStage = debug ? new URLSearchParams(location.search).get('stage') : null;
if (debugStage === 'active-dash') {
  ff.startRun('neymar');
  const stagedSim = ff.getSim();
  if (stagedSim) {
    const params = new URLSearchParams(location.search);
    const phase = params.get('phase') ?? 'ready';
    stagedSim.debugDirectorPaused = true;
    stagedSim.player.abilities = { dash: 4 };
    stagedSim.player.dashCds = phase === 'cooldown' ? [2.4, 0.9] : [0, 0];
    stagedSim.player.dashDx = 1;
    stagedSim.player.dashDy = 0;
    stagedSim.player.visualDx = 1;
    stagedSim.player.visualDy = 0;
    stagedSim.player.visualDir = 0;
    stagedSim.player.dashWindupT = phase === 'windup' ? DASH_ANTICIPATION_DURATION * 0.48 : 0;
    stagedSim.player.dashT = phase === 'travel' ? 0.13 : 0;
    stagedSim.player.dashRecoveryT = phase === 'recovery' ? DASH_RECOVERY_DURATION * 0.62 : 0;
    stagedSim.player.moving = false;
    runState = 'paused';
    if (params.get('touch') === '1') {
      document.body.classList.add('touch');
      const stick = document.getElementById('joystick');
      const nub = stick?.querySelector<HTMLElement>('.nub');
      if (stick && nub) {
        stick.style.display = 'block';
        stick.style.left = '78px';
        stick.style.top = 'calc(100% - 194px)';
        stick.style.setProperty('--joy-angle', '-0.68rad');
        stick.style.setProperty('--joy-strength', '0.94');
        nub.style.transform = 'translate(calc(-50% + 38px), calc(-50% - 31px))';
      }
    }
    document.getElementById('banner')?.classList.remove('show');
  }
} else if (debugStage === 'kick-commitment') {
  ff.startRun('messi');
  const stagedSim = ff.getSim();
  if (stagedSim) {
    const phase = new URLSearchParams(location.search).get('phase') ?? 'anticipation';
    stagedSim.debugDirectorPaused = true;
    stagedSim.player.abilities = { strike: 1 };
    stagedSim.player.maxHp = stagedSim.player.hp = 9999;
    stagedSim.debugSpawn('steward', stagedSim.player.x + 345, stagedSim.player.y + 110);
    const target = stagedSim.enemies.find((enemy) => enemy.active && enemy.def.id === 'steward');
    if (target) {
      target.speed = 0;
      target.damage = 0;
      target.stun = 9999;
      target.maxHp = target.hp = target.barHp = 999999;
      const dx = target.x - stagedSim.player.x;
      const dy = target.y - stagedSim.player.y;
      const distance = Math.hypot(dx, dy) || 1;
      stagedSim.player.kickTargetIdx = stagedSim.enemies.indexOf(target);
      stagedSim.player.aimDx = dx / distance;
      stagedSim.player.aimDy = dy / distance;
      stagedSim.player.face = dx >= 0 ? 1 : -1;
      stagedSim.player.kickT = phase === 'contact'
        ? KICK_DURATION - KICK_CONTACT_DELAY - 0.015
        : phase === 'recovery' ? 0.055 : KICK_DURATION - 0.055;
      const marker = stagedSim.reticles[0];
      marker.active = true;
      marker.x = target.x;
      marker.y = target.y;
      marker.t = stagedSim.player.kickT;
      marker.max = KICK_DURATION;
      marker.targetIdx = stagedSim.player.kickTargetIdx;
      marker.phase = 'aim';
      if (phase === 'contact') {
        const contact = stagedSim.impacts.find((impact) => !impact.active);
        if (contact) {
          contact.active = true;
          contact.x = stagedSim.player.x + stagedSim.player.aimDx * 40;
          contact.y = stagedSim.player.y + stagedSim.player.aimDy * 40;
          contact.angle = Math.atan2(stagedSim.player.aimDy, stagedSim.player.aimDx);
          contact.strength = 1.08;
          contact.color = '#b6e36b';
          contact.kind = 'kickground';
          // Hold the continuous dust envelope near its quiet visibility peak
          // while the fixture stays paused for gameplay-scale visual review.
          contact.maxLife = 0.42;
          contact.life = 0.32;
        }
      }
    }
    runState = 'paused';
    document.getElementById('banner')?.classList.remove('show');
  }
} else if (debugStage === 'melee-contact') {
  ff.startRun('messi');
  const stagedSim = ff.getSim();
  if (stagedSim) {
    const params = new URLSearchParams(location.search);
    const bossFixture = params.get('actor') === 'captain';
    const phase = params.get('phase') === 'contact' || params.get('phase') === 'recovery'
      ? params.get('phase')!
      : 'anticipation';
    stagedSim.player.abilities = {};
    stagedSim.player.maxHp = 9999;
    stagedSim.player.hp = 9999;
    stagedSim.player.xpNext = 999_999;
    stagedSim.debugDirectorPaused = true;
    let attacker: Sim['enemies'][number] | null | undefined;
    if (bossFixture) {
      stagedSim.boss0Spawned = true;
      stagedSim.boss1Spawned = true;
      stagedSim.boss2Spawned = true;
      stagedSim.debugSpawnBoss('captain');
      stagedSim.bossIntroT = 0;
      stagedSim.player.iframes = 0;
      attacker = stagedSim.bossAlive;
    } else {
      stagedSim.debugSpawn('invader', stagedSim.player.x + 90, stagedSim.player.y);
      attacker = stagedSim.enemies.find((enemy) => enemy.active && enemy.def.id === 'invader');
    }
    if (attacker) {
      const lungeDuration = bossFixture ? BOSS_MELEE_LUNGE_DURATION : ENEMY_MELEE_LUNGE_DURATION;
      attacker.x = stagedSim.player.x + (bossFixture ? phase === 'anticipation' ? 170 : 145 : phase === 'anticipation' ? 90 : 48);
      attacker.y = stagedSim.player.y + (bossFixture ? 42 : 0);
      attacker.damage = 0;
      attacker.maxHp = attacker.hp = attacker.barHp = 9999;
      attacker.meleeDx = -1;
      attacker.meleeDy = 0;
      attacker.face = -1;
      attacker.meleeHit = phase !== 'anticipation';
      attacker.windup = phase === 'anticipation' ? 0.08 : 0;
      attacker.lungeT = phase === 'contact' ? lungeDuration * 0.38 : 0;
      attacker.attackAnimT = phase === 'contact'
        ? lungeDuration + MELEE_RECOVERY_DURATION
        : phase === 'recovery' ? MELEE_RECOVERY_DURATION * 0.58 : 0;
      attacker.attackCd = 999;
      attacker.bossCd = attacker.bossCd2 = attacker.rangedCd = 999;
      if (phase === 'contact') {
        stagedSim.player.hurtT = 0.25;
        stagedSim.player.hurtDx = -1;
        stagedSim.player.hurtDy = 0;
      }
    }
    stagedSim.debugHostileHold = true;
    stagedSim.events.length = 0;
    document.getElementById('banner')?.classList.remove('show');
  }
} else if (debugStage === 'damage') {
  ff.startRun('messi');
  const stagedSim = ff.getSim();
  if (stagedSim) {
    stagedSim.debugDirectorPaused = true;
    stagedSim.player.abilities = {};
    stagedSim.player.maxHp = 9999;
    stagedSim.player.hp = 9999;
    stagedSim.debugSpawn('steward', stagedSim.player.x + 54, stagedSim.player.y);
  }
} else if (debugStage === 'death-vfx') {
  ff.startRun('messi');
  const stagedSim = ff.getSim();
  if (stagedSim) {
    stagedSim.debugDirectorPaused = true;
    stagedSim.player.abilities = {};
    stagedSim.player.maxHp = 9999;
    stagedSim.player.hp = 9999;
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
} else if (debugStage === 'blast-vfx') {
  ff.startRun('messi');
  const stagedSim = ff.getSim();
  if (stagedSim) {
    stagedSim.debugDirectorPaused = true;
    stagedSim.player.maxHp = 9_999;
    stagedSim.player.hp = 9_999;
    stagedSim.player.xp = 0;
    stagedSim.player.xpNext = 999_999;
    stagedSim.player.abilities = { blast: 5 };
    stagedSim.debugSpawn('steward', stagedSim.player.x + 132, stagedSim.player.y + 18);
    stagedSim.debugSpawn('drone', stagedSim.player.x + 88, stagedSim.player.y - 24);
    for (const enemy of stagedSim.enemies) {
      if (!enemy.active) continue;
      enemy.damage = 0;
      enemy.speed = 0;
      enemy.hp = enemy.maxHp = enemy.barHp = 99_999;
      enemy.attackCd = 999;
      enemy.rangedCd = 999;
    }
    // Give the two generated atlases time to decode before the deterministic
    // review pulse; normal gameplay has already primed them at boot.
    stagedSim.player.blastCd = 0.75;
    document.getElementById('banner')?.classList.remove('show');
  }
} else if (debugStage === 'combat-readability') {
  ff.startRun('messi');
  const stagedSim = ff.getSim();
  if (stagedSim) {
    const requestedCount = Number(new URLSearchParams(location.search).get('count') ?? 80);
    const count = Math.max(50, Math.min(120, Number.isFinite(requestedCount) ? Math.floor(requestedCount) : 80));
    stagedSim.debugDirectorPaused = true;
    stagedSim.time = 570;
    stagedSim.boss0Spawned = true;
    stagedSim.boss1Spawned = true;
    stagedSim.boss2Spawned = true;
    stagedSim.player.maxHp = 99_999;
    stagedSim.player.hp = 99_999;
    stagedSim.player.iframes = 0;
    stagedSim.player.xp = 0;
    stagedSim.player.xpNext = 999_999;
    stagedSim.player.abilities = {
      strike: 5,
      curveball: 5,
      bootseekers: 5,
      orbit: 5,
      whistle: 5,
      pressure: 5,
      blast: 5,
    };
    const ids = ['invader', 'sprinter', 'lobber', 'flag', 'steward', 'drummer', 'vuvuzela', 'mascot', 'paparazzo', 'bull', 'drone'] as const;
    const goldenAngle = Math.PI * (3 - Math.sqrt(5));
    for (let index = 0; index < count; index++) {
      const angle = index * goldenAngle;
      const radius = 145 + (index % 8) * 68;
      stagedSim.debugSpawn(
        ids[index % ids.length],
        stagedSim.player.x + Math.cos(angle) * radius,
        stagedSim.player.y + Math.sin(angle) * radius,
      );
      const enemy = [...stagedSim.enemies].reverse().find((entry) => entry.active && entry.maxHp < 900_000);
      if (!enemy) continue;
      enemy.damage = 0;
      enemy.speed = 0;
      enemy.hp = enemy.maxHp = enemy.barHp = 999_999;
      enemy.attackCd = 999;
      enemy.rangedCd = 999;
      enemy.windup = 0;
      enemy.telegraph = 0;
    }
    stagedSim.telegraphs.push({
      active: true,
      x: stagedSim.player.x + 195,
      y: stagedSim.player.y + 30,
      r: 132,
      t: 10,
      max: 10,
      kind: 'shock',
      dmg: 32,
      dir: 0,
      summon: 0,
      summonIndex: -1,
    });
    stagedSim.telegraphs.push({
      active: true,
      x: stagedSim.player.x - 205,
      y: stagedSim.player.y - 70,
      r: 260,
      t: 10,
      max: 10,
      kind: 'cone',
      dmg: 18,
      dir: 0.15,
      summon: 0,
      summonIndex: -1,
    });
    stagedSim.events.length = 0;
    document.getElementById('banner')?.classList.remove('show');
  }
} else if (debugStage === 'whistle-vfx') {
  ff.startRun('ronaldo');
  const stagedSim = ff.getSim();
  if (stagedSim) {
    const reviewProgress = Number(new URLSearchParams(location.search).get('progress'));
    const lockedReview = Number.isFinite(reviewProgress) && reviewProgress >= 0 && reviewProgress <= 1;
    stagedSim.debugDirectorPaused = true;
    stagedSim.player.maxHp = 9_999;
    stagedSim.player.hp = 9_999;
    stagedSim.player.xp = 0;
    stagedSim.player.xpNext = 999_999;
    stagedSim.player.abilities = { whistle: 5 };
    // Fire one review pulse only after the generated strip has decoded.
    stagedSim.player.whistleCd = 999;
    stagedSim.player.whistlePulse = -1;
    stagedSim.debugSpawn('invader', stagedSim.player.x + 185, stagedSim.player.y + 20);
    stagedSim.debugSpawn('steward', stagedSim.player.x - 165, stagedSim.player.y - 55);
    stagedSim.debugSpawn('sprinter', stagedSim.player.x + 45, stagedSim.player.y + 155);
    for (const enemy of stagedSim.enemies) {
      if (!enemy.active) continue;
      enemy.damage = 0;
      enemy.speed = 0;
      enemy.maxHp = enemy.hp = enemy.barHp = 99_999;
      enemy.attackCd = 999;
      enemy.rangedCd = 999;
    }
    stagedSim.events.length = 0;
    document.getElementById('banner')?.classList.remove('show');
    window.setTimeout(() => {
      if (lockedReview) {
        const ring = stagedSim.rings.find((entry) => !entry.active);
        if (ring) {
          ring.active = true;
          ring.x = stagedSim.player.x;
          ring.y = stagedSim.player.y;
          ring.r = 245 * (0.2 + reviewProgress * 0.8);
          ring.maxR = 245;
          ring.life = Math.max(0.001, (1 - reviewProgress) * 0.45);
          ring.color = '#f5f7fa';
        }
        runState = 'paused';
        return;
      }
      stagedSim.player.whistleCd = 0;
      window.setTimeout(() => {
        stagedSim.player.whistleCd = 999;
        stagedSim.player.whistlePulse = -1;
      }, 90);
    }, 650);
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
} else if (debugStage === 'aerial-defence') {
  ff.startRun('messi');
  const stagedSim = ff.getSim();
  if (stagedSim) {
    stagedSim.debugDirectorPaused = true;
    stagedSim.player.abilities = { keeperhalo: 5 };
    stagedSim.player.maxHp = 99_999;
    stagedSim.player.hp = 99_999;
    stagedSim.player.xpNext = 99_999;
    stagedSim.debugSpawn('drone', stagedSim.player.x - 300, stagedSim.player.y - 95);
    stagedSim.debugSpawn('varcam', stagedSim.player.x + 340, stagedSim.player.y - 70);
    for (const enemy of stagedSim.enemies) {
      if (!enemy.active) continue;
      enemy.hp = enemy.maxHp = enemy.barHp = 99_999;
      enemy.speed = 0;
      enemy.rangedCd = enemy.def.id === 'varcam' ? 0.55 : 0.25;
    }
    document.getElementById('banner')?.classList.remove('show');
  }
} else if (debugStage === 'upgrade-vfx') {
  ff.startRun('messi');
  const stagedSim = ff.getSim();
  if (stagedSim) {
    stagedSim.debugDirectorPaused = true;
    stagedSim.player.abilities = {};
    stagedSim.player.maxHp = 99_999;
    stagedSim.player.hp = 99_999;
    stagedSim.player.xpNext = 99_999;
    // Leave enough time for the generated strip to decode on a cold mobile
    // load before the isolated proof scene starts its one-shot animation.
    window.setTimeout(() => renderer.playAbilityUpgrade(true), 1_800);
    document.getElementById('banner')?.classList.remove('show');
  }
} else if (debugStage === 'enemy-attacks') {
  ff.startRun('messi');
  const stagedSim = ff.getSim();
  if (stagedSim) {
    stagedSim.debugDirectorPaused = true;
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
        const dxToPlayer = stagedSim.player.x - enemy.x;
        const dyToPlayer = stagedSim.player.y - enemy.y;
        const d = Math.hypot(dxToPlayer, dyToPlayer) || 1;
        enemy.meleeDx = dxToPlayer / d;
        enemy.meleeDy = dyToPlayer / d;
        enemy.meleeHit = false;
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
} else if (debugStage === 'boss-intro') {
  ff.startRun('messi');
  const stagedSim = ff.getSim();
  if (stagedSim) {
    const params = new URLSearchParams(location.search);
    const requestedBoss = params.get('boss');
    const bossId = requestedBoss === 'drumboss' || requestedBoss === 'official' || requestedBoss === 'captain'
      ? requestedBoss
      : 'official';
    const phase = Math.min(0.92, Math.max(0.08, Number(params.get('phase') ?? 0.46)));
    stagedSim.player.abilities = {};
    stagedSim.player.maxHp = 99_999;
    stagedSim.player.hp = 99_999;
    stagedSim.player.xpNext = 999_999;
    stagedSim.debugDirectorPaused = true;
    stagedSim.boss0Spawned = true;
    stagedSim.boss1Spawned = true;
    stagedSim.boss2Spawned = true;
    stagedSim.debugSpawnBoss(bossId);
    const boss = stagedSim.enemies.find((enemy) => enemy.active && enemy.boss === bossId);
    if (boss) {
      boss.x = stagedSim.player.x + 350;
      boss.y = stagedSim.player.y + 72;
      boss.damage = 0;
      boss.bossCd = 999;
      boss.bossCd2 = 999;
      boss.rangedCd = 999;
    }
    stagedSim.bossIntroT = BOSS_INTRO_DURATION * (1 - phase);
    stagedSim.debugBossIntroHold = true;
    document.getElementById('banner')?.classList.remove('show');
  }
} else if (debugStage === 'full-time-boss') {
  ff.startRun('messi');
  const stagedSim = ff.getSim();
  if (stagedSim) {
    stagedSim.player.abilities = {};
    stagedSim.player.maxHp = 99_999;
    stagedSim.player.hp = 99_999;
    stagedSim.player.xpNext = 999_999;
    stagedSim.debugDirectorPaused = true;
    stagedSim.boss0Spawned = true;
    stagedSim.boss1Spawned = true;
    stagedSim.boss2Spawned = true;
    stagedSim.debugSpawnBoss('captain');
    stagedSim.bossIntroT = 0;
    stagedSim.player.iframes = 0;
    stagedSim.time = RUN_LENGTH;
    const boss = stagedSim.enemies.find((enemy) => enemy.active && enemy.boss === 'captain');
    if (boss) {
      boss.x = stagedSim.player.x + 360;
      boss.y = stagedSim.player.y + 64;
      boss.damage = 0;
      boss.stun = 999;
      boss.bossCd = 999;
      boss.bossCd2 = 999;
      boss.rangedCd = 999;
    }
    stagedSim.events.length = 0;
    document.getElementById('banner')?.classList.remove('show');
  }
} else if (debugStage === 'boss-summon') {
  ff.startRun('messi');
  const stagedSim = ff.getSim();
  if (stagedSim) {
    stagedSim.player.abilities = {};
    stagedSim.player.maxHp = 9999;
    stagedSim.player.hp = 9999;
    stagedSim.debugDirectorPaused = true;
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
    stagedSim.bossIntroT = 0;
    stagedSim.player.iframes = 0;
    stagedSim.debugTelegraphHold = true;
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
    stagedSim.debugDirectorPaused = true;
    stagedSim.boss0Spawned = true;
    stagedSim.boss1Spawned = true;
    stagedSim.boss2Spawned = true;
    stagedSim.events.length = 0;
    document.getElementById('banner')?.classList.remove('show');
  }
} else if (debugStage === 'arena-preview') {
  ff.startRun('messi');
  const stagedSim = ff.getSim();
  if (stagedSim) {
    stagedSim.player.abilities = {};
    stagedSim.player.maxHp = 99_999;
    stagedSim.player.hp = 99_999;
    stagedSim.player.xpNext = 999_999;
    stagedSim.events.length = 0;
    document.getElementById('banner')?.classList.remove('show');
  }
} else if (debugStage === 'hybrid-edge-preview') {
  ff.startRun('messi');
  const stagedSim = ff.getSim();
  if (stagedSim) {
    stagedSim.player.abilities = {};
    stagedSim.player.maxHp = 99_999;
    stagedSim.player.hp = 99_999;
    stagedSim.player.xpNext = 999_999;
    stagedSim.player.x = ARENA_W / 2;
    stagedSim.player.y = ARENA_H - 32;
    stagedSim.boss0Spawned = true;
    stagedSim.boss1Spawned = true;
    stagedSim.boss2Spawned = true;
    stagedSim.events.length = 0;
    document.getElementById('banner')?.classList.remove('show');
  }
} else if (debugStage === 'hybrid-near-grounding') {
  ff.startRun('messi');
  const stagedSim = ff.getSim();
  if (stagedSim) {
    stagedSim.player.abilities = {};
    stagedSim.player.maxHp = 99_999;
    stagedSim.player.hp = 99_999;
    stagedSim.player.xpNext = 999_999;
    stagedSim.player.x = ARENA_W / 2;
    stagedSim.player.y = ARENA_H - 280;
    stagedSim.boss0Spawned = true;
    stagedSim.boss1Spawned = true;
    stagedSim.boss2Spawned = true;
    for (const [kind, offsetX] of [['trophy', -118], ['magnet', 0], ['bomb', 118]] as const) {
      stagedSim.debugDropPickup(kind, ARENA_W / 2 + offsetX, ARENA_H - 72);
    }
    for (const pickup of stagedSim.pickups) {
      if (!pickup.active) continue;
      pickup.vx = 0;
      pickup.vy = 0;
      // Keep this alpha/grounding proof scene stationary. Production rescue
      // pickups still begin their intentional long-range seek after 0.8s.
      pickup.t = -3_600;
    }
    stagedSim.events.length = 0;
    document.getElementById('banner')?.classList.remove('show');
  }
} else if (debugStage === 'hybrid-pickup-grounding') {
  ff.startRun('messi');
  const stagedSim = ff.getSim();
  if (stagedSim) {
    stagedSim.player.abilities = {};
    stagedSim.player.maxHp = 99_999;
    stagedSim.player.hp = 99_999;
    stagedSim.player.xpNext = 999_999;
    stagedSim.player.x = ARENA_W / 2;
    stagedSim.player.y = ARENA_H - 250;
    stagedSim.boss0Spawned = true;
    stagedSim.boss1Spawned = true;
    stagedSim.boss2Spawned = true;
    const pickupKinds = ['xp', 'coin', 'heal', 'trophy', 'magnet', 'bomb', 'freeze'] as const;
    for (let index = 0; index < pickupKinds.length; index++) {
      stagedSim.debugDropPickup(
        pickupKinds[index],
        ARENA_W / 2 - 270 + index * 90,
        ARENA_H - 72,
      );
    }
    for (const pickup of stagedSim.pickups) {
      if (!pickup.active) continue;
      pickup.vx = 0;
      pickup.vy = 0;
      // Every family eventually migrates in production (XP at 0.6s and rescue
      // tools at 0.8s). This visual fixture must remain a frozen alpha-bound
      // comparison even on a cold browser where image decoding takes longer.
      pickup.t = -3_600;
    }
    stagedSim.events.length = 0;
    document.getElementById('banner')?.classList.remove('show');
  }
} else if (debugStage === 'hybrid-far-edge-preview') {
  ff.startRun('messi');
  const stagedSim = ff.getSim();
  if (stagedSim) {
    stagedSim.player.abilities = {};
    stagedSim.player.maxHp = 99_999;
    stagedSim.player.hp = 99_999;
    stagedSim.player.xpNext = 999_999;
    stagedSim.player.x = ARENA_W / 2;
    stagedSim.player.y = 32;
    stagedSim.boss0Spawned = true;
    stagedSim.boss1Spawned = true;
    stagedSim.boss2Spawned = true;
    stagedSim.events.length = 0;
    document.getElementById('banner')?.classList.remove('show');
  }
} else if (debugStage === 'hybrid-board-crowd') {
  ff.startRun('messi');
  const stagedSim = ff.getSim();
  if (stagedSim) {
    stagedSim.player.abilities = {};
    stagedSim.player.maxHp = 99_999;
    stagedSim.player.hp = 99_999;
    stagedSim.player.xpNext = 999_999;
    stagedSim.player.x = ARENA_W / 2;
    stagedSim.player.y = 74;
    stagedSim.boss0Spawned = true;
    stagedSim.boss1Spawned = true;
    stagedSim.boss2Spawned = true;
    const ids = ['invader', 'sprinter', 'steward', 'flare', 'flag', 'lobber', 'bull', 'drone'] as const;
    for (let index = 0; index < 20; index++) {
      const column = index % 10;
      const row = Math.floor(index / 10);
      stagedSim.debugSpawn(
        ids[index % ids.length],
        ARENA_W / 2 - 405 + column * 90,
        118 + row * 122 + (column % 2) * 18,
        index === 6 || index === 15,
      );
      const enemy = [...stagedSim.enemies].reverse().find((candidate) => candidate.active);
      if (!enemy) continue;
      enemy.damage = 0;
      enemy.speed = 0;
      enemy.attackCd = 999;
      enemy.rangedCd = 999;
      enemy.bossCd = 999;
      enemy.bossCd2 = 999;
      enemy.windup = 0;
      enemy.lungeT = 0;
      enemy.casting = '';
      if (index % 4 === 0) {
        enemy.hp *= 0.58;
        enemy.barHp = enemy.maxHp;
      }
    }
    stagedSim.events.length = 0;
    document.getElementById('banner')?.classList.remove('show');
  }
} else if (debugStage === 'hybrid-board-corner') {
  ff.startRun('messi');
  const stagedSim = ff.getSim();
  if (stagedSim) {
    const side = new URLSearchParams(location.search).get('side') === 'right' ? 'right' : 'left';
    stagedSim.player.abilities = {};
    stagedSim.player.maxHp = 99_999;
    stagedSim.player.hp = 99_999;
    stagedSim.player.xpNext = 999_999;
    stagedSim.player.x = side === 'left' ? 72 : ARENA_W - 72;
    stagedSim.player.y = 118;
    stagedSim.boss0Spawned = true;
    stagedSim.boss1Spawned = true;
    stagedSim.boss2Spawned = true;
    stagedSim.events.length = 0;
    document.getElementById('banner')?.classList.remove('show');
  }
} else if (debugStage === 'hybrid-corner-flag') {
  ff.startRun('messi');
  const stagedSim = ff.getSim();
  if (stagedSim) {
    const params = new URLSearchParams(location.search);
    const side = params.get('side') === 'left' ? 'left' : 'right';
    const edge = params.get('edge') === 'near' ? 'near' : 'far';
    stagedSim.player.abilities = {};
    stagedSim.player.maxHp = 99_999;
    stagedSim.player.hp = 99_999;
    stagedSim.player.xpNext = 999_999;
    stagedSim.player.x = side === 'left' ? 150 : ARENA_W - 150;
    stagedSim.player.y = edge === 'near' ? ARENA_H - 150 : 150;
    stagedSim.boss0Spawned = true;
    stagedSim.boss1Spawned = true;
    stagedSim.boss2Spawned = true;
    stagedSim.events.length = 0;
    document.getElementById('banner')?.classList.remove('show');
  }
} else if (debugStage === 'hybrid-technical-preview') {
  ff.startRun('messi');
  const stagedSim = ff.getSim();
  if (stagedSim) {
    stagedSim.player.abilities = {};
    stagedSim.player.maxHp = 99_999;
    stagedSim.player.hp = 99_999;
    stagedSim.player.xpNext = 999_999;
    stagedSim.player.x = ARENA_W / 2;
    stagedSim.player.y = 360;
    stagedSim.boss0Spawned = true;
    stagedSim.boss1Spawned = true;
    stagedSim.boss2Spawned = true;
    stagedSim.events.length = 0;
    document.getElementById('banner')?.classList.remove('show');
  }
} else if (debugStage === 'hybrid-centre-markings') {
  ff.startRun('messi');
  const stagedSim = ff.getSim();
  if (stagedSim) {
    stagedSim.player.abilities = {};
    stagedSim.player.maxHp = 99_999;
    stagedSim.player.hp = 99_999;
    stagedSim.player.xpNext = 999_999;
    stagedSim.player.x = ARENA_W / 2;
    stagedSim.player.y = ARENA_H / 2 + 126;
    stagedSim.boss0Spawned = true;
    stagedSim.boss1Spawned = true;
    stagedSim.boss2Spawned = true;
    stagedSim.events.length = 0;
    document.getElementById('banner')?.classList.remove('show');
  }
} else if (debugStage === 'hybrid-markings-preview') {
  ff.startRun('messi');
  const stagedSim = ff.getSim();
  if (stagedSim) {
    const side = new URLSearchParams(location.search).get('side') === 'left' ? 'left' : 'right';
    stagedSim.player.abilities = {};
    stagedSim.player.maxHp = 99_999;
    stagedSim.player.hp = 99_999;
    stagedSim.player.xpNext = 999_999;
    stagedSim.player.x = side === 'left' ? 520 : ARENA_W - 520;
    stagedSim.player.y = ARENA_H / 2;
    stagedSim.boss0Spawned = true;
    stagedSim.boss1Spawned = true;
    stagedSim.boss2Spawned = true;
    stagedSim.events.length = 0;
    document.getElementById('banner')?.classList.remove('show');
  }
} else if (debugStage === 'hybrid-markings-combat') {
  ff.startRun('messi');
  const stagedSim = ff.getSim();
  if (stagedSim) {
    stagedSim.player.abilities = { strike: 4, orbit: 4, whistle: 3, curveball: 3 };
    stagedSim.player.maxHp = 99_999;
    stagedSim.player.hp = 99_999;
    stagedSim.player.xpNext = 999_999;
    stagedSim.player.x = ARENA_W - 650;
    stagedSim.player.y = ARENA_H / 2;
    stagedSim.boss0Spawned = true;
    stagedSim.boss1Spawned = true;
    stagedSim.boss2Spawned = true;
    const ids = ['invader', 'sprinter', 'steward', 'flare', 'flag', 'lobber', 'bull', 'drone'] as const;
    for (let index = 0; index < 24; index++) {
      const column = index % 6;
      const row = Math.floor(index / 6);
      stagedSim.debugSpawn(
        ids[index % ids.length],
        ARENA_W - 530 + column * 62,
        ARENA_H / 2 - 300 + row * 188 + (column % 2) * 24,
        index === 10 || index === 19,
      );
      const enemy = [...stagedSim.enemies].reverse().find((candidate) => candidate.active);
      if (!enemy) continue;
      enemy.damage = 0;
      enemy.speed = 0;
      enemy.attackCd = 999;
      enemy.rangedCd = 999;
      enemy.bossCd = 999;
      enemy.bossCd2 = 999;
      enemy.windup = 0;
      enemy.lungeT = 0;
      enemy.casting = '';
      enemy.maxHp = 12_000;
      enemy.hp = enemy.maxHp * (index % 5 === 0 ? 0.44 : index % 3 === 0 ? 0.72 : 1);
      enemy.barHp = enemy.maxHp;
    }
    stagedSim.events.length = 0;
    document.getElementById('banner')?.classList.remove('show');
  }
} else if (debugStage === 'hybrid-goal-crowd') {
  ff.startRun('messi');
  const stagedSim = ff.getSim();
  if (stagedSim) {
    stagedSim.player.abilities = {};
    stagedSim.player.maxHp = 99_999;
    stagedSim.player.hp = 99_999;
    stagedSim.player.xpNext = 999_999;
    stagedSim.player.x = ARENA_W - 118;
    stagedSim.player.y = ARENA_H / 2;
    stagedSim.boss0Spawned = true;
    stagedSim.boss1Spawned = true;
    stagedSim.boss2Spawned = true;
    const ids = ['invader', 'steward', 'sprinter', 'flare', 'flag', 'lobber'] as const;
    for (let index = 0; index < 18; index++) {
      const column = index % 6;
      const row = Math.floor(index / 6);
      stagedSim.debugSpawn(
        ids[index % ids.length],
        ARENA_W - 250 + column * 28,
        ARENA_H / 2 - 112 + row * 112 + (column % 2) * 16,
        index === 8,
      );
      const enemy = [...stagedSim.enemies].reverse().find((candidate) => candidate.active);
      if (!enemy) continue;
      enemy.damage = 0;
      enemy.speed = 0;
      enemy.attackCd = 999;
      enemy.rangedCd = 999;
      enemy.bossCd = 999;
      enemy.bossCd2 = 999;
      enemy.windup = 0;
      enemy.lungeT = 0;
      enemy.casting = '';
      if (index % 4 === 0) {
        enemy.hp *= 0.62;
        enemy.barHp = enemy.maxHp;
      }
    }
    stagedSim.events.length = 0;
    document.getElementById('banner')?.classList.remove('show');
  }
} else if (debugStage === 'hybrid-left-goal') {
  ff.startRun('messi');
  const stagedSim = ff.getSim();
  if (stagedSim) {
    stagedSim.player.abilities = {};
    stagedSim.player.maxHp = 99_999;
    stagedSim.player.hp = 99_999;
    stagedSim.player.xpNext = 999_999;
    stagedSim.player.x = 118;
    stagedSim.player.y = ARENA_H / 2;
    stagedSim.boss0Spawned = true;
    stagedSim.boss1Spawned = true;
    stagedSim.boss2Spawned = true;
    stagedSim.events.length = 0;
    document.getElementById('banner')?.classList.remove('show');
  }
} else if (debugStage === 'hybrid-boss-edge') {
  ff.startRun('messi');
  const stagedSim = ff.getSim();
  if (stagedSim) {
    const params = new URLSearchParams(location.search);
    const requestedBoss = params.get('boss');
    const bossId = requestedBoss === 'drumboss' || requestedBoss === 'official' || requestedBoss === 'captain'
      ? requestedBoss
      : 'captain';
    const side = params.get('side') === 'right' ? 'right' : 'left';
    stagedSim.player.abilities = {};
    stagedSim.player.maxHp = 99_999;
    stagedSim.player.hp = 99_999;
    stagedSim.player.xpNext = 999_999;
    stagedSim.player.x = side === 'left' ? 330 : ARENA_W - 330;
    stagedSim.player.y = ARENA_H / 2;
    stagedSim.boss0Spawned = true;
    stagedSim.boss1Spawned = true;
    stagedSim.boss2Spawned = true;
    stagedSim.debugSpawnBoss(bossId);
    stagedSim.bossIntroT = 0;
    const boss = stagedSim.enemies.find((enemy) => enemy.active && enemy.boss === bossId);
    if (boss) {
      boss.x = side === 'left' ? 0 : ARENA_W;
      boss.y = ARENA_H / 2;
      boss.damage = 0;
      boss.hp = boss.maxHp = boss.barHp = 999_999;
      boss.stun = 999;
      boss.bossCd = 999;
      boss.bossCd2 = 999;
      boss.rangedCd = 999;
    }
    stagedSim.events.length = 0;
    document.getElementById('banner')?.classList.remove('show');
  }
} else if (debugStage === 'hybrid-drone-edge') {
  ff.startRun('messi');
  const stagedSim = ff.getSim();
  if (stagedSim) {
    const side = new URLSearchParams(location.search).get('side') === 'right' ? 'right' : 'left';
    stagedSim.player.abilities = {};
    stagedSim.player.maxHp = 99_999;
    stagedSim.player.hp = 99_999;
    stagedSim.player.xpNext = 999_999;
    stagedSim.player.x = side === 'left' ? 330 : ARENA_W - 330;
    stagedSim.player.y = ARENA_H / 2;
    stagedSim.boss0Spawned = true;
    stagedSim.boss1Spawned = true;
    stagedSim.boss2Spawned = true;
    stagedSim.debugSpawn('drone', side === 'left' ? 0 : ARENA_W, ARENA_H / 2);
    const drone = stagedSim.enemies.find((enemy) => enemy.active && enemy.def.id === 'drone');
    if (drone) {
      drone.damage = 0;
      drone.hp = drone.maxHp = drone.barHp = 99_999;
      drone.stun = 999;
      drone.rangedCd = 999;
    }
    stagedSim.events.length = 0;
    document.getElementById('banner')?.classList.remove('show');
  }
} else if (debugStage === 'hybrid-touchline-entity') {
  ff.startRun('messi');
  const stagedSim = ff.getSim();
  if (stagedSim) {
    const params = new URLSearchParams(location.search);
    const entityId = params.get('entity') ?? 'captain';
    const edge = params.get('edge') === 'near' ? 'near' : 'far';
    stagedSim.player.abilities = {};
    stagedSim.player.maxHp = 99_999;
    stagedSim.player.hp = 99_999;
    stagedSim.player.xpNext = 999_999;
    stagedSim.player.x = ARENA_W / 2 + 330;
    stagedSim.player.y = edge === 'far' ? 330 : ARENA_H - 330;
    stagedSim.boss0Spawned = true;
    stagedSim.boss1Spawned = true;
    stagedSim.boss2Spawned = true;
    if (entityId === 'drone') {
      stagedSim.debugSpawn('drone', ARENA_W / 2, edge === 'far' ? 0 : ARENA_H);
    } else {
      const bossId = entityId === 'drumboss' || entityId === 'official' ? entityId : 'captain';
      stagedSim.debugSpawnBoss(bossId);
      stagedSim.bossIntroT = 0;
      const boss = stagedSim.enemies.find((enemy) => enemy.active && enemy.boss === bossId);
      if (boss) {
        boss.x = ARENA_W / 2;
        boss.y = edge === 'far' ? 0 : ARENA_H;
        boss.bossCd = 999;
        boss.bossCd2 = 999;
      }
    }
    const entity = stagedSim.enemies.find((enemy) => enemy.active);
    if (entity) {
      entity.damage = 0;
      entity.hp = entity.maxHp = entity.barHp = 999_999;
      entity.stun = 999;
      entity.rangedCd = 999;
    }
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
    stagedSim.bossIntroT = 0;
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
} else if (debugStage === 'movement-review') {
  ff.startRun('messi');
  const stagedSim = ff.getSim();
  if (stagedSim) {
    stagedSim.debugDirectorPaused = true;
    stagedSim.player.abilities = {};
    stagedSim.player.maxHp = 99_999;
    stagedSim.player.hp = 99_999;
    stagedSim.player.xpNext = 999_999;
    stagedSim.boss0Spawned = true;
    stagedSim.boss1Spawned = true;
    stagedSim.boss2Spawned = true;
    for (let level = 1; level <= 5; level++) {
      stagedSim.applyUpgrade({ kind: 'ability', id: 'guard', name: '', desc: '', color: '', level });
    }
    const roster = ['invader', 'sprinter', 'lobber', 'flare', 'flag', 'foam', 'steward', 'drummer', 'vuvuzela', 'mascot', 'banner', 'paparazzo', 'chant', 'bull', 'drone', 'varcam'] as const;
    roster.forEach((enemyId, index) => {
      const angle = (index / roster.length) * Math.PI * 2;
      const radius = 440 + (index % 3) * 95;
      stagedSim.debugSpawn(
        enemyId,
        stagedSim.player.x + Math.cos(angle) * radius,
        stagedSim.player.y + Math.sin(angle) * radius,
      );
    });
    (['drumboss', 'official', 'captain'] as const).forEach((bossId, index) => {
      stagedSim.debugSpawnBoss(bossId);
      const boss = [...stagedSim.enemies].reverse().find((enemy) => enemy.active && enemy.boss === bossId);
      if (!boss) return;
      const angle = -2.35 + index * 0.82;
      boss.x = stagedSim.player.x + Math.cos(angle) * 720;
      boss.y = stagedSim.player.y + Math.sin(angle) * 620;
      boss.bossCd = 999;
      boss.bossCd2 = 999;
      boss.rangedCd = 999;
    });
    stagedSim.bossIntroT = 0;
    for (const enemy of stagedSim.enemies) {
      if (!enemy.active) continue;
      enemy.damage = 0;
      enemy.attackCd = 999;
      enemy.rangedCd = 999;
      enemy.hp = enemy.maxHp = enemy.barHp = 99_999;
    }
    stagedSim.events.length = 0;
    document.getElementById('banner')?.classList.remove('show');
  }
} else if (debugStage === 'captain-charge') {
  ff.startRun('messi');
  const stagedSim = ff.getSim();
  if (stagedSim) {
    stagedSim.debugDirectorPaused = true;
    stagedSim.player.abilities = {};
    stagedSim.player.maxHp = 99_999;
    stagedSim.player.hp = 99_999;
    stagedSim.player.xpNext = 999_999;
    stagedSim.boss0Spawned = true;
    stagedSim.boss1Spawned = true;
    stagedSim.boss2Spawned = true;
    stagedSim.debugSpawnBoss('captain');
    stagedSim.bossIntroT = 0;
    const boss = stagedSim.enemies.find((enemy) => enemy.active && enemy.boss === 'captain');
    if (boss) {
      boss.x = stagedSim.player.x + 600;
      boss.y = stagedSim.player.y;
      boss.damage = 0;
      boss.hp = boss.maxHp = boss.barHp = 99_999;
      boss.bossCd = 999;
      // Give the debug page time to finish loading before the 500ms evidence
      // window begins. This keeps human review and browser tests deterministic.
      boss.bossCd2 = 1.2;
      boss.rangedCd = 999;
    }
    stagedSim.events.length = 0;
    document.getElementById('banner')?.classList.remove('show');
  }
} else if (debugStage === 'art-direction') {
  ff.startRun('messi');
  const stagedSim = ff.getSim();
  if (stagedSim) {
    stagedSim.debugDirectorPaused = true;
    stagedSim.player.abilities = {};
    stagedSim.player.maxHp = 99_999;
    stagedSim.player.hp = 99_999;
    stagedSim.player.iframes = 0;
    stagedSim.player.xpNext = 999_999;
    stagedSim.player.x = ARENA_W / 2;
    stagedSim.player.y = ARENA_H / 2 + 40;
    stagedSim.boss0Spawned = true;
    stagedSim.boss1Spawned = true;
    stagedSim.boss2Spawned = true;
    stagedSim.debugSetGuardDamageMultiplier(0);
    stagedSim.applyUpgrade({ kind: 'ability', id: 'guard', name: '', desc: '', color: '', level: 1 });

    const lineup = [
      ['invader', -355, -190],
      ['bull', 335, 185],
      ['drone', 315, -150],
    ] as const;
    for (const [enemyId, dx, dy] of lineup) {
      stagedSim.debugSpawn(enemyId, stagedSim.player.x + dx, stagedSim.player.y + dy);
    }
    stagedSim.debugSpawnBoss('captain');
    stagedSim.bossIntroT = 0;
    const boss = stagedSim.enemies.find((enemy) => enemy.active && enemy.boss === 'captain');
    if (boss) {
      boss.x = stagedSim.player.x - 430;
      boss.y = stagedSim.player.y + 160;
    }
    for (const enemy of stagedSim.enemies) {
      if (!enemy.active) continue;
      enemy.damage = 0;
      enemy.speed = 0;
      enemy.attackCd = 999;
      enemy.rangedCd = 999;
      enemy.bossCd = 999;
      enemy.bossCd2 = 999;
      enemy.windup = 0;
      enemy.lungeT = 0;
      enemy.casting = '';
      enemy.hp = enemy.maxHp;
      enemy.barHp = enemy.maxHp;
    }
    stagedSim.events.length = 0;
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
    stagedSim.bossIntroT = 0;
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
    stagedSim.debugDirectorPaused = true;
    stagedSim.player.abilities = {};
    stagedSim.player.maxHp = 9999;
    stagedSim.player.hp = 9999;
    stagedSim.debugSetGuardDamageMultiplier(0);
    stagedSim.applyUpgrade({ kind: 'ability', id: 'guard', name: '', desc: '', color: '', level: 3 });
    // Leave enough leash margin for the authored punch knockback so this
    // scene continues proving independent assignments after several strikes.
    stagedSim.debugSpawn('invader', stagedSim.player.x - 245, stagedSim.player.y + 45);
    stagedSim.debugSpawn('steward', stagedSim.player.x + 245, stagedSim.player.y + 45);
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
} else if (debugStage === 'player-occlusion') {
  ff.startRun('messi');
  const stagedSim = ff.getSim();
  if (stagedSim) {
    stagedSim.debugDirectorPaused = true;
    stagedSim.player.abilities = {};
    stagedSim.player.maxHp = 99_999;
    stagedSim.player.hp = 99_999;
    stagedSim.player.xpNext = 999_999;
    stagedSim.boss0Spawned = true;
    stagedSim.boss1Spawned = true;
    stagedSim.boss2Spawned = true;
    stagedSim.debugSpawnBoss('captain');
    stagedSim.bossIntroT = 0;
    const boss = stagedSim.enemies.find((enemy) => enemy.active && enemy.boss === 'captain');
    if (boss) {
      boss.x = stagedSim.player.x + 8;
      boss.y = stagedSim.player.y + (new URLSearchParams(location.search).get('occlusion') === 'behind' ? -280 : 44);
      boss.damage = 0;
      boss.hp = boss.maxHp = boss.barHp = 99_999;
      boss.stun = 999;
      boss.bossCd = 999;
      boss.bossCd2 = 999;
      boss.rangedCd = 999;
    }
    stagedSim.events.length = 0;
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
    stagedSim.bossIntroT = 0;
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
    showUpgradeDraft(stagedSim.rollBossAbilities(), () => stagedSim.rollBossAbilities(), 'boss', 2);
  }
} else if (debugStage === 'training-cards') {
  ff.startRun('messi');
  ff.showTrainingCards(['maxhp', 'armor', 'magnet']);
}
