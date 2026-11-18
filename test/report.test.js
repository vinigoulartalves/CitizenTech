import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { File } from 'node:buffer';
import { createApp } from '../server.js';

const operatorUser = 'operador';
const operatorPassword = 'senha-de-teste';

async function login(request, password = operatorPassword) {
  return request('/api/operador/sessao', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: operatorUser, password }),
  });
}

async function authorize(request) {
  const response = await login(request);
  assert.equal(response.status, 204);
  return { Cookie: response.headers.get('set-cookie').split(';')[0] };
}

async function start(t, options) {
  const server = createApp({ operatorUser, operatorPassword, ...options });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  return (path, config) => fetch(`http://127.0.0.1:${server.address().port}${path}`, config);
}

async function register(request, photo, observedOn = '2026-01-10') {
  const body = new FormData();
  body.set('street', 'Rua Geral do Rio Grande');
  body.set('number', '100');
  body.set('neighborhood', 'Rio Grande');
  body.set('city', 'Palhoça');
  body.set('reference', 'Travessia perto do Centro de Saúde Rio Grande');
  body.set('observedOn', observedOn);
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
  const citizen = await page.text();
  assert.match(citizen, /Registrar barreira/);
  assert.match(citizen, /Status atual/);
  assert.doesNotMatch(citizen, /id="operator-form"/);
  const triage = await (await request('/triagem')).text();
  assert.match(triage, /id="operator-form"/);
  assert.doesNotMatch(triage, /id="report-form"/);
});

test('consulta mostra a atualização publicada pelo operador', async (t) => {
  const request = await start(t);
  const { protocol } = await register(request);
  const authorized = await authorize(request);
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
  const authorized = await authorize(request);
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
  const authorized = await authorize(request);
  const photo = await request(path, { headers: authorized });
  assert.equal(photo.status, 200);
  assert.equal(photo.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await photo.arrayBuffer()), bytes);
});

test('exige usuário e senha e invalida a sessão ao sair', async (t) => {
  const request = await start(t);
  assert.equal((await request('/api/operador/relatos')).status, 401);
  assert.equal((await login(request, 'senha-incorreta')).status, 401);
  const headers = await authorize(request);
  assert.equal((await request('/api/operador/relatos', { headers })).status, 200);
  assert.equal((await request('/api/operador/sessao', { method: 'DELETE', headers })).status, 204);
  assert.equal((await request('/api/operador/relatos', { headers })).status, 401);
});

test('filtra por data da ocorrência, status e categoria', async (t) => {
  const request = await start(t);
  const first = await register(request);
  const second = await register(request, undefined, '2026-01-11');
  const headers = await authorize(request);
  const updated = await request('/api/operador/relatos/' + first.protocol, {
    method: 'PATCH',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'Em análise', category: 'Rampa obstruída', note: 'Relato analisado.' }),
  });
  assert.equal(updated.status, 200);
  const params = new URLSearchParams({ start: '2026-01-10', end: '2026-01-11', status: 'Em análise', category: 'Rampa obstruída' });
  const list = async () => (await (await request('/api/operador/relatos?' + params, { headers })).json()).reports;
  const match = await list();
  assert.equal(match.length, 1);
  assert.equal(match[0].protocol, first.protocol);
  assert.equal(match[0].street, 'Rua Geral do Rio Grande');
  assert.equal(match[0].number, '100');
  assert.equal(match[0].neighborhood, 'Rio Grande');
  assert.equal(match[0].city, 'Palhoça');
  assert.equal(match[0].reference, 'Travessia perto do Centro de Saúde Rio Grande');
  assert.equal(match[0].observedOn, '2026-01-10');
  params.set('start', '2026-01-11');
  assert.deepEqual(await list(), []);
  params.set('status', 'Recebido');
  params.delete('category');
  assert.equal((await list())[0].protocol, second.protocol);
  params.set('end', '2026-02-30');
  assert.equal((await request('/api/operador/relatos?' + params, { headers })).status, 400);
});

test('migra relatos antigos e mantém a consulta dos protocolos', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'calcada-test-'));
  const database = join(directory, 'old.sqlite');
  const db = new DatabaseSync(database);
  db.exec(`
    CREATE TABLE reports (
      protocol TEXT PRIMARY KEY, location TEXT NOT NULL, description TEXT NOT NULL,
      suggestion TEXT, category TEXT, photo BLOB, photo_type TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL
    );
    INSERT INTO reports VALUES (
      'CL-ABC123-ABC123-ABC123-ABC123', 'Local legado', 'Relato antigo', NULL, NULL,
      NULL, NULL, 'Recebido', '2026-01-10T00:00:00.000Z'
    );
  `);
  db.close();
  const request = await start(t, { database });
  t.after(() => rm(directory, { recursive: true, force: true }));
  const report = await (await request('/api/relatos/CL-ABC123-ABC123-ABC123-ABC123')).json();
  assert.equal(report.status, 'Recebido');
  assert.equal(report.observedOn, null);
  const headers = await authorize(request);
  const { reports } = await (await request('/api/operador/relatos', { headers })).json();
  assert.equal(reports[0].location, 'Local legado');
  const filtered = await (await request('/api/operador/relatos?start=2026-01-01', { headers })).json();
  assert.deepEqual(filtered.reports, []);
  await register(request);
});
