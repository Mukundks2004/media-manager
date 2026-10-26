const express = require('express');
const multer = require('multer');
const net = require('net');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Client } = require('ssh2');

const MAX_UPLOAD = 10 * 1024 * 1024;
const DOWNLOAD_DIR = path.join(__dirname, 'downloads');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD, files: 1 } });

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// sessionId -> { conn, sftp, root }
const sessions = new Map();

const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const wrap = (fn) => (req, res) => fn(req, res).catch((e) => res.status(e.status || 500).json({ error: e.message }));
const fail = (status, message) => Object.assign(new Error(message), { status });

function getSession(req) {
  const s = sessions.get(req.get('x-session-id'));
  if (!s) throw fail(401, 'Not connected. Connect to the server first.');
  return s;
}

function requireRoot(s) {
  if (!s.root) throw fail(400, 'Set a folder first.');
}

// Resolve a path relative to the chosen root and ensure it cannot escape it.
function resolveInRoot(s, rel, allowRoot = true) {
  requireRoot(s);
  const full = path.posix.normalize(path.posix.join(s.root, String(rel || '')));
  const inside = full === s.root || full.startsWith(s.root === '/' ? '/' : s.root + '/');
  if (!inside || (!allowRoot && full === s.root)) throw fail(400, 'Path is outside the managed folder.');
  return full;
}

function exec(conn, cmd) {
  return new Promise((resolve, reject) => {
    conn.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let out = '', errOut = '';
      stream.on('data', (d) => (out += d));
      stream.stderr.on('data', (d) => (errOut += d));
      stream.on('close', (code) => resolve({ code, out, err: errOut }));
    });
  });
}

const sftpCall = (s, method, ...args) =>
  new Promise((resolve, reject) => s.sftp[method](...args, (e, r) => (e ? reject(e) : resolve(r))));

app.post('/api/check', wrap(async (req, res) => {
  const { host, port = 22 } = req.body;
  if (!host) throw fail(400, 'Server name is required.');
  const start = Date.now();
  await new Promise((resolve, reject) => {
    const sock = net.connect({ host, port: Number(port), timeout: 5000 }, () => { sock.destroy(); resolve(); });
    sock.on('timeout', () => { sock.destroy(); reject(new Error('Connection timed out.')); });
    sock.on('error', (e) => reject(new Error(`Cannot reach ${host}:${port} - ${e.message}`)));
  });
  res.json({ ok: true, ms: Date.now() - start });
}));

app.post('/api/connect', upload.single('cert'), wrap(async (req, res) => {
  const { host, port = 22, username = 'ubuntu', passphrase } = req.body;
  if (!host || !req.file) throw fail(400, 'Server name and certificate (private key) are required.');
  const conn = new Client();
  await new Promise((resolve, reject) => {
    conn.on('ready', resolve).on('error', reject).connect({
      host, port: Number(port), username,
      privateKey: req.file.buffer,
      passphrase: passphrase || undefined,
      readyTimeout: 10000,
    });
  }).catch((e) => { throw fail(400, `SSH failed: ${e.message}`); });
  const sftp = await new Promise((resolve, reject) => conn.sftp((e, s) => (e ? reject(e) : resolve(s))));
  const id = crypto.randomUUID();
  const session = { conn, sftp, root: null };
  sessions.set(id, session);
  conn.on('close', () => sessions.delete(id));
  const { out } = await exec(conn, 'lsb_release -ds 2>/dev/null || head -n1 /etc/os-release');
  res.json({ sessionId: id, os: out.trim() });
}));

app.post('/api/disconnect', wrap(async (req, res) => {
  const s = getSession(req);
  s.conn.end();
  sessions.delete(req.get('x-session-id'));
  res.json({ ok: true });
}));

app.post('/api/folder', wrap(async (req, res) => {
  const s = getSession(req);
  const folder = String(req.body.folder || '').trim();
  if (!folder) throw fail(400, 'Folder is required.');
  const r = await exec(s.conn, `cd ${q(folder)} && pwd -P && ls`);
  if (r.code !== 0) throw fail(400, `Cannot cd/ls "${folder}": ${r.err.trim() || 'exit ' + r.code}`);
  const [real, ...entries] = r.out.split('\n').filter(Boolean);
  s.root = real;
  res.json({ ok: true, root: real, entryCount: entries.length });
}));

app.get('/api/tree', wrap(async (req, res) => {
  const s = getSession(req);
  requireRoot(s);
  // type, size, relative path; NUL-terminated so odd filenames are safe
  const r = await exec(s.conn, `cd ${q(s.root)} && find . -mindepth 1 -printf '%y\\t%s\\t%P\\0'`);
  if (r.code !== 0 && !r.out) throw fail(500, r.err.trim() || 'find failed');
  const nodes = new Map();
  const rootNode = { name: path.posix.basename(s.root) || '/', path: '', type: 'dir', size: 0, ext: '', children: [] };
  nodes.set('', rootNode);
  const items = r.out.split('\0').filter(Boolean).map((l) => {
    const i1 = l.indexOf('\t'), i2 = l.indexOf('\t', i1 + 1);
    return { y: l.slice(0, i1), size: Number(l.slice(i1 + 1, i2)), p: l.slice(i2 + 1) };
  }).sort((a, b) => a.p.length - b.p.length);
  for (const it of items) {
    const isDir = it.y === 'd';
    const name = path.posix.basename(it.p);
    const node = { name, path: it.p, type: isDir ? 'dir' : 'file', size: isDir ? 0 : it.size, ext: isDir ? '' : path.posix.extname(name).slice(1), children: [] };
    nodes.set(it.p, node);
    const parent = nodes.get(path.posix.dirname(it.p) === '.' ? '' : path.posix.dirname(it.p));
    if (parent) parent.children.push(node);
  }
  const total = (n) => { for (const c of n.children) n.size += total(c); return n.size; };
  total(rootNode);
  const sort = (n) => { n.children.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1)); n.children.forEach(sort); };
  sort(rootNode);
  res.json(rootNode);
}));

app.post('/api/upload', (req, res, next) => upload.single('file')(req, res, (err) => {
  if (err) return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'File exceeds 10MB limit.' : err.message });
  next();
}), wrap(async (req, res) => {
  const s = getSession(req);
  if (!req.file) throw fail(400, 'No file provided.');
  const name = path.posix.basename(req.file.originalname.replace(/\\/g, '/'));
  const dest = resolveInRoot(s, path.posix.join(req.body.dir || '', name), false);
  await new Promise((resolve, reject) => s.sftp.writeFile(dest, req.file.buffer, (e) => (e ? reject(e) : resolve())));
  res.json({ ok: true, path: dest });
}));

app.post('/api/download', wrap(async (req, res) => {
  const s = getSession(req);
  const full = resolveInRoot(s, req.body.path, false);
  const st = await sftpCall(s, 'stat', full);
  if (st.isDirectory()) throw fail(400, 'Cannot download a folder.');
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  const local = path.join(DOWNLOAD_DIR, path.basename(full));
  await new Promise((resolve, reject) => s.sftp.fastGet(full, local, (e) => (e ? reject(e) : resolve())));
  res.json({ ok: true, localPath: local });
}));

app.post('/api/rename', wrap(async (req, res) => {
  const s = getSession(req);
  const newName = String(req.body.newName || '').trim();
  if (!newName || newName.includes('/') || newName === '.' || newName === '..') throw fail(400, 'Invalid new name.');
  const from = resolveInRoot(s, req.body.path, false);
  const to = path.posix.join(path.posix.dirname(from), newName);
  await sftpCall(s, 'rename', from, to);
  res.json({ ok: true });
}));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '127.0.0.1', () => console.log(`Media Manager running at http://localhost:${PORT}`));
