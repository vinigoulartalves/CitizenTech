import { element, feedback, get, request, submit } from './ui.js';

const filters = get('filters');
const reportList = get('operator-reports');
const operatorForm = get('operator-form');
const messageId = 'operator-message';
const formatDate = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeZone: 'UTC' });
let reportRequest = 0;

function showLogin() {
  reportRequest++;
  get('operator-panel').hidden = true;
  get('login').hidden = false;
  reportList.replaceChildren();
}

function renderReport(report, categories, transitions) {
  const card = element('article');
  card.className = 'report-item';
  const heading = element('div');
  heading.className = 'panel-header';
  const badge = element('strong', report.status);
  badge.className = 'status';
  badge.dataset.status = report.status;
  heading.append(element('h3', report.protocol), badge);
  const date = report.observedOn
    ? formatDate.format(new Date(report.observedOn + 'T00:00:00Z'))
    : 'Não informada';
  card.append(heading, element('p', report.location), element('p', 'Data da ocorrência: ' + date));
  if (report.reference) card.append(element('p', 'Referência: ' + report.reference));
  card.append(element('p', report.description));
  card.append(element('p', report.category
    ? 'Categoria: ' + report.category
    : 'Sugestão: ' + (report.suggestion ?? 'Classificação manual')));

  if (report.hasPhoto) {
    const button = element('button', 'Ver foto anexada');
    button.className = 'secondary';
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        const photo = await (await request('/api/operador/relatos/' + report.protocol + '/foto')).blob();
        if (!button.isConnected) return;
        const image = element('img');
        image.alt = 'Foto da barreira anexada ao relato';
        const url = URL.createObjectURL(photo);
        image.addEventListener('load', () => URL.revokeObjectURL(url), { once: true });
        image.addEventListener('error', () => URL.revokeObjectURL(url), { once: true });
        image.src = url;
        button.replaceWith(image);
      } catch (error) {
        if (error.status === 401) showLogin();
        feedback(messageId, error.message, true);
        button.disabled = false;
      }
    });
    card.append(button);
  }

  const next = transitions[report.status][0];
  if (!next) return card;
  const form = element('form');
  const label = element('label', 'Categoria');
  const select = element('select');
  select.required = true;
  const empty = element('option', 'Selecione uma categoria');
  empty.value = '';
  select.append(empty, ...categories.map((category) => element('option', category)));
  select.value = report.category ?? report.suggestion ?? '';
  label.append(select);
  const noteLabel = element('label', 'Nota pública de acompanhamento');
  const note = element('textarea');
  note.required = true;
  note.minLength = 5;
  note.maxLength = 300;
  note.rows = 2;
  noteLabel.append(note);
  form.append(label, noteLabel, element('button', 'Mover para ' + next));
  form.addEventListener('submit', (event) => submit(event, messageId, async () => {
    try {
      await request('/api/operador/relatos/' + report.protocol, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category: select.value, status: next, note: note.value }),
      });
      await loadReports();
    } catch (error) {
      if (error.status === 401) showLogin();
      throw error;
    }
  }));
  card.append(form);
  return card;
}

function setOptions(id, values) {
  const select = get(id);
  const selected = select.value;
  select.replaceChildren(select.options[0], ...values.map((value) => element('option', value)));
  select.value = selected;
}

async function loadReports() {
  const current = ++reportRequest;
  const query = new URLSearchParams(new FormData(filters));
  try {
    const response = await request('/api/operador/relatos?' + query);
    const { reports, categories, transitions } = await response.json();
    if (current !== reportRequest) return;
    setOptions('filter-status', Object.keys(transitions));
    setOptions('filter-category', categories);
    reportList.replaceChildren(...reports.map((report) => renderReport(report, categories, transitions)));
    get('results-count').textContent = reports.length === 0
      ? 'Nenhuma ocorrência encontrada.'
      : reports.length === 1 ? '1 ocorrência encontrada.' : reports.length + ' ocorrências encontradas.';
    get('login').hidden = true;
    get('operator-panel').hidden = false;
  } catch (error) {
    if (current !== reportRequest) return;
    if (error.status === 401) showLogin();
    throw error;
  }
}

operatorForm.addEventListener('submit', (event) => submit(event, messageId, async () => {
  await request('/api/operador/sessao', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.fromEntries(new FormData(operatorForm))),
  });
  operatorForm.reset();
  await loadReports();
  get('reports-title').focus();
}));

filters.addEventListener('submit', (event) => submit(event, messageId, loadReports));
get('clear-filters').addEventListener('click', () => {
  filters.reset();
  filters.requestSubmit();
});

get('operator-exit').addEventListener('click', async () => {
  try {
    await request('/api/operador/sessao', { method: 'DELETE' });
    showLogin();
    filters.reset();
    feedback(messageId, 'Sessão encerrada.');
    get('username').focus();
  } catch (error) {
    feedback(messageId, error.message, true);
  }
});

loadReports().catch((error) => {
  if (error.status !== 401) feedback(messageId, error.message, true);
});
