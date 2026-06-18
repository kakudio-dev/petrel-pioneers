import type { Colony } from '../sim/colony';
import type { Building, BuildingType } from '../sim/types';
import {
  BUILD_COST,
  BUILD_TIME,
  CREW_REQ,
  ENERGY_DRAW,
  ENERGY_PRODUCTION,
  EXPAND_SLOTS,
  REFUND_FRACTION,
} from '../sim/config';
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
  command: '',
  generator: '+10 E/s · +40 battery',
  extractor: '+8 ore/s · −4 E/s',
  greenhouse: '+6 food/s · −5 E/s',
  habitat: '+5 cap · −2 E/s',
};

interface Row {
  el: HTMLElement;
  state: string;
  status: HTMLElement;
  fill: HTMLElement | null; // construction/deconstruction progress
  pwrBlocks: HTMLElement[]; // one per unit of power draw
  crewBlocks: HTMLElement[]; // one per crew required
  up: HTMLButtonElement | null;
  down: HTMLButtonElement | null;
}

// Buildings panel. The list order IS the power/worker priority order — reorder with
// ▲▼. Rows are reconciled in place (never re-appended per frame, which would cancel
// clicks); the DOM is only reordered on the frame after an actual move.
export function createBuildingsPanel(colony: Colony) {
  const el = document.createElement('div');
  el.className = 'panel buildings';
  el.innerHTML = `
    <h2>Buildings &amp; Power</h2>
    <div class="powerbar">
      <span class="pb-label"><span class="msym">bolt</span> Power</span>
      <span class="pb-nums"></span>
      <span class="pb-track"><span class="pb-fill"></span></span>
      <span class="pb-powered"></span>
    </div>
    <div class="popbar">
      <span class="pb-label"><span class="msym">groups</span> Population</span>
      <span class="pb-nums"></span>
      <span class="blocks pop"></span>
    </div>
    <div class="build-actions"></div>
    <div class="blist"></div>`;

  const actions = el.querySelector('.build-actions') as HTMLElement;
  const blist = el.querySelector('.blist') as HTMLElement;
  const pbNums = el.querySelector('.powerbar .pb-nums') as HTMLElement;
  const pbFill = el.querySelector('.pb-fill') as HTMLElement;
  const pbTrack = el.querySelector('.pb-track') as HTMLElement;
  const pbPowered = el.querySelector('.pb-powered') as HTMLElement;
  const popNums = el.querySelector('.popbar .pb-nums') as HTMLElement;
  const popBlocks = el.querySelector('.blocks.pop') as HTMLElement;
  let popCount = -1;

  for (const t of TYPES) {
    const b = document.createElement('button');
    b.dataset.type = t;
    b.innerHTML = `<span>${TYPE_LABEL[t]}</span><span class="cost">${BUILD_COST[t]} ore · ${BUILD_TIME[t]}s · ${TYPE_EFFECT[t]}</span>`;
    b.addEventListener('click', () => colony.build(t));
    actions.appendChild(b);
  }
  const expandBtn = document.createElement('button');
  expandBtn.className = 'expand';
  expandBtn.addEventListener('click', () => colony.expand());
  actions.appendChild(expandBtn);

  const rows = new Map<number, Row>();
  let lastOrder = '';

  function update() {
    // build buttons + expand
    const free = colony.freeSlots;
    actions.querySelectorAll('button[data-type]').forEach((node) => {
      (node as HTMLButtonElement).disabled = free <= 0;
    });
    expandBtn.innerHTML = `<span>Expand +${EXPAND_SLOTS} slots</span><span class="cost">${fmt(colony.expandCost)} ore</span>`;
    expandBtn.disabled = colony.iron < colony.expandCost;

    // power-budget bar
    const f = colony.flows;
    pbNums.innerHTML = `gen ${f.energyProduction.toFixed(0)} · use ${f.energyConsumption.toFixed(0)} · <span class="msym">battery_full</span> ${fmt(colony.E)}/${fmt(colony.energyCap)}`;
    const greenPct = f.energyConsumption > 0 ? Math.min(f.energyProduction, f.energyConsumption) / f.energyConsumption * 100 : 100;
    pbFill.style.width = `${greenPct}%`;
    pbTrack.classList.toggle('deficit', f.energyProduction < f.energyConsumption - 0.01);
    pbPowered.textContent = `${f.poweredCount}/${f.consumerCount} powered`;
    pbPowered.classList.toggle('bad', f.poweredCount < f.consumerCount);

    // population bar: one block per unit of housing capacity, filled by actual crew.
    // Empty blocks are housing we have but lack the crew to fill.
    const capacity = Math.round(colony.crewCapacity);
    const crewN = Math.round(colony.crew);
    popNums.textContent = `${crewN} / ${capacity}`;
    if (capacity !== popCount) {
      popBlocks.innerHTML = '<span class="blk"></span>'.repeat(capacity);
      popCount = capacity;
    }
    Array.from(popBlocks.children).forEach((blk, i) => {
      (blk as HTMLElement).className = i < crewN ? 'blk on' : 'blk';
    });

    // reconcile rows (create/replace/remove — never move existing nodes here)
    const present = new Set<number>();
    for (const b of colony.buildings) {
      present.add(b.id);
      const existing = rows.get(b.id);
      if (!existing) {
        const built = createRow(colony, b);
        rows.set(b.id, built);
        blist.appendChild(built.el);
        updateRow(colony, built, b);
      } else if (existing.state !== b.state) {
        const built = createRow(colony, b);
        existing.el.replaceWith(built.el);
        rows.set(b.id, built);
        updateRow(colony, built, b);
      } else {
        updateRow(colony, existing, b);
      }
    }
    for (const [id, row] of rows) {
      if (!present.has(id)) {
        row.el.remove();
        rows.delete(id);
      }
    }

    // reorder DOM only when the priority order actually changed (a discrete action,
    // so no clicks are in flight) — never every frame.
    const order = colony.buildings.map((b) => b.id).join(',');
    if (order !== lastOrder) {
      for (const b of colony.buildings) blist.appendChild(rows.get(b.id)!.el);
      lastOrder = order;
    }
  }

  return { el, update };
}

function blocksMeter(kind: string, iconName: string, count: number): string {
  let blks = '';
  for (let i = 0; i < count; i++) blks += '<span class="blk"></span>';
  return `<span class="meter" title="${kind === 'pwr' ? 'power' : 'workers'}"><span class="msym mi">${iconName}</span><span class="blocks ${kind}">${blks}</span></span>`;
}
function chip(text: string): string {
  return `<span class="chip">${text}</span>`;
}

function activeMetersHTML(b: Building): string {
  let html = '';
  if (ENERGY_PRODUCTION[b.type] > 0) html += chip(`<span class="msym">bolt</span> +${ENERGY_PRODUCTION[b.type]}`);
  if (ENERGY_DRAW[b.type] > 0) html += blocksMeter('pwr', 'bolt', ENERGY_DRAW[b.type]);
  if (CREW_REQ[b.type] > 0) html += blocksMeter('crew', 'engineering', CREW_REQ[b.type]);
  if (b.capacity > 0) html += chip(`<span class="msym">bed</span> ${b.capacity}`);
  return `<span class="meters">${html}</span>`;
}

function createRow(colony: Colony, b: Building): Row {
  const el = document.createElement('div');
  const dot = `<span class="dot ${b.type}"></span>`;
  const name = `<span class="bname"><b>${TYPE_LABEL[b.type]}</b> <span class="meta"></span></span>`;

  if (b.state === 'building') {
    el.className = 'brow building';
    el.innerHTML = `${dot}<span class="bname"><b>${TYPE_LABEL[b.type]}</b> <span class="meta">building · ${BUILD_COST[b.type]} ore over ${BUILD_TIME[b.type]}s</span></span>
      <span class="meters"></span>
      <span class="status building">0%</span>
      <button class="kill">Cancel</button>
      <div class="bprogress"><div class="fill build" style="width:0%"></div></div>`;
    el.querySelector('.kill')!.addEventListener('click', () => colony.cancel(b.id));
  } else if (b.state === 'demolishing') {
    el.className = 'brow demolishing';
    el.innerHTML = `${dot}<span class="bname"><b>${TYPE_LABEL[b.type]}</b> <span class="meta">demolishing · refunds ${Math.round(BUILD_COST[b.type] * REFUND_FRACTION)} ore</span></span>
      <span class="meters"></span>
      <span class="status demolishing">0%</span>
      <button class="kill">Cancel</button>
      <div class="bprogress"><div class="fill demolish" style="width:0%"></div></div>`;
    el.querySelector('.kill')!.addEventListener('click', () => colony.cancel(b.id));
  } else {
    const isCore = b.type === 'command';
    el.className = isCore ? 'brow core' : 'brow';
    el.innerHTML = `${dot}${name}
      ${activeMetersHTML(b)}
      ${isCore ? '<span class="arrows"></span>' : '<span class="arrows"><button class="up" title="raise priority"><span class="msym">keyboard_arrow_up</span></button><button class="down" title="lower priority"><span class="msym">keyboard_arrow_down</span></button></span>'}
      ${isCore ? '<span class="locked">locked</span>' : '<button class="kill">Demolish</button>'}`;
    if (!isCore) {
      el.querySelector('.kill')!.addEventListener('click', () => colony.demolish(b.id));
      el.querySelector('.up')!.addEventListener('click', () => colony.moveUp(b.id));
      el.querySelector('.down')!.addEventListener('click', () => colony.moveDown(b.id));
    }
  }

  return {
    el,
    state: b.state,
    status: el.querySelector('.status') as HTMLElement,
    fill: el.querySelector('.bprogress .fill') as HTMLElement | null,
    pwrBlocks: Array.from(el.querySelectorAll('.blocks.pwr .blk')) as HTMLElement[],
    crewBlocks: Array.from(el.querySelectorAll('.blocks.crew .blk')) as HTMLElement[],
    up: el.querySelector('.up') as HTMLButtonElement | null,
    down: el.querySelector('.down') as HTMLButtonElement | null,
  };
}

function updateRow(colony: Colony, row: Row, b: Building): void {
  if (b.state === 'building' || b.state === 'demolishing') {
    const pct = Math.round(b.progress * 100);
    row.status.textContent = `${pct}%`;
    if (row.fill) row.fill.style.width = `${pct}%`;
    return;
  }

  // active row meta + meters + priority coloring
  const req = CREW_REQ[b.type];
  const meta = row.el.querySelector('.meta') as HTMLElement;
  if (b.type === 'command') meta.textContent = 'core · always on · grows no food';
  else if (b.type === 'generator') meta.textContent = `+10 E/s · needs ${req} crew`;
  else if (b.type === 'extractor') meta.textContent = `+8 ore/s · −4 E/s · needs ${req} crew`;
  else if (b.type === 'greenhouse') meta.textContent = `+6 food/s · −5 E/s · needs ${req} crew`;
  else meta.textContent = '−2 E/s housing';

  // A standing consumer draws its full power regardless of staffing. Each filled
  // block is sourced from live generation (solid) or the battery (hollow) so a
  // colony running on reserves is visible before the battery empties.
  const consumes = ENERGY_DRAW[b.type] > 0;
  const genBlocks = Math.round(b.genPower);
  const litBlocks = Math.round(b.genPower + b.batPower);
  row.pwrBlocks.forEach((blk, i) => {
    if (i < genBlocks) blk.className = 'blk on gen';
    else if (i < litBlocks) blk.className = 'blk on bat';
    else blk.className = 'blk';
  });
  // Worker blocks fill to the crew staffing this building.
  const crewFilled = Math.round(b.staffing * row.crewBlocks.length);
  row.crewBlocks.forEach((blk, i) => {
    blk.className = i < crewFilled ? 'blk on' : 'blk';
  });

  // power-status accent: how far the power reaches (every standing consumer)
  row.el.classList.toggle('pwr-good', consumes && b.powerLevel >= 0.999);
  row.el.classList.toggle('pwr-warn', consumes && b.powerLevel > 0.001 && b.powerLevel < 0.999);
  row.el.classList.toggle('pwr-bad', consumes && b.powerLevel <= 0.001);

  // reorder arrow availability
  const idx = colony.buildings.findIndex((x) => x.id === b.id);
  if (row.up) row.up.disabled = idx <= 1;
  if (row.down) row.down.disabled = idx >= colony.buildings.length - 1;
}
