import type { Colony } from '../sim/colony';
import type { Footing } from '../sim/types';

const FOOTINGS: Footing[] = ['expansion', 'balanced', 'conservation'];

// Directives panel. Power & worker priority is now the building list order (sort
// buildings up/down in the Buildings panel), so the only dial here is Growth Footing.
export function createDirectivesPanel(colony: Colony) {
  const el = document.createElement('div');
  el.className = 'panel directives';
  el.innerHTML = `
    <h2>Directives</h2>

    <div class="dir">
      <div class="dlabel"><span class="msym">bolt</span> Power & Workers <span style="color:var(--ink-dim)">(by priority)</span></div>
      <div class="dhint">Generation and crew flow down the building list, top to bottom.
      When power or crew runs short, the buildings lowest in the list go dark or
      unstaffed first. Reorder buildings (▲▼) to choose who keeps running.</div>
    </div>

    <div class="dir">
      <div class="dlabel"><span class="msym">eco</span> Growth Footing</div>
      <div class="seg footing"></div>
      <div class="dhint">Expansion grows crew fast; Conservation nearly halts growth to
      hold a steady, low-demand colony while you rebalance.</div>
    </div>`;

  const footingSeg = el.querySelector('.footing') as HTMLElement;
  for (const ft of FOOTINGS) {
    const b = document.createElement('button');
    b.textContent = ft[0].toUpperCase() + ft.slice(1);
    b.dataset.footing = ft;
    b.addEventListener('click', () => {
      colony.directives.footing = ft;
    });
    footingSeg.appendChild(b);
  }

  function update() {
    footingSeg.querySelectorAll('button').forEach((b) => {
      b.classList.toggle('active', (b as HTMLElement).dataset.footing === colony.directives.footing);
    });
  }

  return { el, update };
}
