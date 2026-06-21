import type { Colony } from '../sim/colony';
import { SEASON_LENGTH } from '../sim/config';
import { fmt, rate, netClass } from './format';

// per-second flow → per-season, for the descriptive sub-lines
const perSeason = (n: number) => n * SEASON_LENGTH;

// Stocks panel (spec §6A). The net-flow number is the most important thing on
// screen — it's how the player sees a bottleneck coming before it hits.
export function createStocksPanel() {
  const el = document.createElement('div');
  el.className = 'panel stocks';
  el.innerHTML = `
    <h2>Stocks</h2>
    <div class="stock-grid">
      ${stockCard('energy', 'Energy')}
      ${stockCard('iron', 'Ore')}
      ${stockCard('food', 'Food')}
      ${stockCard('crew', 'Crew')}
      ${stockCard('slots', 'Slots')}
    </div>`;

  const q = (sel: string) => el.querySelector(sel) as HTMLElement;
  const refs = {
    eVal: q('.s-energy .value'), eNet: q('.s-energy .net'), eCard: q('.s-energy'),
    eSub: q('.s-energy .sub2'),
    iVal: q('.s-iron .value'), iNet: q('.s-iron .net'), iCard: q('.s-iron'),
    iSub: q('.s-iron .sub2'),
    fVal: q('.s-food .value'), fNet: q('.s-food .net'), fCard: q('.s-food'),
    fSub: q('.s-food .sub2'),
    cVal: q('.s-crew .value'), cNet: q('.s-crew .net'), cSub: q('.s-crew .sub2'),
    sVal: q('.s-slots .value'), sNet: q('.s-slots .net'), sCard: q('.s-slots'),
    sSub: q('.s-slots .sub2'),
  };

  function update(colony: Colony) {
    const f = colony.flows;

    refs.eVal.textContent = `${fmt(colony.E)} / ${fmt(colony.energyCap)}`;
    setNet(refs.eNet, f.energyNet);
    refs.eSub.textContent = f.brownout
      ? `${f.poweredCount}/${f.consumerCount} powered · gen ${perSeason(f.energyProduction).toFixed(0)} < use ${perSeason(f.energyConsumption).toFixed(0)}`
      : `gen ${perSeason(f.energyProduction).toFixed(0)} · use ${perSeason(f.energyConsumption).toFixed(0)}${f.storageWasted ? ' · full' : ''}`;
    refs.eCard.classList.toggle('alarm', f.brownout);

    refs.iVal.textContent = `${fmt(colony.iron)} / ${fmt(colony.ironCap)}`;
    setNet(refs.iNet, f.ironNet);
    refs.iSub.textContent = f.ironWasted
      ? `stockpile full · extracting ${perSeason(f.ironProduced).toFixed(0)}/season wasted`
      : `extracting ${perSeason(f.ironProduced).toFixed(0)}/season`;

    // Famine = the larder is empty AND crew is actively declining. At the exact
    // food-supportable equilibrium the larder sits empty but isn't a crisis.
    const famine = f.starving && f.foodRatio < 0.99;
    refs.fVal.textContent = `${fmt(colony.food)} / ${fmt(colony.foodCap)}`;
    setNet(refs.fNet, f.foodNet);
    refs.fSub.textContent = famine
      ? `fed ${Math.round(f.foodRatio * 100)}% · grow ${perSeason(f.foodProduction).toFixed(0)} < eat ${perSeason(f.foodConsumption).toFixed(0)}`
      : f.starving
        ? `larder empty · grow ${perSeason(f.foodProduction).toFixed(0)} · eat ${perSeason(f.foodConsumption).toFixed(0)}`
        : `grow ${perSeason(f.foodProduction).toFixed(0)} · eat ${perSeason(f.foodConsumption).toFixed(0)}`;
    refs.fCard.classList.toggle('alarm', famine);

    refs.cVal.textContent = `${fmt(colony.crewCount)} / ${fmt(colony.crewCapacity)}`;
    refs.cNet.className = 'net zero';
    refs.cNet.textContent = f.starving ? 'starving' : '';
    refs.cNet.classList.toggle('neg', f.starving);
    refs.cSub.textContent = `${f.buildingCrew} on shift`;

    refs.sVal.textContent = `${colony.slotsUsed} / ${colony.slotCap}`;
    const free = colony.freeSlots;
    refs.sNet.className = `net ${free <= 0 ? 'neg' : 'zero'}`;
    refs.sNet.textContent = free <= 0 ? 'FULL' : `${free} free`;
    refs.sSub.textContent = free <= 0 ? 'demolish to rebuild' : '';
    refs.sCard.classList.toggle('alarm', free <= 0);
  }

  function setNet(node: HTMLElement, n: number) {
    node.className = `net ${netClass(n)}`;
    node.textContent = rate(n);
  }

  return { el, update };
}

function stockCard(key: string, label: string): string {
  return `
    <div class="stock s-${key}">
      <div class="label">${label}</div>
      <div class="value">—</div>
      <div class="net zero">±0/season</div>
      <div class="sub2"></div>
    </div>`;
}
