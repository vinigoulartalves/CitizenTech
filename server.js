import { createServer } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

const categories = ['Rampa obstruída', 'Calçada danificada', 'Travessia inacessível', 'Outra barreira'];
const transitions = { Recebido: ['Em análise'], 'Em análise': ['Encaminhado'], Encaminhado: ['Resolvido'], Resolvido: [] };
const assets = {
  '/': ['index.html', 'text/html'],
  '/triagem': ['triagem.html', 'text/html'],
  '/triagem/': ['triagem.html', 'text/html'],
  '/triagem.js': ['triagem.js', 'text/javascript'],
  '/ui.js': ['ui.js', 'text/javascript'],
  '/app.js': ['app.js', 'text/javascript'],
  '/style.css': ['style.css', 'text/css'],
  '/logo.webp': ['logo.webp', 'image/webp'],
  '/travessia.webp': ['travessia.webp', 'image/webp'],
};

function suggestCategory(description) {
  const words = description.toLocaleLowerCase('pt-BR');
  if (words.includes('rampa') && /entulho|bloque|obstru/.test(words)) return categories[0];
  if (/buraco|rachadura|quebrad/.test(words)) return categories[1];
  if (/travessia|faixa/.test(words)) return categories[2];
  return null;
}

function fail(status, message) {
  throw Object.assign(new Error(message), { status });
}

async function readBody(request, limit) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > limit) {
      request.resume();
      fail(413, 'Arquivo ou formulário acima do limite.');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function field(value, label, min, max) {
  const clean = typeof value === 'string' ? value.trim() : '';
  if (clean.length < min || clean.length > max) fail(400, `${label} deve ter entre ${min} e ${max} caracteres.`);
  return clean;
}

function calendarDate(value, label) {
  const date = new Date(value + 'T00:00:00Z');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(date.valueOf()) || date.toISOString().slice(0, 10) !== value) {
    fail(400, label + ' inválida.');
  }
  return value;
}

function readLocation(form) {
  if (!form.has('street') && form.has('location')) {
    return [field(form.get('location'), 'Local', 5, 160), null, null, null, null, null, null];
  }
  const street = field(form.get('street'), 'Rua ou avenida', 3, 120);
  const number = field(form.get('number'), 'Número', 0, 20);
  const neighborhood = field(form.get('neighborhood'), 'Bairro', 2, 80);
  const city = field(form.get('city'), 'Município', 2, 80);
  const reference = field(form.get('reference'), 'Ponto de referência', 0, 160);
  const observedOn = calendarDate(form.get('observedOn'), 'Data da ocorrência');
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo' }).format();
  if (observedOn > today) fail(400, 'A data da ocorrência deve ser hoje ou anterior.');
  const location = [street + (number ? ', ' + number : ''), neighborhood, city].join(' · ');
  return [location, street, number || null, neighborhood, city, reference || null, observedOn];
}

const digest = (value) => createHash('sha256').update(value).digest();
const sessionDuration = 8 * 60 * 60;

async function readJson(request) {
  if (request.headers['content-type']?.split(';')[0] !== 'application/json') fail(415, 'Envie os dados em JSON.');
  const body = await readBody(request, 4096);
  try {
    return JSON.parse(body.toString());
  } catch {
    fail(400, 'Dados inválidos.');
  }
}

async function readPhoto(file) {
  if (!file || file.size === 0) return [null, null];
  if (typeof file.arrayBuffer !== 'function' || file.size > 2 * 1024 * 1024) {
    fail(400, 'Envie uma foto JPEG ou PNG de até 2 MB.');
  }
  const bytes = Buffer.from(await file.arrayBuffer());
  if (bytes.length >= 3 && bytes.subarray(0, 3).toString('hex') === 'ffd8ff') return [bytes, 'image/jpeg'];
  if (bytes.length >= 8 && bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') return [bytes, 'image/png'];
  fail(400, 'Use uma imagem JPEG ou PNG.');
}

export function createApp({ database = ':memory:', operatorUser, operatorPassword, secureCookies = false, classifier = suggestCategory } = {}) {
  if (database !== ':memory:') mkdirSync(dirname(database), { recursive: true });
  const db = new DatabaseSync(database);
  db.exec(`
    CREATE TABLE IF NOT EXISTS reports (
      protocol TEXT PRIMARY KEY, location TEXT NOT NULL, description TEXT NOT NULL,
      suggestion TEXT, category TEXT, photo BLOB, photo_type TEXT,
      status TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS history (
      id INTEGER PRIMARY KEY, protocol TEXT NOT NULL REFERENCES reports(protocol),
      status TEXT NOT NULL, recorded_at TEXT NOT NULL, note TEXT NOT NULL
    );
  `);
  transaction(() => {
    const columns = new Set(db.prepare('PRAGMA table_info(reports)').all().map(({ name }) => name));
    for (const column of ['street', 'street_number', 'neighborhood', 'city', 'reference', 'observed_on']) {
      if (!columns.has(column)) db.exec('ALTER TABLE reports ADD COLUMN ' + column + ' TEXT');
    }
  });
  const sessions = new Map();
  const expectedUser = digest(operatorUser ?? '');
  const expectedPassword = digest(operatorPassword ?? '');
  const sessionCookie = (token, age) => `calcada_session=${token}; Path=/api/operador; HttpOnly; SameSite=Strict; Max-Age=${age}${secureCookies ? '; Secure' : ''}`;
  const history = db.prepare('SELECT status, recorded_at AS recordedAt, note FROM history WHERE protocol = ? ORDER BY id');
  const publicReport = db.prepare('SELECT protocol, status, category, observed_on AS observedOn FROM reports WHERE protocol = ?');
  const addHistory = db.prepare('INSERT INTO history (protocol, status, recorded_at, note) VALUES (?, ?, ?, ?)');
  const operatorReports = db.prepare(`
    SELECT protocol, location, description, category, suggestion, status, created_at AS createdAt,
      street, street_number AS number, neighborhood, city, reference, observed_on AS observedOn,
      photo IS NOT NULL AS hasPhoto FROM reports
    WHERE (? IS NULL OR observed_on >= ?) AND (? IS NULL OR observed_on <= ?)
      AND (? IS NULL OR status = ?) AND (? IS NULL OR category = ?)
    ORDER BY created_at DESC, protocol
  `);

  function transaction(work) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  const server = createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' blob:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const send = (status, payload) => response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(payload));

    try {
      const { pathname, searchParams } = new URL(request.url, 'http://localhost');
      if (request.method === 'GET' && Object.hasOwn(assets, pathname)) {
        const [filename, type] = assets[pathname];
        const file = await readFile(new URL(`./public/${filename}`, import.meta.url));
        return response.writeHead(200, { 'Content-Type': type.startsWith('text/') ? `${type}; charset=utf-8` : type }).end(file);
      }

      if (request.method === 'POST' && pathname === '/api/relatos') {
        const type = request.headers['content-type'] ?? '';
        if (!type.startsWith('multipart/form-data;')) fail(415, 'Formato de formulário inválido.');
        const body = await readBody(request, 2 * 1024 * 1024 + 16384);
        let form;
        try {
          form = await new Response(body, { headers: { 'Content-Type': type } }).formData();
        } catch {
          fail(400, 'Formulário inválido.');
        }
        const [location, street, number, neighborhood, city, reference, observedOn] = readLocation(form);
        const description = field(form.get('description'), 'Descrição', 10, 600);
        const [photo, photoType] = await readPhoto(form.get('photo'));
        let suggestion = null;
        try {
          const result = await classifier(description);
          if (categories.includes(result)) suggestion = result;
        } catch {
          // O operador pode classificar o relato manualmente.
        }
        const protocol = `CL-${randomBytes(12).toString('hex').toUpperCase().match(/.{6}/g).join('-')}`;
        const now = new Date().toISOString();
        transaction(() => {
          db.prepare(`
            INSERT INTO reports (protocol, location, description, suggestion, photo, photo_type,
              status, created_at, street, street_number, neighborhood, city, reference, observed_on)
            VALUES (?, ?, ?, ?, ?, ?, 'Recebido', ?, ?, ?, ?, ?, ?, ?)
          `).run(protocol, location, description, suggestion, photo, photoType, now,
            street, number, neighborhood, city, reference, observedOn);
          addHistory.run(protocol, 'Recebido', now, 'Relato registrado e aguardando triagem.');
        });
        return send(201, { ...publicReport.get(protocol), history: history.all(protocol) });
      }

      const publicMatch = /^\/api\/relatos\/(CL-(?:[A-F0-9]{6}-){3}[A-F0-9]{6})$/i.exec(pathname);
      if (request.method === 'GET' && publicMatch) {
        const protocol = publicMatch[1].toUpperCase();
        const report = publicReport.get(protocol);
        if (!report) fail(404, 'Protocolo não encontrado.');
        return send(200, { ...report, history: history.all(protocol) });
      }

      if (pathname.startsWith('/api/operador/')) {
        if (!operatorUser || !operatorPassword) fail(503, 'Configure o usuário e a senha do operador no servidor.');
        const token = /(?:^|;\s*)calcada_session=([a-f0-9]{64})(?:;|$)/.exec(request.headers.cookie ?? '')?.[1];
        if (request.method === 'POST' && pathname === '/api/operador/sessao') {
          const credentials = await readJson(request);
          const user = field(credentials?.username, 'Usuário', 1, 128);
          const password = credentials?.password;
          if (typeof password !== 'string' || password.length < 1 || password.length > 512) fail(401, 'Usuário ou senha inválidos.');
          const userValid = timingSafeEqual(expectedUser, digest(user));
          const passwordValid = timingSafeEqual(expectedPassword, digest(password));
          if (!userValid || !passwordValid) fail(401, 'Usuário ou senha inválidos.');
          const now = Date.now();
          for (const [id, expires] of sessions) if (expires <= now) sessions.delete(id);
          sessions.delete(token);
          if (sessions.size >= 100) sessions.delete(sessions.keys().next().value);
          const id = randomBytes(32).toString('hex');
          sessions.set(id, now + sessionDuration * 1000);
          response.setHeader('Set-Cookie', sessionCookie(id, sessionDuration));
          return response.writeHead(204).end();
        }
        if (request.method === 'DELETE' && pathname === '/api/operador/sessao') {
          sessions.delete(token);
          response.setHeader('Set-Cookie', sessionCookie('', 0));
          return response.writeHead(204).end();
        }
        if (!(sessions.get(token) > Date.now())) {
          sessions.delete(token);
          fail(401, 'Entre com usuário e senha para acessar a triagem.');
        }
        if (request.method === 'GET' && pathname === '/api/operador/relatos') {
          const start = searchParams.get('start') || null;
          const end = searchParams.get('end') || null;
          const status = searchParams.get('status') || null;
          const category = searchParams.get('category') || null;
          if (start) calendarDate(start, 'Data inicial');
          if (end) calendarDate(end, 'Data final');
          if (start && end && start > end) fail(400, 'A data inicial deve ser anterior ou igual à final.');
          if (status && !Object.hasOwn(transitions, status)) fail(400, 'Status inválido.');
          if (category && !categories.includes(category)) fail(400, 'Categoria inválida.');
          const reports = operatorReports.all(start, start, end, end, status, status, category, category);
          return send(200, { reports, categories, transitions });
        }
        const match = /^\/api\/operador\/relatos\/([^/]+)(\/foto)?$/.exec(pathname);
        if (match) {
          const [, protocol, photoPath] = match;
          if (request.method === 'GET' && photoPath) {
            const attachment = db.prepare('SELECT photo, photo_type FROM reports WHERE protocol = ?').get(protocol);
            if (!attachment?.photo) fail(404, 'Foto não encontrada.');
            return response.writeHead(200, { 'Content-Type': attachment.photo_type }).end(attachment.photo);
          }
          if (request.method === 'PATCH' && !photoPath) {
            const update = await readJson(request);
            const { category, status } = update ?? {};
            if (!categories.includes(category)) fail(400, 'Selecione uma categoria.');
            const note = field(update?.note, 'Nota pública', 5, 300);
            const updated = transaction(() => {
              const current = publicReport.get(protocol);
              if (!current) fail(404, 'Protocolo não encontrado.');
              if (!transitions[current.status].includes(status)) fail(409, 'Mudança de status inválida. Recarregue a lista.');
              db.prepare('UPDATE reports SET status = ?, category = ? WHERE protocol = ?').run(status, category, protocol);
              addHistory.run(protocol, status, new Date().toISOString(), note);
              return { ...publicReport.get(protocol), history: history.all(protocol) };
            });
            return send(200, updated);
          }
        }
      }
      fail(404, 'Recurso não encontrado.');
    } catch (error) {
      if (!error.status) console.error(error);
      if (!response.headersSent) send(error.status ?? 500, error.status ? error.message : 'Erro ao processar a solicitação.');
    }
  });
  server.on('close', () => db.close());
  return server;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const port = Number(process.env.PORT ?? '3000');
  const host = process.env.HOST ?? '127.0.0.1';
  const classifier = process.env.CLASSIFIER_MODE === 'unavailable'
    ? () => { throw new Error('Classificador indisponível'); }
    : suggestCategory;
  createApp({ database: process.env.DATABASE_PATH ?? 'data/calcada-livre.sqlite', operatorUser: process.env.OPERATOR_USER,
    operatorPassword: process.env.OPERATOR_PASSWORD, secureCookies: process.env.SECURE_COOKIES === '1', classifier })
    .listen(port, host, () => console.log(`Calçada Livre em http://${host}:${port}`));
}
