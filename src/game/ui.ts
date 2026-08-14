/**
 * DOM UI: menu, character select, HUD, level-up, pause, result, club shop.
 * The canvas renders the world; everything else lives here.
 */

import { matchClock } from '../core/math';
import { abilityIcon, ABILITY_GLYPHS } from '../core/sprites';
import {
  ABILITIES,
  ABILITY_ROLE_LABELS,
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
import type { EntityScreenRect } from './render';
import { abilityCadenceLabel, type Sim, type UpgradeOption } from './sim';
import type { LeaderboardEntry, VipAdminStats } from '../core/community';

export interface UiHooks {
  onPlay(playerId: string): void;
  onOpenClub(): void;
  onCloseClub(): void;
  onResume(): void;
  onDash(): void;
  onRestart(): void;
  onQuitToMenu(): void;
  onUpgradePicked(opt: UpgradeOption): void;
  onBuyTrack(id: MetaTrackId): void;
  onBuySkin(id: string): void;
  onEquipSkin(playerId: string, skinId: string | null): void;
  onToggleMute(): void;
  onToggleReducedVfx(): void;
  onToggleHaptics(): void;
  onVolume(kind: 'master' | 'sfx' | 'music', value: number): void;
  onLeaderboardName(name: string): void;
  onLeaderboardRefresh(): void;
  onVipAuthenticate(token: string): void;
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

/** Full illustrated art is reserved for draft cards; HUD icons stay compact. */
function abilityCardArtUrl(id: AbilityId): string {
  return `art/abilities/${id}.webp`;
}

/** Every training/recovery choice has a full generated illustration, just
 *  like offensive abilities. */
function trainingCardArtUrl(id: string): string {
  return `art/cards/${id}.webp`;
}

/** CSS custom-property URLs are otherwise resolved from the built stylesheet
 * under /assets/, not from the document. Emit a document-based absolute URL
 * so character previews work both at localhost root and portal subpaths. */
function documentAssetUrl(path: string): string {
  return new URL(path, document.baseURI).href;
}

export class UI {
  root: HTMLElement;
  private hooks: UiHooks;
  private save: Save;
  private artReady = new Set<string>();
  private selectPreviewReady = false;
  private selectPreviewPromise: Promise<void>;
  private hudRefs: {
    xpFill?: HTMLElement;
    xpBar?: HTMLElement;
    clock?: HTMLElement;
    clockValue?: HTMLElement;
    clockPhase?: HTMLElement;
    kills?: HTMLElement;
    coins?: HTMLElement;
    level?: HTMLElement;
    hpFill?: HTMLElement;
    hpBar?: HTMLElement;
    hpText?: HTMLElement;
    dock?: HTMLElement;
    dashButton?: HTMLButtonElement;
    dashCooldown?: HTMLElement;
    dashCharges?: HTMLElement;
    dashHint?: HTMLElement;
    bossPlate?: HTMLElement;
    bossName?: HTMLElement;
    bossTitle?: HTMLElement;
    bossHpFill?: HTMLElement;
    bossHpBar?: HTMLElement;
    bossHpText?: HTMLElement;
    banner?: HTMLElement;
  } = {};
  private dockSig = '';
  private dialogCleanup: (() => void) | null = null;
  private draftCleanup: (() => void) | null = null;
  selectedPlayer = PLAYERS[0].id;

  constructor(root: HTMLElement, hooks: UiHooks, save: Save) {
    this.root = root;
    this.hooks = hooks;
    this.save = save;
    // Start the four animated selection previews while the menu key art is on
    // screen. A very fast first click may still beat disk/network decode, so
    // showSelect() owns an intentional tunnel transition until all four settle.
    const previewDelayParam = new URLSearchParams(location.search).get('previewDelay');
    const previewDelay = new URLSearchParams(location.search).has('debug')
      ? Math.min(3_000, Math.max(0, Number(previewDelayParam) || 0))
      : 0;
    this.selectPreviewPromise = Promise.all(PLAYERS.map((player) => new Promise<void>((resolve) => {
      const image = new Image();
      image.onload = () => resolve();
      image.onerror = () => resolve();
      image.src = `art/players/directional-v3/${player.id}/e.webp`;
    }))).then(() => previewDelay > 0
      ? new Promise<void>((resolve) => window.setTimeout(resolve, previewDelay))
      : undefined).then(() => {
      this.selectPreviewReady = true;
    });
  }

  clear(): void {
    this.dialogCleanup?.();
    this.draftCleanup?.();
    this.root.innerHTML = '';
    this.hudRefs = {};
    this.dockSig = '';
  }

  /** Gives pause/admin overlays real modal keyboard behaviour without
   * trapping focus after the overlay closes. */
  private bindDialog(el: HTMLElement, onEscape: () => void): () => void {
    this.dialogCleanup?.();
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.tabIndex = -1;
    let cleaned = false;
    const focusable = () => [...el.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
    )].filter((node) => node.offsetParent !== null);
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      el.removeEventListener('keydown', handleKeydown);
      if (this.dialogCleanup === cleanup) this.dialogCleanup = null;
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
    const close = () => {
      cleanup();
      onEscape();
    };
    const handleKeydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
        return;
      }
      if (event.key !== 'Tab') return;
      const nodes = focusable();
      if (nodes.length === 0) {
        event.preventDefault();
        el.focus({ preventScroll: true });
        return;
      }
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus({ preventScroll: true });
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      }
    };
    el.addEventListener('keydown', handleKeydown);
    this.dialogCleanup = cleanup;
    requestAnimationFrame(() => (focusable()[0] ?? el).focus({ preventScroll: true }));
    return close;
  }

  /** Roving-focus navigation shared by every screen: WASD/arrows move
   * focus between the focusable controls, Enter/Space activates the
   * focused control. Text fields keep their native behaviour (typing,
   * caret, slider adjust), and screens with their own keydown handling
   * keep precedence because they preventDefault. Skin swatches stay out
   * of the arrow path so character cards read as one clean unit. */
  private bindMenuNav(el: HTMLElement): void {
    const direction = (key: string): 'up' | 'down' | 'left' | 'right' | null => {
      const k = key.toLowerCase();
      if (k === 'arrowup' || k === 'w') return 'up';
      if (k === 'arrowdown' || k === 's') return 'down';
      if (k === 'arrowleft' || k === 'a') return 'left';
      if (k === 'arrowright' || k === 'd') return 'right';
      return null;
    };
    const targets = () => [...el.querySelectorAll<HTMLElement>(
      'button:not([disabled]):not(.skin-swatch), input:not([disabled]):not([type="hidden"]), select:not([disabled]), [tabindex]:not([tabindex="-1"]):not(.skin-swatch), [href]',
    )].filter((node) => node.offsetParent !== null);
    el.addEventListener('keydown', (event) => {
      if (!(event instanceof KeyboardEvent) || event.defaultPrevented) return;
      const active = document.activeElement;
      if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || active instanceof HTMLSelectElement) return;
      const key = event.key;
      if (key === 'Enter' || key === ' ') {
        event.preventDefault();
        if (active instanceof HTMLElement) active.click();
        return;
      }
      const dir = direction(key);
      if (!dir) return;
      event.preventDefault();
      const nodes = targets();
      if (nodes.length === 0) return;
      if (!(active instanceof HTMLElement) || !nodes.includes(active)) {
        nodes[0].focus({ preventScroll: true });
        return;
      }
      const cur = active.getBoundingClientRect();
      const cx = cur.left + cur.width / 2;
      const cy = cur.top + cur.height / 2;
      let best: HTMLElement | null = null;
      let bestScore = Infinity;
      for (const node of nodes) {
        if (node === active) continue;
        const rect = node.getBoundingClientRect();
        const dx = rect.left + rect.width / 2 - cx;
        const dy = rect.top + rect.height / 2 - cy;
        const horizontal = dir === 'left' || dir === 'right';
        const forward = horizontal ? dx : dy;
        if (dir === 'left' && forward >= -8) continue;
        if (dir === 'right' && forward <= 8) continue;
        if (dir === 'up' && forward >= -8) continue;
        if (dir === 'down' && forward <= 8) continue;
        const perpendicular = horizontal ? Math.abs(dy) : Math.abs(dx);
        const score = Math.abs(forward) + perpendicular * 4;
        if (score < bestScore) {
          bestScore = score;
          best = node;
        }
      }
      best?.focus({ preventScroll: true });
    });
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
      <section class="leaderboard-panel panel" aria-labelledby="leaderboard-title">
        <div class="leaderboard-head">
          <div><span class="leaderboard-kicker">Online table</span><h2 id="leaderboard-title">Leaderboard</h2></div>
          <div class="leaderboard-actions"><button type="button" class="leaderboard-refresh" data-act="leaderboard-refresh" aria-label="Refresh leaderboard">Refresh</button><button type="button" class="leaderboard-refresh vip-open" data-act="vip-open" aria-label="Open VIP admin">VIP</button></div>
        </div>
        <label class="leaderboard-name">Your name<input type="text" maxlength="20" autocomplete="nickname" spellcheck="false" aria-label="Leaderboard name"></label>
        <div class="leaderboard-list" role="list" aria-live="polite"><div class="leaderboard-status">Connecting…</div></div>
      </section>
      <div class="controls-hint"><kbd>WASD</kbd> / <kbd>arrows</kbd> to move — everything else is automatic. Touch: drag left side.</div>
      <div class="version-tag">v1.0 — local save</div>
    `;
    el.querySelector('[data-act="play"]')!.addEventListener('click', () => this.showSelect());
    el.querySelector('[data-act="club"]')!.addEventListener('click', () => this.hooks.onOpenClub());
    el.querySelector('[data-act="mute"]')?.addEventListener('click', () => this.hooks.onToggleMute());
    const nameInput = el.querySelector<HTMLInputElement>('.leaderboard-name input')!;
    nameInput.value = this.save.data.leaderboardName;
    const commitName = () => this.hooks.onLeaderboardName(nameInput.value);
    nameInput.addEventListener('change', commitName);
    nameInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        commitName();
        nameInput.blur();
      }
    });
    el.querySelector('[data-act="leaderboard-refresh"]')?.addEventListener('click', () => this.hooks.onLeaderboardRefresh());
    el.querySelector('[data-act="vip-open"]')?.addEventListener('click', () => this.showVipAdmin());
    this.root.appendChild(el);
    this.bindMenuNav(el);
  }

  renderLeaderboard(entries: LeaderboardEntry[], online: boolean): void {
    const list = this.root.querySelector<HTMLElement>('.leaderboard-list');
    if (!list) return;
    list.innerHTML = '';
    if (!online) {
      const status = document.createElement('div');
      status.className = 'leaderboard-status offline';
      status.textContent = 'Offline · game progress still saves locally';
      list.appendChild(status);
      return;
    }
    if (entries.length === 0) {
      const status = document.createElement('div');
      status.className = 'leaderboard-status';
      status.textContent = 'No completed runs yet — set the first score.';
      list.appendChild(status);
      return;
    }
    for (const entry of entries) {
      const row = document.createElement('div');
      row.className = 'leaderboard-row';
      row.setAttribute('role', 'listitem');
      const rank = document.createElement('span');
      rank.className = 'leaderboard-rank';
      rank.textContent = String(entry.rank).padStart(2, '0');
      const identity = document.createElement('span');
      identity.className = 'leaderboard-identity';
      const name = document.createElement('b');
      name.textContent = entry.name;
      const run = document.createElement('small');
      run.textContent = `${entry.kills} KOs · ${matchClock(entry.time)} · Lv${entry.level}${entry.won ? ' · FT' : ''}`;
      identity.append(name, run);
      const score = document.createElement('strong');
      score.textContent = entry.score.toLocaleString();
      row.append(rank, identity, score);
      list.appendChild(row);
    }
  }

  showVipAdmin(): void {
    this.root.querySelector('#vip-screen')?.remove();
    const el = document.createElement('div');
    el.className = 'screen';
    el.id = 'vip-screen';
    el.setAttribute('aria-labelledby', 'vip-title');
    el.innerHTML = `
      <div class="vip-shell panel">
        <div class="vip-head"><div><span>Private operations</span><h1 id="vip-title">VIP Admin</h1></div><button type="button" data-act="vip-close" aria-label="Close VIP admin">×</button></div>
        <form class="vip-login">
          <label>Admin token<input type="password" autocomplete="current-password" minlength="16" required></label>
          <button type="submit" class="btn small">Unlock stats</button>
        </form>
        <div class="vip-status" role="status">Visitor identities are anonymous. Raw IP addresses are not stored.</div>
        <div class="vip-content"></div>
      </div>
    `;
    const form = el.querySelector<HTMLFormElement>('.vip-login')!;
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const input = form.querySelector<HTMLInputElement>('input')!;
      const button = form.querySelector<HTMLButtonElement>('button')!;
      button.disabled = true;
      el.querySelector<HTMLElement>('.vip-status')!.textContent = 'Authenticating…';
      this.hooks.onVipAuthenticate(input.value);
    });
    this.root.appendChild(el);
    const close = this.bindDialog(el, () => el.remove());
    el.querySelector('[data-act="vip-close"]')?.addEventListener('click', close);
    this.bindMenuNav(el);
  }

  renderVipAdmin(data: VipAdminStats | null, error?: string): void {
    const screen = this.root.querySelector<HTMLElement>('#vip-screen');
    if (!screen) return;
    const form = screen.querySelector<HTMLFormElement>('.vip-login')!;
    const input = form.querySelector<HTMLInputElement>('input')!;
    const button = form.querySelector<HTMLButtonElement>('button')!;
    const status = screen.querySelector<HTMLElement>('.vip-status')!;
    const content = screen.querySelector<HTMLElement>('.vip-content')!;
    button.disabled = false;
    if (!data) {
      status.textContent = error ?? 'VIP stats are unavailable.';
      status.classList.add('error');
      input.select();
      return;
    }
    input.value = '';
    form.hidden = true;
    status.classList.remove('error');
    status.textContent = `Authorized · ${data.summary.active24h} active during the last 24 hours`;
    content.innerHTML = '';
    const metrics = document.createElement('div');
    metrics.className = 'vip-metrics';
    for (const [label, value] of [
      ['Visitors', data.summary.visitors],
      ['Visits', data.summary.visits],
      ['Games', data.summary.games],
      ['Wins', data.summary.wins],
      ['KOs', data.summary.totalKills],
    ] as const) {
      const metric = document.createElement('div');
      const number = document.createElement('strong');
      number.textContent = value.toLocaleString();
      const name = document.createElement('span');
      name.textContent = label;
      metric.append(number, name);
      metrics.appendChild(metric);
    }
    const title = document.createElement('h2');
    title.textContent = 'Every anonymous visitor';
    const visitors = document.createElement('div');
    visitors.className = 'vip-visitors';
    for (const visitor of data.visitors) {
      const row = document.createElement('div');
      row.className = 'vip-visitor-row';
      const identity = document.createElement('span');
      const name = document.createElement('b');
      name.textContent = visitor.name;
      const id = document.createElement('small');
      id.textContent = `Visitor ${visitor.id.slice(-8).toUpperCase()} · last ${new Date(visitor.lastSeen).toLocaleString()}`;
      identity.append(name, id);
      const counts = document.createElement('span');
      counts.className = 'vip-visitor-counts';
      counts.textContent = `${visitor.visits} visits · ${visitor.games} games · ${visitor.wins} wins · ${visitor.totalKills} KOs · best ${visitor.bestScore.toLocaleString()}`;
      row.append(identity, counts);
      visitors.appendChild(row);
    }
    if (data.visitors.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'leaderboard-status';
      empty.textContent = 'No visitors recorded yet.';
      visitors.appendChild(empty);
    }
    content.append(metrics, title, visitors);
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
    if (!this.selectPreviewReady) {
      el.dataset.selectLoading = 'true';
      el.innerHTML = `
        <h1 class="screen-title">Pick Your Fighter</h1>
        <div class="select-tunnel" role="status" aria-live="polite">
          <span class="select-ball" aria-hidden="true"></span>
          <strong>Players entering the tunnel…</strong>
          <small>Preparing all four animated previews</small>
        </div>
      `;
      this.root.appendChild(el);
      void this.selectPreviewPromise.then(() => {
        if (this.root.querySelector('[data-select-loading="true"]')) this.showSelect();
      });
      return;
    }
    const cards = PLAYERS.map((p) => {
      const equipped = this.save.equippedSkin(p.id);
      const maxSpeed = 130;
      const maxHp = 130;
      const sel = p.id === this.selectedPlayer ? 'selected' : '';
      const skinSwatches = SKINS.filter((s) => s.player === p.id && this.save.ownsSkin(s.id))
        .map(
          (s) =>
            `<button type="button" role="radio" aria-checked="${s.id === equipped}" aria-label="${s.name}" class="skin-swatch ${s.id === equipped ? 'selected' : ''}" data-skin="${s.id}" data-player="${p.id}" title="${s.name}" style="background:${s.kit.shirt}"></button>`,
        )
        .join('');
      return `
      <div class="char-card ${sel}" data-player="${p.id}" role="radio" aria-checked="${p.id === this.selectedPlayer}" aria-label="Select ${p.name}" tabindex="${p.id === this.selectedPlayer ? '0' : '-1'}">
        <div class="portrait run-preview" role="img" aria-label="${p.name} running east">
          <span class="runner-sprite" style="--run-strip:url('${documentAssetUrl(`art/players/directional-v3/${p.id}/e.webp`)}')"></span>
        </div>
        <div class="name">${p.name}</div>
        <div class="nickname">#${p.number} · ${p.nickname}</div>
        <div class="stat-bars">
          <div class="stat-row"><span>Pace</span><span class="bar"><i style="width:${(p.speed / maxSpeed) * 100}%;background:var(--green)"></i></span><b>${p.speed}</b></div>
          <div class="stat-row"><span>Health</span><span class="bar"><i style="width:${(p.maxHp / maxHp) * 100}%;background:var(--red)"></i></span><b>${p.maxHp}</b></div>
          <div class="stat-row"><span>Power</span><span class="bar"><i style="width:${p.power * 70}%;background:var(--gold)"></i></span><b>${Math.round(p.power * 100)}%</b></div>
        </div>
        <div class="trait"><b style="color:${ABILITIES[p.startAbility].color}">${p.trait}:</b> ${p.traitDesc}</div>
        <div class="starts-with"><img src="${iconUrl(p.startAbility)}" alt=""><span>Starts with ${ABILITIES[p.startAbility].name}<small>${ABILITY_ROLE_LABELS[ABILITIES[p.startAbility].role]} · ${ABILITIES[p.startAbility].lane.toUpperCase()} · ${ABILITIES[p.startAbility].rangeBand.toUpperCase()} · ${abilityCadenceLabel(p.startAbility, 1)}</small></span></div>
        <div class="skin-row" role="radiogroup" aria-label="${p.name} kits">
          <button type="button" role="radio" aria-checked="${!equipped}" aria-label="Default kit" class="skin-swatch ${!equipped ? 'selected' : ''}" data-skin="" data-player="${p.id}" title="Default kit" style="background:${p.kit.shirt};border-style:${!equipped ? 'solid' : 'dashed'}"></button>
          ${skinSwatches}
        </div>
      </div>`;
    }).join('');
    el.innerHTML = `
      <h1 class="screen-title">Pick Your Fighter</h1>
      <div class="char-grid" role="radiogroup" aria-label="Playable footballers">${cards}</div>
      <div class="row">
        <button class="btn secondary" data-act="back">Back</button>
        <button class="btn" data-act="start">To Kick Off</button>
      </div>
    `;
    const selectCard = (card: Element, restoreFocus: boolean) => {
      this.selectedPlayer = (card as HTMLElement).dataset.player!;
      this.showSelect();
      if (restoreFocus) requestAnimationFrame(() => {
        this.root.querySelector<HTMLElement>(`.char-card[data-player="${this.selectedPlayer}"]`)?.focus({ preventScroll: true });
      });
    };
    el.querySelectorAll('.char-card').forEach((card) => {
      card.addEventListener('click', (ev) => {
        const target = ev.target as HTMLElement;
        if (target.classList.contains('skin-swatch')) return;
        selectCard(card, true);
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
    this.bindMenuNav(el);
  }

  /* ---------------- HUD ---------------- */

  buildHud(): void {
    this.clear();
    const el = document.createElement('div');
    el.id = 'hud';
    el.innerHTML = `
      <div id="xp-bar" role="progressbar" aria-label="Experience" aria-valuemin="0" aria-valuemax="1" aria-valuenow="0"><div id="xp-fill"></div></div>
      <div id="hud-top">
        <div class="hud-chip" id="hud-kills"><span class="lbl">KOs</span><span class="v">0</span></div>
        <div id="match-clock"><span class="clock-value">0'</span><span class="clock-phase" aria-live="polite"></span></div>
        <div class="hud-chip" id="hud-coins"><span class="lbl">Coins</span><span class="v">0</span></div>
        <div class="hud-chip" id="hud-level"><span class="lbl">Lv</span><span class="v">1</span></div>
      </div>
      <div id="boss-plate"><div class="title"></div><div class="name"></div><div class="boss-hp" role="progressbar" aria-label="Boss health" aria-valuemin="0" aria-valuemax="1" aria-valuenow="0"><i></i></div><div class="boss-hp-text"></div></div>
      <div id="banner"></div>
      <div id="hp-wrap">
        <div id="hp-label"><span>HP</span><span id="hp-text"></span></div>
        <div id="hp-bar" role="progressbar" aria-label="Player health" aria-valuemin="0" aria-valuemax="1" aria-valuenow="1"><div id="hp-fill"></div></div>
      </div>
      <div id="ability-dock"></div>
      <button id="dash-btn" type="button" hidden aria-label="Nutmeg Dash">
        <span class="dash-cooldown" aria-hidden="true"></span>
        <img src="${iconUrl('dash')}" alt="">
        <span class="dash-hint" data-key="SPACE" data-touch="DASH">SPACE</span>
        <span class="dash-charges" aria-hidden="true"></span>
      </button>
      <button id="pause-btn" aria-label="Pause">II</button>
      <div id="joystick"><div class="nub"></div></div>
    `;
    this.root.appendChild(el);
    this.hudRefs = {
      xpFill: el.querySelector<HTMLElement>('#xp-fill')!,
      xpBar: el.querySelector<HTMLElement>('#xp-bar')!,
      clock: el.querySelector<HTMLElement>('#match-clock')!,
      clockValue: el.querySelector<HTMLElement>('#match-clock .clock-value')!,
      clockPhase: el.querySelector<HTMLElement>('#match-clock .clock-phase')!,
      kills: el.querySelector<HTMLElement>('#hud-kills .v')!,
      coins: el.querySelector<HTMLElement>('#hud-coins .v')!,
      level: el.querySelector<HTMLElement>('#hud-level .v')!,
      hpFill: el.querySelector<HTMLElement>('#hp-fill')!,
      hpBar: el.querySelector<HTMLElement>('#hp-bar')!,
      hpText: el.querySelector<HTMLElement>('#hp-text')!,
      dock: el.querySelector<HTMLElement>('#ability-dock')!,
      dashButton: el.querySelector<HTMLButtonElement>('#dash-btn')!,
      dashCooldown: el.querySelector<HTMLElement>('#dash-btn .dash-cooldown')!,
      dashCharges: el.querySelector<HTMLElement>('#dash-btn .dash-charges')!,
      dashHint: el.querySelector<HTMLElement>('#dash-btn .dash-hint')!,
      bossPlate: el.querySelector<HTMLElement>('#boss-plate')!,
      bossName: el.querySelector<HTMLElement>('#boss-plate .name')!,
      bossTitle: el.querySelector<HTMLElement>('#boss-plate .title')!,
      bossHpFill: el.querySelector<HTMLElement>('#boss-plate .boss-hp i')!,
      bossHpBar: el.querySelector<HTMLElement>('#boss-plate .boss-hp')!,
      bossHpText: el.querySelector<HTMLElement>('#boss-plate .boss-hp-text')!,
      banner: el.querySelector<HTMLElement>('#banner')!,
    };
    el.querySelector('#pause-btn')!.addEventListener('click', () => this.hooks.onResume());
    const dashButton = el.querySelector<HTMLButtonElement>('#dash-btn')!;
    dashButton.addEventListener('pointerdown', (event) => {
      if (event.pointerType === 'touch') document.body.classList.add('touch');
    });
    dashButton.addEventListener('click', () => this.hooks.onDash());
  }

  updateHud(sim: Sim, bossScreen?: EntityScreenRect): void {
    const r = this.hudRefs;
    if (!r.clock) return;
    const p = sim.player;
    r.clockValue!.textContent = matchClock(sim.time);
    r.clockPhase!.textContent = sim.suddenDeath ? 'Sudden Death' : '';
    r.clock!.classList.toggle('halftime', sim.time >= 285 && sim.time < 330);
    r.clock!.classList.toggle('sudden-death', sim.suddenDeath);
    r.kills!.textContent = String(sim.kills);
    r.coins!.textContent = String(sim.coins);
    r.level!.textContent = String(p.level);
    r.xpFill!.style.width = `${Math.min(100, (p.xp / p.xpNext) * 100)}%`;
    r.xpBar!.setAttribute('aria-valuemax', String(p.xpNext));
    r.xpBar!.setAttribute('aria-valuenow', String(Math.min(p.xp, p.xpNext)));
    const hpPct = Math.max(0, (p.hp / p.maxHp) * 100);
    r.hpFill!.style.width = `${hpPct}%`;
    r.hpBar!.setAttribute('aria-valuemax', String(p.maxHp));
    r.hpBar!.setAttribute('aria-valuenow', String(Math.max(0, p.hp)));
    r.hpFill!.classList.toggle('low', hpPct < 35);
    r.hpFill!.classList.toggle('hit', p.hurtT > 0);
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
          return `<div class="ability-slot lane-${def.lane}" data-ability="${id}" title="${def.name} Lv${lvl} · ${def.lane.toUpperCase()}"><img src="${iconUrl(id as AbilityId)}" alt="${def.name}"><span class="cooldown-mask" aria-hidden="true"></span><span class="cooldown-value" aria-hidden="true"></span><span class="lvl">${lvl}</span></div>`;
        })
        .join('');
    }
    for (const slot of r.dock!.querySelectorAll<HTMLElement>('.ability-slot[data-ability]')) {
      const id = slot.dataset.ability as AbilityId;
      const def = ABILITIES[id];
      const level = p.abilities[id] ?? 0;
      const timing = sim.getAbilityTiming(id);
      const ratio = timing.duration > 0 ? Math.max(0, Math.min(1, timing.remaining / timing.duration)) : 0;
      slot.style.setProperty('--ability-cooldown', `${ratio * 360}deg`);
      slot.dataset.state = timing.active ? 'active' : timing.remaining > 0.05 ? 'cooldown' : timing.duration > 0 ? 'ready' : 'passive';
      const value = slot.querySelector<HTMLElement>('.cooldown-value');
      if (value) value.textContent = timing.remaining > 0.55 ? String(Math.ceil(timing.remaining)) : '';
      const stateLabel = timing.duration <= 0
        ? 'always active'
        : timing.active
          ? 'active now'
          : timing.remaining > 0.05
            ? `${timing.remaining.toFixed(1)}s cooldown`
            : 'ready';
      slot.title = `${def.name} Lv${level} · ${def.lane.toUpperCase()} · ${stateLabel}`;
    }
    // Nutmeg Dash is the one deliberate combat action. Its dedicated control
    // exposes readiness and both level-four charges without turning the game
    // into a twin-stick shooter.
    const dashLevel = p.abilities.dash ?? 0;
    const dashButton = r.dashButton!;
    dashButton.hidden = dashLevel <= 0;
    if (dashLevel > 0) {
      const cooldownDuration = Math.max(0.001, sim.dashCooldownDuration);
      const readyCharges = p.dashCds.filter((cooldown) => cooldown <= 0).length;
      const nextCooldown = readyCharges > 0
        ? 0
        : Math.min(...p.dashCds.filter((cooldown) => cooldown > 0));
      const cooldownRatio = Math.max(0, Math.min(1, nextCooldown / cooldownDuration));
      const phase = p.dashWindupT > 0
        ? 'windup'
        : p.dashT > 0
          ? 'active'
          : p.dashRecoveryT > 0
            ? 'recovery'
            : 'idle';
      const available = readyCharges > 0 && phase === 'idle';
      dashButton.disabled = !available;
      dashButton.dataset.phase = phase;
      dashButton.classList.toggle('ready', available);
      dashButton.style.setProperty('--dash-cooldown', `${cooldownRatio * 360}deg`);
      r.dashCharges!.innerHTML = p.dashCds
        .map((cooldown) => `<i class="${cooldown <= 0 ? 'ready' : ''}"></i>`)
        .join('');
      const stateLabel = available
        ? `${readyCharges} charge${readyCharges === 1 ? '' : 's'} ready`
        : phase !== 'idle'
          ? phase
          : `${nextCooldown.toFixed(1)} seconds`;
      dashButton.setAttribute('aria-label', `Nutmeg Dash, ${stateLabel}`);
      dashButton.title = `Nutmeg Dash · ${stateLabel}`;
    }
    // boss plate
    if (sim.bossAlive && sim.bossAlive.boss) {
      const bossId: BossId = sim.bossAlive.boss;
      r.bossPlate!.style.display = 'block';
      r.bossPlate!.classList.toggle('arriving', sim.bossIntroT > 0);
      r.bossPlate!.classList.toggle('sudden-death', sim.suddenDeath);
      r.bossName!.textContent = BOSSES[bossId].name;
      r.bossTitle!.textContent = sim.bossIntroT > 0
        ? `${BOSSES[bossId].title} · ARRIVING`
        : BOSSES[bossId].title;
      // Boss HUD scales with the actual encounter silhouette instead of using
      // one oversized fixed plate for all three bosses.
      const bossPlateWidth = 260 + (BOSSES[bossId].radius - 38) * 5;
      r.bossPlate!.style.setProperty('--boss-plate-width', `${bossPlateWidth}px`);
      // A northern giant can otherwise sit directly behind the persistent
      // plate. Bias the HUD into the opposite half only when that boss is
      // actually close to its screen-space footprint; centre remains default.
      const viewportWidth = Math.max(1, window.innerWidth);
      const plateHalf = Math.min(bossPlateWidth, viewportWidth * 0.72) / 2;
      const centredLeft = viewportWidth / 2 - plateHalf;
      const centredRight = viewportWidth / 2 + plateHalf;
      const plateRect = r.bossPlate!.getBoundingClientRect();
      const overlapsCentrePlate = bossScreen !== undefined
        && bossScreen.right > centredLeft - 14
        && bossScreen.left < centredRight + 14
        && bossScreen.bottom > plateRect.top - 8
        && bossScreen.top < plateRect.bottom + 12;
      const wideDock = viewportWidth >= 780;
      const dockPercent = wideDock ? 72 : 68;
      const plateAnchor = overlapsCentrePlate
        ? (bossScreen!.centerX <= viewportWidth / 2 ? dockPercent : 100 - dockPercent)
        : 50;
      r.bossPlate!.style.setProperty('--boss-plate-left', `${plateAnchor}%`);
      const boss = sim.bossAlive;
      r.bossHpFill!.style.width = `${Math.max(0, (boss.hp / boss.maxHp) * 100)}%`;
      r.bossHpBar!.setAttribute('aria-label', `${BOSSES[bossId].name} health`);
      r.bossHpBar!.setAttribute('aria-valuemax', String(boss.maxHp));
      r.bossHpBar!.setAttribute('aria-valuenow', String(Math.max(0, boss.hp)));
      r.bossHpText!.textContent = `${Math.ceil(boss.hp).toLocaleString()} / ${Math.ceil(boss.maxHp).toLocaleString()} HP`;
    } else {
      r.bossPlate!.style.display = 'none';
      r.bossPlate!.classList.remove('sudden-death');
      r.bossPlate!.classList.remove('arriving');
      r.bossPlate!.style.removeProperty('--boss-plate-left');
    }
  }

  banner(text: string): void {
    const b = this.hudRefs.banner;
    if (!b) return;
    b.textContent = text;
    b.classList.toggle('compact', text.length > 18);
    b.classList.remove('show');
    void (b as HTMLElement).offsetWidth; // restart animation
    b.classList.add('show');
  }

  /* ---------------- level up ---------------- */

  showLevelUp(
    options: UpgradeOption[],
    onReroll: () => { options: UpgradeOption[]; remaining: number } | null,
    mode: 'levelup' | 'boss' = 'levelup',
    remainingPicks = 0,
    initialRerolls = 0,
  ): void {
    this.draftCleanup?.();
    const existing = this.root.querySelector('#levelup-screen');
    existing?.remove();
    const bossLoot = mode === 'boss';
    let rerollsRemaining = Math.max(0, initialRerolls);
    let lastCardIndex = 0;
    const el = document.createElement('div');
    el.className = bossLoot ? 'screen boss-loot' : 'screen';
    el.id = 'levelup-screen';
    const closeDraft = () => {
      this.draftCleanup?.();
      el.remove();
    };
    const renderCards = (opts: UpgradeOption[]) => {
      const cards = opts
        .map((o, i) => {
          const isAbility = o.kind === 'ability';
          const icon = isAbility ? abilityCardArtUrl(o.id as AbilityId) : trainingCardArtUrl(o.id);
          const artClass = 'ability-art full-card-art';
          const tag = o.kind === 'ability'
            ? (o.level === 5 ? 'MAX EVOLUTION' : o.level === 1 ? 'New ability' : `Ability · Lv${o.level}`)
            : o.kind === 'stat' ? 'Training' : o.kind === 'coins' ? 'Club reward' : 'Recovery';
          // every offensive ability is lane-typed: GROUND hugs the pitch,
          // AERIAL flies over near mobs onto far high-priority threats
          const lane = o.kind === 'ability' ? ABILITIES[o.id as AbilityId].lane : null;
          const laneChip = lane ? `<span class="lane-tag lane-${lane}">${lane.toUpperCase()}</span>` : '';
          const roleChip = o.kind === 'ability'
            ? `<span class="role-tag">${ABILITY_ROLE_LABELS[ABILITIES[o.id as AbilityId].role]}</span>`
            : '';
          const comparison = o.currentLabel && o.afterLabel
            ? `<div class="uc-compare"><span><small>Current</small>${o.currentLabel}</span><i aria-hidden="true">→</i><span><small>After pick</small>${o.afterLabel}</span></div>`
            : '';
          const details = o.capLabel || o.metaLabel
            ? `<div class="uc-details">${o.capLabel ? `<span>Cap · ${o.capLabel}</span>` : ''}${o.metaLabel ? `<span>${o.metaLabel}</span>` : ''}</div>`
            : '';
          const synergy = o.synergyLabel ? `<div class="uc-synergy">${o.synergyLabel}</div>` : '';
          return `
          <button type="button" class="upgrade-card${o.kind === 'ability' && o.level === 5 ? ' max-evolution' : ''}" data-idx="${i}" style="--uc:${o.color}" aria-label="Choose ${o.name}: ${o.desc}">
            <img class="uc-art ${artClass}" src="${icon}" alt="">
            <div class="uc-tag">${tag} ${laneChip} ${roleChip}</div>
            <div class="uc-name">${o.name}</div>
            <div class="uc-desc">${o.desc}</div>
            ${comparison}${details}${synergy}
          </button>`;
        })
        .join('');
      const wrap = el.querySelector('.levelup-cards')!;
      wrap.innerHTML = cards;
      wrap.querySelectorAll<HTMLButtonElement>('.upgrade-card').forEach((c) => {
        c.addEventListener('click', () => {
          const idx = Number((c as HTMLElement).dataset.idx);
          closeDraft();
          this.hooks.onUpgradePicked(opts[idx]);
        });
        c.addEventListener('focus', () => {
          lastCardIndex = Number(c.dataset.idx) || 0;
        });
      });
      if (el.isConnected) wrap.querySelector<HTMLButtonElement>('.upgrade-card')?.focus({ preventScroll: true });
    };
    el.innerHTML = `
      <h1 class="screen-title" style="color:var(--gold)">${bossLoot ? 'Boss Loot' : 'Level Up!'}</h1>
      ${bossLoot ? `<div class="loot-subtitle">Choose an ability · ${remainingPicks} pick${remainingPicks === 1 ? '' : 's'} remaining</div>` : ''}
      <div class="levelup-cards"></div>
      <button class="btn small secondary draft-reroll" data-act="reroll" style="margin-top:6px"></button>
      <div class="controls-hint" style="margin-top:4px"><kbd>WASD</kbd> / <kbd>arrows</kbd> navigate · <kbd>Enter</kbd> chooses · <kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd> quick-pick</div>
    `;
    const rerollButton = el.querySelector<HTMLButtonElement>('[data-act="reroll"]')!;
    const updateRerollButton = () => {
      rerollButton.disabled = rerollsRemaining <= 0;
      rerollButton.textContent = rerollsRemaining > 0
        ? `${bossLoot ? 'Reroll boss loot' : 'Reroll cards'} · ${rerollsRemaining} left`
        : 'No rerolls left';
      rerollButton.setAttribute('aria-label', rerollsRemaining > 0
        ? `Reroll choices, ${rerollsRemaining} remaining this run`
        : 'No rerolls remaining this run');
    };
    rerollButton.addEventListener('click', () => {
      const result = onReroll();
      if (!result) return;
      rerollsRemaining = Math.max(0, result.remaining);
      renderCards(result.options);
      updateRerollButton();
    });
    updateRerollButton();
    renderCards(options);
    this.root.appendChild(el);
    el.querySelector<HTMLButtonElement>('.upgrade-card')?.focus({ preventScroll: true });
    const handleDraftKeydown = (event: KeyboardEvent) => {
      if (!(event instanceof KeyboardEvent)) return;
      const key = event.key.toLowerCase();
      if (!['arrowleft', 'arrowright', 'arrowup', 'arrowdown', 'w', 'a', 's', 'd', 'enter', ' '].includes(key)) return;
      const cards = [...el.querySelectorAll<HTMLButtonElement>('.upgrade-card')];
      if (cards.length === 0) return;
      const current = cards.indexOf(document.activeElement as HTMLButtonElement);
      const onRerollControl = document.activeElement === rerollButton;
      if (key === 'enter' || key === ' ') {
        if (onRerollControl && !rerollButton.disabled) rerollButton.click();
        else cards[current >= 0 ? current : Math.min(lastCardIndex, cards.length - 1)]?.click();
      } else if ((key === 'arrowdown' || key === 's') && !rerollButton.disabled) {
        rerollButton.focus({ preventScroll: true });
      } else if ((key === 'arrowup' || key === 'w') && onRerollControl) {
        cards[Math.min(lastCardIndex, cards.length - 1)]?.focus({ preventScroll: true });
      } else if (key === 'arrowleft' || key === 'a' || key === 'arrowup' || key === 'w') {
        const from = current >= 0 ? current : Math.min(lastCardIndex, cards.length - 1);
        cards[(from - 1 + cards.length) % cards.length]?.focus({ preventScroll: true });
      } else if (key === 'arrowright' || key === 'd') {
        const from = current >= 0 ? current : Math.min(lastCardIndex, cards.length - 1);
        cards[(from + 1) % cards.length]?.focus({ preventScroll: true });
      } else if ((key === 'arrowdown' || key === 's') && onRerollControl) {
        cards[Math.min(lastCardIndex, cards.length - 1)]?.focus({ preventScroll: true });
      }
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    window.addEventListener('keydown', handleDraftKeydown);
    const cleanup = () => {
      window.removeEventListener('keydown', handleDraftKeydown);
      if (this.draftCleanup === cleanup) this.draftCleanup = null;
    };
    this.draftCleanup = cleanup;
  }

  /* ---------------- pause ---------------- */

  showPause(): void {
    const el = document.createElement('div');
    el.className = 'screen';
    el.id = 'pause-screen';
    el.setAttribute('aria-labelledby', 'pause-title');
    el.innerHTML = `
      <h1 class="screen-title" id="pause-title">Half-Time Team Talk</h1>
      <div class="menu-buttons">
        <button class="btn" data-act="resume">Play On</button>
        <button class="btn secondary" data-act="restart">Restart Match</button>
        <button class="btn secondary" data-act="mute">${this.save.data.muted ? 'Unmute' : 'Mute'}</button>
        <button class="btn secondary setting-toggle" data-act="reduced-vfx" aria-pressed="${this.save.data.reducedVfx}">Reduced VFX: ${this.save.data.reducedVfx ? 'On' : 'Off'}</button>
        <button class="btn secondary setting-toggle" data-act="haptics" aria-pressed="${this.save.data.haptics}">Haptics: ${this.save.data.haptics ? 'On' : 'Off'}</button>
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
    const resume = () => this.hooks.onResume();
    el.querySelector('[data-act="resume"]')!.addEventListener('click', resume);
    el.querySelector('[data-act="restart"]')!.addEventListener('click', () => this.hooks.onRestart());
    el.querySelector('[data-act="mute"]')?.addEventListener('click', () => this.hooks.onToggleMute());
    el.querySelector('[data-act="reduced-vfx"]')?.addEventListener('click', () => this.hooks.onToggleReducedVfx());
    el.querySelector('[data-act="haptics"]')?.addEventListener('click', () => this.hooks.onToggleHaptics());
    el.querySelector('[data-act="quit"]')!.addEventListener('click', () => this.hooks.onQuitToMenu());
    this.root.appendChild(el);
    this.bindDialog(el, resume);
    this.bindMenuNav(el);
  }

  hidePause(): void {
    this.dialogCleanup?.();
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
    this.bindMenuNav(el);
  }

  /* ---------------- club (shop + skins) ---------------- */

  showClub(tab: 'upgrades' | 'skins'): void {
    this.clear();
    const el = document.createElement('div');
    el.className = 'screen';
    el.id = 'club-screen';
    const header = `
      <h1 class="screen-title">The Club</h1>
      <div class="coin-chip"><span class="dot"></span>${this.save.data.coins}</div>
      <div class="shop-tabs" role="tablist" aria-label="Club sections">
        <button id="club-tab-upgrades" role="tab" aria-controls="club-panel" aria-selected="${tab === 'upgrades'}" class="btn small ${tab === 'upgrades' ? 'active' : 'secondary'}" data-tab="upgrades">Training Ground</button>
        <button id="club-tab-skins" role="tab" aria-controls="club-panel" aria-selected="${tab === 'skins'}" class="btn small ${tab === 'skins' ? 'active' : 'secondary'}" data-tab="skins">Kit Room</button>
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
    el.innerHTML = `<div class="shop-wrap">${header}<div id="club-panel" role="tabpanel" aria-labelledby="club-tab-${tab}">${body}</div></div>
      <button class="btn secondary" data-act="back">Back</button>`;
    const tabs = [...el.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    tabs.forEach((button, index) => {
      button.tabIndex = button.getAttribute('aria-selected') === 'true' ? 0 : -1;
      button.addEventListener('click', () => this.showClub(button.dataset.tab as 'upgrades' | 'skins'));
      button.addEventListener('keydown', (event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const nextIndex = event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? tabs.length - 1
            : (index + (event.key === 'ArrowLeft' ? -1 : 1) + tabs.length) % tabs.length;
        tabs[nextIndex].click();
      });
    });
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
    this.bindMenuNav(el);
  }
}
