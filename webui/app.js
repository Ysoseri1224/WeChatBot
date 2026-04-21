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
      logs:()=>{},
      network:loadNetConfig,
      files:loadRawFiles,
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

document.querySelectorAll('#page-logs input[type=checkbox]').forEach(cb=>{
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
  el.classList.add('active');
  $('ftab-raw').classList.toggle('hidden',tab!=='raw');
  $('ftab-converted').classList.toggle('hidden',tab!=='converted');
  if(tab==='raw') loadRawFiles(); else loadConvertedFiles();
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
    <td class="td-actions"><button class="btn btn-ghost btn-sm" onclick="convertFile('${esc(f.name)}',this)">转化为 md</button></td>
  </tr>`).join('');
}

async function convertFile(name,btn){
  btn.disabled=true; btn.textContent='转化中...';
  const d=await api('/api/files/convert',{method:'POST',body:JSON.stringify({filename:name})});
  toast(d.ok?d.msg:(d.msg||d.error||'失败'),d.ok);
  btn.disabled=false; btn.textContent='转化为 md';
}

async function loadConvertedFiles(){
  const tb=$('conv-tbody');
  tb.innerHTML='<tr><td colspan="4" style="color:var(--muted)">加载中...</td></tr>';
  const d=await api('/api/files/converted');
  if(d.error){ tb.innerHTML=`<tr><td colspan="4" style="color:var(--red)">${esc(d.error)}</td></tr>`; return; }
  if(!d.length){ tb.innerHTML='<tr><td colspan="4" style="color:var(--muted)">暂无文件</td></tr>'; return; }
  tb.innerHTML=d.map(f=>`<tr>
    <td class="font-mono text-xs">${esc(f.name)}</td>
    <td style="color:var(--muted)">${fmtBytes(f.size)}</td>
    <td style="color:var(--muted)">${fmtTime(f.mtime)}</td>
    <td class="td-actions"><button class="btn btn-danger btn-sm" onclick="delConverted('${esc(f.name)}')">删除</button></td>
  </tr>`).join('');
}

async function delConverted(name){
  if(!confirm(`确认删除 ${name}？`)) return;
  const d=await api('/api/files/converted/'+encodeURIComponent(name),{method:'DELETE'});
  toast(d.ok?'已删除':(d.error||'失败'),d.ok);
  if(d.ok) loadConvertedFiles();
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

async function openSchForm(id){
  _editingSchId=id;
  $('sch-form-title').textContent=id?'编辑日程':'新建日程';
  if(id){
    const all=await api('/api/schedules');
    const s=(all||[]).find(x=>x.id===id);
    if(s){
      $('sf-name').value=s.name||'';
      $('sf-content').value=s.content||'';
      // parse datetime "YYYY/MM/DD HH:MM"
      const [datePart,timePart]=(s.datetime||'').split(' ');
      if(datePart){ $('sf-date').value=datePart.replace(/\//g,'-'); }
      if(timePart){ $('sf-time').value=timePart; }
      // weekday
      const wdMap={'周一':'0','周二':'1','周三':'2','周四':'3','周五':'4','周六':'5','周日':'6'};
      $('sf-weekday').value=wdMap[s.weekday]||'';
    }
  } else {
    $('sf-name').value=''; $('sf-date').value=''; $('sf-time').value='';
    $('sf-weekday').value=''; $('sf-content').value='';
  }
  $('sch-form').classList.remove('hidden');
  $('sch-form').scrollIntoView({behavior:'smooth'});
}

function closeSchForm(){ $('sch-form').classList.add('hidden'); _editingSchId=null; }

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
  const p=$('note-panel'); p.classList.remove('hidden'); p.scrollIntoView({behavior:'smooth'});
}

async function saveNote(){
  if(!_editingNote) return;
  const content=$('note-content').value;
  const d=await api('/api/notes/'+encodeURIComponent(_editingNote),{method:'PUT',body:JSON.stringify({content})});
  toast(d.ok?'已保存':(d.error||'失败'),d.ok);
  if(d.ok) loadNotes();
}

async function delNote(name){
  if(!confirm(`确认删除笔记「${name}」？`)) return;
  const d=await api('/api/notes/'+encodeURIComponent(name),{method:'DELETE'});
  toast(d.ok?'已删除':(d.error||'失败'),d.ok);
  if(d.ok){ loadNotes(); $('note-panel').classList.add('hidden'); }
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

const CSS_VARS=[
  ['--bg','背景色'],['--surface','卡片背景'],['--surface2','次级背景'],
  ['--surface3','高亮背景'],['--border','边框色'],['--text','主文字'],
  ['--muted','次要文字'],['--accent','强调色'],['--accent-h','强调悬停'],
  ['--accent-bg','强调背景'],['--accent-text','强调文字'],
  ['--red','红色'],['--red-bg','红色背景'],
  ['--yellow','黄色'],['--blue','蓝色'],['--green','绿色'],['--orange','橙色'],
];

function initAppearance(){
  const saved=localStorage.getItem('wb_theme')||'light';
  const tg=$('theme-grid');
  tg.innerHTML=THEMES.map(t=>`<div class="theme-card${t.id===saved?' active':''}" data-theme="${t.id}" onclick="applyTheme('${t.id}',this)">
    <div class="theme-preview" style="${t.preview}"></div>
    <div class="theme-label">${t.label}</div>
  </div>`).join('');

  const cg=$('color-grid');
  if(cg.children.length) return;
  cg.innerHTML=CSS_VARS.map(([v,label])=>{
    const color=getComputedStyle(document.documentElement).getPropertyValue(v).trim()||'#888';
    const sid='sw_'+v.replace(/-/g,'_');
    return `<div class="color-item" onclick="pickColor('${v}','${sid}')">
      <div class="color-swatch" id="${sid}" style="background:${color}"></div>
      <div class="color-name">${label}<br><span style="font-size:10px;opacity:.6">${v}</span></div>
    </div>`;
  }).join('');
}

function applyTheme(name,el){
  document.querySelectorAll('.theme-card').forEach(c=>c.classList.remove('active'));
  if(el) el.classList.add('active');
  document.documentElement.setAttribute('data-theme',name);
  localStorage.setItem('wb_theme',name);
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
