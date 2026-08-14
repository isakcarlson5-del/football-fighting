/**
 * 2.5D oblique renderer: world (x,y) -> screen with vertical tilt.
 * The pitch + stadium surroundings are prerendered once to an offscreen
 * canvas; entities are billboard sprites sorted by depth (painter's algorithm).
 */

import { clamp, TAU } from '../core/math';
import { exponentialSmoothing } from '../core/timing';
import {
  ballSprite,
  bossAtlas,
  bottleSprite,
  coinSprite,
  drinkSprite,
  enemyAtlas,
  getStripAtlas,
  guardAtlas,
  loadStripAtlas,
  playerArtUrl,
  playerAtlas,
  trimStripAtlasCache,
  trophySprite,
  xpSprite,
  type Atlas,
} from '../core/sprites';
import { BOSSES, ENEMIES, FREEZE_DURATION, SKINS, type BossId, type EnemyDef, type PlayerDef } from './data';
import { ARENA_H, ARENA_W, BOSS_INTRO_DURATION, BOSS_MELEE_LUNGE_DURATION, DASH_ANTICIPATION_DURATION, DASH_RECOVERY_DURATION, ENEMY_MELEE_LUNGE_DURATION, enemyAirLift, enemyRunCycleDistance, guardRunCycleDistance, guardRunPresentation, hybridBossBodyContact, KICK_AIM_LOCK_DELAY, KICK_CONTACT_DELAY, KICK_DURATION, MELEE_RECOVERY_DURATION, PLAYER_PIVOT_DURATION, type Enemy, type Guard, type Pickup, type Sim } from './sim';
import type { Save } from './meta';

/** Runtime art bible. Values are consumed by the renderer so perspective,
 * scale hierarchy and lighting cannot silently drift between actor classes. */
export const ART_DIRECTION_PROFILE = Object.freeze({
  projectionTilt: 0.62,
  lightCast: Object.freeze({ x: 0.78, y: 0.56 }),
  scale: Object.freeze({ player: 1.68, standardEnemy: 1.52, ally: 1.56, elite: 1.22 }),
  aerial: Object.freeze({ baseLift: 38, bobAmplitude: 4 }),
  saturation: Object.freeze({ minimum: 0.72, maximum: 1.08 }),
  bossScale: Object.freeze({ minimum: 2.08, maximum: 3 }),
});

const TILT = ART_DIRECTION_PROFILE.projectionTilt;
const MARGIN = 340; // stands width around pitch (world units) — procedural fallback only
const PLAYER_ENTITY_SCALE = ART_DIRECTION_PROFILE.scale.player;
const ENEMY_ENTITY_SCALE = ART_DIRECTION_PROFILE.scale.standardEnemy;
const ALLY_ENTITY_SCALE = ART_DIRECTION_PROFILE.scale.ally;
export interface ArenaGrassRect {
  x: number;
  y: number;
  w: number;
  h: number;
}
/** Conservative grass rect inside the sharp arena plate (source px,
 *  1536x1024). The painted field is slightly trapezoidal, so this inset keeps
 *  all four playable corners on turf while the surrounding stadium remains
 *  available to the camera. */
const PLATE_GRASS = { x: 124, y: 150, w: 1288, h: 790 };
/** Camera never gets closer than this to the painted world's outer edge. */
const EDGE_PAD = 6;
type SpriteBitmap = HTMLCanvasElement | HTMLImageElement;
export type MovementDirection = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw';
const MOVEMENT_DIRECTIONS: readonly MovementDirection[] = ['e', 'se', 's', 'sw', 'w', 'nw', 'n', 'ne'];
const BOSS_DIRECTION_FRAME_WIDTH = 480;
const PLAYER_DIRECTION_FRAME_WIDTH = 256;
const PLAYER_DIRECTION_RUN_FPS = 18;
const KEEPER_HALO_FRAME_COUNT = 12;
/** Normal match framing. The previous 1240-unit window made dense late-game
 *  threats enter from just outside the player's readable space. A restrained
 *  6.5% wider frame shows more of the pitch without miniaturising actors. */
export const NORMAL_VIEW_WORLD_H = 1320;
const HYBRID_GOAL_DEPTH = 34;
const HYBRID_GOAL_LIFT = 13.5;
const HYBRID_GOAL_POST_HEIGHT = 27;
// Stadium-camera verticals lean a few pixels toward the upper-left. Keep this
// shear identical on both goals: mirroring it with the goal direction makes
// one set of posts look folded sideways instead of rising from the turf.
const HYBRID_GOAL_HEIGHT_SHEAR_X = 3.4;
const HYBRID_GOAL_RIM_GAP_PAD = 23;
const HYBRID_LIGHT_CAST_X = ART_DIRECTION_PROFILE.lightCast.x;
const HYBRID_LIGHT_CAST_Y = ART_DIRECTION_PROFILE.lightCast.y;
export const HYBRID_LIGHT_CAST = Object.freeze({ x: HYBRID_LIGHT_CAST_X, y: HYBRID_LIGHT_CAST_Y });
const HYBRID_PENALTY_DEPTH = 330;
const HYBRID_PENALTY_HEIGHT = 820;
const HYBRID_GOAL_AREA_DEPTH = 130;
const HYBRID_GOAL_AREA_HEIGHT = 420;
const HYBRID_PENALTY_SPOT_DEPTH = 230;
const HYBRID_PENALTY_ARC_RADIUS = 150;

/** Aerial enemies descend for the first 200ms of overheat, stay planted for
 * 950ms, then rise during the last 200ms. Ground-lane hit tests use the same
 * state in Sim, so the visual height always communicates vulnerability. */
export function aerialOverheatHeightScale(groundT: number): number {
  if (groundT <= 0) return 1;
  if (groundT > 1.15) return clamp((groundT - 1.15) / 0.2, 0, 1);
  if (groundT < 0.2) return clamp(1 - groundT / 0.2, 0, 1);
  return 0;
}

export interface HybridPitchMarkingGeometry {
  side: 'left' | 'right';
  goalLineX: number;
  penaltyLineX: number;
  goalAreaLineX: number;
  penaltySpotX: number;
  penaltyTop: number;
  penaltyBottom: number;
  goalAreaTop: number;
  goalAreaBottom: number;
  arcStart: number;
  arcEnd: number;
}

export interface HybridCentreMarkingGeometry {
  lineX: number;
  top: number;
  bottom: number;
  circleX: number;
  circleY: number;
  radius: number;
}

export interface ScreenOcclusionRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** Fraction of the player's readable body covered by a body that is actually
 * painted in front. This stays independent of gameplay collision geometry so
 * giant authored silhouettes can receive a visual-only transparency budget. */
export function playerOcclusionStrength(
  player: ScreenOcclusionRect,
  actor: ScreenOcclusionRect,
  actorInFront: boolean,
): number {
  if (!actorInFront) return 0;
  const playerWidth = Math.max(1, player.right - player.left);
  const playerHeight = Math.max(1, player.bottom - player.top);
  const overlapWidth = Math.max(0, Math.min(player.right, actor.right) - Math.max(player.left, actor.left));
  const overlapHeight = Math.max(0, Math.min(player.bottom, actor.bottom) - Math.max(player.top, actor.top));
  const covered = clamp((overlapWidth * overlapHeight) / (playerWidth * playerHeight), 0, 1);
  const normalized = clamp((covered - 0.06) / 0.54, 0, 1);
  return normalized * normalized * (3 - 2 * normalized);
}

/** Collision-aligned World Cup pitch geometry for the optional live layer.
 * Exporting this keeps the mirrored goal construction independently testable. */
export function hybridPitchMarkingGeometry(side: 'left' | 'right'): HybridPitchMarkingGeometry {
  const direction = side === 'left' ? 1 : -1;
  const goalLineX = side === 'left' ? 40 : ARENA_W - 40;
  const arcHalfAngle = Math.acos((HYBRID_PENALTY_DEPTH - HYBRID_PENALTY_SPOT_DEPTH) / HYBRID_PENALTY_ARC_RADIUS);
  return {
    side,
    goalLineX,
    penaltyLineX: goalLineX + direction * HYBRID_PENALTY_DEPTH,
    goalAreaLineX: goalLineX + direction * HYBRID_GOAL_AREA_DEPTH,
    penaltySpotX: goalLineX + direction * HYBRID_PENALTY_SPOT_DEPTH,
    penaltyTop: (ARENA_H - HYBRID_PENALTY_HEIGHT) / 2,
    penaltyBottom: (ARENA_H + HYBRID_PENALTY_HEIGHT) / 2,
    goalAreaTop: (ARENA_H - HYBRID_GOAL_AREA_HEIGHT) / 2,
    goalAreaBottom: (ARENA_H + HYBRID_GOAL_AREA_HEIGHT) / 2,
    arcStart: side === 'left' ? -arcHalfAngle : Math.PI - arcHalfAngle,
    arcEnd: side === 'left' ? arcHalfAngle : Math.PI + arcHalfAngle,
  };
}

/** Shared halfway-line construction for the hybrid pitch. Keeping this world
 * geometry explicit makes the cached chalk treatment testable and guarantees
 * that its worn overlay stays registered with the Showpiece base markings. */
export function hybridCentreMarkingGeometry(): HybridCentreMarkingGeometry {
  return {
    lineX: ARENA_W / 2,
    top: 40,
    bottom: ARENA_H - 40,
    circleX: ARENA_W / 2,
    circleY: ARENA_H / 2,
    radius: 190,
  };
}

/** Sub-pixel wind response for the two live goal nets. Opposite phase keeps
 * the stadium from moving like one synchronized UI animation. */
export function hybridGoalNetBreathe(time: number, side: 'left' | 'right'): number {
  if (!Number.isFinite(time)) return 0;
  return Math.sin(time * 0.82 + (side === 'right' ? 1.7 : 0.2)) * 0.48;
}

export type HybridShadowKind = 'player' | 'enemy' | 'boss' | 'guard' | 'aerial' | 'pickup';

export interface HybridEntityShadowGeometry {
  castLength: number;
  castWidth: number;
  offsetX: number;
  offsetY: number;
  alpha: number;
  contactAlpha: number;
}

export interface EntityScreenRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
  centerX: number;
}

/** Material shadow proportions for the optional hybrid arena. They follow the
 * same lower-right floodlight direction as the raised goal cage. Elevation
 * separates and softens aerial shadows instead of turning them into foot rings. */
export function hybridEntityShadowGeometry(
  radius: number,
  kind: HybridShadowKind,
  elevation = 0,
  out?: HybridEntityShadowGeometry,
): HybridEntityShadowGeometry {
  const safeRadius = clamp(Number.isFinite(radius) ? radius : 16, 5, 70);
  const safeElevation = clamp(Number.isFinite(elevation) ? elevation : 0, 0, 80);
  const airborne = clamp(safeElevation / 52, 0, 1);
  const kindScale = kind === 'boss' ? 1.32
    : kind === 'player' ? 1.06
      : kind === 'guard' ? 0.96
        : kind === 'aerial' ? 0.78
          : kind === 'pickup' ? 0.56
          : 0.9;
  const baseLength = clamp(11 + safeRadius * 0.52, 16, 48) * kindScale;
  const baseWidth = clamp(4.2 + safeRadius * 0.2, 5.5, 17) * Math.sqrt(kindScale);
  const geometry = out ?? {
    castLength: 0,
    castWidth: 0,
    offsetX: 0,
    offsetY: 0,
    alpha: 0,
    contactAlpha: 0,
  };
  geometry.castLength = baseLength * (1 + airborne * 0.3);
  geometry.castWidth = baseWidth * (1 + airborne * 0.2);
  geometry.offsetX = 1.8 + airborne * 10.5;
  geometry.offsetY = 2.2 + airborne * 8.2;
  geometry.alpha = (kind === 'boss' ? 0.165 : kind === 'player' ? 0.145 : kind === 'pickup' ? 0.095 : 0.12) * (1 - airborne * 0.34);
  geometry.contactAlpha = kind === 'aerial' || safeElevation > 1
    ? 0
    : (kind === 'boss' ? 0.21 : kind === 'pickup' ? 0.13 : 0.17);
  return geometry;
}

/** Restrained foreground scale for billboard actors in the hybrid arena.
 * The feet remain at their collision point; only the authored cutout changes
 * size, producing depth without changing hitboxes or projectile targeting. */
export function hybridEntityDepthScale(worldY: number): number {
  const normalized = clamp((Number.isFinite(worldY) ? worldY : ARENA_H / 2) / ARENA_H, 0, 1);
  const eased = normalized * normalized * (3 - 2 * normalized);
  return 0.96 + eased * 0.08;
}

/** Orbiting Press is a protective halo behind the hero, never a foreground
 * billboard. Preserve natural depth on the far half, but cap the near half
 * immediately behind the player's painter position. */
export function orbitPainterDepthY(playerY: number, ballWorldY: number): number {
  return Math.min(ballWorldY, playerY - 0.01);
}

export interface OrbitTrailArcGeometry {
  arcRadians: number;
  segments: number;
  segmentLength: number;
  remainingGapRadians: number;
}

/** Builds a curved Orbiting Press wake that follows the real circular path.
 * The tail always stops with enough chord clearance before the following ball,
 * even at the six-ball maximum, so adjacent wakes cannot intersect a ball. */
export function orbitTrailArcGeometry(radius: number, count: number, ballDiameter = 28): OrbitTrailArcGeometry {
  const safeRadius = Math.max(1, Number.isFinite(radius) ? radius : 1);
  const safeCount = Math.max(1, Math.floor(Number.isFinite(count) ? count : 1));
  const angularGap = TAU / safeCount;
  const clearanceChord = Math.max(1, ballDiameter) + 30;
  const clearanceAngle = 2 * Math.asin(clamp(clearanceChord / (2 * safeRadius), 0, 0.95));
  const desiredArc = clamp(100 / safeRadius, 0.48, 0.82);
  const arcRadians = Math.min(desiredArc, Math.max(0.18, angularGap - clearanceAngle));
  const segments = Math.max(6, Math.min(10, Math.ceil(arcRadians * 12)));
  const segmentLength = clamp((safeRadius * arcRadians / segments) * 3.8, 28, 40);
  return {
    arcRadians,
    segments,
    segmentLength,
    remainingGapRadians: angularGap - arcRadians,
  };
}

export interface PickupVisibleBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AerialLaunchVisual {
  bodyAlpha: number;
  wakeAlpha: number;
  scale: number;
}

/** Keeps newly kicked aerial objects from being painted across the hero's
 * face on their contact frame. The ball itself emerges quickly from the foot;
 * the larger additive wake arrives later, once the projectile has cleared the
 * authored body silhouette. This is visual-only and never changes targeting. */
export function aerialLaunchVisual(age: number): AerialLaunchVisual {
  const safeAge = Math.max(0, Number.isFinite(age) ? age : 0);
  const smooth = (value: number): number => {
    const t = clamp(value, 0, 1);
    return t * t * (3 - 2 * t);
  };
  const bodyAlpha = smooth((safeAge - 0.022) / 0.082);
  const wakeAlpha = smooth((safeAge - 0.074) / 0.13);
  return {
    bodyAlpha,
    wakeAlpha,
    scale: 0.76 + bodyAlpha * 0.24,
  };
}

/** Measured alpha bounds of the generated pickup PNGs, normalized to their
 * source canvases. Rendering only this visible rectangle lets the lowest real
 * asset pixel sit exactly on the world contact point instead of floating on
 * each file's different transparent export margin. */
export function pickupVisibleBounds(kind: Pickup['kind'], tier: Pickup['tier']): PickupVisibleBounds {
  if (kind === 'bomb') return { x: 31 / 256, y: 18 / 256, width: 194 / 256, height: 220 / 256 };
  if (kind === 'freeze') return { x: 29 / 256, y: 18 / 256, width: 197 / 256, height: 220 / 256 };
  if (kind === 'magnet') return { x: 18 / 256, y: 19 / 256, width: 220 / 256, height: 217 / 256 };
  if (kind === 'trophy') return { x: 19 / 128, y: 8 / 128, width: 89 / 128, height: 112 / 128 };
  if (kind === 'coin') return { x: 8 / 128, y: 11 / 128, width: 112 / 128, height: 105 / 128 };
  if (kind === 'heal') return { x: 34 / 128, y: 8 / 128, width: 59 / 128, height: 112 / 128 };
  if (tier === 2) return { x: 31 / 128, y: 8 / 128, width: 65 / 128, height: 112 / 128 };
  if (tier === 3) return { x: 22 / 128, y: 8 / 128, width: 84 / 128, height: 112 / 128 };
  return { x: 15 / 128, y: 8 / 128, width: 97 / 128, height: 112 / 128 };
}

/** Stronger but still restrained depth cue for fixed corner assemblies. Their
 * turf socket stays at the authored world point while only the pole/cloth
 * silhouette grows toward the near camera edge. */
export function hybridCornerFlagDepthScale(worldY: number): number {
  const normalized = clamp((Number.isFinite(worldY) ? worldY : ARENA_H / 2) / ARENA_H, 0, 1);
  const eased = normalized * normalized * (3 - 2 * normalized);
  return 0.92 + eased * 0.16;
}

/** Screen-space offset for the rear structural tier of the hybrid bowl. It
 * moves at roughly one quarter of the pitch camera delta and is clamped so the
 * effect reads as depth rather than a sliding background. */
export function hybridStadiumParallax(camera: number, centre: number): number {
  if (!Number.isFinite(camera) || !Number.isFinite(centre)) return 0;
  return clamp((camera - centre) * 0.024, -8, 8);
}

/** Visual-only height for hostile projectiles in the hybrid arena. Bottle
 * lobs rise and settle through a single readable arc; electric darts retain a
 * taut low flight path so players can distinguish their timing at a glance. */
export function hybridHostileProjectileElevation(kind: 'bottle' | 'electric' | 'scan', life: number, maxLife = 2.2): number {
  const remaining = Math.max(0, Number.isFinite(life) ? life : 0);
  if (kind === 'electric') return 28;
  if (kind === 'scan') return 34;
  const duration = Math.max(0.001, Number.isFinite(maxLife) ? maxLife : 2.2);
  const phase = clamp(1 - remaining / duration, 0, 1);
  return 12 + Math.sin(phase * Math.PI) * 34;
}

export interface CorpseCollapseVisual {
  rotation: number;
  scaleX: number;
  scaleY: number;
  sink: number;
  alpha: number;
}

/** A compressed three-beat collapse keeps the body attached to the turf and
 * avoids turning a complete billboard into a flat 77-degree card. */
export function corpseCollapseVisual(progress: number): CorpseCollapseVisual {
  const u = clamp(Number.isFinite(progress) ? progress : 0, 0, 1);
  const collapse = clamp(u / 0.72, 0, 1);
  const eased = collapse * collapse * (3 - 2 * collapse);
  return {
    rotation: eased * 0.48,
    scaleX: 1 + Math.sin(eased * Math.PI) * 0.08,
    scaleY: 1 - eased * 0.38,
    sink: eased * 13,
    alpha: u < 0.58 ? 1 : Math.max(0, 1 - (u - 0.58) / 0.42),
  };
}

/** Quantize a world-space movement vector into one of eight authored views. */
export function movementDirection(dx: number, dy: number): MovementDirection {
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || Math.abs(dx) + Math.abs(dy) < 0.0001) return 's';
  const octant = Math.round(Math.atan2(dy, dx) / (Math.PI / 4));
  return MOVEMENT_DIRECTIONS[(octant + 8) % 8];
}

export interface DirectionalFrameBlend {
  frame: number;
  nextFrame: number;
  mix: number;
}

export interface PlayerStepCue {
  strength: number;
  foot: -1 | 1;
}

export interface BossArrivalVisual {
  progress: number;
  alpha: number;
  scale: number;
  lift: number;
  beamAlpha: number;
}

/** Short bottom-up materialization. It never resembles a red danger circle:
 * the entrance is communicated through silhouette reveal and vertical light. */
export function bossArrivalVisual(
  remaining: number,
  duration = BOSS_INTRO_DURATION,
): BossArrivalVisual {
  const safeDuration = Math.max(0.001, Number.isFinite(duration) ? duration : BOSS_INTRO_DURATION);
  const progress = clamp(1 - Math.max(0, Number.isFinite(remaining) ? remaining : 0) / safeDuration, 0, 1);
  const eased = 1 - Math.pow(1 - progress, 3);
  return {
    progress,
    alpha: 0.16 + eased * 0.84,
    scale: 0.78 + eased * 0.22,
    lift: (1 - eased) * 30,
    beamAlpha: Math.sin(progress * Math.PI) * 0.72,
  };
}

interface TurfFootprint {
  active: boolean;
  x: number;
  y: number;
  born: number;
  side: -1 | 1;
  angle: number;
}

interface TurfClipping {
  active: boolean;
  x: number;
  y: number;
  born: number;
  vx: number;
  vy: number;
  angle: number;
  spin: number;
  length: number;
  shade: number;
}

/** Integrated exponential drag for turf clippings. Exported so monotonic
 * world-space motion remains covered independently of canvas rendering. */
export function dampedTurfDisplacement(age: number, dragRate = 4.7): number {
  const safeAge = Math.max(0, Number.isFinite(age) ? age : 0);
  const safeDrag = Math.max(0.001, Number.isFinite(dragRate) ? dragRate : 4.7);
  return (1 - Math.exp(-safeAge * safeDrag)) / safeDrag;
}

/** Hold one concrete authored pose per frame. Alpha-dissolving two displaced
 * cleats creates a visible double foot, especially during slow movement. The
 * 12-frame directional strips already provide sufficient in-betweens. */
export function directionalFrameBlend(animT: number, fps: number, frames: number): DirectionalFrameBlend {
  const count = Math.max(1, Math.floor(frames));
  const phase = Math.max(0, Number.isFinite(animT) ? animT : 0) * Math.max(0, fps);
  const base = Math.floor(phase);
  return {
    frame: base % count,
    nextFrame: (base + 1) % count,
    mix: 0,
  };
}

export interface MatchdayWipeoutVisual {
  size: number;
  alpha: number;
}

/** Keep the authored Wipeout spectacular without hiding the tactical frame.
 * The diameter is capped to 65% of the short viewport edge, matching the
 * release-audit readability contract on portrait and landscape screens. */
export function matchdayWipeoutVisual(
  viewportWidth: number,
  viewportHeight: number,
  progress: number,
  reducedVfx: boolean,
): MatchdayWipeoutVisual {
  const safeProgress = clamp(progress, 0, 0.999);
  const fade = safeProgress < 0.72 ? 1 : 1 - (safeProgress - 0.72) / 0.28;
  return {
    size: Math.max(0, Math.min(viewportWidth, viewportHeight)) * 0.65,
    alpha: clamp(fade, 0, 1) * (reducedVfx ? 0.26 : 0.5),
  };
}

/** Two authored foot plants per 12-frame running cycle. This drives a tiny
 *  turf-contact cue and body lift; it never appears while the player is idle. */
export function playerStepCue(animT: number, fps = PLAYER_DIRECTION_RUN_FPS, frames = 12): PlayerStepCue {
  const count = Math.max(2, Math.floor(frames));
  const phase = Math.max(0, Number.isFinite(animT) ? animT : 0) * Math.max(0, fps);
  const frame = phase % count;
  const contacts = [2, 2 + count / 2];
  const circularDistance = (value: number, target: number) => {
    const raw = Math.abs(value - target);
    return Math.min(raw, count - raw);
  };
  const firstDistance = circularDistance(frame, contacts[0]);
  const secondDistance = circularDistance(frame, contacts[1]);
  const distance = Math.min(firstDistance, secondDistance);
  const normalized = clamp(1 - distance / 0.9, 0, 1);
  return {
    strength: normalized * normalized * (3 - 2 * normalized),
    foot: firstDistance <= secondDistance ? -1 : 1,
  };
}

export interface FrameAnchorAdjustment { x: number; y: number }

/** Source strips remain untouched. Small measured per-frame corrections are
 * applied at draw time so the original art is always recoverable. */
export function playerFrameAnchorAdjustment(playerId: string, frame: number): FrameAnchorAdjustment {
  return playerId === 'neymar' && frame % 12 === 2 ? { x: 0, y: 2 } : { x: 0, y: 0 };
}

export function enemyFrameAnchorAdjustment(enemyId: string, frame: number): FrameAnchorAdjustment {
  const safeFrame = ((Math.floor(frame) % 6) + 6) % 6;
  if (enemyId === 'invader' && safeFrame === 2) return { x: 0, y: 3 };
  if (enemyId === 'banner') return { x: 0, y: 4 };
  if (enemyId === 'flag') {
    // Pole-base measurements from the six source cells, normalized around
    // the cell-three hand anchor. This removes the four-pixel flag snap.
    const xOffsets = [11, -28, 0, 12, -1, 2];
    return { x: xOffsets[safeFrame], y: 0 };
  }
  return { x: 0, y: 0 };
}

/** Generated enemy strips use semantic poses: idle, move, attack/cast, hurt. */
export function enemyPoseFrame(
  e: Pick<Enemy, 'hurtT' | 'stun' | 'windup' | 'lungeT' | 'attackAnimT' | 'telegraph' | 'casting' | 'moving' | 'airT'>,
  frames: number,
): number {
  if (frames < 4) return Math.max(0, frames - 1);
  if (e.hurtT > 0 || e.stun > 0) return 3;
  if (e.windup > 0 || e.lungeT > 0 || e.attackAnimT > 0 || e.telegraph > 0 || e.casting !== '') return 2;
  if (e.moving || e.airT > 0) return 1;
  return 0;
}

/** Allied bodyguard strip poses: idle, move, punch, bottle interception. */
export function guardPoseFrame(
  g: Pick<Guard, 'moving' | 'strikeT' | 'blockT'>,
  frames: number,
): number {
  if (frames < 4) return Math.max(0, frames - 1);
  if (g.blockT > 0) return 3;
  if (g.strikeT > 0) return 2;
  if (g.moving) return 1;
  return 0;
}

export interface EnemyHealthBarStyle {
  ratio: number;
  width: number;
  height: number;
  accent: string;
  numeric: boolean;
}

export interface CombatPresentationBudget {
  maxOrdinaryHealthBars: number;
  particleStride: number;
  maxStandardImpacts: number;
  maxPriorityImpacts: number;
  maxSeekerTrails: number;
  maxStandardDamageNumbers: number;
  maxCriticalDamageNumbers: number;
  hitFlashAlpha: number;
}

/** Rendering pressure changes presentation only. Simulation, damage, spawn,
 * targeting and telegraphs never read this budget. */
export function combatPresentationBudget(activeEnemies: number): CombatPresentationBudget {
  const count = Math.max(0, Math.floor(activeEnemies));
  if (count >= 100) {
    return {
      maxOrdinaryHealthBars: 5,
      particleStride: 4,
      maxStandardImpacts: 4,
      maxPriorityImpacts: 6,
      maxSeekerTrails: 5,
      maxStandardDamageNumbers: 5,
      maxCriticalDamageNumbers: 6,
      hitFlashAlpha: 0.24,
    };
  }
  if (count >= 70) {
    return {
      maxOrdinaryHealthBars: 7,
      particleStride: 3,
      maxStandardImpacts: 6,
      maxPriorityImpacts: 8,
      maxSeekerTrails: 7,
      maxStandardDamageNumbers: 8,
      maxCriticalDamageNumbers: 8,
      hitFlashAlpha: 0.32,
    };
  }
  if (count >= 40) {
    return {
      maxOrdinaryHealthBars: 10,
      particleStride: 2,
      maxStandardImpacts: 10,
      maxPriorityImpacts: 14,
      maxSeekerTrails: 10,
      maxStandardDamageNumbers: 12,
      maxCriticalDamageNumbers: 10,
      hitFlashAlpha: 0.42,
    };
  }
  return {
    maxOrdinaryHealthBars: 16,
    particleStride: 1,
    maxStandardImpacts: 20,
    maxPriorityImpacts: 24,
    maxSeekerTrails: 16,
    maxStandardDamageNumbers: 22,
    maxCriticalDamageNumbers: 16,
    hitFlashAlpha: 0.56,
  };
}

/** Accessibility mode reduces decorative density and flash intensity without
 * touching telegraphs, health bars, targeting markers or simulation. */
export function reducedCombatPresentationBudget(base: CombatPresentationBudget): CombatPresentationBudget {
  return {
    ...base,
    particleStride: Math.max(2, base.particleStride * 2),
    maxStandardImpacts: Math.max(2, Math.ceil(base.maxStandardImpacts * 0.45)),
    maxPriorityImpacts: Math.max(4, Math.ceil(base.maxPriorityImpacts * 0.65)),
    maxSeekerTrails: Math.max(3, Math.ceil(base.maxSeekerTrails * 0.45)),
    maxStandardDamageNumbers: Math.max(4, Math.ceil(base.maxStandardDamageNumbers * 0.55)),
    maxCriticalDamageNumbers: Math.max(4, Math.ceil(base.maxCriticalDamageNumbers * 0.7)),
    hitFlashAlpha: base.hitFlashAlpha * 0.58,
  };
}

/** Positive scores are eligible ordinary bars; Infinity is reserved for an
 * elite or a temporary status that the player must be able to identify. */
export function enemyHealthBarPriority(
  e: Pick<Enemy, 'hp' | 'maxHp' | 'elite' | 'boss' | 'stun' | 'slow' | 'airT' | 'barHitT' | 'def'>,
  distanceToPlayer: number,
  activeEnemies: number,
): number {
  if (e.boss) return -1;
  if (e.elite) return Number.POSITIVE_INFINITY;
  const ratio = e.maxHp > 0 ? clamp(e.hp / e.maxHp, 0, 1) : 0;
  const count = Math.max(0, activeEnemies);
  const nearRange = count >= 100 ? 145 : count >= 70 ? 175 : count >= 40 ? 215 : 285;
  const priorityRange = count >= 100 ? 235 : count >= 70 ? 290 : count >= 40 ? 365 : 480;
  const behavior = e.def.behavior;
  const priorityThreat = behavior === 'aerial' || behavior === 'charger' || behavior === 'summoner'
    || behavior === 'support' || behavior === 'ranged' || behavior === 'cone';
  const status = e.stun > 0 || e.slow > 0 || e.airT > 0;
  const damaged = ratio < 0.999;
  if (!damaged && !status && distanceToPlayer > nearRange && (!priorityThreat || distanceToPlayer > priorityRange)) return -1;
  let score = Math.max(0, 1800 - distanceToPlayer * 2.2);
  if (damaged) score += 3200 + (1 - ratio) * 2400;
  if (e.barHitT > 0) score += 2200;
  if (status) score += 2100;
  if (priorityThreat) score += 1100;
  return score;
}

export interface HealthBarCollisionRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface EnemyHealthBarPlacement {
  x: number;
  y: number;
  widthScale: number;
  alpha: number;
  lane: number;
  compact: boolean;
  hidden: boolean;
}

/** Deterministically separates billboard health bars in dense crowds.
 *
 * Fully healthy ordinary threats may use a smaller scoreboard plate once the
 * local group becomes crowded. Damaged and elite threats retain the full bar,
 * then climb through additional vertical lanes so important combat state is
 * never hidden behind a neighbour. The caller owns `occupied` for one frame. */
export function placeEnemyHealthBar(
  anchorX: number,
  anchorY: number,
  width: number,
  height: number,
  important: boolean,
  fullHealth: boolean,
  occupied: HealthBarCollisionRect[],
  reserved: readonly HealthBarCollisionRect[] = [],
): EnemyHealthBarPlacement {
  const nearby = occupied.reduce((count, rect) => {
    const centerX = (rect.left + rect.right) * 0.5;
    const centerY = (rect.top + rect.bottom) * 0.5;
    return count + (Math.abs(centerX - anchorX) < width * 2.15 && Math.abs(centerY - anchorY) < 104 ? 1 : 0);
  }, 0);
  // One untouched ordinary bar is enough to establish that a local pack is
  // healthy. Additional 100% plates carry no new combat information and were
  // previously displaced into a wall of UI above the actors. Do not reserve a
  // lane for suppressed bars: the space remains available to damaged enemies,
  // elites and status-bearing threats, which always keep their full readout.
  if (!important && fullHealth && nearby >= 1) {
    return {
      x: anchorX,
      y: anchorY,
      widthScale: 0.6,
      alpha: 0,
      lane: 0,
      compact: true,
      hidden: true,
    };
  }
  const compact = false;
  const widthScale = compact ? 0.6 : 1;
  const alpha = compact ? 0.66 : 1;
  const plateWidth = width * widthScale + 12;
  const plateHeight = height * (compact ? 0.82 : 1) + 8;
  const labelHeadroom = important ? 13 : 0;
  // Lane spacing is based on the authored full plate, not the compacted
  // variant. Switching presentation mid-crowd must never reuse a prior lane.
  const laneStep = Math.max(16, height + 13 + labelHeadroom);
  const maxLane = important ? 7 : compact ? 6 : 6;
  let bestLane = 0;
  let bestX = anchorX;
  let bestY = anchorY;
  let bestHits = Number.POSITIVE_INFINITY;

  for (let lane = 0; lane <= maxLane; lane++) {
    const row = lane === 0 ? 0 : Math.ceil(lane / 2);
    const side = lane === 0 ? 0 : lane % 2 === 1 ? -1 : 1;
    const sideDistance = row === 0 ? 0 : 0.58 + Math.max(0, row - 1) * 0.56;
    const x = anchorX + side * plateWidth * sideDistance;
    const y = anchorY - row * laneStep;
    const candidate: HealthBarCollisionRect = {
      left: x - plateWidth / 2,
      right: x + plateWidth / 2,
      top: y - labelHeadroom - 3,
      bottom: y + plateHeight,
    };
    let hits = 0;
    for (let index = Math.max(0, occupied.length - 48); index < occupied.length; index++) {
      const rect = occupied[index];
      if (candidate.right + 3 > rect.left && candidate.left - 3 < rect.right
        && candidate.bottom + 2 > rect.top && candidate.top - 2 < rect.bottom) hits++;
    }
    // A reserved gameplay silhouette is much more important than a collision
    // between two labels. Bars still remain visible, but exhaust their authored
    // side/height lanes before accepting overlap with the hero or critical VFX.
    for (const rect of reserved) {
      if (candidate.right + 4 > rect.left && candidate.left - 4 < rect.right
        && candidate.bottom + 3 > rect.top && candidate.top - 3 < rect.bottom) hits += 64;
    }
    if (hits < bestHits) {
      bestHits = hits;
      bestLane = lane;
      bestX = x;
      bestY = y;
    }
    if (hits === 0) break;
  }

  occupied.push({
    left: bestX - plateWidth / 2,
    right: bestX + plateWidth / 2,
    top: bestY - labelHeadroom - 3,
    bottom: bestY + plateHeight,
  });
  return {
    x: bestX,
    y: bestY,
    widthScale,
    alpha: bestHits > 0 && compact ? 0.58 : alpha,
    lane: bestLane,
    compact,
    hidden: false,
  };
}

/** Shared health-bar metrics keep every archetype readable without letting
 *  100+ simultaneous bars dominate the pitch. */
export function enemyHealthBarStyle(
  e: Pick<Enemy, 'hp' | 'maxHp' | 'radius' | 'elite' | 'boss'>,
): EnemyHealthBarStyle {
  const ratio = clamp(e.maxHp > 0 ? e.hp / e.maxHp : 0, 0, 1);
  const boss = !!e.boss;
  const width = boss
    ? clamp(52 + e.radius * 2.1, 128, 166)
    : clamp((24 + e.radius * 1.5) * (e.elite ? 1.16 : 1), 42, e.elite ? 84 : 70);
  return {
    ratio,
    width,
    height: boss
      ? clamp(8 + (e.radius - 38) * 0.2, 8, 11)
      : e.elite
        ? clamp(5 + e.radius * 0.16, 7, 9)
        : clamp(3.4 + e.radius * 0.16, 5, 8.2),
    accent: boss ? '#ff4d66' : e.elite ? '#ffd23f' : '#b7cbd6',
    numeric: boss || e.elite,
  };
}

export interface CombatPresentationMetrics {
  activeEnemies: number;
  visibleHealthBars: number;
  renderedParticles: number;
  renderedImpacts: number;
  renderedSeekerTrails: number;
  renderedDamageNumbers: number;
}

export class Renderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private pitch: HTMLCanvasElement;
  private plate: HTMLImageElement | null = null;
  private plateGrass: ArenaGrassRect = PLATE_GRASS;
  private liveStadium = false;
  private hybridDepth = false;
  /** World rect covered by the prerendered pitch canvas (camera hard limits). */
  private bounds = { x0: -MARGIN, y0: -MARGIN, x1: ARENA_W + MARGIN, y1: ARENA_H + MARGIN };
  private scale = 1;
  private viewWorldH = NORMAL_VIEW_WORLD_H;
  private shake = 0;
  private lastDrawTime = Number.NaN;
  private ball: HTMLCanvasElement;
  private matchBallSpr: SpriteBitmap;
  private curveballSpr: SpriteBitmap;
  private goldenBootSpr: SpriteBitmap;
  private xpSpr: SpriteBitmap[];
  private coinSpr: SpriteBitmap;
  private healSpr: SpriteBitmap;
  private trophySpr: SpriteBitmap;
  private magnetSpr: SpriteBitmap;
  private bombSpr: SpriteBitmap;
  private freezeSpr: SpriteBitmap;
  private orbitImpactSpr: HTMLImageElement | null = null;
  private orbitSkidSpr: HTMLImageElement | null = null;
  private contactHitSpr: HTMLImageElement | null = null;
  private playerHurtSpr: HTMLImageElement | null = null;
  private knockoutSpr: HTMLImageElement | null = null;
  private guardSlamSpr: HTMLImageElement | null = null;
  private curveTrailSpr: HTMLImageElement | null = null;
  private goldenBootTrailSpr: HTMLImageElement | null = null;
  private bossWarningSpr: HTMLImageElement | null = null;
  private bullChargeLaneSpr: HTMLImageElement | null = null;
  private aerialTargetSpr: HTMLImageElement | null = null;
  private captainsHeartSpr: HTMLImageElement | null = null;
  private droneShotSpr: HTMLImageElement | null = null;
  private matchdayWipeoutSpr: HTMLImageElement | null = null;
  private firstTouchGroundSpr: HTMLImageElement | null = null;
  private firstTouchAirSpr: HTMLImageElement | null = null;
  private kickDustSpr: HTMLImageElement | null = null;
  private orbitTrailSpr: HTMLImageElement | null = null;
  private keeperHaloSpr: HTMLImageElement | null = null;
  private varScanShotSpr: HTMLImageElement | null = null;
  private abilityUpgradeSpr: HTMLImageElement | null = null;
  private captainsWhistleSpr: HTMLImageElement | null = null;
  private bottleSpr: HTMLCanvasElement;
  private atlasCache = new Map<string, Atlas>();
  private crowdSeed: number[] = [];
  private flashWarn = 0;
  private flashWhiteT = 0;
  private lossStartedAt = -1;
  private matchdayWipeoutStartedAt = -1;
  private abilityUpgradeStartedAt = -1;
  private abilityUpgradeMax = false;
  private keeperBlockStartedAt = -1;
  private keeperBlockX = 0;
  private keeperBlockY = 0;
  private keeperBlockCounter = false;
  private scanImpactStartedAt = -1;
  private scanImpactX = 0;
  private scanImpactY = 0;
  private turfFootprints: TurfFootprint[] = Array.from({ length: 24 }, () => ({
    active: false, x: 0, y: 0, born: 0, side: 1, angle: 0,
  }));
  private turfFootprintCursor = 0;
  private turfClippings: TurfClipping[] = Array.from({ length: 72 }, () => ({
    active: false, x: 0, y: 0, born: 0, vx: 0, vy: 0, angle: 0, spin: 0, length: 0, shade: 0,
  }));
  private turfClippingCursor = 0;
  private lastTurfFootprintAt = -1e9;
  private lastTurfFootprintX = Number.NaN;
  private lastTurfFootprintY = Number.NaN;
  private lastTurfRunStep = 0;
  private nextTurfFoot: -1 | 1 = -1;
  private reservedHealthBarZones: HealthBarCollisionRect[] = [{ left: 0, right: 0, top: 0, bottom: 0 }];
  private playerOcclusionMask = document.createElement('canvas');
  private playerOcclusionOutline = document.createElement('canvas');
  private lastPlayerOcclusion = 0;
  private healthBarVisibleScratch = new Uint8Array(512);
  private healthBarCandidateScratch: Array<{ index: number; score: number }> = [];
  private lastPresentationMetrics: CombatPresentationMetrics = {
    activeEnemies: 0,
    visibleHealthBars: 0,
    renderedParticles: 0,
    renderedImpacts: 0,
    renderedSeekerTrails: 0,
    renderedDamageNumbers: 0,
  };
  private reducedVfx = false;
  private hybridShadowScratch: HybridEntityShadowGeometry = {
    castLength: 0,
    castWidth: 0,
    offsetX: 0,
    offsetY: 0,
    alpha: 0,
    contactAlpha: 0,
  };

  camX = ARENA_W / 2;
  camY = ARENA_H / 2;
  private hybridLookX = 0;
  private hybridLookY = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false })!;
    this.pitch = this.buildPitch();
    this.ball = ballSprite(22);
    this.matchBallSpr = this.ball;
    this.curveballSpr = this.ball;
    this.goldenBootSpr = this.ball;
    this.xpSpr = [xpSprite(1), xpSprite(2), xpSprite(3)];
    this.coinSpr = coinSprite();
    this.healSpr = drinkSprite();
    this.trophySpr = trophySprite();
    this.magnetSpr = coinSprite();
    this.bombSpr = ballSprite(28);
    this.freezeSpr = xpSprite(1);
    this.bottleSpr = bottleSprite();
    ['xp-1', 'xp-2', 'xp-3'].forEach((id, i) => {
      this.loadPickupSprite(`art/pickups/${id}.png`, (img) => {
        this.xpSpr[i] = img;
      });
    });
    this.loadPickupSprite('art/pickups/coin.png', (img) => {
      this.coinSpr = img;
    });
    this.loadPickupSprite('art/pickups/heal.png', (img) => {
      this.healSpr = img;
    });
    this.loadPickupSprite('art/pickups/trophy.png', (img) => {
      this.trophySpr = img;
    });
    this.loadPickupSprite('art/pickups/magnet.png', (img) => {
      this.magnetSpr = img;
    });
    this.loadPickupSprite('art/pickups/bomb.png', (img) => {
      this.bombSpr = img;
    });
    this.loadPickupSprite('art/pickups/freeze.png', (img) => {
      this.freezeSpr = img;
    });
    this.loadPickupSprite('art/projectiles/curveball-v2.png', (img) => {
      this.curveballSpr = img;
    });
    this.loadPickupSprite('art/projectiles/golden-boot-v2.png', (img) => {
      this.goldenBootSpr = img;
    });
    this.loadPickupSprite('art/projectiles/match-ball.png', (img) => {
      this.matchBallSpr = img;
    });
    this.loadPickupSprite('art/vfx/orbit-impact-v2.png', (img) => {
      this.orbitImpactSpr = img;
    });
    this.loadPickupSprite('art/vfx/orbit-skid-v2.png', (img) => {
      this.orbitSkidSpr = img;
    });
    this.loadPickupSprite('art/vfx/contact-hit-strip.png', (img) => {
      this.contactHitSpr = img;
    });
    this.loadPickupSprite('art/vfx/player-hurt-strip.png', (img) => {
      this.playerHurtSpr = img;
    });
    this.loadPickupSprite('art/vfx/knockout-strip.png', (img) => {
      this.knockoutSpr = img;
    });
    this.loadPickupSprite('art/vfx/guard-slam-strip.png', (img) => {
      this.guardSlamSpr = img;
    });
    this.loadPickupSprite('art/vfx/curveball-trail-strip.png', (img) => {
      this.curveTrailSpr = img;
    });
    this.loadPickupSprite('art/vfx/golden-boot-trail-strip.png', (img) => {
      this.goldenBootTrailSpr = img;
    });
    this.loadPickupSprite('art/vfx/boss-warning-strip.png', (img) => {
      this.bossWarningSpr = img;
    });
    this.loadPickupSprite('art/vfx/bull-charge-lane-strip.png', (img) => {
      this.bullChargeLaneSpr = img;
    });
    this.loadPickupSprite('art/vfx/aerial-target-strip.png', (img) => {
      this.aerialTargetSpr = img;
    });
    this.loadPickupSprite('art/vfx/captains-heart-strip.png', (img) => {
      this.captainsHeartSpr = img;
    });
    this.loadPickupSprite('art/vfx/drone-shot-strip.png', (img) => {
      this.droneShotSpr = img;
    });
    this.loadPickupSprite('art/vfx/matchday-wipeout-strip.webp', (img) => {
      this.matchdayWipeoutSpr = img;
    });
    this.loadPickupSprite('art/vfx/first-touch-ground-strip.webp', (img) => {
      this.firstTouchGroundSpr = img;
    });
    this.loadPickupSprite('art/vfx/first-touch-air-strip.webp', (img) => {
      this.firstTouchAirSpr = img;
    });
    this.loadPickupSprite('art/vfx/kick-dust-motes.png', (img) => {
      this.kickDustSpr = img;
    });
    this.loadPickupSprite('art/vfx/orbit-ball-curved-trail.png?v=2', (img) => {
      this.orbitTrailSpr = img;
    });
    this.loadPickupSprite('art/abilities/keeper-halo-strip-v2.png', (img) => {
      this.keeperHaloSpr = img;
    });
    this.loadPickupSprite('art/vfx/var-scan-shot-strip.png', (img) => {
      this.varScanShotSpr = img;
    });
    this.loadPickupSprite('art/vfx/ability-upgrade-strip.png', (img) => {
      this.abilityUpgradeSpr = img;
    });
    this.loadPickupSprite('art/vfx/captains-whistle-strip.webp?v=2', (img) => {
      this.captainsWhistleSpr = img;
    });
    void loadStripAtlas('ally-bodyguard-rookie', 'art/allies/bodyguard-rookie.png');
    void loadStripAtlas('ally-bodyguard-rookie-run', 'art/allies/bodyguard-rookie-run.png');
    void loadStripAtlas('ally-bodyguard', 'art/allies/bodyguard.png');
    void loadStripAtlas('ally-bodyguard-run', 'art/allies/bodyguard-run.png');
    void loadStripAtlas('ally-bodyguard-heavy', 'art/allies/bodyguard-heavy-clean.png');
    void loadStripAtlas('ally-bodyguard-heavy-run', 'art/allies/bodyguard-heavy-run.png');
    void loadStripAtlas('ally-bodyguard-scout', 'art/allies/bodyguard-scout-clean.png');
    void loadStripAtlas('ally-bodyguard-scout-run', 'art/allies/bodyguard-scout-run.png');
    // Stable stadium seed makes visual reviews and repeated arena loads
    // pixel-comparable while retaining varied crowd and material placement.
    let stadiumSeed = 0x5f3759df;
    for (let i = 0; i < 400; i++) {
      stadiumSeed = (Math.imul(stadiumSeed, 1664525) + 1013904223) >>> 0;
      this.crowdSeed.push(stadiumSeed / 0x100000000);
    }
  }

  /** Loads generated pickup art while preserving the procedural fallback. */
  private loadPickupSprite(url: string, apply: (img: HTMLImageElement) => void): void {
    const img = new Image();
    img.onload = () => apply(img);
    img.src = url;
  }

  /** Draws one cell from a generated VFX strip. Keeping VFX in one fixed atlas
   *  avoids per-hit allocations and remains safe in dense runs. */
  private drawVfxFrame(
    ctx: CanvasRenderingContext2D,
    sprite: HTMLImageElement | null,
    frame: number,
    x: number,
    y: number,
    size: number,
    rotation = 0,
    alpha = 1,
    additive = false,
    anchorX = 0.5,
    frameCount = 6,
  ): boolean {
    if (!sprite || !sprite.complete || sprite.naturalWidth <= 0) return false;
    const frames = Math.max(1, Math.floor(frameCount));
    const fw = sprite.naturalWidth / frames;
    const sourceFrame = clamp(Math.floor(frame), 0, frames - 1);
    ctx.save();
    ctx.globalAlpha = clamp(alpha, 0, 1);
    if (additive) ctx.globalCompositeOperation = 'lighter';
    ctx.translate(x, y);
    ctx.rotate(rotation);
    ctx.drawImage(
      sprite,
      sourceFrame * fw,
      0,
      fw,
      sprite.naturalHeight,
      -size * anchorX,
      -size / 2,
      size,
      size,
    );
    ctx.restore();
    return true;
  }

  /** Rectangular six-frame VFX for directional lanes and beams. Unlike the
   * square helper this preserves a long charge silhouette without stretching
   * its thickness to match the travel distance. */
  private drawVfxFrameRect(
    ctx: CanvasRenderingContext2D,
    sprite: HTMLImageElement | null,
    frame: number,
    x: number,
    y: number,
    width: number,
    height: number,
    rotation = 0,
    alpha = 1,
    additive = false,
  ): boolean {
    if (!sprite || !sprite.complete || sprite.naturalWidth <= 0) return false;
    const frames = 6;
    const fw = sprite.naturalWidth / frames;
    const sourceFrame = clamp(Math.floor(frame), 0, frames - 1);
    ctx.save();
    ctx.globalAlpha = clamp(alpha, 0, 1);
    if (additive) ctx.globalCompositeOperation = 'lighter';
    ctx.translate(x, y);
    ctx.rotate(rotation);
    ctx.drawImage(sprite, sourceFrame * fw, 0, fw, sprite.naturalHeight, -width / 2, -height / 2, width, height);
    ctx.restore();
    return true;
  }

  /** Ground decals share world perspective instead of looking like upright UI. */
  private drawGroundVfxFrame(
    ctx: CanvasRenderingContext2D,
    sprite: HTMLImageElement | null,
    frame: number,
    x: number,
    y: number,
    diameter: number,
    alpha = 1,
  ): boolean {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(1, TILT);
    const drawn = this.drawVfxFrame(ctx, sprite, frame, 0, 0, diameter, 0, alpha, false);
    ctx.restore();
    return drawn;
  }

  /** Compact stadium-scoreboard health bar. It uses only pooled canvas work,
   *  so large late-game crowds remain mobile-safe. */
  private drawEnemyHealthBar(
    ctx: CanvasRenderingContext2D,
    e: Enemy,
    x: number,
    y: number,
    time: number,
    widthScale = 1,
    alphaScale = 1,
    anchorX = x,
    anchorY = y,
  ): void {
    const style = enemyHealthBarStyle(e);
    const ratio = style.ratio;
    const w = style.width * widthScale;
    const h = style.height * (widthScale < 1 ? 0.82 : 1);
    if (x + w / 2 < -12 || x - w / 2 > this.canvas.width + 12 || y < -30 || y > this.canvas.height + 12) return;

    const left = Math.round(x - w / 2);
    const top = Math.round(y);
    const low = ratio <= 0.25;
    const hit = e.flash > 0 || e.hurtT > 0;
    const fill = ratio > 0.58 ? '#45dc86' : ratio > 0.28 ? '#ffc247' : '#ff4d61';
    const pulse = low ? 0.72 + Math.sin(time * 11 + e.x * 0.01) * 0.2 : 0.88;

    ctx.save();
    const visibility = (e.boss || e.elite || ratio < 0.999 ? 1 : 0.84) * alphaScale;
    ctx.globalAlpha = visibility;
    if (Math.hypot(anchorX - x, anchorY - y) > 8) {
      // A displaced dense-crowd plate remains unambiguously attached to its
      // actor. The curved stem is intentionally quiet and disappears when the
      // normal close-to-head placement is available.
      ctx.globalAlpha = 0.3 * alphaScale;
      ctx.strokeStyle = style.accent;
      ctx.lineWidth = 0.85;
      ctx.beginPath();
      ctx.moveTo(x, top + h + 4);
      ctx.quadraticCurveTo((x + anchorX) / 2, anchorY - 4, anchorX, anchorY + h / 2);
      ctx.stroke();
      ctx.globalAlpha = 0.52 * alphaScale;
      ctx.fillStyle = style.accent;
      ctx.beginPath();
      ctx.arc(anchorX, anchorY + h / 2, 1.25, 0, TAU);
      ctx.fill();
      ctx.globalAlpha = visibility;
    }
    if (e.boss || e.elite) {
      ctx.shadowColor = e.boss ? 'rgba(255,45,76,0.48)' : 'rgba(255,210,63,0.42)';
      ctx.shadowBlur = e.boss ? 9 : 6;
    }

    // Metal outer casing and inset dark track.
    ctx.fillStyle = 'rgba(5,10,14,0.9)';
    ctx.beginPath();
    ctx.roundRect(left - 3, top - 3, w + 6, h + 6, h / 2 + 3);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = hit ? '#ffffff' : style.accent;
    ctx.lineWidth = hit ? 2 : e.boss || e.elite ? 1.6 : 1.15;
    ctx.stroke();

    ctx.fillStyle = 'rgba(20,28,34,0.96)';
    ctx.beginPath();
    ctx.roundRect(left, top, w, h, h / 2);
    ctx.fill();

    // A pale delayed chip shows exactly how much the latest hit removed before
    // easing down to the real value. This makes burst damage legible in crowds.
    const trailRatio = clamp(e.maxHp > 0 ? e.barHp / e.maxHp : ratio, ratio, 1);
    const trailW = w * trailRatio;
    if (trailW > w * ratio + 0.5) {
      ctx.fillStyle = e.boss ? '#ffd0d7' : e.elite ? '#fff0a8' : '#dcecf2';
      ctx.globalAlpha = 0.88 * alphaScale;
      ctx.beginPath();
      ctx.roundRect(left, top, trailW, h, Math.min(h / 2, trailW / 2));
      ctx.fill();
      ctx.globalAlpha = visibility;
    }

    const fillW = Math.max(ratio > 0 ? 2 : 0, w * ratio);
    if (fillW > 0) {
      ctx.globalAlpha *= pulse;
      ctx.fillStyle = fill;
      ctx.beginPath();
      ctx.roundRect(left, top, fillW, h, Math.min(h / 2, fillW / 2));
      ctx.fill();
      // Highlight strip makes the bar feel like a physical enamel scoreboard.
      ctx.globalAlpha *= 0.72;
      ctx.fillStyle = 'rgba(255,255,255,0.48)';
      ctx.beginPath();
      ctx.roundRect(left + 1, top + 1, Math.max(0, fillW - 2), Math.max(1, h * 0.28), h / 4);
      ctx.fill();
    }

    ctx.globalAlpha = (e.boss || e.elite || ratio < 0.999 ? 0.48 : 0.32) * alphaScale;
    ctx.strokeStyle = '#071015';
    ctx.lineWidth = 1;
    for (let segment = 1; segment < 4; segment++) {
      const sx = left + (w * segment) / 4;
      ctx.beginPath();
      ctx.moveTo(sx, top + 1);
      ctx.lineTo(sx, top + h - 1);
      ctx.stroke();
    }

    // Status pips: purple = stunned, cyan = slowed, blue chevron = airborne.
    const statuses: Array<{ color: string; kind: 'dot' | 'air' }> = [];
    if (e.stun > 0) statuses.push({ color: '#c78cff', kind: 'dot' });
    if (e.slow > 0) statuses.push({ color: '#5cecff', kind: 'dot' });
    if (e.airT > 0 || (e.def.behavior === 'aerial' && e.aerialGroundT <= 0)) statuses.push({ color: '#7ca8ff', kind: 'air' });
    statuses.forEach((status, index) => {
      const sx = left + w + 8 + index * 9;
      const sy = top + h / 2;
      ctx.globalAlpha = 0.95 * alphaScale;
      ctx.fillStyle = status.color;
      ctx.strokeStyle = '#061016';
      ctx.lineWidth = 2;
      ctx.beginPath();
      if (status.kind === 'air') {
        ctx.moveTo(sx, sy - 4);
        ctx.lineTo(sx + 4, sy + 3);
        ctx.lineTo(sx - 4, sy + 3);
        ctx.closePath();
      } else {
        ctx.arc(sx, sy, 3.5, 0, TAU);
      }
      ctx.fill();
      ctx.stroke();
    });

    // Tiny rotated crest anchors the bar to the game's football presentation.
    ctx.globalAlpha = alphaScale;
    ctx.translate(left - 5, top + h / 2);
    ctx.rotate(Math.PI / 4);
    ctx.fillStyle = style.accent;
    ctx.fillRect(-3.5, -3.5, 7, 7);
    ctx.fillStyle = '#111a20';
    ctx.fillRect(-1.5, -1.5, 3, 3);
    ctx.rotate(-Math.PI / 4);
    ctx.translate(-(left - 5), -(top + h / 2));

    if (style.numeric) {
      ctx.font = `800 ${e.boss ? 10 : 8}px "Space Grotesk", system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(4,8,12,0.9)';
      const label = `${Math.ceil(Math.max(0, e.hp)).toLocaleString()} HP`;
      ctx.strokeText(label, x, top - 4);
      ctx.fillStyle = e.boss ? '#fff2f4' : '#fff1b3';
      ctx.fillText(label, x, top - 4);
    }
    ctx.restore();
  }

  /** Draws the generated four-frame match ball strip, with a procedural
   * fallback while the asset is loading. */
  private drawMatchBall(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, frame: number): void {
    const spr = this.matchBallSpr;
    const frames = spr.width >= spr.height * 3.2 ? 4 : 1;
    const fw = spr.width / frames;
    const f = frames === 1 ? 0 : Math.floor(frame) % frames;
    ctx.drawImage(spr, f * fw, 0, fw, spr.height, x - size / 2, y - size / 2, size, size);
  }

  /** Swap in the AI arena plate and rebuild the prerendered world canvas. */
  setArenaImage(
    img: HTMLImageElement,
    grassRect: ArenaGrassRect = PLATE_GRASS,
    liveStadium = false,
    hybridDepth = false,
  ): void {
    this.plate = img;
    this.plateGrass = grassRect;
    this.liveStadium = liveStadium;
    this.hybridDepth = hybridDepth;
    this.pitch = this.buildPitch();
  }

  /** Exposes only the active construction mode for deterministic browser QA. */
  getArenaRenderMode(): { liveStadium: boolean; hybridDepth: boolean } {
    return { liveStadium: this.liveStadium, hybridDepth: this.hybridDepth };
  }

  /** Read-only camera proof for deterministic browser QA. */
  getCameraState(): { x: number; y: number; lookX: number; lookY: number; viewWorldH: number } {
    return {
      x: this.camX,
      y: this.camY,
      lookX: this.hybridLookX,
      lookY: this.hybridLookY,
      viewWorldH: this.viewWorldH,
    };
  }

  /** Read-only visual-priority proof for deterministic browser QA. */
  getPlayerOcclusionStrength(): number {
    return this.lastPlayerOcclusion;
  }

  /** Read-only proof that dense scenes degrade decorative presentation before
   * simulation timing or gameplay information. */
  getCombatPresentationMetrics(): CombatPresentationMetrics {
    return { ...this.lastPresentationMetrics };
  }

  setReducedVfx(enabled: boolean): void {
    this.reducedVfx = !!enabled;
  }

  getReducedVfx(): boolean {
    return this.reducedVfx;
  }

  /** Current CSS-pixel world scale used by screen-space HUD avoidance. */
  getScale(): number {
    const backingToCss = this.canvas.width > 0 ? this.canvas.clientWidth / this.canvas.width : 1;
    return this.scale * backingToCss;
  }

  /** CSS-pixel billboard bounds for HUD collision avoidance. This mirrors the
   * real sprite scale/feet anchor without exposing renderer internals to UI. */
  getEnemyScreenRect(e: Enemy): EntityScreenRect {
    const atlas = this.enemyAtlasFor(e);
    const cssScale = this.getScale();
    const entityScale = ENEMY_ENTITY_SCALE
      * (80 / atlas.fh)
      * (e.boss ? BOSSES[e.boss].scale : e.def.scale)
      * (e.elite ? 1.22 : 1)
      * (this.hybridDepth ? hybridEntityDepthScale(e.y) : 1);
    const centerX = (e.x - this.camX) * cssScale + this.canvas.clientWidth / 2;
    const groundY = (e.y - this.camY) * TILT * cssScale + this.canvas.clientHeight / 2;
    const lift = e.def.behavior === 'aerial'
      ? 42 * aerialOverheatHeightScale(e.aerialGroundT)
      : e.airT > 0 ? 22 : 0;
    const transparentTop = e.boss === 'drumboss'
      ? 62
      : e.boss === 'official' ? 24
        : e.boss === 'captain' ? 20 : 0;
    const top = groundY - (lift + (atlas.feetY - transparentTop) * entityScale) * cssScale;
    const width = atlas.fw * entityScale * cssScale;
    const height = (atlas.fh - transparentTop) * entityScale * cssScale;
    return {
      left: centerX - width / 2,
      right: centerX + width / 2,
      top,
      bottom: top + height,
      centerX,
    };
  }

  /** Starts every run from its real spawn instead of easing from the previous
   * run's last sideline position. This resets visual state only. */
  resetCamera(x: number, y: number): void {
    this.camX = Number.isFinite(x) ? x : ARENA_W / 2;
    this.camY = Number.isFinite(y) ? y : ARENA_H / 2;
    this.hybridLookX = 0;
    this.hybridLookY = 0;
    this.viewWorldH = NORMAL_VIEW_WORLD_H;
    this.shake = 0;
  }

  /** A cheap two-pass stadium-light shadow. The tapered cast is directional,
   * while the tiny contact mark is restricted to grounded actors. Keeping it
   * path-based avoids per-enemy blur filters in 100+ threat stress scenes. */
  private drawHybridEntityShadow(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    radius: number,
    kind: HybridShadowKind,
    elevation = 0,
    opacity = 1,
  ): void {
    if (!this.hybridDepth) return;
    const shadow = hybridEntityShadowGeometry(radius, kind, elevation, this.hybridShadowScratch);
    const startX = x + shadow.offsetX;
    const startY = y + shadow.offsetY;
    const endX = startX + shadow.castLength * HYBRID_LIGHT_CAST_X;
    const endY = startY + shadow.castLength * HYBRID_LIGHT_CAST_Y;

    ctx.save();
    ctx.globalAlpha *= clamp(opacity, 0, 1);
    ctx.fillStyle = `rgba(2,12,8,${shadow.alpha * 0.46})`;
    ctx.beginPath();
    ctx.moveTo(startX - shadow.castWidth * 0.68, startY);
    ctx.quadraticCurveTo(
      startX + shadow.castLength * 0.32,
      startY + shadow.castWidth * 0.98,
      endX,
      endY,
    );
    ctx.quadraticCurveTo(
      startX + shadow.castLength * 0.43,
      startY - shadow.castWidth * 0.35,
      startX + shadow.castWidth * 0.68,
      startY,
    );
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = `rgba(2,12,8,${shadow.alpha})`;
    ctx.beginPath();
    ctx.moveTo(startX - shadow.castWidth * 0.5, startY + 0.4);
    ctx.quadraticCurveTo(
      startX + shadow.castLength * 0.28,
      startY + shadow.castWidth * 0.52,
      endX - shadow.castLength * 0.13,
      endY - shadow.castLength * 0.08,
    );
    ctx.quadraticCurveTo(
      startX + shadow.castLength * 0.35,
      startY - shadow.castWidth * 0.18,
      startX + shadow.castWidth * 0.5,
      startY + 0.4,
    );
    ctx.closePath();
    ctx.fill();

    if (shadow.contactAlpha > 0.001) {
      ctx.fillStyle = `rgba(2,14,8,${shadow.contactAlpha})`;
      ctx.beginPath();
      ctx.ellipse(x, y + 1, shadow.castWidth * 0.48, Math.max(1.3, shadow.castWidth * 0.17), 0.05, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }

  /** Enemy visuals: generated 2.5D strip when available, else the procedural atlas. */
  private enemyAtlasFor(e: { def: EnemyDef; boss: '' | BossId; variant: 0 | 1 | 2 }): Atlas {
    const id = e.boss
      ? `boss-${e.boss}`
      : e.def.id === 'invader' && e.variant === 1 ? 'invader-ultra'
        : e.def.id === 'invader' && e.variant === 2 ? 'invader-away'
          : e.def.id;
    const strip = getStripAtlas(id);
    if (strip) return strip;
    void loadStripAtlas(id, `art/enemies/${id}.png`);
    return e.boss ? bossAtlas(e.boss) : enemyAtlas(e.def.id as Parameters<typeof enemyAtlas>[0]);
  }

  /** Dedicated six-frame locomotion art. Semantic idle/attack/hurt strips are
   * kept separate so an enemy never appears to run while standing still. */
  private enemyRunAtlasFor(e: Pick<Enemy, 'def' | 'boss' | 'variant' | 'moveDx' | 'moveDy'>): Atlas | null {
    // The drone is a hovering machine, not a footstep character. Holding its
    // clean thrust pose and animating roll/height continuously avoids the
    // clipped, off-centre cells in the generated locomotion strip.
    if (e.def.id === 'drone') return null;
    if (e.boss) {
      const direction = movementDirection(e.moveDx, e.moveDy);
      const directionalId = `boss-directional-${e.boss}-${direction}`;
      const directional = getStripAtlas(directionalId);
      if (directional) {
        trimStripAtlasCache('boss-directional-', directionalId, 6);
        return directional;
      }
      void loadStripAtlas(
        directionalId,
        `art/enemies/directional-v2/boss-${e.boss}/${direction}.webp`,
        undefined,
        {
          frameWidth: BOSS_DIRECTION_FRAME_WIDTH,
          frameHeight: 320,
          feetY: 312,
          minFrames: 12,
          maxFrames: 12,
          buildEffects: false,
          alignOpaqueBottom: true,
        },
      ).then(() => trimStripAtlasCache('boss-directional-', directionalId, 6));
      const fallbackId = `boss-${e.boss}-run`;
      const fallback = getStripAtlas(fallbackId);
      if (fallback) return fallback;
      void loadStripAtlas(fallbackId, `art/enemies/boss-${e.boss}-run.png`);
      return null;
    }
    const id = e.boss
      ? `boss-${e.boss}`
      : e.def.id === 'invader' && e.variant === 1 ? 'invader-ultra'
        : e.def.id === 'invader' && e.variant === 2 ? 'invader-away'
          : e.def.id;
    const runId = `${id}-run`;
    const strip = getStripAtlas(runId);
    if (strip) return strip;
    void loadStripAtlas(runId, `art/enemies/${id}-run.png`);
    return null;
  }

  /** White blinding flash (paparazzo). */
  flashWhite(): void {
    this.flashWhiteT = this.reducedVfx ? 0.11 : 0.28;
  }

  addShake(amount: number): void {
    this.shake = Math.min(14, this.shake + amount * (this.reducedVfx ? 0.42 : 1));
  }

  warnFlash(): void {
    this.flashWarn = this.reducedVfx ? 0.24 : 0.42;
  }

  /** Draw only the alpha contour of the exact live player pose above world
   * VFX. The body remains in painter order; this locator restores position
   * information without turning the hero into a permanently topmost sticker. */
  private drawPlayerOcclusionLocator(
    ctx: CanvasRenderingContext2D,
    atlas: Atlas,
    frame: number,
    x: number,
    y: number,
    scale: number,
    bobY: number,
    flip: boolean,
    strength: number,
  ): void {
    const dw = atlas.fw * scale;
    const dh = atlas.fh * scale;
    const pad = 7;
    const width = Math.max(1, Math.ceil(dw) + pad * 2);
    const height = Math.max(1, Math.ceil(dh) + pad * 2);
    if (this.playerOcclusionMask.width !== width || this.playerOcclusionMask.height !== height) {
      this.playerOcclusionMask.width = width;
      this.playerOcclusionMask.height = height;
      this.playerOcclusionOutline.width = width;
      this.playerOcclusionOutline.height = height;
    }
    const mask = this.playerOcclusionMask.getContext('2d')!;
    mask.setTransform(1, 0, 0, 1, 0, 0);
    mask.clearRect(0, 0, width, height);
    mask.save();
    if (flip) {
      mask.translate(width, 0);
      mask.scale(-1, 1);
    }
    const safeFrame = Math.max(0, Math.min(atlas.frames - 1, frame));
    mask.drawImage(atlas.flash, safeFrame * atlas.fw, 0, atlas.fw, atlas.fh, pad, pad, dw, dh);
    mask.restore();
    mask.globalCompositeOperation = 'source-in';
    mask.fillStyle = '#d9ffe5';
    mask.fillRect(0, 0, width, height);
    mask.globalCompositeOperation = 'source-over';

    const outline = this.playerOcclusionOutline.getContext('2d')!;
    outline.setTransform(1, 0, 0, 1, 0, 0);
    outline.clearRect(0, 0, width, height);
    const offsets = [[-3, 0], [3, 0], [0, -3], [0, 3], [-2, -2], [2, -2], [-2, 2], [2, 2]] as const;
    for (const [ox, oy] of offsets) outline.drawImage(this.playerOcclusionMask, ox, oy);
    outline.globalCompositeOperation = 'destination-out';
    outline.drawImage(this.playerOcclusionMask, 0, 0);
    outline.globalCompositeOperation = 'source-over';

    ctx.save();
    ctx.globalAlpha = 0.48 + strength * 0.47;
    ctx.shadowColor = 'rgba(3, 18, 10, 0.92)';
    ctx.shadowBlur = 5;
    ctx.drawImage(
      this.playerOcclusionOutline,
      x - dw / 2 - pad,
      y - atlas.feetY * scale + bobY - pad,
    );
    ctx.restore();
  }

  playMatchdayWipeout(): void {
    this.matchdayWipeoutStartedAt = performance.now() / 1000;
  }

  playAbilityUpgrade(max: boolean): void {
    this.abilityUpgradeStartedAt = performance.now() / 1000;
    this.abilityUpgradeMax = max;
  }

  playKeeperBlock(x: number, y: number, counter: boolean): void {
    this.keeperBlockStartedAt = performance.now() / 1000;
    this.keeperBlockX = x;
    this.keeperBlockY = y;
    this.keeperBlockCounter = counter;
  }

  playScanImpact(x: number, y: number): void {
    this.scanImpactStartedAt = performance.now() / 1000;
    this.scanImpactX = x;
    this.scanImpactY = y;
  }

  /* ------------------------------------------------------------------ */

  private buildPitch(): HTMLCanvasElement {
    // Margins around the playable arena that the base layer covers. The arena
    // plate supplies its own asymmetric surround (stands/track/tunnel), so the
    // world canvas and the camera bounds derive from the measured grass rect.
    let ml = MARGIN;
    let mr = MARGIN;
    let mt = MARGIN;
    let mb = MARGIN;
    let psx = 1;
    let psy = 1;
    if (this.plate) {
      psx = ARENA_W / this.plateGrass.w;
      psy = ARENA_H / this.plateGrass.h;
      ml = this.plateGrass.x * psx;
      mr = (this.plate.width - this.plateGrass.x - this.plateGrass.w) * psx;
      mt = this.plateGrass.y * psy;
      mb = (this.plate.height - this.plateGrass.y - this.plateGrass.h) * psy;
    }
    this.bounds = { x0: -ml, y0: -mt, x1: ARENA_W + mr, y1: ARENA_H + mb };
    const w = ARENA_W + ml + mr;
    const h = ARENA_H + mt + mb;
    const c = document.createElement('canvas');
    c.width = Math.ceil(w);
    c.height = Math.ceil(h * TILT);
    const ctx = c.getContext('2d')!;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.setTransform(1, 0, 0, TILT, 0, 0);
    ctx.translate(ml, mt);

    if (this.plate) {
      // The authored arena plate's measured grass rect maps exactly onto the
      // playable arena. A slight non-uniform scale absorbs each source plate's
      // aspect difference while its stands fill the surrounding margin.
      ctx.drawImage(this.plate, -this.plateGrass.x * psx, -this.plateGrass.y * psy, this.plate.width * psx, this.plate.height * psy);
      if (this.liveStadium) {
        // Broadcast-grade the photographed turf toward a fresher World Cup
        // green while retaining every source-pixel highlight and worn patch.
        // Alternating translucent passes reinforce the mower direction at the
        // same 112-unit cadence used by the authored blade clusters.
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, ARENA_W, ARENA_H);
        ctx.clip();
        ctx.fillStyle = 'rgba(52,112,24,0.145)';
        ctx.fillRect(0, 0, ARENA_W, ARENA_H);
        for (let strip = 0; strip < Math.ceil(ARENA_W / 112); strip++) {
          ctx.fillStyle = strip % 2 === 0
            ? 'rgba(221,226,130,0.020)'
            : 'rgba(8,54,18,0.026)';
          ctx.fillRect(strip * 112, 0, 112, ARENA_H);
        }
        const broadcastFalloff = ctx.createLinearGradient(0, 0, 0, ARENA_H);
        broadcastFalloff.addColorStop(0, 'rgba(248,242,170,0.018)');
        broadcastFalloff.addColorStop(0.48, 'rgba(255,255,222,0.010)');
        broadcastFalloff.addColorStop(1, 'rgba(10,37,13,0.028)');
        ctx.fillStyle = broadcastFalloff;
        ctx.fillRect(0, 0, ARENA_W, ARENA_H);
        ctx.restore();
      }
    } else {
    // surround apron
    ctx.fillStyle = '#0d2818';
    ctx.fillRect(-MARGIN, -MARGIN, w, h);

    // crowd stands: rows of dots in the margin ring
    const crowdColors = ['#d8d3c8', '#c46a5a', '#5a7bc4', '#c4b45a', '#7ac48a', '#b08ac4', '#e0e0e0', '#8a94a6'];
    const rng = (() => {
      let s = 1234567;
      return () => {
        s = (s * 1103515245 + 12345) & 0x7fffffff;
        return s / 0x7fffffff;
      };
    })();
    for (let row = 0; row < 22; row++) {
      const inset = 30 + row * 13;
      const density = 0.55;
      // top & bottom rows
      for (let x = -MARGIN + inset; x < ARENA_W + MARGIN - inset; x += 9) {
        if (rng() > density) continue;
        const yTop = -MARGIN + inset + rng() * 8;
        const yBot = ARENA_H + MARGIN - inset - rng() * 8;
        ctx.fillStyle = crowdColors[(rng() * crowdColors.length) | 0];
        ctx.fillRect(x, yTop, 5.5, 5.5);
        if (rng() > density) {
          ctx.fillStyle = crowdColors[(rng() * crowdColors.length) | 0];
          ctx.fillRect(x, yBot, 5.5, 5.5);
        }
      }
      // left & right rows
      for (let y = -MARGIN + inset; y < ARENA_H + MARGIN - inset; y += 9) {
        if (rng() > density) continue;
        ctx.fillStyle = crowdColors[(rng() * crowdColors.length) | 0];
        ctx.fillRect(-MARGIN + inset + rng() * 8, y, 5.5, 5.5);
        if (rng() > density) {
          ctx.fillStyle = crowdColors[(rng() * crowdColors.length) | 0];
          ctx.fillRect(ARENA_W + MARGIN - inset - rng() * 8, y, 5.5, 5.5);
        }
      }
    }

    // ad boards ring
    ctx.fillStyle = '#101820';
    ctx.fillRect(-70, -70, ARENA_W + 140, 26);
    ctx.fillRect(-70, ARENA_H + 44, ARENA_W + 140, 26);
    ctx.fillRect(-70, -44, 26, ARENA_H + 88);
    ctx.fillRect(ARENA_W + 44, -44, 26, ARENA_H + 88);
    const ads = ['FOOTBALL FIGHTING', 'KICK ENERGY', 'STRIKE COLA', 'BOOTS & CO', 'TERRACE TV', 'MATCHDAY'];
    ctx.font = 'bold 17px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    const boardW = (ARENA_W + 140) / 6;
    for (let i = 0; i < 6; i++) {
      ctx.fillStyle = i % 2 === 0 ? '#ffd23f' : '#4cc9f0';
      ctx.textAlign = 'center';
      ctx.fillText(ads[i], -70 + boardW * (i + 0.5), -56);
      ctx.fillText(ads[5 - i], -70 + boardW * (i + 0.5), ARENA_H + 58);
    }
    ctx.save();
    ctx.translate(-56, ARENA_H / 2);
    ctx.rotate(-Math.PI / 2);
    for (let i = 0; i < 4; i++) {
      ctx.fillStyle = i % 2 === 0 ? '#e8283f' : '#f5f7fa';
      ctx.fillText(ads[i], -(ARENA_H / 4) * (i - 1.5), 0);
    }
    ctx.restore();
    ctx.save();
    ctx.translate(ARENA_W + 58, ARENA_H / 2);
    ctx.rotate(Math.PI / 2);
    for (let i = 0; i < 4; i++) {
      ctx.fillStyle = i % 2 === 0 ? '#80ed99' : '#ffd23f';
      ctx.fillText(ads[i + 2], -(ARENA_H / 4) * (i - 1.5), 0);
    }
    ctx.restore();

    // grass with mowed stripes
    for (let i = 0; i < Math.ceil(ARENA_W / 170); i++) {
      ctx.fillStyle = i % 2 === 0 ? '#2e8b47' : '#2a8042';
      ctx.fillRect(i * 170, 0, 170, ARENA_H);
    }
    // subtle noise
    for (let i = 0; i < 2600; i++) {
      ctx.fillStyle = `rgba(0,0,0,${0.03 + rng() * 0.05})`;
      ctx.fillRect(rng() * ARENA_W, rng() * ARENA_H, 3, 3);
    }
    // mowing arcs (alternating circular cut pattern for richness)
    for (let i = 0; i < 7; i++) {
      const ax = ARENA_W * (0.12 + i * 0.14);
      const dir = i % 2 === 0 ? 1 : -1;
      ctx.strokeStyle = 'rgba(255,255,255,0.028)';
      ctx.lineWidth = 90;
      ctx.beginPath();
      ctx.arc(ax, ARENA_H / 2, 420 + i * 30, dir > 0 ? -Math.PI / 2.6 : Math.PI / 2.6, dir > 0 ? Math.PI / 2.6 : Math.PI - Math.PI / 2.6, dir < 0);
      ctx.stroke();
    }
    // worn scuffs near heavy-traffic zones
    for (let i = 0; i < 60; i++) {
      const zones = [
        [ARENA_W / 2, ARENA_H / 2, 260],
        [40 + 230, ARENA_H / 2, 200],
        [ARENA_W - 40 - 230, ARENA_H / 2, 200],
      ];
      const z = zones[i % 3];
      const a = rng() * TAU;
      const r = rng() * z[2];
      ctx.fillStyle = `rgba(90,60,30,${0.04 + rng() * 0.05})`;
      ctx.beginPath();
      ctx.ellipse(z[0] + Math.cos(a) * r, z[1] + Math.sin(a) * r, 4 + rng() * 14, 3 + rng() * 8, rng() * 3, 0, TAU);
      ctx.fill();
    }
    } // end procedural fallback base

    if (this.liveStadium) {
      // A final code-built nap survives WebP resampling as distinct grass
      // blades. It is baked into the pitch canvas once (never per frame), uses
      // a fixed generator and follows the alternating mower direction. Paired
      // root shadows and fine lit edges keep the fibres physical at gameplay
      // scale without becoming a noisy particle field.
      let turfSeed = 0x47a91f2d;
      const turfRandom = (): number => {
        turfSeed = (Math.imul(turfSeed, 1664525) + 1013904223) >>> 0;
        return turfSeed / 0x100000000;
      };
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, ARENA_W, ARENA_H);
      ctx.clip();
      ctx.lineCap = 'round';
      const ellipticalWear = (x: number, y: number, cx: number, cy: number, rx: number, ry: number): number => {
        const dx = (x - cx) / rx;
        const dy = (y - cy) / ry;
        return Math.max(0, 1 - Math.sqrt(dx * dx + dy * dy));
      };
      for (let blade = 0; blade < 9_600; blade++) {
        const x = 10 + turfRandom() * (ARENA_W - 20);
        const y = 10 + turfRandom() * (ARENA_H - 20);
        const densityWave = (
          Math.sin(x * 0.0107 + y * 0.0041)
          + Math.cos(y * 0.0129 - x * 0.0037)
        ) * 0.5;
        if (turfRandom() > 0.72 + densityWave * 0.08) continue;
        const mowerDirection = Math.floor(x / 112) % 2 === 0 ? 1 : -1;
        const trafficWear = Math.max(
          ellipticalWear(x, y, ARENA_W * 0.5, ARENA_H * 0.5, 370, 225),
          ellipticalWear(x, y, 138, ARENA_H * 0.5, 220, 330),
          ellipticalWear(x, y, ARENA_W - 138, ARENA_H * 0.5, 220, 330),
        );
        if (trafficWear > 0.08 && turfRandom() < trafficWear * 0.58) {
          const flattenedDirection = turfRandom() < 0.5 ? -1 : 1;
          const flattenedLength = 3.2 + turfRandom() * (4.2 + trafficWear * 3.8);
          const flattenedLift = (turfRandom() - 0.5) * (1.4 - trafficWear * 0.65);
          const flattenedAlpha = 0.036 + turfRandom() * 0.038;
          ctx.strokeStyle = `rgba(28,38,10,${flattenedAlpha * (0.85 + trafficWear * 0.35)})`;
          ctx.lineWidth = 0.72;
          ctx.beginPath();
          ctx.moveTo(x + 0.65, y + 0.65);
          ctx.quadraticCurveTo(
            x + flattenedDirection * flattenedLength * 0.46,
            y + flattenedLift * 0.45 + 0.65,
            x + flattenedDirection * flattenedLength,
            y + flattenedLift + 0.65,
          );
          ctx.stroke();
          ctx.strokeStyle = `rgba(198,201,116,${flattenedAlpha * 0.72})`;
          ctx.lineWidth = 0.5;
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.quadraticCurveTo(
            x + flattenedDirection * flattenedLength * 0.46,
            y + flattenedLift * 0.45,
            x + flattenedDirection * flattenedLength,
            y + flattenedLift,
          );
          ctx.stroke();
          continue;
        }
        const length = 2.1 + turfRandom() * 3.8;
        const bend = mowerDirection * (0.35 + turfRandom() * 1.25) + (turfRandom() - 0.5) * 0.7;
        const lift = length * (0.82 + turfRandom() * 0.16);
        const alpha = 0.045 + turfRandom() * 0.05;
        ctx.strokeStyle = `rgba(32,42,12,${alpha * 0.72})`;
        ctx.lineWidth = 0.76;
        ctx.beginPath();
        ctx.moveTo(x + 0.75, y + 0.55);
        ctx.quadraticCurveTo(x + bend * 0.42 + 0.75, y - lift * 0.48 + 0.55, x + bend + 0.75, y - lift + 0.55);
        ctx.stroke();
        ctx.strokeStyle = `rgba(223,224,145,${alpha})`;
        ctx.lineWidth = 0.58;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.quadraticCurveTo(x + bend * 0.42, y - lift * 0.48, x + bend, y - lift);
        ctx.stroke();
        if (blade % 17 === 0) {
          const siblingLean = bend * 0.62 - mowerDirection * 0.9;
          ctx.strokeStyle = `rgba(191,198,106,${alpha * 0.72})`;
          ctx.lineWidth = 0.52;
          ctx.beginPath();
          ctx.moveTo(x + 0.9, y + 0.2);
          ctx.quadraticCurveTo(x + siblingLean * 0.45, y - lift * 0.31, x + siblingLean, y - lift * 0.72);
          ctx.stroke();
        }
      }
      ctx.restore();

      // Low, directional blade clusters break up the remaining flat plate
      // without turning the grass into uniform noise. Each tuft has a dark
      // root and two short highlights, follows the local mowing direction and
      // becomes sparser in the three heaviest traffic zones. This is baked
      // once into the pitch canvas, so the extra physical detail is free in
      // the combat loop and remains stable under camera movement.
      let tuftSeed = 0x9e3779b9;
      const tuftRandom = (): number => {
        tuftSeed = (Math.imul(tuftSeed, 1103515245) + 12345) >>> 0;
        return tuftSeed / 0x100000000;
      };
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, ARENA_W, ARENA_H);
      ctx.clip();
      ctx.lineCap = 'round';
      for (let tuft = 0; tuft < 3_100; tuft++) {
        const x = 7 + tuftRandom() * (ARENA_W - 14);
        const y = 7 + tuftRandom() * (ARENA_H - 14);
        const centreWear = ellipticalWear(x, y, ARENA_W * 0.5, ARENA_H * 0.5, 390, 245);
        const leftWear = ellipticalWear(x, y, 138, ARENA_H * 0.5, 230, 345);
        const rightWear = ellipticalWear(x, y, ARENA_W - 138, ARENA_H * 0.5, 230, 345);
        const wear = Math.max(centreWear, leftWear, rightWear);
        if (tuftRandom() < wear * 0.52) continue;
        const mowerDirection = Math.floor(x / 112) % 2 === 0 ? 1 : -1;
        const baseLean = mowerDirection * (0.55 + tuftRandom() * 1.1);
        const length = 2.4 + tuftRandom() * 2.8;
        const rootAlpha = 0.038 + tuftRandom() * 0.024;
        ctx.strokeStyle = `rgba(24,34,9,${rootAlpha})`;
        ctx.lineWidth = 1.05;
        ctx.beginPath();
        ctx.moveTo(x - 0.55, y + 0.65);
        ctx.lineTo(x + 1.35, y + 0.45);
        ctx.stroke();
        for (let blade = 0; blade < 2; blade++) {
          const offset = blade * 1.15 - 0.55;
          const lean = baseLean + (blade === 0 ? -0.7 : 0.6) + (tuftRandom() - 0.5) * 0.45;
          const lift = length * (0.72 + blade * 0.16);
          ctx.strokeStyle = blade === 0
            ? `rgba(196,203,111,${0.048 + tuftRandom() * 0.035})`
            : `rgba(228,224,145,${0.038 + tuftRandom() * 0.029})`;
          ctx.lineWidth = 0.5;
          ctx.beginPath();
          ctx.moveTo(x + offset, y);
          ctx.quadraticCurveTo(
            x + offset + lean * 0.46,
            y - lift * 0.52,
            x + offset + lean,
            y - lift,
          );
          ctx.stroke();
        }
      }
      ctx.restore();

      // A broken fringe of real blades bridges the flat turf plate and the
      // stadium apron. Roots stay just inside the playable field while tips
      // cross the four source-image seams by a few world units, removing the
      // ruler-straight cut-out edge without creating a gameplay border.
      let edgeSeed = 0x6d2b79f5;
      const edgeRandom = (): number => {
        edgeSeed = (Math.imul(edgeSeed, 1664525) + 1013904223) >>> 0;
        return edgeSeed / 0x100000000;
      };
      const edgeBlade = (x: number, y: number, outwardX: number, outwardY: number, index: number): void => {
        if (index % 7 === 3 || edgeRandom() < 0.12) return;
        const tangentX = -outwardY;
        const tangentY = outwardX;
        const rootInset = 0.8 + edgeRandom() * 2.2;
        const reach = 1.5 + edgeRandom() * 3.7;
        const sideLean = (edgeRandom() - 0.5) * 2.8;
        const rootX = x - outwardX * rootInset;
        const rootY = y - outwardY * rootInset;
        const tipX = x + outwardX * reach + tangentX * sideLean;
        const tipY = y + outwardY * reach + tangentY * sideLean;
        ctx.strokeStyle = `rgba(16,33,8,${0.10 + edgeRandom() * 0.055})`;
        ctx.lineWidth = 1.05;
        ctx.beginPath();
        ctx.moveTo(rootX + 0.65, rootY + 0.55);
        ctx.quadraticCurveTo(x + tangentX * sideLean * 0.35 + 0.65, y + 0.55, tipX + 0.65, tipY + 0.55);
        ctx.stroke();
        ctx.strokeStyle = `rgba(185,201,105,${0.075 + edgeRandom() * 0.06})`;
        ctx.lineWidth = 0.56;
        ctx.beginPath();
        ctx.moveTo(rootX, rootY);
        ctx.quadraticCurveTo(x + tangentX * sideLean * 0.35, y, tipX, tipY);
        ctx.stroke();
      };
      ctx.save();
      ctx.lineCap = 'round';
      for (let x = 4, index = 0; x < ARENA_W - 3; x += 8.2, index++) {
        edgeBlade(x, 0, 0, -1, index);
        edgeBlade(x + 3.7, ARENA_H, 0, 1, index + 337);
      }
      for (let y = 4, index = 0; y < ARENA_H - 3; y += 8.1, index++) {
        edgeBlade(0, y, -1, 0, index + 677);
        edgeBlade(ARENA_W, y + 3.5, 1, 0, index + 863);
      }
      ctx.restore();
    }

    // Chalk markings: thinner, slightly translucent and softly grounded into
    // the turf so they read as painted grass rather than bright UI strokes.
    ctx.strokeStyle = 'rgba(245,247,250,0.74)';
    ctx.fillStyle = 'rgba(245,247,250,0.76)';
    ctx.lineWidth = 3.2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.shadowColor = 'rgba(5,32,14,0.6)';
    ctx.shadowBlur = 2;
    ctx.shadowOffsetY = 1;
    ctx.strokeRect(40, 40, ARENA_W - 80, ARENA_H - 80);
    // halfway line + center circle
    ctx.beginPath();
    ctx.moveTo(ARENA_W / 2, 40);
    ctx.lineTo(ARENA_W / 2, ARENA_H - 40);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(ARENA_W / 2, ARENA_H / 2, 190, 0, TAU);
    ctx.stroke();
    const paintedSpot = (x: number, y: number, seed: number): void => {
      ctx.fillStyle = 'rgba(245,247,238,0.63)';
      ctx.beginPath();
      for (let segment = 0; segment <= 18; segment++) {
        const angle = (segment / 18) * TAU;
        const radius = 5.4 + Math.sin(seed * 0.73 + segment * 2.17) * 0.75 + Math.cos(segment * 1.31) * 0.32;
        const px = x + Math.cos(angle) * radius;
        const py = y + Math.sin(angle) * radius;
        if (segment === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,244,0.29)';
      ctx.lineWidth = 0.72;
      for (let fibre = -3; fibre <= 3; fibre++) {
        ctx.beginPath();
        ctx.moveTo(x - 3.6, y + fibre * 1.15);
        ctx.lineTo(x + 3.9, y + fibre * 0.96 + ((fibre + seed) % 2) * 0.45);
        ctx.stroke();
      }
      ctx.fillStyle = 'rgba(73,87,34,0.23)';
      for (let chip = 0; chip < 5; chip++) {
        const angle = seed + chip * 2.31;
        const radius = 1.5 + (chip % 3) * 1.15;
        ctx.fillRect(x + Math.cos(angle) * radius, y + Math.sin(angle) * radius, 0.9, 0.75);
      }
    };
    paintedSpot(ARENA_W / 2, ARENA_H / 2, 17);
    // penalty boxes
    const boxW = 330;
    const boxH = 820;
    const boxY = (ARENA_H - boxH) / 2;
    ctx.strokeRect(40, boxY, boxW, boxH);
    ctx.strokeRect(ARENA_W - 40 - boxW, boxY, boxW, boxH);
    const sixW = 130;
    const sixH = 420;
    ctx.strokeRect(40, (ARENA_H - sixH) / 2, sixW, sixH);
    ctx.strokeRect(ARENA_W - 40 - sixW, (ARENA_H - sixH) / 2, sixW, sixH);
    // penalty spots + arcs
    paintedSpot(40 + 230, ARENA_H / 2, 29);
    paintedSpot(ARENA_W - 40 - 230, ARENA_H / 2, 41);
    ctx.beginPath();
    ctx.arc(40 + 230, ARENA_H / 2, 150, -Math.PI / 3.2, Math.PI / 3.2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(ARENA_W - 40 - 230, ARENA_H / 2, 150, Math.PI - Math.PI / 3.2, Math.PI + Math.PI / 3.2);
    ctx.stroke();
    // Painted corner arcs follow the same collision-accurate 40-unit radius.
    for (const [cornerX, cornerY, startAngle, endAngle] of [
      [40, 40, 0, Math.PI / 2],
      [ARENA_W - 40, 40, Math.PI / 2, Math.PI],
      [40, ARENA_H - 40, -Math.PI / 2, 0],
      [ARENA_W - 40, ARENA_H - 40, Math.PI, Math.PI * 1.5],
    ] as const) {
      ctx.beginPath();
      ctx.arc(cornerX, cornerY, 42, startAngle, endAngle);
      ctx.stroke();
    }

    // A sparse upper nap makes the white paint belong to the grass instead of
    // reading as a perfectly vector-clean HUD line. All marks are deterministic
    // and stay sub-pixel at normal gameplay zoom.
    const paintedFibre = (x: number, y: number, dx: number, dy: number): void => {
      ctx.strokeStyle = 'rgba(255,255,246,0.20)';
      ctx.lineWidth = 0.85;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + dx, y + dy);
      ctx.stroke();
    };
    for (let y = 48; y < ARENA_H - 45; y += 29) {
      const jitter = ((y * 17) % 9) - 4;
      paintedFibre(40 + jitter * 0.18, y, jitter * 0.09, 3.8);
      paintedFibre(ARENA_W - 40 + jitter * 0.16, y + 7, -jitter * 0.08, 3.4);
      paintedFibre(ARENA_W / 2 + jitter * 0.12, y + 13, jitter * 0.06, 3.7);
    }
    for (let x = 48; x < ARENA_W - 45; x += 31) {
      const jitter = ((x * 13) % 11) - 5;
      paintedFibre(x, 40 + jitter * 0.12, 3.5, jitter * 0.08);
      paintedFibre(x + 11, ARENA_H - 40 + jitter * 0.11, 3.8, -jitter * 0.07);
    }
    for (let angle = 0; angle < TAU; angle += 0.17) {
      const radius = 190 + ((Math.floor(angle * 100) * 7) % 5) - 2;
      const x = ARENA_W / 2 + Math.cos(angle) * radius;
      const y = ARENA_H / 2 + Math.sin(angle) * radius;
      paintedFibre(x, y, Math.cos(angle + 0.34) * 3.2, Math.sin(angle + 0.34) * 3.2);
    }
    if (this.liveStadium) {
      // Tiny olive interruptions and paint crumbs remove the last vector-clean
      // edge from the Showpiece markings. They stay deterministic and much
      // smaller than any collectible or combat decal.
      const paintWear = (x: number, y: number, angle: number, index: number): void => {
        const tangentX = Math.cos(angle);
        const tangentY = Math.sin(angle);
        const normalX = -tangentY;
        const normalY = tangentX;
        const offset = ((index * 17) % 7) - 3;
        const length = 1.2 + ((index * 11) % 5) * 0.34;
        ctx.strokeStyle = `rgba(75,88,35,${0.22 + (index % 3) * 0.045})`;
        ctx.lineWidth = 0.72 + (index % 2) * 0.18;
        ctx.beginPath();
        ctx.moveTo(x + normalX * offset * 0.22, y + normalY * offset * 0.22);
        ctx.lineTo(
          x + tangentX * length + normalX * offset * 0.3,
          y + tangentY * length + normalY * offset * 0.3,
        );
        ctx.stroke();
        if (index % 4 === 0) {
          ctx.fillStyle = 'rgba(251,249,224,0.28)';
          ctx.fillRect(x + normalX * 2.1, y + normalY * 2.1, 1.1, 0.8);
        }
      };
      for (let y = 54, i = 0; y < ARENA_H - 50; y += 37, i++) {
        paintWear(40, y, Math.PI / 2, i);
        paintWear(ARENA_W - 40, y + 11, Math.PI / 2, i + 29);
        paintWear(ARENA_W / 2, y + 19, Math.PI / 2, i + 61);
      }
      for (let x = 55, i = 0; x < ARENA_W - 50; x += 41, i++) {
        paintWear(x, 40, 0, i + 91);
        paintWear(x + 17, ARENA_H - 40, 0, i + 137);
      }
      for (let angle = 0, i = 0; angle < TAU; angle += 0.23, i++) {
        paintWear(
          ARENA_W / 2 + Math.cos(angle) * 190,
          ARENA_H / 2 + Math.sin(angle) * 190,
          angle + Math.PI / 2,
          i + 181,
        );
      }
      const wearRect = (left: number, top: number, width: number, height: number, seed: number): void => {
        let index = seed;
        for (let x = left + 13; x < left + width - 10; x += 43) {
          paintWear(x, top, 0, index++);
          paintWear(x + 19, top + height, 0, index++);
        }
        for (let y = top + 13; y < top + height - 10; y += 39) {
          paintWear(left, y, Math.PI / 2, index++);
          paintWear(left + width, y + 17, Math.PI / 2, index++);
        }
      };
      wearRect(40, boxY, boxW, boxH, 229);
      wearRect(ARENA_W - 40 - boxW, boxY, boxW, boxH, 317);
      wearRect(40, (ARENA_H - sixH) / 2, sixW, sixH, 409);
      wearRect(ARENA_W - 40 - sixW, (ARENA_H - sixH) / 2, sixW, sixH, 461);
      for (let angle = -Math.PI / 3.2, i = 0; angle <= Math.PI / 3.2; angle += 0.17, i++) {
        paintWear(
          40 + 230 + Math.cos(angle) * 150,
          ARENA_H / 2 + Math.sin(angle) * 150,
          angle + Math.PI / 2,
          521 + i,
        );
        const opposite = Math.PI + angle;
        paintWear(
          ARENA_W - 40 - 230 + Math.cos(opposite) * 150,
          ARENA_H / 2 + Math.sin(opposite) * 150,
          opposite + Math.PI / 2,
          559 + i,
        );
      }
      const cornerWearSpecs = [
        [40, 40, 0, Math.PI / 2, 601],
        [ARENA_W - 40, 40, Math.PI / 2, Math.PI, 619],
        [40, ARENA_H - 40, -Math.PI / 2, 0, 637],
        [ARENA_W - 40, ARENA_H - 40, Math.PI, Math.PI * 1.5, 653],
      ] as const;
      for (const [cornerX, cornerY, startAngle, endAngle, seed] of cornerWearSpecs) {
        let index = seed;
        for (let angle = startAngle; angle <= endAngle; angle += 0.19) {
          paintWear(
            cornerX + Math.cos(angle) * 42,
            cornerY + Math.sin(angle) * 42,
            angle + Math.PI / 2,
            index++,
          );
        }
      }

      // Chalk is sprayed onto fibres rather than laid as a vector-perfect
      // ribbon. Sub-pixel pigment crumbs and olive pinholes sit on both sides
      // of the main markings, making them porous at gameplay zoom while their
      // collision-readable silhouette remains unchanged.
      ctx.save();
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;
      const pigmentNoise = (seed: number): number => {
        const value = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
        return value - Math.floor(value);
      };
      const pigmentGrain = (x: number, y: number, tangentX: number, tangentY: number, seed: number): void => {
        const normalX = -tangentY;
        const normalY = tangentX;
        const offset = (pigmentNoise(seed + 0.17) - 0.5) * 4.4;
        const along = (pigmentNoise(seed + 1.93) - 0.5) * 2.2;
        const px = x + normalX * offset + tangentX * along;
        const py = y + normalY * offset + tangentY * along;
        if (seed % 5 === 0 || seed % 11 === 3) {
          ctx.fillStyle = `rgba(66,82,31,${0.16 + pigmentNoise(seed + 4.2) * 0.13})`;
          ctx.fillRect(px, py, 0.75 + pigmentNoise(seed + 7.1) * 0.7, 0.62 + pigmentNoise(seed + 8.3) * 0.55);
        } else {
          ctx.fillStyle = `rgba(255,253,229,${0.14 + pigmentNoise(seed + 5.7) * 0.16})`;
          ctx.fillRect(px, py, 0.55 + pigmentNoise(seed + 3.4) * 0.75, 0.5 + pigmentNoise(seed + 6.8) * 0.58);
        }
      };
      const pigmentLine = (x0: number, y0: number, x1: number, y1: number, count: number, seed: number): void => {
        const dx = x1 - x0;
        const dy = y1 - y0;
        const length = Math.max(1, Math.hypot(dx, dy));
        const tangentX = dx / length;
        const tangentY = dy / length;
        for (let index = 0; index < count; index++) {
          const t = (index + pigmentNoise(seed + index * 3.7)) / count;
          pigmentGrain(x0 + dx * t, y0 + dy * t, tangentX, tangentY, seed + index * 13);
        }
      };
      const pigmentArc = (cx: number, cy: number, radius: number, start: number, end: number, count: number, seed: number): void => {
        for (let index = 0; index < count; index++) {
          const angle = start + (end - start) * ((index + pigmentNoise(seed + index * 2.9)) / count);
          pigmentGrain(
            cx + Math.cos(angle) * radius,
            cy + Math.sin(angle) * radius,
            -Math.sin(angle),
            Math.cos(angle),
            seed + index * 17,
          );
        }
      };
      pigmentLine(40, 40, ARENA_W - 40, 40, 290, 701);
      pigmentLine(40, ARENA_H - 40, ARENA_W - 40, ARENA_H - 40, 290, 1001);
      pigmentLine(40, 40, 40, ARENA_H - 40, 165, 1301);
      pigmentLine(ARENA_W - 40, 40, ARENA_W - 40, ARENA_H - 40, 165, 1471);
      pigmentLine(ARENA_W / 2, 40, ARENA_W / 2, ARENA_H - 40, 170, 1643);
      pigmentArc(ARENA_W / 2, ARENA_H / 2, 190, 0, TAU, 180, 1813);
      ctx.restore();
    }
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;

    // The hybrid markings never animate. Bake them into the same tilted world
    // canvas as the turf so late-game combat pays only the existing pitch blit
    // rather than rebuilding hundreds of chalk/scuff paths every frame.
    if (this.hybridDepth) {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      this.drawHybridPitchMarkings(
        ctx,
        (worldX) => ml + worldX,
        (worldY) => (mt + worldY) * TILT,
      );
      ctx.restore();
    }

    // Goals: layered mesh, ground shadow, rear frame and highlighted posts.
    // The old translucent box read as a UI rectangle rather than a real net.
    for (const side of [0, 1]) {
      const gx = side === 0 ? 40 : ARENA_W - 40;
      const dir = side === 0 ? -1 : 1;
      const frontX = gx;
      const backX = gx + dir * 52;
      const left = Math.min(frontX, backX);
      const top = ARENA_H / 2 - 130;
      const height = 260;
      ctx.save();
      const netDepth = Math.abs(backX - frontX);
      const netShadow = ctx.createLinearGradient(frontX, 0, backX, 0);
      netShadow.addColorStop(0, 'rgba(3,18,10,0.16)');
      netShadow.addColorStop(1, 'rgba(3,18,10,0.42)');
      ctx.fillStyle = netShadow;
      ctx.fillRect(left + 4, top + 7, netDepth, height);
      ctx.fillStyle = 'rgba(235,241,238,0.075)';
      ctx.fillRect(left, top, Math.abs(backX - frontX), height);

      if (!this.liveStadium) {
        ctx.strokeStyle = 'rgba(232,238,235,0.42)';
        ctx.lineWidth = 1.25;
        for (let row = 0; row <= 10; row++) {
          const y = top + (height * row) / 10;
          ctx.beginPath();
          ctx.moveTo(frontX, y);
          ctx.quadraticCurveTo(
            frontX + (backX - frontX) * 0.56,
            y + Math.sin((row / 10) * Math.PI) * 3.2,
            backX,
            y,
          );
          ctx.stroke();
        }
        for (let column = 0; column <= 5; column++) {
          const x = frontX + ((backX - frontX) * column) / 5;
          ctx.beginPath();
          ctx.moveTo(x, top);
          ctx.quadraticCurveTo(x + dir * Math.sin((column / 5) * Math.PI) * 2.6, top + height / 2, x, top + height);
          ctx.stroke();
        }
      }

      // Rear stanchion, diagonal braces and four dark anchor plates establish
      // physical depth without adding a warning ring beneath the goal.
      ctx.strokeStyle = 'rgba(216,223,220,0.72)';
      ctx.lineWidth = 3.2;
      ctx.beginPath();
      ctx.moveTo(backX, top);
      ctx.lineTo(backX, top + height);
      ctx.moveTo(frontX, top);
      ctx.lineTo(backX, top + 17);
      ctx.moveTo(frontX, top + height);
      ctx.lineTo(backX, top + height - 17);
      ctx.stroke();
      for (const anchorY of [top + 8, top + height - 8]) {
        ctx.fillStyle = 'rgba(7,21,13,0.54)';
        ctx.beginPath();
        ctx.ellipse(backX + dir * 2.5, anchorY + 3, 5.5, 3.2, 0, 0, TAU);
        ctx.fill();
        ctx.fillStyle = 'rgba(220,224,211,0.62)';
        ctx.beginPath();
        ctx.arc(backX + dir * 2.5, anchorY + 1.5, 1.35, 0, TAU);
        ctx.fill();
      }

      ctx.strokeStyle = 'rgba(16,35,27,0.48)';
      ctx.lineWidth = 8;
      ctx.beginPath();
      ctx.moveTo(frontX + 4, top + 5);
      ctx.lineTo(frontX + 4, top + height + 5);
      ctx.stroke();
      ctx.strokeStyle = '#f5f7fa';
      ctx.lineWidth = 6;
      ctx.strokeRect(left, top, netDepth, height);
      ctx.beginPath();
      ctx.moveTo(frontX, top);
      ctx.lineTo(frontX, top + height);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,0.78)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(frontX - dir * 1.5, top + 2);
      ctx.lineTo(frontX - dir * 1.5, top + height - 2);
      ctx.stroke();
      ctx.restore();
    }

    // stadium lighting: dark corners, floodlight pools (procedural base only;
    // the arena plate ships its own baked floodlighting)
    if (!this.plate) {
      for (const [cx, cy] of [
        [0, 0],
        [ARENA_W, 0],
        [0, ARENA_H],
        [ARENA_W, ARENA_H],
      ]) {
        const dg = ctx.createRadialGradient(cx, cy, 80, cx, cy, 900);
        dg.addColorStop(0, 'rgba(4,10,8,0.26)');
        dg.addColorStop(1, 'rgba(4,10,8,0)');
        ctx.fillStyle = dg;
        ctx.fillRect(-MARGIN, -MARGIN, w, h);
      }
      for (const [cx, cy, cr] of [
        [ARENA_W / 2, ARENA_H / 2, 700],
        [ARENA_W * 0.18, ARENA_H / 2, 480],
        [ARENA_W * 0.82, ARENA_H / 2, 480],
      ]) {
        const lg = ctx.createRadialGradient(cx, cy, 40, cx, cy, cr);
        lg.addColorStop(0, 'rgba(255,250,220,0.09)');
        lg.addColorStop(1, 'rgba(255,250,220,0)');
        ctx.fillStyle = lg;
        ctx.fillRect(cx - cr, cy - cr, cr * 2, cr * 2);
      }
    }

    // corner flags
    for (const [cx, cy] of [
      [40, 40],
      [ARENA_W - 40, 40],
      [40, ARENA_H - 40],
      [ARENA_W - 40, ARENA_H - 40],
    ]) {
      ctx.strokeStyle = 'rgba(48,64,20,0.21)';
      ctx.lineWidth = 0.9;
      for (let fibre = 0; fibre < 9; fibre++) {
        const angle = (fibre / 9) * TAU + cx * 0.001 + cy * 0.0007;
        const innerRadius = 3 + (fibre % 3) * 1.3;
        const outerRadius = 9 + (fibre % 4) * 2.1;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(angle) * innerRadius, cy + Math.sin(angle) * innerRadius);
        ctx.lineTo(cx + Math.cos(angle) * outerRadius, cy + Math.sin(angle) * outerRadius);
        ctx.stroke();
      }
      ctx.fillStyle = 'rgba(3,18,10,0.28)';
      ctx.beginPath();
      ctx.ellipse(cx + 9, cy + 3, 18, 5, 0, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = '#ffd23f';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx, cy - 34);
      ctx.stroke();
      if (!this.liveStadium) {
        ctx.fillStyle = '#e8283f';
        ctx.beginPath();
        ctx.moveTo(cx, cy - 34);
        ctx.lineTo(cx + 22, cy - 27);
        ctx.lineTo(cx, cy - 20);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,244,208,0.46)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(cx + 2, cy - 32);
        ctx.lineTo(cx + 18, cy - 27);
        ctx.stroke();
      }
    }

    return c;
  }

  /* ------------------------------------------------------------------ */

  resize(): void {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (w === 0 || h === 0) return;
    const backingWidth = Math.round(w * dpr);
    const backingHeight = Math.round(h * dpr);
    // Assigning either canvas dimension clears its complete front buffer.
    // Browsers can emit duplicate resize/orientation events with unchanged
    // geometry; ignoring them prevents a one-frame navy/black pitch flash.
    if (this.canvas.width === backingWidth && this.canvas.height === backingHeight) return;
    this.canvas.width = backingWidth;
    this.canvas.height = backingHeight;
  }

  /**
   * Picks the hero's atlas for the current locomotion state.
   * kind 'kick'     — one-shot wind-up/contact/recovery strip
   * kind 'idle'     — dedicated idle strip (generated art), loop its frames
   * kind 'run'      — run strip cycling while moving/dashing
   * kind 'run-held' — no idle art yet: hold the run strip's first frame
   *                   (a subtle breathing bob is added at draw time)
   */
  private heroVisual(
    def: PlayerDef,
    save: Save,
    running: boolean,
    kicking: boolean,
    direction: MovementDirection,
  ): { atlas: Atlas; kind: 'kick' | 'idle' | 'run-directional' | 'run' | 'run-held' } {
    const skinId = save.equippedSkin(def.id);
    const skin = skinId ? SKINS.find((s) => s.id === skinId) : undefined;
    const tint = skin?.kit.shirt;
    if (kicking) {
      const kickStrip = getStripAtlas(`${def.id}-kick`, tint);
      if (kickStrip) return { atlas: kickStrip, kind: 'kick' };
      void loadStripAtlas(`${def.id}-kick`, playerArtUrl(`art/players/${def.id}-kick.png`), tint);
    }
    if (!running) {
      const idleStrip = getStripAtlas(`${def.id}-idle`, tint);
      if (idleStrip) return { atlas: idleStrip, kind: 'idle' };
      // trigger a lazy load; until idle art exists, hold a neutral frame
      void loadStripAtlas(`${def.id}-idle`, playerArtUrl(`art/players/${def.id}-idle.png`), tint);
    }
    if (running) {
      const directionalId = `player-directional-${def.id}-${direction}`;
      const directional = getStripAtlas(directionalId, tint);
      if (directional) {
        trimStripAtlasCache('player-directional-', directionalId, 8);
        return { atlas: directional, kind: 'run-directional' };
      }
      // Load the requested view plus its two neighboring octants. This keeps
      // first-time turns seamless without decoding all 32 player atlases.
      const directionIndex = MOVEMENT_DIRECTIONS.indexOf(direction);
      for (const offset of [-1, 0, 1]) {
        const nextDirection = MOVEMENT_DIRECTIONS[(directionIndex + offset + MOVEMENT_DIRECTIONS.length) % MOVEMENT_DIRECTIONS.length];
        const nextId = `player-directional-${def.id}-${nextDirection}`;
        void loadStripAtlas(
          nextId,
          playerArtUrl(`art/players/directional-v4/${def.id}/${nextDirection}.webp`),
          tint,
          {
            frameWidth: PLAYER_DIRECTION_FRAME_WIDTH,
            frameHeight: 320,
            feetY: 312,
            minFrames: 12,
            maxFrames: 12,
            flippable: false,
            buildEffects: false,
          },
        ).then(() => trimStripAtlasCache('player-directional-', nextId, 8));
      }
      const runStrip = getStripAtlas(`${def.id}-run`, tint);
      if (runStrip) return { atlas: runStrip, kind: 'run' };
      void loadStripAtlas(`${def.id}-run`, playerArtUrl(`art/players/${def.id}-run.png`), tint);
    }
    // prefer the generated 2.5D strip; fall back to the procedural atlas
    const strip = getStripAtlas(def.id, tint);
    if (strip) return { atlas: strip, kind: running ? 'run' : 'run-held' };
    // trigger a lazy load (primed at boot; skin variants load on demand)
    void loadStripAtlas(def.id, playerArtUrl(`art/players/${def.id}.png`), tint);
    const key = `p:${def.id}:${skinId ?? 'base'}`;
    let a = this.atlasCache.get(key);
    if (!a) {
      a = playerAtlas(def, skin?.kit);
      this.atlasCache.set(key, a);
    }
    return { atlas: a, kind: running ? 'run' : 'run-held' };
  }

  /** Main per-frame draw. */
  draw(sim: Sim, def: PlayerDef, save: Save, time: number, debug: boolean): void {
    const ctx = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;
    if (W === 0 || H === 0) return;
    const renderDt = Number.isFinite(this.lastDrawTime)
      ? clamp(time - this.lastDrawTime, 1 / 240, 0.05)
      : 1 / 60;
    this.lastDrawTime = time;

    // Normal gameplay keeps its established scale. Boss arrival and the final
    // sudden-death duel use a responsive two-actor frame so narrow portrait
    // screens actually show both the hero and the threat named by the HUD.
    const aspect = W / Math.max(1, H);
    const introBoss = sim.bossIntroT > 0 ? sim.bossAlive : null;
    const finaleBoss = sim.suddenDeath ? sim.bossAlive : null;
    // Portrait play keeps the complete boss encounter in a stable two-actor
    // frame. Returning to the player-only zoom after the intro clipped giant
    // contact poses and made their readable wind-up unfair on mobile.
    const encounterBoss = aspect < 0.72 ? sim.bossAlive : null;
    const framedBoss = introBoss ?? finaleBoss ?? encounterBoss;
    const introTargetWorldH = aspect < 0.72
      ? 2050
      : aspect < 1.05
        ? 1540
        : 1360;
    // A fully materialized major boss is substantially wider than its intro
    // silhouette. Portrait sudden death therefore needs its own wider frame.
    const finaleTargetWorldH = aspect < 0.72
      ? 2550
      : aspect < 1.05
        ? 1840
        : 1400;
    const targetViewWorldH = introBoss
      ? introTargetWorldH
      : finaleBoss
        ? finaleTargetWorldH
        : encounterBoss
          ? 2200
          : NORMAL_VIEW_WORLD_H;
    this.viewWorldH += (targetViewWorldH - this.viewWorldH) * exponentialSmoothing(9.05, renderDt);
    if (Math.abs(targetViewWorldH - this.viewWorldH) < 0.1) this.viewWorldH = targetViewWorldH;
    const viewWorldH = this.viewWorldH;
    this.scale = H / (viewWorldH * TILT);
    const scale = this.scale;
    const vw = W / scale;
    const vh = H / scale; // in tilted pixels

    // camera follows player, hard-clamped so the view never leaves the
    // painted world (bounds derive from the arena plate's real surround)
    const p = sim.player;
    const bossFocusWeight = aspect < 0.72 && finaleBoss ? 0.67 : aspect < 0.72 ? 0.58 : 0.5;
    const px = p
      ? framedBoss ? p.x + (framedBoss.x - p.x) * bossFocusWeight : p.x
      : this.camX;
    const py = p
      ? framedBoss ? p.y + (framedBoss.y - p.y) * bossFocusWeight : p.y
      : this.camY;
    const targetLookX = this.hybridDepth && p?.moving && !framedBoss ? p.moveDx * 38 : 0;
    const targetLookY = this.hybridDepth && p?.moving && !framedBoss ? p.moveDy * 28 : 0;
    const lookFollow = exponentialSmoothing(4.68, renderDt);
    const cameraFollow = exponentialSmoothing(7.67, renderDt);
    this.hybridLookX += (targetLookX - this.hybridLookX) * lookFollow;
    this.hybridLookY += (targetLookY - this.hybridLookY) * lookFollow;
    this.camX += (px + this.hybridLookX - this.camX) * cameraFollow;
    this.camY += (py + this.hybridLookY - this.camY) * cameraFollow;
    const b = this.bounds;
    const minCx = b.x0 + vw / 2 + EDGE_PAD;
    const maxCx = b.x1 - vw / 2 - EDGE_PAD;
    this.camX = minCx <= maxCx ? clamp(this.camX, minCx, maxCx) : (b.x0 + b.x1) / 2;
    const minCy = b.y0 + vh / 2 / TILT + EDGE_PAD;
    const maxCy = b.y1 - vh / 2 / TILT - EDGE_PAD;
    this.camY = minCy <= maxCy ? clamp(this.camY, minCy, maxCy) : (b.y0 + b.y1) / 2;

    const camTX = this.camX - b.x0; // pitch-canvas coords (x)
    const camTY = (this.camY - b.y0) * TILT;

    this.shake *= Math.exp(-9.05 * renderDt);
    const shX = (Math.random() - 0.5) * this.shake * scale;
    const shY = (Math.random() - 0.5) * this.shake * scale;

    ctx.setTransform(scale, 0, 0, scale, shX, shY);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    // pitch blit
    const sx = camTX - vw / 2;
    const sy = camTY - vh / 2;
    ctx.drawImage(this.pitch, sx, sy, vw, vh, 0, 0, vw, vh);

    const toSX = (wx: number) => wx - b.x0 - sx;
    const toSY = (wy: number) => (wy - b.y0) * TILT - sy;

    if (this.hybridDepth) this.drawHybridFloodlightSpill(ctx, toSX, toSY);

    // animated crowd: jumping dots near the visible stands edge
    // (skipped when the arena plate supplies its own crowd)
    if (!this.plate) this.drawCrowd(ctx, toSX, toSY, sx + b.x0, sy / TILT + b.y0, vw, vh / TILT, time);
    if (this.liveStadium) this.drawLiveShowpieceStadium(ctx, b, sx, sy, vw, vh, time);
    if (this.hybridDepth) this.drawHybridStadiumParallax(ctx, b, sx, sy, vw, vh);
    if (this.liveStadium) this.drawPitchEdgeOcclusion(ctx, toSX, toSY);
    if (this.hybridDepth) this.drawHybridPitchRimBack(ctx, toSX, toSY);
    if (this.hybridDepth) this.drawHybridTechnicalZone(ctx, toSX, toSY, time);
    if (this.hybridDepth) this.drawHybridTouchlineBoards(ctx, toSX, toSY, time);
    if (this.liveStadium) {
      // The dense survivor endgame owns the frame budget. The baked nap and
      // tuft clusters remain fully detailed, while only the tiny animated
      // glints thin out as the enemy pool grows.
      const windFibreBudget = sim.enemies.length > 110 ? 26 : sim.enemies.length > 70 ? 52 : 86;
      this.drawTurfWindFibres(ctx, toSX, toSY, time, windFibreBudget);
    }
    if (this.liveStadium) this.drawLiveCornerFlags(ctx, toSX, toSY, time);
    if (this.liveStadium && !this.hybridDepth) this.drawLiveGoalNets(ctx, toSX, toSY, time);
    if (this.hybridDepth) this.drawHybridGoalDepth(ctx, toSX, toSY, time);

    // ground decals: telegraphs, flare zones, slow zones
    this.updateAndDrawTurfFootprints(ctx, sim, toSX, toSY, time);

    for (const t of sim.telegraphs) {
      if (!t.active) continue;
      const u = 1 - t.t / t.max;
      const tx = toSX(t.x);
      const ty = toSY(t.y);
      if (t.kind === 'cone' || t.kind === 'card') {
        // Vuvuzela gold and official red-card sectors share readable geometry
        // while retaining distinct color language and timings.
        const officialCard = t.kind === 'card';
        const coneHalfAngle = officialCard ? Math.PI / 6 : 0.55;
        const rgb = officialCard ? '255,56,85' : '255,210,63';
        ctx.fillStyle = `rgba(${rgb},${0.1 + u * 0.16})`;
        ctx.strokeStyle = `rgba(${rgb},${0.45 + u * 0.45})`;
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.moveTo(tx, ty);
        ctx.ellipse(tx, ty, t.r * (0.25 + u * 0.75), t.r * (0.25 + u * 0.75) * TILT, 0, t.dir - coneHalfAngle, t.dir + coneHalfAngle);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        continue;
      }
      if (t.kind !== 'chant') {
        const frame = Math.min(5, Math.floor(u * 6));
        const diameter = t.r * (t.kind === 'summon' ? 2.18 : 2.06);
        if (this.drawGroundVfxFrame(ctx, this.bossWarningSpr, frame, tx, ty, diameter, 0.72 + u * 0.28)) {
          continue;
        }
      }
      const col =
        t.kind === 'shock' ? '232,40,63'
        : t.kind === 'flash' ? '245,247,250'
        : t.kind === 'chant' ? '55,214,122'
        : '232,40,63';
      ctx.fillStyle = `rgba(${col},${0.12 + u * 0.15})`;
      ctx.strokeStyle = `rgba(${col},${0.5 + u * 0.5})`;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.ellipse(tx, ty, t.r, t.r * TILT, 0, 0, TAU);
      ctx.fill();
      ctx.stroke();
      if (t.kind === 'chant') {
        // sound waves radiating from the chant
        ctx.beginPath();
        ctx.ellipse(tx, ty, t.r * (0.4 + u * 0.6), t.r * (0.4 + u * 0.6) * TILT, 0, 0, TAU);
        ctx.stroke();
      } else {
        ctx.beginPath();
        ctx.ellipse(tx, ty, t.r * u, t.r * u * TILT, 0, 0, TAU);
        ctx.stroke();
      }
    }
    for (const z of sim.flareZones) {
      ctx.fillStyle = `rgba(255,120,40,${0.16 + 0.08 * Math.sin(time * 9)})`;
      ctx.beginPath();
      ctx.ellipse(toSX(z.x), toSY(z.y), z.r, z.r * TILT, 0, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,154,61,0.6)';
      ctx.lineWidth = 2.5;
      ctx.stroke();
    }
    for (const z of sim.slowZones) {
      ctx.fillStyle = `rgba(128,237,153,${0.1 + Math.min(0.12, z.t * 0.05)})`;
      ctx.beginPath();
      ctx.ellipse(toSX(z.x), toSY(z.y), z.r, z.r * TILT, 0, 0, TAU);
      ctx.fill();
    }

    // First Touch Blast is a real pitch-layer animation. Its generated turf
    // atlas is painted before every actor so the player and enemies remain
    // grounded above the blast instead of being covered by a UI-like ring.
    for (const ring of sim.rings) {
      if (!ring.active || (ring.color !== '#a8ff4d' && ring.color !== '#f5ff9b')) continue;
      const progress = clamp(1 - ring.life / 0.45, 0, 0.999);
      const frame = Math.min(5, Math.floor(progress * 6));
      this.drawVfxFrame(
        ctx,
        this.firstTouchGroundSpr,
        frame,
        toSX(ring.x),
        toSY(ring.y) - 3,
        ring.maxR * 2.18,
        0,
        Math.min(1, ring.life / 0.16),
        false,
      );
    }

    // Precision Strike lifts a barely visible AI-authored dust cluster from
    // the lead cleat. It has no discrete animation cells: position, scale and
    // opacity move continuously, avoiding the stepping of the former six-cell
    // turf explosion while keeping the player and ball visually dominant.
    for (const impact of sim.impacts) {
      if (!impact.active || impact.kind !== 'kickground') continue;
      if (!this.kickDustSpr?.complete || this.kickDustSpr.naturalWidth <= 0) continue;
      const progress = clamp(1 - impact.life / impact.maxLife, 0, 1);
      const eased = 1 - (1 - progress) * (1 - progress);
      const fadeIn = clamp(progress / 0.06, 0, 1);
      const fadeOut = clamp((1 - progress) / 0.76, 0, 1);
      const alpha = fadeIn * fadeOut * (this.reducedVfx ? 0.24 : 0.48);
      const screenAngle = Math.atan2(Math.sin(impact.angle) * TILT, Math.cos(impact.angle));
      const size = (72 + eased * 14) * impact.strength;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.globalCompositeOperation = 'screen';
      ctx.filter = 'brightness(1.7) contrast(1.08)';
      ctx.translate(
        toSX(impact.x) + Math.cos(screenAngle) * eased * 4,
        toSY(impact.y) - 2 - eased * 7,
      );
      ctx.rotate(screenAngle * 0.12);
      ctx.drawImage(this.kickDustSpr, -size / 2, -size / 2, size, size);
      ctx.restore();
    }

    // Pressure is a pitch decal, not a body overlay. It must be painted before
    // every actor so feet, silhouettes and contact VFX stay readable above it.
    for (const pr of sim.pressures) {
      if (!pr.active) continue;
      const u = pr.r / pr.maxR;
      const alpha = (1 - u) * 0.72 + 0.12;
      ctx.fillStyle = `rgba(55,214,122,${0.055 * (1 - u)})`;
      ctx.beginPath();
      ctx.ellipse(toSX(pr.x), toSY(pr.y), pr.r, pr.r * TILT, 0, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = `rgba(55,214,122,${alpha})`;
      ctx.lineWidth = 6 * (1 - u) + 2;
      ctx.beginPath();
      ctx.ellipse(toSX(pr.x), toSY(pr.y), pr.r, pr.r * TILT, 0, 0, TAU);
      ctx.stroke();
      ctx.strokeStyle = `rgba(245,247,250,${alpha * 0.42})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.ellipse(toSX(pr.x), toSY(pr.y), Math.max(1, pr.r - 7), Math.max(1, pr.r - 7) * TILT, 0, 0, TAU);
      ctx.stroke();
      const maxPressure = sim.abilityLevel('pressure') >= 5;
      const arrows = pr.r > 42 ? 8 : 4;
      ctx.lineWidth = 2;
      for (let arrow = 0; arrow < arrows; arrow++) {
        const angle = (arrow / arrows) * TAU + time * 0.18;
        const x = toSX(pr.x + Math.cos(angle) * pr.r);
        const y = toSY(pr.y + Math.sin(angle) * pr.r);
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(Math.atan2(Math.sin(angle) * TILT, Math.cos(angle)));
        ctx.strokeStyle = `rgba(229,255,238,${alpha * 0.72})`;
        ctx.beginPath();
        ctx.moveTo(-7, -5);
        ctx.lineTo(1, 0);
        ctx.lineTo(-7, 5);
        ctx.stroke();
        if (maxPressure) {
          ctx.strokeStyle = `rgba(128,237,153,${alpha * 0.42})`;
          ctx.beginPath();
          ctx.moveTo(-15, -4);
          ctx.lineTo(-21, 0);
          ctx.lineTo(-15, 4);
          ctx.stroke();
        }
        ctx.restore();
      }
    }

    // AERIAL aim/landing markers belong to the pitch decal layer. Drawing
    // them here guarantees that every enemy billboard, health bar and combat
    // pose is painted over the marker instead of being obscured by it.
    for (const rc of sim.reticles) {
      if (!rc.active) continue;
      const target = rc.targetIdx >= 0 ? sim.enemies[rc.targetIdx] : undefined;
      const u = clamp(rc.t / rc.max, 0, 1); // 1 -> 0 as the ball descends
      const x = toSX(rc.x);
      const y = toSY(rc.y);
      const baseDiameter = target?.active
        ? clamp(54 + target.radius * 1.45, 74, target.boss ? 176 : 112)
        : 86;
      const aiming = rc.phase === 'aim';
      const pulse = aiming ? 1 + Math.sin(time * 16) * 0.055 : 1;
      const targetFrame = aiming ? 1 : Math.min(5, Math.floor((1 - u) * 6));
      const diameter = aiming
        ? baseDiameter * 1.08 * pulse
        : baseDiameter * (0.82 + u * 0.55);
      this.drawGroundVfxFrame(
        ctx,
        this.aerialTargetSpr,
        targetFrame,
        x,
        y,
        diameter,
        aiming ? 0.72 : 0.58 + (1 - u) * 0.42,
      );
    }

    // A short alternating cleat press makes each authored foot plant legible
    // without restoring the artificial selection ring removed from the hero.
    if (p.moving && p.dashT <= 0 && p.kickT <= 0) {
      const step = playerStepCue(p.animT);
      if (step.strength > 0.01) {
        const dx = p.moveDx;
        const dy = p.moveDy * TILT;
        const length = Math.hypot(dx, dy) || 1;
        const forwardX = dx / length;
        const forwardY = dy / length;
        const sideX = -forwardY;
        const sideY = forwardX;
        const footX = toSX(p.x) - forwardX * 4 + sideX * step.foot * 6;
        const footY = toSY(p.y) - forwardY * 4 + sideY * step.foot * 6 + 1;
        ctx.save();
        ctx.translate(footX, footY);
        ctx.rotate(Math.atan2(forwardY, forwardX));
        ctx.globalAlpha = step.strength * 0.48;
        ctx.strokeStyle = '#d8f3c8';
        ctx.lineWidth = 1.35;
        ctx.lineCap = 'round';
        for (const offset of [-2.2, 0, 2.2]) {
          ctx.beginPath();
          ctx.moveTo(-6.5, offset);
          ctx.lineTo(3.5, offset * 0.72);
          ctx.stroke();
        }
        ctx.restore();
      }
    }

    /* corpses: fallen enemies topple sideways, sink and fade (under live entities) */
    for (const c of sim.corpses) {
      if (!c.active) continue;
      const u = c.t / c.max;
      const atlas = this.enemyAtlasFor({ def: ENEMIES[c.enemyId as keyof typeof ENEMIES] ?? ENEMIES.invader, boss: c.boss, variant: c.variant });
      // Generated strips are 4x the procedural atlas resolution. Normalize by
      // source height so swapping art never changes the enemy's world size.
      const sc = ENEMY_ENTITY_SCALE * (80 / atlas.fh) * (c.boss ? BOSSES[c.boss].scale : (ENEMIES[c.enemyId as keyof typeof ENEMIES]?.scale ?? 1)) * (c.elite ? 1.22 : 1) * (this.hybridDepth ? hybridEntityDepthScale(c.y) : 1);
      const collapse = corpseCollapseVisual(u);
      const x = toSX(c.x);
      const y = toSY(c.y);
      const knockoutFrame = Math.min(5, Math.floor(clamp(u / 0.72, 0, 0.999) * 6));
      const knockoutSize = c.boss ? 178 : c.elite ? 132 : 104;
      this.drawVfxFrame(ctx, this.knockoutSpr, knockoutFrame, x, y - 11, knockoutSize, 0, collapse.alpha * 0.82, false);
      ctx.save();
      ctx.globalAlpha = collapse.alpha * 0.28;
      ctx.fillStyle = '#06100a';
      ctx.beginPath();
      ctx.ellipse(x + c.face * collapse.sink * 0.42, y + 2, 18 + collapse.sink * 0.72, 5 + collapse.sink * 0.18, 0, 0, TAU);
      ctx.fill();
      ctx.globalAlpha = collapse.alpha;
      ctx.translate(x + c.face * collapse.sink * 0.35, y - 3 + collapse.sink);
      ctx.rotate(c.face * collapse.rotation);
      ctx.scale(collapse.scaleX, collapse.scaleY);
      const dw = atlas.fw * sc;
      const dh = atlas.fh * sc;
      const frame = atlas.frames >= 4 ? 3 : 0;
      ctx.drawImage(atlas.canvas, frame * atlas.fw, 0, atlas.fw, atlas.fh, -dw / 2, -atlas.feetY * sc, dw, dh);
      ctx.restore();
    }
    ctx.globalAlpha = 1;

    // Loot is painted after fallen bodies so rewards remain collectible and
    // readable instead of disappearing underneath the corpse billboard.
    for (const pk of sim.pickups) {
      if (!pk.active) continue;
      const img = pk.kind === 'coin' ? this.coinSpr
        : pk.kind === 'heal' ? this.healSpr
          : pk.kind === 'trophy' ? this.trophySpr
            : pk.kind === 'magnet' ? this.magnetSpr
              : pk.kind === 'bomb' ? this.bombSpr
                : pk.kind === 'freeze' ? this.freezeSpr
                  : this.xpSpr[pk.tier - 1];
      const baseSize = pk.kind === 'trophy' ? 52
        : pk.kind === 'magnet' ? 52
          : pk.kind === 'bomb' ? 50
            : pk.kind === 'freeze' ? 50
              : pk.kind === 'heal' ? 42
                : pk.kind === 'coin' ? 30
                  : pk.tier === 3 ? 38 : pk.tier === 2 ? 32 : 27;
      const groundX = toSX(pk.x);
      const groundY = toSY(pk.y) + 4;
      const depthScale = this.hybridDepth ? hybridEntityDepthScale(pk.y) : 1;
      const visibleBounds = pickupVisibleBounds(pk.kind, pk.tier);
      const sourceWidth = img.width;
      const sourceHeight = img.height;
      const sourceX = visibleBounds.x * sourceWidth;
      const sourceY = visibleBounds.y * sourceHeight;
      const sourceVisibleWidth = visibleBounds.width * sourceWidth;
      const sourceVisibleHeight = visibleBounds.height * sourceHeight;
      const visibleAspect = sourceVisibleWidth / Math.max(1, sourceVisibleHeight);
      const visibleHeight = baseSize * depthScale;
      const visibleWidth = visibleHeight * visibleAspect;
      if (this.hybridDepth) this.drawHybridEntityShadow(ctx, groundX, groundY - 1, visibleWidth * 0.18, 'pickup');
      ctx.drawImage(img, sourceX, sourceY, sourceVisibleWidth, sourceVisibleHeight, groundX - visibleWidth / 2, groundY - visibleHeight, visibleWidth, visibleHeight);
    }

    // Orbit balls retain their exact simulation/contact position, but every
    // visual is capped behind the hero's painter depth. The near half therefore
    // never crosses over the player's face or kick pose.
    const orbitLvl = sim.abilityLevel('orbit');
    const orbitCount = orbitLvl > 0 ? [0, 2, 3, 3, 4, 5][orbitLvl] + (def.id === 'yamal' ? 1 : 0) : 0;
    const orbitRadius = orbitLvl > 0 ? [0, 90, 90, 115, 115, 140][orbitLvl] : 0;
    const orbitDepthScale = this.hybridDepth ? hybridEntityDepthScale(p.y) : 1;
    const keeperLvl = sim.abilityLevel('keeperhalo');
    const keeperCount = keeperLvl > 0 ? [0, 2, 3, 3, 4, 5][keeperLvl] : 0;
    const keeperRadius = keeperLvl > 0 ? [0, 82, 88, 94, 102, 110][keeperLvl] : 0;

    /* depth-sorted draw list */
    interface Item {
      y: number;
      kind: number; // 0 enemy, 1 player, 2 guard, 3 orbit ball, 4 keeper halo
      idx: number;
    }
    const items: Item[] = [];
    for (let i = 0; i < sim.enemies.length; i++) {
      const e = sim.enemies[i];
      if (e.active) items.push({ y: e.y, kind: 0, idx: i });
    }
    for (let i = 0; i < sim.guards.length; i++) items.push({ y: sim.guards[i].y, kind: 2, idx: i });
    if (p) items.push({ y: p.y, kind: 1, idx: 0 });
    for (let ball = 0; ball < orbitCount; ball++) {
      const angle = p.orbitAngle + (ball / orbitCount) * TAU;
      const ballWorldY = p.y + Math.sin(angle) * orbitRadius;
      items.push({ y: orbitPainterDepthY(p.y, ballWorldY), kind: 3, idx: ball });
    }
    for (let shield = 0; shield < keeperCount; shield++) {
      const angle = p.keeperAngle + (shield / keeperCount) * TAU;
      const shieldWorldY = p.y + Math.sin(angle) * keeperRadius;
      items.push({ y: orbitPainterDepthY(p.y, shieldWorldY), kind: 4, idx: shield });
    }
    items.sort((a, b) => a.y - b.y);
    const activeEnemyCount = items.reduce((count, item) => count + (item.kind === 0 ? 1 : 0), 0);
    const basePresentationBudget = combatPresentationBudget(activeEnemyCount);
    const presentationBudget = this.reducedVfx
      ? reducedCombatPresentationBudget(basePresentationBudget)
      : basePresentationBudget;
    this.healthBarVisibleScratch.fill(0);
    this.healthBarCandidateScratch.length = 0;
    for (let index = 0; index < sim.enemies.length; index++) {
      const enemy = sim.enemies[index];
      if (!enemy.active || enemy.boss) continue;
      const priority = enemyHealthBarPriority(
        enemy,
        Math.hypot(enemy.x - p.x, enemy.y - p.y),
        activeEnemyCount,
      );
      if (priority === Number.POSITIVE_INFINITY) {
        if (index < this.healthBarVisibleScratch.length) this.healthBarVisibleScratch[index] = 1;
      } else if (priority >= 0) {
        this.healthBarCandidateScratch.push({ index, score: priority });
      }
    }
    this.healthBarCandidateScratch.sort((a, b) => b.score - a.score || a.index - b.index);
    for (let rank = 0; rank < Math.min(presentationBudget.maxOrdinaryHealthBars, this.healthBarCandidateScratch.length); rank++) {
      const index = this.healthBarCandidateScratch[rank].index;
      if (index < this.healthBarVisibleScratch.length) this.healthBarVisibleScratch[index] = 1;
    }
    this.lastPresentationMetrics = {
      activeEnemies: activeEnemyCount,
      visibleHealthBars: 0,
      renderedParticles: 0,
      renderedImpacts: 0,
      renderedSeekerTrails: 0,
      renderedDamageNumbers: 0,
    };
    const occupiedHealthBars: HealthBarCollisionRect[] = [];
    const reservedHealthBarZones = this.reservedHealthBarZones;
    if (this.hybridDepth) {
      const heroZone = reservedHealthBarZones[0];
      heroZone.left = toSX(p.x) - 30;
      heroZone.right = toSX(p.x) + 30;
      heroZone.top = toSY(p.y) - 118 * hybridEntityDepthScale(p.y);
      heroZone.bottom = toSY(p.y) + 5;
    }

    // One underlay pass keeps every cast shadow below every body. Drawing a
    // shadow immediately before each sprite made a near actor's shadow crawl
    // over a farther actor in dense crowds, breaking the painter illusion.
    if (this.hybridDepth) {
      for (const it of items) {
        if (it.kind === 0) {
          const e = sim.enemies[it.idx];
          const shadowX = toSX(e.x);
          const shadowY = toSY(e.y);
          if (shadowX < -90 || shadowX > vw + 90 || shadowY < -120 || shadowY > vh + 120) continue;
          const aerialHeight = aerialOverheatHeightScale(e.aerialGroundT);
          const elevation = e.def.behavior === 'aerial'
            ? (38 + Math.sin(e.animT * 7.5) * 4) * aerialHeight
            : enemyAirLift(e.airT, e.airMaxT);
          this.drawHybridEntityShadow(
            ctx,
            shadowX,
            shadowY,
            e.radius * hybridEntityDepthScale(e.y),
            e.def.behavior === 'aerial' && aerialHeight > 0.05 ? 'aerial' : e.boss ? 'boss' : 'enemy',
            elevation,
            e.boss && e === sim.bossAlive && sim.bossIntroT > 0
              ? bossArrivalVisual(sim.bossIntroT).alpha
              : 1,
          );
        } else if (it.kind === 1) {
          this.drawHybridEntityShadow(ctx, toSX(p.x), toSY(p.y), 20 * hybridEntityDepthScale(p.y), 'player');
        } else if (it.kind === 2) {
          const g = sim.guards[it.idx];
          const radius = g.variant === 2 ? 22 : g.variant === 0 ? 16 : 18;
          this.drawHybridEntityShadow(ctx, toSX(g.x), toSY(g.y), radius * hybridEntityDepthScale(g.y), 'guard');
        } else if (it.kind === 3) {
          const angle = p.orbitAngle + (it.idx / orbitCount) * TAU;
          const worldX = p.x + Math.cos(angle) * orbitRadius;
          const worldY = p.y + Math.sin(angle) * orbitRadius;
          const lift = (12 + Math.sin(time * 7 + it.idx * 1.7) * 3) * orbitDepthScale;
          this.drawHybridEntityShadow(ctx, toSX(worldX), toSY(worldY) + 2, 7 * orbitDepthScale, 'aerial', lift);
        } else {
          const angle = p.keeperAngle + (it.idx / keeperCount) * TAU;
          const worldX = p.x + Math.cos(angle) * keeperRadius;
          const worldY = p.y + Math.sin(angle) * keeperRadius;
          const depthScale = this.hybridDepth ? hybridEntityDepthScale(worldY) : 1;
          const lift = (22 + Math.sin(time * 6.4 + it.idx * 1.9) * 2.5) * depthScale;
          this.drawHybridEntityShadow(ctx, toSX(worldX), toSY(worldY) + 2, 8 * depthScale, 'aerial', lift);
        }
      }
    }

    const playerDepthScale = this.hybridDepth ? hybridEntityDepthScale(p.y) : 1;
    const playerScreenX = toSX(p.x);
    const playerScreenY = toSY(p.y);
    const playerReadableRect: ScreenOcclusionRect = {
      left: playerScreenX - 27 * playerDepthScale,
      right: playerScreenX + 27 * playerDepthScale,
      top: playerScreenY - 96 * playerDepthScale,
      bottom: playerScreenY + 3,
    };
    let playerOcclusion = 0;
    let friendlyVfxOcclusion = 0;
    let playerOcclusionPose: {
      atlas: Atlas;
      frame: number;
      x: number;
      y: number;
      scale: number;
      bobY: number;
      flip: boolean;
    } | null = null;

    for (const it of items) {
      if (it.kind === 0) {
        const e = sim.enemies[it.idx];
        const arriving = !!e.boss && e === sim.bossAlive && sim.bossIntroT > 0;
        const arrival = arriving ? bossArrivalVisual(sim.bossIntroT) : null;
        const semanticAtlas = this.enemyAtlasFor(e);
        const locomoting = e.moving && e.windup <= 0 && e.lungeT <= 0 && e.attackAnimT <= 0 && e.telegraph <= 0 && e.hurtT <= 0;
        const runAtlas = locomoting ? this.enemyRunAtlasFor(e) : null;
        const atlas = runAtlas ?? semanticAtlas;
        const directionalBossRun = !!(e.boss && runAtlas && runAtlas.frames === 12);
        const bossBreath = e.boss ? 1 + Math.sin(time * (e.boss === 'captain' ? 2.6 : 2.2) + it.idx) * 0.018 : 1;
        // Semantic lobber frames are already height-normalized in the source
        // strip (idle 233px, throw 232px). A previous 0.87 multiplier made the
        // whole character shrink during its cast despite matching source art.
        const sc = ENEMY_ENTITY_SCALE * (80 / atlas.fh) * (e.boss ? BOSSES[e.boss].scale : e.def.scale) * (e.elite ? 1.22 : 1) * bossBreath * (this.hybridDepth ? hybridEntityDepthScale(e.y) : 1);
        const x = toSX(e.x);
        const y = toSY(e.y);
        // Permanent aerial troops hover; temporarily launched mobs follow an arc.
        const lift = e.def.behavior === 'aerial'
          ? (ART_DIRECTION_PROFILE.aerial.baseLift + Math.sin(e.animT * 7.5) * ART_DIRECTION_PROFILE.aerial.bobAmplitude)
            * aerialOverheatHeightScale(e.aerialGroundT)
          : enemyAirLift(e.airT, e.airMaxT);
        const dw = atlas.fw * sc;
        const dh = atlas.fh * sc;
        const actorBodyWidth = Math.max(e.radius * 2.3 * (this.hybridDepth ? hybridEntityDepthScale(e.y) : 1), dw * 0.58);
        const actorBottom = y - lift + 3;
        const actorTop = actorBottom - atlas.feetY * sc;
        const occlusion = playerOcclusionStrength(
          playerReadableRect,
          {
            left: x - actorBodyWidth / 2,
            right: x + actorBodyWidth / 2,
            top: actorTop,
            bottom: actorBottom,
          },
          e.y > p.y + 0.5,
        );
        playerOcclusion = Math.max(playerOcclusion, occlusion);
        // Preserve the threat's mass: the exact pose contour carries most of
        // the readability gain, while only a restrained amount of the large
        // body is lifted. Full-body transparency looked washed out on bosses.
        const bodyOcclusionFade = e.boss ? 0.28 : e.elite || e.radius >= 24 ? 0.18 : 0;
        const bodyAlpha = (1 - occlusion * bodyOcclusionFade) * (arrival?.alpha ?? 1);
        const hitAngle = Math.atan2(e.hurtDy * TILT, e.hurtDx || e.face);
        if (arrival) {
          const beamWidth = clamp(dw * 0.82, 110, 260);
          const beamHeight = clamp(dh * 0.86, 180, 410);
          ctx.save();
          ctx.globalCompositeOperation = 'screen';
          ctx.lineCap = 'round';
          // Separate feathered shafts carry the arrival light without the
          // rectangular translucent patch produced by one filled polygon.
          for (let stripe = -2; stripe <= 2; stripe++) {
            const edge = Math.abs(stripe) / 2;
            const shaft = ctx.createLinearGradient(x, y - beamHeight, x, y + 3);
            shaft.addColorStop(0, 'rgba(255,226,124,0)');
            shaft.addColorStop(0.48, `rgba(255,226,124,${arrival.beamAlpha * (0.08 - edge * 0.025)})`);
            shaft.addColorStop(0.9, `rgba(255,244,204,${arrival.beamAlpha * (0.2 - edge * 0.06)})`);
            shaft.addColorStop(1, 'rgba(255,244,204,0)');
            ctx.strokeStyle = shaft;
            ctx.lineWidth = beamWidth * (0.13 - edge * 0.025);
            ctx.beginPath();
            ctx.moveTo(x + stripe * beamWidth * 0.17, y - beamHeight);
            ctx.lineTo(x + stripe * beamWidth * 0.1, y + 2);
            ctx.stroke();
          }
          ctx.restore();
        }
        if (e.orbitHitT > 0 && this.orbitSkidSpr) {
          const u = clamp(1 - e.orbitHitT / 0.38, 0, 1);
          const skidSize = clamp(78 + e.radius * 1.35, 92, e.boss ? 154 : 124);
          ctx.save();
          ctx.globalAlpha = Math.sin(Math.PI * clamp(u * 1.1, 0, 1)) * 0.86;
          ctx.translate(x - e.hurtDx * 12, y - e.hurtDy * 12 * TILT - 1);
          ctx.rotate(hitAngle);
          ctx.scale(0.72 + u * 0.38, 0.72 + u * 0.18);
          ctx.drawImage(this.orbitSkidSpr, -skidSize * 0.82, -skidSize / 2, skidSize, skidSize);
          ctx.restore();
        }
        // Grounding is supplied by the shared underlay pass in the hybrid
        // arena. Gameplay telegraphs remain separate and cannot read as feet.
        const captainChargeLane = e.boss === 'captain' && (e.chargeWindupT > 0 || e.chargeLaneFadeT > 0);
        if (e.telegraph > 0 || captainChargeLane) {
          const pulse = 0.55 + Math.sin(time * 18) * 0.25;
          const captainCharge = captainChargeLane;
          if (e.def.behavior === 'charger' || captainCharge) {
            const laneReach = captainCharge ? 600 : 520;
            const telegraphDuration = captainCharge ? 0.5 : 0.72;
            const ex = toSX(e.x + e.chargeDx * laneReach);
            const ey = toSY(e.y + e.chargeDy * laneReach);
            const laneDx = ex - x;
            const laneDy = ey - y;
            const laneLength = Math.hypot(laneDx, laneDy);
            const laneFrame = Math.min(5, Math.floor(clamp(1 - e.telegraph / telegraphDuration, 0, 0.999) * 6));
            const chargeLaneAlpha = captainCharge
              ? e.chargeWindupT > 0
                ? 1
                : clamp(e.chargeLaneFadeT / 0.1, 0, 1)
              : 1;
            this.drawVfxFrameRect(
              ctx,
              this.bullChargeLaneSpr,
              laneFrame,
              x + laneDx / 2,
              y + laneDy / 2,
              laneLength + 64,
              captainCharge ? 132 : 92,
              Math.atan2(laneDy, laneDx),
              (0.68 + pulse * 0.25) * chargeLaneAlpha,
              false,
            );
          } else if (e.def.behavior === 'aerial' && e.aerialGroundT <= 0 && p) {
            const varScan = e.def.id === 'varcam';
            ctx.strokeStyle = varScan
              ? `rgba(255,66,93,${pulse})`
              : `rgba(112,231,255,${pulse})`;
            ctx.lineWidth = 2.5;
            ctx.setLineDash(varScan ? [3, 8] : [7, 7]);
            ctx.beginPath();
            ctx.moveTo(x, y - lift);
            ctx.lineTo(toSX(p.x), toSY(p.y) - 12);
            ctx.stroke();
            ctx.setLineDash([]);
          }
        }
        if (e.windup > 0 && e.telegraph <= 0 && e.casting === '' && e.def.behavior !== 'aerial') {
          // Every melee swing exposes a short red contact wedge. It reads as
          // intent at crowd scale without turning the pitch into warning spam.
          const pulse = 0.58 + Math.sin(time * 24) * 0.18;
          ctx.strokeStyle = `rgba(255,61,85,${pulse})`;
          ctx.lineWidth = 4;
          ctx.lineCap = 'round';
          const attackAngle = Math.atan2(e.meleeDy * TILT, e.meleeDx);
          const intentOffset = e.boss ? hybridBossBodyContact(e.boss) * 0.72 : 20;
          ctx.beginPath();
          ctx.arc(
            x + Math.cos(attackAngle) * intentOffset,
            y - 3 + Math.sin(attackAngle) * intentOffset * 0.8,
            25 + e.radius * 0.22,
            attackAngle - 1.05,
            attackAngle + 1.05,
          );
          ctx.stroke();
        }
        // Six-frame locomotion plays only while the simulation reports real
        // movement. Idle, attack and hurt remain explicit semantic poses.
        const runCycleDistance = runAtlas ? enemyRunCycleDistance(e, runAtlas.frames) : 1;
        const runPhase = runAtlas ? (e.runDistance / runCycleDistance) * runAtlas.frames : 0;
        const frame = runAtlas ? Math.floor(runPhase) % runAtlas.frames : enemyPoseFrame(e, atlas.frames);
        const frameAnchor = runAtlas && !e.boss
          ? enemyFrameAnchorAdjustment(e.def.id, frame)
          : { x: 0, y: 0 };
        const useFlash = e.flash > 0;
        const img = atlas.canvas;
        const usesChargeVector = (
          e.def.behavior === 'charger'
          || (e.boss === 'captain' && (e.chargeWindupT > 0 || e.casting === 'captain-charge'))
        ) && (e.windup > 0 || e.chargeWindupT > 0 || e.lungeT > 0 || e.chargeBrakeT > 0);
        const usesMeleeVector = e.casting === ''
          && (e.windup > 0 || e.lungeT > 0 || (e.attackAnimT > 0 && e.meleeHit));
        const attackWorldDx = usesChargeVector ? e.chargeDx : usesMeleeVector ? e.meleeDx : e.face;
        const attackWorldDy = usesChargeVector ? e.chargeDy : usesMeleeVector ? e.meleeDy : 0;
        const meleeScreenLength = Math.hypot(attackWorldDx, attackWorldDy * TILT) || 1;
        const meleeScreenDx = attackWorldDx / meleeScreenLength;
        const meleeScreenDy = (attackWorldDy * TILT) / meleeScreenLength;
        ctx.save();
        ctx.globalAlpha = bodyAlpha;
        ctx.translate(x, y - lift);
        if (arrival) {
          ctx.translate(0, -arrival.lift);
          ctx.scale(arrival.scale, arrival.scale);
        }
        if (locomoting && !directionalBossRun) {
          const gait = Math.sin((e.runDistance / runCycleDistance) * TAU);
          ctx.translate(e.face * gait * 1.5, 0);
          ctx.rotate(e.face * gait * 0.018);
          ctx.scale(1 + Math.abs(gait) * 0.008, 1 - Math.abs(gait) * 0.012);
        }
        if (e.chargeWindupT > 0) {
          const windup = clamp(1 - e.chargeWindupT / 0.5, 0, 1);
          const ease = windup * windup * (3 - 2 * windup);
          ctx.translate(-e.chargeDx * (5 + ease * 12), -e.chargeDy * TILT * (3 + ease * 7) + ease * 5);
          ctx.rotate(-e.face * ease * 0.11);
          ctx.scale(1 - ease * 0.055, 1 + ease * 0.045);
        } else if (e.windup > 0) {
          const windupMax = e.def.behavior === 'charger'
            ? 0.72
            : e.def.id === 'varcam'
              ? 0.72
              : e.def.behavior === 'aerial'
                ? 0.46
                : 0.34;
          const w = clamp(1 - e.windup / windupMax, 0, 1);
          const ease = w * w * (3 - 2 * w);
          ctx.translate(-meleeScreenDx * (3 + ease * 9), -meleeScreenDy * (3 + ease * 7) + ease * 3);
          ctx.rotate(-e.face * 0.13 * ease);
          ctx.scale(1 - ease * 0.035, 1 + ease * 0.025);
        } else if (e.lungeT > 0) {
          if (e.def.behavior === 'charger' || e.casting === 'captain-charge') {
            const charge = 0.5 + Math.sin(e.animT * 22) * 0.5;
            ctx.translate(e.chargeDx * 7, e.chargeDy * 3);
            ctx.rotate(e.face * 0.025 * charge);
            ctx.scale(1.07, 0.94);
          } else {
            const lungeDuration = e.boss ? BOSS_MELEE_LUNGE_DURATION : ENEMY_MELEE_LUNGE_DURATION;
            const progress = clamp(1 - e.lungeT / lungeDuration, 0, 1);
            const strike = Math.sin(Math.PI * progress);
            ctx.translate(meleeScreenDx * strike * 18, meleeScreenDy * strike * 14 - strike * 2);
            ctx.rotate(e.face * strike * 0.1);
            ctx.scale(1 + strike * 0.08, 1 - strike * 0.07);
          }
        } else if (e.chargeBrakeT > 0) {
          const brakeDuration = e.boss === 'captain' ? 0.2 : 0.15;
          const brake = clamp(e.chargeBrakeT / brakeDuration, 0, 1);
          ctx.translate(-e.chargeDx * (1 - brake) * 3, -e.chargeDy * TILT * (1 - brake) * 2);
          ctx.rotate(-e.face * (1 - brake) * 0.045);
          ctx.scale(1 + brake * 0.055, 1 - brake * 0.035);
        } else if (e.telegraph > 0) {
          const cast = 0.5 + 0.5 * Math.sin(e.animT * 18);
          ctx.translate(e.face * cast * 3, -cast * 4);
          ctx.rotate(e.face * (cast - 0.5) * 0.045);
          ctx.scale(1 + cast * 0.035, 1 - cast * 0.02);
        } else if (e.attackAnimT > 0) {
          const recover = clamp(e.attackAnimT / MELEE_RECOVERY_DURATION, 0, 1);
          const follow = Math.sin(recover * Math.PI / 2);
          ctx.translate(meleeScreenDx * follow * 9, meleeScreenDy * follow * 7 - follow * 2);
          ctx.rotate(e.face * follow * 0.07);
          ctx.scale(1 + follow * 0.035, 1 - follow * 0.025);
        }
        if (e.hurtT > 0) {
          const hurtMax = e.hurtStrength > 0.75 ? 0.32 : 0.26;
          const elapsed = clamp(1 - e.hurtT / hurtMax, 0, 1);
          const recoil = Math.sin(Math.PI * elapsed);
          const kick = (8 + e.hurtStrength * 8) * recoil;
          ctx.translate(e.hurtDx * kick, e.hurtDy * kick * TILT - recoil * (2 + e.hurtStrength * 3));
          ctx.rotate(e.hurtDx * recoil * 0.1);
          ctx.scale(1 + recoil * 0.07, 1 - recoil * 0.1);
        }
        if (e.def.behavior === 'aerial' && e.aerialGroundT <= 0) {
          const hover = Math.sin(e.animT * 10);
          ctx.rotate(hover * 0.018);
          ctx.scale(1 + Math.abs(hover) * 0.012, 1 - Math.abs(hover) * 0.008);
        }
        if (e.face < 0 && !directionalBossRun) ctx.scale(-1, 1);
        ctx.drawImage(img, frame * atlas.fw, 0, atlas.fw, atlas.fh, -dw / 2 + frameAnchor.x * sc, -atlas.feetY * sc + frameAnchor.y * sc, dw, dh);
        if (useFlash) {
          const heavyLift = e.hurtStrength > 0.75 ? 1.28 : 1;
          ctx.globalAlpha = bodyAlpha * clamp(e.flash / 0.13, 0, 1) * presentationBudget.hitFlashAlpha * e.flashStrength * heavyLift;
          ctx.drawImage(atlas.flash, frame * atlas.fw, 0, atlas.fw, atlas.fh, -dw / 2 + frameAnchor.x * sc, -atlas.feetY * sc + frameAnchor.y * sc, dw, dh);
          ctx.globalAlpha = bodyAlpha;
        }
        if (sim.freezeT > 0) {
          // The precomputed material is clipped to this atlas and exact pose;
          // the old one-size ice shell made bulls, drones and humans identical.
          const elapsed = Number.isFinite(sim.freezeT)
            ? Math.max(0, FREEZE_DURATION - sim.freezeT)
            : 0.72;
          const flicker = 0.92 + Math.sin(elapsed * 12 + it.idx * 0.71) * 0.04;
          ctx.globalAlpha = flicker * bodyAlpha;
          ctx.globalCompositeOperation = 'source-over';
          ctx.drawImage(atlas.frost, frame * atlas.fw, 0, atlas.fw, atlas.fh, -dw / 2 + frameAnchor.x * sc, -atlas.feetY * sc + frameAnchor.y * sc, dw, dh);
        }
        ctx.restore();
        if (e.orbitHitT > 0 && this.orbitImpactSpr) {
          const u = clamp(1 - e.orbitHitT / 0.38, 0, 1);
          const impactSize = clamp(82 + e.radius * 1.2, 94, e.boss ? 164 : 132);
          ctx.save();
          ctx.globalAlpha = Math.pow(1 - u, 1.7) * 0.96;
          ctx.globalCompositeOperation = 'lighter';
          ctx.translate(x - e.hurtDx * 9, y - lift - Math.min(30, e.radius * sc * 0.34));
          ctx.rotate(hitAngle);
          ctx.scale(0.72 + u * 0.58, 0.72 + u * 0.34);
          ctx.drawImage(this.orbitImpactSpr, -impactSize * 0.82, -impactSize / 2, impactSize, impactSize);
          ctx.restore();
        }
        if (e.lungeT > 0 && e.def.behavior !== 'charger') {
          const lungeDuration = e.boss ? BOSS_MELEE_LUNGE_DURATION : ENEMY_MELEE_LUNGE_DURATION;
          const strikeProgress = clamp(1 - e.lungeT / lungeDuration, 0, 0.999);
          const strikeAngle = Math.atan2(e.meleeDy * TILT, e.meleeDx);
          const contactOffset = e.boss ? hybridBossBodyContact(e.boss) : 28;
          this.drawVfxFrame(
            ctx,
            this.playerHurtSpr,
            Math.floor(strikeProgress * 6),
            x + Math.cos(strikeAngle) * contactOffset,
            y - lift - 26 + Math.sin(strikeAngle) * contactOffset * 0.75,
            clamp(82 + e.radius, 92, 132),
            strikeAngle,
            0.76,
            true,
            0.7,
          );
        }
        // Every ordinary living threat carries a compact physical scoreboard
        // bar; elites gain numeric HP and a stronger metal/glow accent.
        // Generated plates retain transparent headroom; compensate here so
        // the bar hugs the visible silhouette instead of floating too high.
        const healthY = y - lift - atlas.feetY * sc + (e.boss ? 8 : e.elite ? 8 : 12);
        // Boss HP already has a large persistent screen-space plate; omitting
        // the duplicate billboard prevents it clipping above giant bosses.
        const showHealthBar = it.idx < this.healthBarVisibleScratch.length && this.healthBarVisibleScratch[it.idx] === 1;
        if (!e.boss && showHealthBar && this.hybridDepth) {
          const healthStyle = enemyHealthBarStyle(e);
          const importantBar = e.elite || e.stun > 0 || e.slow > 0 || e.airT > 0;
          const placement = placeEnemyHealthBar(
            x,
            healthY,
            healthStyle.width,
            healthStyle.height,
            importantBar,
            healthStyle.ratio >= 0.999,
            occupiedHealthBars,
            reservedHealthBarZones,
          );
          if (!placement.hidden) {
            this.lastPresentationMetrics.visibleHealthBars++;
            this.drawEnemyHealthBar(
              ctx,
              e,
              placement.x,
              placement.y,
              time,
              placement.widthScale,
              placement.alpha,
              x,
              healthY,
            );
          }
        } else if (!e.boss && showHealthBar) {
          this.lastPresentationMetrics.visibleHealthBars++;
          this.drawEnemyHealthBar(ctx, e, x, healthY, time);
        }
      } else if (it.kind === 1) {
        const dashPose = p.dashWindupT > 0 || p.dashT > 0 || p.dashRecoveryT > 0;
        const running = p.moving || dashPose;
        const physicalDirection = movementDirection(
          dashPose ? p.dashDx : p.visualDx,
          dashPose ? p.dashDy : p.visualDy,
        );
        const pivotProgress = p.pivotT > 0
          ? clamp(1 - p.pivotT / PLAYER_PIVOT_DURATION, 0, 1)
          : 1;
        // A true 180-degree cut holds the outgoing authored view through the
        // first half of a compressed plant, then commits to the new view. This
        // removes the instantaneous atlas teleport without blending two feet.
        const direction = p.pivotT > 0 && pivotProgress < 0.5
          ? MOVEMENT_DIRECTIONS[((p.pivotFromDir % 8) + 8) % 8]
          : physicalDirection;
        const vis = this.heroVisual(def, save, running, p.kickT > 0, direction);
        const heroSkinId = save.equippedSkin(def.id);
        const heroSkin = heroSkinId ? SKINS.find((skin) => skin.id === heroSkinId) : undefined;
        const semanticAtlas = p.hurtT > 0 || sim.over === 'lost'
          ? getStripAtlas(def.id, heroSkin?.kit.shirt)
          : null;
        const atlas = semanticAtlas ?? vis.atlas;
        const x = toSX(p.x);
        const y = toSY(p.y);
        // Keep the authored cleat dust visible during the complete 360 ms kick,
        // not only after the ball has already left. Anchoring it ahead of the
        // body at the committed aim vector prevents the character art from
        // hiding it while retaining a grounded, football-specific contact cue.
        if (p.kickT > 0 && this.kickDustSpr?.complete && this.kickDustSpr.naturalWidth > 0) {
          const kickElapsed = clamp(KICK_DURATION - p.kickT, 0, KICK_DURATION);
          const contactDistance = Math.abs(kickElapsed - KICK_CONTACT_DELAY);
          const contactPulse = 1 - clamp(contactDistance / 0.16, 0, 1);
          const anticipation = clamp(kickElapsed / KICK_AIM_LOCK_DELAY, 0, 1);
          const dustAlpha = (0.24 + contactPulse * 0.36) * anticipation;
          const dustSize = 70 + contactPulse * 20;
          const screenAngle = Math.atan2(p.aimDy * TILT, p.aimDx);
          ctx.save();
          ctx.globalAlpha = this.reducedVfx ? dustAlpha * 0.6 : dustAlpha;
          ctx.globalCompositeOperation = 'screen';
          ctx.filter = 'brightness(1.7) contrast(1.08)';
          ctx.translate(x + p.aimDx * 42, y + p.aimDy * TILT * 42 - 2);
          ctx.rotate(screenAngle * 0.1);
          ctx.drawImage(this.kickDustSpr, -dustSize / 2, -dustSize / 2, dustSize, dustSize);
          ctx.restore();
        }
        // Two tight cleat occlusion marks visually pin the authored foot
        // baseline to the turf. They are deliberately tiny and independent —
        // never a selection disc or character ring — so the player reads as
        // standing on detailed grass without looking like a floating token.
        if (!this.hybridDepth) {
          ctx.save();
          ctx.fillStyle = 'rgba(2, 18, 8, 0.24)';
          ctx.beginPath();
          ctx.ellipse(x - 5.2, y + 0.8, 6.8, 2.05, -0.14, 0, TAU);
          ctx.ellipse(x + 5.2, y + 0.8, 6.8, 2.05, 0.14, 0, TAU);
          ctx.fill();
          ctx.restore();
        }
        // dash trail
        if (p.dashT > 0) {
          const dashAngle = Math.atan2(p.dashDy * TILT, p.dashDx);
          ctx.save();
          ctx.translate(x, y - 8);
          ctx.rotate(dashAngle);
          const dashGlow = ctx.createLinearGradient(-86, 0, 5, 0);
          dashGlow.addColorStop(0, 'rgba(128,237,153,0)');
          dashGlow.addColorStop(0.68, 'rgba(128,237,153,0.32)');
          dashGlow.addColorStop(1, 'rgba(232,255,238,0.8)');
          ctx.strokeStyle = dashGlow;
          ctx.lineWidth = 8;
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(-86, 0);
          ctx.lineTo(2, 0);
          ctx.stroke();
          // Alternating cleat cuts make the trail read as a football sprint,
          // not a generic sci-fi beam.
          for (let mark = 0; mark < 4; mark++) {
            const mx = -18 - mark * 17;
            const my = (mark % 2 === 0 ? -1 : 1) * 6;
            ctx.globalAlpha = 0.78 - mark * 0.13;
            ctx.fillStyle = '#bfffd0';
            ctx.beginPath();
            ctx.ellipse(mx, my, 6.5, 2.2, mark % 2 === 0 ? -0.24 : 0.24, 0, TAU);
            ctx.fill();
            ctx.strokeStyle = '#37d67a';
            ctx.lineWidth = 1.5;
            for (let cleat = -1; cleat <= 1; cleat++) {
              ctx.beginPath();
              ctx.moveTo(mx + cleat * 3, my - 5);
              ctx.lineTo(mx + cleat * 3 - 4, my - 10);
              ctx.stroke();
            }
          }
          ctx.restore();
        }
        // Idle plays the dedicated neutral clip. Keep the feet planted; any
        // breathing motion belongs inside the art rather than moving the body.
        const directionalBlend = vis.kind === 'run-directional'
          ? directionalFrameBlend(p.animT, PLAYER_DIRECTION_RUN_FPS, atlas.frames)
          : null;
        const frame = semanticAtlas
          ? Math.min(3, semanticAtlas.frames - 1)
          : vis.kind === 'kick'
            ? Math.min(atlas.frames - 1, Math.floor(clamp(1 - p.kickT / KICK_DURATION, 0, 0.999) * atlas.frames))
          : vis.kind === 'idle' ? Math.floor(time * 4.5) % atlas.frames
          : directionalBlend ? directionalBlend.frame
          : vis.kind === 'run' ? Math.floor(p.animT * 12.2) % atlas.frames
          : 0;
        const step = directionalBlend ? playerStepCue(p.animT, PLAYER_DIRECTION_RUN_FPS, atlas.frames) : null;
        // Lift only between planted poses. Contact frames retain the exact
        // delivered feet baseline, so the runner reads as stepping, not sliding.
        const bobY = step ? -(1 - step.strength) * 1.5 : 0;
        const sc = PLAYER_ENTITY_SCALE * (80 / atlas.fh) * (this.hybridDepth ? hybridEntityDepthScale(p.y) : 1);
        const dw = atlas.fw * sc;
        const dh = atlas.fh * sc;
        playerOcclusionPose = {
          atlas,
          frame: directionalBlend && directionalBlend.mix >= 0.5 ? directionalBlend.nextFrame : frame,
          x,
          y,
          scale: sc,
          bobY,
          flip: p.face < 0 && atlas.flippable,
        };
        // Boss arrival has its own explicit fair-play language. Do not reuse
        // the damage iframe blink here: it made the hero disappear while the
        // player was meant to read the new threat and reposition.
        const blink = p.iframes > 0 && sim.bossIntroT <= 0 && Math.floor(time * 20) % 2 === 0;
        ctx.save();
        ctx.translate(x, y);
        if (sim.over === 'lost') {
          if (this.lossStartedAt < 0) this.lossStartedAt = time;
          const fall = clamp((time - this.lossStartedAt) / 0.72, 0, 1);
          const easedFall = Math.sin((fall * Math.PI) / 2);
          ctx.translate(p.face * easedFall * 18, easedFall * 9);
          ctx.rotate(p.face * easedFall * 1.18);
        }
        if (p.hurtT > 0) {
          const recoil = Math.sin(Math.PI * clamp(p.hurtT / 0.32, 0, 1));
          ctx.translate(p.hurtDx * recoil * 11, p.hurtDy * recoil * 11 * TILT - recoil * 3);
          ctx.rotate(p.hurtDx * recoil * 0.07);
          ctx.scale(1 + recoil * 0.05, 1 - recoil * 0.08);
        }
        // The active dash reads as three authored body beats around one locked
        // vector: plant back, explode forward, then settle. The feet remain on
        // their delivered baseline and the transforms are intentionally small
        // enough to preserve the generated directional silhouette.
        if (p.dashWindupT > 0) {
          const u = clamp(1 - p.dashWindupT / DASH_ANTICIPATION_DURATION, 0, 1);
          ctx.translate(-p.dashDx * (2.5 + u * 3.5), -p.dashDy * TILT * (1.5 + u * 1.5));
          ctx.rotate(-p.dashDx * (0.035 + u * 0.025));
          ctx.scale(0.96 - u * 0.018, 1.035 + u * 0.025);
        } else if (p.dashT > 0) {
          ctx.translate(p.dashDx * 2.4, p.dashDy * TILT * 1.2);
          ctx.rotate(p.dashDx * 0.055);
          ctx.scale(1.055, 0.965);
        } else if (p.dashRecoveryT > 0) {
          const u = clamp(p.dashRecoveryT / DASH_RECOVERY_DURATION, 0, 1);
          ctx.translate(p.dashDx * u * 2.2, p.dashDy * TILT * u);
          ctx.rotate(p.dashDx * u * 0.032);
          ctx.scale(1 + u * 0.028, 1 - u * 0.022);
        }
        if (p.kickT > 0) {
          const elapsed = clamp(KICK_DURATION - p.kickT, 0, KICK_DURATION);
          if (elapsed < KICK_AIM_LOCK_DELAY) {
            const u = elapsed / KICK_AIM_LOCK_DELAY;
            ctx.translate(-p.aimDx * (1.5 + u * 2.5), -p.aimDy * TILT * (0.8 + u));
            ctx.rotate(-p.aimDx * (0.018 + u * 0.022));
          } else if (elapsed < KICK_CONTACT_DELAY + 0.055) {
            const contactU = clamp((elapsed - KICK_AIM_LOCK_DELAY) / (KICK_CONTACT_DELAY + 0.055 - KICK_AIM_LOCK_DELAY), 0, 1);
            ctx.translate(p.aimDx * contactU * 3.8, p.aimDy * TILT * contactU * 1.8);
            ctx.rotate(p.aimDx * contactU * 0.045);
            ctx.scale(1 + contactU * 0.035, 1 - contactU * 0.025);
          } else {
            const recoveryU = clamp((KICK_DURATION - elapsed) / (KICK_DURATION - KICK_CONTACT_DELAY - 0.055), 0, 1);
            ctx.translate(p.aimDx * recoveryU * 2.2, p.aimDy * TILT * recoveryU);
            ctx.rotate(p.aimDx * recoveryU * 0.024);
          }
        }
        if (p.pivotT > 0 && p.dashT <= 0 && p.kickT <= 0) {
          const plant = Math.sin(Math.PI * pivotProgress);
          const turnSign = Math.sin((p.pivotToDir - p.pivotFromDir) * Math.PI / 4) || (p.moveDx >= 0 ? 1 : -1);
          ctx.translate(0, plant * 1.3);
          ctx.rotate(turnSign * plant * 0.042);
          ctx.scale(1 - plant * 0.085, 1 + plant * 0.035);
        }
        // A restrained acceleration lean gives the first 130 ms physical
        // weight without shifting the planted foot baseline or delaying input.
        if (running && p.dashT <= 0 && p.kickT <= 0 && p.accelLean > 0.01) {
          const lean = p.accelLean;
          ctx.translate(p.visualDx * lean * 1.5, p.visualDy * TILT * lean * 0.8);
          ctx.rotate(p.visualDx * lean * 0.032);
        }
        if (p.face < 0 && atlas.flippable) ctx.scale(-1, 1);
        const visibleAlpha = blink ? 0.45 : 1;
        if (directionalBlend) {
          ctx.globalAlpha = visibleAlpha * (1 - directionalBlend.mix);
          ctx.drawImage(atlas.canvas, frame * atlas.fw, 0, atlas.fw, atlas.fh, -dw / 2, -atlas.feetY * sc + bobY, dw, dh);
          ctx.globalAlpha = visibleAlpha * directionalBlend.mix;
          ctx.drawImage(
            atlas.canvas,
            directionalBlend.nextFrame * atlas.fw,
            0,
            atlas.fw,
            atlas.fh,
            -dw / 2,
            -atlas.feetY * sc + bobY,
            dw,
            dh,
          );
        } else {
          ctx.globalAlpha = visibleAlpha;
          ctx.drawImage(atlas.canvas, frame * atlas.fw, 0, atlas.fw, atlas.fh, -dw / 2, -atlas.feetY * sc + bobY, dw, dh);
        }
        ctx.restore();
        if (this.abilityUpgradeStartedAt >= 0) {
          const age = time - this.abilityUpgradeStartedAt;
          if (age >= 0 && age < 0.96) {
            const progress = clamp(age / 0.96, 0, 0.999);
            const framePosition = progress * 5;
            const currentFrame = Math.floor(framePosition);
            const nextFrame = Math.min(5, currentFrame + 1);
            const mix = framePosition - currentFrame;
            const fade = Math.min(1, age * 7) * clamp((0.96 - age) * 3.2, 0, 1);
            const size = (this.abilityUpgradeMax ? 184 : 148) * playerDepthScale;
            const effectY = y - 42 * playerDepthScale;
            this.drawVfxFrame(ctx, this.abilityUpgradeSpr, currentFrame, x, effectY, size, 0, fade * (1 - mix), true);
            if (nextFrame !== currentFrame) {
              this.drawVfxFrame(ctx, this.abilityUpgradeSpr, nextFrame, x, effectY, size, 0, fade * mix, true);
            }
          } else if (age >= 0.96) {
            this.abilityUpgradeStartedAt = -1;
          }
        }
        if (p.heartFxT > 0) {
          const age = Number.isFinite(p.heartFxT) ? clamp(1 - p.heartFxT / 0.9, 0, 0.999) : 0.72;
          const heartFrame = Math.min(5, Math.floor(age * 6));
          const heartAlpha = Math.min(1, p.heartFxT * 2.8);
          this.drawVfxFrame(ctx, this.captainsHeartSpr, heartFrame, x, y - 148, 102 + age * 12, 0, heartAlpha, false);
        }
        if (p.hurtT > 0) {
          const hurtProgress = clamp(1 - p.hurtT / 0.32, 0, 0.999);
          this.drawVfxFrame(ctx, this.playerHurtSpr, Math.floor(hurtProgress * 6), x, y - 30, 118, 0, 0.96, true);
        }
      } else if (it.kind === 3) {
        const angle = p.orbitAngle + (it.idx / orbitCount) * TAU;
        const worldX = p.x + Math.cos(angle) * orbitRadius;
        const worldY = p.y + Math.sin(angle) * orbitRadius;
        const x = toSX(worldX);
        const y = toSY(worldY);
        const lift = (12 + Math.sin(time * 7 + it.idx * 1.7) * 3) * orbitDepthScale;
        if (!this.hybridDepth) {
          ctx.fillStyle = 'rgba(4,10,6,0.24)';
          ctx.beginPath();
          ctx.ellipse(x, y + 2, 8, 3.4, 0, 0, TAU);
          ctx.fill();
        }
        ctx.save();
        ctx.translate(x, y - lift);
        // A single AI-authored crescent follows the real orbital tangent. Its
        // curved silhouette preserves the circular wake and avoids the square
        // chain created by repeating straight texture fragments.
        if (this.orbitTrailSpr?.complete && this.orbitTrailSpr.naturalWidth > 0) {
          const geometry = orbitTrailArcGeometry(orbitRadius, orbitCount);
          const tangentAngle = Math.atan2(Math.cos(angle) * TILT, -Math.sin(angle));
          const trailWidth = clamp(orbitRadius * geometry.arcRadians * 1.32, 88, 132) * orbitDepthScale;
          const trailHeight = trailWidth * 0.5;
          ctx.save();
          ctx.globalCompositeOperation = 'screen';
          ctx.rotate(tangentAngle);
          ctx.globalAlpha = this.reducedVfx ? 0.48 : 0.82;
          ctx.drawImage(
            this.orbitTrailSpr,
            -trailWidth * 0.96,
            -trailHeight / 2,
            trailWidth,
            trailHeight,
          );
          ctx.restore();
        }
        ctx.rotate(Math.sin(time * 5 + it.idx) * 0.12);
        this.drawMatchBall(ctx, 0, 0, 28 * orbitDepthScale, Math.floor(time * 14 + it.idx * 1.7));
        ctx.restore();
      } else if (it.kind === 4) {
        const angle = p.keeperAngle + (it.idx / keeperCount) * TAU;
        const worldX = p.x + Math.cos(angle) * keeperRadius;
        const worldY = p.y + Math.sin(angle) * keeperRadius;
        const x = toSX(worldX);
        const y = toSY(worldY);
        const depthScale = this.hybridDepth ? hybridEntityDepthScale(worldY) : 1;
        const lift = (22 + Math.sin(time * 6.4 + it.idx * 1.9) * 2.5) * depthScale;
        const frame = Math.floor(time * (keeperLvl >= 4 ? 16 : 12) + it.idx * 2.35) % KEEPER_HALO_FRAME_COUNT;
        this.drawVfxFrame(
          ctx,
          this.keeperHaloSpr,
          frame,
          x,
          y - lift,
          (keeperLvl >= 5 ? 74 : 68) * depthScale,
          angle + Math.PI / 2,
          this.reducedVfx ? 0.72 : 0.96,
          false,
          0.5,
          KEEPER_HALO_FRAME_COUNT,
        );
      } else {
        const g = sim.guards[it.idx];
        const guardIds = ['ally-bodyguard-rookie', 'ally-bodyguard', 'ally-bodyguard-heavy', 'ally-bodyguard-scout'] as const;
        const semanticAtlas = getStripAtlas(guardIds[g.variant]) ?? guardAtlas();
        const locomoting = g.moving && g.strikeT <= 0 && g.blockT <= 0;
        const runAtlas = locomoting ? getStripAtlas(`${guardIds[g.variant]}-run`) : null;
        const atlas = runAtlas ?? semanticAtlas;
        const variantScale = g.variant === 0 ? 0.92 : g.variant === 2 ? 1.14 : g.variant === 3 ? 1.02 : 0.87;
        const sc = ALLY_ENTITY_SCALE * (80 / atlas.fh) * variantScale * (this.hybridDepth ? hybridEntityDepthScale(g.y) : 1);
        const x = toSX(g.x);
        const y = toSY(g.y);
        if (g.strikeT > 0) {
          const strikeProgress = clamp(1 - g.strikeT / 0.24, 0, 0.999);
          const contactAlpha = clamp(1 - Math.abs(strikeProgress - 0.55) / 0.34, 0, 1);
          if (contactAlpha > 0) {
            this.drawVfxFrame(
              ctx,
              this.guardSlamSpr,
              Math.floor(strikeProgress * 6),
              x + g.face * (g.variant === 2 ? 34 : 28),
              y - 18,
              g.variant === 2 ? 112 : 90,
              g.face < 0 ? Math.PI : 0,
              0.58 * contactAlpha,
              true,
            );
          }
        }
        const frame = runAtlas
          ? Math.floor((g.runDistance / guardRunCycleDistance(g.variant)) * runAtlas.frames) % runAtlas.frames
          : guardPoseFrame(g, semanticAtlas.frames);
        ctx.save();
        ctx.translate(x, y);
        if (locomoting) {
          const runPresentation = guardRunPresentation(g.vx, g.vy, g.face);
          ctx.rotate(runPresentation.tilt);
        }
        if (g.strikeT > 0) {
          const punch = Math.sin(Math.PI * (1 - g.strikeT / 0.24));
          ctx.translate(g.face * punch * 7, -punch);
          ctx.rotate(g.face * punch * 0.045);
        } else if (g.blockT > 0) {
          const brace = 0.5 + 0.5 * Math.sin(g.animT * 20);
          ctx.scale(1 + brace * 0.016, 1 - brace * 0.008);
        }
        if (g.face < 0) ctx.scale(-1, 1);
        ctx.drawImage(atlas.canvas, frame * atlas.fw, 0, atlas.fw, atlas.fh, -(atlas.fw * sc) / 2, -atlas.feetY * sc, atlas.fw * sc, atlas.fh * sc);
        ctx.restore();
      }
    }

    // Preserve the original Showpiece painter order exactly. The hybrid route
    // delays its physical foreground until projectiles and ground abilities
    // are drawn, allowing real goal tubing and the near fascia to occlude the
    // world without ever covering hit feedback or damage numbers.
    if (!this.hybridDepth) this.drawGoalForeground(ctx, toSX, toSY);

    // balls (AERIAL lobs: height via z, moving ground shadow sells the arc)
    for (const b of sim.balls) {
      if (!b.active) continue;
      const x = toSX(b.x);
      const y = toSY(b.y);
      const hFrac = clamp(b.z / 240, 0, 1);
      const launchVisual = aerialLaunchVisual(b.flightT);
      const depthScale = this.hybridDepth ? hybridEntityDepthScale(b.y) : 1;
      // ground shadow tracks the landing point, shrinking/fading with height
      if (this.hybridDepth) {
        this.drawHybridEntityShadow(ctx, x, y, 7 * depthScale, 'aerial', Math.max(8, b.z));
      } else {
        ctx.fillStyle = `rgba(4,10,6,${0.3 * (1 - hFrac * 0.6)})`;
        ctx.beginPath();
        ctx.ellipse(x, y + 2, 7 * (1 - hFrac * 0.45), 3 * (1 - hFrac * 0.45), 0, 0, TAU);
        ctx.fill();
      }
      ctx.save();
      ctx.globalAlpha = launchVisual.bodyAlpha;
      ctx.translate(x, y - 16 - b.z);
      ctx.rotate(Math.sin(b.flightT * 9) * 0.1);
      const bs = 1 + hFrac * 0.12; // slight forced perspective near the apex
      this.drawMatchBall(ctx, 0, 0, 24 * bs * depthScale * launchVisual.scale, Math.floor(b.flightT * 16 * Math.max(0.6, Math.abs(b.spin))));
      ctx.restore();
    }
    // Homing AERIAL seekers: physical airborne sprites paired with generated
    // six-frame wakes. The wake anchor follows the projectile through turns.
    let seekerTrails = 0;
    for (const s of sim.seekers) {
      if (!s.active) continue;
      const x = toSX(s.x);
      const y = toSY(s.y);
      const lift = 16 + s.z;
      const size = s.kind === 'curveball' ? 40 : 48;
      const screenAngle = Math.atan2(s.vy * TILT, s.vx);
      const age = s.maxLife - s.life;
      const launchVisual = aerialLaunchVisual(age);
      const depthScale = this.hybridDepth ? hybridEntityDepthScale(s.y) : 1;

      if (this.hybridDepth) {
        this.drawHybridEntityShadow(ctx, x, y, (s.kind === 'curveball' ? 8 : 11) * depthScale, 'aerial', lift);
      } else {
        ctx.fillStyle = 'rgba(4,10,6,0.24)';
        ctx.beginPath();
        ctx.ellipse(x, y + 2, s.kind === 'curveball' ? 8 : 11, s.kind === 'curveball' ? 3.5 : 4.5, 0, 0, TAU);
        ctx.fill();
      }

      // A ping-pong frame order keeps the generated wake breathing without a
      // visible jump from its dissipated final cell back to the full burst.
      const wakeOrder = [0, 1, 2, 3, 2, 1];
      const wakeFrame = wakeOrder[Math.floor(age * 15 + s.phase * 2) % wakeOrder.length];
      const wakeSprite = s.kind === 'curveball' ? this.curveTrailSpr : this.goldenBootTrailSpr;
      if (seekerTrails < presentationBudget.maxSeekerTrails) {
        this.drawVfxFrame(
          ctx,
          wakeSprite,
          wakeFrame,
          x,
          y - lift,
          s.kind === 'curveball' ? 112 : 134,
          screenAngle,
          (s.kind === 'curveball' ? 0.86 : 0.98) * launchVisual.wakeAlpha,
          true,
          0.82,
        );
        seekerTrails++;
        this.lastPresentationMetrics.renderedSeekerTrails++;
      }

      const sprite = s.kind === 'curveball' ? this.curveballSpr : this.goldenBootSpr;
      ctx.save();
      ctx.globalAlpha = launchVisual.bodyAlpha;
      ctx.translate(x, y - lift);
      const pulse = 1 + Math.sin(age * 14 + s.phase) * (s.kind === 'curveball' ? 0.035 : 0.025);
      ctx.rotate(s.kind === 'curveball'
        ? age * 13 + s.phase
        : screenAngle + Math.PI / 4 + Math.sin(age * 17 + s.phase) * 0.06);
      const launchSize = size * pulse * depthScale * launchVisual.scale;
      ctx.drawImage(sprite, -launchSize / 2, -launchSize / 2, launchSize, launchSize);
      ctx.restore();
    }
    // bottles
    for (const b of sim.bottles) {
      if (!b.active) continue;
      const bx = toSX(b.x);
      const elevation = this.hybridDepth
        ? hybridHostileProjectileElevation(b.kind, b.life, b.maxLife)
        : b.kind === 'scan' ? 34 : b.kind === 'electric' ? 28 : 12;
      const depthScale = this.hybridDepth ? hybridEntityDepthScale(b.y) : 1;
      const by = toSY(b.y) - elevation;
      if (this.hybridDepth) {
        this.drawHybridEntityShadow(
          ctx,
          bx,
          toSY(b.y),
          (b.kind === 'scan' ? 9 : b.kind === 'electric' ? 8 : 6) * depthScale,
          'aerial',
          elevation,
        );
      }
      ctx.save();
      ctx.translate(bx, by);
      if (b.kind === 'scan') {
        const a = Math.atan2(b.vy * TILT, b.vx);
        const age = Math.max(0, b.maxLife - b.life);
        const shotFrame = age < 0.1 ? 0 : 1 + (Math.floor(age * 17) % 3);
        this.drawVfxFrame(ctx, this.varScanShotSpr, shotFrame, 0, 0, 92 * depthScale, a, 0.98, true, 0.42);
      } else if (b.kind === 'electric') {
        const a = Math.atan2(b.vy * TILT, b.vx);
        const age = Math.max(0, 1.45 - b.life);
        const shotFrame = age < 0.08 ? 0 : 1 + (Math.floor(time * 22 + age * 9) % 4);
        this.drawVfxFrame(ctx, this.droneShotSpr, shotFrame, 0, 0, 72 * depthScale, a, 0.98, true, 0.44);
      } else {
        ctx.rotate(time * 9);
        ctx.drawImage(this.bottleSpr, -6 * depthScale, -10 * depthScale, 12 * depthScale, 20 * depthScale);
      }
      ctx.restore();
    }

    if (this.keeperBlockStartedAt >= 0) {
      const age = time - this.keeperBlockStartedAt;
      if (age >= 0 && age < 0.48) {
        const progress = clamp(age / 0.48, 0, 0.999);
        const frame = Math.min(KEEPER_HALO_FRAME_COUNT - 1, Math.floor(progress * KEEPER_HALO_FRAME_COUNT));
        this.drawVfxFrame(
          ctx,
          this.keeperHaloSpr,
          frame,
          toSX(this.keeperBlockX),
          toSY(this.keeperBlockY) - 30,
          this.keeperBlockCounter ? 138 : 108,
          progress * 0.32,
          clamp((0.48 - age) * 3.4, 0, 1),
          false,
          0.5,
          KEEPER_HALO_FRAME_COUNT,
        );
      } else if (age >= 0.48) {
        this.keeperBlockStartedAt = -1;
      }
    }

    if (this.scanImpactStartedAt >= 0) {
      const age = time - this.scanImpactStartedAt;
      if (age >= 0 && age < 0.42) {
        const progress = clamp(age / 0.42, 0, 0.999);
        const frame = 4 + Math.min(1, Math.floor(progress * 2));
        this.drawVfxFrame(
          ctx,
          this.varScanShotSpr,
          frame,
          toSX(this.scanImpactX),
          toSY(this.scanImpactY) - 30,
          112 + progress * 24,
          0,
          clamp((0.42 - age) * 3.4, 0, 1),
          true,
        );
      } else if (age >= 0.42) {
        this.scanImpactStartedAt = -1;
      }
    }

    // rings
    for (const r of sim.rings) {
      if (!r.active) continue;
      const a = clamp(r.life / 0.45, 0, 1);
      if (r.color === '#7ce7ff' && this.guardSlamSpr) {
        const slamProgress = clamp(1 - r.life / 0.45, 0, 0.999);
        this.drawVfxFrame(
          ctx,
          this.guardSlamSpr,
          Math.floor(slamProgress * 6),
          toSX(r.x),
          toSY(r.y) - 12,
          Math.max(116, r.maxR * 1.72),
          0,
          Math.min(1, a * 1.35),
          true,
        );
        continue;
      }
      const whistle = r.color === '#f5f7fa';
      const pitchBlast = r.color === '#a8ff4d' || r.color === '#f5ff9b';
      if (pitchBlast && this.firstTouchGroundSpr?.complete) continue;
      if (whistle) {
        if (this.captainsWhistleSpr?.complete) {
          const progress = clamp(1 - r.life / 0.45, 0, 0.999);
          const framePosition = progress * 5;
          const currentFrame = Math.floor(framePosition);
          const nextFrame = Math.min(5, currentFrame + 1);
          const mix = framePosition - currentFrame;
          const size = r.maxR * 2.12;
          const x = toSX(r.x);
          const y = toSY(r.y);
          // Cross-fading the authored keyframes makes the generated shockwave
          // read as continuous expansion instead of a six-step sprite flip.
          ctx.save();
          ctx.globalCompositeOperation = 'screen';
          this.drawVfxFrame(ctx, this.captainsWhistleSpr, currentFrame, x, y, size, 0, (1 - mix) * (this.reducedVfx ? 0.5 : 0.78), false);
          if (nextFrame !== currentFrame) {
            this.drawVfxFrame(ctx, this.captainsWhistleSpr, nextFrame, x, y, size, 0, mix * (this.reducedVfx ? 0.5 : 0.78), false);
          }
          ctx.restore();
        } else {
          // Decode/network failure must not make a gameplay pulse invisible.
          // The shipped authored strip remains the normal presentation; this
          // restrained stadium-sound contour is emergency readability only.
          const progress = clamp(1 - r.life / 0.45, 0, 0.999);
          const x = toSX(r.x);
          const y = toSY(r.y);
          ctx.save();
          ctx.globalAlpha = (1 - progress) * (this.reducedVfx ? 0.28 : 0.46);
          ctx.strokeStyle = '#eefbff';
          ctx.lineWidth = 3.2 - progress * 1.2;
          ctx.beginPath();
          ctx.ellipse(x, y, r.r, r.r * TILT, 0, 0, TAU);
          ctx.stroke();
          ctx.globalAlpha *= 0.52;
          ctx.beginPath();
          ctx.ellipse(x, y, r.r * 0.78, r.r * TILT * 0.78, 0, 0, TAU);
          ctx.stroke();
          ctx.restore();
        }
        continue;
      }
      ctx.globalAlpha = whistle ? a * 0.9 : a;
      ctx.strokeStyle = r.color;
      ctx.lineWidth = 5 * a + 1;
      ctx.beginPath();
      ctx.ellipse(toSX(r.x), toSY(r.y), r.r, r.r * TILT, 0, 0, TAU);
      ctx.stroke();
      if (pitchBlast) {
        // Jagged turf fissures belong to the GROUND layer; the separate cyan
        // airburst impact above it communicates the smaller AERIAL detonation.
        ctx.strokeStyle = `rgba(214,255,140,${a * 0.72})`;
        ctx.lineWidth = 2.5;
        for (let crack = 0; crack < 8; crack++) {
          const angle = (crack / 8) * TAU + 0.22;
          const inner = Math.max(12, r.r * 0.34);
          const mid = r.r * 0.61;
          const outer = r.r * 0.88;
          ctx.beginPath();
          ctx.moveTo(toSX(r.x + Math.cos(angle) * inner), toSY(r.y + Math.sin(angle) * inner));
          ctx.lineTo(toSX(r.x + Math.cos(angle + 0.08) * mid), toSY(r.y + Math.sin(angle + 0.08) * mid));
          ctx.lineTo(toSX(r.x + Math.cos(angle - 0.035) * outer), toSY(r.y + Math.sin(angle - 0.035) * outer));
          ctx.stroke();
        }
      }
    }
    ctx.globalAlpha = 1;

    if (this.hybridDepth) {
      this.drawGoalForeground(ctx, toSX, toSY);
      this.drawHybridPitchRimFront(ctx, toSX, toSY);
    }

    // Decorative particles are the first layer to thin under horde pressure.
    // This never changes pooled particle physics, only how many are painted.
    let activeParticleOrdinal = 0;
    for (const pt of sim.particles) {
      if (!pt.active) continue;
      const particleOrdinal = activeParticleOrdinal++;
      if (particleOrdinal % presentationBudget.particleStride !== 0) continue;
      const a = clamp(pt.life / pt.maxLife, 0, 1);
      ctx.globalAlpha = a;
      ctx.fillStyle = pt.color;
      ctx.fillRect(toSX(pt.x) - pt.size / 2, toSY(pt.y) - pt.size / 2 - 8, pt.size, pt.size);
      this.lastPresentationMetrics.renderedParticles++;
    }
    ctx.globalAlpha = 1;

    // Generated directional contact, aerial and landing bursts. The source
    // strips carry the exact impact silhouette; no procedural ray scaffolding.
    let standardImpacts = 0;
    let priorityImpacts = 0;
    for (const impact of sim.impacts) {
      if (!impact.active || impact.kind === 'kickground') continue;
      const priorityImpact = impact.kind !== 'contact' || impact.strength >= 1.18;
      if (priorityImpact) {
        if (priorityImpacts >= presentationBudget.maxPriorityImpacts) continue;
        priorityImpacts++;
      } else {
        if (standardImpacts >= presentationBudget.maxStandardImpacts) continue;
        standardImpacts++;
      }
      const remaining = clamp(impact.life / impact.maxLife, 0, 1);
      const age = 1 - remaining;
      const x = toSX(impact.x);
      const groundY = toSY(impact.y);
      const angle = Math.atan2(Math.sin(impact.angle) * TILT, Math.cos(impact.angle));
      const frame = Math.min(5, Math.floor(clamp(age, 0, 0.999) * 6));
      const landing = impact.kind === 'landing';
      const airburst = impact.kind === 'airburst';
      const blastAir = impact.kind === 'blastair';
      const sprite = blastAir ? this.firstTouchAirSpr : landing ? this.knockoutSpr : this.contactHitSpr;
      const impactY = groundY - (landing ? 10 : blastAir ? 128 : airburst ? 78 : 24);
      const size = (landing ? 108 : blastAir ? 142 : airburst ? 98 : 76) * impact.strength;
      this.drawVfxFrame(
        ctx,
        sprite,
        frame,
        x,
        impactY,
        size,
        landing || blastAir ? 0 : angle,
        Math.min(1, remaining * 1.8),
        !blastAir,
      );
      this.lastPresentationMetrics.renderedImpacts++;
    }
    ctx.globalAlpha = 1;

    // Matchday Wipeout uses the authored six-stage stadium explosion but is
    // clamped to the audit's fair-play footprint. It renders before the final
    // hostile-warning pass, and the player receives a temporary contour so
    // neither danger nor control position disappears inside the spectacle.
    if (this.matchdayWipeoutStartedAt >= 0) {
      const age = time - this.matchdayWipeoutStartedAt;
      const duration = 0.72;
      if (age < duration) {
        const progress = clamp(age / duration, 0, 0.999);
        const frame = Math.min(5, Math.floor(progress * 6));
        const wipeoutVisual = matchdayWipeoutVisual(vw, vh, progress, this.reducedVfx);
        this.drawVfxFrame(
          ctx,
          this.matchdayWipeoutSpr,
          frame,
          toSX(sim.player.x),
          toSY(sim.player.y) - 20,
          wipeoutVisual.size,
          0,
          wipeoutVisual.alpha,
          false,
        );
        friendlyVfxOcclusion = wipeoutVisual.alpha * 0.82;
      } else {
        this.matchdayWipeoutStartedAt = -1;
      }
    }

    // Re-ink only the collision boundary of active danger after decorative
    // impacts. The ground fill remains correctly underneath bodies, while the
    // final two-pixel edge cannot be erased by friendly max-level spectacle.
    for (const telegraph of sim.telegraphs) {
      if (!telegraph.active || telegraph.kind === 'chant') continue;
      const progress = clamp(1 - telegraph.t / telegraph.max, 0, 1);
      const x = toSX(telegraph.x);
      const y = toSY(telegraph.y);
      const danger = telegraph.dmg > 0 || telegraph.kind === 'cone' || telegraph.kind === 'card' || telegraph.kind === 'shock';
      ctx.save();
      ctx.globalAlpha = 0.72 + progress * 0.28;
      ctx.strokeStyle = danger ? '#ff3855' : '#ffd65a';
      ctx.lineWidth = 2.4;
      ctx.lineCap = 'round';
      ctx.setLineDash([8, 6]);
      ctx.lineDashOffset = -time * 18;
      ctx.beginPath();
      if (telegraph.kind === 'cone' || telegraph.kind === 'card') {
        const radius = telegraph.r * (0.25 + progress * 0.75);
        const coneHalfAngle = telegraph.kind === 'card' ? Math.PI / 6 : 0.55;
        ctx.moveTo(x, y);
        ctx.ellipse(x, y, radius, radius * TILT, 0, telegraph.dir - coneHalfAngle, telegraph.dir + coneHalfAngle);
        ctx.closePath();
      } else {
        ctx.ellipse(x, y, telegraph.r, telegraph.r * TILT, 0, 0, TAU);
      }
      ctx.stroke();
      ctx.restore();
    }

    // The final player knockout is also a generated sequence. It has enough
    // time to complete before the result screen replaces the live pitch.
    if (sim.over === 'lost') {
      if (this.lossStartedAt < 0) this.lossStartedAt = time;
      const lossProgress = clamp((time - this.lossStartedAt) / 1.05, 0, 0.999);
      this.drawVfxFrame(
        ctx,
        this.knockoutSpr,
        Math.floor(lossProgress * 6),
        toSX(sim.player.x),
        toSY(sim.player.y) - 16,
        164,
        0,
        1 - lossProgress * 0.18,
        false,
      );
    } else {
      this.lossStartedAt = -1;
    }

    // The contour is intentionally delayed until all world-space effects have
    // rendered. It appears only while another living body covers the player,
    // preserving normal painter depth everywhere else.
    const playerLocatorStrength = Math.max(playerOcclusion, friendlyVfxOcclusion);
    if (playerOcclusionPose && playerLocatorStrength > 0.04 && sim.over !== 'lost') {
      this.drawPlayerOcclusionLocator(
        ctx,
        playerOcclusionPose.atlas,
        playerOcclusionPose.frame,
        playerOcclusionPose.x,
        playerOcclusionPose.y,
        playerOcclusionPose.scale,
        playerOcclusionPose.bobY,
        playerOcclusionPose.flip,
        playerLocatorStrength,
      );
    }
    this.lastPlayerOcclusion = playerOcclusion;

    // damage numbers
    ctx.textAlign = 'center';
    let standardDamageNumbers = 0;
    let criticalDamageNumbers = 0;
    for (const d of sim.dmgNums) {
      if (!d.active) continue;
      if (d.crit) {
        if (criticalDamageNumbers >= presentationBudget.maxCriticalDamageNumbers) continue;
        criticalDamageNumbers++;
      } else {
        if (standardDamageNumbers >= presentationBudget.maxStandardDamageNumbers) continue;
        standardDamageNumbers++;
      }
      const a = clamp(d.life / 0.7, 0, 1);
      ctx.globalAlpha = a;
      ctx.font = `bold ${d.crit ? 21 : 15}px system-ui, sans-serif`;
      ctx.strokeStyle = 'rgba(10,12,20,0.85)';
      ctx.lineWidth = 3.5;
      const x = toSX(d.x);
      const y = toSY(d.y) - 26;
      ctx.strokeText(d.value, x, y);
      ctx.fillStyle = d.crit ? '#ffd23f' : '#f5f7fa';
      ctx.fillText(d.value, x, y);
      this.lastPresentationMetrics.renderedDamageNumbers++;
    }
    ctx.globalAlpha = 1;

    // vignette
    const vg = ctx.createRadialGradient(vw / 2, vh / 2, vh * 0.42, vw / 2, vh / 2, vh * 0.85);
    vg.addColorStop(0, 'rgba(6,10,16,0)');
    vg.addColorStop(1, 'rgba(6,10,16,0.42)');
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, vw, vh);

    // Stoppage-Time Freeze keeps the field readable while clearly freezing
    // the hostile layer. A cool rim and scan sheen avoid a flat blue overlay.
    if (sim.freezeT > 0) {
      ctx.fillStyle = `rgba(82,210,255,${0.055 + 0.018 * Math.sin(time * 8)})`;
      ctx.fillRect(0, 0, vw, vh);
      const iceRim = ctx.createRadialGradient(vw / 2, vh / 2, vh * 0.3, vw / 2, vh / 2, vh * 0.82);
      iceRim.addColorStop(0, 'rgba(124,236,255,0)');
      iceRim.addColorStop(1, 'rgba(124,236,255,0.34)');
      ctx.fillStyle = iceRim;
      ctx.fillRect(0, 0, vw, vh);
    }

    // hurt flash
    if (this.flashWarn > 0) {
      this.flashWarn -= renderDt;
      const hurtStrength = clamp(this.flashWarn / 0.42, 0, 1);
      ctx.save();
      // Screen blending raises the warning red without subtracting the pitch's
      // green luminance. The prior source-over wash made the whole arena pulse
      // dark whenever several enemies landed consecutive hits.
      ctx.globalCompositeOperation = 'screen';
      ctx.fillStyle = `rgba(214,12,35,${hurtStrength * 0.045})`;
      ctx.fillRect(0, 0, vw, vh);
      const redVignette = ctx.createRadialGradient(vw / 2, vh / 2, vh * 0.18, vw / 2, vh / 2, vh * 0.76);
      redVignette.addColorStop(0, 'rgba(205,0,32,0)');
      redVignette.addColorStop(0.62, `rgba(235,12,42,${hurtStrength * 0.055})`);
      redVignette.addColorStop(1, `rgba(255,18,48,${hurtStrength * 0.52})`);
      ctx.fillStyle = redVignette;
      ctx.fillRect(0, 0, vw, vh);
      ctx.restore();
    }
    // paparazzo white flash
    if (this.flashWhiteT > 0) {
      this.flashWhiteT -= renderDt;
      ctx.fillStyle = `rgba(245,247,250,${Math.max(0, this.flashWhiteT) * 2.4})`;
      ctx.fillRect(0, 0, vw, vh);
    }

    if (debug) {
      ctx.fillStyle = '#80ed99';
      ctx.font = '13px monospace';
      ctx.textAlign = 'left';
      ctx.fillText(`enemies=${sim.enemies.filter((e) => e.active).length} scale=${scale.toFixed(2)}`, 10, vh - 10);
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  private drawCrowd(
    ctx: CanvasRenderingContext2D,
    toSX: (wx: number) => number,
    toSY: (wy: number) => number,
    wx0: number,
    wy0: number,
    vw: number,
    vh: number,
    time: number,
  ): void {
    // jumping crowd dots around the visible window edges (stands live in the margin ring)
    const colors = ['#e8e0d0', '#e0705a', '#6a8bd4', '#d4c46a', '#8ad49a', '#c09ad4'];
    const n = 130;
    for (let i = 0; i < n; i++) {
      const rx = this.crowdSeed[i * 2] ?? 0.5;
      const rz = this.crowdSeed[i * 2 + 1] ?? 0.5;
      const edge = i % 4;
      let x = 0;
      let y = 0;
      if (edge === 0) {
        x = wx0 + rx * vw;
        y = wy0 - 20 - rz * 240;
      } else if (edge === 1) {
        x = wx0 + rx * vw;
        y = wy0 + vh + 30 + rz * 240;
      } else if (edge === 2) {
        x = wx0 - 25 - rz * 240;
        y = wy0 + rx * vh;
      } else {
        x = wx0 + vw + 30 + rz * 240;
        y = wy0 + rx * vh;
      }
      const jump = Math.abs(Math.sin(time * 2.4 + i * 1.7)) * 5;
      ctx.fillStyle = colors[i % colors.length];
      ctx.fillRect(toSX(x), toSY(y) - jump, 6, 6);
    }
  }

  /** Subtle pitch-clipped spill from the stadium's upper-left floodlight bank.
   *
   * The Showpiece plate already contains detailed grass exposure. This pass
   * only unifies the newly live 2.5D construction and cast shadows under one
   * dominant light direction. Values stay below combat/VFX contrast and use
   * neutral-warm white rather than a coloured gameplay overlay. */
  private drawHybridFloodlightSpill(
    ctx: CanvasRenderingContext2D,
    toSX: (wx: number) => number,
    toSY: (wy: number) => number,
  ): void {
    const left = toSX(0);
    const right = toSX(ARENA_W);
    const top = toSY(0);
    const bottom = toSY(ARENA_H);
    const width = Math.max(1, right - left);
    const height = Math.max(1, bottom - top);

    ctx.save();
    ctx.beginPath();
    ctx.rect(left, top, width, height);
    ctx.clip();

    // Broad neutral floodlight pool follows the same upper-left source that
    // sends every object shadow down-right. The far edge remains brighter than
    // the near-right corner, but the maximum delta is only a few percent.
    const sourceX = left + width * 0.12;
    const sourceY = top - height * 0.34;
    const radius = Math.max(width * 0.95, height * 1.45);
    const flood = ctx.createRadialGradient(sourceX, sourceY, radius * 0.16, sourceX, sourceY, radius);
    flood.addColorStop(0, 'rgba(255,252,230,0.032)');
    flood.addColorStop(0.42, 'rgba(255,250,221,0.018)');
    flood.addColorStop(0.78, 'rgba(236,244,220,0.007)');
    flood.addColorStop(1, 'rgba(236,244,220,0)');
    ctx.fillStyle = flood;
    ctx.fillRect(left, top, width, height);

    // Narrow oblique shafts are fixed in world/screen projection and never
    // animate, so they cannot be read as attacks. Screen blending lifts only
    // highlights in the existing grass texture instead of tinting dark fibres.
    ctx.globalCompositeOperation = 'screen';
    for (let shaft = 0; shaft < 3; shaft++) {
      const startX = left - width * 0.09 + shaft * width * 0.36;
      const shaftW = width * (0.20 + shaft * 0.015);
      const shaftGradient = ctx.createLinearGradient(startX, top, startX + width * 0.32, bottom);
      shaftGradient.addColorStop(0, 'rgba(255,252,231,0.016)');
      shaftGradient.addColorStop(0.46, 'rgba(255,252,231,0.008)');
      shaftGradient.addColorStop(1, 'rgba(255,252,231,0)');
      ctx.fillStyle = shaftGradient;
      ctx.beginPath();
      ctx.moveTo(startX, top);
      ctx.lineTo(startX + shaftW, top);
      ctx.lineTo(startX + shaftW + width * 0.30, bottom);
      ctx.lineTo(startX + width * 0.30, bottom);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  /** Structural rear tier for the optional hybrid stadium.
   *
   * The arena plate already supplies detailed supporters. This pass adds only
   * architecture that benefits from a separate depth plane: portal shadows,
   * aisle spines, rear safety rails and section breaks. A tiny inverse camera
   * offset makes those fixed elements lag behind the pitch while the even-odd
   * clip guarantees they never enter gameplay turf. */
  private drawHybridStadiumParallax(
    ctx: CanvasRenderingContext2D,
    bounds: { x0: number; y0: number; x1: number; y1: number },
    sx: number,
    sy: number,
    vw: number,
    vh: number,
  ): void {
    const left = -bounds.x0 - sx;
    const right = ARENA_W - bounds.x0 - sx;
    const top = (-bounds.y0 * TILT) - sy;
    const bottom = ((ARENA_H - bounds.y0) * TILT) - sy;
    const pitchWidth = Math.max(1, right - left);
    const pitchHeight = Math.max(1, bottom - top);
    const offsetX = -hybridStadiumParallax(this.camX, ARENA_W / 2);
    const offsetY = -hybridStadiumParallax(this.camY, ARENA_H / 2) * TILT;

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, vw, vh);
    ctx.rect(left, top, pitchWidth, pitchHeight);
    ctx.clip('evenodd');
    ctx.translate(offsetX, offsetY);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // Six deep vomitory portals sit behind the lower bowl. Their inner bevel
    // and floor line retain readability without resembling dark HUD panels.
    for (let section = 0; section < 6; section++) {
      const centerX = left + ((section + 0.5) / 6) * pitchWidth;
      const portalW = 40 + (section % 2) * 6;
      for (const side of [-1, 1] as const) {
        const edgeY = side < 0 ? top - 73 : bottom + 73;
        const outerY = edgeY + side * 23;
        const portal = ctx.createLinearGradient(0, edgeY, 0, outerY);
        portal.addColorStop(0, 'rgba(15,25,27,0.76)');
        portal.addColorStop(0.32, 'rgba(3,9,13,0.92)');
        portal.addColorStop(1, 'rgba(0,4,7,0.98)');
        ctx.fillStyle = portal;
        ctx.beginPath();
        ctx.moveTo(centerX - portalW / 2, edgeY);
        ctx.lineTo(centerX + portalW / 2, edgeY);
        ctx.lineTo(centerX + portalW * 0.39, outerY);
        ctx.lineTo(centerX - portalW * 0.39, outerY);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = 'rgba(150,167,164,0.27)';
        ctx.lineWidth = 1.05;
        ctx.beginPath();
        ctx.moveTo(centerX - portalW / 2, edgeY);
        ctx.lineTo(centerX - portalW * 0.39, outerY);
        ctx.lineTo(centerX + portalW * 0.39, outerY);
        ctx.lineTo(centerX + portalW / 2, edgeY);
        ctx.stroke();
        ctx.strokeStyle = 'rgba(222,230,221,0.16)';
        ctx.lineWidth = 0.72;
        ctx.beginPath();
        ctx.moveTo(centerX - portalW * 0.31, edgeY + side * 5);
        ctx.lineTo(centerX + portalW * 0.31, edgeY + side * 5);
        ctx.stroke();
      }
    }

    // Rear aluminium rail is offset from the baked front barrier. Posts and
    // twin bars expose a second physical tier under lateral camera movement.
    const drawLongRail = (y: number, direction: -1 | 1): void => {
      const railY = y + direction * 106;
      ctx.strokeStyle = 'rgba(188,203,200,0.26)';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(left - 12, railY);
      ctx.lineTo(right + 12, railY);
      ctx.moveTo(left - 9, railY + direction * 5.5);
      ctx.lineTo(right + 9, railY + direction * 5.5);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(7,15,17,0.42)';
      ctx.lineWidth = 2.6;
      for (let postX = left + 26; postX < right - 18; postX += 94) {
        ctx.beginPath();
        ctx.moveTo(postX + 1.4, railY - direction * 1.5);
        ctx.lineTo(postX + 1.4, railY + direction * 15);
        ctx.stroke();
        ctx.strokeStyle = 'rgba(181,198,195,0.24)';
        ctx.lineWidth = 0.8;
        ctx.beginPath();
        ctx.moveTo(postX, railY);
        ctx.lineTo(postX, railY + direction * 14);
        ctx.stroke();
        ctx.strokeStyle = 'rgba(7,15,17,0.42)';
        ctx.lineWidth = 2.6;
      }
    };
    drawLongRail(top, -1);
    drawLongRail(bottom, 1);

    // Side-bowl aisle spines converge slightly toward the pitch, mirroring the
    // stepped concrete geometry visible in a modern World Cup stadium.
    for (const [edgeX, direction] of [[left, -1], [right, 1]] as const) {
      for (let aisle = 0; aisle < 5; aisle++) {
        const anchorY = top + ((aisle + 0.5) / 5) * pitchHeight;
        ctx.strokeStyle = 'rgba(180,194,191,0.19)';
        ctx.lineWidth = 3.4;
        ctx.beginPath();
        ctx.moveTo(edgeX + direction * 56, anchorY - 16);
        ctx.lineTo(edgeX + direction * 123, anchorY - 27 + (aisle - 2) * 3.2);
        ctx.stroke();
        ctx.strokeStyle = 'rgba(241,218,151,0.15)';
        ctx.lineWidth = 0.85;
        for (let step = 0; step < 6; step++) {
          const t = (step + 0.5) / 6;
          const x = edgeX + direction * (59 + t * 61);
          const y = anchorY - 17 + t * (-9 + (aisle - 2) * 3.2);
          ctx.beginPath();
          ctx.moveTo(x, y - 2.1);
          ctx.lineTo(x, y + 2.1);
          ctx.stroke();
        }
      }
    }
    ctx.restore();
  }

  /** Restrained runtime life for the detailed Showpiece plate.
   *
   * The effect is clipped to the stadium surround and uses a fixed seed table,
   * so no particles or allocations enter the dense combat loop. It animates
   * phone flashes and little supporter flags without ever drawing over turf.
   */
  private drawLiveShowpieceStadium(
    ctx: CanvasRenderingContext2D,
    bounds: { x0: number; y0: number; x1: number; y1: number },
    sx: number,
    sy: number,
    vw: number,
    vh: number,
    time: number,
  ): void {
    const left = -bounds.x0 - sx;
    const right = ARENA_W - bounds.x0 - sx;
    const top = (-bounds.y0 * TILT) - sy;
    const bottom = ((ARENA_H - bounds.y0) * TILT) - sy;

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, vw, vh);
    ctx.rect(left, top, Math.max(0, right - left), Math.max(0, bottom - top));
    ctx.clip('evenodd');

    const surroundW = Math.max(1, bounds.x1 - bounds.x0);
    const surroundH = Math.max(1, (bounds.y1 - bounds.y0) * TILT);
    const worldLeft = -sx;
    const worldRight = surroundW - sx;
    const worldTop = -sy;
    const worldBottom = surroundH - sy;
    const pitchWidth = Math.max(1, right - left);
    const pitchHeight = Math.max(1, bottom - top);
    for (let i = 0; i < 92; i++) {
      const seedA = this.crowdSeed[(i * 2) % this.crowdSeed.length] ?? 0.5;
      const seedB = this.crowdSeed[(i * 2 + 1) % this.crowdSeed.length] ?? 0.5;
      const side = i % 4;
      let x = worldLeft;
      let y = worldTop;
      if (side === 0 || side === 1) {
        x = worldLeft + seedA * surroundW;
        y = side === 0
          ? worldTop + seedB * Math.max(12, top - worldTop)
          : bottom + seedB * Math.max(12, worldBottom - bottom);
      } else {
        x = side === 2
          ? worldLeft + seedA * Math.max(12, left - worldLeft)
          : right + seedA * Math.max(12, worldRight - right);
        y = worldTop + seedB * surroundH;
      }
      if (x < -12 || x > vw + 12 || y < -12 || y > vh + 12) continue;
      const phase = time * (1.4 + seedB * 2.2) + i * 2.381;
      const flash = Math.max(0, Math.sin(phase * 0.73) - 0.965) / 0.035;
      if (flash > 0) {
        const radius = 2.1 + flash * 3.8;
        const glow = ctx.createRadialGradient(x, y, 0, x, y, radius);
        glow.addColorStop(0, `rgba(255,251,224,${0.8 * flash})`);
        glow.addColorStop(1, 'rgba(255,244,198,0)');
        ctx.fillStyle = glow;
        ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
      }
      // Tiny paired torso/head motions reinforce the baked spectators instead
      // of adding free-floating particles. Only selected seeds animate and the
      // surround clip prevents all overlap with the pitch.
      if (i % 5 === 1 || i % 11 === 3) {
        const cheer = Math.max(0, Math.sin(phase * 0.46 + seedA * 3.1));
        const lift = cheer * (0.75 + seedB * 1.2);
        const shirtColors = [
          'rgba(207,54,70,0.27)',
          'rgba(45,112,181,0.27)',
          'rgba(232,181,52,0.25)',
          'rgba(226,228,218,0.24)',
        ];
        ctx.fillStyle = 'rgba(219,181,142,0.24)';
        ctx.beginPath();
        ctx.arc(x, y - 3.2 - lift, 1.15, 0, TAU);
        ctx.fill();
        ctx.fillStyle = shirtColors[i % shirtColors.length];
        ctx.fillRect(x - 1.5, y - 1.6 - lift, 3, 3.2);
        if (cheer > 0.62) {
          ctx.strokeStyle = shirtColors[(i + 1) % shirtColors.length];
          ctx.lineWidth = 0.72;
          ctx.beginPath();
          ctx.moveTo(x - 1.1, y - 1.1 - lift);
          ctx.lineTo(x - 2.8, y - 4.2 - lift);
          ctx.moveTo(x + 1.1, y - 1.1 - lift);
          ctx.lineTo(x + 2.8, y - 4.2 - lift);
          ctx.stroke();
        }
      }
      if (i % 7 === 0) {
        const wave = Math.sin(phase) * 2.5;
        ctx.strokeStyle = 'rgba(226,230,220,0.42)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, y + 4);
        ctx.lineTo(x, y - 8);
        ctx.stroke();
        ctx.fillStyle = i % 14 === 0 ? 'rgba(222,49,70,0.72)' : 'rgba(238,185,49,0.72)';
        ctx.beginPath();
        ctx.moveTo(x, y - 8);
        ctx.lineTo(x + 8 + wave, y - 5);
        ctx.lineTo(x, y - 1);
        ctx.fill();
      }
    }

    // Stadium LED chase and camera tally lights are deliberately confined to
    // the touchline surround. The pulses are sparse, subtle and allocation-free.
    const pulse = 0.5 + 0.5 * Math.sin(time * 2.15);
    const boardAlpha = 0.12 + pulse * 0.14;
    ctx.lineCap = 'round';
    ctx.lineWidth = 2;
    for (let i = 0; i < 18; i++) {
      const phase = (i / 18 + time * 0.055) % 1;
      const x = left + phase * Math.max(1, right - left);
      ctx.strokeStyle = i % 3 === 0
        ? `rgba(226,57,78,${boardAlpha})`
        : i % 3 === 1
          ? `rgba(238,189,58,${boardAlpha})`
          : `rgba(67,147,202,${boardAlpha})`;
      ctx.beginPath();
      ctx.moveTo(x - 13, top - 8);
      ctx.lineTo(x + 13, top - 8);
      ctx.moveTo(x - 13, bottom + 8);
      ctx.lineTo(x + 13, bottom + 8);
      ctx.stroke();
    }
    for (let i = 0; i < 8; i++) {
      const x = left + ((i + 0.5) / 8) * Math.max(1, right - left);
      const tally = Math.max(0, Math.sin(time * 1.35 + i * 1.7) - 0.82) / 0.18;
      if (tally <= 0) continue;
      ctx.fillStyle = `rgba(255,52,64,${0.28 + tally * 0.58})`;
      ctx.beginPath();
      ctx.arc(x, top - 20, 1.4 + tally * 1.2, 0, TAU);
      ctx.arc(x, bottom + 20, 1.4 + tally * 1.2, 0, TAU);
      ctx.fill();
    }

    // Warm aisle markers give the dark lower bowl readable depth at gameplay
    // scale. Each short dash follows a fixed access path away from the pitch;
    // there are no travelling lights or random flashes that could read as
    // pickups, projectiles or combat telegraphs.
    const aisleAlpha = 0.16 + (0.5 + 0.5 * Math.sin(time * 0.42)) * 0.025;
    const aisleTopDepth = Math.max(0, top - worldTop - 36);
    const aisleBottomDepth = Math.max(0, worldBottom - bottom - 36);
    ctx.lineCap = 'round';
    for (let aisle = 0; aisle < 6; aisle++) {
      const anchorX = left + ((aisle + 0.5) / 6) * pitchWidth;
      const lean = (aisle - 2.5) * 1.8;
      for (let step = 0; step < 7; step++) {
        const depthT = (step + 0.7) / 7;
        const topY = top - 25 - depthT * aisleTopDepth;
        const bottomY = bottom + 25 + depthT * aisleBottomDepth;
        const x = anchorX + lean * depthT;
        const markerAlpha = aisleAlpha * (0.72 + depthT * 0.28);
        ctx.strokeStyle = `rgba(255,210,113,${markerAlpha})`;
        ctx.lineWidth = 1.35;
        ctx.beginPath();
        ctx.moveTo(x - 2.4, topY);
        ctx.lineTo(x + 2.4, topY);
        ctx.moveTo(x - 2.4, bottomY);
        ctx.lineTo(x + 2.4, bottomY);
        ctx.stroke();
      }
    }
    const aisleLeftDepth = Math.max(0, left - worldLeft - 36);
    const aisleRightDepth = Math.max(0, worldRight - right - 36);
    for (let aisle = 0; aisle < 4; aisle++) {
      const anchorY = top + ((aisle + 0.5) / 4) * pitchHeight;
      const lean = (aisle - 1.5) * 1.6;
      for (let step = 0; step < 6; step++) {
        const depthT = (step + 0.7) / 6;
        const leftX = left - 25 - depthT * aisleLeftDepth;
        const rightX = right + 25 + depthT * aisleRightDepth;
        const y = anchorY + lean * depthT;
        const markerAlpha = aisleAlpha * (0.72 + depthT * 0.28);
        ctx.strokeStyle = `rgba(255,210,113,${markerAlpha})`;
        ctx.lineWidth = 1.35;
        ctx.beginPath();
        ctx.moveTo(leftX, y - 2.4);
        ctx.lineTo(leftX, y + 2.4);
        ctx.moveTo(rightX, y - 2.4);
        ctx.lineTo(rightX, y + 2.4);
        ctx.stroke();
      }
    }

    // Crisp construction details are rendered after the lossy arena plate so
    // its smallest rails, drain teeth and fasteners survive runtime scaling.
    // The even-odd clip above guarantees every stroke remains outside turf.
    ctx.lineCap = 'butt';
    ctx.strokeStyle = 'rgba(205,218,216,0.22)';
    ctx.lineWidth = 1;
    for (let x = left + 9; x < right - 7; x += 37) {
      const offset = ((Math.floor(x) * 13) % 7) - 3;
      ctx.beginPath();
      ctx.moveTo(x, top - 25 + offset * 0.2);
      ctx.lineTo(x, top - 7);
      ctx.moveTo(x + 17, bottom + 7);
      ctx.lineTo(x + 17, bottom + 25 - offset * 0.2);
      ctx.stroke();
    }
    for (let y = top + 11; y < bottom - 9; y += 35) {
      const offset = ((Math.floor(y) * 11) % 7) - 3;
      ctx.beginPath();
      ctx.moveTo(left - 24 + offset * 0.2, y);
      ctx.lineTo(left - 7, y);
      ctx.moveTo(right + 7, y + 16);
      ctx.lineTo(right + 24 - offset * 0.2, y + 16);
      ctx.stroke();
    }

    // Drainage slots and individual retaining bolts create a fine mechanical
    // seam at the grass boundary without turning it into a bright outline.
    ctx.strokeStyle = 'rgba(151,170,168,0.27)';
    ctx.lineWidth = 0.8;
    for (let x = left + 5, index = 0; x < right - 4; x += 14, index++) {
      const depth = 3 + (index % 3);
      ctx.beginPath();
      ctx.moveTo(x, top - 2);
      ctx.lineTo(x + 1.5, top - depth);
      ctx.moveTo(x + 6, bottom + 2);
      ctx.lineTo(x + 7.5, bottom + depth);
      ctx.stroke();
      if (index % 4 === 0) {
        ctx.fillStyle = 'rgba(226,230,218,0.30)';
        ctx.beginPath();
        ctx.arc(x + 3, top - 7, 0.85, 0, TAU);
        ctx.arc(x + 9, bottom + 7, 0.85, 0, TAU);
        ctx.fill();
      }
    }
    for (let y = top + 5, index = 0; y < bottom - 4; y += 14, index++) {
      const depth = 3 + (index % 3);
      ctx.beginPath();
      ctx.moveTo(left - 2, y);
      ctx.lineTo(left - depth, y + 1.5);
      ctx.moveTo(right + 2, y + 6);
      ctx.lineTo(right + depth, y + 7.5);
      ctx.stroke();
    }

    // Short diagonal glass catches appear only on a subset of panels and use
    // fixed geometry, avoiding a synthetic continuous shine.
    ctx.strokeStyle = 'rgba(221,240,239,0.13)';
    ctx.lineWidth = 1.1;
    for (let panel = 0; panel < 22; panel++) {
      const x = left + ((panel + 0.35) / 22) * pitchWidth;
      if (panel % 3 !== 1) continue;
      ctx.beginPath();
      ctx.moveTo(x - 6, top - 33);
      ctx.lineTo(x + 7, top - 24);
      ctx.moveTo(x + 13, bottom + 24);
      ctx.lineTo(x + 1, bottom + 33);
      ctx.stroke();
    }
    for (let panel = 0; panel < 12; panel++) {
      const y = top + ((panel + 0.4) / 12) * pitchHeight;
      if (panel % 3 !== 0) continue;
      ctx.beginPath();
      ctx.moveTo(left - 33, y - 6);
      ctx.lineTo(left - 24, y + 7);
      ctx.moveTo(right + 24, y + 13);
      ctx.lineTo(right + 33, y + 1);
      ctx.stroke();
    }

    // Technical rubber walkway: broad slab seams, shallow caster scuffs and
    // cable-channel covers. These marks remain dark and textless so the apron
    // gains scale without competing with pickups or attack telegraphs.
    ctx.strokeStyle = 'rgba(4,12,15,0.31)';
    ctx.lineWidth = 1.2;
    for (let slab = 0; slab <= 28; slab++) {
      const x = worldLeft + (slab / 28) * surroundW;
      const skipTop = x > left - 80 && x < right + 80;
      if (!skipTop || slab % 4 === 0) {
        ctx.beginPath();
        ctx.moveTo(x, worldTop + 5);
        ctx.lineTo(x + ((slab * 13) % 5) - 2, Math.max(worldTop + 8, top - 38));
        ctx.moveTo(x + 7, Math.min(worldBottom - 8, bottom + 38));
        ctx.lineTo(x + 7, worldBottom - 5);
        ctx.stroke();
      }
    }
    for (let slab = 0; slab <= 18; slab++) {
      const y = worldTop + (slab / 18) * surroundH;
      ctx.beginPath();
      ctx.moveTo(worldLeft + 5, y);
      ctx.lineTo(Math.max(worldLeft + 8, left - 38), y + ((slab * 11) % 5) - 2);
      ctx.moveTo(Math.min(worldRight - 8, right + 38), y + 7);
      ctx.lineTo(worldRight - 5, y + 7);
      ctx.stroke();
    }

    // Paired channel lids with hinge bolts imply broadcast/power cabling.
    const channelColor = 'rgba(131,148,150,0.19)';
    ctx.strokeStyle = channelColor;
    ctx.lineWidth = 1;
    for (let segment = 0; segment < 16; segment++) {
      const x = left + ((segment + 0.25) / 16) * pitchWidth;
      const width = pitchWidth / 16 * 0.52;
      for (const y of [top - 47, bottom + 47]) {
        ctx.strokeRect(x, y - 3, width, 6);
        ctx.fillStyle = 'rgba(205,213,204,0.24)';
        ctx.beginPath();
        ctx.arc(x + 3, y, 0.75, 0, TAU);
        ctx.arc(x + width - 3, y, 0.75, 0, TAU);
        ctx.fill();
      }
    }

    // Sparse caster and boot scuffs use short paired arcs rather than circles,
    // keeping them recognisably physical and never pickup-shaped.
    ctx.strokeStyle = 'rgba(0,5,7,0.20)';
    ctx.lineWidth = 0.9;
    for (let mark = 0; mark < 38; mark++) {
      const seedA = this.crowdSeed[(mark * 5 + 23) % this.crowdSeed.length] ?? 0.5;
      const seedB = this.crowdSeed[(mark * 5 + 24) % this.crowdSeed.length] ?? 0.5;
      const side = mark % 4;
      let x = left + seedA * pitchWidth;
      let y = top - 54 - seedB * Math.max(10, top - worldTop - 62);
      if (side === 1) y = bottom + 54 + seedB * Math.max(10, worldBottom - bottom - 62);
      if (side === 2) {
        x = left - 54 - seedB * Math.max(10, left - worldLeft - 62);
        y = top + seedA * pitchHeight;
      }
      if (side === 3) {
        x = right + 54 + seedB * Math.max(10, worldRight - right - 62);
        y = top + seedA * pitchHeight;
      }
      const rotation = mark * 0.83;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(rotation);
      ctx.beginPath();
      ctx.arc(0, 0, 5 + (mark % 4), -0.8, 0.75);
      ctx.arc(3, 1.5, 5 + (mark % 3), Math.PI - 0.65, Math.PI + 0.7);
      ctx.stroke();
      ctx.restore();
    }
    ctx.restore();
  }

  /** Sparse world-fixed fibres catch light as a restrained breeze crosses the
   *  pitch. Positions are deterministic, camera-independent and allocation-free;
   *  low alpha prevents water-like shimmer or interference with combat reads. */
  private drawTurfWindFibres(
    ctx: CanvasRenderingContext2D,
    toSX: (wx: number) => number,
    toSY: (wy: number) => number,
    time: number,
    fibreBudget: number,
  ): void {
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineWidth = 0.7;
    for (let fibre = 0; fibre < fibreBudget; fibre++) {
      const seedA = this.crowdSeed[(fibre * 4 + 17) % this.crowdSeed.length] ?? 0.5;
      const seedB = this.crowdSeed[(fibre * 4 + 18) % this.crowdSeed.length] ?? 0.5;
      const seedC = this.crowdSeed[(fibre * 4 + 19) % this.crowdSeed.length] ?? 0.5;
      const worldX = 55 + seedA * (ARENA_W - 110);
      const worldY = 55 + seedB * (ARENA_H - 110);
      const wave = Math.sin(time * (0.42 + seedC * 0.24) + fibre * 1.791);
      const visibility = Math.max(0, Math.abs(wave) - 0.47) / 0.53;
      if (visibility <= 0.02) continue;
      const x = toSX(worldX);
      const y = toSY(worldY);
      const lean = wave * (1.2 + seedC * 1.6);
      const length = 2.2 + seedC * 2.4;
      ctx.strokeStyle = wave > 0
        ? `rgba(221,224,148,${visibility * 0.105})`
        : `rgba(55,69,21,${visibility * 0.09})`;
      ctx.beginPath();
      ctx.moveTo(x, y + 1.2);
      ctx.quadraticCurveTo(x + lean * 0.45, y - length * 0.45, x + lean, y - length);
      ctx.stroke();
    }
    ctx.restore();
  }

  /** Four physical corner assemblies with deterministic cloth motion. */
  private drawHybridPitchMarkings(
    ctx: CanvasRenderingContext2D,
    toSX: (wx: number) => number,
    toSY: (wy: number) => number,
  ): void {
    interface MarkPoint { x: number; y: number }
    const project = (x: number, y: number): MarkPoint => ({ x: toSX(x), y: toSY(y) });
    const noise = (seed: number): number => {
      const value = Math.sin(seed * 12.9898 + 31.173) * 43758.5453;
      return value - Math.floor(value);
    };
    const strokeWornPolyline = (points: MarkPoint[], seed: number): void => {
      if (points.length < 2) return;
      const path = (): void => {
        ctx.beginPath();
        ctx.moveTo(points[0].x, points[0].y);
        for (let index = 1; index < points.length; index++) ctx.lineTo(points[index].x, points[index].y);
      };
      ctx.strokeStyle = 'rgba(8,28,14,0.18)';
      ctx.lineWidth = 3.8;
      path();
      ctx.stroke();
      ctx.strokeStyle = 'rgba(248,247,232,0.59)';
      ctx.lineWidth = 1.85;
      path();
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,250,0.22)';
      ctx.lineWidth = 0.55;
      path();
      ctx.stroke();

      // Olive interruptions and loose pigment remove the vector-clean edge.
      for (let segment = 0; segment < points.length - 1; segment++) {
        const start = points[segment];
        const end = points[segment + 1];
        const dx = end.x - start.x;
        const dy = end.y - start.y;
        const length = Math.hypot(dx, dy) || 1;
        const tangentX = dx / length;
        const tangentY = dy / length;
        const count = Math.max(1, Math.floor(length / 39));
        for (let chip = 0; chip < count; chip++) {
          const chipSeed = seed + segment * 97 + chip * 19;
          if (noise(chipSeed + 23) < 0.31) continue;
          const t = (chip + 0.3 + noise(chipSeed) * 0.45) / count;
          const x = start.x + dx * t;
          const y = start.y + dy * t;
          const chipLength = 0.9 + noise(chipSeed + 4) * 2.2;
          ctx.strokeStyle = `rgba(67,87,37,${0.20 + noise(chipSeed + 9) * 0.17})`;
          ctx.lineWidth = 0.62 + noise(chipSeed + 13) * 0.66;
          ctx.beginPath();
          ctx.moveTo(x - tangentX * chipLength / 2, y - tangentY * chipLength / 2);
          ctx.lineTo(x + tangentX * chipLength / 2, y + tangentY * chipLength / 2);
          ctx.stroke();
          if (noise(chipSeed + 31) > 0.72) {
            ctx.fillStyle = 'rgba(255,253,227,0.20)';
            ctx.fillRect(x - tangentY * 2.2, y + tangentX * 2.2, 0.9, 0.7);
          }
        }
      }
    };

    const erodeChalkPolyline = (points: MarkPoint[], seed: number, spacing = 18): void => {
      for (let segment = 0; segment < points.length - 1; segment++) {
        const start = points[segment];
        const end = points[segment + 1];
        const dx = end.x - start.x;
        const dy = end.y - start.y;
        const length = Math.hypot(dx, dy) || 1;
        const tangentX = dx / length;
        const tangentY = dy / length;
        const count = Math.max(1, Math.floor(length / spacing));
        for (let chip = 0; chip < count; chip++) {
          const chipSeed = seed + segment * 151 + chip * 29;
          if (noise(chipSeed + 7) < 0.70) continue;
          const t = clamp((chip + 0.16 + noise(chipSeed) * 0.68) / count, 0, 1);
          const x = start.x + dx * t;
          const y = start.y + dy * t;
          const halfLength = 0.7 + noise(chipSeed + 3) * 2.35;
          ctx.strokeStyle = noise(chipSeed + 17) > 0.82
            ? `rgba(105,111,54,${0.20 + noise(chipSeed + 21) * 0.12})`
            : `rgba(54,76,31,${0.26 + noise(chipSeed + 21) * 0.16})`;
          ctx.lineWidth = 1.45 + noise(chipSeed + 11) * 1.15;
          ctx.beginPath();
          ctx.moveTo(x - tangentX * halfLength, y - tangentY * halfLength);
          ctx.lineTo(x + tangentX * halfLength, y + tangentY * halfLength);
          ctx.stroke();

          // A few kicked-off grains beside the line keep the damage physical
          // instead of reading as a regular dashed gameplay indicator.
          if (noise(chipSeed + 31) > 0.42) {
            const side = noise(chipSeed + 37) > 0.5 ? 1 : -1;
            const offset = 2.4 + noise(chipSeed + 41) * 3.8;
            ctx.fillStyle = `rgba(245,242,216,${0.16 + noise(chipSeed + 43) * 0.14})`;
            ctx.fillRect(
              x - tangentY * offset * side,
              y + tangentX * offset * side,
              0.65 + noise(chipSeed + 47) * 0.9,
              0.55 + noise(chipSeed + 53) * 0.65,
            );
          }
        }
      }
    };

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // The generated Showpiece plate provides the registered base geometry,
    // but its middle line and circle are deliberately clean. Rebuild that
    // centre as physical chalk over asymmetric boot wear, then abrade it in
    // screen space. The result remains grounded under the 2.5D projection and
    // avoids the look of a bright target ring behind the player.
    const centre = hybridCentreMarkingGeometry();
    const centreX = toSX(centre.circleX);
    const centreY = toSY(centre.circleY);
    ctx.save();
    ctx.translate(centreX + 9, centreY - 2);
    ctx.scale(1, 0.54);
    const centreWear = ctx.createRadialGradient(-16, 4, 4, 0, 0, 118);
    centreWear.addColorStop(0, 'rgba(82,83,39,0.15)');
    centreWear.addColorStop(0.46, 'rgba(68,79,34,0.10)');
    centreWear.addColorStop(1, 'rgba(48,70,28,0)');
    ctx.fillStyle = centreWear;
    ctx.beginPath();
    ctx.ellipse(0, 0, 118, 97, -0.08, 0, TAU);
    ctx.fill();
    ctx.restore();

    for (let scuff = 0; scuff < 34; scuff++) {
      const scuffSeed = 1901 + scuff * 23;
      const angle = noise(scuffSeed) * TAU;
      const radius = Math.sqrt(noise(scuffSeed + 3)) * 111;
      const x = centreX + Math.cos(angle) * radius + 9;
      const y = centreY + Math.sin(angle) * radius * 0.50 - 2;
      const sweep = (noise(scuffSeed + 5) > 0.48 ? 1 : -1) * (2.2 + noise(scuffSeed + 7) * 5.2);
      ctx.strokeStyle = scuff % 7 === 0
        ? `rgba(132,128,65,${0.12 + noise(scuffSeed + 9) * 0.09})`
        : `rgba(40,64,26,${0.12 + noise(scuffSeed + 9) * 0.12})`;
      ctx.lineWidth = 0.68 + noise(scuffSeed + 11) * 0.72;
      ctx.beginPath();
      ctx.moveTo(x - sweep, y + 1.8);
      ctx.quadraticCurveTo(x, y - 1.4, x + sweep * 0.82, y - 2.1);
      ctx.stroke();
    }

    const halfwayPoints: MarkPoint[] = [];
    const halfwaySteps = 38;
    for (let step = 0; step <= halfwaySteps; step++) {
      halfwayPoints.push(project(
        centre.lineX + (noise(2101 + step * 13) - 0.5) * 0.46,
        centre.top + (centre.bottom - centre.top) * step / halfwaySteps,
      ));
    }
    const circlePoints: MarkPoint[] = [];
    const circleSteps = 72;
    for (let step = 0; step <= circleSteps; step++) {
      const angle = step / circleSteps * TAU;
      const radius = centre.radius + (noise(2503 + step * 17) - 0.5) * 0.68;
      circlePoints.push(project(
        centre.circleX + Math.cos(angle) * radius,
        centre.circleY + Math.sin(angle) * radius,
      ));
    }
    strokeWornPolyline(halfwayPoints, 2203);
    strokeWornPolyline(circlePoints, 2609);
    erodeChalkPolyline(halfwayPoints, 2801, 17);
    erodeChalkPolyline(circlePoints, 3203, 16);

    // The centre spot is a ragged paint deposit with cleat cuts, not a smooth
    // floating disc. The source spot remains underneath for perfect register.
    for (let fibre = 0; fibre < 17; fibre++) {
      const fibreSeed = 3607 + fibre * 19;
      const angle = noise(fibreSeed) * TAU;
      const radius = 2 + noise(fibreSeed + 5) * 8.6;
      const x = centreX + Math.cos(angle) * radius;
      const y = centreY + Math.sin(angle) * radius * 0.52;
      ctx.strokeStyle = fibre % 5 === 0
        ? 'rgba(247,243,216,0.22)'
        : `rgba(45,69,28,${0.17 + noise(fibreSeed + 11) * 0.17})`;
      ctx.lineWidth = 0.55 + noise(fibreSeed + 13) * 0.54;
      ctx.beginPath();
      ctx.moveTo(x - 1.2, y + 1.3);
      ctx.lineTo(x + 1.4 + noise(fibreSeed + 17) * 1.8, y - 1.1);
      ctx.stroke();
    }

    for (const side of ['left', 'right'] as const) {
      const geometry = hybridPitchMarkingGeometry(side);
      const direction = side === 'left' ? 1 : -1;

      // Layered keeper-box wear belongs below the chalk. Its broken ovals and
      // cleat cuts read as disturbed turf, never a gameplay selection ring.
      const wearX = toSX(geometry.goalLineX + direction * 72);
      const wearY = toSY(ARENA_H / 2);
      const wearGradient = ctx.createRadialGradient(wearX, wearY, 3, wearX, wearY, 88);
      wearGradient.addColorStop(0, 'rgba(83,82,36,0.18)');
      wearGradient.addColorStop(0.55, 'rgba(68,76,32,0.12)');
      wearGradient.addColorStop(1, 'rgba(55,74,31,0)');
      ctx.fillStyle = wearGradient;
      ctx.save();
      ctx.translate(wearX, wearY);
      ctx.scale(1, 0.58);
      ctx.beginPath();
      ctx.arc(0, 0, 88, 0, TAU);
      ctx.fill();
      ctx.restore();
      for (let scuff = 0; scuff < 22; scuff++) {
        const scuffSeed = (side === 'left' ? 701 : 907) + scuff * 17;
        const x = wearX + (noise(scuffSeed) - 0.5) * 132;
        const y = wearY + (noise(scuffSeed + 3) - 0.5) * 66;
        const lean = direction * (2.5 + noise(scuffSeed + 5) * 4.5);
        ctx.strokeStyle = `rgba(45,61,25,${0.13 + noise(scuffSeed + 7) * 0.11})`;
        ctx.lineWidth = 0.75 + noise(scuffSeed + 11) * 0.65;
        ctx.beginPath();
        ctx.moveTo(x - lean, y + 2.2);
        ctx.quadraticCurveTo(x, y - 1.8, x + lean, y - 2.6);
        ctx.stroke();
      }

      strokeWornPolyline([
        project(geometry.goalLineX, geometry.penaltyTop),
        project(geometry.penaltyLineX, geometry.penaltyTop),
        project(geometry.penaltyLineX, geometry.penaltyBottom),
        project(geometry.goalLineX, geometry.penaltyBottom),
      ], side === 'left' ? 101 : 211);
      strokeWornPolyline([
        project(geometry.goalLineX, geometry.goalAreaTop),
        project(geometry.goalAreaLineX, geometry.goalAreaTop),
        project(geometry.goalAreaLineX, geometry.goalAreaBottom),
        project(geometry.goalLineX, geometry.goalAreaBottom),
      ], side === 'left' ? 307 : 419);

      const arcPoints: MarkPoint[] = [];
      const arcSteps = 34;
      for (let step = 0; step <= arcSteps; step++) {
        const angle = geometry.arcStart + (geometry.arcEnd - geometry.arcStart) * step / arcSteps;
        arcPoints.push(project(
          geometry.penaltySpotX + Math.cos(angle) * HYBRID_PENALTY_ARC_RADIUS,
          ARENA_H / 2 + Math.sin(angle) * HYBRID_PENALTY_ARC_RADIUS,
        ));
      }
      strokeWornPolyline(arcPoints, side === 'left' ? 521 : 631);

      const spotX = toSX(geometry.penaltySpotX);
      const spotY = toSY(ARENA_H / 2);
      const spotSeed = side === 'left' ? 1301 : 1709;
      // The Showpiece source already contains the painted spot. Do not stack a
      // second white mark on top; integrate it with short disturbed fibres.
      ctx.lineCap = 'round';
      for (let fibre = 0; fibre < 13; fibre++) {
        const angle = noise(spotSeed + fibre * 17) * TAU;
        const radius = 5.4 + noise(spotSeed + fibre * 17 + 5) * 6.8;
        const x = spotX + Math.cos(angle) * radius;
        const y = spotY + Math.sin(angle) * radius * 0.56;
        const lean = Math.cos(angle) * (1.2 + noise(spotSeed + fibre * 17 + 11) * 2.4);
        const length = 0.8 + noise(spotSeed + fibre * 17 + 19) * 1.25;
        ctx.strokeStyle = fibre % 4 === 0
          ? 'rgba(123,125,65,0.20)'
          : `rgba(42,67,29,${0.15 + noise(spotSeed + fibre * 17 + 23) * 0.13})`;
        ctx.lineWidth = 0.52 + noise(spotSeed + fibre * 17 + 29) * 0.42;
        ctx.beginPath();
        ctx.moveTo(x - lean * 0.25, y + length * 0.35);
        ctx.lineTo(x + lean, y - length * 0.65);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  /** Small deterministic cloth motion for the four physical corner poles. */
  private drawLiveCornerFlags(
    ctx: CanvasRenderingContext2D,
    toSX: (wx: number) => number,
    toSY: (wy: number) => number,
    time: number,
  ): void {
    const corners = [
      [40, 40, 1, 1],
      [ARENA_W - 40, 40, -1, 1],
      [40, ARENA_H - 40, 1, -1],
      [ARENA_W - 40, ARENA_H - 40, -1, -1],
    ] as const;
    ctx.save();
    for (let index = 0; index < corners.length; index++) {
      const [worldX, worldY, inwardX, inwardY] = corners[index];
      const screenX = toSX(worldX);
      const screenGroundY = toSY(worldY);
      const hybrid = this.hybridDepth;
      const flagDepthScale = hybrid ? hybridCornerFlagDepthScale(worldY) : 1;
      ctx.save();
      ctx.translate(screenX, screenGroundY);
      ctx.scale(flagDepthScale, flagDepthScale);
      const x = 0;
      const groundY = 0;
      const wave = Math.sin(time * 1.65 + index * 1.37);
      const flutter = Math.sin(time * 3.4 + index * 2.11) * 0.85;
      const direction = inwardX;
      const poleHeight = hybrid ? 48 : 34 * TILT;
      const poleTopX = x + (hybrid ? -2.4 : 0);
      const poleTop = groundY - poleHeight;
      const tailX = x + direction * (20.5 + wave * 2.1);
      const centerY = poleTop + (hybrid ? 9.2 : 7.2 * TILT) + inwardY * flutter * 0.24;
      const controlX = poleTopX + direction * (hybrid ? 12.2 : 9.5 + wave * 1.15);

      if (hybrid) {
        // Directional cast and tight contact mark establish the pole's exact
        // turf insertion point without adding a selection-style ring.
        ctx.fillStyle = 'rgba(2,11,7,0.10)';
        ctx.beginPath();
        ctx.moveTo(x - 1.5, groundY + 1.2);
        ctx.quadraticCurveTo(x + 15, groundY + 8.5, x + 31, groundY + 18.4);
        ctx.quadraticCurveTo(x + 15, groundY + 12.1, x - 1.5, groundY + 3.2);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = 'rgba(1,9,6,0.31)';
        ctx.beginPath();
        ctx.ellipse(x + 1.2, groundY + 1.5, 4.5, 1.8, 0.04, 0, TAU);
        ctx.fill();

        // Silver ground socket, rubber collar and two anchor tabs make the
        // flag belong to the pitch instead of hovering over it.
        const socket = ctx.createLinearGradient(x - 4, 0, x + 4, 0);
        socket.addColorStop(0, 'rgba(74,86,82,0.96)');
        socket.addColorStop(0.43, 'rgba(231,237,230,0.94)');
        socket.addColorStop(0.7, 'rgba(131,147,140,0.96)');
        socket.addColorStop(1, 'rgba(34,48,44,0.98)');
        ctx.fillStyle = 'rgba(3,12,9,0.92)';
        ctx.beginPath();
        ctx.ellipse(x, groundY + 0.5, 4.2, 2, 0, 0, TAU);
        ctx.fill();
        ctx.fillStyle = socket;
        ctx.beginPath();
        ctx.roundRect(x - 2.35, groundY - 5.4, 4.7, 6.2, 1.4);
        ctx.fill();
        ctx.strokeStyle = 'rgba(221,229,219,0.44)';
        ctx.lineWidth = 0.75;
        for (const tabX of [x - 5.2, x + 5.2]) {
          ctx.beginPath();
          ctx.moveTo(tabX, groundY + 0.3);
          ctx.lineTo(x + Math.sign(tabX - x) * 2.7, groundY - 1.6);
          ctx.stroke();
        }

        // Flexible fibreglass pole: dark cast, warm core and fine highlight.
        const drawPole = (): void => {
          ctx.beginPath();
          ctx.moveTo(x, groundY - 3.6);
          ctx.quadraticCurveTo(x - 0.9 + wave * 0.24, groundY - poleHeight * 0.54, poleTopX, poleTop);
        };
        ctx.save();
        ctx.translate(1.8, 2.1);
        ctx.strokeStyle = 'rgba(1,9,7,0.62)';
        ctx.lineWidth = 4.3;
        drawPole();
        ctx.stroke();
        ctx.restore();
        ctx.strokeStyle = 'rgba(244,226,169,0.96)';
        ctx.lineWidth = 2.55;
        drawPole();
        ctx.stroke();
        ctx.save();
        ctx.translate(-0.62, -0.38);
        ctx.strokeStyle = 'rgba(255,252,228,0.68)';
        ctx.lineWidth = 0.72;
        drawPole();
        ctx.stroke();
        ctx.restore();

        // Two dark rope loops visibly attach the cloth at mobile scale.
        ctx.strokeStyle = 'rgba(20,29,25,0.78)';
        ctx.lineWidth = 0.92;
        for (const tetherY of [poleTop + 2.3, poleTop + 14.3]) {
          ctx.beginPath();
          ctx.ellipse(poleTopX + direction * 0.2, tetherY, 1.65, 1.05, 0, 0, TAU);
          ctx.stroke();
        }
      }

      const drawCloth = (): void => {
        ctx.beginPath();
        ctx.moveTo(poleTopX, poleTop);
        ctx.quadraticCurveTo(controlX, poleTop + (hybrid ? 3.4 : 2.7 * TILT) - flutter * 0.25, tailX, centerY);
        ctx.quadraticCurveTo(controlX + direction * 0.9, poleTop + (hybrid ? 16.8 : 12.5 * TILT) + flutter * 0.18, poleTopX, poleTop + (hybrid ? 17.5 : 14 * TILT));
        ctx.closePath();
      };
      if (hybrid) {
        ctx.save();
        ctx.translate(1.7, 2.1);
        ctx.fillStyle = 'rgba(91,8,25,0.52)';
        drawCloth();
        ctx.fill();
        ctx.restore();
      }
      const cloth = ctx.createLinearGradient(poleTopX, poleTop, tailX, centerY);
      cloth.addColorStop(0, '#ff4055');
      cloth.addColorStop(0.5, '#e52642');
      cloth.addColorStop(1, '#a90d2c');
      ctx.fillStyle = hybrid ? cloth : '#e8283f';
      drawCloth();
      ctx.fill();
      if (hybrid) {
        ctx.strokeStyle = 'rgba(104,7,24,0.72)';
        ctx.lineWidth = 0.85;
        drawCloth();
        ctx.stroke();
        ctx.strokeStyle = 'rgba(255,125,131,0.34)';
        ctx.lineWidth = 0.7;
        ctx.beginPath();
        ctx.moveTo(poleTopX + direction * 2.5, poleTop + 6.1);
        ctx.quadraticCurveTo(controlX, centerY - flutter * 0.32, tailX - direction * 3.1, centerY + 0.5);
        ctx.stroke();
      }
      ctx.strokeStyle = 'rgba(255,244,208,0.44)';
      ctx.lineWidth = 0.9;
      ctx.beginPath();
      ctx.moveTo(poleTopX + direction * 1.6, poleTop + (hybrid ? 2.4 : 2 * TILT));
      ctx.quadraticCurveTo(controlX, poleTop + (hybrid ? 5.2 : 4.2 * TILT), tailX - direction * 2.4, centerY);
      ctx.stroke();
      ctx.restore();
    }
    ctx.restore();
  }

  /** Tensioned net mesh with a restrained breeze between fixed anchors. */
  private drawLiveGoalNets(
    ctx: CanvasRenderingContext2D,
    toSX: (wx: number) => number,
    toSY: (wy: number) => number,
    time: number,
  ): void {
    const topWorld = ARENA_H / 2 - 130;
    const heightWorld = 260;
    ctx.save();
    ctx.strokeStyle = 'rgba(232,238,235,0.42)';
    ctx.lineWidth = 1.25;
    for (const side of [0, 1]) {
      const frontWorldX = side === 0 ? 40 : ARENA_W - 40;
      const direction = side === 0 ? -1 : 1;
      const backWorldX = frontWorldX + direction * 52;
      const frontX = toSX(frontWorldX);
      const backX = toSX(backWorldX);
      const top = toSY(topWorld);
      const bottom = toSY(topWorld + heightWorld);
      const phase = time * 1.22 + side * 1.73;
      for (let row = 0; row <= 10; row++) {
        const rowT = row / 10;
        const anchorY = top + (bottom - top) * rowT;
        const anchorFade = Math.sin(rowT * Math.PI);
        const sway = Math.sin(phase + row * 0.47) * 1.55 * anchorFade;
        ctx.beginPath();
        ctx.moveTo(frontX, anchorY);
        ctx.quadraticCurveTo(
          frontX + (backX - frontX) * 0.56 + direction * sway * 0.3,
          anchorY + Math.sin(rowT * Math.PI) * 2.25 + sway,
          backX,
          anchorY,
        );
        ctx.stroke();
      }
      for (let column = 0; column <= 5; column++) {
        const columnT = column / 5;
        const x = frontX + (backX - frontX) * columnT;
        const anchorFade = Math.sin(columnT * Math.PI);
        const sway = Math.sin(phase + column * 0.63) * 1.35 * anchorFade;
        ctx.beginPath();
        ctx.moveTo(x, top);
        ctx.quadraticCurveTo(
          x + direction * Math.sin(columnT * Math.PI) * 2.2 + sway,
          (top + bottom) / 2,
          x,
          bottom,
        );
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  /** Narrow asymmetric contact shadows anchor the horizontal turf to the
   *  vertical stadium construction. Each side fades independently, avoiding
   *  a uniform vignette or gameplay-looking border around the pitch. */
  private drawPitchEdgeOcclusion(
    ctx: CanvasRenderingContext2D,
    toSX: (wx: number) => number,
    toSY: (wy: number) => number,
  ): void {
    const left = toSX(0);
    const right = toSX(ARENA_W);
    const top = toSY(0);
    const bottom = toSY(ARENA_H);
    const width = Math.max(1, right - left);
    const height = Math.max(1, bottom - top);
    ctx.save();
    const topShade = ctx.createLinearGradient(0, top, 0, top + 21);
    topShade.addColorStop(0, 'rgba(3,15,8,0.115)');
    topShade.addColorStop(0.34, 'rgba(3,15,8,0.045)');
    topShade.addColorStop(1, 'rgba(3,15,8,0)');
    ctx.fillStyle = topShade;
    ctx.fillRect(left, top, width, 22);

    const bottomShade = ctx.createLinearGradient(0, bottom, 0, bottom - 18);
    bottomShade.addColorStop(0, 'rgba(3,15,8,0.085)');
    bottomShade.addColorStop(0.42, 'rgba(3,15,8,0.035)');
    bottomShade.addColorStop(1, 'rgba(3,15,8,0)');
    ctx.fillStyle = bottomShade;
    ctx.fillRect(left, bottom - 19, width, 20);

    const leftShade = ctx.createLinearGradient(left, 0, left + 14, 0);
    leftShade.addColorStop(0, 'rgba(3,15,8,0.066)');
    leftShade.addColorStop(1, 'rgba(3,15,8,0)');
    ctx.fillStyle = leftShade;
    ctx.fillRect(left, top + 14, 15, Math.max(0, height - 28));

    const rightShade = ctx.createLinearGradient(right, 0, right - 11, 0);
    rightShade.addColorStop(0, 'rgba(3,15,8,0.052)');
    rightShade.addColorStop(1, 'rgba(3,15,8,0)');
    ctx.fillStyle = rightShade;
    ctx.fillRect(right - 12, top + 17, 13, Math.max(0, height - 34));
    ctx.restore();
  }

  /** Back half of the optional hybrid arena rim.
   *
   * The arena stays a lightweight Canvas 2D game, but the far touchline gains
   * a real raised profile: turf lip, dark vertical fascia, retaining rail and
   * inset fasteners. Drawing this before actors lets entities naturally pass
   * in front of the far construction without introducing a 3D engine. */
  private drawHybridPitchRimBack(
    ctx: CanvasRenderingContext2D,
    toSX: (wx: number) => number,
    toSY: (wy: number) => number,
  ): void {
    const left = toSX(0);
    const right = toSX(ARENA_W);
    const top = toSY(0);
    const depth = 11;
    ctx.save();
    const fascia = ctx.createLinearGradient(0, top, 0, top - depth);
    fascia.addColorStop(0, 'rgba(17,32,24,0.94)');
    fascia.addColorStop(0.52, 'rgba(9,19,17,0.96)');
    fascia.addColorStop(1, 'rgba(3,9,11,0.98)');
    ctx.fillStyle = fascia;
    ctx.beginPath();
    ctx.moveTo(left, top);
    ctx.lineTo(right, top);
    ctx.lineTo(right - 7, top - depth);
    ctx.lineTo(left + 7, top - depth);
    ctx.closePath();
    ctx.fill();
    // The far retaining wall receives the same material stack as the near
    // edge, compressed by perspective: dark fascia, cut soil, then the bright
    // rolled-turf lip. It stays behind actors and subtler than the near rim.
    const farSoil = ctx.createLinearGradient(0, top - 5, 0, top - 1);
    farSoil.addColorStop(0, 'rgba(25,34,22,0.72)');
    farSoil.addColorStop(0.55, 'rgba(59,56,28,0.56)');
    farSoil.addColorStop(1, 'rgba(99,91,43,0.40)');
    ctx.fillStyle = farSoil;
    ctx.fillRect(left + 2, top - 4.2, right - left - 4, 2.8);
    ctx.strokeStyle = 'rgba(188,202,132,0.24)';
    ctx.lineWidth = 1.05;
    ctx.beginPath();
    ctx.moveTo(left + 1, top - 1.2);
    ctx.lineTo(right - 1, top - 1.2);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(166,185,165,0.44)';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(left + 7, top - depth);
    ctx.lineTo(right - 7, top - depth);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(218,231,193,0.28)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(left + 1, top - 1.5);
    ctx.lineTo(right - 1, top - 1.5);
    ctx.stroke();
    for (let x = left + 18, index = 0; x < right - 14; x += 34, index++) {
      ctx.strokeStyle = index % 3 === 0 ? 'rgba(151,169,158,0.31)' : 'rgba(73,91,86,0.32)';
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.moveTo(x, top - 3);
      ctx.lineTo(x + 2.5, top - depth + 2);
      ctx.stroke();
      if (index % 4 === 1) {
        ctx.fillStyle = 'rgba(220,224,198,0.46)';
        ctx.beginPath();
        ctx.arc(x + 1.2, top - 6.7, 0.85, 0, TAU);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  /** Physical low-profile LED boards for the optional hybrid arena.
   *
   * The baked stadium already supplies colour and crowd density, but its
   * touchline ads share the same flat image plane as the turf. These live
   * boards add a dark cabinet, bevel, feet and restrained diode motion behind
   * every actor. Short side returns finish the construction without boxing in
   * the combat field or resembling a collision wall. */
  private drawHybridTouchlineBoards(
    ctx: CanvasRenderingContext2D,
    toSX: (wx: number) => number,
    toSY: (wy: number) => number,
    time: number,
  ): void {
    const left = toSX(0);
    const right = toSX(ARENA_W);
    const top = toSY(0);
    const boardTop = top - 31;
    const boardBottom = top - 12;
    const panelWidth = 108;
    const panelCount = Math.max(1, Math.ceil((right - left) / panelWidth));
    const palette = [
      [58, 137, 197],
      [220, 54, 73],
      [235, 183, 49],
      [221, 229, 225],
    ] as const;
    ctx.save();
    ctx.lineJoin = 'round';

    // Cast shadow, cabinet face and angled top cap establish measurable depth.
    ctx.fillStyle = 'rgba(2,10,9,0.25)';
    ctx.fillRect(left + 5, boardBottom + 5, right - left - 10, 6);
    const cabinet = ctx.createLinearGradient(0, boardTop, 0, boardBottom);
    cabinet.addColorStop(0, 'rgba(23,34,36,0.98)');
    cabinet.addColorStop(0.32, 'rgba(10,19,23,0.99)');
    cabinet.addColorStop(1, 'rgba(3,10,13,0.99)');
    ctx.fillStyle = cabinet;
    ctx.fillRect(left + 2, boardTop, right - left - 4, boardBottom - boardTop);
    const cap = ctx.createLinearGradient(0, boardTop - 4.5, 0, boardTop + 2);
    cap.addColorStop(0, 'rgba(178,191,185,0.48)');
    cap.addColorStop(0.44, 'rgba(72,91,91,0.58)');
    cap.addColorStop(1, 'rgba(9,20,23,0.82)');
    ctx.fillStyle = cap;
    ctx.beginPath();
    ctx.moveTo(left + 7, boardTop);
    ctx.lineTo(right - 7, boardTop);
    ctx.lineTo(right - 3, boardTop - 4.5);
    ctx.lineTo(left + 3, boardTop - 4.5);
    ctx.closePath();
    ctx.fill();

    for (let panel = 0; panel < panelCount; panel++) {
      const x0 = left + panel * panelWidth;
      const x1 = Math.min(right, x0 + panelWidth);
      if (x1 - x0 < 3) continue;
      const color = palette[panel % palette.length];
      const localPulse = 0.5 + 0.5 * Math.sin(time * (0.42 + (panel % 3) * 0.07) + panel * 1.31);
      const diodeAlpha = 0.22 + localPulse * 0.13;
      const face = ctx.createLinearGradient(x0, 0, x1, 0);
      face.addColorStop(0, `rgba(${color[0]},${color[1]},${color[2]},${diodeAlpha * 0.46})`);
      face.addColorStop(0.5, `rgba(${color[0]},${color[1]},${color[2]},${diodeAlpha})`);
      face.addColorStop(1, `rgba(${color[0]},${color[1]},${color[2]},${diodeAlpha * 0.42})`);
      ctx.fillStyle = face;
      ctx.fillRect(x0 + 5, boardTop + 4.5, Math.max(0, x1 - x0 - 10), 7.5);

      // Two dim diode rows and one slow, short scan reflection imply a real
      // display surface without text, logos or combat-coloured flashes.
      ctx.fillStyle = `rgba(${color[0]},${color[1]},${color[2]},${0.18 + localPulse * 0.08})`;
      for (let diode = x0 + 8; diode < x1 - 7; diode += 8) {
        ctx.fillRect(diode, boardTop + 5.8, 1.1, 1.1);
        ctx.fillRect(diode + 3.1, boardTop + 9.1, 0.9, 0.9);
      }
      const travel = ((time * 7.5 + panel * 19) % Math.max(12, x1 - x0 - 20));
      ctx.strokeStyle = 'rgba(239,247,242,0.11)';
      ctx.lineWidth = 1.25;
      ctx.beginPath();
      ctx.moveTo(x0 + 8 + travel, boardTop + 4.6);
      ctx.lineTo(Math.min(x1 - 7, x0 + 16 + travel), boardTop + 11.5);
      ctx.stroke();

      // Cabinet seams, hinge screws and dark ventilation slot.
      ctx.strokeStyle = 'rgba(157,174,170,0.32)';
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.moveTo(x0 + 1.5, boardTop + 1.5);
      ctx.lineTo(x0 + 1.5, boardBottom - 1.5);
      ctx.stroke();
      if (panel % 2 === 0) {
        ctx.fillStyle = 'rgba(207,216,207,0.46)';
        ctx.beginPath();
        ctx.arc(x0 + 5, boardBottom - 3.1, 0.75, 0, TAU);
        ctx.fill();
      }
      ctx.fillStyle = 'rgba(0,5,8,0.54)';
      ctx.fillRect(x0 + panelWidth * 0.35, boardBottom - 3.3, Math.min(27, panelWidth * 0.3), 1.25);
    }

    ctx.strokeStyle = 'rgba(223,230,224,0.34)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(left + 3, boardTop + 1);
    ctx.lineTo(right - 3, boardTop + 1);
    ctx.stroke();

    // Low steel feet are offset from the drainage seam, creating a thin air
    // gap under the cabinets. Their asymmetry avoids a decorative fence read.
    for (let foot = left + 44, index = 0; foot < right - 28; foot += 126, index++) {
      ctx.strokeStyle = 'rgba(148,163,158,0.60)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(foot, boardBottom);
      ctx.lineTo(foot + (index % 2 ? -1.5 : 1.5), top - 1.5);
      ctx.stroke();
      ctx.fillStyle = 'rgba(4,13,12,0.55)';
      ctx.beginPath();
      ctx.ellipse(foot + (index % 2 ? -1.5 : 1.5), top - 0.8, 3.6, 1.35, 0, 0, TAU);
      ctx.fill();
    }

    // Short side returns taper down the touchlines and terminate well before
    // either penalty area, so they add corner depth without enclosing play.
    const drawReturn = (x: number, outward: -1 | 1): void => {
      const length = Math.min(188, Math.max(118, (right - left) * 0.085));
      const outerX = x + outward * 18;
      const endY = top + length;
      const footX = x + outward * 13.5;
      const returnGradient = ctx.createLinearGradient(x, 0, outerX, 0);
      returnGradient.addColorStop(0, 'rgba(18,29,31,0.97)');
      returnGradient.addColorStop(1, 'rgba(4,11,14,0.99)');
      ctx.fillStyle = returnGradient;
      ctx.beginPath();
      ctx.moveTo(x, top - 8);
      ctx.lineTo(outerX, top - 12);
      ctx.lineTo(outerX, endY - 10);
      ctx.lineTo(x, endY);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = 'rgba(171,187,181,0.38)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(outerX - outward, top - 9);
      ctx.lineTo(outerX - outward, endY - 12);
      ctx.stroke();
      // The return cabinet needs the same raised-underlay cues as the long
      // board: paired steel feet, a narrow cast shadow and a drainage grate.
      // These details are small but break the vertical black-stripe read at
      // the corner and explain how the cabinet meets the pitch apron.
      const returnShadow = ctx.createLinearGradient(x, 0, outerX, 0);
      returnShadow.addColorStop(0, 'rgba(2,10,9,0.14)');
      returnShadow.addColorStop(1, 'rgba(2,8,9,0.31)');
      ctx.fillStyle = returnShadow;
      ctx.beginPath();
      ctx.moveTo(x + outward * 3, top + 31);
      ctx.lineTo(outerX - outward * 2, top + 27);
      ctx.lineTo(outerX - outward * 2, endY - 5);
      ctx.lineTo(x + outward * 3, endY + 2);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = 'rgba(137,154,150,0.58)';
      ctx.lineWidth = 1.7;
      for (const footT of [0.27, 0.73]) {
        const footY = top + length * footT;
        ctx.beginPath();
        ctx.moveTo(footX, footY - 2.5);
        ctx.lineTo(x + outward * 3.5, footY + 0.5);
        ctx.stroke();
        ctx.fillStyle = 'rgba(3,11,11,0.62)';
        ctx.beginPath();
        ctx.ellipse(x + outward * 3.2, footY + 1.3, 3.2, 1.15, outward * -0.08, 0, TAU);
        ctx.fill();
      }
      ctx.strokeStyle = 'rgba(112,129,125,0.36)';
      ctx.lineWidth = 0.8;
      for (let slot = 0; slot < 5; slot++) {
        const slotY = top + 43 + slot * Math.max(12, (length - 73) / 4);
        ctx.beginPath();
        ctx.moveTo(x + outward * 2, slotY);
        ctx.lineTo(x + outward * 7.5, slotY - 1.1);
        ctx.stroke();
      }
      for (let segment = 0; segment < 4; segment++) {
        const y = top + 14 + segment * (length - 30) / 4;
        const color = palette[(segment + (outward > 0 ? 1 : 3)) % palette.length];
        const alpha = 0.12 + (0.5 + 0.5 * Math.sin(time * 0.48 + segment * 1.9)) * 0.08;
        ctx.strokeStyle = `rgba(${color[0]},${color[1]},${color[2]},${alpha})`;
        ctx.lineWidth = 3.2;
        ctx.beginPath();
        ctx.moveTo(x + outward * 4, y);
        ctx.lineTo(outerX - outward * 4, y - 2.2);
        ctx.stroke();
      }

      // Chamfered corner service module bridges the horizontal cabinet and
      // the side return. It hides the impossible razor-sharp 90-degree seam
      // and gives the live construction a believable removable corner cover.
      const innerX = x + outward * 1.5;
      const outerCornerX = x + outward * 19.5;
      ctx.fillStyle = 'rgba(5,13,16,0.98)';
      ctx.beginPath();
      ctx.moveTo(innerX, boardTop - 3.5);
      ctx.lineTo(outerCornerX, top - 11.5);
      ctx.lineTo(outerCornerX, top + 26);
      ctx.lineTo(innerX, top + 31);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = 'rgba(184,198,191,0.46)';
      ctx.lineWidth = 1.15;
      ctx.beginPath();
      ctx.moveTo(innerX, boardTop - 3.5);
      ctx.lineTo(outerCornerX, top - 11.5);
      ctx.lineTo(outerCornerX, top + 26);
      ctx.stroke();
      // Recessed cable hatch and two captive bolts communicate maintenance
      // scale without any lettering or bright iconography.
      ctx.fillStyle = 'rgba(0,6,9,0.72)';
      ctx.fillRect(
        outward < 0 ? outerCornerX + 4.2 : innerX + 4.2,
        top + 2.5,
        10.8,
        13.5,
      );
      ctx.strokeStyle = 'rgba(117,137,132,0.34)';
      ctx.lineWidth = 0.75;
      ctx.strokeRect(
        outward < 0 ? outerCornerX + 4.2 : innerX + 4.2,
        top + 2.5,
        10.8,
        13.5,
      );
      ctx.fillStyle = 'rgba(212,219,209,0.44)';
      for (const boltY of [top + 5.3, top + 13.7]) {
        ctx.beginPath();
        ctx.arc(outward < 0 ? outerCornerX + 6.3 : innerX + 13.1, boltY, 0.66, 0, TAU);
        ctx.fill();
      }
      ctx.fillStyle = 'rgba(2,9,10,0.68)';
      ctx.beginPath();
      ctx.ellipse(footX, top + 29.5, 5.4, 1.75, outward * 0.06, 0, TAU);
      ctx.fill();

      // A mitred cap links the far turf lip to the return cabinet. It removes
      // the last right-angle gap without introducing a bright gameplay mark.
      const turfJoint = ctx.createLinearGradient(x, top - 7, outerCornerX, top - 13);
      turfJoint.addColorStop(0, 'rgba(142,162,102,0.30)');
      turfJoint.addColorStop(0.5, 'rgba(72,99,62,0.34)');
      turfJoint.addColorStop(1, 'rgba(14,30,25,0.72)');
      ctx.fillStyle = turfJoint;
      ctx.beginPath();
      ctx.moveTo(x + outward * 0.5, top - 7.2);
      ctx.lineTo(outerCornerX - outward * 0.7, top - 12.3);
      ctx.lineTo(outerCornerX - outward * 0.7, top - 8.7);
      ctx.lineTo(x + outward * 1.5, top - 3.6);
      ctx.closePath();
      ctx.fill();
    };
    drawReturn(left, -1);
    drawReturn(right, 1);
    ctx.restore();
  }

  /** Two live dugouts and a broadcast camera behind the far LED cabinets.
   *
   * The structures occupy only the stadium apron and are rendered before the
   * boards and every actor. Transparent acrylic, individual seats, tubular
   * braces and tripod feet add real-world scale without introducing gameplay
   * collision, text, logos or image assets. */
  private drawHybridTechnicalZone(
    ctx: CanvasRenderingContext2D,
    toSX: (wx: number) => number,
    toSY: (wy: number) => number,
    time: number,
  ): void {
    const left = toSX(0);
    const right = toSX(ARENA_W);
    const top = toSY(0);
    const width = right - left;
    ctx.save();
    const drawDugout = (centerX: number, accent: readonly [number, number, number], mirror: -1 | 1): void => {
      const dugoutWidth = Math.min(390, width * 0.25);
      const x0 = centerX - dugoutWidth / 2;
      const x1 = centerX + dugoutWidth / 2;
      const roofY = top - 72;
      const shoulderY = top - 63;
      const baseY = top - 34;
      const depthLean = mirror * 7;

      // Platform contact and recessed rubber plinth sit behind the LED board.
      const platformShadow = ctx.createLinearGradient(0, baseY - 2, 0, top - 19);
      platformShadow.addColorStop(0, 'rgba(1,8,8,0.34)');
      platformShadow.addColorStop(1, 'rgba(1,8,8,0)');
      ctx.fillStyle = platformShadow;
      ctx.fillRect(x0 - 7, baseY - 2, dugoutWidth + 14, 18);
      ctx.fillStyle = 'rgba(5,13,15,0.92)';
      ctx.beginPath();
      ctx.moveTo(x0 - 2, baseY - 4);
      ctx.lineTo(x1 + 2, baseY - 4);
      ctx.lineTo(x1 + 8, baseY + 2);
      ctx.lineTo(x0 - 8, baseY + 2);
      ctx.closePath();
      ctx.fill();

      // Smoke-tinted acrylic back wall. The centre is more transparent than
      // its graphite frame so the baked crowd still contributes natural depth.
      const glass = ctx.createLinearGradient(x0, 0, x1, 0);
      glass.addColorStop(0, 'rgba(118,151,154,0.15)');
      glass.addColorStop(0.48, 'rgba(195,220,216,0.095)');
      glass.addColorStop(1, 'rgba(89,121,127,0.18)');
      ctx.fillStyle = glass;
      ctx.beginPath();
      ctx.moveTo(x0 + depthLean, shoulderY);
      ctx.quadraticCurveTo(x0 + 22 + depthLean, roofY, x0 + 42 + depthLean, roofY);
      ctx.lineTo(x1 - 38 + depthLean, roofY);
      ctx.quadraticCurveTo(x1 - 16 + depthLean, roofY + 1, x1 + depthLean, shoulderY);
      ctx.lineTo(x1, baseY);
      ctx.lineTo(x0, baseY);
      ctx.closePath();
      ctx.fill();

      // A separate roof slab and rear lower panel make the canopy volumetric.
      const roof = ctx.createLinearGradient(0, roofY - 5, 0, roofY + 5);
      roof.addColorStop(0, 'rgba(218,231,227,0.52)');
      roof.addColorStop(0.38, 'rgba(92,118,120,0.48)');
      roof.addColorStop(1, 'rgba(10,23,28,0.78)');
      ctx.fillStyle = roof;
      ctx.beginPath();
      ctx.moveTo(x0 + 35 + depthLean, roofY - 4.5);
      ctx.lineTo(x1 - 32 + depthLean, roofY - 4.5);
      ctx.lineTo(x1 - 37 + depthLean, roofY + 2.2);
      ctx.lineTo(x0 + 40 + depthLean, roofY + 2.2);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = 'rgba(232,241,237,0.25)';
      ctx.lineWidth = 0.85;
      ctx.beginPath();
      ctx.moveTo(x0 + 36 + depthLean, roofY - 3.5);
      ctx.lineTo(x1 - 33 + depthLean, roofY - 3.5);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(2,10,13,0.48)';
      ctx.lineWidth = 2.1;
      ctx.beginPath();
      ctx.moveTo(x0 + 41 + depthLean, roofY + 2.5);
      ctx.lineTo(x1 - 38 + depthLean, roofY + 2.5);
      ctx.stroke();
      ctx.fillStyle = 'rgba(4,13,17,0.73)';
      ctx.fillRect(x0 + 5, baseY - 10, dugoutWidth - 10, 8);

      // Tubular outer frame, vertical ribs and diagonal end braces.
      const drawFrame = (): void => {
        ctx.beginPath();
        ctx.moveTo(x0, baseY);
        ctx.lineTo(x0 + depthLean, shoulderY);
        ctx.quadraticCurveTo(x0 + 22 + depthLean, roofY, x0 + 42 + depthLean, roofY);
        ctx.lineTo(x1 - 38 + depthLean, roofY);
        ctx.quadraticCurveTo(x1 - 16 + depthLean, roofY + 1, x1 + depthLean, shoulderY);
        ctx.lineTo(x1, baseY);
      };
      ctx.save();
      ctx.translate(1.7, 2.1);
      ctx.strokeStyle = 'rgba(2,9,10,0.62)';
      ctx.lineWidth = 4.8;
      drawFrame();
      ctx.stroke();
      ctx.restore();
      ctx.strokeStyle = 'rgba(178,194,190,0.78)';
      ctx.lineWidth = 2.55;
      drawFrame();
      ctx.stroke();
      ctx.strokeStyle = 'rgba(244,248,244,0.38)';
      ctx.lineWidth = 0.72;
      ctx.save();
      ctx.translate(-mirror * 0.55, -0.55);
      drawFrame();
      ctx.stroke();
      ctx.restore();

      const ribCount = 6;
      for (let rib = 1; rib < ribCount; rib++) {
        const t = rib / ribCount;
        const ribX = x0 + dugoutWidth * t + depthLean * (1 - Math.abs(t - 0.5) * 1.2);
        ctx.strokeStyle = 'rgba(151,172,170,0.39)';
        ctx.lineWidth = 1.15;
        ctx.beginPath();
        ctx.moveTo(ribX, roofY + 1.5);
        ctx.lineTo(ribX - depthLean * 0.16, baseY - 1.5);
        ctx.stroke();
      }
      ctx.strokeStyle = 'rgba(173,190,186,0.34)';
      ctx.lineWidth = 1.15;
      for (const endX of [x0 + 4, x1 - 4]) {
        ctx.beginPath();
        ctx.moveTo(endX, baseY - 2);
        ctx.lineTo(endX + mirror * 9, shoulderY + 5);
        ctx.stroke();
      }

      // Seven individual moulded seats: back shell, cushion, metal pedestal
      // and small footplate. Alternating highlights prevent a flat colour bar.
      const seats = 7;
      for (let seat = 0; seat < seats; seat++) {
        const seatX = x0 + 29 + seat * (dugoutWidth - 58) / (seats - 1);
        const seatY = baseY - 11;
        const [r, g, b] = accent;
        const shell = ctx.createLinearGradient(seatX - 8, 0, seatX + 8, 0);
        shell.addColorStop(0, `rgba(${Math.max(0, r - 35)},${Math.max(0, g - 35)},${Math.max(0, b - 35)},0.96)`);
        shell.addColorStop(0.45, `rgba(${r},${g},${b},0.94)`);
        shell.addColorStop(1, `rgba(${Math.max(0, r - 48)},${Math.max(0, g - 48)},${Math.max(0, b - 48)},0.98)`);
        ctx.fillStyle = shell;
        ctx.beginPath();
        ctx.roundRect(seatX - 8.2, seatY - 14.5, 16.4, 13.5, 3.2);
        ctx.fill();
        ctx.fillStyle = `rgba(${Math.min(255, r + 28)},${Math.min(255, g + 28)},${Math.min(255, b + 28)},0.74)`;
        ctx.beginPath();
        ctx.roundRect(seatX - 8.6, seatY - 2.5, 17.2, 5.6, 2.3);
        ctx.fill();
        ctx.strokeStyle = 'rgba(169,184,179,0.58)';
        ctx.lineWidth = 1.15;
        ctx.beginPath();
        ctx.moveTo(seatX, seatY + 2.5);
        ctx.lineTo(seatX, baseY - 2);
        ctx.stroke();
        ctx.fillStyle = 'rgba(2,9,10,0.68)';
        ctx.fillRect(seatX - 4.4, baseY - 2.5, 8.8, 1.7);
      }

      // Fixed glass reflections stay subdued; one slow moving highlight sells
      // acrylic rather than a glowing screen or animated gameplay element.
      ctx.strokeStyle = 'rgba(229,244,242,0.13)';
      ctx.lineWidth = 1.1;
      for (let pane = 0; pane < 3; pane++) {
        const reflectionX = x0 + 55 + pane * (dugoutWidth - 110) / 2;
        ctx.beginPath();
        ctx.moveTo(reflectionX - 10, roofY + 8);
        ctx.lineTo(reflectionX + 4, baseY - 14);
        ctx.stroke();
      }
      const glint = ((time * 9 + (mirror > 0 ? 23 : 0)) % Math.max(1, dugoutWidth - 110));
      ctx.strokeStyle = 'rgba(241,250,247,0.10)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x0 + 50 + glint, roofY + 7);
      ctx.lineTo(x0 + 62 + glint, baseY - 10);
      ctx.stroke();
    };

    drawDugout(left + width * 0.31, [36, 107, 165], -1);
    drawDugout(left + width * 0.69, [193, 43, 61], 1);

    // Central broadcast camera: low tripod, pan head, lens hood, tally lamp
    // and two coiled cables. It remains behind the board and cannot obscure
    // the centre line or player silhouette.
    const cameraX = left + width * 0.5 + Math.min(86, width * 0.06);
    const cameraY = top - 47;
    ctx.strokeStyle = 'rgba(142,156,153,0.64)';
    ctx.lineWidth = 2.1;
    for (const footX of [cameraX - 18, cameraX, cameraX + 18]) {
      ctx.beginPath();
      ctx.moveTo(cameraX, cameraY + 6);
      ctx.lineTo(footX, top - 27);
      ctx.stroke();
      ctx.fillStyle = 'rgba(2,8,10,0.72)';
      ctx.beginPath();
      ctx.ellipse(footX, top - 26, 4.2, 1.5, 0, 0, TAU);
      ctx.fill();
    }
    const cameraBody = ctx.createLinearGradient(cameraX - 20, 0, cameraX + 16, 0);
    cameraBody.addColorStop(0, 'rgba(20,31,35,0.99)');
    cameraBody.addColorStop(0.42, 'rgba(66,79,81,0.98)');
    cameraBody.addColorStop(0.68, 'rgba(15,25,30,0.99)');
    cameraBody.addColorStop(1, 'rgba(2,9,13,1)');
    ctx.fillStyle = cameraBody;
    ctx.beginPath();
    ctx.roundRect(cameraX - 20, cameraY - 11, 36, 19, 3.5);
    ctx.fill();
    ctx.strokeStyle = 'rgba(194,207,202,0.68)';
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    ctx.roundRect(cameraX - 20, cameraY - 11, 36, 19, 3.5);
    ctx.stroke();
    ctx.fillStyle = 'rgba(209,219,214,0.58)';
    ctx.fillRect(cameraX - 15, cameraY - 9, 18, 1.35);
    ctx.fillStyle = 'rgba(1,7,10,0.78)';
    ctx.fillRect(cameraX - 15.5, cameraY - 5.5, 15, 9.5);
    // Articulated operator monitor: dark bezel, blue-black glass and hinge.
    ctx.strokeStyle = 'rgba(157,173,169,0.66)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(cameraX - 17, cameraY - 2);
    ctx.lineTo(cameraX - 26, cameraY - 3.5);
    ctx.stroke();
    ctx.fillStyle = 'rgba(7,15,20,0.98)';
    ctx.beginPath();
    ctx.roundRect(cameraX - 35, cameraY - 10, 12.5, 14, 1.8);
    ctx.fill();
    const monitorGlass = ctx.createLinearGradient(cameraX - 34, cameraY - 9, cameraX - 24, cameraY + 2);
    monitorGlass.addColorStop(0, 'rgba(45,92,112,0.48)');
    monitorGlass.addColorStop(0.45, 'rgba(13,39,51,0.68)');
    monitorGlass.addColorStop(1, 'rgba(1,11,17,0.92)');
    ctx.fillStyle = monitorGlass;
    ctx.fillRect(cameraX - 33, cameraY - 8, 8.7, 10);
    ctx.strokeStyle = 'rgba(207,220,215,0.36)';
    ctx.lineWidth = 0.7;
    ctx.strokeRect(cameraX - 33, cameraY - 8, 8.7, 10);
    const lens = ctx.createLinearGradient(cameraX + 10, 0, cameraX + 31, 0);
    lens.addColorStop(0, 'rgba(37,51,55,0.98)');
    lens.addColorStop(0.58, 'rgba(8,17,22,0.99)');
    lens.addColorStop(1, 'rgba(1,7,10,1)');
    ctx.fillStyle = lens;
    ctx.beginPath();
    ctx.moveTo(cameraX + 10, cameraY - 6);
    ctx.lineTo(cameraX + 32, cameraY - 4.5);
    ctx.lineTo(cameraX + 32, cameraY + 4.5);
    ctx.lineTo(cameraX + 10, cameraY + 6);
    ctx.closePath();
    ctx.fill();
    // Cool glass objective nested inside the matte hood makes the camera read
    // at gameplay scale without a glowing light source.
    const objective = ctx.createRadialGradient(cameraX + 31, cameraY, 0.5, cameraX + 31, cameraY, 4.2);
    objective.addColorStop(0, 'rgba(142,215,225,0.64)');
    objective.addColorStop(0.34, 'rgba(35,111,137,0.62)');
    objective.addColorStop(0.72, 'rgba(5,32,46,0.86)');
    objective.addColorStop(1, 'rgba(0,5,8,0.96)');
    ctx.fillStyle = objective;
    ctx.beginPath();
    ctx.ellipse(cameraX + 31, cameraY, 3.4, 4.15, 0, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = 'rgba(184,204,200,0.42)';
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.ellipse(cameraX + 31, cameraY, 3.6, 4.35, 0, 0, TAU);
    ctx.stroke();
    ctx.fillStyle = 'rgba(219,38,52,0.48)';
    ctx.beginPath();
    ctx.arc(cameraX - 13, cameraY - 7, 1.35, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = 'rgba(4,10,13,0.52)';
    ctx.lineWidth = 1.3;
    for (const offset of [-8, 8]) {
      ctx.beginPath();
      ctx.arc(cameraX + offset, top - 26, 6, 0.2, Math.PI * 1.65);
      ctx.stroke();
    }
    ctx.restore();
  }

  /** Near half of the optional hybrid rim.
   *
   * It is intentionally drawn after actors and the goal foreground so the
   * near lip can occlude feet by a few pixels. That small, consistent overlap
   * is the depth cue a flat arena lacks; side returns connect it to the far rim
   * while remaining outside the combat field. */
  private drawHybridPitchRimFront(
    ctx: CanvasRenderingContext2D,
    toSX: (wx: number) => number,
    toSY: (wy: number) => number,
  ): void {
    const left = toSX(0);
    const right = toSX(ARENA_W);
    const top = toSY(0);
    const bottom = toSY(ARENA_H);
    const depth = 18;
    ctx.save();

    const sideReturn = (x: number, direction: -1 | 1): void => {
      const lip = 8;
      const gradient = ctx.createLinearGradient(x, 0, x + direction * lip, 0);
      gradient.addColorStop(0, 'rgba(18,35,25,0.93)');
      gradient.addColorStop(1, 'rgba(4,12,13,0.97)');
      const goalGapTop = toSY(ARENA_H / 2 - 130) - HYBRID_GOAL_RIM_GAP_PAD;
      const goalGapBottom = toSY(ARENA_H / 2 + 130) + HYBRID_GOAL_RIM_GAP_PAD;
      const drawSegment = (y0: number, y1: number): void => {
        if (y1 <= y0) return;
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.moveTo(x, y0);
        ctx.lineTo(x, y1);
        ctx.lineTo(x + direction * lip, y1 + 5);
        ctx.lineTo(x + direction * lip, y0 - 5);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = 'rgba(181,199,175,0.28)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, y0 + 2);
        ctx.lineTo(x, y1 - 2);
        ctx.stroke();
      };
      // Leave a real opening through the raised side fascia for each goal.
      // Previously the wall continued behind the mesh and made the cage look
      // pasted onto a black stripe. Two capped segments let the base rails
      // pass naturally beyond the goal line while retaining the raised rim.
      drawSegment(top, goalGapTop);
      drawSegment(goalGapBottom, bottom);
      for (const [capY, capDirection] of [[goalGapTop, 1], [goalGapBottom, -1]] as const) {
        ctx.fillStyle = 'rgba(8,19,17,0.98)';
        ctx.beginPath();
        ctx.moveTo(x, capY);
        ctx.lineTo(x + direction * lip, capY + capDirection * 5);
        ctx.lineTo(x + direction * (lip + 3.5), capY + capDirection * 1.5);
        ctx.lineTo(x + direction * 2, capY - capDirection * 2);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = 'rgba(202,214,196,0.38)';
        ctx.lineWidth = 0.9;
        ctx.beginPath();
        ctx.moveTo(x + direction, capY);
        ctx.lineTo(x + direction * lip, capY + capDirection * 4.2);
        ctx.stroke();
      }
    };
    sideReturn(left, -1);
    sideReturn(right, 1);

    const fascia = ctx.createLinearGradient(0, bottom, 0, bottom + depth);
    fascia.addColorStop(0, 'rgba(38,61,38,0.95)');
    fascia.addColorStop(0.24, 'rgba(22,41,29,0.97)');
    fascia.addColorStop(0.62, 'rgba(12,26,22,0.98)');
    fascia.addColorStop(1, 'rgba(3,11,13,0.99)');
    ctx.fillStyle = fascia;
    ctx.beginPath();
    ctx.moveTo(left, bottom);
    ctx.lineTo(right, bottom);
    ctx.lineTo(right + 8, bottom + depth);
    ctx.lineTo(left - 8, bottom + depth);
    ctx.closePath();
    ctx.fill();
    // A shallow apron compression shadow remains on the turf, not under it.
    // This grounds objects before the sod lip occludes their bottom pixels.
    const apronShadow = ctx.createLinearGradient(0, bottom - 24, 0, bottom + 1);
    apronShadow.addColorStop(0, 'rgba(4,17,10,0)');
    apronShadow.addColorStop(0.62, 'rgba(4,17,10,0.055)');
    apronShadow.addColorStop(1, 'rgba(2,10,8,0.16)');
    ctx.fillStyle = apronShadow;
    ctx.fillRect(left, bottom - 24, right - left, 25);

    // Rolled turf edge catches light above the fascia and makes the grass read
    // as a physical sod layer instead of a texture ending at a black bar.
    const turfBevel = ctx.createLinearGradient(0, bottom - 3, 0, bottom + 4);
    turfBevel.addColorStop(0, 'rgba(157,177,83,0.22)');
    turfBevel.addColorStop(0.45, 'rgba(84,116,44,0.46)');
    turfBevel.addColorStop(1, 'rgba(22,51,25,0.66)');
    ctx.fillStyle = turfBevel;
    ctx.beginPath();
    ctx.moveTo(left, bottom - 2.6);
    ctx.lineTo(right, bottom - 2.6);
    ctx.lineTo(right + 2.2, bottom + 4.2);
    ctx.lineTo(left - 2.2, bottom + 4.2);
    ctx.closePath();
    ctx.fill();
    // Irregular individual blade tips break the unnaturally perfect horizontal
    // edge. The deterministic spacing prevents sparkle and is cheap enough for
    // mobile while retaining the authored close-up grass texture.
    ctx.lineCap = 'round';
    for (let tuftX = left + 4, tuft = 0; tuftX < right - 3; tuftX += 8.5, tuft++) {
      const bend = ((tuft * 17) % 7 - 3) * 0.32;
      const height = 1.2 + (tuft % 4) * 0.48;
      ctx.strokeStyle = tuft % 5 === 0 ? 'rgba(200,210,128,0.34)' : 'rgba(104,137,65,0.38)';
      ctx.lineWidth = tuft % 3 === 0 ? 0.75 : 0.55;
      ctx.beginPath();
      ctx.moveTo(tuftX, bottom - 0.3);
      ctx.quadraticCurveTo(tuftX + bend * 0.4, bottom - height * 0.62, tuftX + bend, bottom - height);
      ctx.stroke();
    }
    // Expose a thin cut-soil seam under the sod. This materially separates
    // the physical pitch slab from the dark retaining modules below; without
    // it the whole front edge reads like a flat black letterbox bar.
    const soilSeam = ctx.createLinearGradient(0, bottom + 2.6, 0, bottom + 7.2);
    soilSeam.addColorStop(0, 'rgba(82,72,34,0.64)');
    soilSeam.addColorStop(0.46, 'rgba(47,45,24,0.72)');
    soilSeam.addColorStop(1, 'rgba(18,27,18,0.74)');
    ctx.fillStyle = soilSeam;
    ctx.fillRect(left - 1, bottom + 3.4, right - left + 2, 3.4);
    ctx.strokeStyle = 'rgba(203,192,115,0.17)';
    ctx.lineWidth = 0.65;
    for (let clump = left + 8, index = 0; clump < right - 4; clump += 19, index++) {
      const length = 2.1 + (index % 3) * 0.7;
      ctx.beginPath();
      ctx.moveTo(clump, bottom + 3.8);
      ctx.lineTo(clump + (index % 2 ? 1.2 : -0.8), bottom + 3.8 + length);
      ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(228,235,203,0.34)';
    ctx.lineWidth = 1.35;
    ctx.beginPath();
    ctx.moveTo(left + 1, bottom + 1.4);
    ctx.lineTo(right - 1, bottom + 1.4);
    ctx.stroke();

    // Recessed linear drain separates wet sod from the structural modules.
    // Slotted steel and a narrow cavity create measurable depth without a
    // bright border that could be mistaken for an arena hazard.
    const drainY = bottom + 7.4;
    const drain = ctx.createLinearGradient(0, drainY, 0, drainY + 4.8);
    drain.addColorStop(0, 'rgba(2,8,10,0.96)');
    drain.addColorStop(0.52, 'rgba(17,29,29,0.98)');
    drain.addColorStop(1, 'rgba(5,14,15,0.98)');
    ctx.fillStyle = drain;
    ctx.fillRect(left - 2, drainY, right - left + 4, 4.8);
    ctx.strokeStyle = 'rgba(151,167,159,0.33)';
    ctx.lineWidth = 0.65;
    for (let slotX = left + 8, slot = 0; slotX < right - 5; slotX += 14, slot++) {
      const lean = slot % 2 === 0 ? 1.3 : -1.3;
      ctx.beginPath();
      ctx.moveTo(slotX - lean, drainY + 1.15);
      ctx.lineTo(slotX + lean, drainY + 3.65);
      ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(215,222,208,0.22)';
    ctx.lineWidth = 0.75;
    ctx.beginPath();
    ctx.moveTo(left, drainY + 0.55);
    ctx.lineTo(right, drainY + 0.55);
    ctx.stroke();
    // Alternating inset panels give the retaining face a believable modular
    // scale. They remain dark and textless so they cannot resemble pickups.
    const panelWidth = 92;
    for (let panelX = left - 3, panel = 0; panelX < right; panelX += panelWidth, panel++) {
      const width = Math.min(panelWidth - 3, right - panelX + 5);
      ctx.fillStyle = panel % 2 === 0 ? 'rgba(74,91,73,0.26)' : 'rgba(9,21,18,0.23)';
      ctx.fillRect(panelX + 2, drainY + 4.8, width, Math.max(1, bottom + depth - drainY - 4.8));
      ctx.strokeStyle = panel % 2 === 0 ? 'rgba(151,169,158,0.32)' : 'rgba(95,116,108,0.25)';
      ctx.lineWidth = 0.9;
      ctx.beginPath();
      ctx.moveTo(panelX + 2, drainY + 5.2);
      ctx.lineTo(panelX + 4, bottom + depth - 1.4);
      ctx.stroke();
      if (panel % 2 === 0) {
        ctx.fillStyle = 'rgba(216,224,207,0.46)';
        ctx.beginPath();
        ctx.arc(panelX + 12, drainY + 7.1, 1.15, 0, TAU);
        ctx.arc(panelX + panelWidth - 13, drainY + 7.1, 1.15, 0, TAU);
        ctx.fill();
      }
      if (panel % 3 === 1) {
        ctx.fillStyle = 'rgba(2,8,10,0.58)';
        ctx.fillRect(panelX + panelWidth * 0.34, bottom + depth - 4.2, panelWidth * 0.32, 1.6);
      }
    }
    ctx.restore();
  }

  /** Rear goal cage for the hybrid route, drawn before all entities.
   *
   * Separating this from drawGoalForeground is essential: players may cross
   * in front of the rear stanchion and net roof, while only the real front post
   * is allowed to occlude them later. The result is genuine painter-sorted
   * 2.5D rather than one bright outline pasted over every actor. */
  private strokeHybridGoalTube(
    ctx: CanvasRenderingContext2D,
    drawPath: () => void,
    width: number,
    highlightOffset: { x: number; y: number },
    alpha = 1,
  ): void {
    ctx.save();
    ctx.translate(2.5, 2.8);
    ctx.strokeStyle = `rgba(4,14,11,${0.54 * alpha})`;
    ctx.lineWidth = width + 3.2;
    drawPath();
    ctx.stroke();
    ctx.restore();

    ctx.strokeStyle = `rgba(178,188,184,${0.94 * alpha})`;
    ctx.lineWidth = width + 0.8;
    drawPath();
    ctx.stroke();
    ctx.strokeStyle = `rgba(247,249,249,${0.98 * alpha})`;
    ctx.lineWidth = width;
    drawPath();
    ctx.stroke();

    ctx.save();
    ctx.translate(highlightOffset.x, highlightOffset.y);
    ctx.strokeStyle = `rgba(255,255,255,${0.72 * alpha})`;
    ctx.lineWidth = Math.max(0.72, width * 0.19);
    drawPath();
    ctx.stroke();
    ctx.restore();
  }

  private drawHybridGoalDepth(
    ctx: CanvasRenderingContext2D,
    toSX: (wx: number) => number,
    toSY: (wy: number) => number,
    time: number,
  ): void {
    interface NetPoint { x: number; y: number }
    type NetSurface = (u: number, v: number) => NetPoint;
    const drawDiamondNet = (
      surface: NetSurface,
      columns: number,
      rows: number,
      sagX: number,
      alpha: number,
    ): void => {
      const drawCord = (u0: number, v0: number, u1: number, v1: number, phase: number): void => {
        const samples = 9;
        ctx.beginPath();
        for (let sample = 0; sample <= samples; sample++) {
          const t = sample / samples;
          const u = u0 + (u1 - u0) * t;
          const v = v0 + (v1 - v0) * t;
          const point = surface(u, v);
          const relaxed = Math.sin(t * Math.PI);
          const fibreWave = Math.sin((t * 2 + phase) * Math.PI) * 0.24;
          const x = point.x + sagX * relaxed;
          const y = point.y + fibreWave * relaxed;
          if (sample === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      };

      ctx.save();
      ctx.lineCap = 'round';
      ctx.strokeStyle = `rgba(235,241,237,${alpha})`;
      ctx.lineWidth = 0.72;
      // Work in integer mesh coordinates before projecting onto the surface.
      // V-U and V+U families tessellate into diamonds even on perspective
      // quads, unlike the previous rigid row/column transparency grid.
      for (let diagonal = -columns; diagonal <= rows; diagonal++) {
        const startU = Math.max(0, -diagonal);
        const endU = Math.min(columns, rows - diagonal);
        if (endU <= startU) continue;
        drawCord(
          startU / columns,
          (startU + diagonal) / rows,
          endU / columns,
          (endU + diagonal) / rows,
          diagonal * 0.17,
        );
      }
      for (let diagonal = 0; diagonal <= columns + rows; diagonal++) {
        const startU = Math.max(0, diagonal - rows);
        const endU = Math.min(columns, diagonal);
        if (endU <= startU) continue;
        drawCord(
          startU / columns,
          (diagonal - startU) / rows,
          endU / columns,
          (diagonal - endU) / rows,
          diagonal * 0.13 + 0.5,
        );
      }
      ctx.restore();
    };

    const top = toSY(ARENA_H / 2 - 130);
    const bottom = toSY(ARENA_H / 2 + 130);
    ctx.save();
    ctx.lineCap = 'round';
    for (const gx of [40, ARENA_W - 40]) {
      const x = toSX(gx);
      const direction = gx < ARENA_W / 2 ? -1 : 1;
      const backX = x + direction * HYBRID_GOAL_DEPTH;
      const lift = HYBRID_GOAL_LIFT;
      const postHeight = HYBRID_GOAL_POST_HEIGHT;
      const frontRaisedX = x - HYBRID_GOAL_HEIGHT_SHEAR_X;
      const rearRaisedX = backX - HYBRID_GOAL_HEIGHT_SHEAR_X;
      const frontTop = top - postHeight;
      const frontBottom = bottom - postHeight;
      const rearTop = top - postHeight - lift;
      const rearBottom = bottom - postHeight - lift;

      // The elevated cage casts a restrained stadium-light shadow onto the
      // grass. A two-pass offset avoids the crisp duplicate-frame look that a
      // single black stroke would create, while remaining far below gameplay
      // telegraph contrast and entirely behind actors.
      const drawRaisedCageShadow = (): void => {
        ctx.beginPath();
        ctx.moveTo(frontRaisedX, frontTop);
        ctx.lineTo(rearRaisedX, rearTop);
        ctx.lineTo(rearRaisedX, rearBottom);
        ctx.lineTo(frontRaisedX, frontBottom);
      };
      ctx.save();
      // The cage shares the upper-left key light with actors and flags.
      ctx.translate(10.2, 7.4);
      ctx.strokeStyle = 'rgba(2,12,8,0.075)';
      ctx.lineWidth = 10.5;
      drawRaisedCageShadow();
      ctx.stroke();
      ctx.strokeStyle = 'rgba(2,12,8,0.12)';
      ctx.lineWidth = 4.6;
      drawRaisedCageShadow();
      ctx.stroke();
      ctx.restore();

      // Soft internal floor shadow sells the footprint without adding a ring.
      const floorShadow = ctx.createLinearGradient(x, 0, backX, 0);
      floorShadow.addColorStop(0, 'rgba(4,13,9,0.07)');
      floorShadow.addColorStop(1, 'rgba(3,10,9,0.34)');
      ctx.fillStyle = floorShadow;
      ctx.beginPath();
      ctx.moveTo(x, top + 5);
      ctx.lineTo(backX, top - lift + 5);
      ctx.lineTo(backX, bottom - lift + 5);
      ctx.lineTo(x, bottom + 5);
      ctx.closePath();
      ctx.fill();

      // Four small ground sleeves make both real uprights and rear anchors
      // look bolted into the turf. These are contact shadows, never selection
      // rings, and remain beneath actors with the rest of the goal floor.
      for (const [anchorX, anchorY, radiusX] of [
        [x, top, 5.2],
        [x, bottom, 5.2],
        [backX, top - lift, 4.3],
        [backX, bottom - lift, 4.3],
      ] as const) {
        ctx.fillStyle = 'rgba(2,10,7,0.42)';
        ctx.beginPath();
        ctx.ellipse(anchorX + direction * 1.4, anchorY + 2.3, radiusX, 2.25, direction * 0.08, 0, TAU);
        ctx.fill();
        ctx.fillStyle = 'rgba(191,199,191,0.66)';
        ctx.beginPath();
        ctx.ellipse(anchorX, anchorY + 0.8, radiusX * 0.52, 1.4, direction * 0.08, 0, TAU);
        ctx.fill();
      }

      // A complete low base frame gives the cage physical contact with the
      // pitch. It is intentionally behind actors and below the bright mouth:
      // side rails run away from both front posts and meet a rear ballast bar.
      const drawGroundBase = (): void => {
        ctx.beginPath();
        ctx.moveTo(x, top);
        ctx.lineTo(backX, top - lift);
        ctx.lineTo(backX, bottom - lift);
        ctx.lineTo(x, bottom);
      };
      this.strokeHybridGoalTube(ctx, drawGroundBase, 2.45, { x: -direction * 0.55, y: -0.42 }, 0.57);

      const drawRearCage = (): void => {
        ctx.beginPath();
        ctx.moveTo(frontRaisedX, frontTop);
        ctx.lineTo(rearRaisedX, rearTop);
        ctx.lineTo(rearRaisedX, rearBottom);
        ctx.lineTo(frontRaisedX, frontBottom);
      };
      this.strokeHybridGoalTube(ctx, drawRearCage, 3.7, { x: -direction * 0.85, y: -0.75 }, 0.78);

      // Rear uprights connect the raised roof rectangle to the newly visible
      // base frame. Without these tubes the net had volume but no believable
      // load-bearing structure at its back corners.
      const drawRearUprights = (): void => {
        ctx.beginPath();
        ctx.moveTo(backX, top - lift);
        ctx.lineTo(rearRaisedX, rearTop);
        ctx.moveTo(backX, bottom - lift);
        ctx.lineTo(rearRaisedX, rearBottom);
      };
      this.strokeHybridGoalTube(ctx, drawRearUprights, 3.15, { x: -direction * 0.68, y: -0.58 }, 0.68);

      const netBreathe = hybridGoalNetBreathe(time, direction > 0 ? 'right' : 'left');
      const roofSurface: NetSurface = (u, v) => ({
        x: frontRaisedX + (rearRaisedX - frontRaisedX) * u,
        y: frontTop + (frontBottom - frontTop) * v
          + ((rearTop + (rearBottom - rearTop) * v) - (frontTop + (frontBottom - frontTop) * v)) * u
          + netBreathe * Math.sin(u * Math.PI) * Math.sin(v * Math.PI),
      });
      const rearSurface: NetSurface = (u, v) => ({
        x: rearRaisedX + (backX - rearRaisedX) * u + direction * netBreathe * 0.32 * Math.sin(v * Math.PI),
        y: rearTop + (rearBottom - rearTop) * v + postHeight * u
          + netBreathe * 0.45 * Math.sin(u * Math.PI) * Math.sin(v * Math.PI),
      });
      const sideSurface = (groundY: number, raisedY: number, rearGroundY: number, rearRaisedY: number): NetSurface => (
        (u, v) => {
          const raisedPoint = {
            x: frontRaisedX + (rearRaisedX - frontRaisedX) * u,
            y: raisedY + (rearRaisedY - raisedY) * u,
          };
          const groundPoint = {
            x: x + (backX - x) * u,
            y: groundY + (rearGroundY - groundY) * u,
          };
          return {
            x: raisedPoint.x + (groundPoint.x - raisedPoint.x) * v,
            y: raisedPoint.y + (groundPoint.y - raisedPoint.y) * v,
          };
        }
      );

      // Three distinct cloth planes make the net occupy space: a taut roof,
      // a lightly relaxed rear curtain and two darker end panels. Everything
      // remains behind actors; the bright real goal mouth is drawn later.
      drawDiamondNet(roofSurface, 4, 12, direction * 0.75, 0.30);
      drawDiamondNet(rearSurface, 3, 12, -direction * 1.35, 0.25);
      drawDiamondNet(sideSurface(top, frontTop, top - lift, rearTop), 4, 3, -direction * 0.55, 0.21);
      drawDiamondNet(sideSurface(bottom, frontBottom, bottom - lift, rearBottom), 4, 3, -direction * 0.55, 0.21);

      // Small rope knots at the rear frame make the mesh look tied to the
      // stanchion instead of printed over it. Keep them sparse and sub-pixel.
      for (let knot = 1; knot < 12; knot++) {
        const t = knot / 12;
        const knotY = rearTop + (rearBottom - rearTop) * t;
        ctx.fillStyle = knot % 3 === 0 ? 'rgba(255,255,250,0.58)' : 'rgba(205,217,211,0.39)';
        ctx.beginPath();
        ctx.arc(rearRaisedX, knotY, knot % 3 === 0 ? 0.9 : 0.65, 0, TAU);
        ctx.fill();
      }
      // Discrete black clips hold the roof mesh to the front rail. Their
      // spacing follows the authored mesh cells and survives at mobile scale.
      for (let clip = 1; clip < 5; clip++) {
        const t = clip / 5;
        const clipX = frontRaisedX + (rearRaisedX - frontRaisedX) * t;
        const clipY = frontTop + (rearTop - frontTop) * t;
        ctx.fillStyle = 'rgba(51,65,59,0.62)';
        ctx.beginPath();
        ctx.ellipse(clipX, clipY + 0.4, 0.92, 0.58, direction * -0.12, 0, TAU);
        ctx.fill();
        ctx.fillStyle = 'rgba(225,231,225,0.38)';
        ctx.beginPath();
        ctx.arc(clipX - direction * 0.28, clipY + 0.12, 0.29, 0, TAU);
        ctx.fill();
      }

      // Paired rear ballast feet and hinge pins give the cage measurable
      // scale and prevent the lower frame from appearing to float.
      for (const anchorY of [top - lift, bottom - lift]) {
        ctx.fillStyle = 'rgba(3,10,9,0.58)';
        ctx.beginPath();
        ctx.ellipse(backX + direction * 1.5, anchorY + 3.5, 6.2, 3.1, 0, 0, TAU);
        ctx.fill();
        ctx.fillStyle = 'rgba(211,216,198,0.68)';
        ctx.beginPath();
        ctx.arc(backX + direction * 1.5, anchorY + 1.6, 1.25, 0, TAU);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  /** Draw only the goal-mouth bars that physically sit above actors. */
  private drawGoalForeground(
    ctx: CanvasRenderingContext2D,
    toSX: (wx: number) => number,
    toSY: (wy: number) => number,
  ): void {
    const top = toSY(ARENA_H / 2 - 130);
    const bottom = toSY(ARENA_H / 2 + 130);
    ctx.save();
    ctx.lineCap = 'round';
    for (const gx of [40, ARENA_W - 40]) {
      const x = toSX(gx);
      if (this.hybridDepth) {
        const postHeight = HYBRID_GOAL_POST_HEIGHT;
        const direction = gx < ARENA_W / 2 ? -1 : 1;
        const raisedX = x - HYBRID_GOAL_HEIGHT_SHEAR_X;
        const raisedTop = top - postHeight;
        const raisedBottom = bottom - postHeight;
        const drawGoalMouth = (): void => {
          ctx.beginPath();
          ctx.moveTo(x, top);
          ctx.lineTo(raisedX, raisedTop);
          ctx.lineTo(raisedX, raisedBottom);
          ctx.lineTo(x, bottom);
        };
        this.strokeHybridGoalTube(ctx, drawGoalMouth, 5.6, { x: -direction * 1.15, y: -0.9 });
        // Black nylon clips visually attach the mesh to the real crossbar.
        // They stop short of both post caps so the circular joins stay clear.
        for (let clip = 1; clip < 8; clip++) {
          const t = clip / 8;
          const clipY = raisedTop + (raisedBottom - raisedTop) * t;
          ctx.fillStyle = 'rgba(48,63,57,0.60)';
          ctx.beginPath();
          ctx.ellipse(raisedX + direction * 0.18, clipY, 0.72, 1.12, 0, 0, TAU);
          ctx.fill();
          ctx.fillStyle = 'rgba(236,240,236,0.34)';
          ctx.beginPath();
          ctx.arc(raisedX - direction * 0.26, clipY - 0.26, 0.28, 0, TAU);
          ctx.fill();
        }
        // Circular post caps distinguish the two uprights from the crossbar.
        for (const capY of [raisedTop, raisedBottom]) {
          ctx.fillStyle = 'rgba(10,25,19,0.50)';
          ctx.beginPath();
          ctx.ellipse(raisedX + 2.2, capY + 2.2, 3.8, 2.4, 0, 0, TAU);
          ctx.fill();
          ctx.fillStyle = '#ffffff';
          ctx.beginPath();
          ctx.ellipse(raisedX, capY, 3.25, 2.05, 0, 0, TAU);
          ctx.fill();
          ctx.fillStyle = 'rgba(181,194,188,0.62)';
          ctx.beginPath();
          ctx.ellipse(raisedX + 0.45, capY + 0.35, 1.35, 0.8, 0, 0, TAU);
          ctx.fill();
        }
        continue;
      }
      ctx.strokeStyle = 'rgba(13,30,22,0.46)';
      ctx.lineWidth = 8;
      ctx.beginPath();
      ctx.moveTo(x + 3.5, top + 3.5);
      ctx.lineTo(x + 3.5, bottom + 3.5);
      ctx.stroke();
      ctx.strokeStyle = '#f5f7fa';
      ctx.lineWidth = 6;
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x, bottom);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,0.74)';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(x - 1.2, top + 2);
      ctx.lineTo(x - 1.2, bottom - 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  /** Record and render restrained cleat compression in the grass.
   *
   * This is not a trail VFX: each mark is a tiny, fading pair of dark fibres
   * placed only after meaningful travel. A fixed pool keeps it mobile-safe.
   */
  private updateAndDrawTurfFootprints(
    ctx: CanvasRenderingContext2D,
    sim: Sim,
    toSX: (wx: number) => number,
    toSY: (wy: number) => number,
    time: number,
  ): void {
    const p = sim.player;
    if (p.runStep < this.lastTurfRunStep) {
      // A new run reuses the renderer but starts a fresh gait clock.
      this.lastTurfRunStep = p.runStep;
      this.lastTurfFootprintX = Number.NaN;
      this.lastTurfFootprintY = Number.NaN;
    }
    if (p.moving || p.dashT > 0) {
      const travelled = Number.isFinite(this.lastTurfFootprintX)
        ? Math.hypot(p.x - this.lastTurfFootprintX, p.y - this.lastTurfFootprintY)
        : Number.POSITIVE_INFINITY;
      const dashPlant = p.dashT > 0 && travelled >= 21 && time - this.lastTurfFootprintAt >= 0.075;
      const runPlant = p.dashT <= 0 && p.runStep > this.lastTurfRunStep;
      if (dashPlant || runPlant) {
        const mark = this.turfFootprints[this.turfFootprintCursor];
        const directionX = p.dashT > 0 ? p.dashDx : p.moveDx;
        const directionY = p.dashT > 0 ? p.dashDy : p.moveDy;
        const angle = Math.atan2(directionY, directionX);
        const plantedFoot: -1 | 1 = p.dashT > 0
          ? this.nextTurfFoot
          : p.runStep % 2 === 1 ? -1 : 1;
        const lateral = plantedFoot * 5.2;
        mark.active = true;
        mark.x = p.x + Math.cos(angle + Math.PI / 2) * lateral;
        mark.y = p.y + Math.sin(angle + Math.PI / 2) * lateral;
        mark.born = time;
        mark.side = plantedFoot;
        mark.angle = angle;
        if (p.dashT > 0) this.nextTurfFoot = this.nextTurfFoot === -1 ? 1 : -1;
        else this.lastTurfRunStep = p.runStep;
        this.turfFootprintCursor = (this.turfFootprintCursor + 1) % this.turfFootprints.length;
        const clippingCount = p.dashT > 0 ? 7 : 3;
        for (let clippingIndex = 0; clippingIndex < clippingCount; clippingIndex++) {
          const clipping = this.turfClippings[this.turfClippingCursor];
          const spread = clippingIndex - (clippingCount - 1) / 2;
          const seed = this.turfClippingCursor * 2.399 + mark.x * 0.017 + mark.y * 0.013;
          const sideAngle = angle + Math.PI + spread * 0.115 + Math.sin(seed) * 0.08;
          const speed = (p.dashT > 0 ? 34 : 17) + (0.5 + 0.5 * Math.sin(seed * 1.71)) * (p.dashT > 0 ? 38 : 18);
          clipping.active = true;
          clipping.x = mark.x + Math.cos(angle + Math.PI / 2) * spread * 1.1;
          clipping.y = mark.y + Math.sin(angle + Math.PI / 2) * spread * 1.1;
          clipping.born = time;
          clipping.vx = Math.cos(sideAngle) * speed;
          clipping.vy = Math.sin(sideAngle) * speed;
          clipping.angle = sideAngle;
          clipping.spin = (clippingIndex % 2 === 0 ? 1 : -1) * (2.2 + (seed % 1) * 2.1);
          clipping.length = 2.7 + (0.5 + 0.5 * Math.cos(seed * 2.31)) * 3.6;
          clipping.shade = clippingIndex % 3;
          this.turfClippingCursor = (this.turfClippingCursor + 1) % this.turfClippings.length;
        }
        this.lastTurfFootprintAt = time;
        this.lastTurfFootprintX = p.x;
        this.lastTurfFootprintY = p.y;
      }
    }

    for (const mark of this.turfFootprints) {
      if (!mark.active) continue;
      const age = time - mark.born;
      if (age >= 2.8) {
        mark.active = false;
        continue;
      }
      const alpha = (1 - age / 2.8) * 0.16;
      const x = toSX(mark.x);
      const y = toSY(mark.y);
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(Math.atan2(Math.sin(mark.angle) * TILT, Math.cos(mark.angle)));
      ctx.scale(1, TILT);
      ctx.fillStyle = `rgba(2,25,10,${alpha})`;
      ctx.beginPath();
      ctx.ellipse(0, 0, 5.2, 2.1, mark.side * 0.12, 0, TAU);
      ctx.fill();
      // A planted boot presses individual fibres backwards along its travel
      // axis. These short deterministic strokes sit beneath the character and
      // make contact readable without a glow, ring or particle emitter.
      ctx.strokeStyle = `rgba(43,57,17,${alpha * 1.28})`;
      ctx.lineWidth = 0.8;
      for (let fibre = -3; fibre <= 3; fibre++) {
        const offset = fibre * 1.15;
        const reach = 4.2 + ((fibre * fibre + mark.side + 7) % 3) * 1.3;
        ctx.beginPath();
        ctx.moveTo(-1.4, offset * 0.34);
        ctx.lineTo(-reach, offset * 0.5 + mark.side * 0.32);
        ctx.stroke();
      }
      ctx.strokeStyle = `rgba(194,220,167,${alpha * 0.48})`;
      ctx.lineWidth = 0.75;
      for (const offset of [-2.5, 0, 2.5]) {
        ctx.beginPath();
        ctx.moveTo(-3.8, offset * 0.2);
        ctx.lineTo(2.8, offset * 0.17);
        ctx.stroke();
      }
      ctx.strokeStyle = `rgba(210,218,132,${alpha * 0.42})`;
      ctx.lineWidth = 0.65;
      for (const offset of [-3.4, 3.4]) {
        ctx.beginPath();
        ctx.moveTo(-0.5, offset * 0.3);
        ctx.lineTo(1.2 + mark.side * 0.5, offset * 0.44 - 1.7);
        ctx.stroke();
      }
      ctx.restore();
    }

    for (const clipping of this.turfClippings) {
      if (!clipping.active) continue;
      const age = time - clipping.born;
      const lifetime = 0.72;
      if (age >= lifetime) {
        clipping.active = false;
        continue;
      }
      // Integral of exponentially damped velocity: displacement increases
      // monotonically and asymptotically settles instead of sliding backwards.
      const displacement = dampedTurfDisplacement(age);
      const x = toSX(clipping.x + clipping.vx * displacement);
      const y = toSY(clipping.y + clipping.vy * displacement);
      const lift = Math.sin(clamp(age / lifetime, 0, 1) * Math.PI) * Math.min(4.5, clipping.length * 0.7);
      const alpha = (1 - age / lifetime) * 0.34;
      ctx.save();
      ctx.translate(x, y - lift);
      ctx.rotate(clipping.angle + clipping.spin * age);
      ctx.scale(1, TILT);
      ctx.strokeStyle = clipping.shade === 0
        ? `rgba(184,195,102,${alpha})`
        : clipping.shade === 1
          ? `rgba(66,83,25,${alpha * 0.92})`
          : `rgba(216,216,132,${alpha * 0.78})`;
      ctx.lineWidth = 0.75;
      ctx.beginPath();
      ctx.moveTo(-clipping.length * 0.5, 0);
      ctx.quadraticCurveTo(0, -0.9, clipping.length * 0.5, 0.2);
      ctx.stroke();
      ctx.restore();
    }
  }
}
