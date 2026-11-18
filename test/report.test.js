import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { File } from 'node:buffer';
import { createApp } from '../server.js';

const operatorKey = 'test-operator-key';
const authorized = { Authorization: `Bearer ${operatorKey}` };

async function start(t, options) {
  const server = createApp({ operatorKey, ...options });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  return (path, config) => fetch(`http://127.0.0.1:${server.address().port}${path}`, config);
}

async function register(request, photo) {
  const body = new FormData();
  body.set('location', 'Travessia perto do Centro de Saúde Rio Grande');
  body.set('description', '[Simulação] A rampa está bloqueada por entulho.');
  if (photo) body.set('photo', photo);
  const response = await request('/api/relatos', { method: 'POST', body });
  assert.equal(response.status, 201);
  return response.json();
}

test('registra barreira sem foto e gera protocolo', async (t) => {
  const request = await start(t);
  const report = await register(request);
  assert.match(report.protocol, /^CL-(?:[A-F0-9]{6}-){3}[A-F0-9]{6}$/);
  assert.equal(report.status, 'Recebido');
  assert.equal(report.history.length, 1);
  assert.equal(report.history[0].status, 'Recebido');
  const page = await request('/');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Registrar barreira/);
});

test('consulta mostra a atualização publicada pelo operador', async (t) => {
  const request = await start(t);
  const { protocol } = await register(request);
  const panel = await (await request('/api/operador/relatos', { headers: authorized })).json();
  assert.equal(panel.reports[0].suggestion, 'Rampa obstruída');
  const note = 'Relato classificado e em análise para encaminhamento.';
  const updated = await request(`/api/operador/relatos/${protocol}`, {
    method: 'PATCH',
    headers: { ...authorized, 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'Em análise', category: panel.reports[0].suggestion, note }),
  });
  assert.equal(updated.status, 200);
  const tracked = await (await request(`/api/relatos/${protocol.toLowerCase()}`)).json();
  assert.equal(tracked.status, 'Em análise');
  assert.deepEqual(tracked.history.map((event) => event.status), ['Recebido', 'Em análise']);
  assert.equal(tracked.history[1].note, note);
  assert.ok(Number.isFinite(Date.parse(tracked.history[1].recordedAt)));
});

test('classificador indisponível mantém registro e triagem manual', async (t) => {
  const request = await start(t, { classifier: async () => { throw new Error('Indisponível'); } });
  const report = await register(request);
  assert.equal(report.status, 'Recebido');
  const panel = await (await request('/api/operador/relatos', { headers: authorized })).json();
  assert.equal(panel.reports[0].protocol, report.protocol);
  assert.equal(panel.reports[0].suggestion, null);
  const response = await request(`/api/operador/relatos/${report.protocol}`, {
    method: 'PATCH',
    headers: { ...authorized, 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'Em análise', category: 'Rampa obstruída', note: 'Classificação manual concluída.' }),
  });
  assert.equal(response.status, 200);
});

test('foto fica disponível somente para o operador', async (t) => {
  const request = await start(t);
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l2QAAAAASUVORK5CYII=', 'base64');
  const report = await register(request, new File([bytes], 'barreira.png', { type: 'image/png' }));
  const path = `/api/operador/relatos/${report.protocol}/foto`;
  assert.equal((await request(path)).status, 401);
  assert.equal(Object.hasOwn(report, 'photo'), false);
  const photo = await request(path, { headers: authorized });
  assert.equal(photo.status, 200);
  assert.equal(photo.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await photo.arrayBuffer()), bytes);
});
