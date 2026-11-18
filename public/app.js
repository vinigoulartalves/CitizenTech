const get = (id) => document.getElementById(id);
const reportForm = get('report-form');
const trackForm = get('track-form');
const operatorForm = get('operator-form');
const reportList = get('operator-reports');
const dateFormat = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
const draftKey = 'calcada-livre-draft';
let operatorKey = '';

function element(tag, text) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}

function feedback(id, message, error = false) {
  const target = get(id);
  target.textContent = message;
  target.dataset.error = String(error);
}

async function request(path, options) {
  const response = await fetch(path, options);
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.message ?? 'Serviço indisponível. Tente novamente.');
  }
  return response;
}

async function submit(event, messageId, work) {
  event.preventDefault();
  const button = event.submitter;
  if (button) button.disabled = true;
  feedback(messageId, 'Processando…');
  try {
    await work();
    feedback(messageId, '');
  } catch (error) {
    const offline = !navigator.onLine && messageId === 'report-message';
    feedback(messageId, offline ? 'Sem conexão. Volte quando estiver online para enviar o relato.' : error.message, true);
  } finally {
    if (button) button.disabled = false;
  }
}

function saveDraft() {
  try {
    localStorage.setItem(draftKey, JSON.stringify({
      location: get('location').value,
      description: get('description').value,
    }));
  } catch {
    // O envio continua disponível quando o navegador bloqueia o armazenamento local.
  }
}

try {
  const draft = JSON.parse(localStorage.getItem(draftKey) ?? 'null');
  if (draft) {
    get('location').value = typeof draft.location === 'string' ? draft.location.slice(0, 160) : '';
    get('description').value = typeof draft.description === 'string' ? draft.description.slice(0, 600) : '';
  }
} catch {
  // O formulário inicia vazio se o rascunho estiver indisponível.
}
get('location').addEventListener('input', saveDraft);
get('description').addEventListener('input', saveDraft);

get('demo').addEventListener('click', () => {
  get('location').value = 'Travessia no trajeto entre o ponto de ônibus e o Centro de Saúde Rio Grande';
  get('description').value = '[Relato simulado] Há entulho sobre a rampa da calçada e não consigo passar com a cadeira de rodas.';
  saveDraft();
  get('location').focus();
});

reportForm.addEventListener('submit', (event) => submit(event, 'report-message', async () => {
  const data = new FormData(reportForm);
  if (data.get('photo').size > 2 * 1024 * 1024) throw new Error('A foto deve ter até 2 MB.');
  const report = await (await request('/api/relatos', { method: 'POST', body: data })).json();
  reportForm.reset();
  saveDraft();
  get('receipt-code').textContent = report.protocol;
  get('receipt').hidden = false;
  get('track-new').focus();
}));

get('track-new').addEventListener('click', () => {
  get('protocol').value = get('receipt-code').textContent;
  trackForm.requestSubmit();
  get('protocol').focus();
});

trackForm.addEventListener('submit', (event) => submit(event, 'track-message', async () => {
  get('track-result').hidden = true;
  const code = encodeURIComponent(get('protocol').value.trim());
  const report = await (await request(`/api/relatos/${code}`)).json();
  get('track-status').textContent = report.status;
  get('track-category').textContent = report.category ? `Categoria: ${report.category}` : 'Aguardando classificação.';
  get('history').replaceChildren(...report.history.map((item) => {
    const row = element('li');
    row.append(element('strong', item.status), element('div', dateFormat.format(new Date(item.recordedAt))), element('div', item.note));
    return row;
  }));
  get('track-result').hidden = false;
}));

function authorization(key = operatorKey) {
  return { Authorization: `Bearer ${key}` };
}

function renderReport(report, categories, transitions) {
  const card = element('article');
  card.className = 'report-item';
  card.append(
    element('h3', report.protocol),
    element('p', report.location),
    element('p', report.description),
    element('p', `Status: ${report.status} · Sugestão: ${report.suggestion ?? 'Classificação manual'}`),
  );
  if (report.hasPhoto) {
    const button = element('button', 'Ver foto anexada');
    button.className = 'secondary';
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        const photo = await (await request(`/api/operador/relatos/${report.protocol}/foto`, { headers: authorization() })).blob();
        if (!button.isConnected) return;
        const image = element('img');
        image.alt = 'Foto da barreira anexada ao relato';
        const url = URL.createObjectURL(photo);
        image.addEventListener('load', () => URL.revokeObjectURL(url), { once: true });
        image.addEventListener('error', () => URL.revokeObjectURL(url), { once: true });
        image.src = url;
        button.replaceWith(image);
      } catch (error) {
        feedback('operator-message', error.message, true);
        button.disabled = false;
      }
    });
    card.append(button);
  }

  const next = transitions[report.status];
  if (next.length === 0) return card;
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
  form.append(label, noteLabel, element('button', `Mover para ${next[0]}`));
  form.addEventListener('submit', (event) => submit(event, 'operator-message', async () => {
    await request(`/api/operador/relatos/${report.protocol}`, {
      method: 'PATCH',
      headers: { ...authorization(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ category: select.value, status: next[0], note: note.value }),
    });
    await loadReports(operatorKey);
  }));
  card.append(form);
  return card;
}

async function loadReports(key) {
  const response = await request('/api/operador/relatos', { headers: authorization(key) });
  const { reports, categories, transitions } = await response.json();
  if (key !== operatorKey) return;
  reportList.replaceChildren(...(reports.length
    ? reports.map((report) => renderReport(report, categories, transitions))
    : [element('p', 'Nenhum relato registrado.')]));
}

operatorForm.addEventListener('submit', (event) => submit(event, 'operator-message', async () => {
  reportList.replaceChildren();
  operatorKey = get('key').value;
  get('operator-exit').hidden = false;
  await loadReports(operatorKey);
  get('key').value = '';
}));

get('operator-exit').addEventListener('click', () => {
  operatorKey = '';
  get('key').value = '';
  get('operator-exit').hidden = true;
  reportList.replaceChildren();
  feedback('operator-message', '');
  get('key').focus();
});
