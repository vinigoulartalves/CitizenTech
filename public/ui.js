export const get = (id) => document.getElementById(id);

export function element(tag, text) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}

export function feedback(id, message, error = false) {
  const target = get(id);
  target.textContent = message;
  target.dataset.error = String(error);
}

export async function request(path, options) {
  const response = await fetch(path, options);
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw Object.assign(new Error(error.message ?? 'Serviço indisponível. Tente novamente.'), { status: response.status });
  }
  return response;
}

export async function submit(event, messageId, work) {
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
