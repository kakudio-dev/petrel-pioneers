import type { Colony, MissionType } from '../sim/colony';

interface MissionDef {
  type: MissionType | 'expand';
  label: string;
  icon: string;
  desc: string;
  reward: (colony: Colony) => string;
  stub?: boolean;
}

const MISSIONS: MissionDef[] = [
  {
    type: 'explore',
    label: 'Explore',
    icon: 'travel_explore',
    desc: 'Scout the surrounding region to discover new zones.',
    reward: (c) => (c.zonesRemaining ? 'Discover a new zone' : 'Region fully explored'),
  },
  {
    type: 'gatherFood',
    label: 'Gather Food',
    icon: 'grass',
    desc: 'Send a team to forage the wastes for food.',
    reward: (c) => `+${c.crewOnTask('gatherFood') * 25} food`, // FOOD_BATCH = 25
  },
  {
    type: 'expand',
    label: 'Expand Base',
    icon: 'explore',
    desc: 'Survey and claim new ground for the colony.',
    reward: () => 'Planned',
    stub: true,
  },
];

interface Card {
  def: MissionDef;
  prepare: HTMLButtonElement;
  expand: HTMLElement;
  team: HTMLElement;
  previewRow: HTMLElement;
  stat: HTMLElement;
  inc: HTMLButtonElement;
  dec: HTMLButtonElement;
  launch: HTMLButtonElement;
  cancel: HTMLButtonElement;
  activeRow: HTMLElement;
  fill: HTMLElement;
  left: HTMLElement;
  teamSig: string;
}

// Missions page — Prepare assembles a team (and expands to show who's going),
// preview it, then Launch runs the expedition on a timer.
export function createMissionsPage(colony: Colony) {
  const el = document.createElement('div');
  el.className = 'page';
  el.innerHTML = `
    <div class="panel">
      <h2>Missions <span class="mission-summary"></span></h2>
      <div class="mission-list"></div>
    </div>
    <div class="panel zones-panel">
      <h2>Zones <span class="zone-count"></span></h2>
      <div class="zone-list"></div>
    </div>`;

  const summary = el.querySelector('.mission-summary') as HTMLElement;
  const list = el.querySelector('.mission-list') as HTMLElement;
  const zoneCount = el.querySelector('.zone-count') as HTMLElement;
  const zoneList = el.querySelector('.zone-list') as HTMLElement;
  const cards: Card[] = [];

  for (const def of MISSIONS) {
    const card = document.createElement('div');
    card.className = 'mission-card';
    card.innerHTML = `
      <div class="mission-head">
        <span class="msym mission-icon">${def.icon}</span>
        <div class="mission-info"><b>${def.label}</b><span class="mission-desc">${def.desc}</span></div>
        <button class="m-prepare">Prepare</button>
      </div>
      <div class="m-expand">
        <div class="m-team"></div>
        <div class="m-preview-row">
          <span class="m-stat"></span>
          <span class="m-adjust"><button class="m-dec">−</button><button class="m-inc">+</button></span>
          <button class="m-launch">Launch</button>
          <button class="m-cancel">Cancel</button>
        </div>
        <div class="m-active-row">
          <span class="m-prog"><span class="m-fill"></span></span>
          <span class="m-left"></span>
          <button class="m-recall">Recall</button>
        </div>
      </div>`;
    list.appendChild(card);

    const q = <T extends HTMLElement>(s: string) => card.querySelector(s) as T;
    const c: Card = {
      def,
      prepare: q('.m-prepare'),
      expand: q('.m-expand'),
      team: q('.m-team'),
      previewRow: q('.m-preview-row'),
      stat: q('.m-stat'),
      inc: q('.m-inc'),
      dec: q('.m-dec'),
      launch: q('.m-launch'),
      cancel: q('.m-cancel'),
      activeRow: q('.m-active-row'),
      fill: q('.m-fill'),
      left: q('.m-left'),
      teamSig: '',
    };
    if (!def.stub) {
      const t = def.type as MissionType;
      c.prepare.addEventListener('click', () => colony.prepareMission(t));
      c.inc.addEventListener('click', () => colony.assignCrewTo(t));
      c.dec.addEventListener('click', () => colony.unassignCrewFrom(t));
      c.launch.addEventListener('click', () => colony.launchMission(t));
      c.cancel.addEventListener('click', () => colony.cancelMission(t));
      q<HTMLButtonElement>('.m-recall').addEventListener('click', () => colony.cancelMission(t));
    } else {
      c.prepare.disabled = true;
      c.prepare.textContent = 'Planned';
      c.expand.classList.add('hidden');
    }
    cards.push(c);
  }

  let zoneShown = -1;

  function update() {
    summary.textContent = `· ${colony.deployableCrew} crew available`;

    for (const c of cards) {
      if (c.def.stub) continue;
      const t = c.def.type as MissionType;
      const team = colony.crew.filter((cm) => cm.task === t);
      const m = colony.missions[t];
      const prepared = team.length > 0 && !m.active;

      c.prepare.classList.toggle('hidden', team.length > 0 || m.active);
      c.prepare.disabled = colony.deployableCrew === 0;
      c.expand.classList.toggle('hidden', team.length === 0 && !m.active);
      c.previewRow.classList.toggle('hidden', !prepared);
      c.activeRow.classList.toggle('hidden', !m.active);

      // team roster (rebuild only when the membership changes)
      const sig = team.map((cm) => cm.id).join(',');
      if (sig !== c.teamSig) {
        c.teamSig = sig;
        c.team.innerHTML = team
          .map((cm) => `<span class="team-chip"><span class="team-av">${cm.name[0]}</span>${cm.name}</span>`)
          .join('');
      }

      if (prepared) {
        const dur = Math.ceil(colony.missionDuration(t));
        c.stat.textContent = `~${dur}s · Risk Low · ${c.def.reward(colony)}`;
        c.inc.disabled = colony.deployableCrew === 0;
        c.dec.disabled = team.length === 0;
      }
      if (m.active) {
        const dur = colony.missionDuration(t);
        c.fill.style.width = `${Math.min(100, (m.elapsed / dur) * 100)}%`;
        c.left.textContent = `${Math.ceil(dur - m.elapsed)}s left`;
      }
    }

    // zones — the home (command hub) zone is always present and badged
    zoneCount.textContent = `(${colony.zones.length})`;
    if (colony.zones.length !== zoneShown) {
      zoneShown = colony.zones.length;
      zoneList.innerHTML = colony.zones
        .map(
          (z) =>
            `<div class="zone${z.home ? ' home' : ''}"><b>${z.name}</b><span class="zone-kind">${z.kind}</span>${z.home ? '<span class="zone-tag">HUB</span>' : ''}</div>`,
        )
        .join('');
    }
  }

  return { el, update };
}
