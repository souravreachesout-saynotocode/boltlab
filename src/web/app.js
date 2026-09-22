const feed = document.getElementById('feed');
const searchInput = document.getElementById('search');
const projectSelect = document.getElementById('project');
const typeSelect = document.getElementById('type');
const statsEl = document.getElementById('stats');
const footerNote = document.getElementById('footer-note');

const PAGE_SIZE = 40;

const state = {
  project: localStorage.getItem('boltmem.project') || 'all',
  type: '',
  query: '',
  cursor: null,
  loading: false,
  exhausted: false,
  /** Per-card view mode, keyed by observation id. */
  views: new Map(),
  /** Everything currently on screen, so a toggle re-renders without a fetch. */
  items: new Map(),
};

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[char]);
}

function highlight(text, query) {
  const safe = escapeHtml(text);
  const terms = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((term) => term.length > 1);
  if (terms.length === 0) return safe;
  const pattern = new RegExp(`(${terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
  return safe.replace(pattern, '<mark>$1</mark>');
}

function formatStamp(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso ?? '';
  return date.toLocaleString(undefined, {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function cardMarkup(observation) {
  const view = state.views.get(observation.id) ?? 'narrative';
  const query = state.query;

  const body =
    view === 'facts' && observation.facts.length > 0
      ? `<ul class="facts">${observation.facts
          .map((fact) => `<li>${highlight(fact, query)}</li>`)
          .join('')}</ul>`
      : `<p class="card-body">${highlight(observation.narrative || '—', query)}</p>`;

  const files =
    observation.files.length > 0
      ? `<span class="files">${observation.files
          .slice(0, 4)
          .map((file) => `<span class="file-chip">${escapeHtml(file)}</span>`)
          .join('')}</span>`
      : '';

  return `
    <article class="card" data-id="${observation.id}">
      <div class="card-head">
        <span class="badge badge-type" data-type="${escapeHtml(observation.type)}">${escapeHtml(observation.type)}</span>
        <span class="badge">${escapeHtml(observation.agent)}</span>
        ${observation.scope ? `<span class="scope">${escapeHtml(observation.scope)}</span>` : ''}
        <span class="toggle" role="group" aria-label="View mode">
          <button type="button" data-view="facts" aria-pressed="${view === 'facts'}" ${
            observation.facts.length === 0 ? 'disabled' : ''
          }>facts</button>
          <button type="button" data-view="narrative" aria-pressed="${view === 'narrative'}">narrative</button>
        </span>
      </div>
      <h2 class="card-title">${highlight(observation.title, query)}</h2>
      ${body}
      <div class="card-foot">
        <span>#${observation.seq}</span>
        <span>${formatStamp(observation.createdAt)}</span>
        <span>${escapeHtml(observation.project)}</span>
        ${files}
      </div>
    </article>`;
}

function render(observations, { append }) {
  if (!append) {
    feed.innerHTML = '';
    state.items.clear();
  }
  for (const observation of observations) state.items.set(observation.id, observation);

  if (observations.length === 0 && !append) {
    feed.innerHTML = `<p class="placeholder">${
      state.query ? 'Nothing in memory matches that search.' : 'No memories yet — finish a Claude Code session and they will appear here.'
    }</p>`;
    return;
  }

  const chunks = [];
  let currentSession = append ? feed.dataset.lastSession : null;

  for (const observation of observations) {
    // Recency-ordered feeds group naturally by session; search results do not.
    if (!state.query && observation.sessionId !== currentSession) {
      currentSession = observation.sessionId;
      chunks.push(
        `<div class="session-divider">Session #${observation.sessionSeq} · ${formatStamp(
          observation.createdAt,
        )}</div>`,
      );
    }
    chunks.push(cardMarkup(observation));
  }

  feed.dataset.lastSession = currentSession ?? '';
  feed.insertAdjacentHTML('beforeend', chunks.join(''));
}

async function loadObservations({ append = false } = {}) {
  if (state.loading || (append && state.exhausted)) return;
  state.loading = true;
  feed.setAttribute('aria-busy', 'true');

  const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
  if (state.project !== 'all') params.set('project', state.project);
  if (state.type) params.set('type', state.type);
  if (state.query) params.set('q', state.query);
  if (append && state.cursor) params.set('before', String(state.cursor));

  try {
    const response = await fetch(`/api/observations?${params}`);
    const data = await response.json();
    const observations = data.observations ?? [];

    if (!append) state.exhausted = false;
    if (observations.length < PAGE_SIZE || data.mode === 'search') state.exhausted = true;
    if (observations.length > 0) state.cursor = observations[observations.length - 1].id;

    render(observations, { append });
    footerNote.textContent = state.exhausted && observations.length > 0 ? 'End of memory.' : '';
  } catch (error) {
    feed.innerHTML = `<p class="placeholder">Could not reach the boltmem server: ${escapeHtml(error.message)}</p>`;
  } finally {
    state.loading = false;
    feed.setAttribute('aria-busy', 'false');
  }
}

async function loadProjects() {
  const response = await fetch('/api/projects');
  const { projects } = await response.json();
  const options = ['<option value="all">All projects</option>'];
  for (const project of projects) {
    options.push(
      `<option value="${escapeHtml(project.project)}">${escapeHtml(project.project)} (${project.observations})</option>`,
    );
  }
  projectSelect.innerHTML = options.join('');
  projectSelect.value = projects.some((project) => project.project === state.project)
    ? state.project
    : 'all';
  state.project = projectSelect.value;
}

async function loadStats() {
  const response = await fetch('/api/stats');
  const data = await response.json();
  statsEl.textContent = `${data.observations} memories · ${data.sessions} sessions · ${data.projects} projects`;
}

function reload() {
  state.cursor = null;
  state.exhausted = false;
  feed.dataset.lastSession = '';
  loadObservations({ append: false });
}

let searchTimer;
searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.query = searchInput.value.trim();
    reload();
  }, 180);
});

projectSelect.addEventListener('change', () => {
  state.project = projectSelect.value;
  localStorage.setItem('boltmem.project', state.project);
  reload();
});

typeSelect.addEventListener('change', () => {
  state.type = typeSelect.value;
  reload();
});

feed.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-view]');
  if (!button) return;
  const card = button.closest('.card');
  const id = Number(card.dataset.id);
  const observation = state.items.get(id);
  if (!observation) return;
  state.views.set(id, button.dataset.view);
  card.outerHTML = cardMarkup(observation);
});

window.addEventListener('scroll', () => {
  if (state.query || state.loading || state.exhausted) return;
  const nearBottom = window.innerHeight + window.scrollY >= document.body.offsetHeight - 600;
  if (nearBottom) loadObservations({ append: true });
});

await loadProjects();
await loadStats();
await loadObservations();
