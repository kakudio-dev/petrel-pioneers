import type { Colony } from '../sim/colony';
import type { Building, BuildingType } from '../sim/types';
import { BUILD_COST, BUILD_TIME, CREW_REQ, EXPAND_SLOTS, REFUND_FRACTION } from '../sim/config';
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
  command: '+15 E/s · +6 cap · 200 larder',
  generator: '+10 E/s · +40 battery',
  extractor: '+8 Fe/s · −4 E/s',
  greenhouse: '+6 food/s · −5 E/s',
  habitat: '+5 cap · −2 E/s',
};

interface Row {
  el: HTMLElement;
  state: string; // structural signature (type + lifecycle state); rebuild when it changes
  status: HTMLElement;
  meta: HTMLElement;
  fill: HTMLElement | null;
}

// Buildings / construction panel (spec §6C). Rows are reconciled in place (persistent
// DOM nodes keyed by building id) rather than rebuilt every frame — otherwise the
// Demolish/Cancel buttons get recreated mid-click and the click is lost.
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

  const rows = new Map<number, Row>();

  function update() {
    const free = colony.freeSlots;
    actions.querySelectorAll('button[data-type]').forEach((node) => {
      (node as HTMLButtonElement).disabled = free <= 0;
    });
    expandBtn.innerHTML = `<span>Expand +${EXPAND_SLOTS} slots</span><span class="cost">${fmt(colony.expandCost)} Fe</span>`;
    expandBtn.disabled = colony.iron < colony.expandCost;

    const present = new Set<number>();
    for (const b of colony.buildings) {
      present.add(b.id);
      let row = rows.get(b.id);
      if (!row || row.state !== b.state) {
        const built = createRow(colony, b);
        if (row) row.el.replaceWith(built.el);
        row = built;
        rows.set(b.id, row);
      }
      updateRow(colony, row, b);
      blist.appendChild(row.el); // re-append in order (moves the node, listeners survive)
    }
    for (const [id, row] of rows) {
      if (!present.has(id)) {
        row.el.remove();
        rows.delete(id);
      }
    }
  }

  return { el, update };
}

function createRow(colony: Colony, b: Building): Row {
  const el = document.createElement('div');
  const dot = `<span class="dot ${b.type}"></span>`;

  if (b.state === 'building') {
    el.className = 'brow building';
    el.innerHTML = `
      ${dot}
      <span><b>${TYPE_LABEL[b.type]}</b> <span class="meta">building · ${BUILD_COST[b.type]} Fe over ${BUILD_TIME[b.type]}s</span></span>
      <span class="status building">0%</span>
      <button class="kill">Cancel</button>
      <div class="bprogress"><div class="fill build" style="width:0%"></div></div>`;
    el.querySelector('.kill')!.addEventListener('click', () => colony.cancel(b.id));
  } else if (b.state === 'demolishing') {
    el.className = 'brow demolishing';
    el.innerHTML = `
      ${dot}
      <span><b>${TYPE_LABEL[b.type]}</b> <span class="meta">demolishing · refunds ${Math.round(BUILD_COST[b.type] * REFUND_FRACTION)} Fe</span></span>
      <span class="status demolishing">0%</span>
      <button class="kill">Cancel</button>
      <div class="bprogress"><div class="fill demolish" style="width:0%"></div></div>`;
    el.querySelector('.kill')!.addEventListener('click', () => colony.cancel(b.id));
  } else {
    const isCore = b.type === 'command';
    el.className = isCore ? 'brow core' : 'brow';
    el.innerHTML = `
      ${dot}
      <span><b>${TYPE_LABEL[b.type]}</b> <span class="meta"></span></span>
      <span class="status"></span>
      ${isCore ? '<span class="locked">locked</span>' : '<button class="kill">Demolish</button>'}`;
    if (!isCore) {
      el.querySelector('.kill')!.addEventListener('click', () => colony.demolish(b.id));
    }
  }

  return {
    el,
    state: b.state,
    status: el.querySelector('.status') as HTMLElement,
    meta: el.querySelector('.meta') as HTMLElement,
    fill: el.querySelector('.fill') as HTMLElement | null,
  };
}

function updateRow(colony: Colony, row: Row, b: Building): void {
  if (b.state === 'building' || b.state === 'demolishing') {
    const pct = Math.round(b.progress * 100);
    row.status.textContent = `${pct}%`;
    if (row.fill) row.fill.style.width = `${pct}%`;
    return;
  }
  // active
  const status = colony.staffStatus(b);
  row.status.className = `status ${status}`;
  row.status.textContent = status;
  const req = CREW_REQ[b.type];
  const staffed = `${Math.round(b.staffing * 100)}% staffed`;
  if (b.type === 'command') row.meta.textContent = 'core · +15 E/s · +6 cap · larder, no food';
  else if (b.type === 'generator') row.meta.textContent = `${staffed} · +10 E/s · needs ${req} crew`;
  else if (b.type === 'extractor') row.meta.textContent = `${staffed} · −4 E/s · needs ${req} crew`;
  else if (b.type === 'greenhouse') row.meta.textContent = `${staffed} · +6 food/s · −5 E/s · needs ${req} crew`;
  else row.meta.textContent = `−2 E/s · +${b.capacity} cap`;
}
