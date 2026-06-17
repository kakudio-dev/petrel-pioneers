import type { Colony } from '../sim/colony';
import type { BuildingType, Footing } from '../sim/types';

const FOOTINGS: Footing[] = ['expansion', 'balanced', 'conservation'];
const TYPE_LABEL: Record<BuildingType, string> = {
  command: 'Command',
  generator: 'Generators',
  extractor: 'Extractors',
  greenhouse: 'Greenhouses',
  habitat: 'Habitats',
};

// Directives panel. Energy is now an automatic power grid (no allocation dial), so
// the steering directives are Growth Footing and Crew Priority. The energy lever is
// the build mix — see the Buildings panel.
export function createDirectivesPanel(colony: Colony) {
  const el = document.createElement('div');
  el.className = 'panel directives';
  el.innerHTML = `
    <h2>Directives</h2>

    <div class="dir">
      <div class="dlabel">🔌 Power Grid <span style="color:var(--ink-dim)">(automatic)</span></div>
      <div class="dhint">Generation feeds the battery; consumers draw from it. When the
      battery empties, every consumer throttles together. Steer it by building
      generators vs. consumers — there's no dial.</div>
    </div>

    <div class="dir">
      <div class="dlabel">🌱 Growth Footing</div>
      <div class="seg footing"></div>
      <div class="dhint">Expansion grows crew fast; Conservation nearly halts growth to
      hold a steady, low-demand colony while you rebalance the grid.</div>
    </div>

    <div class="dir">
      <div class="dlabel">👷 Crew Priority <span style="color:var(--ink-dim)">(staffing order)</span></div>
      <div class="prio-list"></div>
      <div class="dhint">When crew can't staff everything, earlier types get crew first.
      Generators first bootstraps power; extractors first chases iron.</div>
    </div>`;

  const footingSeg = el.querySelector('.footing') as HTMLElement;
  const prioList = el.querySelector('.prio-list') as HTMLElement;

  // Footing segmented control.
  for (const ft of FOOTINGS) {
    const b = document.createElement('button');
    b.textContent = ft[0].toUpperCase() + ft.slice(1);
    b.dataset.footing = ft;
    b.addEventListener('click', () => {
      colony.directives.footing = ft;
    });
    footingSeg.appendChild(b);
  }

  function renderPriority() {
    prioList.innerHTML = '';
    const order = colony.directives.crewPriority;
    order.forEach((type, i) => {
      const row = document.createElement('div');
      row.className = 'prio-item';
      row.innerHTML = `
        <span><span class="rank">${i + 1}</span>${TYPE_LABEL[type]}</span>
        <span class="moves">
          <button class="up" ${i === 0 ? 'disabled' : ''}>▲</button>
          <button class="down" ${i === order.length - 1 ? 'disabled' : ''}>▼</button>
        </span>`;
      row.querySelector('.up')!.addEventListener('click', () => move(i, -1));
      row.querySelector('.down')!.addEventListener('click', () => move(i, 1));
      prioList.appendChild(row);
    });
  }

  function move(i: number, dir: number) {
    const order = colony.directives.crewPriority;
    const j = i + dir;
    if (j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];
    renderPriority();
  }

  renderPriority();

  function update() {
    footingSeg.querySelectorAll('button').forEach((b) => {
      b.classList.toggle('active', (b as HTMLElement).dataset.footing === colony.directives.footing);
    });
  }

  return { el, update };
}
