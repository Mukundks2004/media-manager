const $ = (id) => document.getElementById(id);
let sessionId = null, treeData = null, uploadDir = '';
const expanded = new Set(['']);
const MAX = 10 * 1024 * 1024;

function msg(id, text, ok) { const e = $(id); e.textContent = text; e.className = 'msg ' + (ok ? 'ok' : 'err'); }

async function api(url, opts = {}) {
  opts.headers = { ...(opts.headers || {}), 'x-session-id': sessionId || '' };
  if (opts.json) { opts.method = 'POST'; opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(opts.json); }
  const r = await fetch(url, opts);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || r.statusText);
  return data;
}

function fmt(n) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i ? n.toFixed(1) : n) + ' ' + u[i];
}

$('checkBtn').onclick = async () => {
  try {
    const r = await api('/api/check', { json: { host: $('host').value.trim(), port: $('port').value } });
    msg('m1', `Reachable (${r.ms} ms).`, true);
    $('s2').disabled = false;
  } catch (e) { msg('m1', e.message); $('s2').disabled = true; }
};

$('connectBtn').onclick = async () => {
  try {
    const f = $('cert').files[0];
    if (!f) throw new Error('Choose a certificate / private key file.');
    const fd = new FormData();
    fd.append('host', $('host').value.trim()); fd.append('port', $('port').value);
    fd.append('username', $('user').value.trim()); fd.append('passphrase', $('pass').value);
    fd.append('cert', f);
    msg('m2', 'Connecting...', true);
    const r = await api('/api/connect', { method: 'POST', body: fd });
    sessionId = r.sessionId;
    msg('m2', 'Connected. ' + r.os, true);
    $('s3').disabled = false;
  } catch (e) { msg('m2', e.message); }
};

$('folderBtn').onclick = async () => {
  try {
    const r = await api('/api/folder', { json: { folder: $('folder').value } });
    msg('m3', `OK: cd and ls succeeded on ${r.root} (${r.entryCount} entries).`, true);
    $('s4').disabled = false;
    expanded.clear(); expanded.add(''); uploadDir = '';
    await refresh();
  } catch (e) { msg('m3', e.message); $('s4').disabled = true; }
};

async function refresh() {
  try {
    msg('m4', 'Loading...', true);
    treeData = await api('/api/tree');
    msg('m4', `Total: ${fmt(treeData.size)}`, true);
    render();
  } catch (e) { msg('m4', e.message); }
}
$('refreshBtn').onclick = refresh;

function render() {
  const body = $('tree'); body.innerHTML = '';
  $('upTarget').textContent = 'Upload into: /' + uploadDir + ' (click a folder to change)';
  const walk = (n, depth) => {
    const tr = document.createElement('tr');
    const isDir = n.type === 'dir';
    const name = document.createElement('td');
    name.style.paddingLeft = depth * 18 + 6 + 'px';
    const tog = document.createElement('span'); tog.className = 'toggle';
    tog.textContent = isDir ? (expanded.has(n.path) ? '▼' : '▶') : '';
    if (isDir) tog.onclick = () => { expanded.has(n.path) ? expanded.delete(n.path) : expanded.add(n.path); render(); };
    const label = document.createElement('span');
    label.textContent = (isDir ? '📁 ' : '📄 ') + n.name;
    if (isDir) { label.style.cursor = 'pointer'; label.onclick = () => { uploadDir = n.path; render(); }; }
    name.append(tog, label);
    const size = Object.assign(document.createElement('td'), { className: 'num', textContent: fmt(n.size) });
    const ext = Object.assign(document.createElement('td'), { textContent: n.ext });
    const act = document.createElement('td');
    if (n.path !== '') {
      if (!isDir) act.append(btn('Download', () => download(n)));
      act.append(btn('Rename', () => rename(n)));
    }
    tr.append(name, size, ext, act); body.append(tr);
    if (isDir && expanded.has(n.path)) n.children.forEach((c) => walk(c, depth + 1));
  };
  walk(treeData, 0);
}

function btn(text, fn) { return Object.assign(document.createElement('button'), { textContent: text, onclick: fn }); }

async function download(n) {
  try { const r = await api('/api/download', { json: { path: n.path } }); msg('m4', 'Saved to ' + r.localPath, true); }
  catch (e) { msg('m4', e.message); }
}

async function rename(n) {
  const newName = prompt('New name for ' + n.name, n.name);
  if (!newName || newName === n.name) return;
  try {
    await api('/api/rename', { json: { path: n.path, newName } });
    if (n.type === 'dir') expanded.delete(n.path);
    if (uploadDir === n.path || uploadDir.startsWith(n.path + '/')) uploadDir = '';
    await refresh();
  } catch (e) { msg('m4', e.message); }
}

$('uploadBtn').onclick = async () => {
  try {
    const f = $('upFile').files[0];
    if (!f) throw new Error('Choose a file to upload.');
    if (f.size > MAX) throw new Error('File exceeds 10MB limit.');
    const fd = new FormData();
    fd.append('dir', uploadDir); fd.append('file', f);
    await api('/api/upload', { method: 'POST', body: fd });
    $('upFile').value = '';
    await refresh();
    msg('m4', `Uploaded ${f.name}.`, true);
  } catch (e) { msg('m4', e.message); }
};
