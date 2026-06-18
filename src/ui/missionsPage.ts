import type { Colony, MissionType } from '../sim/colony';
import type { CrewMember } from '../sim/types';

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
const GATHER_TYPES: MissionType[] = ['gatherFood', 'gatherResources'];
const STATS: { key: keyof CrewMember['stats']; label: string }[] = [
  { key: 'vigor', label: 'VIG' },
  { key: 'tech', label: 'TEC' },
  { key: 'grit', label: 'GRT' },
];

export function createMissionsPage(colony: Colony) {
  const el = document.createElement('div');
  el.className = 'page';
  el.innerHTML = `
    <div class="panel">
      <h2>Active Missions <span class="active-count"></span></h2>
      <div class="active-list"></div>
    </div>
    <div class="panel">
      <h2>Zones <span class="zone-count"></span></h2>
      <div class="zone-list"></div>
    </div>`;

  const activeCount = el.querySelector('.active-count') as HTMLElement;
  const activeList = el.querySelector('.active-list') as HTMLElement;
  const zoneCount = el.querySelector('.zone-count') as HTMLElement;
  const zoneList = el.querySelector('.zone-list') as HTMLElement;

  const openZones = new Set<number>(); // expanded zone ids (multiple allowed)
  const teams = new Map<string, Set<number>>(); // open mission setup -> staged crew
  let activeSig = '';
  let zoneSig = '';
  const fills = new Map<number, { fill: HTMLElement; left: HTMLElement }>();

  function rewardText(type: MissionType, zoneId: number | null, crew: number): string {
    if (type === 'explore') return colony.zonesRemaining ? 'Discover a new zone' : 'Region fully explored';
    if (type === 'gatherFood') return `+${colony.missionYield('gatherFood', zoneId, crew)} food`;
    return `+${colony.missionYield('gatherResources', zoneId, crew)} ore`;
  }

  // Crew may be staged in multiple pending setups at once; they only become
  // exclusive when a mission is actually launched. A setup opens with a single
  // crew member assigned — the player adds or removes more with the stepper.
  function autoFill(key: string) {
    const t = new Set<number>();
    const first = colony.availableCrew[0];
    if (first) t.add(first.id);
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

  function setupHTML(key: string, type: MissionType, zoneId: number | null): string {
    const t = teams.get(key) ?? new Set<number>();
    const team = colony.crew.filter((c) => t.has(c.id));
    const rows = team.map((c) => crewRowHTML(c, true)).join('');
    // can add another if any crew is neither away on a mission nor already on this team
    const canAdd = colony.crew.some((c) => !colony.onMission(c.id) && !t.has(c.id));
    const addRow = canAdd
      ? '<button class="crew-add"><span class="msym">person_add</span> Add crew</button>'
      : '';
    const dur = Math.ceil(colony.missionDuration(type));
    return `<div class="setup" data-key="${key}" data-mt="${type}" data-zone="${zoneId ?? 'x'}">
      <div class="mcrew-list">${rows}${addRow || (rows ? '' : '<div class="empty">No crew available.</div>')}</div>
      <div class="setup-foot">
        <span class="setup-preview">~${dur}s · Risk Low · ${rewardText(type, zoneId, t.size)}</span>
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
        <span class="msub-name">${LABEL[type]}</span>
        <span class="avail-reward">${rewardText(type, zoneId, 1)}</span>
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

    wireSetups();
  }

  function wireSetups() {
    zoneList.querySelectorAll('.setup').forEach((setupEl) => {
      const key = (setupEl as HTMLElement).dataset.key!;
      const type = (setupEl as HTMLElement).dataset.mt as MissionType;
      const zraw = (setupEl as HTMLElement).dataset.zone!;
      const zoneId = zraw === 'x' ? null : Number(zraw);
      const team = teams.get(key);
      if (!team) return;

      setupEl.querySelectorAll('.crew-remove').forEach((btn) =>
        btn.addEventListener('click', () => {
          team.delete(Number((btn as HTMLElement).dataset.crew));
          renderZones();
        }),
      );
      const addBtn = setupEl.querySelector('.crew-add');
      if (addBtn)
        addBtn.addEventListener('click', () => {
          const add = colony.availableCrew.find((c) => !team.has(c.id));
          if (add) team.add(add.id);
          renderZones();
        });
      const launch = setupEl.querySelector('.setup-launch') as HTMLButtonElement;
      launch.disabled = team.size < 1;
      launch.addEventListener('click', () => {
        const committed = [...team];
        if (committed.length === 0) return;
        colony.launchMission(type, zoneId, committed);
        teams.delete(key);
        // committed crew are now busy — drop them from any other pending teams
        for (const [, t] of teams) for (const id of committed) t.delete(id);
        renderZones();
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
          const team = m.crewIds
            .map((id) => colony.crew.find((c) => c.id === id))
            .filter(Boolean)
            .map((c) => crewRowHTML(c as CrewMember))
            .join('');
          const card = document.createElement('div');
          card.className = 'amission';
          card.innerHTML = `
            <div class="amission-head">
              <span class="msym mission-icon">${ICON[m.type]}</span>
              <span class="amission-name"><b>${LABEL[m.type]}</b> <span class="mission-desc">${zone ? zone.name : 'Uncharted region'}</span></span>
              <span class="m-prog"><span class="m-fill"></span></span>
              <span class="m-left"></span>
              <button class="m-recall">Recall</button>
            </div>
            <div class="mcrew-list">${team}</div>`;
          card.querySelector('.m-recall')!.addEventListener('click', () => colony.recallMission(m.id));
          activeList.appendChild(card);
          fills.set(m.id, {
            fill: card.querySelector('.m-fill') as HTMLElement,
            left: card.querySelector('.m-left') as HTMLElement,
          });
        }
      }
    }
    for (const m of colony.activeMissions) {
      const r = fills.get(m.id);
      if (r) {
        r.fill.style.width = `${Math.min(100, (m.elapsed / m.duration) * 100)}%`;
        r.left.textContent = `${Math.ceil(m.duration - m.elapsed)}s`;
      }
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
  }

  return { el, update };
}

function statsHTML(c: CrewMember): string {
  return STATS.map(
    (s) =>
      `<span class="cstat"><span class="cstat-l">${s.label}</span><span class="cbar"><span class="cbarf" style="width:${c.stats[s.key] * 10}%"></span></span></span>`,
  ).join('');
}

function crewRowHTML(c: CrewMember, removable = false): string {
  const tail = removable
    ? `<button class="crew-remove" data-crew="${c.id}" title="Remove"><span class="msym">close</span></button>`
    : '';
  return `<div class="mcrew-row" data-crew="${c.id}">
    <span class="crew-av">${c.name[0]}</span>
    <span class="crew-name">${c.name}</span>
    <span class="crew-stats">${statsHTML(c)}</span>
    ${tail}</div>`;
}
