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
  preview: HTMLElement;
  team: HTMLElement;
  stat: HTMLElement;
  inc: HTMLButtonElement;
  dec: HTMLButtonElement;
  launch: HTMLButtonElement;
  cancel: HTMLButtonElement;
  activeBox: HTMLElement;
  fill: HTMLElement;
  left: HTMLElement;
  recall: HTMLButtonElement;
}

// Missions page — prepare an expedition (auto-pull a team), preview it, then launch.
export function createMissionsPage(colony: Colony) {
  const el = document.createElement('div');
  el.className = 'page';
  el.innerHTML = `
    <div class="panel">
      <h2>Missions <span class="mission-summary"></span></h2>
      <div class="mission-list"></div>
    </div>
    <div class="panel zones-panel">
      <h2>Discovered Zones <span class="zone-count"></span></h2>
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
      </div>
      <div class="mission-body">
        <button class="m-prepare">Prepare</button>
        <div class="m-preview">
          <span class="m-team"></span>
          <span class="m-adjust"><button class="m-dec">−</button><button class="m-inc">+</button></span>
          <span class="m-stat"></span>
          <span class="m-acts"><button class="m-launch">Launch</button><button class="m-cancel">Cancel</button></span>
        </div>
        <div class="m-active">
          <span class="m-prog"><span class="m-fill"></span></span>
          <span class="m-left"></span>
          <button class="m-recall">Recall</button>
        </div>
      </div>`;
    list.appendChild(card);

    const c: Card = {
      def,
      prepare: card.querySelector('.m-prepare') as HTMLButtonElement,
      preview: card.querySelector('.m-preview') as HTMLElement,
      team: card.querySelector('.m-team') as HTMLElement,
      stat: card.querySelector('.m-stat') as HTMLElement,
      inc: card.querySelector('.m-inc') as HTMLButtonElement,
      dec: card.querySelector('.m-dec') as HTMLButtonElement,
      launch: card.querySelector('.m-launch') as HTMLButtonElement,
      cancel: card.querySelector('.m-cancel') as HTMLButtonElement,
      activeBox: card.querySelector('.m-active') as HTMLElement,
      fill: card.querySelector('.m-fill') as HTMLElement,
      left: card.querySelector('.m-left') as HTMLElement,
      recall: card.querySelector('.m-recall') as HTMLButtonElement,
    };
    if (!def.stub) {
      const t = def.type as MissionType;
      c.prepare.addEventListener('click', () => colony.prepareMission(t));
      c.inc.addEventListener('click', () => colony.assignCrewTo(t));
      c.dec.addEventListener('click', () => colony.unassignCrewFrom(t));
      c.launch.addEventListener('click', () => colony.launchMission(t));
      c.cancel.addEventListener('click', () => colony.cancelMission(t));
      c.recall.addEventListener('click', () => colony.cancelMission(t));
    } else {
      c.prepare.disabled = true;
      c.prepare.textContent = 'Planned';
      c.preview.classList.add('hidden');
      c.activeBox.classList.add('hidden');
    }
    cards.push(c);
  }

  let zoneShown = -1;

  function update() {
    summary.textContent = `· ${colony.deployableCrew} crew available`;

    for (const c of cards) {
      if (c.def.stub) continue;
      const t = c.def.type as MissionType;
      const team = colony.crewOnTask(t);
      const m = colony.missions[t];
      const prepared = team > 0 && !m.active;

      c.prepare.classList.toggle('hidden', team > 0 || m.active);
      c.preview.classList.toggle('hidden', !prepared);
      c.activeBox.classList.toggle('hidden', !m.active);
      c.prepare.disabled = colony.deployableCrew === 0;

      if (prepared) {
        const dur = Math.ceil(colony.missionDuration(t));
        c.team.textContent = `Team ${team}`;
        c.stat.textContent = `~${dur}s · Risk Low · ${c.def.reward(colony)}`;
        c.inc.disabled = colony.deployableCrew === 0;
        c.dec.disabled = team === 0;
        c.launch.disabled = team === 0;
      }
      if (m.active) {
        const dur = colony.missionDuration(t);
        c.fill.style.width = `${Math.min(100, (m.elapsed / dur) * 100)}%`;
        c.left.textContent = `${Math.ceil(dur - m.elapsed)}s left · Team ${team}`;
      }
    }

    // zones
    zoneCount.textContent = `(${colony.zones.length})`;
    if (colony.zones.length !== zoneShown) {
      zoneShown = colony.zones.length;
      if (colony.zones.length === 0) {
        zoneList.innerHTML = '<div class="empty">No zones discovered yet — run an Explore mission.</div>';
      } else {
        zoneList.innerHTML = colony.zones
          .map((z) => `<div class="zone"><b>${z.name}</b><span class="zone-kind">${z.kind}</span></div>`)
          .join('');
      }
    }
  }

  return { el, update };
}
