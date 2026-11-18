import { element, get, request, submit } from './ui.js';

const reportForm = get('report-form');
const trackForm = get('track-form');
const dateFormat = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
const draftKey = 'calcada-livre-draft';

const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo' }).format();
const draftFields = ['street', 'number', 'neighborhood', 'city', 'reference', 'observedOn', 'description'];
get('observedOn').max = today;

function saveDraft() {
  try {
    const draft = Object.fromEntries(draftFields.map((id) => [id, get(id).value]));
    localStorage.setItem(draftKey, JSON.stringify(draft));
  } catch {
    // O envio continua disponível quando o navegador bloqueia o armazenamento local.
  }
}

try {
  const draft = JSON.parse(localStorage.getItem(draftKey) ?? 'null');
  if (draft) {
    for (const id of draftFields) {
      if (typeof draft[id] !== 'string') continue;
      const input = get(id);
      input.value = input.maxLength > 0 ? draft[id].slice(0, input.maxLength) : draft[id];
    }
    if (!draft.reference && typeof draft.location === 'string') get('reference').value = draft.location.slice(0, 160);
  }
} catch {
  // O formulário inicia vazio se o rascunho estiver indisponível.
}
for (const id of draftFields) get(id).addEventListener('input', saveDraft);

get('demo').addEventListener('click', () => {
  get('street').value = 'Rua Geral do Rio Grande';
  get('number').value = '';
  get('neighborhood').value = 'Rio Grande';
  get('city').value = 'Palhoça';
  get('reference').value = 'Travessia no trajeto até o Centro de Saúde Rio Grande';
  get('observedOn').value = today;
  get('description').value = '[Relato simulado] Há entulho sobre a rampa da calçada e não consigo passar com a cadeira de rodas.';
  saveDraft();
  get('street').focus();
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
  get('track-summary').dataset.status = report.status;
  get('track-status').textContent = report.status;
  const latest = report.history.at(-1);
  get('track-latest').textContent = latest ? 'Atualizado em ' + dateFormat.format(new Date(latest.recordedAt)) : '';
  get('track-category').textContent = report.category ? `Categoria: ${report.category}` : 'Aguardando classificação.';
  get('history').replaceChildren(...report.history.map((item) => {
    const row = element('li');
    row.append(element('strong', item.status), element('div', dateFormat.format(new Date(item.recordedAt))), element('div', item.note));
    return row;
  }));
  get('track-result').hidden = false;
  get('track-status').focus();
}));
