import type { Colony, MissionType } from '../sim/colony';
import type { CrewMember } from '../sim/types';
import { MISSION_CREW, GATHER_FOOD_AMOUNT, GATHER_ORE_AMOUNT } from '../sim/config';

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

type ZoneKey = number | 'explore' | null;

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

  let openZone: ZoneKey = null; // expanded zone (or 'explore')
  let openMission: MissionType | null = null; // expanded mission within the open zone
  const selected = new Set<number>();
  let activeSig = '';
  let zoneSig = '';
  const fills = new Map<number, { fill: HTMLElement; left: HTMLElement }>();

  function rewardText(type: MissionType): string {
    if (type === 'explore') return colony.zonesRemaining ? 'Discover a new zone' : 'Region fully explored';
    if (type === 'gatherFood') return `+${GATHER_FOOD_AMOUNT} food`;
    return `+${GATHER_ORE_AMOUNT} ore`;
  }

  function autoFillTeam() {
    selected.clear();
    for (const c of colony.availableCrew) {
      if (selected.size >= MISSION_CREW) break;
      selected.add(c.id);
    }
  }

  function toggleZone(key: ZoneKey, explore = false) {
    if (openZone === key) {
      openZone = null;
      openMission = null;
    } else {
      openZone = key;
      openMission = explore ? 'explore' : null;
      if (explore) autoFillTeam();
    }
    renderZones();
  }
  function toggleMission(type: MissionType) {
    if (openMission === type) openMission = null;
    else {
      openMission = type;
      autoFillTeam();
    }
    renderZones();
  }

  function setupBodyHTML(type: MissionType): string {
    const dur = Math.ceil(colony.missionDuration(type));
    const team = colony.crew.filter((c) => selected.has(c.id));
    const rows = team.map((c) => crewRowHTML(c, true)).join('');
    const short = selected.size < MISSION_CREW;
    return `
      <div class="setup-pick">Away team — <b>${selected.size}/${MISSION_CREW}</b>${short ? ' · not enough crew available' : ' · tap a member to swap'}</div>
      <div class="mcrew-list">${rows || '<div class="empty">No crew available.</div>'}</div>
      <div class="setup-foot">
        <span class="setup-preview">~${dur}s · Risk Low · ${rewardText(type)}</span>
        <button class="setup-launch">Launch</button>
      </div>`;
  }

  function missionSubHTML(type: MissionType): string {
    const open = openMission === type;
    return `<div class="msub${open ? ' open' : ''}" data-mt="${type}">
      <div class="msub-head clickable">
        <span class="msym msub-icon">${ICON[type]}</span>
        <span class="msub-name">${LABEL[type]}</span>
        <span class="avail-reward">${rewardText(type)}</span>
        <span class="msym zrow-chev">${open ? 'expand_less' : 'expand_more'}</span>
      </div>
      ${open ? `<div class="msub-body">${setupBodyHTML(type)}</div>` : ''}</div>`;
  }

  function renderZones() {
    zoneList.innerHTML = '';

    for (const z of colony.zones) {
      const zoneOpen = openZone === z.id;
      const row = document.createElement('div');
      row.className = `zrow${z.home ? ' home' : ''}${zoneOpen ? ' open' : ''}`;
      const tag = z.home ? '<span class="zone-tag">HUB</span>' : '';
      const body = zoneOpen
        ? `<div class="zrow-body">${GATHER_TYPES.map(missionSubHTML).join('')}</div>`
        : '';
      row.innerHTML = `
        <div class="zrow-head clickable">
          <span class="msym zrow-icon">${z.home ? 'hub' : 'place'}</span>
          <span class="zrow-name"><b>${z.name}</b> <span class="mission-desc">${z.kind}</span></span>
          ${tag}<span class="msym zrow-chev">${zoneOpen ? 'expand_less' : 'expand_more'}</span>
        </div>${body}`;
      row.querySelector('.zrow-head')!.addEventListener('click', () => toggleZone(z.id));
      if (zoneOpen) {
        row.querySelectorAll('.msub').forEach((sub) => {
          const t = (sub as HTMLElement).dataset.mt as MissionType;
          sub.querySelector('.msub-head')!.addEventListener('click', () => toggleMission(t));
        });
      }
      zoneList.appendChild(row);
    }

    // Explore row at the bottom (expands straight to its setup)
    const exploreOpen = openZone === 'explore';
    const canExplore = colony.zonesRemaining;
    const erow = document.createElement('div');
    erow.className = `zrow explore${exploreOpen ? ' open' : ''}`;
    erow.innerHTML = `
      <div class="zrow-head${canExplore ? ' clickable' : ''}">
        <span class="msym zrow-icon">travel_explore</span>
        <span class="zrow-name"><b>Explore</b> <span class="mission-desc">${canExplore ? 'Chart a new zone' : 'Region fully explored'}</span></span>
        ${canExplore ? `<span class="msym zrow-chev">${exploreOpen ? 'expand_less' : 'expand_more'}</span>` : ''}
      </div>
      ${exploreOpen ? `<div class="zrow-body">${setupBodyHTML('explore')}</div>` : ''}`;
    if (canExplore) erow.querySelector('.zrow-head')!.addEventListener('click', () => toggleZone('explore', true));
    zoneList.appendChild(erow);

    wireSetup();
  }

  function wireSetup() {
    if (openZone === null || openMission === null) return;
    zoneList.querySelectorAll('.mcrew-row.selectable').forEach((r) =>
      r.addEventListener('click', () => {
        const id = Number((r as HTMLElement).dataset.crew);
        const alt = colony.availableCrew.find((c) => !selected.has(c.id));
        if (alt) {
          selected.delete(id);
          selected.add(alt.id);
          renderZones();
        }
      }),
    );
    const launch = zoneList.querySelector('.setup-launch') as HTMLButtonElement | null;
    if (launch) {
      launch.disabled = selected.size !== MISSION_CREW;
      launch.addEventListener('click', () => {
        const zoneId = openZone === 'explore' ? null : (openZone as number);
        colony.launchMission(openMission!, zoneId, [...selected]);
        openZone = null;
        openMission = null;
        selected.clear();
        renderZones();
      });
    }
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
            .map((c) => crewRowHTML(c as CrewMember, false))
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
  }

  return { el, update };
}

function statsHTML(c: CrewMember): string {
  return STATS.map(
    (s) =>
      `<span class="cstat"><span class="cstat-l">${s.label}</span><span class="cbar"><span class="cbarf" style="width:${c.stats[s.key] * 10}%"></span></span></span>`,
  ).join('');
}

function crewRowHTML(c: CrewMember, selectable: boolean): string {
  const tail = selectable ? '<span class="mcrew-pick">Swap</span>' : '';
  return `<div class="mcrew-row${selectable ? ' selectable' : ''}" data-crew="${c.id}">
    <span class="crew-av">${c.name[0]}</span>
    <span class="crew-name">${c.name}</span>
    <span class="crew-stats">${statsHTML(c)}</span>
    ${tail}</div>`;
}
