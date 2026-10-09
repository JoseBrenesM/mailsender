/* ============================================
   CV Scheduler — lógica de la app
   (extraído de mailsender.html)
   ============================================ */

let S = {
  clientId:'', subject:'', body:'', times:[],
  cvs:[], // { id, name, data } — colección abierta de CVs, uno por vacante si se quiere
  cv1Data:'', cv1Name:'', cv2Data:'', cv2Name:'', cvData:'', cvName:'', // legado, se migran a cvs[] en loadState()
  campaigns:[],
  gmailConnected:false, // true si el usuario ya dio consentimiento alguna vez
  pixelUrl:'' // URL del Web App de Apps Script para tracking de apertura
};
let token = null;
let tokenExpiryTs = 0;
let timers = {};
let tokenClient = null;
let lastOpensCheckTs = 0;

const RECOVERY_WINDOW_MS = 1 * 60 * 60 * 1000; // ventana de recuperación de envíos perdidos (1h)
const LAST_SCHEDULE_CHECK_KEY = 'cvapp_last_schedule_check_v1';
// Gmail suele pre-escanear imágenes externas apenas llega el correo (antes de
// que el destinatario lo abra). Un solo hit dentro de esta ventana desde el
// envío se trata como ese escaneo automático, no como apertura real.
const OPEN_GRACE_MS = 3 * 60 * 1000;
const STORAGE_KEY = 'cvapp_v2';
const META_KEY = 'cvapp_v2_meta';

/* ── Helpers ────────────────────────────── */
function get(id){ return document.getElementById(id); }

// Fecha local YYYY-MM-DD (a propósito NO usa toISOString(), que da la fecha en
// UTC: en Costa Rica (UTC-6) cualquier hora entre las 18:00 y 23:59 locales ya
// cae en el día siguiente en UTC, lo que desalineaba sentKey() entre el
// momento del envío y una verificación posterior — causaba reenvíos
// duplicados vía la ventana de recuperación si se reconectaba pasadas las
// 18:00 hora local).
function localDateStr(d = new Date()){
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Clave única para un envío: campaña + fecha + hora  ej. "c123_2026-06-17_08:00"
function sentKey(campId, hora){
  return campId + '_' + localDateStr() + '_' + hora;
}

function yaEnviado(c, hora){
  return (c.sentLog || []).includes(sentKey(c.id, hora));
}

function marcarEnviado(c, hora){
  if(!c.sentLog) c.sentLog = [];
  const key = sentKey(c.id, hora);
  if(!c.sentLog.includes(key)) c.sentLog.push(key);
  // Limpiar entradas de más de 8 días para no inflar localStorage
  const limite = new Date(); limite.setDate(limite.getDate() - 8);
  c.sentLog = c.sentLog.filter(k => {
    const partes = k.split('_');
    if(partes.length < 3) return false;
    return new Date(partes[1]) >= limite;
  });
}

/* ── Cifrado local opcional (mejora #3) ──────────────────────────
   Si el usuario activa "protección con contraseña", todo el blob de
   S se cifra con AES-GCM antes de escribirlo en localStorage. La
   clave se deriva de la contraseña vía PBKDF2 y sólo vive en memoria
   durante la sesión (nunca se guarda). Sin backend no hay forma de
   recuperar una contraseña olvidada — se advierte al usuario. */
const ENC = { key: null };

function bufToB64(buf){
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}
function b64ToBuf(b64){
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}

async function deriveKey(pass, saltB64){
  const salt = saltB64 ? b64ToBuf(saltB64) : crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']
  );
  const key = await crypto.subtle.deriveKey(
    { name:'PBKDF2', salt, iterations:150000, hash:'SHA-256' },
    keyMaterial, { name:'AES-GCM', length:256 }, false, ['encrypt','decrypt']
  );
  return { key, salt };
}

async function encryptJSON(key, obj){
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name:'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(obj))
  );
  return bufToB64(iv) + '.' + bufToB64(data);
}

async function decryptJSON(key, payload){
  const [ivB64, dataB64] = payload.split('.');
  const plain = await crypto.subtle.decrypt(
    { name:'AES-GCM', iv: b64ToBuf(ivB64) }, key, b64ToBuf(dataB64)
  );
  return JSON.parse(new TextDecoder().decode(plain));
}

function isLocked(){
  try{ return !!JSON.parse(localStorage.getItem(META_KEY) || 'null')?.locked; }
  catch(e){ return false; }
}

async function enableLock(){
  const pass = prompt('Crea una contraseña para proteger tus datos localmente.\nSi la olvidas, no hay forma de recuperarla (no hay servidor).');
  if(!pass) return;
  const { key, salt } = await deriveKey(pass);
  ENC.key = key;
  localStorage.setItem(META_KEY, JSON.stringify({ locked:true, salt: bufToB64(salt) }));
  save();
  alert('Datos protegidos. Se te pedirá la contraseña cada vez que abras la app en este navegador.');
  updateLockUI();
}

function disableLock(){
  if(!confirm('¿Quitar la protección? A partir de ahora tus datos quedarán en localStorage sin cifrar.')) return;
  ENC.key = null;
  localStorage.removeItem(META_KEY);
  save();
  updateLockUI();
}

function updateLockUI(){
  const box = get('lock-status');
  if(!box) return;
  const locked = isLocked();
  box.textContent = locked
    ? 'Protección activa: tus datos se cifran en este navegador.'
    : 'Sin protección: el Client ID, los CV y las campañas se guardan en localStorage sin cifrar.';
  box.className = locked ? 'auth-box auth-ok' : 'auth-box auth-warn';
  box.style.display = 'flex';
  get('btn-lock').style.display = locked ? 'none' : 'inline-flex';
  get('btn-unlock').style.display = locked ? 'inline-flex' : 'none';
}

/* ── Inicialización ─────────────────────── */
async function loadState(){
  const meta = (() => { try{ return JSON.parse(localStorage.getItem(META_KEY) || 'null'); }catch(e){ return null; } })();

  if(meta && meta.locked){
    let ok = false;
    let pass = prompt('Ingresa tu contraseña para desbloquear tus datos:');
    while(pass && !ok){
      try{
        const { key } = await deriveKey(pass, meta.salt);
        const raw = localStorage.getItem(STORAGE_KEY);
        if(raw){
          const parsed = await decryptJSON(key, raw);
          S = Object.assign(S, parsed);
        }
        ENC.key = key;
        ok = true;
      }catch(e){
        pass = prompt('Contraseña incorrecta. Intenta de nuevo (o cancela para seguir sin desbloquear):');
      }
    }
  } else {
    try{
      const d = localStorage.getItem(STORAGE_KEY);
      if(d) S = Object.assign(S, JSON.parse(d));
    }catch(e){}
  }

  // Migración CV único → cv1
  if(S.cvData && !S.cv1Data){
    S.cv1Data = S.cvData; S.cv1Name = S.cvName || 'CV.pdf';
    S.cvData = ''; S.cvName = '';
  }

  // Migración cv1/cv2 fijos → colección abierta S.cvs (solo una vez; los
  // campos legado quedan vacíos después así no se re-migra si luego el
  // usuario borra todos los CVs de la colección)
  if(!S.cvs) S.cvs = [];
  if(!S.cvs.length){
    if(S.cv1Data) S.cvs.push({ id:'cv1', name: S.cv1Name || 'CV 1.pdf', label:'Técnico / TI', data: S.cv1Data });
    if(S.cv2Data) S.cvs.push({ id:'cv2', name: S.cv2Name || 'CV 2.pdf', label:'General / Estudiante', data: S.cv2Data });
  }
  S.cv1Data=''; S.cv1Name=''; S.cv2Data=''; S.cv2Name='';

  // Migración campaigns sin sentLog / opens / followUp / cvId / body propio
  S.campaigns.forEach(c => {
    if(!c.sentLog) c.sentLog = [];
    if(!c.opens) c.opens = [];
    if(c.followUp === undefined) c.followUp = null;
    if(c.cvId === undefined){
      c.cvId = c.cvNum === 2 ? 'cv2' : 'cv1';
      delete c.cvNum;
    }
    if(c.body === undefined) c.body = '';
  });
  save();

  get('def-subject').value = S.subject || '';
  get('def-body').value    = S.body    || '';
  get('client-id').value   = S.clientId || '';
  get('pixel-url').value   = S.pixelUrl || '';

  renderCVList();
  populateCVSelect();
  renderTimes();
  renderCampaigns();
  updateAuthBox();
  updateLockUI();

  // Mejora #1/#2: intento de reconexión silenciosa + reanudar campañas activas
  if(S.gmailConnected){
    trySilentReconnect(() => resumeAll());
  }
}

function save(){
  S.subject = get('def-subject').value;
  S.body    = get('def-body').value;
  if(ENC.key){
    encryptJSON(ENC.key, S).then(enc => localStorage.setItem(STORAGE_KEY, enc));
  } else {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(S));
  }
}

function saveClientId(){
  S.clientId = get('client-id').value.trim();
  tokenClient = null; // el client id cambió, forzar recrear el token client
  save();
}

function savePixelUrl(){
  S.pixelUrl = get('pixel-url').value.trim();
  save();
  renderCampaigns();
}

/* ── Navegación ─────────────────────────── */
const TAB_ORDER = ['campanas','plantilla','conexiones'];

function go(t){
  TAB_ORDER.forEach(x => {
    get('tab-'+x).classList.toggle('active', x===t);
  });
  document.querySelectorAll('.tab').forEach((b,i) => {
    b.classList.toggle('active', TAB_ORDER[i]===t);
  });
  if(t==='campanas') renderCampaigns();
}

/* ── Variables en mensaje ───────────────── */
function ins(v){
  const ta = get('def-body');
  const s = ta.selectionStart, e = ta.selectionEnd;
  ta.value = ta.value.slice(0,s) + v + ta.value.slice(e);
  ta.focus(); ta.selectionStart = ta.selectionEnd = s + v.length;
  save();
}

/* ── CVs (colección abierta) ────────────── */
function addCV(input){
  const file = input.files[0]; if(!file) return;
  const r = new FileReader();
  r.onload = ev => {
    S.cvs.push({ id:'cv_'+Date.now(), name:file.name, label:'', data: ev.target.result.split(',')[1] });
    save();
    renderCVList();
    populateCVSelect();
    input.value = '';
  };
  r.readAsDataURL(file);
}

function renameCV(id, label){
  const cv = S.cvs.find(x => x.id===id); if(!cv) return;
  cv.label = label.trim();
  save();
  populateCVSelect();
}

function removeCVSlot(id){
  const cv = S.cvs.find(x => x.id===id); if(!cv) return;
  if(!confirm(`¿Quitar "${cv.name}"? Las campañas que lo usen quedarán sin adjunto.`)) return;
  S.cvs = S.cvs.filter(x => x.id!==id);
  save();
  renderCVList();
  populateCVSelect();
  renderCampaigns();
}

// Descarga de respaldo: reconstruye el PDF desde el base64 ya guardado en
// S.cvs — no lee ni escribe nada más, es la misma data que ya se adjunta
// en los correos (sendEmail()), solo que acá se lleva al disco del usuario.
function downloadCV(id){
  const cv = S.cvs.find(x => x.id===id); if(!cv) return;
  const bytes = atob(cv.data);
  const arr = new Uint8Array(bytes.length);
  for(let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
  const blob = new Blob([arr], { type:'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = cv.name;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

function renderCVList(){
  const el = get('cv-list'); if(!el) return;
  if(!S.cvs.length){
    el.innerHTML = `<div class="empty" style="padding:1rem 0"><i class="ti ti-file-off" aria-hidden="true"></i><p>No hay CVs cargados todavía.</p></div>`;
    return;
  }
  el.innerHTML = S.cvs.map(cv => `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 12px;border:1px solid var(--border);border-radius:8px;margin-bottom:8px">
      <div style="display:flex;align-items:center;gap:8px;overflow:hidden;flex:1">
        <i class="ti ti-file-type-pdf" style="font-size:18px;flex-shrink:0" aria-hidden="true"></i>
        <div style="overflow:hidden;flex:1">
          <input type="text" value="${escapeHtml(cv.label||'')}" placeholder="Apodo (ej. CV Desarrollo)"
            style="width:100%;background:transparent;border:none;border-bottom:1px dashed var(--border-mid);color:var(--text);font-size:13px;padding:2px 0"
            onchange="renameCV('${cv.id}', this.value)"/>
          <div style="font-size:11px;opacity:.55;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(cv.name)}</div>
        </div>
      </div>
      <button class="btn" style="font-size:12px;flex-shrink:0" onclick="downloadCV('${cv.id}')" title="Descargar como respaldo"><i class="ti ti-download" aria-hidden="true"></i></button>
      <button class="btn btn-danger" style="font-size:12px;flex-shrink:0" onclick="removeCVSlot('${cv.id}')"><i class="ti ti-trash" aria-hidden="true"></i></button>
    </div>
  `).join('');
}

function populateCVSelect(){
  const sel = get('new-cv'); if(!sel) return;
  const prev = sel.value;
  sel.innerHTML = S.cvs.length
    ? S.cvs.map(cv => `<option value="${cv.id}">${escapeHtml(cv.label || cv.name)}</option>`).join('')
    : `<option value="">— sin CVs cargados —</option>`;
  if(S.cvs.some(cv => cv.id===prev)) sel.value = prev;
}

/* ── Horarios ───────────────────────────── */
function addTime(){
  const t = get('new-time').value;
  if(!t || S.times.includes(t)) return;
  S.times.push(t); S.times.sort();
  save(); renderTimes();
}

function removeTime(t){
  S.times = S.times.filter(x => x!==t);
  save(); renderTimes();
}

function renderTimes(){
  get('times-row').innerHTML = S.times.map(t =>
    `<div class="chip"><i class="ti ti-clock" style="font-size:13px" aria-hidden="true"></i>${t}
     <button onclick="removeTime('${t}')" aria-label="Quitar ${t}">×</button></div>`
  ).join('');
}

/* ── Asunto automático ──────────────────── */
function updateNewSubject(){
  const v = get('new-vacante').value;
  const e = get('new-empresa').value;
  const base = S.subject || 'Aplicación para vacante de {{vacante}}';
  get('new-subject-camp').value = base
    .replace('{{vacante}}', v || '[vacante]')
    .replace('{{empresa}}', e || '[empresa]');
}

/* ── Crear campaña ──────────────────────── */
function addCampaign(){
  const dest    = get('new-dest').value.trim();
  const vacante = get('new-vacante').value.trim();
  const empresa = get('new-empresa').value.trim();
  const subject = get('new-subject-camp').value.trim();
  const body    = get('new-body-camp').value.trim();
  const cvId    = get('new-cv').value;
  const days    = parseInt(get('new-days').value);

  if(!dest){ alert('Ingresa el correo destinatario'); return; }
  if(!S.times.length){ alert('Agrega horarios de envío en Plantilla y CVs primero'); return; }

  if(!cvId || !S.cvs.find(cv => cv.id===cvId)){
    if(!confirm('No hay un CV válido seleccionado. ¿Continuar de todas formas?\nPodés cargarlo en Plantilla y CVs antes de iniciar.')) return;
  }

  const fuEnabled = get('new-followup-enabled').checked;
  const fuDays    = parseInt(get('new-followup-days').value) || 4;
  const fuSubject = get('new-followup-subject').value.trim();
  const fuBody    = get('new-followup-body').value.trim();

  const id = 'c' + Date.now();
  S.campaigns.push({
    id, dest, vacante, empresa, subject, body, cvId,
    days, times:[...S.times],
    sent:0, total: days * S.times.length,
    active:false, log:[], sentLog:[],
    opens:[],
    followUp: fuEnabled ? {
      enabled:true, afterDays:fuDays,
      subject: fuSubject || subject, body: fuBody || body || S.body,
      sent:false, sentAt:null
    } : null,
    createdAt: new Date().toISOString()
  });
  save();

  get('new-dest').value = '';
  get('new-vacante').value = '';
  get('new-empresa').value = '';
  get('new-subject-camp').value = '';
  get('new-body-camp').value = '';
  get('new-followup-enabled').checked = false;
  get('new-followup-days').value = '4';
  get('new-followup-subject').value = '';
  get('new-followup-body').value = '';
  renderCampaigns();
}

/* ── Renderizar campañas ────────────────── */
function renderCampaigns(){
  const el = get('camps-list');
  if(!S.campaigns.length){
    el.innerHTML = `<div class="empty"><i class="ti ti-inbox" aria-hidden="true"></i><p>No hay campañas. Agrega una arriba.</p></div>`;
    return;
  }
  el.innerHTML = S.campaigns.map(c => {
    const pct = c.total > 0 ? Math.round((c.sent/c.total)*100) : 0;
    const status = c.active
      ? `<span class="badge b-info"><i class="ti ti-player-play" style="font-size:10px"></i> activa</span>`
      : c.sent >= c.total && c.total > 0
        ? `<span class="badge b-ok"><i class="ti ti-check" style="font-size:10px"></i> completada</span>`
        : `<span class="badge b-gray">en espera</span>`;
    const cv = S.cvs.find(x => x.id===c.cvId);
    const cvBadge = cv
      ? `<span class="badge b-info"><i class="ti ti-paperclip" style="font-size:10px"></i> ${escapeHtml(cv.label || cv.name)}</span>`
      : `<span class="badge b-warn"><i class="ti ti-alert-triangle" style="font-size:10px"></i> CV no cargado</span>`;
    const logHtml = c.log.length
      ? `<div class="log-box">${c.log.slice(-8).join('<br>')}</div>` : '';
    const anyOpened = (c.opens||[]).some(o => o.opened);
    const openBadge = S.pixelUrl && (c.opens||[]).length
      ? (anyOpened
          ? `<span class="badge b-ok"><i class="ti ti-eye" style="font-size:10px"></i> Abierto (aprox.)</span>`
          : `<span class="badge b-gray"><i class="ti ti-eye-off" style="font-size:10px"></i> Sin abrir</span>`)
      : '';
    const fuBadge = c.followUp
      ? (c.followUp.sent
          ? `<span class="badge b-info"><i class="ti ti-send" style="font-size:10px"></i> Seguimiento enviado</span>`
          : `<span class="badge b-gray"><i class="ti ti-clock" style="font-size:10px"></i> Seguimiento en ${c.followUp.afterDays}d si no abre</span>`)
      : '';
    return `<div class="card-camp" id="camp-${c.id}">
      <div class="camp-header">
        <div>
          <div class="dest">${c.dest}</div>
          <div class="meta">${c.vacante?c.vacante+' · ':''}${c.days} día${c.days>1?'s':''} · ${c.times.join(', ')}</div>
          <div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap">${cvBadge}${openBadge}${fuBadge}</div>
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px">
          ${status}<span style="font-size:12px;opacity:.6">${c.sent}/${c.total}</span>
        </div>
      </div>
      <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
      ${logHtml}
      <div class="camp-actions">
        ${!c.active && c.sent < c.total
          ? `<button class="btn btn-success" onclick="startCamp('${c.id}')"><i class="ti ti-player-play" aria-hidden="true"></i> Iniciar</button>` : ''}
        ${c.active
          ? `<button class="btn btn-danger" onclick="stopCamp('${c.id}')"><i class="ti ti-player-stop" aria-hidden="true"></i> Pausar</button>` : ''}
        ${S.pixelUrl && (c.opens||[]).length
          ? `<button class="btn" onclick="checkOpens(true)"><i class="ti ti-refresh" aria-hidden="true"></i> Verificar aperturas</button>` : ''}
        <button class="btn" onclick="deleteCamp('${c.id}')" style="margin-left:auto"><i class="ti ti-trash" aria-hidden="true"></i></button>
      </div>
    </div>`;
  }).join('');
}

/* ── Log ────────────────────────────────── */
function clog(id, msg){
  const c = S.campaigns.find(x => x.id===id); if(!c) return;
  const now = new Date().toLocaleTimeString('es-CR', {hour:'2-digit', minute:'2-digit'});
  c.log.push(`[${now}] ${msg}`);
  save(); renderCampaigns();
}

/* ── Notificaciones (apoyo a la mejora #2) ──────────────────────
   El navegador no puede enviar correos con la pestaña cerrada, pero
   sí puede avisar al usuario cuando la pestaña está en segundo plano
   o al reabrirla, para que sepa qué pasó mientras tanto. */
function ensureNotifyPermission(){
  if(!('Notification' in window)) return;
  if(Notification.permission === 'default') Notification.requestPermission();
}

function notify(title, body){
  if(!('Notification' in window)) return;
  if(Notification.permission !== 'granted') return;
  if(!document.hidden) return; // solo si el usuario no está viendo la pestaña
  try{ new Notification(title, { body }); }catch(e){}
}

/* ── Control campañas ───────────────────── */
function startCamp(id){
  ensureNotifyPermission();
  const c = S.campaigns.find(x => x.id===id); if(!c) return;
  if(!S.cvs.find(x => x.id===c.cvId)){
    alert('El CV de esta campaña no está cargado.\nCárgalo en Plantilla y CVs antes de iniciar.');
    go('plantilla'); return;
  }
  if(!token && !S.gmailConnected){ alert('Primero conecta Gmail en la pestaña Conexiones.'); go('conexiones'); return; }
  c.active = true; save(); renderCampaigns();
  clog(id, 'Campaña iniciada');
  scheduleNext(id);
}

function stopCamp(id){
  clearTimeout(timers[id]);
  const c = S.campaigns.find(x => x.id===id);
  if(c){ c.active = false; save(); }
  clog(id, 'Pausada manualmente');
  renderCampaigns();
}

function deleteCamp(id){
  clearTimeout(timers[id]);
  S.campaigns = S.campaigns.filter(x => x.id!==id);
  save(); renderCampaigns();
}

/* Reanuda todas las campañas activas — se llama al cargar la página,
   al reconectar Gmail y al volver a mostrar la pestaña (mejora #2). */
function resumeAll(){
  checkOpens();
  S.campaigns.filter(c => c.active).forEach(c => scheduleNext(c.id));
}

document.addEventListener('visibilitychange', () => {
  if(!document.hidden) resumeAll();
});

/* Programa (o envía si ya venció el plazo) el correo de seguimiento de una
   campaña que ya terminó su tanda normal, si tiene follow-up habilitado y
   aún no se envió. Devuelve true si la campaña debe seguir "activa"
   esperando ese seguimiento. */
function scheduleFollowUpIfNeeded(c){
  const fu = c.followUp;
  if(!fu || !fu.enabled || fu.sent) return false;

  const firstSent = (c.opens && c.opens[0]) ? new Date(c.opens[0].sentAt) : new Date(c.createdAt);
  const dueAt = new Date(firstSent.getTime() + fu.afterDays*24*60*60*1000);
  const delay = Math.max(0, dueAt - new Date());

  clearTimeout(timers[c.id]);
  timers[c.id] = setTimeout(async () => {
    await checkOpens(true);
    const cc = S.campaigns.find(x => x.id === c.id);
    if(!cc || !cc.active || !cc.followUp || cc.followUp.sent) return;

    const anyOpened = (cc.opens||[]).some(o => o.opened);
    if(anyOpened){
      clog(cc.id, '👁 El destinatario abrió el correo — se omite el seguimiento');
    } else {
      clog(cc.id, `✉ Sin apertura detectada tras ${fu.afterDays} día(s) — enviando seguimiento`);
      const ok = await sendEmail(cc.id, null, 0, true);
      clog(cc.id, ok ? '✓ Seguimiento enviado' : '✗ No se pudo enviar el seguimiento');
    }
    cc.followUp.sent = true;
    cc.followUp.sentAt = new Date().toISOString();
    cc.active = false; save(); renderCampaigns();
  }, delay);

  if(delay > 0){
    clog(c.id, `Seguimiento programado para ${dueAt.toLocaleString('es-CR')} si no hay apertura`);
  }
  return true;
}

/* ── Programación con ventana de recuperación y sentLog ── */
function scheduleNext(id){
  const c = S.campaigns.find(x => x.id===id);
  if(!c || !c.active) return;

  if(c.sent >= c.total){
    if(scheduleFollowUpIfNeeded(c)) return;
    c.active = false; save(); renderCampaigns();
    return;
  }

  clearTimeout(timers[id]);
  const now = new Date();

  // Si la aplicación estuvo abierta pero sin ejecutar (pestaña suspendida),
  // informa una sola vez qué horarios de hoy quedaron fuera de recuperación.
  reportMissedSchedules(c, now);

  // 1. Buscar envíos perdidos recuperables (pasaron hace < RECOVERY_WINDOW_MS y NO están en sentLog)
  let recuperar = null;
  let recuperarHora = null;
  for(const t of c.times){
    const [h,m] = t.split(':');
    const d = new Date(); d.setHours(+h, +m, 0, 0);
    const diff = now - d; // ms desde que pasó esa hora
    if(diff > 0 && diff <= RECOVERY_WINDOW_MS && !yaEnviado(c, t)){
      // De todos los recuperables, tomar el más reciente (menor diff)
      if(!recuperar || diff < (now - recuperar)){
        recuperar = d;
        recuperarHora = t;
      }
    }
  }

  if(recuperar && recuperarHora){
    const mins = Math.round((now - recuperar) / 60000);
    clog(id, `↻ Horario de las ${recuperarHora} recuperable: pasó hace ${mins} min (límite 60 min). Se intentará enviar ahora.`);
    timers[id] = setTimeout(async () => {
      const ok = await sendEmail(id, recuperarHora);
      if(ok){
        const cc = S.campaigns.find(x => x.id===id);
        if(cc){ cc.sent++; marcarEnviado(cc, recuperarHora); save(); }
      }
      scheduleNext(id);
    }, 1500);
    return;
  }

  // 2. Sin recuperables — buscar próxima hora futura
  let next = null;
  let nextHora = null;
  for(const t of c.times){
    const [h,m] = t.split(':');
    const d = new Date(); d.setHours(+h, +m, 0, 0);
    if(d > now && (!next || d < next)){ next = d; nextHora = t; }
  }
  if(!next){
    // Todas pasaron hoy — programar la primera hora para mañana
    nextHora = c.times[0];
    const [h,m] = nextHora.split(':');
    next = new Date(); next.setDate(next.getDate()+1); next.setHours(+h, +m, 0, 0);
  }

  const delay = next - now;
  const mins  = Math.round(delay / 60000);
  clog(id, `Próximo envío en ${mins<60 ? mins+' min' : Math.round(mins/60)+'h'} (${next.toLocaleTimeString('es-CR',{hour:'2-digit',minute:'2-digit'})})`);
  timers[id] = setTimeout(async () => {
    const ok = await sendEmail(id, nextHora);
    if(ok){
      const cc = S.campaigns.find(x => x.id===id);
      if(cc){ cc.sent++; marcarEnviado(cc, nextHora); save(); }
    }
    scheduleNext(id);
  }, delay);
}

function reportMissedSchedules(c, now){
  const today = localDateStr(now);
  let checks = {};
  try{ checks = JSON.parse(sessionStorage.getItem(LAST_SCHEDULE_CHECK_KEY) || '{}'); }catch(e){}
  const checkKey = `${c.id}_${today}`;
  if(checks[checkKey]) return;

  const expired = c.times.filter(t => {
    const [h,m] = t.split(':');
    const scheduled = new Date(now); scheduled.setHours(+h, +m, 0, 0);
    const elapsed = now - scheduled;
    return elapsed > RECOVERY_WINDOW_MS && !yaEnviado(c, t);
  });
  const pendingCount = Math.max(0, c.total - c.sent);
  expired.length = Math.min(expired.length, pendingCount);
  if(expired.length){
    const labels = expired.join(', ');
    clog(c.id, `⏭ Horario(s) ${labels} omitido(s): pasó más de 60 min sin registro. No se reenviará para evitar acumular correos.`);
  }
  checks[checkKey] = true;
  try{ sessionStorage.setItem(LAST_SCHEDULE_CHECK_KEY, JSON.stringify(checks)); }catch(e){}
}

/* ── Tracking de apertura por píxel (mejora "seguimiento") ──────
   El estado se consulta vía JSONP (no fetch normal) porque los Web Apps
   de Apps Script no devuelven cabeceras CORS para XHR/fetch cross-origin. */
function escapeHtml(s){
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function checkOpens(force=false){
  if(!S.pixelUrl) return Promise.resolve();
  const now = Date.now();
  if(!force && now - lastOpensCheckTs < 15*60*1000) return Promise.resolve();
  lastOpensCheckTs = now;

  const pending = [];
  S.campaigns.forEach(c => (c.opens||[]).forEach(o => { if(!o.opened) pending.push(o.trackingId); }));
  if(!pending.length) return Promise.resolve();

  return new Promise(resolve => {
    const cbName = '__pixelStatusCb' + Date.now();
    const script = document.createElement('script');
    const timeout = setTimeout(() => { cleanup(); resolve(); }, 8000);
    function cleanup(){
      clearTimeout(timeout);
      delete window[cbName];
      script.remove();
    }
    window[cbName] = (result) => {
      Object.keys(result || {}).forEach(tid => {
        const info = result[tid]; // { first, last, hits }
        S.campaigns.forEach(c => (c.opens||[]).forEach(o => {
          if(o.trackingId !== tid) return;
          const sentAt = new Date(o.sentAt).getTime();
          const lastAt = new Date(info.last).getTime();
          // Heurística: un solo hit muy pegado al envío es casi seguro el
          // pre-escaneo automático de Gmail, no una apertura real.
          o.opened = (info.hits >= 2) || (lastAt - sentAt > OPEN_GRACE_MS);
          o.openedAt = info.first;
          o.hits = info.hits;
        }));
      });
      save(); renderCampaigns();
      cleanup(); resolve();
    };
    script.onerror = () => { cleanup(); resolve(); };
    script.src = `${S.pixelUrl}${S.pixelUrl.includes('?')?'&':'?'}action=status&ids=${encodeURIComponent(pending.join(','))}&callback=${cbName}`;
    document.body.appendChild(script);
  });
}

/* ── Envío (con reintentos, backoff y píxel de apertura) ─────────────── */
async function sendEmail(id, horaSlot, attempt=0, isFollowUp=false){
  const c = S.campaigns.find(x => x.id===id); if(!c) return false;

  // Doble chequeo: si por alguna carrera de condición ya se envió, abortar
  if(horaSlot && yaEnviado(c, horaSlot)){
    clog(id, `⚠ Envío de las ${horaSlot} ya registrado — omitido`);
    return false;
  }

  const cv = S.cvs.find(x => x.id===c.cvId);
  if(!cv){ clog(id, `✗ CV no cargado — envío omitido`); return false; }
  const cvData = cv.data, cvName = cv.name, cvLabel = cv.label || cv.name;

  const ready = await ensureFreshToken();
  if(!ready){ clog(id, '✗ No se pudo obtener un token de Gmail — reconecta en la pestaña Conexiones'); return false; }

  const subject = (isFollowUp && c.followUp) ? c.followUp.subject : c.subject;
  let body = (isFollowUp && c.followUp) ? c.followUp.body : (c.body || S.body || '');
  body = body
    .replace(/\{\{vacante\}\}/g, c.vacante || '')
    .replace(/\{\{empresa\}\}/g, c.empresa || '')
    .replace(/\{\{nombre\}\}/g,  '');

  const trackingId = S.pixelUrl ? (c.id + '_' + Date.now()) : null;

  const boundaryMixed = 'bnd' + Date.now();
  let bodyPart;
  if(trackingId){
    const boundaryAlt = 'alt' + Date.now();
    const pixelSrc = `${S.pixelUrl}${S.pixelUrl.includes('?')?'&':'?'}id=${trackingId}`
      + `&dest=${encodeURIComponent(c.dest||'')}`
      + `&vacante=${encodeURIComponent(c.vacante||'')}`;
    const htmlBody = escapeHtml(body).replace(/\n/g, '<br>\n')
      + `\n<img src="${pixelSrc}" width="1" height="1" style="display:none" alt="">`;
    bodyPart = [
      `Content-Type: multipart/alternative; boundary="${boundaryAlt}"`,``,
      `--${boundaryAlt}`,
      `Content-Type: text/plain; charset="UTF-8"`,
      `Content-Transfer-Encoding: base64`,``,
      btoa(unescape(encodeURIComponent(body))),``,
      `--${boundaryAlt}`,
      `Content-Type: text/html; charset="UTF-8"`,
      `Content-Transfer-Encoding: base64`,``,
      btoa(unescape(encodeURIComponent(htmlBody))),``,
      `--${boundaryAlt}--`
    ].join('\n');
  } else {
    bodyPart = [
      `Content-Type: text/plain; charset="UTF-8"`,
      `Content-Transfer-Encoding: base64`,``,
      btoa(unescape(encodeURIComponent(body)))
    ].join('\n');
  }

  const mime = [
    `MIME-Version: 1.0`,
    `To: ${c.dest}`,
    `Subject: =?UTF-8?B?${btoa(unescape(encodeURIComponent(subject)))}?=`,
    `Content-Type: multipart/mixed; boundary="${boundaryMixed}"`,``,
    `--${boundaryMixed}`,
    bodyPart,``,
    `--${boundaryMixed}`,
    `Content-Type: application/pdf`,
    `Content-Transfer-Encoding: base64`,
    `Content-Disposition: attachment; filename="${cvName}"`,``,
    cvData,``,
    `--${boundaryMixed}--`
  ].join('\n');

  const raw = btoa(unescape(encodeURIComponent(mime)))
    .replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');

  const MAX_RETRIES = 4;

  try{
    const r = await fetch('https://www.googleapis.com/gmail/v1/users/me/messages/send',{
      method:'POST',
      headers:{ Authorization:`Bearer ${token}`, 'Content-Type':'application/json' },
      body: JSON.stringify({ raw })
    });
    if(r.ok){
      if(trackingId){
        c.opens = c.opens || [];
        c.opens.push({ trackingId, sentAt: new Date().toISOString(), opened:false, openedAt:null });
      }
      save();
      clog(id, `✓ Enviado a ${c.dest} [${cvLabel}]${isFollowUp ? ' (seguimiento)' : ''}`);
      notify('CV enviado', `Se envió el CV a ${c.dest}`);
      return true;
    }
    if((r.status === 429 || r.status >= 500) && attempt < MAX_RETRIES){
      const wait = Math.min(30000, 1000 * 2 ** attempt) + Math.random()*500;
      clog(id, `⏳ Gmail respondió ${r.status} — reintentando en ${Math.round(wait/1000)}s`);
      await new Promise(res => setTimeout(res, wait));
      return sendEmail(id, horaSlot, attempt + 1, isFollowUp);
    }
    const e = await r.json().catch(() => ({}));
    if(e.error?.status === 'UNAUTHENTICATED'){
      clog(id, '✗ Token expirado — reconecta Gmail'); token = null; updateAuthBox();
    } else {
      clog(id, `✗ Error: ${e.error?.message || r.status}`);
      notify('Error enviando CV', `${c.dest}: ${e.error?.message || r.status}`);
    }
    return false;
  }catch(e){
    if(attempt < MAX_RETRIES){
      const wait = Math.min(30000, 1000 * 2 ** attempt);
      clog(id, `⏳ Error de red — reintentando en ${Math.round(wait/1000)}s`);
      await new Promise(res => setTimeout(res, wait));
      return sendEmail(id, horaSlot, attempt + 1, isFollowUp);
    }
    clog(id, `✗ Error de red (sin más reintentos)`);
    return false;
  }
}

/* ── Gmail OAuth vía Google Identity Services (mejora #1) ──────
   Sustituye el flujo "implicit" clásico (popup a accounts.google.com
   con response_type=token) por google.accounts.oauth2.initTokenClient,
   que permite pedir un token de forma silenciosa (prompt:'') mientras
   el usuario mantenga la sesión/consentimiento en Google, sin abrir
   popup cada vez que se recarga la página. */
function whenGoogleReady(cb, tries=0){
  if(window.google && google.accounts && google.accounts.oauth2) return cb();
  if(tries > 50) return; // ~10s esperando el script de Google
  setTimeout(() => whenGoogleReady(cb, tries+1), 200);
}

function getTokenClient(onToken){
  if(!S.clientId) return null;
  if(tokenClient) { tokenClient.callback = onToken; return tokenClient; }
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: S.clientId,
    scope: 'https://www.googleapis.com/auth/gmail.send',
    callback: onToken
  });
  return tokenClient;
}

function connectGmail(){
  const cid = get('client-id').value.trim();
  if(!cid){ alert('Ingresa tu Client ID primero'); return; }
  S.clientId = cid; save();
  whenGoogleReady(() => {
    const client = getTokenClient((resp) => {
      if(resp.error){ clogAuthError(resp.error); return; }
      token = resp.access_token;
      tokenExpiryTs = Date.now() + (resp.expires_in || 3600) * 1000;
      S.gmailConnected = true; save();
      updateAuthBox();
      resumeAll();
    });
    if(client) client.requestAccessToken({ prompt:'consent' });
  });
}

function disconnectGmail(){
  token = null; tokenExpiryTs = 0;
  S.gmailConnected = false; save();
  updateAuthBox();
}

// Reconexión silenciosa: sin popup si Google aún recuerda el consentimiento.
function trySilentReconnect(onDone){
  if(!S.clientId) return;
  whenGoogleReady(() => {
    const client = getTokenClient((resp) => {
      if(resp.error){ updateAuthBox(); return; } // falló silenciosamente, el usuario deberá reconectar a mano
      token = resp.access_token;
      tokenExpiryTs = Date.now() + (resp.expires_in || 3600) * 1000;
      updateAuthBox();
      if(onDone) onDone();
    });
    if(client) client.requestAccessToken({ prompt:'' });
  });
}

// Se llama antes de cada envío: renueva el token si está por vencer.
function ensureFreshToken(){
  if(token && Date.now() < tokenExpiryTs - 60000) return Promise.resolve(true);
  if(!S.clientId) return Promise.resolve(false);
  return new Promise(resolve => {
    whenGoogleReady(() => {
      const client = getTokenClient((resp) => {
        if(resp.error){ resolve(false); return; }
        token = resp.access_token;
        tokenExpiryTs = Date.now() + (resp.expires_in || 3600) * 1000;
        updateAuthBox();
        resolve(true);
      });
      if(!client){ resolve(false); return; }
      client.requestAccessToken({ prompt:'' });
    });
  });
}

function clogAuthError(err){
  console.warn('Gmail auth error:', err);
  updateAuthBox();
}

function updateAuthBox(){
  const b = get('auth-box');
  b.style.display = 'flex';
  if(token){
    b.className = 'auth-box auth-ok';
    b.innerHTML = `<i class="ti ti-check" aria-hidden="true"></i> Gmail conectado. Las campañas activas se reanudan automáticamente al reabrir la pestaña.`;
  } else {
    b.className = 'auth-box auth-warn';
    b.innerHTML = `<i class="ti ti-alert-triangle" aria-hidden="true"></i> No conectado. Haz clic en "Conectar con Google".`;
  }
}

/* ── Arranque ───────────────────────────── */
loadState();
get('def-subject').addEventListener('input', () => { save(); updateNewSubject(); });
