import type { Sim } from '../../src/game/sim';
import type { Save } from '../../src/game/meta';
import type { AbilityId, StatId } from '../../src/game/data';

declare global {
  interface Window {
    __FF: {
      getState(): { app: string; run: string };
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
      getCameraState(): { x: number; y: number; lookX: number; lookY: number };
      getPlayerOcclusionStrength(): number;
      getBossScreenRect(): { left: number; right: number; top: number; bottom: number; centerX: number } | null;
      getCombatPresentationMetrics(): {
        activeEnemies: number;
        visibleHealthBars: number;
        renderedParticles: number;
        renderedImpacts: number;
        renderedSeekerTrails: number;
        renderedDamageNumbers: number;
      };
      pickUpgrade(i: number): void;
      skipToBoss(n: 1 | 2): void;
      debugSpawn(id: string, dx: number, dy: number, elite?: boolean): void;
      debugDropPickup(kind: 'xp' | 'coin' | 'heal' | 'trophy' | 'magnet' | 'bomb' | 'freeze', dx: number, dy: number): void;
      showAbilityCards(ids: AbilityId[]): void;
      showTrainingCards(ids: Array<StatId | 'heal' | 'coins'>): void;
    };
    __ART_READY?: boolean;
  }
}

export {};
