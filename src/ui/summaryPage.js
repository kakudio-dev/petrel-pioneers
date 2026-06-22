// Placeholder Summary page — a colony overview to be built later.
export function createSummaryPage() {
    const el = document.createElement('div');
    el.className = 'page';
    el.innerHTML = `
    <div class="panel">
      <h2>Colony Summary</h2>
      <p class="empty">An at-a-glance overview of the colony will live here — coming soon.</p>
    </div>`;
    return { el, update() { } };
}
