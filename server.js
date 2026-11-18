import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

const categories = ['Rampa obstruída', 'Calçada danificada', 'Travessia inacessível', 'Outra barreira'];
const transitions = { Recebido: ['Em análise'], 'Em análise': ['Encaminhado'], Encaminhado: ['Resolvido'], Resolvido: [] };
const assets = {
  '/': ['index.html', 'text/html'],
  '/app.js': ['app.js', 'text/javascript'],
  '/style.css': ['style.css', 'text/css'],
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

export function createApp({ database = ':memory:', operatorKey, classifier = suggestCategory } = {}) {
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
  const history = db.prepare('SELECT status, recorded_at AS recordedAt, note FROM history WHERE protocol = ? ORDER BY id');
  const publicReport = db.prepare('SELECT protocol, status, category FROM reports WHERE protocol = ?');
  const addHistory = db.prepare('INSERT INTO history (protocol, status, recorded_at, note) VALUES (?, ?, ?, ?)');
  const operatorReports = db.prepare(`
    SELECT protocol, location, description, category, suggestion, status, created_at AS createdAt,
      photo IS NOT NULL AS hasPhoto FROM reports ORDER BY created_at DESC
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
      const { pathname } = new URL(request.url, 'http://localhost');
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
        const location = field(form.get('location'), 'Local', 5, 160);
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
          db.prepare(`INSERT INTO reports VALUES (?, ?, ?, ?, NULL, ?, ?, 'Recebido', ?)`)
            .run(protocol, location, description, suggestion, photo, photoType, now);
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
        if (!operatorKey) fail(503, 'Defina a chave do operador no servidor.');
        const expected = Buffer.from(`Bearer ${operatorKey}`);
        const supplied = Buffer.from(request.headers.authorization ?? '');
        if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) fail(401, 'Chave do operador inválida.');
        if (request.method === 'GET' && pathname === '/api/operador/relatos') {
          return send(200, { reports: operatorReports.all(), categories, transitions });
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
            let update;
            const body = await readBody(request, 4096);
            try {
              update = JSON.parse(body.toString());
            } catch {
              fail(400, 'Atualização inválida.');
            }
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
  createApp({ database: process.env.DATABASE_PATH ?? 'data/calcada-livre.sqlite', operatorKey: process.env.OPERATOR_KEY, classifier })
    .listen(port, host, () => console.log(`Calçada Livre em http://${host}:${port}`));
}
