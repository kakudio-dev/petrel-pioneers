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

interface Setup {
  zoneId: number | null;
  type: MissionType | null;
  selected: Set<number>;
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
      <h2>Zones <span class="zone-count"></span> <button class="explore-btn">Explore</button></h2>
      <div class="zone-grid"></div>
    </div>
    <div class="panel setup-panel hidden">
      <h2 class="setup-title"></h2>
      <div class="setup-body"></div>
    </div>`;

  const activeCount = el.querySelector('.active-count') as HTMLElement;
  const activeList = el.querySelector('.active-list') as HTMLElement;
  const zoneCount = el.querySelector('.zone-count') as HTMLElement;
  const zoneGrid = el.querySelector('.zone-grid') as HTMLElement;
  const exploreBtn = el.querySelector('.explore-btn') as HTMLButtonElement;
  const setupPanel = el.querySelector('.setup-panel') as HTMLElement;
  const setupTitle = el.querySelector('.setup-title') as HTMLElement;
  const setupBody = el.querySelector('.setup-body') as HTMLElement;

  let setup: Setup | null = null;
  let activeSig = '';
  let zoneSig = '';
  const fills = new Map<number, { fill: HTMLElement; left: HTMLElement }>();

  exploreBtn.addEventListener('click', () => {
    setup = { zoneId: null, type: 'explore', selected: new Set() };
    renderSetup();
  });

  // ---- Setup (event-driven render; never rebuilt per frame so clicks survive) ----
  function rewardText(type: MissionType): string {
    if (type === 'explore') return colony.zonesRemaining ? 'Discover a new zone' : 'Region fully explored';
    if (type === 'gatherFood') return `+${GATHER_FOOD_AMOUNT} food`;
    return `+${GATHER_ORE_AMOUNT} ore`;
  }

  function renderSetup() {
    if (!setup) {
      setupPanel.classList.add('hidden');
      return;
    }
    setupPanel.classList.remove('hidden');
    const zone = colony.zones.find((z) => z.id === setup!.zoneId);
    setupTitle.textContent = setup.type === 'explore' ? 'Explore — find a new zone' : `New mission · ${zone?.name ?? ''}`;

    if (setup.zoneId !== null && !setup.type) {
      // choose a mission type for this zone
      setupBody.innerHTML = `<div class="setup-types"><span class="setup-label">Choose a mission:</span>
        <button data-mt="gatherFood">Gather Food</button>
        <button data-mt="gatherResources">Gather Resources</button></div>`;
      setupBody.querySelectorAll('button[data-mt]').forEach((b) =>
        b.addEventListener('click', () => {
          setup!.type = (b as HTMLElement).dataset.mt as MissionType;
          renderSetup();
        }),
      );
      return;
    }

    const type = setup.type!;
    const dur = Math.ceil(colony.missionDuration(type));
    const sel = setup.selected;
    const rows = colony.availableCrew
      .map((c) => crewRowHTML(c, sel.has(c.id), true))
      .join('');
    setupBody.innerHTML = `
      <div class="setup-pick">Assign crew — <b>${sel.size}/${MISSION_CREW}</b></div>
      <div class="mcrew-list">${rows || '<div class="empty">No crew available.</div>'}</div>
      <div class="setup-foot">
        <span class="setup-preview">~${dur}s · Risk Low · ${rewardText(type)}</span>
        <button class="setup-launch">Launch</button>
        <button class="setup-cancel">Cancel</button>
      </div>`;
    setupBody.querySelectorAll('.mcrew-row').forEach((r) =>
      r.addEventListener('click', () => {
        const id = Number((r as HTMLElement).dataset.crew);
        if (sel.has(id)) sel.delete(id);
        else if (sel.size < MISSION_CREW) sel.add(id);
        renderSetup();
      }),
    );
    const launch = setupBody.querySelector('.setup-launch') as HTMLButtonElement;
    launch.disabled = sel.size !== MISSION_CREW;
    launch.addEventListener('click', () => {
      colony.launchMission(type, setup!.zoneId, [...sel]);
      setup = null;
      renderSetup();
    });
    (setupBody.querySelector('.setup-cancel') as HTMLButtonElement).addEventListener('click', () => {
      setup = null;
      renderSetup();
    });
  }

  // ---- Per-frame update: active missions + zones + explore button ----
  function update() {
    exploreBtn.disabled = !colony.zonesRemaining || colony.availableCrew.length < MISSION_CREW;

    // active missions (rebuild only when the set changes; update progress each frame)
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
            .map((c) => crewRowHTML(c as CrewMember, false, false))
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

    // zones
    zoneCount.textContent = `(${colony.zones.length})`;
    const zsig = colony.zones.map((z) => z.id).join(',');
    if (zsig !== zoneSig) {
      zoneSig = zsig;
      zoneGrid.innerHTML = '';
      for (const z of colony.zones) {
        const card = document.createElement('div');
        card.className = `zone${z.home ? ' home' : ' clickable'}`;
        card.innerHTML = `<b>${z.name}</b><span class="zone-kind">${z.kind}</span>${z.home ? '<span class="zone-tag">HUB</span>' : ''}`;
        if (!z.home) {
          card.addEventListener('click', () => {
            setup = { zoneId: z.id, type: null, selected: new Set() };
            renderSetup();
          });
        }
        zoneGrid.appendChild(card);
      }
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

function crewRowHTML(c: CrewMember, selected: boolean, selectable: boolean): string {
  const tail = selectable
    ? `<span class="mcrew-pick">${selected ? '✓ Assigned' : 'Assign'}</span>`
    : '';
  return `<div class="mcrew-row${selectable ? ' selectable' : ''}${selected ? ' selected' : ''}" data-crew="${c.id}">
    <span class="crew-av">${c.name[0]}</span>
    <span class="crew-name">${c.name}</span>
    <span class="crew-stats">${statsHTML(c)}</span>
    ${tail}</div>`;
}
