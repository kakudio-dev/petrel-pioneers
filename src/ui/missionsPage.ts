import type { Colony } from '../sim/colony';
import type { CrewTask } from '../sim/types';
import { ORE_GATHER_RATE, FOOD_GATHER_RATE } from '../sim/config';

interface Mission {
  task: CrewTask;
  label: string;
  icon: string;
  desc: string;
  rate: number; // per-crew yield/s (0 for stubs)
  unit: string;
  stub?: boolean;
}

const MISSIONS: Mission[] = [
  { task: 'gatherOre', label: 'Gather Ore', icon: 'terrain', desc: 'Mine surface deposits beyond the base.', rate: ORE_GATHER_RATE, unit: 'ore' },
  { task: 'gatherFood', label: 'Gather Food', icon: 'grass', desc: 'Forage the frozen wastes for anything edible.', rate: FOOD_GATHER_RATE, unit: 'food' },
  { task: 'expand', label: 'Expand Base', icon: 'explore', desc: 'Survey and claim new ground for the colony.', rate: 0, unit: '', stub: true },
];

interface MissionRow {
  count: HTMLElement;
  out: HTMLElement;
  inc: HTMLButtonElement;
  dec: HTMLButtonElement;
}

// Missions page — deploy crew (drawn from the building pool) onto missions, and
// recall them. A per-mission counterpart to the Crew page's per-person dropdowns.
export function createMissionsPage(colony: Colony) {
  const el = document.createElement('div');
  el.className = 'page';
  el.innerHTML = `
    <div class="panel">
      <h2>Missions <span class="mission-summary"></span></h2>
      <div class="mission-list"></div>
    </div>`;

  const summary = el.querySelector('.mission-summary') as HTMLElement;
  const list = el.querySelector('.mission-list') as HTMLElement;
  const rows = new Map<CrewTask, MissionRow>();

  for (const m of MISSIONS) {
    const row = document.createElement('div');
    row.className = 'mission-row';
    row.innerHTML = `
      <span class="msym mission-icon">${m.icon}</span>
      <span class="mission-info"><b>${m.label}</b><span class="mission-desc">${m.desc}</span></span>
      <span class="mission-out"></span>
      <span class="mission-assign">
        <button class="m-dec" title="recall">−</button>
        <span class="m-count">0</span>
        <button class="m-inc" title="deploy">+</button>
      </span>`;
    const inc = row.querySelector('.m-inc') as HTMLButtonElement;
    const dec = row.querySelector('.m-dec') as HTMLButtonElement;
    inc.addEventListener('click', () => colony.assignCrewTo(m.task));
    dec.addEventListener('click', () => colony.unassignCrewFrom(m.task));
    rows.set(m.task, {
      count: row.querySelector('.m-count') as HTMLElement,
      out: row.querySelector('.mission-out') as HTMLElement,
      inc,
      dec,
    });
    list.appendChild(row);
  }

  function update() {
    summary.textContent = `· ${colony.deployableCrew} crew available to deploy`;
    for (const m of MISSIONS) {
      const r = rows.get(m.task)!;
      const n = colony.crewOnTask(m.task);
      r.count.textContent = String(n);
      r.out.textContent = m.stub ? 'planned' : `+${(n * m.rate).toFixed(1)} ${m.unit}/s`;
      r.out.classList.toggle('muted', m.stub || n === 0);
      r.dec.disabled = m.stub || n === 0;
      r.inc.disabled = m.stub || colony.deployableCrew === 0;
    }
  }

  return { el, update };
}
