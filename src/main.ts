import './ui/style.css';
import { Colony } from './sim/colony';
import { TickLoop } from './sim/tickLoop';
import { createStocksPanel } from './ui/stocksPanel';
import { createDirectivesPanel } from './ui/directivesPanel';
import { createBuildingsPanel } from './ui/buildingsPanel';

const app = document.getElementById('app')!;

// v0.2 instantiates a single colony; the sim object is self-contained so a
// portfolio (Tier 2) drops in without a rewrite.
const colony = new Colony();

const stocks = createStocksPanel();
const directives = createDirectivesPanel(colony);
const buildings = createBuildingsPanel(colony);

// --- Header + clock bar ---
const header = document.createElement('div');
header.className = 'title';
header.innerHTML = `
  <div>
    <h1>🐦 Petrel Pioneers <span class="sub">v0.2 core loop</span></h1>
  </div>
  <div class="clockbar">
    <span class="clock">0:00</span>
    <button data-speed="0">⏸</button>
    <button data-speed="1">1×</button>
    <button data-speed="5">5×</button>
    <button data-speed="20">20×</button>
  </div>`;

const banner = document.createElement('div');
banner.className = 'banner';

const POWER_DEFICIT_MSG =
  '⚠ POWER DEFICIT — demand exceeds generation and the battery is empty. Power flows by priority, so the buildings lowest in the list go dark first. Build a generator, demolish a consumer, or reorder (▲▼) to choose who stays powered.';
const FAMINE_MSG =
  '⚠ FAMINE — the larder is empty and there is not enough food. Crew are dying. Get a greenhouse running NOW, or the colony will starve out.';

const cols = document.createElement('div');
cols.className = 'cols';
cols.appendChild(directives.el);
const right = document.createElement('div');
right.appendChild(buildings.el);
cols.appendChild(right);

const overlay = document.createElement('div');
overlay.className = 'overlay';
overlay.innerHTML = `
  <div class="overlay-card">
    <h2>☠ COLONY LOST</h2>
    <p>Your crew starved. The command module ships with a full larder but grows no
    food — establish a greenhouse before it runs dry.</p>
    <button class="restart">Restart</button>
  </div>`;
overlay.querySelector('.restart')!.addEventListener('click', () => location.reload());

app.appendChild(header);
app.appendChild(stocks.el);
app.appendChild(banner);
app.appendChild(cols);
app.appendChild(overlay);

const clockEl = header.querySelector('.clock') as HTMLElement;
const speedBtns = Array.from(header.querySelectorAll('button[data-speed]')) as HTMLButtonElement[];

const loop = new TickLoop(
  (dt) => colony.step(dt),
  () => render(),
);

function setSpeed(s: number) {
  if (s === 0) {
    loop.paused = true;
  } else {
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
  directives.update();
  buildings.update();
  // Surface whichever crisis is active. Power deficit comes first — it also starves
  // greenhouses, so fixing the grid often fixes the famine too.
  const { brownout, starving, foodRatio } = colony.flows;
  const famine = starving && foodRatio < 0.99; // empty larder AND crew declining
  if (brownout) banner.textContent = POWER_DEFICIT_MSG;
  else if (famine) banner.textContent = FAMINE_MSG;
  banner.classList.toggle('show', brownout || famine);
  overlay.classList.toggle('show', colony.failed);
  const t = Math.floor(colony.elapsed);
  clockEl.textContent = `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}

loop.start();

// Expose for console poking during prototyping.
(window as unknown as { colony: Colony; Colony: typeof Colony }).colony = colony;
(window as unknown as { colony: Colony; Colony: typeof Colony }).Colony = Colony;
