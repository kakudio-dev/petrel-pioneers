import type { Colony, CompletedMission, MissionType } from '../sim/colony';
import type { CrewMember } from '../sim/types';
import type { SkillId } from '../sim/types';
import { healthColor, secs } from './format';
import { xpToNext } from '../sim/skills';
import { SKILLS } from '../sim/config';

const LABEL: Record<MissionType, string> = {
  explore: 'Explore',
  gatherFood: 'Gather Food',
  gatherResources: 'Gather Resources',
};
const ICON: Record<MissionType, string> = {
  explore: 'travel_explore',
  gatherFood: 'grass',
  gatherResources: 'terrain',
};
const DESC: Record<MissionType, string> = {
  explore: 'Chart a new zone',
  gatherFood: 'Forage this zone for food',
  gatherResources: 'Mine this zone for ore',
};
const GATHER_TYPES: MissionType[] = ['gatherFood', 'gatherResources'];

export function createMissionsPage(colony: Colony) {
  const el = document.createElement('div');
  el.className = 'page';
  el.innerHTML = `
    <div class="panel">
      <h2>Active Missions <span class="active-count"></span></h2>
      <div class="active-list"></div>
    </div>
    <div class="panel">
      <h2>Recent Missions</h2>
      <div class="recent-list"><div class="empty">No completed missions yet.</div></div>
    </div>
    <div class="panel">
      <h2>Zones <span class="zone-count"></span></h2>
      <div class="zone-list"></div>
    </div>`;

  const activeCount = el.querySelector('.active-count') as HTMLElement;
  const activeList = el.querySelector('.active-list') as HTMLElement;
  const zoneCount = el.querySelector('.zone-count') as HTMLElement;
  const zoneList = el.querySelector('.zone-list') as HTMLElement;
  const recentList = el.querySelector('.recent-list') as HTMLElement;

  const openZones = new Set<number>(); // expanded zone ids (multiple allowed)
  const home = colony.zones.find((z) => z.home); // expand the home zone (The Roost) by default
  if (home) openZones.add(home.id);
  const openMissions = new Set<number>(); // active missions expanded to show their crew
  const teams = new Map<string, Set<number>>(); // open mission setup -> staged crew
  let activeSig = '';
  let zoneSig = '';
  let recentSig = '';
  const fills = new Map<number, { fill: HTMLElement; left: HTMLElement; phase: HTMLElement }>();

  // Pre-launch preview: what the party would bring back and roughly how long a round trip takes.
  function previewText(type: MissionType, zoneId: number | null, crewIds: number[]): string {
    if (type === 'explore')
      return colony.zonesRemaining ? `Discover a new zone · ~${secs(colony.estimateRunSeconds(type, zoneId, crewIds))}` : 'Region fully explored';
    const unit = type === 'gatherFood' ? 'food' : 'ore';
    const cap = colony.partyCapacity(crewIds);
    return `holds ${cap} ${unit} · ~${secs(colony.estimateRunSeconds(type, zoneId, crewIds))} round trip`;
  }

  // Crew may be staged in multiple pending setups at once; they only become
  // exclusive when a mission is actually launched. A setup opens with `count` free
  // crew assigned by default — the player adds or removes more.
  function autoFill(key: string, count = 1) {
    const t = new Set<number>();
    for (const c of colony.availableCrew) {
      if (t.size >= Math.max(1, count)) break;
      t.add(c.id);
    }
    teams.set(key, t);
  }

  function toggleZone(id: number) {
    if (openZones.has(id)) {
      openZones.delete(id);
      for (const k of [...teams.keys()]) if (k.startsWith(`${id}:`)) teams.delete(k);
    } else {
      openZones.add(id);
    }
    renderZones();
  }
  function toggleMission(key: string) {
    if (teams.has(key)) teams.delete(key);
    else autoFill(key);
    renderZones();
  }

  // Launch a mission and clear the committed crew from any other pending setups.
  function commitLaunch(type: MissionType, zoneId: number | null, crewIds: number[]) {
    if (crewIds.length === 0) return;
    colony.launchMission(type, zoneId, crewIds);
    for (const [, t] of teams) for (const id of crewIds) t.delete(id);
    renderZones();
  }

  // Can a logged mission be re-run right now? (crew free, and zones left for explore)
  function canRerun(m: CompletedMission): boolean {
    if (m.type === 'explore' && !colony.zonesRemaining) return false;
    return colony.availableCrew.length > 0;
  }

  // The replay button expands the recent mission into the same planning widget used to
  // create it, pre-filled with the original crew count.
  function toggleRecent(m: CompletedMission) {
    const key = `recent:${m.id}`;
    if (teams.has(key)) teams.delete(key);
    else {
      if (!canRerun(m)) return;
      autoFill(key, m.crew);
    }
    renderRecent();
  }

  function setupHTML(key: string, type: MissionType, zoneId: number | null): string {
    const t = teams.get(key) ?? new Set<number>();
    const team = colony.crew.filter((c) => t.has(c.id));
    const skill = colony.missionSkill(type);
    const rows = team.map((c) => crewRowHTML(c, true, skill)).join('');
    // can add another if any crew is neither away on a mission nor already on this team
    const canAdd = colony.crew.some((c) => !colony.onMission(c.id) && !t.has(c.id));
    const addRow = canAdd
      ? '<button class="crew-add"><span class="msym">person_add</span> Add crew</button>'
      : '';
    return `<div class="setup" data-key="${key}" data-mt="${type}" data-zone="${zoneId ?? 'x'}">
      <div class="mcrew-list">${rows}${addRow || (rows ? '' : '<div class="empty">No crew available.</div>')}</div>
      <div class="setup-foot">
        <span class="setup-preview">${previewText(type, zoneId, [...t])}</span>
        <button class="setup-launch">Launch</button>
      </div>
    </div>`;
  }

  function geoHTML(z: { fertility: number; oreRichness: number }): string {
    return `<div class="zgeo">
      <span class="zgeo-item"><span class="msym">eco</span> Fertility <b>${Math.round(z.fertility * 100)}</b></span>
      <span class="zgeo-item"><span class="msym">diamond</span> Ore richness <b>${Math.round(z.oreRichness * 100)}</b></span>
    </div>`;
  }

  function missionSubHTML(zoneId: number, type: MissionType): string {
    const key = `${zoneId}:${type}`;
    const open = teams.has(key);
    return `<div class="msub${open ? ' open' : ''}">
      <div class="msub-head clickable" data-key="${key}">
        <span class="msym msub-icon">${ICON[type]}</span>
        <span class="msub-name"><b>${LABEL[type]}</b> <span class="mission-desc">${DESC[type]}</span></span>
        <span class="msym zrow-chev">${open ? 'expand_less' : 'expand_more'}</span>
      </div>
      ${open ? `<div class="msub-body">${setupHTML(key, type, zoneId)}</div>` : ''}</div>`;
  }

  function renderZones() {
    zoneList.innerHTML = '';

    for (const z of colony.zones) {
      const zoneOpen = openZones.has(z.id);
      const row = document.createElement('div');
      row.className = `zrow${z.home ? ' home' : ''}${zoneOpen ? ' open' : ''}`;
      const tag = z.home ? '<span class="zone-tag">HUB</span>' : '';
      const body = zoneOpen
        ? `<div class="zrow-body">${geoHTML(z)}${GATHER_TYPES.map((t) => missionSubHTML(z.id, t)).join('')}</div>`
        : '';
      row.innerHTML = `
        <div class="zrow-head clickable">
          <span class="msym zrow-icon">${z.home ? 'hub' : 'place'}</span>
          <span class="zrow-name"><b>${z.name}</b> <span class="mission-desc">${z.kind}</span></span>
          <span class="zstats">
            <span class="zstat" title="Food abundance"><span class="msym">grass</span> <span data-zfood="${z.id}">${Math.round(z.foodAbundance)}</span></span>
            <span class="zstat" title="Resource abundance"><span class="msym">terrain</span> <span data-zres="${z.id}">${Math.round(z.resourceAbundance)}</span></span>
          </span>
          ${tag}<span class="msym zrow-chev">${zoneOpen ? 'expand_less' : 'expand_more'}</span>
        </div>${body}`;
      row.querySelector('.zrow-head')!.addEventListener('click', () => toggleZone(z.id));
      if (zoneOpen) {
        row.querySelectorAll('.msub-head').forEach((h) =>
          h.addEventListener('click', () => toggleMission((h as HTMLElement).dataset.key!)),
        );
      }
      zoneList.appendChild(row);
    }

    // Explore row at the bottom (its own setup; no target zone)
    const exploreOpen = teams.has('explore');
    const canExplore = colony.zonesRemaining;
    const erow = document.createElement('div');
    erow.className = `zrow explore${exploreOpen ? ' open' : ''}`;
    erow.innerHTML = `
      <div class="zrow-head${canExplore ? ' clickable' : ''}">
        <span class="msym zrow-icon">travel_explore</span>
        <span class="zrow-name"><b>Explore</b> <span class="mission-desc">${canExplore ? 'Chart a new zone' : 'Region fully explored'}</span></span>
        ${canExplore ? `<span class="msym zrow-chev">${exploreOpen ? 'expand_less' : 'expand_more'}</span>` : ''}
      </div>
      ${exploreOpen ? `<div class="zrow-body">${setupHTML('explore', 'explore', null)}</div>` : ''}`;
    if (canExplore) erow.querySelector('.zrow-head')!.addEventListener('click', () => toggleMission('explore'));
    zoneList.appendChild(erow);

    wireSetups(zoneList, renderZones);
  }

  function wireSetups(container: HTMLElement, rerender: () => void) {
    container.querySelectorAll('.setup').forEach((setupEl) => {
      const key = (setupEl as HTMLElement).dataset.key!;
      const type = (setupEl as HTMLElement).dataset.mt as MissionType;
      const zraw = (setupEl as HTMLElement).dataset.zone!;
      const zoneId = zraw === 'x' ? null : Number(zraw);
      const team = teams.get(key);
      if (!team) return;

      setupEl.querySelectorAll('.crew-remove').forEach((btn) =>
        btn.addEventListener('click', () => {
          team.delete(Number((btn as HTMLElement).dataset.crew));
          rerender();
        }),
      );
      const addBtn = setupEl.querySelector('.crew-add');
      if (addBtn)
        addBtn.addEventListener('click', () => {
          const add = colony.availableCrew.find((c) => !team.has(c.id));
          if (add) team.add(add.id);
          rerender();
        });
      const launch = setupEl.querySelector('.setup-launch') as HTMLButtonElement;
      launch.disabled = team.size < 1;
      launch.addEventListener('click', () => {
        const committed = [...team];
        if (committed.length === 0) return;
        teams.delete(key);
        commitLaunch(type, zoneId, committed);
        rerender();
      });
    });
  }

  function update() {
    // active missions
    activeCount.textContent = `(${colony.activeMissions.length})`;
    const sig = colony.activeMissions.map((m) => m.id).join(',');
    if (sig !== activeSig) {
      activeSig = sig;
      fills.clear();
      if (colony.activeMissions.length === 0) {
        activeList.innerHTML = '<div class="empty">No active missions.</div>';
      } else {
        activeList.innerHTML = '';
        for (const m of colony.activeMissions) {
          const zone = colony.zones.find((z) => z.id === m.zoneId);
          const skill = colony.missionSkill(m.type);
          const team = m.crewIds
            .map((id) => colony.crew.find((c) => c.id === id))
            .filter(Boolean)
            .map((c) => crewRowHTML(c as CrewMember, false, skill))
            .join('');
          const open = openMissions.has(m.id);
          const card = document.createElement('div');
          card.className = `amission${open ? ' open' : ''}`;
          card.innerHTML = `
            <div class="amission-head clickable">
              <span class="msym mission-icon">${ICON[m.type]}</span>
              <span class="amission-name"><b>${LABEL[m.type]}</b> <span class="mission-desc">${zone ? zone.name : 'Uncharted region'}</span></span>
              <span class="m-phase"></span>
              <span class="m-prog"><span class="m-fill"></span></span>
              <span class="m-left"></span>
              <button class="m-recall">Recall</button>
              <span class="msym m-chev">${open ? 'expand_less' : 'expand_more'}</span>
            </div>
            <div class="mcrew-list">${team}</div>`;
          const recall = card.querySelector('.m-recall') as HTMLElement;
          recall.addEventListener('click', (e) => {
            e.stopPropagation();
            colony.recallMission(m.id);
          });
          const chev = card.querySelector('.m-chev') as HTMLElement;
          card.querySelector('.amission-head')!.addEventListener('click', () => {
            const nowOpen = !openMissions.has(m.id);
            if (nowOpen) openMissions.add(m.id);
            else openMissions.delete(m.id);
            card.classList.toggle('open', nowOpen);
            chev.textContent = nowOpen ? 'expand_less' : 'expand_more';
          });
          activeList.appendChild(card);
          fills.set(m.id, {
            fill: card.querySelector('.m-fill') as HTMLElement,
            left: card.querySelector('.m-left') as HTMLElement,
            phase: card.querySelector('.m-phase') as HTMLElement,
          });
        }
      }
    }
    for (const m of colony.activeMissions) {
      const r = fills.get(m.id);
      if (!r) continue;
      const unit = m.type === 'gatherFood' ? 'food' : 'ore';
      let progress = 1;
      let phaseText = '';
      if (m.phase === 'outbound') {
        progress = m.travelTime > 0 ? m.phaseElapsed / m.travelTime : 1;
        phaseText = m.type === 'explore' ? 'Scouting' : 'Traveling out';
      } else if (m.phase === 'gathering') {
        const cap = colony.partyCapacity(m.crewIds);
        progress = cap > 0 ? m.cargo / cap : 1;
        phaseText = `Gathering · ${Math.floor(m.cargo)}/${cap} ${unit}`;
      } else {
        progress = m.returnTime > 0 ? m.phaseElapsed / m.returnTime : 1;
        phaseText =
          m.type === 'explore' ? 'Returning' : `Returning · ${Math.round(m.cargo)} ${unit}`;
      }
      r.fill.style.width = `${Math.min(100, progress * 100)}%`;
      r.phase.textContent = phaseText;
      r.left.textContent = `~${secs(colony.missionEta(m))}`;
    }

    // zones (re-render on zone or mission-set change; keeps crew availability fresh)
    zoneCount.textContent = `(${colony.zones.length})`;
    const zsig = colony.zones.map((z) => z.id).join(',') + '|' + sig;
    if (zsig !== zoneSig) {
      zoneSig = zsig;
      renderZones();
    }
    // live-update abundance % without rebuilding rows (so clicks survive)
    for (const z of colony.zones) {
      const f = zoneList.querySelector(`[data-zfood="${z.id}"]`);
      const r = zoneList.querySelector(`[data-zres="${z.id}"]`);
      if (f) f.textContent = `${Math.round(z.foodAbundance)}`;
      if (r) r.textContent = `${Math.round(z.resourceAbundance)}`;
    }

    // recent completed missions — re-render when the log OR re-run availability changes
    const rsig =
      colony.completedMissions.map((m) => m.id).join(',') +
      `|${colony.availableCrew.length}|${colony.zonesRemaining}`;
    if (rsig !== recentSig) {
      recentSig = rsig;
      renderRecent();
    }
    updateRerunForecasts(); // keep re-run forecasts fresh as seasons/abundance drift
    updateCrewStats(); // keep HP + Explorer level/XP on setup/active crew rows live
  }

  // Live-fill HP and the Explorer level/XP bar on every mission crew row.
  function updateCrewStats() {
    el.querySelectorAll('.mcrew-row[data-crew]').forEach((row) => {
      const c = colony.crew.find((x) => x.id === Number((row as HTMLElement).dataset.crew));
      if (!c) return;
      const fill = row.querySelector('.cbarf.hp') as HTMLElement | null;
      const pct = row.querySelector('.hp-pct') as HTMLElement | null;
      if (fill && pct) {
        const hp = Math.round(c.health);
        fill.style.width = `${hp}%`;
        fill.style.background = healthColor(c.health);
        pct.textContent = `${hp}%`;
      }
      const skillEl = row.querySelector('.mcrew-skill') as HTMLElement | null;
      const lv = skillEl?.querySelector('.skill-lv') as HTMLElement | null;
      const xpFill = skillEl?.querySelector('.cbarf.xpf') as HTMLElement | null;
      if (skillEl && lv && xpFill) {
        const skillId = skillEl.dataset.skill as SkillId;
        const sk = c.skills[skillId];
        lv.textContent = `L${sk.level}`;
        xpFill.style.width = `${(sk.xp / xpToNext(skillId, sk.level)) * 100}%`;
      }
    });
  }

  function renderRecent() {
    const log = colony.completedMissions;
    if (!log.length) {
      recentList.innerHTML = '<div class="empty">No completed missions yet.</div>';
      return;
    }
    recentList.innerHTML = log
      .map((m) => {
        const key = `recent:${m.id}`;
        const open = teams.has(key);
        const setup = open ? `<div class="recent-setup">${setupHTML(key, m.type, m.zoneId)}</div>` : '';
        return `<div class="recent-item${open ? ' open' : ''}">${recentRowHTML(m, canRerun(m), open)}${setup}</div>`;
      })
      .join('');
    recentList.querySelectorAll('.recent-rerun').forEach((btn) =>
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const m = colony.completedMissions.find((x) => x.id === Number((btn as HTMLElement).dataset.mid));
        if (m) toggleRecent(m);
      }),
    );
    wireSetups(recentList, renderRecent);
    updateRerunForecasts();
    updateCrewStats();
  }

  // Live: the hold size and round-trip time a re-run would have, using the crew it would
  // actually take (up to the original count, from those free now).
  function updateRerunForecasts() {
    for (const m of colony.completedMissions) {
      if (m.type === 'explore') continue;
      const span = recentList.querySelector(`[data-again="${m.id}"]`);
      if (!span) continue;
      const ids = colony.availableCrew.slice(0, Math.max(1, m.crew)).map((c) => c.id);
      if (ids.length === 0) {
        span.textContent = 'repeat —';
        continue;
      }
      const unit = m.type === 'gatherFood' ? 'food' : 'ore';
      span.textContent = `repeat ${colony.partyCapacity(ids)} ${unit} · ~${secs(colony.estimateRunSeconds(m.type, m.zoneId, ids))}`;
    }
  }

  return { el, update };
}

function recentRowHTML(m: CompletedMission, rerunnable: boolean, open: boolean): string {
  let sub: string;
  let got: string;
  // collapsed-only: `recent-again` shows the live re-run forecast (hidden while expanded)
  const again = m.type === 'explore' || open ? '' : `<span class="recent-again" data-again="${m.id}"></span>`;
  if (m.type === 'explore') {
    sub = `${m.crew} crew`;
    got = m.zoneName ? `Discovered ${m.zoneName}` : 'Region explored';
  } else {
    sub = `${m.zoneName} · ${m.crew} crew`;
    got = m.type === 'gatherFood' ? `+${m.amount} food` : `+${m.amount} ore`;
  }
  return `<div class="recent-row">
    <span class="msym recent-icon">${ICON[m.type]}</span>
    <span class="recent-main"><b>${LABEL[m.type]}</b> <span class="mission-desc">${sub}</span></span>
    <span class="recent-result"><span class="recent-got">${got}</span>${again}</span>
    <button class="recent-rerun${open ? ' open' : ''}" data-mid="${m.id}"${rerunnable ? '' : ' disabled'} title="Run again"><span class="msym">${open ? 'expand_less' : 'replay'}</span></button>
  </div>`;
}

function crewRowHTML(c: CrewMember, removable = false, skillId: SkillId = 'explorer'): string {
  const tail = removable
    ? `<button class="crew-remove" data-crew="${c.id}" title="Remove"><span class="msym">close</span></button>`
    : '';
  const skill = SKILLS[skillId];
  return `<div class="mcrew-row" data-crew="${c.id}">
    <span class="crew-av">${c.name[0]}</span>
    <span class="crew-name">${c.name}</span>
    <span class="mcrew-skill" data-skill="${skillId}" title="${skill.name}"><span class="msym skill-icon">${skill.icon}</span><span class="skill-lv"></span><span class="cbar xp"><span class="cbarf xpf"></span></span></span>
    <span class="mcrew-hp"><span class="cbar"><span class="cbarf hp"></span></span><span class="hp-pct"></span></span>
    ${tail}</div>`;
}
