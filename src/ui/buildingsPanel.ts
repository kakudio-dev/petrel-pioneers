import type { Colony } from '../sim/colony';
import type { BuildingType } from '../sim/types';
import { BUILD_COST, BUILD_TIME, CREW_REQ, EXPAND_SLOTS } from '../sim/config';
import { fmt } from './format';

const TYPES: BuildingType[] = ['generator', 'extractor', 'greenhouse', 'habitat'];
const TYPE_LABEL: Record<BuildingType, string> = {
  command: 'Command Module',
  generator: 'Generator',
  extractor: 'Extractor',
  greenhouse: 'Greenhouse',
  habitat: 'Habitat',
};
const TYPE_EFFECT: Record<BuildingType, string> = {
  command: '+15 E/s · +12 cap · 200 larder',
  generator: '+10 E/s · +40 battery',
  extractor: '+8 Fe/s · −4 E/s',
  greenhouse: '+6 food/s · −5 E/s',
  habitat: '+5 cap · −2 E/s',
};

// Buildings / construction panel (spec §6C). Demolish is essential: space is fixed,
// so resolving a bottleneck often means tearing something down to fit what you need.
// Construction and deconstruction both take time and show a progress bar.
export function createBuildingsPanel(colony: Colony) {
  const el = document.createElement('div');
  el.className = 'panel buildings';
  el.innerHTML = `
    <h2>Buildings & Construction</h2>
    <div class="build-actions"></div>
    <div class="blist"></div>`;

  const actions = el.querySelector('.build-actions') as HTMLElement;
  const blist = el.querySelector('.blist') as HTMLElement;

  for (const t of TYPES) {
    const b = document.createElement('button');
    b.dataset.type = t;
    b.innerHTML = `<span>${TYPE_LABEL[t]}</span><span class="cost">${BUILD_COST[t]} Fe · ${BUILD_TIME[t]}s · ${TYPE_EFFECT[t]}</span>`;
    b.addEventListener('click', () => colony.build(t));
    actions.appendChild(b);
  }
  const expandBtn = document.createElement('button');
  expandBtn.className = 'expand';
  expandBtn.addEventListener('click', () => colony.expand());
  actions.appendChild(expandBtn);

  function update() {
    const free = colony.freeSlots;
    actions.querySelectorAll('button[data-type]').forEach((node) => {
      (node as HTMLButtonElement).disabled = free <= 0;
    });
    expandBtn.innerHTML = `<span>Expand +${EXPAND_SLOTS} slots</span><span class="cost">${fmt(colony.expandCost)} Fe</span>`;
    expandBtn.disabled = colony.iron < colony.expandCost;

    blist.innerHTML = '';
    if (colony.buildings.length === 0) {
      blist.innerHTML = '<div class="empty">No structures.</div>';
      return;
    }

    for (const b of colony.buildings) {
      const isCore = b.type === 'command';
      const pct = Math.round(b.progress * 100);
      const row = document.createElement('div');

      if (b.state === 'building') {
        row.className = 'brow building';
        row.innerHTML = `
          <span class="dot ${b.type}"></span>
          <span><b>${TYPE_LABEL[b.type]}</b> <span class="meta">building · ${BUILD_COST[b.type]} Fe over ${BUILD_TIME[b.type]}s</span></span>
          <span class="status building">${pct}%</span>
          <button class="kill">Cancel</button>
          <div class="bprogress"><div class="fill build" style="width:${pct}%"></div></div>`;
        row.querySelector('.kill')!.addEventListener('click', () => colony.cancel(b.id));
      } else if (b.state === 'demolishing') {
        row.className = 'brow demolishing';
        row.innerHTML = `
          <span class="dot ${b.type}"></span>
          <span><b>${TYPE_LABEL[b.type]}</b> <span class="meta">demolishing · refunds ${Math.round(BUILD_COST[b.type] * 0.5)} Fe</span></span>
          <span class="status demolishing">${pct}%</span>
          <button class="kill">Cancel</button>
          <div class="bprogress"><div class="fill demolish" style="width:${pct}%"></div></div>`;
        row.querySelector('.kill')!.addEventListener('click', () => colony.cancel(b.id));
      } else {
        const status = colony.staffStatus(b);
        const req = CREW_REQ[b.type];
        const staffed = `${Math.round(b.staffing * 100)}% staffed`;
        let meta: string;
        if (isCore) meta = 'core · +15 E/s · +12 cap · larder, no food';
        else if (b.type === 'generator') meta = `${staffed} · +10 E/s · needs ${req} crew`;
        else if (b.type === 'extractor') meta = `${staffed} · −4 E/s · needs ${req} crew`;
        else if (b.type === 'greenhouse') meta = `${staffed} · +6 food/s · −5 E/s · needs ${req} crew`;
        else meta = `−2 E/s · +${b.capacity} cap`;
        row.className = isCore ? 'brow core' : 'brow';
        row.innerHTML = `
          <span class="dot ${b.type}"></span>
          <span><b>${TYPE_LABEL[b.type]}</b> <span class="meta">${meta}</span></span>
          <span class="status ${status}">${status}</span>
          ${isCore ? '<span class="locked">locked</span>' : '<button class="kill">Demolish</button>'}`;
        if (!isCore) {
          row.querySelector('.kill')!.addEventListener('click', () => colony.demolish(b.id));
        }
      }
      blist.appendChild(row);
    }
  }

  return { el, update };
}
