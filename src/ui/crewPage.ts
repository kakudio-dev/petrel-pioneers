import type { Colony } from '../sim/colony';
import type { CrewMember, CrewTask } from '../sim/types';

const TASKS: { value: CrewTask; label: string }[] = [
  { value: 'building', label: 'Work in Buildings' },
  { value: 'explore', label: 'Explore' },
  { value: 'gatherFood', label: 'Gather Food' },
  { value: 'construction', label: 'Construction' },
  { value: 'expand', label: 'Expand Base' },
  { value: 'idle', label: 'Idle' },
];
const STATUS: Record<CrewTask, string> = {
  building: 'On shift',
  explore: 'Exploring',
  gatherFood: 'Gathering food',
  construction: 'On construction',
  expand: 'Surveying',
  idle: 'Idle',
};
const STATS: { key: keyof CrewMember['stats']; label: string }[] = [
  { key: 'vigor', label: 'VIG' },
  { key: 'tech', label: 'TEC' },
  { key: 'grit', label: 'GRT' },
];

interface CrewRow {
  el: HTMLElement;
  select: HTMLSelectElement;
  status: HTMLElement;
}

// The Crew page — a roster of named individuals you assign to tasks. Working in
// buildings is the default; other tasks pull them out of the staffing pool.
export function createCrewPage(colony: Colony) {
  const el = document.createElement('div');
  el.className = 'page';
  el.innerHTML = `
    <div class="panel">
      <h2>Crew <span class="crew-summary"></span></h2>
      <div class="crew-list"></div>
    </div>`;

  const summary = el.querySelector('.crew-summary') as HTMLElement;
  const list = el.querySelector('.crew-list') as HTMLElement;
  const rows = new Map<number, CrewRow>();

  function update() {
    const onShift = colony.crewOnTask('building');
    const onMission = colony.crewCount - onShift - colony.crewOnTask('idle');
    const idle = colony.crewOnTask('idle');
    summary.textContent = `· ${colony.crewCount} aboard — ${onShift} on shift, ${onMission} on missions, ${idle} idle`;

    const present = new Set<number>();
    for (const c of colony.crew) {
      present.add(c.id);
      let row = rows.get(c.id);
      if (!row) {
        row = createCrewRow(colony, c);
        rows.set(c.id, row);
        list.appendChild(row.el);
      }
      if (row.select.value !== c.task) row.select.value = c.task;
      row.status.textContent = STATUS[c.task];
      row.status.className = `crew-status task-${c.task}`;
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

function createCrewRow(colony: Colony, c: CrewMember): CrewRow {
  const el = document.createElement('div');
  el.className = 'crew-row';
  const statsHtml = STATS.map(
    (s) =>
      `<span class="cstat" title="${s.key}"><span class="cstat-l">${s.label}</span><span class="cbar"><span class="cbarf" style="width:${c.stats[s.key] * 10}%"></span></span></span>`,
  ).join('');
  const opts = TASKS.map((t) => `<option value="${t.value}">${t.label}</option>`).join('');
  el.innerHTML = `
    <span class="crew-av">${c.name[0]}</span>
    <span class="crew-name">${c.name}</span>
    <span class="crew-stats">${statsHtml}</span>
    <select class="crew-task">${opts}</select>
    <span class="crew-status"></span>`;
  const select = el.querySelector('.crew-task') as HTMLSelectElement;
  select.value = c.task;
  select.addEventListener('change', () => colony.setTask(c.id, select.value as CrewTask));
  return { el, select, status: el.querySelector('.crew-status') as HTMLElement };
}
