// ── Utilities ───────────────────────────────────────────────────────────
function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function fmt(bytes){ if(bytes<1024) return bytes+'B'; if(bytes<1048576) return (bytes/1024).toFixed(1)+'KB'; return (bytes/1048576).toFixed(1)+'MB'; }
function fmtTime(ts){ return new Date(ts*1000).toLocaleString('zh-CN'); }

let _toastTimer;
function toast(msg, ok=true){
  const el=document.getElementById('toast');
  el.textContent=msg; el.className='show '+(ok?'ok':'err');
  clearTimeout(_toastTimer);
  _toastTimer=setTimeout(()=>{ el.className=''; },3000);
}

async function api(path, opts={}){
  try{
    const res=await fetch(path,{headers:{'Content-Type':'application/json'},...opts});
    return await res.json();
  }catch(e){ return {error:String(e)}; }
}

// ── Navigation ──────────────────────────────────────────────────────────
document.querySelectorAll('.nav-item').forEach(item=>{
  item.addEventListener('click',()=>{
    const target=item.dataset.page;
    document.querySelectorAll('.nav-item').forEach(n=>n.classList.remove('active'));
    document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
    item.classList.add('active');
    document.getElementById('page-'+target).classList.add('active');
    if(target==='dashboard') refreshStatus();
    if(target==='logs') { /* ws already running */ }
    if(target==='network') loadNetworkConfig();
    if(target==='files') { loadRawFiles(); }
    if(target==='data') { loadSchedules(); }
    if(target==='model') { loadProviders(); loadKeys(); loadMemory(); }
    if(target==='appearance') initAppearance();
  });
});

// ── Dashboard ────────────────────────────────────────────────────────────
async function refreshStatus(){
  const [s, sys, acct] = await Promise.all([
    api('/api/status'), api('/api/sysinfo'), api('/api/account')
  ]);
  if(!s.error){
    const el=document.getElementById('stat-wechat');
    el.textContent=s.wechat==='connected'?'已连接':'未连接';
    el.className='stat-value '+(s.wechat==='connected'?'green':'red');
    document.getElementById('stat-ai').textContent=s.ai_provider+' / '+s.ai_model;
    document.getElementById('stat-uptime').textContent=s.uptime;
    document.getElementById('stat-queue').textContent=s.queue;
  }
  if(!sys.error){
    document.getElementById('stat-cpu').textContent=sys.cpu!=null?sys.cpu+'%':'N/A';
    document.getElementById('stat-mem').textContent=sys.mem_pct!=null?sys.mem_pct+'%':'N/A';
  }
  if(!acct.error && acct.wxid){
    document.getElementById('account-wxid').textContent=acct.wxid;
    if(acct.name) document.getElementById('account-name').textContent=acct.name;
    if(acct.avatar){
      const av=document.getElementById('account-avatar');
      av.innerHTML=`<img src="${acct.avatar}" alt="avatar">`;
    }
  }
}

async function reconnect(){
  if(!confirm('确认发送重连信号？微信连接将被断开，bot 会自动重连。')) return;
  const d=await api('/api/reconnect',{method:'POST'});
  toast(d.ok?d.msg:(d.error||'操作失败'),d.ok);
}

// ── WebSocket Log ─────────────────────────────────────────────────────────
const logBox=document.getElementById('log-box');
const filterMap={DEBUG:'filter-debug',INFO:'filter-info',WARNING:'filter-warning',ERROR:'filter-error',CRITICAL:'filter-error'};
let logLines=[];

function appendLog(raw){
  try{
    const d=typeof raw==='string'?JSON.parse(raw):raw;
    logLines.push(d);
    if(logLines.length>2000) logLines=logLines.slice(-2000);
    renderLine(d);
  }catch(_){}
}

function renderLine(d){
  const fid=filterMap[d.lvl]||'filter-debug';
  if(!document.getElementById(fid)?.checked) return;
  const el=document.createElement('div');
  el.className='log-line'; el.dataset.lvl=d.lvl;
  el.innerHTML=`<span class="log-t">${d.t}</span><span class="log-lvl lvl-${d.lvl}">${d.lvl}</span><span class="log-msg">${esc(d.msg)}</span>`;
  logBox.appendChild(el);
  if(document.getElementById('autoscroll')?.checked) logBox.scrollTop=logBox.scrollHeight;
}

function clearLog(){ logBox.innerHTML=''; logLines=[]; }

document.querySelectorAll('.log-controls input[type=checkbox]').forEach(cb=>{
  cb.addEventListener('change',()=>{
    logBox.innerHTML='';
    logLines.forEach(renderLine);
    if(document.getElementById('autoscroll')?.checked) logBox.scrollTop=logBox.scrollHeight;
  });
});

const wsStatus=document.getElementById('ws-status');
let ws, wsTimer;
function connectWs(){
  const proto=location.protocol==='https:'?'wss':'ws';
  ws=new WebSocket(`${proto}://${location.host}/ws/logs`);
  ws.onopen=()=>{ wsStatus.innerHTML='<span style="color:var(--green)">● WebSocket 已连接</span>'; };
  ws.onmessage=e=>appendLog(e.data);
  ws.onclose=()=>{
    wsStatus.innerHTML='<span style="color:var(--red)">● 已断开，重连中...</span>';
    clearTimeout(wsTimer); wsTimer=setTimeout(connectWs,3000);
  };
  ws.onerror=()=>ws.close();
}
connectWs();

// ── Network ──────────────────────────────────────────────────────────────
async function loadNetworkConfig(){
  const d=await api('/api/network/config');
  if(d.error) return;
  document.getElementById('net-port').value=d.port;
  document.getElementById('net-port-hint').textContent=d.port;
  document.getElementById('net-token').value='';
  document.getElementById('net-token').placeholder=d.token_set?'已设置（留空不修改）':'留空则不鉴权';
}

function toggleTokenVisible(btn){
  const inp=document.getElementById('net-token');
  if(inp.type==='password'){ inp.type='text'; btn.textContent='隐藏'; }
  else{ inp.type='password'; btn.textContent='显示'; }
}

async function saveNetworkConfig(){
  const token=document.getElementById('net-token').value;
  const d=await api('/api/network/token',{method:'POST',body:JSON.stringify({token})});
  toast(d.ok?'Token 已保存':(d.error||'失败'),d.ok);
}

async function testPush(){
  const to=document.getElementById('net-test-to').value.trim();
  if(!to){ toast('请填写测试接收方',false); return; }
  const d=await api('/api/push_test',{method:'POST',body:JSON.stringify({to})});
  toast(d.ok?'测试消息已入队':(d.msg||d.error||'失败'),d.ok);
}

// ── Files ─────────────────────────────────────────────────────────────────
function switchFileTab(tab, el){
  document.querySelectorAll('#page-files .tab-btn').forEach(b=>b.classList.remove('active'));
  el.classList.add('active');
  document.getElementById('ftab-raw').style.display=tab==='raw'?'':'none';
  document.getElementById('ftab-converted').style.display=tab==='converted'?'':'none';
  if(tab==='raw') loadRawFiles();
  else loadConvertedFiles();
}

async function loadRawFiles(){
  const tbody=document.getElementById('raw-files-tbody');
  tbody.innerHTML='<tr><td colspan="4" style="color:var(--text-muted)">加载中...</td></tr>';
  const data=await api('/api/files/raw');
  if(data.error){ tbody.innerHTML=`<tr><td colspan="4" style="color:var(--red)">${esc(data.error)}</td></tr>`; return; }
  if(!data.length){ tbody.innerHTML='<tr><td colspan="4" style="color:var(--text-muted)">暂无文件</td></tr>'; return; }
  tbody.innerHTML=data.map(f=>`<tr>
    <td>${esc(f.name)}</td>
    <td style="color:var(--text-muted)">${fmt(f.size)}</td>
    <td style="color:var(--text-muted)">${fmtTime(f.mtime)}</td>
    <td class="td-actions"><button class="btn btn-ghost btn-sm" onclick="convertFile('${esc(f.name)}',this)">转化为 md</button></td>
  </tr>`).join('');
}

async function convertFile(name, btn){
  btn.disabled=true; btn.textContent='转化中...';
  const d=await api('/api/files/convert',{method:'POST',body:JSON.stringify({filename:name})});
  toast(d.ok?d.msg:(d.msg||d.error||'失败'),d.ok);
  btn.disabled=false; btn.textContent='转化为 md';
}

async function loadConvertedFiles(){
  const tbody=document.getElementById('converted-files-tbody');
  tbody.innerHTML='<tr><td colspan="4" style="color:var(--text-muted)">加载中...</td></tr>';
  const data=await api('/api/files/converted');
  if(data.error){ tbody.innerHTML=`<tr><td colspan="4" style="color:var(--red)">${esc(data.error)}</td></tr>`; return; }
  if(!data.length){ tbody.innerHTML='<tr><td colspan="4" style="color:var(--text-muted)">暂无文件</td></tr>'; return; }
  tbody.innerHTML=data.map(f=>`<tr>
    <td>${esc(f.name)}</td>
    <td style="color:var(--text-muted)">${fmt(f.size)}</td>
    <td style="color:var(--text-muted)">${fmtTime(f.mtime)}</td>
    <td class="td-actions"><button class="btn btn-danger btn-sm" onclick="deleteConverted('${esc(f.name)}')">删除</button></td>
  </tr>`).join('');
}

async function deleteConverted(name){
  if(!confirm(`确认删除 ${name}？`)) return;
  const d=await api('/api/files/converted/'+encodeURIComponent(name),{method:'DELETE'});
  toast(d.ok?'已删除':(d.error||'失败'),d.ok);
  if(d.ok) loadConvertedFiles();
}

// ── Data: Schedules ───────────────────────────────────────────────────────
function switchDataTab(tab, el){
  document.querySelectorAll('#page-data .tab-btn').forEach(b=>b.classList.remove('active'));
  el.classList.add('active');
  document.getElementById('dtab-schedules').style.display=tab==='schedules'?'':'none';
  document.getElementById('dtab-notes').style.display=tab==='notes'?'':'none';
  if(tab==='schedules') loadSchedules();
  else loadNotes();
}

let _editingSchId=null;
async function loadSchedules(){
  const tbody=document.getElementById('schedules-tbody');
  tbody.innerHTML='<tr><td colspan="6" style="color:var(--text-muted)">加载中...</td></tr>';
  const data=await api('/api/schedules');
  if(data.error){ tbody.innerHTML=`<tr><td colspan="6" style="color:var(--red)">${esc(data.error)}</td></tr>`; return; }
  if(!data.length){ tbody.innerHTML='<tr><td colspan="6" style="color:var(--text-muted)">暂无日程</td></tr>'; return; }
  tbody.innerHTML=data.map(s=>`<tr>
    <td>${esc(s.name)}</td>
    <td><span class="badge badge-gray">${s.datetime}</span></td>
    <td>${s.weekday}</td>
    <td style="color:var(--text-muted);max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(s.content)}</td>
    <td>${s.reminded_morning?'<span class="badge badge-green">晨报✓</span>':''} ${s.reminded_before?'<span class="badge badge-green">预报✓</span>':''}</td>
    <td class="td-actions">
      <button class="btn btn-ghost btn-sm" onclick="editSchedule(${s.id},'${esc(s.name)}','${esc(s.content)}')">编辑</button>
      <button class="btn btn-danger btn-sm" onclick="deleteSchedule(${s.id})">删除</button>
    </td>
  </tr>`).join('');
}

function editSchedule(id, name, content){
  _editingSchId=id;
  document.getElementById('sch-edit-name').value=name;
  document.getElementById('sch-edit-content').value=content;
  const p=document.getElementById('sch-edit-panel');
  p.style.display=''; p.scrollIntoView({behavior:'smooth'});
}

async function saveScheduleEdit(){
  if(!_editingSchId) return;
  const name=document.getElementById('sch-edit-name').value;
  const content=document.getElementById('sch-edit-content').value;
  const d=await api('/api/schedules/'+_editingSchId,{method:'PUT',body:JSON.stringify({name,content})});
  toast(d.ok?'已保存':(d.error||'失败'),d.ok);
  if(d.ok){ document.getElementById('sch-edit-panel').style.display='none'; loadSchedules(); }
}

async function deleteSchedule(id){
  if(!confirm(`确认删除日程 #${id}？`)) return;
  const d=await api('/api/schedules/'+id,{method:'DELETE'});
  toast(d.ok?'已删除':(d.error||'失败'),d.ok);
  if(d.ok) loadSchedules();
}

// ── Data: Notes ───────────────────────────────────────────────────────────
let _editingNoteName=null;
async function loadNotes(){
  const tbody=document.getElementById('notes-tbody');
  tbody.innerHTML='<tr><td colspan="3" style="color:var(--text-muted)">加载中...</td></tr>';
  const data=await api('/api/notes');
  if(data.error){ tbody.innerHTML=`<tr><td colspan="3" style="color:var(--red)">${esc(data.error)}</td></tr>`; return; }
  if(!data.length){ tbody.innerHTML='<tr><td colspan="3" style="color:var(--text-muted)">暂无笔记</td></tr>'; return; }
  tbody.innerHTML=data.map(n=>`<tr>
    <td>${esc(n.name)}</td>
    <td style="color:var(--text-muted)">${fmtTime(n.mtime)}</td>
    <td class="td-actions">
      <button class="btn btn-ghost btn-sm" onclick="editNote('${esc(n.name)}')">查看/编辑</button>
      <button class="btn btn-danger btn-sm" onclick="deleteNote('${esc(n.name)}')">删除</button>
    </td>
  </tr>`).join('');
}

async function editNote(name){
  const d=await api('/api/notes/'+encodeURIComponent(name));
  if(d.error){ toast('加载失败',false); return; }
  _editingNoteName=name;
  document.getElementById('note-edit-title').textContent='📝 '+d.name;
  document.getElementById('note-edit-content').value=d.content;
  const p=document.getElementById('note-edit-panel');
  p.style.display=''; p.scrollIntoView({behavior:'smooth'});
}

async function saveNoteEdit(){
  if(!_editingNoteName) return;
  const content=document.getElementById('note-edit-content').value;
  const d=await api('/api/notes/'+encodeURIComponent(_editingNoteName),{method:'PUT',body:JSON.stringify({content})});
  toast(d.ok?'已保存':(d.error||'失败'),d.ok);
  if(d.ok) loadNotes();
}

async function deleteNote(name){
  if(!confirm(`确认删除笔记「${name}」？`)) return;
  const d=await api('/api/notes/'+encodeURIComponent(name),{method:'DELETE'});
  toast(d.ok?'已删除':(d.error||'失败'),d.ok);
  if(d.ok){ loadNotes(); document.getElementById('note-edit-panel').style.display='none'; }
}

// ── Model: Providers ──────────────────────────────────────────────────────
async function loadProviders(){
  const d=await api('/api/model/provider');
  if(d.error) return;
  const grid=document.getElementById('provider-grid');
  grid.innerHTML=(d.available||[]).map(p=>`<div class="provider-card${p===d.provider?' active':''}" onclick="switchProvider('${p}',this)">${p}</div>`).join('');
}

async function switchProvider(p, el){
  const d=await api('/api/model/provider',{method:'POST',body:JSON.stringify({provider:p})});
  if(d.ok){
    document.querySelectorAll('.provider-card').forEach(c=>c.classList.remove('active'));
    el.classList.add('active');
    toast(`已切换到 ${p} / ${d.model}`);
    refreshStatus();
  } else {
    toast(d.msg||'切换失败',false);
  }
}

// ── Model: API Keys ───────────────────────────────────────────────────────
let _keyModalProvider=null;
async function loadKeys(){
  const d=await api('/api/model/keys');
  if(d.error) return;
  const tbody=document.getElementById('keys-tbody');
  tbody.innerHTML=Object.entries(d).map(([p,info])=>`<tr>
    <td><strong>${p}</strong></td>
    <td style="color:var(--text-muted);font-family:var(--font-mono);font-size:12px">${esc(info.model)}</td>
    <td><span class="badge ${info.set?'badge-green':'badge-gray'}">${info.set?info.masked:'未设置'}</span></td>
    <td><button class="btn btn-ghost btn-sm" onclick="openKeyModal('${p}')">修改</button></td>
  </tr>`).join('');
}

function openKeyModal(provider){
  _keyModalProvider=provider;
  document.getElementById('key-modal-title').textContent='修改 '+provider+' API Key';
  document.getElementById('key-modal-input').value='';
  document.getElementById('key-modal').style.display='flex';
  setTimeout(()=>document.getElementById('key-modal-input').focus(),50);
}

function closeKeyModal(){
  document.getElementById('key-modal').style.display='none';
  _keyModalProvider=null;
}

async function submitKeyModal(){
  const key=document.getElementById('key-modal-input').value.trim();
  if(!key){ toast('Key 不能为空',false); return; }
  const d=await api('/api/model/keys',{method:'POST',body:JSON.stringify({provider:_keyModalProvider,key})});
  toast(d.ok?'Key 已更新':(d.error||'失败'),d.ok);
  if(d.ok){ closeKeyModal(); loadKeys(); }
}

// ── Model: Memory ─────────────────────────────────────────────────────────
let _editingMemName=null;
async function loadMemory(){
  const tbody=document.getElementById('memory-tbody');
  tbody.innerHTML='<tr><td colspan="5" style="color:var(--text-muted)">加载中...</td></tr>';
  const data=await api('/api/memory');
  if(data.error){ tbody.innerHTML=`<tr><td colspan="5" style="color:var(--red)">${esc(data.error)}</td></tr>`; return; }
  if(!data.length){ tbody.innerHTML='<tr><td colspan="5" style="color:var(--text-muted)">暂无 memory</td></tr>'; return; }
  tbody.innerHTML=data.map(m=>`<tr>
    <td>${esc(m.name)}</td>
    <td style="color:var(--text-muted)">${fmt(m.size)}</td>
    <td style="color:var(--text-muted)">${fmtTime(m.mtime)}</td>
    <td>
      <label class="toggle" title="${m.enabled?'已启用，点击禁用':'已禁用，点击启用'}">
        <input type="checkbox" ${m.enabled?'checked':''} onchange="toggleMemory('${esc(m.name)}',this)">
        <div class="toggle-track"></div>
      </label>
    </td>
    <td class="td-actions">
      <button class="btn btn-ghost btn-sm" onclick="editMemory('${esc(m.name)}')">查看/编辑</button>
      <button class="btn btn-danger btn-sm" onclick="deleteMemory('${esc(m.name)}')">删除</button>
    </td>
  </tr>`).join('');
}

async function toggleMemory(name, cb){
  const d=await api('/api/memory/'+encodeURIComponent(name)+'/toggle',{method:'POST'});
  if(!d.ok){ cb.checked=!cb.checked; toast('操作失败',false); }
  else toast(d.enabled?name+' 已启用':name+' 已禁用');
}

async function editMemory(name){
  const d=await api('/api/memory/'+encodeURIComponent(name));
  if(d.error){ toast('加载失败',false); return; }
  _editingMemName=name;
  document.getElementById('mem-edit-title').textContent='Memory: '+d.name;
  document.getElementById('mem-edit-content').value=d.content;
  const p=document.getElementById('mem-edit-panel');
  p.style.display=''; p.scrollIntoView({behavior:'smooth'});
}

async function saveMemoryEdit(){
  if(!_editingMemName) return;
  const content=document.getElementById('mem-edit-content').value;
  const d=await api('/api/memory/'+encodeURIComponent(_editingMemName),{method:'PUT',body:JSON.stringify({content})});
  toast(d.ok?'已保存':(d.error||'失败'),d.ok);
  if(d.ok) loadMemory();
}

async function deleteMemory(name){
  if(!confirm(`确认删除 Memory「${name}」？`)) return;
  const d=await api('/api/memory/'+encodeURIComponent(name),{method:'DELETE'});
  toast(d.ok?'已删除':(d.error||'失败'),d.ok);
  if(d.ok){ loadMemory(); document.getElementById('mem-edit-panel').style.display='none'; }
}

// ── Send ──────────────────────────────────────────────────────────────────
async function sendMsg(){
  const to=document.getElementById('send-to').value.trim();
  const msg=document.getElementById('send-msg').value.trim();
  if(!to||!msg){ toast('请填写接收方和消息内容',false); return; }
  const d=await api('/api/send',{method:'POST',body:JSON.stringify({to,msg})});
  if(d.ok){ toast('已入队，等待发送'); document.getElementById('send-msg').value=''; }
  else toast(d.msg||d.error||'发送失败',false);
}

// ── Appearance ────────────────────────────────────────────────────────────
const CSS_VARS=[
  ['--bg','背景色'],['--surface','卡片背景'],['--surface2','次级背景'],
  ['--border','边框色'],['--text','主文字'],['--text-muted','次要文字'],
  ['--accent','强调色'],['--accent-h','强调悬停'],['--green','绿色'],
  ['--red','红色'],['--yellow','黄色'],['--blue','蓝色'],
];

function initAppearance(){
  const saved=localStorage.getItem('wechatbot_theme')||'dark';
  document.querySelectorAll('.theme-card').forEach(c=>{
    c.classList.toggle('active',c.dataset.theme===saved);
  });
  const grid=document.getElementById('color-grid');
  if(grid.children.length) return;
  grid.innerHTML=CSS_VARS.map(([v,label])=>{
    const color=getComputedStyle(document.documentElement).getPropertyValue(v).trim();
    return `<div class="color-item" onclick="pickColor('${v}',this)">
      <div class="color-swatch" id="swatch-${v.replace(/--/,'').replace(/-/g,'_')}" style="background:${color}"></div>
      <div class="color-name">${label}<br><span style="font-size:10px;color:var(--text-muted)">${v}</span></div>
    </div>`;
  }).join('');
}

function applyTheme(name, el){
  document.querySelectorAll('.theme-card').forEach(c=>c.classList.remove('active'));
  el.classList.add('active');
  if(name==='heroui') document.body.classList.add('theme-heroui');
  else document.body.classList.remove('theme-heroui');
  localStorage.setItem('wechatbot_theme',name);
  toast('主题已切换');
}

function pickColor(cssVar, item){
  const inp=document.createElement('input');
  inp.type='color';
  const cur=getComputedStyle(document.documentElement).getPropertyValue(cssVar).trim();
  inp.value=cur.startsWith('#')?cur:'#888888';
  inp.style.cssText='position:absolute;opacity:0;width:0;height:0;';
  document.body.appendChild(inp);
  inp.click();
  inp.addEventListener('input',()=>{
    document.documentElement.style.setProperty(cssVar,inp.value);
    const swatchId='swatch-'+cssVar.replace(/--/,'').replace(/-/g,'_');
    const sw=document.getElementById(swatchId);
    if(sw) sw.style.background=inp.value;
  });
  inp.addEventListener('change',()=>{ document.body.removeChild(inp); });
}

function saveCustomColors(){
  const custom={};
  CSS_VARS.forEach(([v])=>{
    const val=document.documentElement.style.getPropertyValue(v);
    if(val) custom[v]=val;
  });
  localStorage.setItem('wechatbot_colors',JSON.stringify(custom));
  toast('配色已保存');
}

function resetCustomColors(){
  localStorage.removeItem('wechatbot_colors');
  CSS_VARS.forEach(([v])=>document.documentElement.style.removeProperty(v));
  toast('已重置为默认配色');
  initAppearance();
}

function loadSavedAppearance(){
  const theme=localStorage.getItem('wechatbot_theme');
  if(theme==='heroui') document.body.classList.add('theme-heroui');
  try{
    const colors=JSON.parse(localStorage.getItem('wechatbot_colors')||'{}');
    Object.entries(colors).forEach(([v,c])=>document.documentElement.style.setProperty(v,c));
  }catch(_){}
}

// ── Init ──────────────────────────────────────────────────────────────────
loadSavedAppearance();
refreshStatus();
setInterval(refreshStatus,15000);
