// ── Utilities ──────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
function esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function fmtBytes(b){ if(!b)return'0B'; if(b<1024)return b+'B'; if(b<1048576)return(b/1024).toFixed(1)+'KB'; return(b/1048576).toFixed(1)+'MB'; }
function fmtTime(ts){ return new Date(ts*1000).toLocaleString('zh-CN'); }

let _toastTimer;
function toast(msg, ok=true){
  const el=$('toast');
  el.textContent=msg; el.className='toast show '+(ok?'ok':'err');
  clearTimeout(_toastTimer);
  _toastTimer=setTimeout(()=>{ el.className='toast hidden'; },3000);
}

let _noticeTimer;
function showActionNotice(msg, type='info', sticky=false){
  const el=$('action-notice');
  if(!el) return;
  el.textContent=msg;
  el.className='action-notice show '+type;
  clearTimeout(_noticeTimer);
  if(!sticky){
    _noticeTimer=setTimeout(()=>{ el.className='action-notice hidden'; }, 3200);
  }
}

function hideActionNotice(){
  const el=$('action-notice');
  if(!el) return;
  clearTimeout(_noticeTimer);
  el.className='action-notice hidden';
}

async function api(path,opts={}){
  try{
    const r=await fetch(path,{headers:{'Content-Type':'application/json'},...opts});
    const text=await r.text();
    try{ return JSON.parse(text); }
    catch(e){ return {error:`JSON parse error: ${text.slice(0,100)}`}; }
  }catch(e){ return {error:String(e)}; }
}

// ── Navigation ─────────────────────────────────────────────────────────
document.querySelectorAll('.nav-item').forEach(item=>{
  item.addEventListener('click',()=>{
    const pg=item.dataset.page;
    document.querySelectorAll('.nav-item').forEach(n=>n.classList.remove('active'));
    document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
    item.classList.add('active');
    $('page-'+pg).classList.add('active');
    const actions={
      dashboard:()=>{ refreshStatus(); refreshAccount(); },
      network:loadNetConfig,
      files:()=>{ loadRawFiles(); loadConvertQueue().then(()=>{ if(hasActiveQueue()) startQueuePolling(); }); },
      data:loadSchedules,
      model:()=>{ loadProviders(); loadKeys(); loadMemory(); },
      appearance:initAppearance,
    };
    if(actions[pg]) actions[pg]();
  });
});

// ── Account / Dashboard ────────────────────────────────────────────────
async function refreshAccount(){
  const d=await api('/api/account');
  if(d.error||!d.wxid) return;
  $('account-wxid').textContent=d.wxid||'已连接';
  if(d.name){ $('account-name').textContent=d.name; }
  if(d.avatar){
    $('av-initials').classList.add('hidden');
    const img=$('av-img');
    img.src=d.avatar; img.classList.remove('hidden');
  }
}

async function refreshStatus(){
  const [s,sys]=await Promise.all([api('/api/status'),api('/api/sysinfo')]);
  if(!s.error){
    const el=$('s-wechat');
    el.textContent=s.wechat==='connected'?'已连接':'未连接';
    el.style.color=s.wechat==='connected'?'var(--green)':'var(--red)';
    $('s-ai').textContent=(s.ai_provider||'')+(s.ai_model?'/'+s.ai_model:'');
    $('s-uptime').textContent=s.uptime||'—';
    $('s-queue').textContent=s.queue??'—';
  }
  if(!sys.error){
    $('s-cpu').textContent=sys.cpu!=null?sys.cpu+'%':'N/A';
    $('s-mem').textContent=sys.mem_pct!=null?sys.mem_pct+'%':'N/A';
  }
}

async function reconnect(){
  if(!confirm('确认发送重连信号？')) return;
  const d=await api('/api/reconnect',{method:'POST'});
  toast(d.ok?d.msg:(d.error||'失败'),d.ok);
}

// ── SSE Log ────────────────────────────────────────────────────────────
const logBox=$('log-box');
let logLines=[], sseSource=null;

const lvlFilter={DEBUG:'f-debug',INFO:'f-info',WARNING:'f-warning',ERROR:'f-error',CRITICAL:'f-error'};

function renderLogLine(d){
  const fid=lvlFilter[d.lvl]||'f-debug';
  if(!$(fid)?.checked) return;
  const el=document.createElement('div');
  el.className=`log-line lvl-${d.lvl}`; el.dataset.lvl=d.lvl;
  el.innerHTML=`<span class="log-t">${d.t}</span><span class="log-lvl">${d.lvl}</span><span class="log-msg">${esc(d.msg)}</span>`;
  logBox.appendChild(el);
  if($('f-autoscroll')?.checked) logBox.scrollTop=logBox.scrollHeight;
  if(logBox.children.length>2000) logBox.removeChild(logBox.firstChild);
}

function clearLog(){ logBox.innerHTML=''; logLines=[]; }

document.querySelectorAll('#log-controls input[type=checkbox]').forEach(cb=>{
  cb.addEventListener('change',()=>{
    logBox.innerHTML='';
    logLines.forEach(renderLogLine);
    if($('f-autoscroll')?.checked) logBox.scrollTop=logBox.scrollHeight;
  });
});

function connectSSE(){
  if(sseSource){ sseSource.close(); }
  sseSource=new EventSource('/api/logs/stream');
  const dot=$('sse-status');
  sseSource.onopen=()=>{ dot.innerHTML='<span class="status-dot bg-green-500" style="background:var(--green)"></span>日志已连接'; };
  sseSource.onmessage=e=>{
    try{ const d=JSON.parse(e.data); logLines.push(d); renderLogLine(d); }catch(_){}
  };
  sseSource.onerror=()=>{
    dot.innerHTML='<span class="status-dot" style="background:var(--red)"></span>已断开，重连中...';
    sseSource.close(); sseSource=null;
    setTimeout(connectSSE,3000);
  };
}
connectSSE();
const sseStatusEl=$('sse-status');

// ── Network ────────────────────────────────────────────────────────────
async function loadNetConfig(){
  const d=await api('/api/network/config');
  if(d.error){ toast('加载配置失败',false); return; }
  $('net-port').value=d.port||'5700';
  $('net-push-url').value=`http://127.0.0.1:${d.port||5700}/notify`;
  $('net-token').placeholder=d.token_set?'已设置（留空不修改）':'留空则不鉴权';
}

function toggleTokenVis(btn){
  const inp=$('net-token');
  if(inp.type==='password'){ inp.type='text'; btn.textContent='隐藏'; }
  else{ inp.type='password'; btn.textContent='显示'; }
}

async function saveNetConfig(){
  const token=$('net-token').value;
  const d=await api('/api/network/token',{method:'POST',body:JSON.stringify({token})});
  toast(d.ok?'Token 已保存':(d.error||'失败'),d.ok);
}

async function testPush(){
  const to=$('net-test-to').value.trim();
  if(!to){ toast('请填写接收方',false); return; }
  const d=await api('/api/push_test',{method:'POST',body:JSON.stringify({to})});
  toast(d.ok?'测试消息已入队':(d.msg||d.error||'失败'),d.ok);
}

function copyPushUrl(){
  const v=$('net-push-url').value;
  navigator.clipboard.writeText(v).then(()=>toast('已复制到剪贴板'));
}

// ── Files ──────────────────────────────────────────────────────────────
function switchFileTab(tab,el){
  document.querySelectorAll('#page-files .tab-btn').forEach(b=>b.classList.remove('active'));
  if(el) el.classList.add('active');
  $('ftab-raw').classList.toggle('hidden',tab!=='raw');
  $('ftab-converted').classList.toggle('hidden',tab!=='converted');
  $('ftab-queue').classList.toggle('hidden',tab!=='queue');
  if(tab==='raw') loadRawFiles();
  else if(tab==='converted') loadConvertedFiles();
  else if(tab==='queue') loadConvertQueue();
}

function switchFileTabByName(tab){
  const btns=document.querySelectorAll('#page-files .tab-btn');
  const map={raw:0,converted:1,queue:2};
  const idx=map[tab];
  if(idx==null) return;
  switchFileTab(tab, btns[idx]);
}

async function loadRawFiles(){
  const tb=$('raw-tbody');
  tb.innerHTML='<tr><td colspan="4" style="color:var(--muted)">加载中...</td></tr>';
  const d=await api('/api/files/raw');
  if(d.error){ tb.innerHTML=`<tr><td colspan="4" style="color:var(--red)">${esc(d.error)}</td></tr>`; return; }
  if(!d.length){ tb.innerHTML='<tr><td colspan="4" style="color:var(--muted)">暂无文件</td></tr>'; return; }
  tb.innerHTML=d.map(f=>`<tr>
    <td class="font-mono text-xs">${esc(f.name)}</td>
    <td style="color:var(--muted)">${fmtBytes(f.size)}</td>
    <td style="color:var(--muted)">${fmtTime(f.mtime)}</td>
    <td class="td-actions"><button class="btn btn-ghost btn-sm" onclick="convertFile('${esc(f.name)}',this)">加入队列</button></td>
  </tr>`).join('');
}

async function convertFile(name,btn){
  btn.disabled=true; btn.textContent='加入中...';
  const d=await api('/api/files/convert',{method:'POST',body:JSON.stringify({filename:name})});
  if(d.ok){
    showActionNotice(`《${name}》已加入转换队列`, 'info');
    switchFileTabByName('queue');
    startQueuePolling();
  }else{
    showActionNotice(d.msg||d.error||'加入队列失败', 'err');
  }
  toast(d.ok?'已加入队列':(d.msg||d.error||'失败'),d.ok);
  btn.disabled=false; btn.textContent='加入队列';
}

const CONVERTABLE_EXTS=new Set(['.docx','.doc','.xlsx','.xls','.pptx','.ppt','.pdf','.txt']);

async function loadConvertedFiles(){
  const tb=$('conv-tbody');
  tb.innerHTML='<tr><td colspan="4" style="color:var(--muted)">加载中...</td></tr>';
  const d=await api('/api/files/converted');
  if(d.error){ tb.innerHTML=`<tr><td colspan="4" style="color:var(--red)">${esc(d.error)}</td></tr>`; return; }
  if(!d.length){ tb.innerHTML='<tr><td colspan="4" style="color:var(--muted)">暂无文件</td></tr>'; return; }
  tb.innerHTML=d.map(f=>{
    const ext=f.name.substring(f.name.lastIndexOf('.')).toLowerCase();
    const canConvert=CONVERTABLE_EXTS.has(ext);
    return `<tr>
      <td class="font-mono text-xs">${esc(f.name)}</td>
      <td style="color:var(--muted)">${fmtBytes(f.size)}</td>
      <td style="color:var(--muted)">${fmtTime(f.mtime)}</td>
      <td class="td-actions">${canConvert?`<button class="btn btn-ghost btn-sm" onclick="convertConverted('${esc(f.name)}',this)">重新转化</button>`:''}<button class="btn btn-danger btn-sm" onclick="delConverted('${esc(f.name)}')">删除</button></td>
    </tr>`;
  }).join('');
}

async function convertConverted(name,btn){
  btn.disabled=true; btn.textContent='加入中...';
  const d=await api('/api/files/convert',{method:'POST',body:JSON.stringify({filename:name,from_converted:true})});
  if(d.ok){
    showActionNotice(`《${name}》已加入转换队列`, 'info');
    switchFileTabByName('queue');
    startQueuePolling();
  }else{
    showActionNotice(d.msg||d.error||'加入队列失败', 'err');
  }
  toast(d.ok?'已加入队列':(d.msg||d.error||'失败'),d.ok);
  btn.disabled=false; btn.textContent='重新转化';
}

async function delConverted(name){
  if(!confirm(`确认删除 ${name}？`)) return;
  const d=await api('/api/files/converted/'+encodeURIComponent(name),{method:'DELETE'});
  toast(d.ok?'已删除':(d.error||'失败'),d.ok);
  if(d.ok) loadConvertedFiles();
}

// ── Convert Queue ──────────────────────────────────────────────────────
let _queuePollTimer=null;
let _lastQueueIds=new Set();

function statusBadge(st){
  if(st==='converting') return '<span class="q-badge q-converting"><span class="q-spinner"></span>正在转化</span>';
  if(st==='done') return '<span class="q-badge q-done">转化成功</span>';
  if(st==='error') return '<span class="q-badge q-error">转化失败</span>';
  return `<span class="q-badge q-gray">${esc(st||'未知')}</span>`;
}

function renderQueueItem(it){
  const actions=[];
  if(it.status==='done'){
    actions.push(`<button class="btn btn-primary btn-sm" onclick="confirmQueueItem('${it.id}',this)">确认</button>`);
    actions.push(`<button class="btn btn-ghost btn-sm" onclick="cancelQueueItem('${it.id}',this)">取消</button>`);
  }else if(it.status==='error'){
    actions.push(`<button class="btn btn-ghost btn-sm" onclick="cancelQueueItem('${it.id}',this)">移除</button>`);
  }
  const errLine=it.status==='error' && it.error ? `<div class="q-err">${esc(it.error)}</div>`:'';
  const mdLine=it.status==='done' && it.md_name ? `<div class="q-md">暂存：<code>${esc(it.md_name)}</code></div>`:'';
  const isNew=!_lastQueueIds.has(it.id);
  return `<div class="queue-item ${isNew?'q-new':''}" data-id="${it.id}" data-status="${it.status}">
    <div class="q-main">
      <div class="q-name"><span class="q-file-icon">📄</span>${esc(it.name)}</div>
      <div class="q-src" title="${esc(it.src_path)}">来源：<code>${esc(it.src_path)}</code></div>
      ${mdLine}${errLine}
    </div>
    <div class="q-side">
      ${statusBadge(it.status)}
      <div class="q-actions">${actions.join('')}</div>
    </div>
  </div>`;
}

function updateQueueBadge(n){
  const b=$('queue-count');
  if(!b) return;
  if(n>0){ b.textContent=n; b.classList.remove('hidden'); }
  else { b.classList.add('hidden'); }
}

async function loadConvertQueue(){
  const el=$('queue-list');
  if(!el) return;
  const d=await api('/api/convert/queue');
  if(d.error || !Array.isArray(d)){
    el.innerHTML=`<div class="q-empty">${esc(d.error||'加载失败')}</div>`;
    updateQueueBadge(0);
    return;
  }
  updateQueueBadge(d.length);
  if(!d.length){
    el.innerHTML='<div class="q-empty">暂无转换任务</div>';
    _lastQueueIds=new Set();
    return;
  }
  // 稍后到早，最新的放最上
  const sorted=[...d].sort((a,b)=>(b.created_at||0)-(a.created_at||0));
  el.innerHTML=sorted.map(renderQueueItem).join('');
  _lastQueueIds=new Set(sorted.map(x=>x.id));
}

function hasActiveQueue(){
  return document.querySelectorAll('#queue-list .queue-item[data-status="converting"]').length>0;
}

function startQueuePolling(){
  if(_queuePollTimer) return;
  loadConvertQueue();
  _queuePollTimer=setInterval(async()=>{
    await loadConvertQueue();
    // 当前没有转化中且页面不在文件队列 tab 时，停止轮询
    const onQueueTab=!$('ftab-queue').classList.contains('hidden') && $('page-files').classList.contains('active');
    if(!hasActiveQueue() && !onQueueTab){
      stopQueuePolling();
    }
  },2000);
}

function stopQueuePolling(){
  if(_queuePollTimer){ clearInterval(_queuePollTimer); _queuePollTimer=null; }
}

async function confirmQueueItem(id,btn){
  if(btn){ btn.disabled=true; }
  const d=await api('/api/convert/confirm',{method:'POST',body:JSON.stringify({id})});
  if(d.ok){
    toast('已归档到 memory/files/');
    showActionNotice(`已确认：${d.md_name||''}`, 'ok');
    await loadConvertQueue();
  }else{
    toast(d.msg||'失败',false);
    if(btn) btn.disabled=false;
  }
}

async function cancelQueueItem(id,btn){
  if(btn){ btn.disabled=true; }
  const d=await api('/api/convert/cancel',{method:'POST',body:JSON.stringify({id})});
  if(d.ok){
    toast('已取消并删除暂存');
    await loadConvertQueue();
  }else{
    toast(d.msg||'失败',false);
    if(btn) btn.disabled=false;
  }
}

// ── Data: tabs ─────────────────────────────────────────────────────────
function switchDataTab(tab,el){
  document.querySelectorAll('#page-data .tab-btn').forEach(b=>b.classList.remove('active'));
  el.classList.add('active');
  $('dtab-schedules').classList.toggle('hidden',tab!=='schedules');
  $('dtab-notes').classList.toggle('hidden',tab!=='notes');
  if(tab==='schedules') loadSchedules(); else loadNotes();
}

// ── Schedules ──────────────────────────────────────────────────────────
let _editingSchId=null;

async function openSchModal(id){
  _editingSchId=id||null;
  $('sch-modal-title').textContent=id?'编辑日程':'新建日程';
  $('sf-name').value=''; $('sf-date').value=''; $('sf-time').value='';
  $('sf-weekday').value=''; $('sf-content').value='';
  $('sch-modal').classList.remove('hidden');
  if(id) await loadSchForEdit(id);
  setTimeout(()=>$('sf-name').focus(),50);
}
function closeSchModal(){ $('sch-modal').classList.add('hidden'); _editingSchId=null; }

function openSchForm(id){ openSchModal(id); }
function closeSchForm(){ closeSchModal(); }

async function loadSchedules(){
  const tb=$('sch-tbody');
  tb.innerHTML='<tr><td colspan="6" style="color:var(--muted)">加载中...</td></tr>';
  const d=await api('/api/schedules');
  if(d.error){ tb.innerHTML=`<tr><td colspan="6" style="color:var(--red)">${esc(d.error)}</td></tr>`; return; }
  if(!d.length){ tb.innerHTML='<tr><td colspan="6" style="color:var(--muted)">暂无日程</td></tr>'; return; }
  tb.innerHTML=d.map(s=>`<tr>
    <td class="font-semibold">${esc(s.name)}</td>
    <td><span class="badge badge-gray">${s.datetime}</span></td>
    <td style="color:var(--muted)">${s.weekday||'—'}</td>
    <td style="max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--muted)">${esc(s.content)}</td>
    <td>${s.reminded_morning?'<span class="badge badge-green">晨报✓</span>':''} ${s.reminded_before?'<span class="badge badge-green">预报✓</span>':''}</td>
    <td class="td-actions">
      <button class="btn btn-ghost btn-sm" onclick="openSchForm(${s.id})">编辑</button>
      <button class="btn btn-danger btn-sm" onclick="delSch(${s.id})">删除</button>
    </td>
  </tr>`).join('');
}

async function loadSchForEdit(id){
  const all=await api('/api/schedules');
  const s=(all||[]).find(x=>x.id===id);
  if(!s) return;
  $('sf-name').value=s.name||'';
  $('sf-content').value=s.content||'';
  const [datePart,timePart]=(s.datetime||'').split(' ');
  if(datePart) $('sf-date').value=datePart.replace(/\//g,'-');
  if(timePart) $('sf-time').value=timePart;
  const wdMap={'周一':'0','周二':'1','周三':'2','周四':'3','周五':'4','周六':'5','周日':'6'};
  $('sf-weekday').value=wdMap[s.weekday]||'';
}

async function submitSchForm(){
  const name=$('sf-name').value.trim();
  if(!name){ toast('名称不能为空',false); return; }
  const dateVal=$('sf-date').value;
  const timeVal=$('sf-time').value||'00:00';
  let year=0,month=0,day=0,hour=0,minute=0;
  if(dateVal){
    const [y,mo,d]=dateVal.split('-').map(Number);
    year=y; month=mo; day=d;
  }
  if(timeVal){
    const [h,mi]=timeVal.split(':').map(Number);
    hour=h; minute=mi;
  }
  const wdRaw=$('sf-weekday').value;
  const weekday=wdRaw!==''?parseInt(wdRaw):null;
  const content=$('sf-content').value.trim();
  const body={name,year,month,day,hour,minute,weekday,content};

  let d;
  if(_editingSchId){
    d=await api('/api/schedules/'+_editingSchId,{method:'PUT',body:JSON.stringify(body)});
  } else {
    d=await api('/api/schedules',{method:'POST',body:JSON.stringify(body)});
  }
  toast(d.ok?(_editingSchId?'已保存':'已创建'):(d.error||'失败'),d.ok);
  if(d.ok){ closeSchForm(); loadSchedules(); }
}

async function delSch(id){
  if(!confirm(`确认删除日程 #${id}？`)) return;
  const d=await api('/api/schedules/'+id,{method:'DELETE'});
  toast(d.ok?'已删除':(d.error||'失败'),d.ok);
  if(d.ok) loadSchedules();
}

// ── Notes ───────────────────────────────────────────────────────────────
let _editingNote=null;

async function loadNotes(){
  const tb=$('notes-tbody');
  tb.innerHTML='<tr><td colspan="3" style="color:var(--muted)">加载中...</td></tr>';
  const d=await api('/api/notes');
  if(d.error){ tb.innerHTML=`<tr><td colspan="3" style="color:var(--red)">${esc(d.error)}</td></tr>`; return; }
  if(!d.length){ tb.innerHTML='<tr><td colspan="3" style="color:var(--muted)">暂无笔记</td></tr>'; return; }
  tb.innerHTML=d.map(n=>`<tr>
    <td class="font-semibold">${esc(n.name)}</td>
    <td style="color:var(--muted)">${fmtTime(n.mtime)}</td>
    <td class="td-actions">
      <button class="btn btn-ghost btn-sm" onclick="editNote('${esc(n.name)}')">查看/编辑</button>
      <button class="btn btn-danger btn-sm" onclick="delNote('${esc(n.name)}')">删除</button>
    </td>
  </tr>`).join('');
}

async function editNote(name){
  const d=await api('/api/notes/'+encodeURIComponent(name));
  if(d.error){ toast('加载失败',false); return; }
  _editingNote=name;
  $('note-panel-title').textContent='📝 '+d.name;
  $('note-content').value=d.content||'';
  $('note-modal').classList.remove('hidden');
}

function closeNoteModal(){ $('note-modal').classList.add('hidden'); }

async function saveNote(){
  if(!_editingNote) return;
  const content=$('note-content').value;
  const d=await api('/api/notes/'+encodeURIComponent(_editingNote),{method:'PUT',body:JSON.stringify({content})});
  toast(d.ok?'已保存':(d.error||'失败'),d.ok);
  if(d.ok){ closeNoteModal(); loadNotes(); }
}

async function delNote(name){
  if(!confirm(`确认删除笔记「${name}」？`)) return;
  const d=await api('/api/notes/'+encodeURIComponent(name),{method:'DELETE'});
  toast(d.ok?'已删除':(d.error||'失败'),d.ok);
  if(d.ok){ loadNotes(); closeNoteModal(); }
}

// ── Model: Providers ───────────────────────────────────────────────────
async function loadProviders(){
  const d=await api('/api/model/provider');
  if(d.error) return;
  const g=$('provider-grid');
  g.innerHTML=(d.available||[]).map(p=>`<div class="provider-card${p===d.provider?' active':''}" onclick="switchProvider('${p}',this)">${p.toUpperCase()}</div>`).join('');
}

async function switchProvider(p,el){
  const d=await api('/api/model/provider',{method:'POST',body:JSON.stringify({provider:p})});
  if(d.ok){
    document.querySelectorAll('.provider-card').forEach(c=>c.classList.remove('active'));
    el.classList.add('active'); toast(`已切换到 ${p}`); refreshStatus();
  } else toast(d.msg||'切换失败',false);
}

// ── Model: Keys ────────────────────────────────────────────────────────
let _kmProvider=null;

async function loadKeys(){
  const d=await api('/api/model/keys');
  if(d.error) return;
  const tb=$('keys-tbody');
  tb.innerHTML=Object.entries(d).map(([p,info])=>`<tr>
    <td class="font-semibold">${p.toUpperCase()}</td>
    <td class="font-mono text-xs" style="color:var(--muted)">${esc(info.model)}</td>
    <td><span class="badge ${info.set?'badge-green':'badge-gray'}">${info.set?info.masked:'未设置'}</span></td>
    <td><button class="btn btn-ghost btn-sm" onclick="openKeyModal('${p}')">修改</button></td>
  </tr>`).join('');
}

function openKeyModal(p){
  _kmProvider=p;
  $('km-title').textContent='修改 '+p.toUpperCase()+' API Key';
  $('km-input').value='';
  $('key-modal').classList.remove('hidden');
  setTimeout(()=>$('km-input').focus(),50);
}
function closeKeyModal(){ $('key-modal').classList.add('hidden'); _kmProvider=null; }

async function submitKey(){
  const key=$('km-input').value.trim();
  if(!key){ toast('Key 不能为空',false); return; }
  const d=await api('/api/model/keys',{method:'POST',body:JSON.stringify({provider:_kmProvider,key})});
  toast(d.ok?'Key 已更新':(d.error||'失败'),d.ok);
  if(d.ok){ closeKeyModal(); loadKeys(); }
}

// ── Model: Memory ──────────────────────────────────────────────────────
let _editingMem=null;

async function loadMemory(){
  const tb=$('mem-tbody');
  tb.innerHTML='<tr><td colspan="5" style="color:var(--muted)">加载中...</td></tr>';
  const d=await api('/api/memory');
  if(d.error){ tb.innerHTML=`<tr><td colspan="5" style="color:var(--red)">${esc(d.error)}</td></tr>`; return; }
  if(!d.length){ tb.innerHTML='<tr><td colspan="5" style="color:var(--muted)">暂无 memory</td></tr>'; return; }
  tb.innerHTML=d.map(m=>`<tr>
    <td class="font-semibold">${esc(m.name)}</td>
    <td style="color:var(--muted)">${fmtBytes(m.size)}</td>
    <td style="color:var(--muted)">${fmtTime(m.mtime)}</td>
    <td><label class="toggle" title="${m.enabled?'已启用':'已禁用'}">
      <input type="checkbox" ${m.enabled?'checked':''} onchange="toggleMem('${esc(m.name)}',this)">
      <div class="toggle-track"></div>
    </label></td>
    <td class="td-actions">
      <button class="btn btn-ghost btn-sm" onclick="editMem('${esc(m.name)}')">查看/编辑</button>
      <button class="btn btn-danger btn-sm" onclick="delMem('${esc(m.name)}')">删除</button>
    </td>
  </tr>`).join('');
}

async function toggleMem(name,cb){
  const d=await api('/api/memory/'+encodeURIComponent(name)+'/toggle',{method:'POST'});
  if(!d.ok){ cb.checked=!cb.checked; toast('操作失败',false); }
  else toast(d.enabled?name+' 已启用':name+' 已禁用');
}

async function editMem(name){
  const d=await api('/api/memory/'+encodeURIComponent(name));
  if(d.error){ toast('加载失败',false); return; }
  _editingMem=name;
  $('mem-panel-title').textContent='Memory: '+d.name;
  $('mem-content').value=d.content||'';
  const p=$('mem-panel'); p.classList.remove('hidden'); p.scrollIntoView({behavior:'smooth'});
}

async function saveMem(){
  if(!_editingMem) return;
  const content=$('mem-content').value;
  const d=await api('/api/memory/'+encodeURIComponent(_editingMem),{method:'PUT',body:JSON.stringify({content})});
  toast(d.ok?'已保存':(d.error||'失败'),d.ok);
  if(d.ok) loadMemory();
}

async function delMem(name){
  if(!confirm(`确认删除 Memory「${name}」？`)) return;
  const d=await api('/api/memory/'+encodeURIComponent(name),{method:'DELETE'});
  toast(d.ok?'已删除':(d.error||'失败'),d.ok);
  if(d.ok){ loadMemory(); $('mem-panel').classList.add('hidden'); }
}

// ── Send ────────────────────────────────────────────────────────────────
async function sendMsg(){
  const to=$('send-to').value.trim(), msg=$('send-msg').value.trim();
  if(!to||!msg){ toast('请填写接收方和消息内容',false); return; }
  const d=await api('/api/send',{method:'POST',body:JSON.stringify({to,msg})});
  if(d.ok){ toast('已入队'); $('send-msg').value=''; }
  else toast(d.msg||d.error||'失败',false);
}

// ── Appearance ─────────────────────────────────────────────────────────
const THEMES=[
  {id:'light', label:'浅色（默认）',
   preview:'background:linear-gradient(135deg,#f0fdf4 40%,#10b981 100%)'},
  {id:'dark', label:'深色',
   preview:'background:linear-gradient(135deg,#0a0f0d 40%,#10b981 100%)'},
];

const GREEN_PRESETS=[
  '#ecfdf5','#d1fae5','#a7f3d0','#6ee7b7','#34d399','#10b981','#059669','#047857','#065f46','#064e3b',
  '#f0fdf4','#dcfce7','#bbf7d0','#86efac','#4ade80','#22c55e','#16a34a','#15803d','#166534','#14532d',
  '#f7fee7','#ecfccb','#d9f99d','#bef264','#a3e635','#84cc16','#65a30d','#4d7c0f','#3f6212','#365314',
  '#f0fdfa','#ccfbf1','#99f6e4','#5eead4','#2dd4bf','#14b8a6','#0d9488','#0f766e','#115e59','#134e4a',
  '#f6fff8','#eaffef','#d7fbe1','#c1f7d0','#abf1c0','#95ebb0','#7fe5a1','#69df92','#53d983','#3dd374',
  '#dafbe1','#aceebb','#7ce38d','#4cd85f','#2fc94f','#1fb141','#179738','#137b30','#106628','#0c511f'
];

const CSS_VARS=[
  ['--bg','背景色'],['--bg-gradient-a','渐变一'],['--bg-gradient-b','渐变二'],['--bg-gradient-c','渐变三'],['--surface','卡片背景'],['--surface2','次级背景'],
  ['--surface3','高亮背景'],['--border','边框色'],['--text','主文字'],
  ['--muted','次要文字'],['--accent','强调色'],['--accent-h','强调悬停'],
  ['--accent-bg','强调背景'],['--accent-text','强调文字'],
  ['--red','红色'],['--red-bg','红色背景'],
  ['--yellow','黄色'],['--blue','蓝色'],['--green','绿色'],['--orange','橙色'],
];

function hexToRgb(hex){
  const h=hex.replace('#','');
  const v=h.length===3?h.split('').map(x=>x+x).join(''):h;
  return {r:parseInt(v.slice(0,2),16),g:parseInt(v.slice(2,4),16),b:parseInt(v.slice(4,6),16)};
}

function rgbToHex(v){
  return '#'+[v.r,v.g,v.b].map(x=>Math.max(0,Math.min(255,Math.round(x))).toString(16).padStart(2,'0')).join('');
}

function mixColor(hex1,hex2,weight){
  const a=hexToRgb(hex1), b=hexToRgb(hex2);
  return rgbToHex({r:a.r*(1-weight)+b.r*weight,g:a.g*(1-weight)+b.g*weight,b:a.b*(1-weight)+b.b*weight});
}

function applyGreenPreset(color){
  const dark=document.documentElement.getAttribute('data-theme')==='dark';
  document.documentElement.style.setProperty('--accent', color);
  document.documentElement.style.setProperty('--green', color);
  document.documentElement.style.setProperty('--accent-h', mixColor(color, dark?'#ffffff':'#000000', dark?0.12:0.22));
  document.documentElement.style.setProperty('--accent-bg', mixColor(color, dark?'#0a0f0d':'#ffffff', dark?0.82:0.88));
  document.documentElement.style.setProperty('--accent-text', mixColor(color, dark?'#ffffff':'#000000', dark?0.25:0.35));
  document.querySelectorAll('.green-chip').forEach(c=>c.classList.toggle('active', c.dataset.color===color));
  toast('已应用绿色预设');
}

function initAppearance(){
  const saved=localStorage.getItem('wb_theme')||'light';
  const tg=$('theme-grid');
  tg.innerHTML=THEMES.map(t=>`<div class="theme-card${t.id===saved?' active':''}" data-theme="${t.id}" onclick="applyTheme('${t.id}',this)">
    <div class="theme-preview" style="${t.preview}"></div>
    <div class="theme-label">${t.label}</div>
  </div>`).join('');

  const cg=$('color-grid');
  cg.innerHTML=CSS_VARS.map(([v,label])=>{
    const color=getComputedStyle(document.documentElement).getPropertyValue(v).trim()||'#888';
    const sid='sw_'+v.replace(/-/g,'_');
    return `<div class="color-item" onclick="pickColor('${v}','${sid}')">
      <div class="color-swatch" id="${sid}" style="background:${color}"></div>
      <div class="color-name">${label}<br><span style="font-size:10px;opacity:.6">${v}</span></div>
    </div>`;
  }).join('');

  const gp=$('green-palette-grid');
  if(gp){
    const active=(document.documentElement.style.getPropertyValue('--accent')||getComputedStyle(document.documentElement).getPropertyValue('--accent')).trim().toLowerCase();
    gp.innerHTML=GREEN_PRESETS.map(color=>`<button class="green-chip${active===color.toLowerCase()?' active':''}" data-color="${color}" style="background:${color}" title="${color}" onclick="applyGreenPreset('${color}')"></button>`).join('');
  }
}

function applyTheme(name,el){
  document.querySelectorAll('.theme-card').forEach(c=>c.classList.remove('active'));
  if(el) el.classList.add('active');
  document.documentElement.setAttribute('data-theme',name);
  localStorage.setItem('wb_theme',name);
  if($('color-grid')) initAppearance();
  toast('主题已切换');
}

function pickColor(cssVar,swatchId){
  const inp=document.createElement('input');
  inp.type='color';
  const cur=getComputedStyle(document.documentElement).getPropertyValue(cssVar).trim();
  inp.value=cur.startsWith('#')?cur:'#10b981';
  inp.style.cssText='position:absolute;opacity:0;pointer-events:none;width:0;height:0;';
  document.body.appendChild(inp); inp.click();
  inp.oninput=()=>{
    document.documentElement.style.setProperty(cssVar,inp.value);
    const sw=document.getElementById(swatchId);
    if(sw) sw.style.background=inp.value;
  };
  inp.onchange=()=>document.body.removeChild(inp);
}

function saveColors(){
  const custom={};
  CSS_VARS.forEach(([v])=>{
    const val=document.documentElement.style.getPropertyValue(v);
    if(val) custom[v]=val;
  });
  localStorage.setItem('wb_colors',JSON.stringify(custom));
  toast('配色已保存');
}

function resetColors(){
  localStorage.removeItem('wb_colors');
  CSS_VARS.forEach(([v])=>document.documentElement.style.removeProperty(v));
  initAppearance();
  toast('已重置');
}

function loadSavedAppearance(){
  const theme=localStorage.getItem('wb_theme')||'light';
  document.documentElement.setAttribute('data-theme',theme);
  try{
    const c=JSON.parse(localStorage.getItem('wb_colors')||'{}');
    Object.entries(c).forEach(([v,val])=>document.documentElement.style.setProperty(v,val));
  }catch(_){}
}

// ── Init ────────────────────────────────────────────────────────────────
loadSavedAppearance();
refreshStatus();
refreshAccount();
setInterval(refreshStatus,15000);
// 首屏静默刷新一次队列徽章；若有活动任务则开启轮询
loadConvertQueue().then(()=>{ if(hasActiveQueue()) startQueuePolling(); });

// ── Sidebar toggle (mobile) ───────────────────────────────────────────
function toggleSidebar(){
  document.body.classList.toggle('sidebar-open');
}
document.addEventListener('click', e=>{
  if(window.innerWidth>900) return;
  const sb=$('sidebar');
  if(!sb) return;
  if(document.body.classList.contains('sidebar-open')
     && !sb.contains(e.target)
     && !e.target.closest('#sidebar-toggle')){
    document.body.classList.remove('sidebar-open');
  }
});
document.querySelectorAll('.nav-item').forEach(n=>n.addEventListener('click',()=>{
  if(window.innerWidth<=900) document.body.classList.remove('sidebar-open');
}));
