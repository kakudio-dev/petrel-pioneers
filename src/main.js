import './ui/style.css';
import { Colony } from './sim/colony';
import { TickLoop } from './sim/tickLoop';
import { createStocksPanel } from './ui/stocksPanel';
import { createBuildingsPanel } from './ui/buildingsPanel';
import { createCrewPage } from './ui/crewPage';
import { createMissionsPage } from './ui/missionsPage';
import { createTechnologyPage } from './ui/technologyPage';
import { createSummaryPage } from './ui/summaryPage';
const app = document.getElementById('app');
// v0.2 instantiates a single colony; the sim object is self-contained so a
// portfolio (Tier 2) drops in without a rewrite.
const colony = new Colony();
// Resources live in the sidebar; the main area is a tabbed set of pages.
const stocks = createStocksPanel();
const summary = createSummaryPage();
const crew = createCrewPage(colony);
const missions = createMissionsPage(colony);
const technology = createTechnologyPage(colony);
const buildings = createBuildingsPanel(colony);
const PAGES = [
    { id: 'summary', label: 'Summary', page: summary },
    { id: 'missions', label: 'Missions', page: missions },
    { id: 'technology', label: 'Technology', page: technology },
    { id: 'crew', label: 'Crew', page: crew },
    { id: 'buildings', label: 'Buildings', page: buildings },
];
let activeId = 'missions';
// --- Top bar: brand, tabs, clock ---
const topbar = document.createElement('div');
topbar.className = 'topbar';
topbar.innerHTML = `
  <span class="brand">Petrel Pioneers</span>
  <div class="tabs">
    ${PAGES.map((p) => `<button class="tab" data-tab="${p.id}">${p.label}</button>`).join('')}
  </div>
  <div class="clockbar">
    <span class="clock">
      <span class="season-label"></span>
      <svg class="season-ring" viewBox="0 0 36 36">
        <circle class="ring-bg" cx="18" cy="18" r="15"></circle>
        <circle class="ring-fg" cx="18" cy="18" r="15"></circle>
      </svg>
    </span>
    <button data-speed="0"><span class="msym">pause</span></button>
    <button data-speed="1">1×</button>
    <button data-speed="5">5×</button>
    <button data-speed="20">20×</button>
  </div>`;
const banner = document.createElement('div');
banner.className = 'banner';
const FAMINE_MSG = '<span class="msym">warning</span> FAMINE — the larder is empty and there is not enough food. Crew are dying. Get a greenhouse running NOW, or the colony will starve out.';
// --- Layout: sidebar (resources) + main (banner + active page) ---
const layout = document.createElement('div');
layout.className = 'layout';
const sidebar = document.createElement('div');
sidebar.className = 'sidebar';
sidebar.appendChild(stocks.el);
const main = document.createElement('div');
main.className = 'main';
main.appendChild(banner);
for (const p of PAGES)
    main.appendChild(p.page.el);
layout.appendChild(sidebar);
layout.appendChild(main);
const overlay = document.createElement('div');
overlay.className = 'overlay';
overlay.innerHTML = `
  <div class="overlay-card">
    <h2><span class="msym">skull</span> COLONY LOST</h2>
    <p>Your crew starved. The command module ships with a full larder but grows no
    food — establish a greenhouse before it runs dry.</p>
    <button class="restart">Restart</button>
  </div>`;
overlay.querySelector('.restart').addEventListener('click', () => location.reload());
app.appendChild(topbar);
app.appendChild(layout);
app.appendChild(overlay);
const seasonLabel = topbar.querySelector('.season-label');
const ringFg = topbar.querySelector('.ring-fg');
const RING_C = 2 * Math.PI * 15; // ring circumference (r=15)
const speedBtns = Array.from(topbar.querySelectorAll('button[data-speed]'));
const tabBtns = Array.from(topbar.querySelectorAll('.tab'));
function setTab(id) {
    activeId = id;
    for (const p of PAGES)
        p.page.el.classList.toggle('hidden', p.id !== id);
    tabBtns.forEach((b) => b.classList.toggle('active', b.dataset.tab === id));
}
tabBtns.forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));
setTab(activeId);
const loop = new TickLoop((dt) => colony.step(dt), () => render());
function setSpeed(s) {
    if (s === 0) {
        loop.paused = true;
    }
    else {
        loop.paused = false;
        loop.speed = s;
    }
    speedBtns.forEach((b) => {
        const v = Number(b.dataset.speed);
        const active = s === 0 ? v === 0 : v === s;
        b.classList.toggle('active', active);
    });
}
speedBtns.forEach((b) => b.addEventListener('click', () => setSpeed(Number(b.dataset.speed))));
setSpeed(1);
function render() {
    stocks.update(colony);
    const active = PAGES.find((p) => p.id === activeId);
    active?.page.update();
    // Famine is the only banner — a power deficit is legible from the per-building
    // power blocks and the energy card's alarm.
    const { starving, foodRatio } = colony.flows;
    const famine = starving && foodRatio < 0.99;
    if (famine)
        banner.innerHTML = FAMINE_MSG;
    banner.classList.toggle('show', famine);
    overlay.classList.toggle('show', colony.failed);
    // Clock runs in seasons (~1 min each), 4 to a year — shown as a fill ring.
    seasonLabel.textContent = `Y${colony.year} · ${colony.seasonName}`;
    ringFg.style.strokeDashoffset = String(RING_C * (1 - colony.seasonProgress));
}
loop.start();
// Expose for console poking during prototyping (dev builds only).
if (import.meta.env.DEV) {
    window.colony = colony;
    window.Colony = Colony;
}
