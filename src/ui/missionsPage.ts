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
const STATS: { key: keyof CrewMember['stats']; label: string }[] = [
  { key: 'vigor', label: 'VIG' },
  { key: 'tech', label: 'TEC' },
  { key: 'grit', label: 'GRT' },
];

interface Entry {
  key: string;
  type: MissionType;
  zoneId: number | null;
  sub: string; // zone name, or explore tagline
}

export function createMissionsPage(colony: Colony) {
  const el = document.createElement('div');
  el.className = 'page';
  el.innerHTML = `
    <div class="panel">
      <h2>Active Missions <span class="active-count"></span></h2>
      <div class="active-list"></div>
    </div>
    <div class="panel">
      <h2>Available Missions</h2>
      <div class="avail-list"></div>
    </div>
    <div class="panel">
      <h2>Zones <span class="zone-count"></span></h2>
      <div class="zone-ref"></div>
    </div>`;

  const activeCount = el.querySelector('.active-count') as HTMLElement;
  const activeList = el.querySelector('.active-list') as HTMLElement;
  const availList = el.querySelector('.avail-list') as HTMLElement;
  const zoneCount = el.querySelector('.zone-count') as HTMLElement;
  const zoneRef = el.querySelector('.zone-ref') as HTMLElement;

  let openKey: string | null = null;
  let openType: MissionType = 'explore';
  let openZoneId: number | null = null;
  const selected = new Set<number>();
  let activeSig = '';
  let availSig = '';
  let zoneSig = '';
  const fills = new Map<number, { fill: HTMLElement; left: HTMLElement }>();

  function rewardText(type: MissionType): string {
    if (type === 'explore') return colony.zonesRemaining ? 'Discover a new zone' : 'Region fully explored';
    if (type === 'gatherFood') return `+${GATHER_FOOD_AMOUNT} food`;
    return `+${GATHER_ORE_AMOUNT} ore`;
  }

  function entries(): Entry[] {
    const list: Entry[] = [];
    for (const z of colony.zones) {
      list.push({ key: `gf:${z.id}`, type: 'gatherFood', zoneId: z.id, sub: z.name });
      list.push({ key: `gr:${z.id}`, type: 'gatherResources', zoneId: z.id, sub: z.name });
    }
    if (colony.zonesRemaining) list.push({ key: 'explore', type: 'explore', zoneId: null, sub: 'Chart a new zone' });
    return list;
  }

  function autoFillTeam() {
    selected.clear();
    for (const c of colony.availableCrew) {
      if (selected.size >= MISSION_CREW) break;
      selected.add(c.id);
    }
  }

  function openMission(e: Entry) {
    if (openKey === e.key) {
      openKey = null;
    } else {
      openKey = e.key;
      openType = e.type;
      openZoneId = e.zoneId;
      autoFillTeam();
    }
    renderAvailable();
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

  function renderAvailable() {
    availList.innerHTML = '';
    for (const e of entries()) {
      const isOpen = openKey === e.key;
      const row = document.createElement('div');
      row.className = `zrow${isOpen ? ' open' : ''}`;
      row.innerHTML = `
        <div class="zrow-head clickable">
          <span class="msym zrow-icon">${ICON[e.type]}</span>
          <span class="zrow-name"><b>${LABEL[e.type]}</b> <span class="mission-desc">${e.sub}</span></span>
          <span class="avail-reward">${rewardText(e.type)}</span>
          <span class="msym zrow-chev">${isOpen ? 'expand_less' : 'expand_more'}</span>
        </div>
        ${isOpen ? `<div class="zrow-body">${setupBodyHTML(e.type)}</div>` : ''}`;
      row.querySelector('.zrow-head')!.addEventListener('click', () => openMission(e));
      availList.appendChild(row);
    }
    wireSetup();
  }

  function wireSetup() {
    if (openKey === null) return;
    availList.querySelectorAll('.zrow.open .mcrew-row').forEach((r) =>
      r.addEventListener('click', () => {
        const id = Number((r as HTMLElement).dataset.crew);
        const alt = colony.availableCrew.find((c) => !selected.has(c.id));
        if (alt) {
          selected.delete(id);
          selected.add(alt.id);
          renderAvailable();
        }
      }),
    );
    const launch = availList.querySelector('.zrow.open .setup-launch') as HTMLButtonElement | null;
    if (launch) {
      launch.disabled = selected.size !== MISSION_CREW;
      launch.addEventListener('click', () => {
        colony.launchMission(openType, openZoneId, [...selected]);
        openKey = null;
        selected.clear();
        renderAvailable();
      });
    }
  }

  function update() {
    // active missions (rebuild on set change; progress each frame)
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

    // available missions — rebuild when zones or active set change (keeps crew fresh)
    const asig = colony.zones.map((z) => z.id).join(',') + '|' + sig;
    if (asig !== availSig) {
      availSig = asig;
      renderAvailable();
    }

    // zones reference list
    zoneCount.textContent = `(${colony.zones.length})`;
    const zsig = colony.zones.map((z) => z.id).join(',');
    if (zsig !== zoneSig) {
      zoneSig = zsig;
      zoneRef.innerHTML = colony.zones
        .map(
          (z) =>
            `<div class="zref${z.home ? ' home' : ''}"><span class="msym zrow-icon">${z.home ? 'hub' : 'place'}</span><span class="zrow-name"><b>${z.name}</b> <span class="mission-desc">${z.kind}</span></span>${z.home ? '<span class="zone-tag">HUB</span>' : ''}</div>`,
        )
        .join('');
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
