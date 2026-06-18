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
    const crewN = colony.crewCount;
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

// Consumption: one box per unit needed, icon inside (state set in updateRow).
function boxesCol(kind: string, iconName: string, count: number): string {
  let pips = '';
  for (let i = 0; i < count; i++) pips += `<span class="pipbox"><span class="msym pic">${iconName}</span></span>`;
  return `<span class="pips ${kind}">${pips}</span>`;
}
// Production: a filled box with the resource icon (a source), plus the amount.
function prodChip(kind: string, iconName: string, n: number): string {
  return `<span class="prod ${kind}"><span class="pipbox filled"><span class="msym pic">${iconName}</span></span> +${n}</span>`;
}

// The energy column: produces (chip) or consumes (boxes).
function energyColHTML(b: Building): string {
  if (ENERGY_PRODUCTION[b.type] > 0) return prodChip('pwr', 'bolt', ENERGY_PRODUCTION[b.type]);
  if (ENERGY_DRAW[b.type] > 0) return boxesCol('pwr', 'bolt', ENERGY_DRAW[b.type]);
  return '';
}
// The people column: needs workers (boxes) or provides housing (chip).
function peopleColHTML(b: Building): string {
  if (CREW_REQ[b.type] > 0) return boxesCol('crew', 'person', CREW_REQ[b.type]);
  if (b.capacity > 0) return prodChip('people', 'bed', b.capacity);
  return '';
}

function createRow(colony: Colony, b: Building): Row {
  const el = document.createElement('div');
  const dot = `<span class="dot ${b.type}"></span>`;
  const name = `<span class="bname"><b>${TYPE_LABEL[b.type]}</b> <span class="meta"></span></span>`;

  if (b.state === 'building') {
    el.className = 'brow building';
    el.innerHTML = `${dot}<span class="bname"><b>${TYPE_LABEL[b.type]}</b> <span class="meta">building · ${BUILD_COST[b.type]} ore over ${BUILD_TIME[b.type]}s</span></span>
      <span class="status building">0%</span>
      <button class="kill">Cancel</button>
      <div class="bprogress"><div class="fill build" style="width:0%"></div></div>`;
    el.querySelector('.kill')!.addEventListener('click', () => colony.cancel(b.id));
  } else if (b.state === 'demolishing') {
    el.className = 'brow demolishing';
    el.innerHTML = `${dot}<span class="bname"><b>${TYPE_LABEL[b.type]}</b> <span class="meta">demolishing · refunds ${Math.round(BUILD_COST[b.type] * REFUND_FRACTION)} ore</span></span>
      <span class="status demolishing">0%</span>
      <button class="kill">Cancel</button>
      <div class="bprogress"><div class="fill demolish" style="width:0%"></div></div>`;
    el.querySelector('.kill')!.addEventListener('click', () => colony.cancel(b.id));
  } else {
    const isCore = b.type === 'command';
    el.className = isCore ? 'brow core' : 'brow';
    const actions = isCore
      ? '<span class="locked">locked</span>'
      : '<span class="arrows"><button class="up" title="raise priority"><span class="msym">keyboard_arrow_up</span></button><button class="down" title="lower priority"><span class="msym">keyboard_arrow_down</span></button></span><button class="kill">Demolish</button>';
    el.innerHTML = `${dot}${name}
      <span class="col energy" title="energy">${energyColHTML(b)}</span>
      <span class="col people" title="people">${peopleColHTML(b)}</span>
      <span class="row-actions">${actions}</span>`;
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
    pwrBlocks: Array.from(el.querySelectorAll('.pips.pwr .pipbox')) as HTMLElement[],
    crewBlocks: Array.from(el.querySelectorAll('.pips.crew .pipbox')) as HTMLElement[],
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

  // active row meta — just the production output the meters don't already show
  // (power draw → power blocks; crew need → worker blocks).
  const meta = row.el.querySelector('.meta') as HTMLElement;
  if (b.type === 'extractor') meta.textContent = '+8 ore/s';
  else if (b.type === 'greenhouse') meta.textContent = '+6 food/s';
  else meta.textContent = '';

  // A standing consumer draws its full power regardless of staffing. Each filled
  // block is sourced from live generation (solid) or the battery (hollow) so a
  // colony running on reserves is visible before the battery empties.
  const consumes = ENERGY_DRAW[b.type] > 0;
  const genBlocks = Math.round(b.genPower);
  const litBlocks = Math.round(b.genPower + b.batPower);
  row.pwrBlocks.forEach((box, i) => {
    if (i < genBlocks) box.className = 'pipbox gen';
    else if (i < litBlocks) box.className = 'pipbox bat';
    else box.className = 'pipbox';
  });
  // Worker boxes fill to the crew staffing this building.
  const crewFilled = Math.round(b.staffing * row.crewBlocks.length);
  row.crewBlocks.forEach((box, i) => {
    box.className = i < crewFilled ? 'pipbox on' : 'pipbox';
  });

  // power-status accent: green = fully on generation, yellow = fully powered but
  // drawing battery (temporary), orange = partial, red = unpowered.
  const onBattery = b.batPower > 0.001;
  const lvl = b.powerLevel;
  row.el.classList.toggle('pwr-good', consumes && lvl >= 0.999 && !onBattery);
  row.el.classList.toggle('pwr-batt', consumes && lvl >= 0.999 && onBattery);
  row.el.classList.toggle('pwr-warn', consumes && lvl > 0.001 && lvl < 0.999);
  row.el.classList.toggle('pwr-bad', consumes && lvl <= 0.001);

  // reorder arrow availability
  const idx = colony.buildings.findIndex((x) => x.id === b.id);
  if (row.up) row.up.disabled = idx <= 1;
  if (row.down) row.down.disabled = idx >= colony.buildings.length - 1;
}
