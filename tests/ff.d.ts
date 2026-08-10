import type { Sim } from '../../src/game/sim';
import type { Save } from '../../src/game/meta';
import type { AbilityId } from '../../src/game/data';

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
      pickUpgrade(i: number): void;
      skipToBoss(n: 1 | 2): void;
      debugSpawn(id: string, dx: number, dy: number, elite?: boolean): void;
      showAbilityCards(ids: AbilityId[]): void;
    };
    __ART_READY?: boolean;
  }
}

export {};
