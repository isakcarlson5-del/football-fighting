/**
 * DOM UI: menu, character select, HUD, level-up, pause, result, club shop.
 * The canvas renders the world; everything else lives here.
 */

import { matchClock } from '../core/math';
import { abilityIcon, getStripAtlas, playerAtlas, ABILITY_GLYPHS } from '../core/sprites';
import {
  ABILITIES,
  BOSSES,
  META_TRACKS,
  PLAYERS,
  SKINS,
  metaCost,
  type AbilityId,
  type BossId,
  type MetaTrackId,
  type PlayerDef,
} from './data';
import type { Save } from './meta';
import type { Sim, UpgradeOption } from './sim';

export interface UiHooks {
  onPlay(playerId: string): void;
  onOpenClub(): void;
  onCloseClub(): void;
  onResume(): void;
  onRestart(): void;
  onQuitToMenu(): void;
  onUpgradePicked(opt: UpgradeOption): void;
  onBuyTrack(id: MetaTrackId): void;
  onBuySkin(id: string): void;
  onEquipSkin(playerId: string, skinId: string | null): void;
  onToggleMute(): void;
  onVolume(kind: 'master' | 'sfx' | 'music', value: number): void;
}

const ICON_CACHE = new Map<string, string>();
function iconUrl(id: AbilityId): string {
  let u = ICON_CACHE.get(id);
  if (!u) {
    u = abilityIcon(ABILITY_GLYPHS[id], ABILITIES[id].color).toDataURL();
    ICON_CACHE.set(id, u);
  }
  return u;
}

function statIconUrl(id: string, color: string): string {
  const key = `stat:${id}`;
  let u = ICON_CACHE.get(key);
  if (!u) {
    u = abilityIcon(id === 'maxhp' || id === 'regen' ? 'shield' : id === 'power' ? 'ball' : id === 'speed' ? 'dash' : id === 'magnet' ? 'orbit' : 'whistle', color).toDataURL();
    ICON_CACHE.set(key, u);
  }
  return u;
}

function portraitUrl(p: PlayerDef, kit?: { shirt: string; shorts: string; socks: string; trim: string }): string {
  // prefer the generated 2.5D strip (frame 0 bust crop); fall back to procedural
  const strip = getStripAtlas(p.id, kit?.shirt);
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 128;
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingEnabled = true;
  if (strip) {
    ctx.drawImage(strip.canvas, 36, 0, 184, 184, 0, 0, 128, 128);
    return c.toDataURL();
  }
  const atlas = playerAtlas(p, kit);
  ctx.drawImage(atlas.canvas, 0, 0, atlas.fw, atlas.fh, -38, -6, 204, 255);
  return c.toDataURL();
}

export class UI {
  root: HTMLElement;
  private hooks: UiHooks;
  private save: Save;
  private artReady = new Set<string>();
  private hudRefs: {
    xpFill?: HTMLElement;
    clock?: HTMLElement;
    kills?: HTMLElement;
    coins?: HTMLElement;
    level?: HTMLElement;
    hpFill?: HTMLElement;
    hpText?: HTMLElement;
    dock?: HTMLElement;
    bossPlate?: HTMLElement;
    bossName?: HTMLElement;
    bossTitle?: HTMLElement;
    banner?: HTMLElement;
  } = {};
  private dockSig = '';
  selectedPlayer = PLAYERS[0].id;
  rerolled = false;

  constructor(root: HTMLElement, hooks: UiHooks, save: Save) {
    this.root = root;
    this.hooks = hooks;
    this.save = save;
  }

  clear(): void {
    this.root.innerHTML = '';
    this.hudRefs = {};
    this.dockSig = '';
  }

  /**
   * Applies overlay-gradient + art image as the screen background.
   * The relative image URL resolves against the document, so it works when
   * the game is hosted from a subpath (game portals). Gradient-only until
   * the image has actually loaded (no broken-image flash, safe fallback).
   */
  private applyArtBg(el: HTMLElement, url: string, overlay: string, position = 'center 20%'): void {
    const apply = () => {
      el.style.backgroundImage = `${overlay}, url('${url}')`;
      el.style.backgroundSize = 'cover, cover';
      el.style.backgroundPosition = `${position}, center`;
      el.style.backgroundRepeat = 'no-repeat';
    };
    if (this.artReady.has(url)) {
      apply();
      return;
    }
    el.style.backgroundImage = overlay;
    const img = new Image();
    img.onload = () => {
      this.artReady.add(url);
      if (el.isConnected) apply();
    };
    img.src = url;
  }

  /* ---------------- menu ---------------- */

  showMenu(artUrl: string | null): void {
    this.clear();
    const s = this.save.data.stats;
    const el = document.createElement('div');
    el.className = 'screen';
    el.id = 'menu-screen';
    el.innerHTML = `
      <div id="menu-art" style="${artUrl ? `background-image:url('${artUrl}')` : ''}"></div>
      <div class="game-logo">
        <span class="l1">Football</span>
        <span class="l2">Fighting</span>
        <span class="tag">Terrace Survivor</span>
      </div>
      <div class="menu-buttons">
        <button class="btn" data-act="play">Kick Off</button>
        <button class="btn secondary" data-act="club">The Club</button>
      </div>
      <div class="menu-meta">
        <span class="coin-chip"><span class="dot"></span>${this.save.data.coins}</span>
        <button class="btn small secondary" data-act="mute">${this.save.data.muted ? 'Unmute' : 'Mute'}</button>
      </div>
      <div class="best-stats">BEST: ${matchClock(s.bestTime)} survived &nbsp;·&nbsp; ${s.totalKills} career KOs &nbsp;·&nbsp; ${s.wins} full-time wins</div>
      <div class="controls-hint"><kbd>WASD</kbd> / <kbd>arrows</kbd> to move — everything else is automatic. Touch: drag left side.</div>
      <div class="version-tag">v1.0 — local save</div>
    `;
    el.querySelector('[data-act="play"]')!.addEventListener('click', () => this.showSelect());
    el.querySelector('[data-act="club"]')!.addEventListener('click', () => this.hooks.onOpenClub());
    el.querySelector('[data-act="mute"]')?.addEventListener('click', () => this.hooks.onToggleMute());
    this.root.appendChild(el);
  }

  /* ---------------- character select ---------------- */

  showSelect(): void {
    this.clear();
    const el = document.createElement('div');
    el.className = 'screen select-screen';
    this.applyArtBg(
      el,
      'art/select-bg.jpg',
      'linear-gradient(180deg, rgba(11,16,32,0.5) 0%, rgba(11,16,32,0.8) 45%, rgba(11,16,32,0.93) 100%)',
      'center 18%',
    );
    const cards = PLAYERS.map((p) => {
      const equipped = this.save.equippedSkin(p.id);
      const skin = equipped ? SKINS.find((s) => s.id === equipped) : undefined;
      const kit = skin?.kit ?? p.kit;
      const maxSpeed = 130;
      const maxHp = 130;
      const sel = p.id === this.selectedPlayer ? 'selected' : '';
      const skinSwatches = SKINS.filter((s) => s.player === p.id && this.save.ownsSkin(s.id))
        .map(
          (s) =>
            `<div class="skin-swatch ${s.id === equipped ? 'selected' : ''}" data-skin="${s.id}" data-player="${p.id}" title="${s.name}" style="background:${s.kit.shirt}"></div>`,
        )
        .join('');
      return `
      <div class="char-card ${sel}" data-player="${p.id}">
        <div class="portrait"><img src="${portraitUrl(p, skin?.kit)}" alt="${p.name}" width="128" height="128"></div>
        <div class="name">${p.name}</div>
        <div class="nickname">#${p.number} · ${p.nickname}</div>
        <div class="stat-bars">
          <div class="stat-row"><span>Pace</span><span class="bar"><i style="width:${(p.speed / maxSpeed) * 100}%;background:var(--green)"></i></span></div>
          <div class="stat-row"><span>Health</span><span class="bar"><i style="width:${(p.maxHp / maxHp) * 100}%;background:var(--red)"></i></span></div>
          <div class="stat-row"><span>Power</span><span class="bar"><i style="width:${p.power * 70}%;background:var(--gold)"></i></span></div>
        </div>
        <div class="trait"><b style="color:${ABILITIES[p.startAbility].color}">${p.trait}:</b> ${p.traitDesc}</div>
        <div class="starts-with"><img src="${iconUrl(p.startAbility)}" alt="">Starts with ${ABILITIES[p.startAbility].name}</div>
        <div class="skin-row">
          <div class="skin-swatch ${!equipped ? 'selected' : ''}" data-skin="" data-player="${p.id}" title="Default kit" style="background:${kit.shirt};border-style:${!equipped ? 'solid' : 'dashed'}"></div>
          ${skinSwatches}
        </div>
      </div>`;
    }).join('');
    el.innerHTML = `
      <h1 class="screen-title">Pick Your Fighter</h1>
      <div class="char-grid">${cards}</div>
      <div class="row">
        <button class="btn secondary" data-act="back">Back</button>
        <button class="btn" data-act="start">To Kick Off</button>
      </div>
    `;
    el.querySelectorAll('.char-card').forEach((card) => {
      card.addEventListener('click', (ev) => {
        const target = ev.target as HTMLElement;
        if (target.classList.contains('skin-swatch')) return;
        this.selectedPlayer = (card as HTMLElement).dataset.player!;
        this.showSelect();
      });
    });
    el.querySelectorAll('.skin-swatch').forEach((sw) => {
      sw.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const t = sw as HTMLElement;
        const pid = t.dataset.player!;
        const sid = t.dataset.skin || null;
        this.hooks.onEquipSkin(pid, sid);
        this.showSelect();
      });
    });
    el.querySelector('[data-act="back"]')!.addEventListener('click', () => this.hooks.onQuitToMenu());
    el.querySelector('[data-act="start"]')!.addEventListener('click', () => this.hooks.onPlay(this.selectedPlayer));
    this.root.appendChild(el);
  }

  /* ---------------- HUD ---------------- */

  buildHud(): void {
    this.clear();
    const el = document.createElement('div');
    el.id = 'hud';
    el.innerHTML = `
      <div id="xp-bar"><div id="xp-fill"></div></div>
      <div id="hud-top">
        <div class="hud-chip" id="hud-kills"><span class="lbl">KOs</span><span class="v">0</span></div>
        <div id="match-clock">0'</div>
        <div class="hud-chip" id="hud-coins"><span class="lbl">Coins</span><span class="v">0</span></div>
        <div class="hud-chip" id="hud-level"><span class="lbl">Lv</span><span class="v">1</span></div>
      </div>
      <div id="boss-plate"><div class="title"></div><div class="name"></div></div>
      <div id="banner"></div>
      <div id="hp-wrap">
        <div id="hp-label"><span>HP</span><span id="hp-text"></span></div>
        <div id="hp-bar"><div id="hp-fill"></div></div>
      </div>
      <div id="ability-dock"></div>
      <button id="pause-btn" aria-label="Pause">II</button>
      <div id="joystick"><div class="nub"></div></div>
    `;
    this.root.appendChild(el);
    this.hudRefs = {
      xpFill: el.querySelector<HTMLElement>('#xp-fill')!,
      clock: el.querySelector<HTMLElement>('#match-clock')!,
      kills: el.querySelector<HTMLElement>('#hud-kills .v')!,
      coins: el.querySelector<HTMLElement>('#hud-coins .v')!,
      level: el.querySelector<HTMLElement>('#hud-level .v')!,
      hpFill: el.querySelector<HTMLElement>('#hp-fill')!,
      hpText: el.querySelector<HTMLElement>('#hp-text')!,
      dock: el.querySelector<HTMLElement>('#ability-dock')!,
      bossPlate: el.querySelector<HTMLElement>('#boss-plate')!,
      bossName: el.querySelector<HTMLElement>('#boss-plate .name')!,
      bossTitle: el.querySelector<HTMLElement>('#boss-plate .title')!,
      banner: el.querySelector<HTMLElement>('#banner')!,
    };
    el.querySelector('#pause-btn')!.addEventListener('click', () => this.hooks.onResume());
  }

  updateHud(sim: Sim): void {
    const r = this.hudRefs;
    if (!r.clock) return;
    const p = sim.player;
    r.clock!.textContent = matchClock(sim.time);
    r.clock!.classList.toggle('halftime', sim.time >= 285 && sim.time < 330);
    r.kills!.textContent = String(sim.kills);
    r.coins!.textContent = String(sim.coins);
    r.level!.textContent = String(p.level);
    r.xpFill!.style.width = `${Math.min(100, (p.xp / p.xpNext) * 100)}%`;
    const hpPct = Math.max(0, (p.hp / p.maxHp) * 100);
    r.hpFill!.style.width = `${hpPct}%`;
    r.hpFill!.classList.toggle('low', hpPct < 35);
    r.hpText!.textContent = `${Math.ceil(p.hp)} / ${p.maxHp}`;
    // ability dock
    const sig = Object.entries(p.abilities)
      .map(([k, v]) => `${k}${v}`)
      .join(',');
    if (sig !== this.dockSig) {
      this.dockSig = sig;
      r.dock!.innerHTML = Object.entries(p.abilities)
        .map(([id, lvl]) => {
          const def = ABILITIES[id as AbilityId];
          return `<div class="ability-slot lane-${def.lane}" title="${def.name} Lv${lvl} · ${def.lane.toUpperCase()}"><img src="${iconUrl(id as AbilityId)}" alt="${def.name}"><span class="lvl">${lvl}</span></div>`;
        })
        .join('');
    }
    // boss plate
    if (sim.bossAlive && sim.bossAlive.boss) {
      const bossId: BossId = sim.bossAlive.boss;
      r.bossPlate!.style.display = 'block';
      r.bossName!.textContent = BOSSES[bossId].name;
      r.bossTitle!.textContent = BOSSES[bossId].title;
    } else {
      r.bossPlate!.style.display = 'none';
    }
  }

  banner(text: string): void {
    const b = this.hudRefs.banner;
    if (!b) return;
    b.textContent = text;
    b.classList.remove('show');
    void (b as HTMLElement).offsetWidth; // restart animation
    b.classList.add('show');
  }

  /* ---------------- level up ---------------- */

  showLevelUp(options: UpgradeOption[], onReroll: () => UpgradeOption[]): void {
    const existing = this.root.querySelector('#levelup-screen');
    existing?.remove();
    this.rerolled = false;
    const el = document.createElement('div');
    el.className = 'screen';
    el.id = 'levelup-screen';
    const renderCards = (opts: UpgradeOption[]) => {
      const cards = opts
        .map((o, i) => {
          const icon = o.kind === 'ability' ? iconUrl(o.id as AbilityId) : o.kind === 'stat' ? statIconUrl(o.id, o.color) : statIconUrl('heal', o.color);
          const tag = o.kind === 'ability' ? (o.level === 1 ? 'New ability' : `Ability · Lv${o.level}`) : o.kind === 'stat' ? 'Training' : 'Recovery';
          // every offensive ability is lane-typed: GROUND hugs the pitch,
          // AERIAL flies over near mobs onto far high-priority threats
          const lane = o.kind === 'ability' ? ABILITIES[o.id as AbilityId].lane : null;
          const laneChip = lane ? `<span class="lane-tag lane-${lane}">${lane.toUpperCase()}</span>` : '';
          return `
          <div class="upgrade-card" data-idx="${i}" style="--uc:${o.color}">
            <img src="${icon}" alt="">
            <div class="uc-tag">${tag} ${laneChip}</div>
            <div class="uc-name">${o.name}</div>
            <div class="uc-desc">${o.desc}</div>
          </div>`;
        })
        .join('');
      const wrap = el.querySelector('.levelup-cards')!;
      wrap.innerHTML = cards;
      wrap.querySelectorAll('.upgrade-card').forEach((c) => {
        c.addEventListener('click', () => {
          const idx = Number((c as HTMLElement).dataset.idx);
          el.remove();
          this.hooks.onUpgradePicked(opts[idx]);
        });
      });
    };
    el.innerHTML = `
      <h1 class="screen-title" style="color:var(--gold)">Level Up!</h1>
      <div class="levelup-cards"></div>
      <button class="btn small secondary" data-act="reroll" style="margin-top:6px">Reroll (1x)</button>
      <div class="controls-hint" style="margin-top:4px">Press <kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd> to pick</div>
    `;
    el.querySelector('[data-act="reroll"]')!.addEventListener('click', (ev) => {
      if (this.rerolled) return;
      this.rerolled = true;
      (ev.target as HTMLElement).setAttribute('disabled', 'true');
      renderCards(onReroll());
    });
    renderCards(options);
    this.root.appendChild(el);
  }

  /* ---------------- pause ---------------- */

  showPause(): void {
    const el = document.createElement('div');
    el.className = 'screen';
    el.id = 'pause-screen';
    el.innerHTML = `
      <h1 class="screen-title">Half-Time Team Talk</h1>
      <div class="menu-buttons">
        <button class="btn" data-act="resume">Play On</button>
        <button class="btn secondary" data-act="restart">Restart Match</button>
        <button class="btn secondary" data-act="mute">${this.save.data.muted ? 'Unmute' : 'Mute'}</button>
        <button class="btn danger" data-act="quit">Abandon Match</button>
      </div>
      <div class="panel" style="width:min(340px,86vw);display:flex;flex-direction:column;gap:10px">
        ${(['master', 'sfx', 'music'] as const)
          .map(
            (k) => `
          <label style="display:grid;grid-template-columns:70px 1fr;align-items:center;gap:10px;font-size:12px;text-transform:uppercase;letter-spacing:.12em">
            ${k}
            <input type="range" min="0" max="100" value="${Math.round(this.save.data.volume[k] * 100)}" data-vol="${k}" style="accent-color:var(--gold)">
          </label>`,
          )
          .join('')}
      </div>
    `;
    el.querySelectorAll('[data-vol]').forEach((inp) =>
      inp.addEventListener('input', () => {
        const t = inp as HTMLInputElement;
        this.hooks.onVolume(t.dataset.vol as 'master' | 'sfx' | 'music', Number(t.value) / 100);
      }),
    );
    el.querySelector('[data-act="resume"]')!.addEventListener('click', () => this.hooks.onResume());
    el.querySelector('[data-act="restart"]')!.addEventListener('click', () => this.hooks.onRestart());
    el.querySelector('[data-act="mute"]')?.addEventListener('click', () => this.hooks.onToggleMute());
    el.querySelector('[data-act="quit"]')!.addEventListener('click', () => this.hooks.onQuitToMenu());
    this.root.appendChild(el);
  }

  hidePause(): void {
    this.root.querySelector('#pause-screen')?.remove();
  }

  /* ---------------- result ---------------- */

  showResult(won: boolean, sim: Sim, def: PlayerDef): void {
    this.clear();
    const r = sim.result(won);
    const total = r.coins + r.bonus;
    const el = document.createElement('div');
    el.className = `screen ${won ? 'victory-screen' : ''}`;
    if (won) {
      this.applyArtBg(
        el,
        'art/victory.jpg',
        'linear-gradient(180deg, rgba(11,16,32,0.3) 0%, rgba(11,16,32,0.66) 55%, rgba(11,16,32,0.92) 100%)',
        'center 30%',
      );
    }
    el.innerHTML = `
      <h1 class="screen-title ${won ? 'result-title-win' : 'result-title-lose'}">${won ? 'Full Time — You Survived!' : 'Knocked Out'}</h1>
      <p style="opacity:.85">${won ? `${def.name} stood tall through all 90 minutes.` : `The terrace got ${def.name} at ${matchClock(r.time)}.`}</p>
      <div class="result-grid">
        <div class="result-cell"><div class="v">${matchClock(r.time)}</div><div class="k">Survived</div></div>
        <div class="result-cell"><div class="v">${r.kills}</div><div class="k">Knockouts</div></div>
        <div class="result-cell"><div class="v">${r.level}</div><div class="k">Level</div></div>
        <div class="result-cell"><div class="v">+${total}</div><div class="k">Coins earned</div></div>
      </div>
      <div class="row">
        <button class="btn" data-act="again">Run It Back</button>
        <button class="btn secondary" data-act="club">The Club</button>
        <button class="btn secondary" data-act="menu">Main Menu</button>
      </div>
      <div class="coin-chip"><span class="dot"></span>${this.save.data.coins} in the club account</div>
    `;
    el.querySelector('[data-act="again"]')!.addEventListener('click', () => this.hooks.onRestart());
    el.querySelector('[data-act="club"]')!.addEventListener('click', () => this.hooks.onOpenClub());
    el.querySelector('[data-act="menu"]')!.addEventListener('click', () => this.hooks.onQuitToMenu());
    this.root.appendChild(el);
  }

  /* ---------------- club (shop + skins) ---------------- */

  showClub(tab: 'upgrades' | 'skins'): void {
    this.clear();
    const el = document.createElement('div');
    el.className = 'screen';
    const header = `
      <h1 class="screen-title">The Club</h1>
      <div class="coin-chip"><span class="dot"></span>${this.save.data.coins}</div>
      <div class="shop-tabs">
        <button class="btn small ${tab === 'upgrades' ? 'active' : 'secondary'}" data-tab="upgrades">Training Ground</button>
        <button class="btn small ${tab === 'skins' ? 'active' : 'secondary'}" data-tab="skins">Kit Room</button>
      </div>
    `;
    let body = '';
    if (tab === 'upgrades') {
      body = `<div class="shop-list">${META_TRACKS.map((t) => {
        const rank = this.save.rank(t.id);
        const maxed = rank >= t.maxRank;
        const cost = maxed ? 0 : metaCost(t, rank);
        const pips = Array.from({ length: t.maxRank }, (_, i) => `<i class="${i < rank ? 'on' : ''}"></i>`).join('');
        const cur = rank === 0 ? 'none' : `+${t.per * rank}${t.unit.replace('%', '%')}`;
        return `
          <div class="shop-item">
            <div>
              <h3>${t.name}</h3>
              <p>${t.desc} Current: <b style="color:var(--gold)">${cur}</b>${t.id === 'guard' && rank >= 3 ? ' · +1 bodyguard' : ''}${t.id === 'guard' && rank >= 5 ? ' · +2 bodyguards' : ''}</p>
              <div class="rank-pips">${pips}</div>
            </div>
            <button class="btn small ${maxed ? 'secondary' : ''}" data-buy="${t.id}" ${maxed || this.save.data.coins < cost ? 'disabled' : ''}>
              ${maxed ? 'Maxed' : `${cost} coins`}
            </button>
          </div>`;
      }).join('')}</div>`;
    } else {
      body = `<div class="skin-grid">${SKINS.map((s) => {
        const owned = this.save.ownsSkin(s.id);
        const equipped = this.save.equippedSkin(s.player) === s.id;
        const player = PLAYERS.find((p) => p.id === s.player)!;
        return `
          <div class="skin-card ${equipped ? 'equipped' : ''}">
            <div class="kit-preview" style="background:linear-gradient(180deg,${s.kit.shirt} 55%,${s.kit.shorts} 55%);color:${s.kit.trim}">${player.number}</div>
            <div><b>${s.name}</b></div>
            <div class="who">${player.name}</div>
            ${
              equipped
                ? `<button class="btn small secondary" data-equip="${s.id}" data-player="${s.player}">Unequip</button>`
                : owned
                  ? `<button class="btn small" data-equip="${s.id}" data-player="${s.player}">Equip</button>`
                  : `<button class="btn small" data-buyskin="${s.id}" ${this.save.data.coins < s.cost ? 'disabled' : ''}>${s.cost} coins</button>`
            }
          </div>`;
      }).join('')}</div>`;
    }
    el.innerHTML = `<div class="shop-wrap">${header}${body}</div>
      <button class="btn secondary" data-act="back">Back</button>`;
    el.querySelectorAll('[data-tab]').forEach((b) =>
      b.addEventListener('click', () => this.showClub((b as HTMLElement).dataset.tab as 'upgrades' | 'skins')),
    );
    el.querySelectorAll('[data-buy]').forEach((b) =>
      b.addEventListener('click', () => this.hooks.onBuyTrack((b as HTMLElement).dataset.buy as MetaTrackId)),
    );
    el.querySelectorAll('[data-buyskin]').forEach((b) =>
      b.addEventListener('click', () => this.hooks.onBuySkin((b as HTMLElement).dataset.buyskin!)),
    );
    el.querySelectorAll('[data-equip]').forEach((b) =>
      b.addEventListener('click', () => {
        const t = b as HTMLElement;
        const sid = t.dataset.equip!;
        const pid = t.dataset.player!;
        this.hooks.onEquipSkin(pid, this.save.equippedSkin(pid) === sid ? null : sid);
      }),
    );
    el.querySelector('[data-act="back"]')!.addEventListener('click', () => this.hooks.onCloseClub());
    this.root.appendChild(el);
  }
}
