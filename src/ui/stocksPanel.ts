import type { Colony } from '../sim/colony';
import { fmt, rate, netClass } from './format';

// Stocks panel (spec §6A). The net-flow number is the most important thing on
// screen — it's how the player sees a bottleneck coming before it hits.
export function createStocksPanel() {
  const el = document.createElement('div');
  el.className = 'panel stocks';
  el.innerHTML = `
    <h2>Stocks</h2>
    <div class="stock-grid">
      ${stockCard('energy', 'Energy')}
      ${stockCard('iron', 'Iron')}
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
      ? `${f.poweredCount}/${f.consumerCount} powered · gen ${f.energyProduction.toFixed(0)} < use ${f.energyConsumption.toFixed(0)}`
      : `gen ${f.energyProduction.toFixed(0)} · use ${f.energyConsumption.toFixed(0)}${f.storageWasted ? ' · full' : ''}`;
    refs.eCard.classList.toggle('alarm', f.brownout);

    refs.iVal.textContent = `${fmt(colony.iron)} / ${fmt(colony.ironCap)}`;
    setNet(refs.iNet, f.ironNet);
    refs.iSub.textContent = f.ironWasted
      ? `stockpile full · extracting ${f.ironProduced.toFixed(1)}/s wasted`
      : `extracting ${f.ironProduced.toFixed(1)}/s`;

    // Famine = the larder is empty AND crew is actively declining. At the exact
    // food-supportable equilibrium the larder sits empty but isn't a crisis.
    const famine = f.starving && f.foodRatio < 0.99;
    refs.fVal.textContent = `${fmt(colony.food)} / ${fmt(colony.foodCap)}`;
    setNet(refs.fNet, f.foodNet);
    refs.fSub.textContent = famine
      ? `fed ${Math.round(f.foodRatio * 100)}% · grow ${f.foodProduction.toFixed(1)} < eat ${f.foodConsumption.toFixed(1)}`
      : f.starving
        ? `larder empty · grow ${f.foodProduction.toFixed(1)} · eat ${f.foodConsumption.toFixed(1)}`
        : `grow ${f.foodProduction.toFixed(1)} · eat ${f.foodConsumption.toFixed(1)}`;
    refs.fCard.classList.toggle('alarm', famine);

    refs.cVal.textContent = `${fmt(colony.crew)} / ${fmt(f.crewCap || colony.crewCapacity)}`;
    setNet(refs.cNet, f.crewNet);
    refs.cSub.textContent = f.starving ? 'cap (food-limited)' : f.brownout ? 'cap throttled' : 'cap';

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
      <div class="net zero">±0/s</div>
      <div class="sub2"></div>
    </div>`;
}
