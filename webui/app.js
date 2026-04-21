// ── Navigation ──────────────────────────────────────────────────────────
const pages = document.querySelectorAll('.page');
const navItems = document.querySelectorAll('.nav-item');

navItems.forEach(item => {
  item.addEventListener('click', () => {
    const target = item.dataset.page;
    navItems.forEach(n => n.classList.remove('active'));
    pages.forEach(p => p.classList.remove('active'));
    item.classList.add('active');
    document.getElementById('page-' + target).classList.add('active');
    if (target === 'schedules') loadSchedules();
    if (target === 'notes')     loadNotes();
    if (target === 'dashboard') refreshStatus();
  });
});

// ── Toast ────────────────────────────────────────────────────────────────
let _toastTimer;
function toast(msg, ok = true) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'show ' + (ok ? 'ok' : 'err');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { el.className = ''; }, 3000);
}

// ── API helpers ──────────────────────────────────────────────────────────
async function api(path, opts = {}) {
  try {
    const res = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      ...opts,
    });
    return await res.json();
  } catch (e) {
    return { error: String(e) };
  }
}

// ── Dashboard ────────────────────────────────────────────────────────────
async function refreshStatus() {
  const d = await api('/api/status');
  if (d.error) { toast('获取状态失败', false); return; }
  const wechatEl = document.getElementById('stat-wechat');
  wechatEl.textContent = d.wechat === 'connected' ? '已连接' : '未连接';
  wechatEl.className = 'stat-value ' + (d.wechat === 'connected' ? 'green' : 'red');
  document.getElementById('stat-ai').textContent = d.ai_provider + ' / ' + d.ai_model;
  document.getElementById('stat-uptime').textContent = d.uptime;
  document.getElementById('stat-queue').textContent = d.queue;
}

async function reconnect() {
  if (!confirm('确认发送重连信号？微信连接将被断开，bot 会自动重连。')) return;
  const d = await api('/api/reconnect', { method: 'POST' });
  toast(d.ok ? d.msg : (d.error || '操作失败'), d.ok);
}

// ── Logs ─────────────────────────────────────────────────────────────────
const logBox = document.getElementById('log-box');
const filterMap = { DEBUG: 'filter-debug', INFO: 'filter-info', WARNING: 'filter-warning', ERROR: 'filter-error', CRITICAL: 'filter-error' };
let logLines = [];

function appendLog(entry) {
  try {
    const d = typeof entry === 'string' ? JSON.parse(entry) : entry;
    logLines.push(d);
    if (logLines.length > 2000) logLines = logLines.slice(-2000);
    renderLogLine(d);
  } catch (_) {}
}

function renderLogLine(d) {
  const filterId = filterMap[d.lvl] || 'filter-debug';
  const checked = document.getElementById(filterId)?.checked;
  if (!checked) return;

  const line = document.createElement('div');
  line.className = 'log-line';
  line.dataset.lvl = d.lvl;
  line.innerHTML =
    `<span class="log-t">${d.t}</span>` +
    `<span class="log-lvl lvl-${d.lvl}">${d.lvl}</span>` +
    `<span class="log-msg">${escHtml(d.msg)}</span>`;
  logBox.appendChild(line);
  if (document.getElementById('autoscroll').checked) {
    logBox.scrollTop = logBox.scrollHeight;
  }
}

function clearLog() { logBox.innerHTML = ''; logLines = []; }

document.querySelectorAll('.log-controls input[type=checkbox]').forEach(cb => {
  cb.addEventListener('change', () => {
    logBox.innerHTML = '';
    logLines.forEach(renderLogLine);
    if (document.getElementById('autoscroll').checked) logBox.scrollTop = logBox.scrollHeight;
  });
});

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── WebSocket ─────────────────────────────────────────────────────────────
const wsStatus = document.getElementById('ws-status');
let ws, wsReconnectTimer;

function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws/logs`);
  ws.onopen = () => {
    wsStatus.innerHTML = '<span style="color:var(--green)">● WebSocket 已连接</span>';
  };
  ws.onmessage = e => appendLog(e.data);
  ws.onclose = () => {
    wsStatus.innerHTML = '<span style="color:var(--red)">● 已断开，重连中...</span>';
    clearTimeout(wsReconnectTimer);
    wsReconnectTimer = setTimeout(connectWs, 3000);
  };
  ws.onerror = () => ws.close();
}
connectWs();

// ── Schedules ────────────────────────────────────────────────────────────
async function loadSchedules() {
  const tbody = document.getElementById('schedules-tbody');
  tbody.innerHTML = '<tr><td colspan="6" style="color:var(--text-muted)">加载中...</td></tr>';
  const data = await api('/api/schedules');
  if (data.error) { tbody.innerHTML = `<tr><td colspan="6" style="color:var(--red)">${data.error}</td></tr>`; return; }
  if (!data.length) { tbody.innerHTML = '<tr><td colspan="6" style="color:var(--text-muted)">暂无日程</td></tr>'; return; }
  tbody.innerHTML = data.map(s => `
    <tr>
      <td>${escHtml(s.name)}</td>
      <td><span class="badge badge-gray">${s.datetime}</span></td>
      <td>${s.weekday}</td>
      <td style="color:var(--text-muted);max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(s.content)}</td>
      <td>${s.reminded_morning ? '<span class="badge badge-green">晨报✓</span>' : ''} ${s.reminded_before ? '<span class="badge badge-green">预报✓</span>' : ''}</td>
      <td><button class="btn btn-danger btn-sm" onclick="deleteSchedule(${s.id})">删除</button></td>
    </tr>`).join('');
}

async function deleteSchedule(id) {
  if (!confirm(`确认删除日程 #${id}？`)) return;
  const d = await api(`/api/schedules/${id}`, { method: 'DELETE' });
  toast(d.ok ? '已删除' : (d.error || '失败'), d.ok);
  if (d.ok) loadSchedules();
}

// ── Notes ────────────────────────────────────────────────────────────────
async function loadNotes() {
  const tbody = document.getElementById('notes-tbody');
  tbody.innerHTML = '<tr><td colspan="3" style="color:var(--text-muted)">加载中...</td></tr>';
  const data = await api('/api/notes');
  if (data.error) { tbody.innerHTML = `<tr><td colspan="3" style="color:var(--red)">${data.error}</td></tr>`; return; }
  if (!data.length) { tbody.innerHTML = '<tr><td colspan="3" style="color:var(--text-muted)">暂无笔记</td></tr>'; return; }
  tbody.innerHTML = data.map(n => `
    <tr>
      <td>${escHtml(n.name)}</td>
      <td style="color:var(--text-muted)">${new Date(n.mtime * 1000).toLocaleString('zh-CN')}</td>
      <td style="display:flex;gap:8px">
        <button class="btn btn-ghost btn-sm" onclick="viewNote('${escHtml(n.name)}')">查看</button>
        <button class="btn btn-danger btn-sm" onclick="deleteNote('${escHtml(n.name)}')">删除</button>
      </td>
    </tr>`).join('');
}

async function viewNote(name) {
  const d = await api(`/api/notes/${encodeURIComponent(name)}`);
  if (d.error) { toast('加载失败', false); return; }
  document.getElementById('note-viewer-title').textContent = '📝 ' + d.name;
  document.getElementById('note-content-box').textContent = d.content;
  document.getElementById('note-viewer').style.display = 'block';
  document.getElementById('note-viewer').scrollIntoView({ behavior: 'smooth' });
}

async function deleteNote(name) {
  if (!confirm(`确认删除笔记「${name}」？`)) return;
  const d = await api(`/api/notes/${encodeURIComponent(name)}`, { method: 'DELETE' });
  toast(d.ok ? '已删除' : (d.error || '失败'), d.ok);
  if (d.ok) { loadNotes(); document.getElementById('note-viewer').style.display = 'none'; }
}

// ── Send ─────────────────────────────────────────────────────────────────
async function sendMsg() {
  const to  = document.getElementById('send-to').value.trim();
  const msg = document.getElementById('send-msg').value.trim();
  if (!to || !msg) { toast('请填写接收方和消息内容', false); return; }
  const d = await api('/api/send', { method: 'POST', body: JSON.stringify({ to, msg }) });
  if (d.ok) {
    toast('已入队，等待发送');
    document.getElementById('send-msg').value = '';
  } else {
    toast(d.msg || d.error || '发送失败', false);
  }
}

// ── Init ─────────────────────────────────────────────────────────────────
refreshStatus();
setInterval(refreshStatus, 15000);
