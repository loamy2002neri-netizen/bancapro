// Aplicar tema salvo ANTES de renderizar (evita flash escuro)
(function(){
  let t = null;
  try { t = localStorage.getItem('bancapro-theme'); } catch(e) { t = null; }
  if(t === 'light') {
    const r = document.documentElement;
    r.classList.remove('dark'); r.classList.add('light');
    r.style.setProperty('--bg-primary','#f8fafc');
    r.style.setProperty('--bg-secondary','#eef2f7');
    r.style.setProperty('--bg-card','#ffffff');
    r.style.setProperty('--text-primary','#0f172a');
    r.style.setProperty('--text-secondary','#475569');
    r.style.setProperty('--text-muted','#94a3b8');
    r.style.setProperty('--border','rgba(15,23,42,0.08)');
    r.style.setProperty('--border-hover','rgba(15,23,42,0.18)');
    r.style.setProperty('--glass','rgba(15,23,42,0.03)');
    r.style.setProperty('--glass-border','rgba(15,23,42,0.08)');
    r.style.setProperty('--topbar-bg','rgba(248,250,252,0.97)');
    r.style.setProperty('--shadow','0 4px 24px rgba(15,23,42,0.06)');
    r.style.setProperty('--shadow-card','0 2px 12px rgba(15,23,42,0.05)');
  }
})();

// ══════════════════════════════════════════════
//  ESTADO DA APLICAÇÃO
// ══════════════════════════════════════════════
let transactions = [];

// Banca inicial: saldo de partida definido pelo usuário (antes das transações).
// O dashboard soma os resultados a partir desse valor.
let SALDO_BASE = 0;
function loadSaldoInicial() {
  try {
    const v = parseFloat(localStorage.getItem('bancapro-saldo-inicial'));
    SALDO_BASE = isFinite(v) ? v : 0;
  } catch(e) { SALDO_BASE = 0; }
  return SALDO_BASE;
}

// ══════════════════════════════════════════════
//  PERSISTÊNCIA (localStorage com fallback gracioso)
// ══════════════════════════════════════════════
const STORAGE_KEYS = {
  transactions: 'bancapro-transactions',
  goals: 'bancapro-goals',
  methodsCompare: 'bancapro-methods-compare',
  methodsCatalog: 'bancapro-methods-catalog'
};

function persistState() {
  try {
    localStorage.setItem(STORAGE_KEYS.transactions, JSON.stringify(transactions));
    localStorage.setItem(STORAGE_KEYS.goals, JSON.stringify(goals));
    localStorage.setItem(STORAGE_KEYS.methodsCompare, JSON.stringify(methodsCompare));
    localStorage.setItem(STORAGE_KEYS.methodsCatalog, JSON.stringify(METHODS_CATALOG));
  } catch(e) { /* quota / modo anônimo / etc — ignora */ }
  if (typeof schedulePush === 'function') schedulePush();
}

function loadPersistedState() {
  try {
    const t = localStorage.getItem(STORAGE_KEYS.transactions);
    if(t) {
      const parsed = JSON.parse(t);
      if(Array.isArray(parsed) && parsed.length > 0) transactions = parsed;
    }
    const g = localStorage.getItem(STORAGE_KEYS.goals);
    if(g) {
      const parsed = JSON.parse(g);
      if(Array.isArray(parsed)) goals = parsed;
    }
    const m = localStorage.getItem(STORAGE_KEYS.methodsCompare);
    if(m) {
      const parsed = JSON.parse(m);
      if(Array.isArray(parsed) && parsed.length > 0) methodsCompare = parsed;
    }
    const c = localStorage.getItem(STORAGE_KEYS.methodsCatalog);
    if(c) {
      const parsed = JSON.parse(c);
      if(Array.isArray(parsed) && parsed.length > 0) METHODS_CATALOG = parsed;
    }
  } catch(e) { /* dados corrompidos — ignora */ }
}

async function resetAllData() {
  const ok = await customConfirm(
    'Apagar TODOS os dados (transações, metas, comparativos)? Essa ação não pode ser desfeita.',
    '⚠️ Apagar todos os dados',
    'Apagar tudo'
  );
  if(!ok) return;
  try {
    localStorage.removeItem(STORAGE_KEYS.transactions);
    localStorage.removeItem(STORAGE_KEYS.goals);
    localStorage.removeItem(STORAGE_KEYS.methodsCompare);
    localStorage.removeItem(STORAGE_KEYS.methodsCatalog);
    localStorage.removeItem(ACCOUNTS_KEY);
  } catch(e) {}
  location.reload();
}

let currentPeriod = 'month';
let notifOpen = false;

// ══════════════════════════════════════════════
//  AUTH + BANCO DE DADOS (Supabase)
// ══════════════════════════════════════════════
let sbClient = null;
let currentUserId = null;
let currentAuthUser = null;

// Cria (uma vez) o cliente Supabase a partir das chaves em config.js
function getSb() {
  if (sbClient) return sbClient;
  const url = window.SUPABASE_URL, key = window.SUPABASE_ANON_KEY;
  if (!window.supabase || !url || !key || String(url).indexOf('COLE_') === 0) return null;
  sbClient = window.supabase.createClient(url, key);
  return sbClient;
}

// Chaves do localStorage que pertencem a cada usuário (sincronizadas no banco)
const SYNC_KEYS = [
  'bancapro-transactions',
  'bancapro-goals',
  'bancapro-methods-compare',
  'bancapro-methods-catalog',
  'bancapro-accounts',
  'bancapro-user-name',
  'bancapro-user-email',
  'bancapro-logo',
  'bancapro-favicon',
  'bancapro-saldo-inicial',
  'bancapro-platform-name',
  'bancapro-slogan',
  'bancapro-logo-style',
  'bancapro-logo-color1',
  'bancapro-logo-color2',
  'bancapro-logo-split',
  'bancapro-accent',
  'bancapro-accent2',
  'bancapro-theme',
  'bancapro-notes'
];

function clearUserLocal() {
  SYNC_KEYS.forEach(k => { try { localStorage.removeItem(k); } catch(e){} });
}

// ─── Backend LOCAL (usado quando o Supabase não está configurado) ───
// Guarda contas no navegador com senha protegida por hash SHA-256 + salt.
const LOCAL_USERS_KEY = 'bancapro-users';
const LOCAL_SESSION_KEY = 'bancapro-session';
function localGetUsers() {
  try { return JSON.parse(localStorage.getItem(LOCAL_USERS_KEY) || '[]'); } catch(e) { return []; }
}
function localSetUsers(list) {
  try { localStorage.setItem(LOCAL_USERS_KEY, JSON.stringify(list)); } catch(e){}
}
function randomId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'u' + Date.now().toString(16) + Math.random().toString(16).slice(2);
}
async function hashPassword(password, salt) {
  const enc = new TextEncoder().encode(salt + ':' + password);
  const buf = await crypto.subtle.digest('SHA-256', enc);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('');
}

// Aplica um blob de dados (vindo da nuvem ou do navegador) nas chaves ativas
function applyBlob(blob) {
  if (!blob || typeof blob !== 'object') return;
  Object.keys(blob).forEach(k => {
    if (SYNC_KEYS.indexOf(k) !== -1 && blob[k] != null) {
      try { localStorage.setItem(k, blob[k]); } catch(e){}
    }
  });
}

// Baixa o "banco" do usuário e popula o localStorage para os loaders existentes lerem
async function pullUserData(userId) {
  clearUserLocal();
  const sb = getSb();
  if (sb) {
    try {
      const { data, error } = await sb.from('user_data').select('data').eq('user_id', userId).maybeSingle();
      if (error) { console.warn('pullUserData', error); return; }
      applyBlob(data && data.data ? data.data : null);
    } catch(e) { console.warn('pullUserData', e); }
  } else {
    try {
      const raw = localStorage.getItem('bancapro-userdata-' + userId);
      if (raw) applyBlob(JSON.parse(raw));
    } catch(e){}
  }
}

// Salva o "banco" do usuário (debounced — chamado por persistState/persistAccounts/saveProfile)
let _pushTimer = null;
function schedulePush() {
  if (!currentUserId) return;
  clearTimeout(_pushTimer);
  _pushTimer = setTimeout(pushUserData, 800);
}
async function pushUserData() {
  if (!currentUserId) return null;
  const blob = {};
  SYNC_KEYS.forEach(k => {
    try { const v = localStorage.getItem(k); if (v != null) blob[k] = v; } catch(e){}
  });
  const sb = getSb();
  if (sb) {
    try {
      const { error } = await sb.from('user_data')
        .upsert({ user_id: currentUserId, data: blob, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
      if (error) { console.warn('pushUserData', error); return error; }
      return null;
    } catch(e) { console.warn('pushUserData', e); return e; }
  } else {
    try { localStorage.setItem('bancapro-userdata-' + currentUserId, JSON.stringify(blob)); return null; }
    catch(e){ return e; }
  }
}

// Entra no app depois de autenticado
async function enterApp(user) {
  currentUserId = user.id;
  document.getElementById('authScreen').style.display = 'none';
  document.getElementById('appLayout').style.display = 'flex';
  await pullUserData(user.id);
  try {
    if (user.email && !localStorage.getItem('bancapro-user-email')) {
      localStorage.setItem('bancapro-user-email', user.email);
    }
    const metaName = user.user_metadata && user.user_metadata.name;
    if (metaName && !localStorage.getItem('bancapro-user-name')) {
      localStorage.setItem('bancapro-user-name', metaName);
    }
  } catch(e){}
  loadPersistedState();
  loadAccounts();
  loadProfile();
  rebuildMethodSelector();
  initCharts();
  renderGoals();
  renderAccounts();
  recomputeAll();
  loadStoredBranding();
  loadPlatformSettings();
  // aplica o tema que veio da nuvem (sincroniza entre aparelhos)
  try {
    const th = localStorage.getItem('bancapro-theme') || 'dark';
    const btn = document.getElementById(th === 'light' ? 'themeBtnLight' : 'themeBtnDark');
    setTheme(th, btn);
    updateThemeBtn(th);
  } catch(e){}
  setTimeout(() => showToast('Bem-vindo de volta! 👋','success'), 400);
  // Bloqueio por assinatura (não trava modo local nem o dono nem o trial)
  currentAuthUser = user;
  try {
    const allowed = await checkAccess(user);
    if (allowed) hidePaywall(); else showPaywall();
  } catch(e) { hidePaywall(); }
  // Menu Admin/Afiliados só para o dono
  try {
    const isOwner = OWNER_EMAILS.includes((user.email || '').toLowerCase());
    const navAdmin = document.getElementById('navAdmin');
    if (navAdmin) navAdmin.style.display = isOwner ? '' : 'none';
    const navAfiliados = document.getElementById('navAfiliados');
    if (navAfiliados) navAfiliados.style.display = isOwner ? '' : 'none';
  } catch(e){}
  // Registra a indicação (?ref) e libera o painel do afiliado, se for um
  try {
    await recordReferralIfAny(user);
    const sb = getSb();
    const navAf = document.getElementById('navAfiliado');
    if (sb && navAf) {
      const r = await sb.rpc('get_my_affiliate');
      navAf.style.display = (r.data && r.data.length) ? '' : 'none';
    }
  } catch(e){}
  // Voltou do checkout? mostra "obrigado" e reconfere a assinatura
  try {
    if (new URLSearchParams(location.search).get('assinatura') === 'ok') handleReturnFromCheckout();
  } catch(e){}
}

// ─── Controle de acesso por assinatura ───
const OWNER_EMAILS = ['loamy2002neri@gmail.com', 'loamy69zzz@gmail.com']; // nunca bloqueado (dono)

async function hasActiveSubscription(email) {
  const sb = getSb();
  if (!sb || !email) return false;
  try {
    const { data, error } = await sb.from('subscribers').select('status,valid_until').eq('email', email.toLowerCase()).maybeSingle();
    if (error) return false;
    if (!data || data.status !== 'active') return false;
    // acesso com prazo (liberação manual por X dias): expira na data
    if (data.valid_until && new Date(data.valid_until).getTime() < Date.now()) return false;
    return true;
  } catch(e) { return false; }
}

async function checkAccess(user) {
  if (!getSb()) return true;                 // modo local: sem bloqueio
  const email = (user && user.email || '').toLowerCase();
  if (OWNER_EMAILS.includes(email)) return true;
  if (await hasActiveSubscription(email)) return true;
  // Trial: 7 dias desde a criação da conta (não dá pra burlar limpando o navegador)
  try {
    const created = user && user.created_at ? new Date(user.created_at).getTime() : 0;
    if (created && (Date.now() - created) < TRIAL_DAYS * 86400000) return true;
  } catch(e) {}
  return false;
}

function showPaywall() { const el = document.getElementById('paywallOverlay'); if (el) el.style.display = 'flex'; }
function hidePaywall() { const el = document.getElementById('paywallOverlay'); if (el) el.style.display = 'none'; }

// Painel do dono: métricas agregadas (via função get_owner_stats no Supabase)
async function renderAdminStats() {
  const el = document.getElementById('adminStats');
  if (!el) return;
  const sb = getSb();
  if (!sb) { el.innerHTML = '<div class="empty-state-sub">Disponível só com o banco na nuvem.</div>'; return; }
  el.innerHTML = '<div class="empty-state-sub">Carregando…</div>';
  try {
    const { data, error } = await sb.rpc('get_owner_stats');
    if (error || !data) {
      el.innerHTML = '<div style="text-align:center;padding:14px"><div style="font-size:30px">🔒</div><div style="font-weight:700;margin-top:6px">Acesso restrito</div><div class="empty-state-sub">Este painel é só para o dono da plataforma.</div></div>';
      return;
    }
    const s = data;
    const conv = s.total_users > 0 ? ((s.active_subs / s.total_users) * 100).toFixed(1) : '0';
    // Conversão trial→pago = % dos usuários que JÁ assinaram alguma vez
    const convTrial = s.total_users > 0 ? ((s.total_subs / s.total_users) * 100).toFixed(1) : '0';
    // Churn (30 dias) — RPC nova e opcional; mostra "—" se ainda não foi criada no Supabase
    let churnTxt = '—';
    try {
      const { data: ch } = await sb.rpc('get_owner_churn');
      if (ch && ch.churn_pct != null) churnTxt = ch.churn_pct + '%';
    } catch(e) {}

    // Faturamento (MRR): calcula a partir dos planos dos assinantes ATIVOS
    let mensal = 0, anual = 0;
    try {
      const { data: users } = await sb.rpc('get_owner_users');
      (users || []).forEach(u => {
        const plan = u.plan || '';
        const isOwner = OWNER_EMAILS.includes((u.email||'').toLowerCase());
        const isComp  = plan === 'Liberado manualmente'; // cortesia não é receita
        if (u.status === 'active' && !isOwner && !isComp) {
          if (/anual|annual|yearly/i.test(plan)) anual++; else mensal++;
        }
      });
    } catch(e) {}
    const mrr = mensal * SUBSCRIPTION_PRICE + anual * (SUBSCRIPTION_PRICE_ANNUAL / 12);
    const fmtMrr = 'R$ ' + mrr.toLocaleString('pt-BR', {minimumFractionDigits:0, maximumFractionDigits:2});
    const fmtArr = 'R$ ' + (mrr * 12).toLocaleString('pt-BR', {maximumFractionDigits:0});

    el.innerHTML = `
      <div style="font-size:12px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.6px;font-weight:700;margin-bottom:8px">📌 Os 3 números que importam</div>
      <div class="stat-row" style="grid-template-columns:repeat(3,minmax(0,1fr))">
        <div class="stat-chip" style="border-color:rgba(16,185,129,0.35)"><div class="stat-chip-label">✅ Assinantes ativos</div><div class="stat-chip-value" style="font-size:22px;color:var(--green)">${s.active_subs}</div></div>
        <div class="stat-chip" style="border-color:rgba(244,63,94,0.35)"><div class="stat-chip-label">📉 Churn (30 dias)</div><div class="stat-chip-value" style="font-size:22px;color:var(--red)">${churnTxt}</div></div>
        <div class="stat-chip" style="border-color:rgba(139,92,246,0.35)"><div class="stat-chip-label">🎯 Conversão trial→pago</div><div class="stat-chip-value" style="font-size:22px;color:var(--accent2)">${convTrial}%</div></div>
      </div>
      <div class="stat-row" style="grid-template-columns:repeat(4,minmax(0,1fr));margin-top:14px">
        <div class="stat-chip"><div class="stat-chip-label">Usuários totais</div><div class="stat-chip-value">${s.total_users}</div></div>
        <div class="stat-chip"><div class="stat-chip-label">Já assinaram (total)</div><div class="stat-chip-value">${s.total_subs}</div></div>
        <div class="stat-chip"><div class="stat-chip-label">Cadastros (7 dias)</div><div class="stat-chip-value">${s.signups_7d}</div></div>
        <div class="stat-chip"><div class="stat-chip-label">Inativos/cancelados</div><div class="stat-chip-value">${s.inactive_subs}</div></div>
      </div>
      <div class="stat-row" style="grid-template-columns:repeat(3,minmax(0,1fr));margin-top:10px">
        <div class="stat-chip"><div class="stat-chip-label">💰 Faturamento mensal (MRR)</div><div class="stat-chip-value" style="color:var(--green)">${fmtMrr}</div></div>
        <div class="stat-chip"><div class="stat-chip-label">Projeção anual</div><div class="stat-chip-value">${fmtArr}</div></div>
        <div class="stat-chip"><div class="stat-chip-label">Ativos: mensal / anual</div><div class="stat-chip-value">${mensal} / ${anual}</div></div>
      </div>
      <div style="margin-top:14px;font-size:12px;color:var(--text-muted)">💡 <b>Ativos</b>: quem está pagando agora. <b>Churn</b>: % que cancelou nos últimos 30 dias. <b>Conversão</b>: dos cadastros, quantos viraram assinantes.</div>
    `;
  } catch(e) {
    el.innerHTML = '<div class="empty-state-sub">Erro ao carregar métricas.</div>';
  }
}

// Painel do dono: lista de usuários (via função get_owner_users no Supabase)
async function renderAdminUsers() {
  const el = document.getElementById('adminUsers');
  if (!el) return;
  const sb = getSb();
  const countEl = document.getElementById('adminUsersCount');
  if (!sb) { el.innerHTML = '<div class="empty-state-sub">Disponível só com o banco na nuvem.</div>'; return; }
  el.innerHTML = '<div class="empty-state-sub">Carregando…</div>';
  try {
    const { data, error } = await sb.rpc('get_owner_users');
    if (error || !data) { el.innerHTML = '<div class="empty-state-sub">Acesso restrito.</div>'; return; }
    if (countEl) countEl.textContent = data.length;
    if (!data.length) { el.innerHTML = '<div class="empty-state-sub">Nenhum usuário cadastrado ainda.</div>'; return; }
    const rows = data.map(u => {
      const st = u.status === 'active' ? {c:'var(--green)',t:'Ativo'}
               : (u.status === 'sem assinatura' ? {c:'var(--text-muted)',t:'Sem assinatura'} : {c:'var(--red)',t:'Inativo'});
      const created = u.created_at ? new Date(u.created_at).toLocaleDateString('pt-BR') : '—';
      const last = u.last_sign_in_at ? new Date(u.last_sign_in_at).toLocaleDateString('pt-BR') : '—';
      const emailAttr = escapeHtml(u.email || '');
      const statusAttr = escapeHtml(u.status || '');
      const editBtn = u.email
        ? `<button class="btn-ghost" style="padding:5px 14px;font-size:12px" data-email="${emailAttr}" data-status="${statusAttr}" onclick="openEditUser(this)">✏️ Editar</button>`
        : '';
      return `<tr>
        <td data-label="E-mail">${escapeHtml(u.email || '—')}</td>
        <td data-label="Status"><span style="color:${st.c};font-weight:600">${st.t}</span></td>
        <td data-label="Plano">${escapeHtml(u.plan || '—')}</td>
        <td data-label="Cadastro">${created}</td>
        <td data-label="Último acesso">${last}</td>
        <td data-label="" style="white-space:nowrap;text-align:right">${editBtn}</td>
      </tr>`;
    }).join('');
    el.innerHTML = `<div style="overflow-x:auto"><table class="admin-table">
      <thead><tr><th>E-mail</th><th>Status</th><th>Plano</th><th>Cadastro</th><th>Último acesso</th><th style="text-align:right">Ações</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;
  } catch(e) {
    el.innerHTML = '<div class="empty-state-sub">Erro ao carregar usuários.</div>';
  }
}

// ══════════════════════════════════════════════
//  AFILIADOS (real — Supabase)
// ══════════════════════════════════════════════
const _affColors = { 'Ativo':'var(--green)', 'Inativo':'var(--red)', 'Cadastrado':'var(--accent2)' };
function _affMoney(v){ return 'R$ ' + (Number(v)||0).toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2}); }

// ── Dono: adicionar afiliado ──
function openAddAffiliateModal() {
  ['affEmailInput','affCupomInput'].forEach(function(id){ var e=document.getElementById(id); if(e) e.value=''; });
  var c=document.getElementById('affComissaoInput'); if(c) c.value='50';
  document.getElementById('addAffiliateModal').classList.add('open');
}
function closeAddAffiliateModal() { document.getElementById('addAffiliateModal').classList.remove('open'); }
async function saveAffiliate() {
  var email=(document.getElementById('affEmailInput').value||'').trim().toLowerCase();
  var code=(document.getElementById('affCupomInput').value||'').trim();
  var pct=parseFloat(document.getElementById('affComissaoInput').value)||50;
  if(!email || !code){ showToast('Preencha email e código!','error'); return; }
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){ showToast('E-mail inválido!','error'); return; }
  // comissão em R$ por assinante ativo = pct% do líquido (líquido de R$24,90 ≈ R$21,68)
  var commission = +((21.68 * pct/100).toFixed(2));
  var sb=getSb(); if(!sb){ showToast('Disponível só com o banco na nuvem.','error'); return; }
  try {
    var r = await sb.rpc('add_affiliate', { p_email: email, p_code: code, p_commission: commission });
    if(r.error){ showToast('Erro: '+(r.error.message||'não foi possível'),'error'); return; }
    closeAddAffiliateModal();
    showToast('✅ Afiliado adicionado: '+email+' (link '+code.toUpperCase()+')','success');
    renderAffiliatesAdmin();
  } catch(e){ showToast('Erro ao adicionar afiliado.','error'); }
}
async function removeAffiliate(email) {
  var ok = await customConfirm('Remover o afiliado "'+email+'"? Ele perde o painel de indicações.','Remover afiliado','Remover');
  if(!ok) return;
  var sb=getSb(); if(!sb) return;
  try {
    var r = await sb.rpc('remove_affiliate', { p_email: email });
    if(r.error){ showToast('Erro: '+(r.error.message||'não foi possível'),'error'); return; }
    showToast('Afiliado removido.','info');
    renderAffiliatesAdmin();
  } catch(e){ showToast('Erro ao remover.','error'); }
}

// ── Dono: tabela de afiliados ──
async function renderAffiliatesAdmin() {
  var el=document.getElementById('adminAffiliates'); if(!el) return;
  var sb=getSb(); if(!sb){ el.innerHTML='<div class="empty-state-sub">Disponível só com o banco na nuvem.</div>'; return; }
  el.innerHTML='<div class="empty-state-sub">Carregando…</div>';
  try {
    var r = await sb.rpc('list_affiliates');
    if(r.error || !r.data){ el.innerHTML='<div class="empty-state-sub">Acesso restrito.</div>'; return; }
    if(!r.data.length){ el.innerHTML='<div class="empty-state-sub">Nenhum afiliado ainda. Clique em <b>+ Adicionar afiliado</b>.</div>'; return; }
    var rows=r.data.map(function(a){
      return '<tr>'+
        '<td data-label="Afiliado">'+escapeHtml(a.email)+'</td>'+
        '<td data-label="Slug"><span class="tx-method-pill">'+escapeHtml(a.code)+'</span></td>'+
        '<td data-label="Comissão">'+_affMoney(a.commission)+'/ativo</td>'+
        '<td data-label="Indicados">'+a.indicados+'</td>'+
        '<td data-label="Ativos" style="color:var(--green);font-weight:600">'+a.ativos+'</td>'+
        '<td data-label="A pagar" style="color:var(--green);font-weight:600">'+_affMoney(a.a_pagar)+'</td>'+
        '<td data-label="" style="white-space:nowrap;text-align:right">'+
          '<button class="btn-ghost" style="padding:5px 10px;font-size:12px" data-code="'+escapeHtml(a.code)+'" onclick="viewAffiliateReferrals(this.dataset.code)">👁 Ver indicados</button> '+
          '<button class="btn-ghost" style="padding:5px 10px;font-size:12px;color:var(--red)" data-email="'+escapeHtml(a.email)+'" onclick="removeAffiliate(this.dataset.email)">Remover</button>'+
        '</td></tr>';
    }).join('');
    el.innerHTML='<table class="admin-table"><thead><tr><th>Afiliado</th><th>Slug</th><th>Comissão</th><th>Indicados</th><th>Ativos</th><th>A pagar</th><th style="text-align:right">Ações</th></tr></thead><tbody>'+rows+'</tbody></table>';
  } catch(e){ el.innerHTML='<div class="empty-state-sub">Erro ao carregar afiliados.</div>'; }
}

// ── Lista de indicados de um código (dono: qualquer; afiliado: só o seu) ──
async function viewAffiliateReferrals(code) {
  var sb=getSb(); if(!sb) return;
  setTextSafe('affReferralsName', code);
  document.getElementById('affReferralsList').innerHTML='<div class="empty-state-sub">Carregando…</div>';
  document.getElementById('affReferralsModal').classList.add('open');
  try {
    var r = await sb.rpc('get_referrals', { p_code: code });
    document.getElementById('affReferralsList').innerHTML = _affReferralsHtml(r.data);
  } catch(e){ document.getElementById('affReferralsList').innerHTML='<div class="empty-state-sub">Erro ao carregar.</div>'; }
}
function closeAffReferralsModal() { document.getElementById('affReferralsModal').classList.remove('open'); }
function _affReferralsHtml(data) {
  if(!data || !data.length) return '<div class="empty-state-sub">Ninguém entrou por esse link ainda.</div>';
  var rows=data.map(function(r){
    var dt=r.entrou ? new Date(r.entrou).toLocaleDateString('pt-BR') : '—';
    return '<tr><td data-label="Pessoa">'+escapeHtml(r.email)+'</td><td data-label="Entrou em">'+dt+'</td><td data-label="Status"><span style="color:'+(_affColors[r.status]||'var(--text-muted)')+';font-weight:600">'+r.status+'</span></td></tr>';
  }).join('');
  return '<div style="overflow-x:auto"><table class="admin-table"><thead><tr><th>Pessoa</th><th>Entrou em</th><th>Status</th></tr></thead><tbody>'+rows+'</tbody></table></div>';
}

// ── Afiliado: painel próprio ("Minhas Indicações") ──
async function renderMyAffiliatePanel() {
  var sb=getSb(); if(!sb) return;
  try {
    var r = await sb.rpc('get_my_affiliate');
    if(r.error || !r.data || !r.data.length) return;
    var a=r.data[0];
    var link = location.origin + '/?ref=' + a.code;
    setTextSafe('myAffCode', a.code);
    setTextSafe('myAffLink', link);
    setTextSafe('myAffCommission', _affMoney(a.commission));
    setTextSafe('myAffIndicados', a.indicados);
    setTextSafe('myAffAtivos', a.ativos);
    setTextSafe('affEntradas', _affMoney(a.a_pagar));
    var listEl=document.getElementById('myAffList');
    if(listEl){
      var rr = await sb.rpc('get_referrals', { p_code: a.code });
      listEl.innerHTML = _affReferralsHtml(rr.data);
    }
    renderMyWithdrawals(a.a_pagar);
  } catch(e){}
}

// ── Afiliado: saque de comissão ──
async function renderMyWithdrawals(aPagar) {
  var sb=getSb(); if(!sb) return;
  try {
    var r=await sb.rpc('my_withdrawals');
    var list=r.data||[];
    var pend=list.filter(function(w){return w.status==='pendente';}).reduce(function(s,w){return s+Number(w.amount||0);},0);
    var pago=list.filter(function(w){return w.status==='pago';}).reduce(function(s,w){return s+Number(w.amount||0);},0);
    var disp=Math.max(0,(Number(aPagar)||0)-pend);
    window._sqDisponivel=disp;
    setTextSafe('affSaldo', _affMoney(disp));
    setTextSafe('affSaidas', _affMoney(pago));
    setTextSafe('affPendente', _affMoney(pend));
    setTextSafe('sqDisponivel', _affMoney(disp));
    setTextSafe('sqTotal', _affMoney(aPagar));
    var el=document.getElementById('sqHistorico'); if(!el) return;
    if(!list.length){ el.innerHTML=''; return; }
    var rows=list.map(function(w){
      var dt=w.created_at?new Date(w.created_at).toLocaleDateString('pt-BR'):'—';
      var st=w.status==='pago'?'<span style="color:var(--green);font-weight:600">Pago ✓</span>':'<span style="color:var(--yellow);font-weight:600">Pendente</span>';
      return '<tr><td data-label="Data">'+dt+'</td><td data-label="Valor">'+_affMoney(w.amount)+'</td><td data-label="Status">'+st+'</td></tr>';
    }).join('');
    el.innerHTML='<div style="font-size:12px;color:var(--text-muted);margin:10px 0 6px">Seus saques</div><div style="overflow-x:auto"><table class="admin-table"><thead><tr><th>Data</th><th>Valor</th><th>Status</th></tr></thead><tbody>'+rows+'</tbody></table></div>';
  } catch(e){}
}
async function requestWithdrawal() {
  var sb=getSb(); if(!sb){ showToast('Disponível só com o banco na nuvem.','error'); return; }
  var valor=parseFloat(document.getElementById('sqValor').value);
  var tipo=document.getElementById('sqPixTipo').value;
  var chave=(document.getElementById('sqPixChave').value||'').trim();
  var obs=(document.getElementById('sqObs').value||'').trim();
  if(!isFinite(valor) || valor<=0){ showToast('Informe um valor válido!','error'); return; }
  var disp=Number(window._sqDisponivel||0);
  if(valor > disp + 0.001){ showToast('Valor maior que o disponível ('+_affMoney(disp)+').','error'); return; }
  if(!chave){ showToast('Informe a chave PIX!','error'); return; }
  try {
    var r=await sb.rpc('request_withdrawal',{p_amount:valor,p_pix_type:tipo,p_pix_key:chave,p_note:obs});
    if(r.error){ showToast('Erro: '+(r.error.message||'não foi possível'),'error'); return; }
    showToast('✅ Saque solicitado! Aguarde o pagamento por Pix.','success');
    document.getElementById('sqValor').value=''; document.getElementById('sqPixChave').value=''; document.getElementById('sqObs').value='';
    renderMyAffiliatePanel();
  } catch(e){ showToast('Erro ao solicitar saque.','error'); }
}

// ── Dono: saques solicitados ──
async function renderWithdrawalsAdmin() {
  var el=document.getElementById('adminWithdrawals'); if(!el) return;
  var sb=getSb(); if(!sb){ el.innerHTML='<div class="empty-state-sub">Disponível só com o banco na nuvem.</div>'; return; }
  el.innerHTML='<div class="empty-state-sub">Carregando…</div>';
  try {
    var r=await sb.rpc('list_withdrawals');
    if(r.error || !r.data){ el.innerHTML='<div class="empty-state-sub">Acesso restrito.</div>'; return; }
    if(!r.data.length){ el.innerHTML='<div class="empty-state-sub">Nenhum saque solicitado ainda.</div>'; return; }
    var rows=r.data.map(function(w){
      var dt=w.created_at?new Date(w.created_at).toLocaleDateString('pt-BR'):'—';
      var st=w.status==='pago'?'<span style="color:var(--green);font-weight:600">Pago ✓</span>':'<span style="color:var(--yellow);font-weight:600">Pendente</span>';
      var acao=w.status==='pendente'?'<button class="btn-ghost" style="padding:5px 10px;font-size:12px;color:var(--green)" data-id="'+w.id+'" onclick="markWithdrawalPaid(this.dataset.id)">Marcar pago</button>':'—';
      return '<tr><td data-label="Data">'+dt+'</td><td data-label="Afiliado">'+escapeHtml(w.affiliate_email)+'</td><td data-label="Valor">'+_affMoney(w.amount)+'</td><td data-label="Chave PIX">'+escapeHtml(w.pix_type)+': '+escapeHtml(w.pix_key)+'</td><td data-label="Obs">'+escapeHtml(w.note||'—')+'</td><td data-label="Status">'+st+'</td><td data-label="" style="text-align:right">'+acao+'</td></tr>';
    }).join('');
    el.innerHTML='<div style="overflow-x:auto"><table class="admin-table"><thead><tr><th>Data</th><th>Afiliado</th><th>Valor</th><th>Chave PIX</th><th>Obs</th><th>Status</th><th style="text-align:right">Ação</th></tr></thead><tbody>'+rows+'</tbody></table></div>';
  } catch(e){ el.innerHTML='<div class="empty-state-sub">Erro ao carregar saques.</div>'; }
}
async function markWithdrawalPaid(id) {
  var ok=await customConfirm('Confirmar que você PAGOU este saque por Pix?','Marcar como pago','Marcar pago',false);
  if(!ok) return;
  var sb=getSb(); if(!sb) return;
  try {
    var r=await sb.rpc('mark_withdrawal_paid',{p_id:parseInt(id,10)});
    if(r.error){ showToast('Erro: '+(r.error.message||''),'error'); return; }
    showToast('Saque marcado como pago.','success');
    renderWithdrawalsAdmin();
  } catch(e){ showToast('Erro ao marcar.','error'); }
}

function copyAffLink() {
  var link=(document.getElementById('myAffLink')||{}).textContent || '';
  if(!link || link==='—'){ showToast('Link ainda não carregado.','error'); return; }
  try {
    navigator.clipboard.writeText(link).then(
      function(){ showToast('✅ Link copiado!','success'); },
      function(){ showToast('Copie manualmente: '+link,'info'); }
    );
  } catch(e){ showToast('Copie manualmente: '+link,'info'); }
}
function shareAffLink() {
  var link=(document.getElementById('myAffLink')||{}).textContent||'';
  if(!link || link==='—'){ showToast('Link ainda não carregado.','error'); return; }
  var msg='💰 Gerencie sua banca de apostas com o Apostack — lucro, ROI e controle por casa. 7 dias grátis: '+link;
  window.open('https://wa.me/?text='+encodeURIComponent(msg),'_blank');
}

// ── Captura/registro de indicação (?ref) ──
async function recordReferralIfAny(user) {
  try {
    var ref=null; try { ref=localStorage.getItem('bancapro-ref'); } catch(e){}
    if(!ref || !user || !user.email) return;
    var sb=getSb(); if(!sb) return;
    await sb.from('referrals').upsert({ email: (user.email||'').toLowerCase(), ref: ref.toUpperCase() }, { onConflict:'email', ignoreDuplicates:true });
  } catch(e){}
}

// Painel do dono: liberar/bloquear acesso manualmente (rede de segurança p/ webhook falho)
let _grantEmail = null;
async function adminSetStatus(btn) {
  const email  = btn && btn.dataset ? btn.dataset.email : '';
  const status = btn && btn.dataset ? btn.dataset.status : '';
  if (!email || (status !== 'active' && status !== 'inactive')) return;
  const sb = getSb();
  if (!sb) { showToast('Disponível só com o banco na nuvem.','error'); return; }

  if (status === 'active') {
    // abre o modal de liberação (com campo de dias) em vez do prompt() nativo
    _grantEmail = email;
    setTextSafe('grantModalEmail', email);
    const inp = document.getElementById('grantDaysInput');
    if (inp) inp.value = '';
    document.getElementById('grantModal').classList.add('open');
    setTimeout(() => { if (inp) inp.focus(); }, 100);
    return;
  }
  // bloquear
  const ok = await customConfirm(`Bloquear o acesso de "${email}"?`, 'Bloquear acesso', 'Bloquear', true);
  if (!ok) return;
  await applyAccess(email, 'inactive', null);
}

// Painel do dono: modal "Editar usuário" (libera/bloqueia ou exclui)
let _editUser = null;
function openEditUser(btn) {
  const email = btn && btn.dataset ? btn.dataset.email : '';
  const status = btn && btn.dataset ? btn.dataset.status : '';
  if (!email) return;
  _editUser = { email: email, status: status };
  const isActive = status === 'active';
  setTextSafe('editUserEmail', email);
  const statusEl = document.getElementById('editUserStatus');
  if (statusEl) statusEl.innerHTML = isActive
    ? '<span style="color:var(--green);font-weight:600">Acesso ativo</span>'
    : '<span style="color:var(--text-muted);font-weight:600">Sem acesso</span>';
  const accessBtn = document.getElementById('editUserAccessBtn');
  if (accessBtn) {
    accessBtn.textContent = isActive ? '🚫 Bloquear acesso' : '🔓 Liberar acesso';
    accessBtn.className = isActive ? 'btn-ghost' : 'btn-primary';
    accessBtn.style.width = '100%';
    accessBtn.style.color = isActive ? 'var(--red)' : '';
    accessBtn.style.borderColor = isActive ? 'rgba(244,63,94,0.35)' : '';
  }
  const delBtn = document.getElementById('editUserDeleteBtn');
  if (delBtn) delBtn.style.display = OWNER_EMAILS.includes(email.toLowerCase()) ? 'none' : '';
  document.getElementById('editUserModal').classList.add('open');
}
function closeEditUser() { document.getElementById('editUserModal').classList.remove('open'); _editUser = null; }
function editUserToggleAccess() {
  if (!_editUser) return;
  const email = _editUser.email, isActive = _editUser.status === 'active';
  closeEditUser();
  adminSetStatus({ dataset: { email: email, status: isActive ? 'inactive' : 'active' } });
}
function editUserDelete() {
  if (!_editUser) return;
  const email = _editUser.email;
  closeEditUser();
  adminDeleteUser({ dataset: { email: email } });
}

// Painel do dono: excluir usuário DEFINITIVAMENTE (login + todos os dados)
async function adminDeleteUser(btn) {
  const email = btn && btn.dataset ? btn.dataset.email : '';
  if (!email) return;
  if (OWNER_EMAILS.includes(email.toLowerCase())) { showToast('Não dá pra excluir uma conta de dono.', 'error'); return; }
  const ok = await customConfirm(
    'Excluir DEFINITIVAMENTE "' + email + '"? Isso apaga o login e todos os dados dele (transações, métodos, assinatura, indicações). Esta ação NÃO pode ser desfeita.',
    'Excluir usuário', 'Excluir definitivamente', true);
  if (!ok) return;
  const sb = getSb();
  if (!sb) { showToast('Disponível só com o banco na nuvem.', 'error'); return; }
  try {
    const r = await sb.rpc('admin_delete_user', { p_email: email });
    if (r.error) { showToast('Erro: ' + (r.error.message || 'não foi possível'), 'error'); return; }
    showToast('Usuário excluído.', 'info');
    renderAdminUsers();
    if (typeof renderAdminStats === 'function') renderAdminStats();
  } catch (e) { showToast('Erro ao excluir usuário.', 'error'); }
}

function closeGrantModal() {
  document.getElementById('grantModal').classList.remove('open');
  _grantEmail = null;
}

async function confirmGrant() {
  const email = _grantEmail;
  if (!email) { closeGrantModal(); return; }
  const raw = (document.getElementById('grantDaysInput').value || '').trim();
  let days = null;
  if (raw !== '') {
    days = parseInt(raw, 10);
    if (!Number.isFinite(days) || days <= 0) { showToast('Informe um número de dias válido (ou deixe vazio = permanente).','error'); return; }
  }
  closeGrantModal();
  await applyAccess(email, 'active', days);
}

async function applyAccess(email, status, days) {
  const sb = getSb();
  if (!sb) return;
  try {
    const { error } = await sb.rpc('set_subscriber_status', { target_email: email, new_status: status, days: days });
    if (error) { showToast('Erro: ' + (error.message || 'não foi possível atualizar'), 'error'); return; }
    const msg = status === 'active'
      ? (days ? `✅ Liberado para ${email} por ${days} dias` : `✅ Acesso permanente liberado para ${email}`)
      : `🚫 Acesso bloqueado para ${email}`;
    showToast(msg, status === 'active' ? 'success' : 'info');
    renderAdminStats();
    renderAdminUsers();
  } catch(e) { showToast('Erro ao atualizar o acesso.','error'); }
}

// Painel do dono: erros recentes (via get_owner_errors no Supabase)
async function renderAdminErrors() {
  const el = document.getElementById('adminErrors');
  if (!el) return;
  const sb = getSb();
  if (!sb) { el.innerHTML = '<div class="empty-state-sub">Disponível só com o banco na nuvem.</div>'; return; }
  el.innerHTML = '<div class="empty-state-sub">Carregando…</div>';
  try {
    const { data, error } = await sb.rpc('get_owner_errors');
    if (error || !data) { el.innerHTML = '<div class="empty-state-sub">Acesso restrito.</div>'; return; }
    if (!data.length) { el.innerHTML = '<div class="empty-state-sub" style="color:var(--green)">Nenhum erro registrado. 🎉</div>'; return; }
    const rows = data.map(function(er) {
      const dt = er.created_at ? new Date(er.created_at).toLocaleString('pt-BR') : '—';
      return '<tr><td data-label="Quando" style="white-space:nowrap">' + dt + '</td><td data-label="Usuário">' + escapeHtml(er.email || '—') +
             '</td><td data-label="Erro" style="color:var(--red)">' + escapeHtml(String(er.message || '').slice(0,90)) +
             '</td><td data-label="Origem" style="color:var(--text-muted);font-size:11px">' + escapeHtml(String(er.source || '').slice(0,40)) + '</td></tr>';
    }).join('');
    el.innerHTML = '<div style="overflow-x:auto"><table class="admin-table"><thead><tr><th>Quando</th><th>Usuário</th><th>Erro</th><th>Origem</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
  } catch(e) {
    el.innerHTML = '<div class="empty-state-sub">Erro ao carregar.</div>';
  }
}

// Ao voltar do checkout (URL com ?assinatura=ok): agradece e reconfere a assinatura
// algumas vezes (o webhook do Kirvano pode levar alguns segundos pra chegar).
async function handleReturnFromCheckout() {
  try { history.replaceState(null, '', location.pathname); } catch(e){}
  showToast('Pagamento recebido! Ativando seu acesso… 🎉','success');
  for (let i = 0; i < 8; i++) {
    await new Promise(r => setTimeout(r, 2500));
    if (currentAuthUser && await checkAccess(currentAuthUser)) {
      hidePaywall();
      showToast('Assinatura ativa! Acesso liberado ✅','success');
      return;
    }
  }
  showToast('Recebemos seu pagamento. Se não liberar, clique em "Atualizar" na tela de assinatura.','info');
}

// Preenche o card "Gerenciar Assinatura" nas Configurações
async function renderSubscriptionCard() {
  const el = document.getElementById('subscriptionCard');
  if (!el) return;
  const user = currentAuthUser;
  const sb = getSb();
  let planName = 'Trial Gratuito', isActive = false, isTrial = false, validUntil = null;

  if (sb && user) {
    try {
      const { data } = await sb.from('subscribers').select('status,plan,updated_at,valid_until')
        .eq('email', (user.email || '').toLowerCase()).maybeSingle();
      const naoExpirou = !data || !data.valid_until || new Date(data.valid_until).getTime() > Date.now();
      if (data && data.status === 'active' && naoExpirou) {
        isActive = true;
        planName = data.plan || 'Plus';
        if (data.valid_until) {
          validUntil = new Date(data.valid_until); // liberação manual com prazo
        } else {
          const isAnnual = /anual|annual|yearly/i.test(planName);
          const base = data.updated_at ? new Date(data.updated_at) : new Date();
          validUntil = new Date(base.getTime() + (isAnnual ? 365 : 30) * 86400000);
        }
      }
    } catch(e) {}
  }
  if (!isActive && user && user.created_at) {
    const end = new Date(new Date(user.created_at).getTime() + TRIAL_DAYS * 86400000);
    if (end.getTime() > Date.now()) { isTrial = true; validUntil = end; planName = 'Trial Gratuito'; }
  }
  // Dono: sempre ativo
  if (!isActive && !isTrial && user && typeof OWNER_EMAILS !== 'undefined' && OWNER_EMAILS.includes((user.email||'').toLowerCase())) {
    isActive = true; planName = 'Acesso de Dono';
  }

  const daysLeft = validUntil ? Math.max(0, Math.ceil((validUntil.getTime() - Date.now()) / 86400000)) : null;
  const validStr = validUntil ? validUntil.toLocaleDateString('pt-BR') : '—';

  if (isActive || isTrial) {
    const dotColor = isActive ? 'var(--green)' : 'var(--accent)';
    const statusTxt = isActive ? 'Ativo' : 'Trial ativo';
    const dl = daysLeft != null ? `${daysLeft} ${daysLeft === 1 ? 'dia' : 'dias'}` : '—';
    el.innerHTML = `
      <div class="sub-plan-name">${escapeHtml(planName)}</div>
      <div class="sub-status-line"><span class="sub-dot" style="background:${dotColor}"></span><span style="color:${dotColor};font-weight:600">${statusTxt}</span></div>
      <div class="sub-grid">
        <div><div class="sub-k">Status</div><div class="sub-v">${isActive ? 'Active' : 'Trial'}</div></div>
        <div><div class="sub-k">Válido até</div><div class="sub-v">${validStr}</div></div>
        <div><div class="sub-k">Dias restantes</div><div class="sub-v" style="color:${daysLeft != null && daysLeft <= 3 ? 'var(--red)' : 'var(--text-primary)'}">${dl}</div></div>
      </div>
      <button class="${isTrial ? 'btn-primary' : 'btn-ghost'}" style="margin-top:16px;width:auto;padding:9px 18px" onclick="goTo('recharge')">${isTrial ? 'Assinar agora →' : 'Ver planos / gerenciar'}</button>
    `;
  } else {
    el.innerHTML = `
      <div class="sub-plan-name">Sem assinatura ativa</div>
      <div class="sub-status-line"><span class="sub-dot" style="background:var(--red)"></span><span style="color:var(--red);font-weight:600">Inativo</span></div>
      <p style="font-size:13px;color:var(--text-secondary);margin:10px 0 4px;line-height:1.5">Seu período acabou. Assine para liberar o painel completo.</p>
      <button class="btn-primary" style="margin-top:8px;width:auto;padding:9px 18px" onclick="goTo('recharge')">Assinar agora →</button>
    `;
  }
}

async function doLogin() {
  const email = (document.getElementById('loginEmail').value || '').trim().toLowerCase();
  const password = document.getElementById('loginPassword').value || '';
  if (!email || !password) { showToast('Preencha email e senha.','error'); return; }
  const sb = getSb();
  if (sb) {
    showToast('Entrando…','info');
    try {
      const { data, error } = await sb.auth.signInWithPassword({ email, password });
      if (error) { showToast('Email ou senha incorretos.','error'); return; }
      await enterApp(data.user);
    } catch(e) { showToast('Erro ao entrar. Tente novamente.','error'); }
  } else {
    const u = localGetUsers().find(x => x.email === email);
    if (!u) { showToast('Email ou senha incorretos.','error'); return; }
    const h = await hashPassword(password, u.salt);
    if (h !== u.passHash) { showToast('Email ou senha incorretos.','error'); return; }
    try { localStorage.setItem(LOCAL_SESSION_KEY, u.id); } catch(e){}
    await enterApp({ id: u.id, email: u.email, user_metadata: { name: u.name } });
  }
}

async function doRegister() {
  const name = (document.getElementById('regName').value || '').trim();
  const email = (document.getElementById('regEmail').value || '').trim().toLowerCase();
  const password = document.getElementById('regPassword').value || '';
  const password2 = (document.getElementById('regPassword2') || {}).value || '';
  if (!name || !email || !password) { showToast('Preencha nome, email e senha.','error'); return; }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { showToast('Email inválido.','error'); return; }
  if (password.length < 6) { showToast('A senha precisa de pelo menos 6 caracteres.','error'); return; }
  if (password !== password2) { showToast('As senhas não conferem. Digite a mesma nos dois campos.','error'); return; }
  const sb = getSb();
  if (sb) {
    showToast('Criando conta…','info');
    try {
      const { data, error } = await sb.auth.signUp({ email, password, options: { data: { name } } });
      if (error) {
        const m = String(error.message || '').toLowerCase();
        if (m.includes('registered') || m.includes('already')) showToast('Esse email já tem conta. Faça login.','error');
        else showToast('Não foi possível criar a conta: ' + (error.message || ''),'error');
        return;
      }
      if (data.session && data.user) {
        await enterApp(data.user); // confirmação de email desligada → entra direto
      } else {
        showToast('Conta criada! Confirme pelo link enviado ao seu email para entrar.','success');
        showLogin();
      }
    } catch(e) { showToast('Erro ao criar conta. Tente novamente.','error'); }
  } else {
    const users = localGetUsers();
    if (users.some(x => x.email === email)) { showToast('Esse email já tem conta. Faça login.','error'); return; }
    const salt = randomId();
    const passHash = await hashPassword(password, salt);
    const id = randomId();
    users.push({ id, name, email, salt, passHash });
    localSetUsers(users);
    try { localStorage.setItem(LOCAL_SESSION_KEY, id); } catch(e){}
    showToast('Conta criada com sucesso! 🎉','success');
    await enterApp({ id, email, user_metadata: { name } });
  }
}

async function doReset() {
  const email = (document.getElementById('resetEmail').value || '').trim().toLowerCase();
  if (!email) { showToast('Digite seu email.','error'); return; }
  const sb = getSb();
  if (sb) {
    try {
      const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
      if (error) { showToast('Não foi possível enviar: ' + (error.message || ''),'error'); return; }
      showToast('Email enviado! Verifique sua caixa de entrada.','success');
      showLogin();
    } catch(e) { showToast('Erro ao enviar email.','error'); }
  } else {
    showToast('Recuperação por email só funciona com o banco na nuvem (Supabase).','warning');
  }
}

async function logout() {
  const sb = getSb();
  try { if (sb) await sb.auth.signOut(); } catch(e){}
  try { localStorage.removeItem(LOCAL_SESSION_KEY); } catch(e){}
  clearUserLocal();
  currentUserId = null;
  location.reload();
}

function showLogin() { document.getElementById('loginForm').style.display='block'; document.getElementById('registerForm').style.display='none'; document.getElementById('resetForm').style.display='none'; }
function togglePw(btn, id) {
  const inp = document.getElementById(id); if(!inp) return;
  const show = inp.type === 'password';
  inp.type = show ? 'text' : 'password';
  btn.textContent = '👁';
  btn.style.opacity = show ? '1' : '';   // olho "aceso" quando a senha está visível
  btn.setAttribute('aria-label', show ? 'Ocultar senha' : 'Mostrar senha');
}
function showRegister() { document.getElementById('loginForm').style.display='none'; document.getElementById('registerForm').style.display='block'; document.getElementById('resetForm').style.display='none'; }
function showReset() { document.getElementById('loginForm').style.display='none'; document.getElementById('registerForm').style.display='none'; document.getElementById('resetForm').style.display='block'; const r=document.getElementById('recoveryForm'); if(r) r.style.display='none'; }
function showRecovery() {
  const auth = document.getElementById('authScreen'); if(auth) auth.style.display='';
  const app = document.getElementById('appLayout'); if(app) app.style.display='none';
  ['loginForm','registerForm','resetForm'].forEach(id => { const e=document.getElementById(id); if(e) e.style.display='none'; });
  const r=document.getElementById('recoveryForm'); if(r) r.style.display='block';
  setTimeout(() => { const i=document.getElementById('recPwd'); if(i) i.focus(); }, 100);
}
async function doRecovery() {
  const p1 = (document.getElementById('recPwd')||{}).value || '';
  const p2 = (document.getElementById('recPwd2')||{}).value || '';
  if (p1.length < 6) { showToast('A nova senha precisa de pelo menos 6 caracteres.','error'); return; }
  if (p1 !== p2) { showToast('As senhas não conferem.','error'); return; }
  const sb = getSb();
  if (!sb) { showToast('Disponível só com o banco na nuvem.','error'); return; }
  try {
    const { error } = await sb.auth.updateUser({ password: p1 });
    if (error) { showToast('Não foi possível trocar a senha: ' + (error.message||''),'error'); return; }
    showToast('✅ Senha redefinida! Você já pode entrar.','success');
    try { history.replaceState(null, '', location.origin + location.pathname); } catch(e){}
    try { await sb.auth.signOut(); } catch(e){}
    showLogin();
  } catch(e) { showToast('Erro ao redefinir a senha.','error'); }
}

// Captura o ?ref= do link de indicação (guarda pra registrar após o login)
try {
  const _refParam = new URLSearchParams(location.search).get('ref');
  if (_refParam && _refParam.trim()) localStorage.setItem('bancapro-ref', _refParam.trim());
} catch(e){}

// Restaura sessão ao abrir a página (auto-login se já estiver logado)
(async function restoreSession(){
  const sb = getSb();
  if (sb) {
    // Retorno do link de "redefinir senha": mostra a tela de definir nova senha
    sb.auth.onAuthStateChange((event) => { if (event === 'PASSWORD_RECOVERY') showRecovery(); });
    const isRecovery = /type=recovery/.test(location.hash || '');
    try {
      const { data } = await sb.auth.getSession();
      if (isRecovery) { showRecovery(); }
      else if (data && data.session && data.session.user) { await enterApp(data.session.user); }
    } catch(e){}
  } else {
    try {
      const sid = localStorage.getItem(LOCAL_SESSION_KEY);
      if (sid) {
        const u = localGetUsers().find(x => x.id === sid);
        if (u) await enterApp({ id: u.id, email: u.email, user_metadata: { name: u.name } });
      }
    } catch(e){}
  }
})();

// ══════════════════════════════════════════════
//  NAVIGATION
// ══════════════════════════════════════════════
function goTo(section, el) {
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const sec = document.getElementById('sec-'+section);
  if(sec) sec.classList.add('active');
  if(el) el.classList.add('active');
  else {
    document.querySelectorAll('.nav-item').forEach(n => {
      if(n.textContent.toLowerCase().includes(section.toLowerCase())) n.classList.add('active');
    });
  }
  const labels = {dashboard:'Dashboard',methods:'Métodos',transactions:'Transações',accounts:'Contas Depositadas',recharge:'Assinatura',reports:'Relatórios',goals:'Metas',compare:'Comparativo',calculadora:'Calculadora',anotacoes:'Anotações',settings:'Configurações',admin:'Admin',afiliado:'Minhas Indicações',afiliados:'Afiliados'};
  document.getElementById('breadcrumb').textContent = labels[section] || section;
  closeSidebar();
  if(section === 'reports') setTimeout(initReportCharts, 100);
  if(section === 'compare') setTimeout(initCompareChart, 100);
  if(section === 'methods') setTimeout(initMethodEvolution, 100);
  if(section === 'recharge') setTimeout(updateTrialBanner, 50);
  if(section === 'settings') setTimeout(renderSubscriptionCard, 50);
  if(section === 'admin') setTimeout(() => { renderAdminStats(); renderAdminUsers(); renderAdminErrors(); }, 50);
  if(section === 'afiliados') setTimeout(() => { renderAffiliatesAdmin(); renderWithdrawalsAdmin(); }, 50);
  if(section === 'afiliado')  setTimeout(renderMyAffiliatePanel, 50);
  if(section === 'calculadora') setTimeout(calcInit, 50);
  if(section === 'anotacoes') setTimeout(notesInit, 50);
}

function setPeriod(p, el) {
  currentPeriod = p;
  document.querySelectorAll('.period-tab').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
  // Filtra transações de acordo com o período e atualiza os 4 KPIs
  applyPeriodToKPIs(p);
}

function applyPeriodToKPIs(p) {
  loadSaldoInicial();
  const now = new Date();
  const todayStr = now.getFullYear()+'-'+String(now.getMonth()+1).padStart(2,'0')+'-'+String(now.getDate()).padStart(2,'0');
  let fromStr = null;
  let periodLabel = '';
  if(p === 'day') {
    fromStr = todayStr;
    periodLabel = 'Hoje';
  } else if(p === 'week') {
    const d = new Date(now); d.setDate(d.getDate()-6);
    fromStr = d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
    periodLabel = 'Últimos 7 dias';
  } else if(p === 'month') {
    fromStr = now.getFullYear()+'-'+String(now.getMonth()+1).padStart(2,'0')+'-01';
    const monthNames = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
    periodLabel = monthNames[now.getMonth()] + ' ' + now.getFullYear();
  } else if(p === 'year') {
    fromStr = now.getFullYear()+'-01-01';
    periodLabel = 'Ano de ' + now.getFullYear();
  }

  const filtered = transactions.filter(t => fromStr ? (t.date >= fromStr && t.date <= todayStr) : true);
  const receita  = filtered.filter(t => t.type==='income').reduce((s,t)=>s+t.value, 0);
  const despesas = filtered.filter(t => t.type==='expense').reduce((s,t)=>s+t.value, 0);
  const lucro    = receita - despesas;
  // ROI = retorno sobre a banca inicial (lucro do período ÷ banca).
  // Sem banca definida, cai pro retorno sobre as despesas (comportamento antigo).
  const roiBase  = SALDO_BASE > 0 ? SALDO_BASE : despesas;
  const roi      = roiBase > 0 ? (lucro/roiBase)*100 : (receita > 0 ? 100 : 0);

  // Saldo Total = saldo ATUAL da banca (banca inicial + TODO o lucro até hoje).
  // É fixo: NÃO muda com o período (seu dinheiro é o mesmo independente do filtro).
  const saldoTotal = SALDO_BASE + transactions
    .filter(t => t.date <= todayStr)
    .reduce((s,t) => s + (t.type==='income' ? t.value : -t.value), 0);

  setTextSafe('kpi-saldo',    fmtBRL(saldoTotal));
  setTextSafe('kpi-lucro',    (lucro < 0 ? '-' : '') + fmtBRL(Math.abs(lucro)));
  setTextSafe('kpi-despesas', fmtBRL(despesas));
  setTextSafe('kpi-roi',      roi.toFixed(1)+'%');

  // Atualiza subtítulos pra contexto
  const subSaldo = document.getElementById('kpi-saldo-sub');
  if(subSaldo) subSaldo.textContent = (SALDO_BASE > 0 ? 'Banca: ' + fmtBRL(SALDO_BASE) + ' · saldo atual' : 'Saldo atual da banca');
  const subLucro = document.getElementById('kpi-lucro-sub');
  if(subLucro) subLucro.textContent = periodLabel;
  const subDespesas = document.getElementById('kpi-despesas-sub');
  if(subDespesas) subDespesas.textContent = periodLabel;
  const subRoi = document.getElementById('kpi-roi-sub');
  if(subRoi) subRoi.textContent = (SALDO_BASE > 0 ? 'sobre a banca · ' : '') + periodLabel;
}

// ══════════════════════════════════════════════
//  SIDEBAR (MOBILE)
// ══════════════════════════════════════════════
function toggleSidebar() {
  document.getElementById('sidebar').classList.toggle('open');
  document.getElementById('backdrop').classList.toggle('open');
}
function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('backdrop').classList.remove('open');
}

// ══════════════════════════════════════════════
//  NOTIFICATIONS
// ══════════════════════════════════════════════
function toggleNotif() {
  notifOpen = !notifOpen;
  document.getElementById('notifPanel').classList.toggle('open', notifOpen);
  document.getElementById('notifDot').style.display = notifOpen ? 'none' : '';
}
function clearNotifs() {
  document.getElementById('notifPanel').innerHTML = '<div class="notif-header">Notificações <span class="notif-clear" onclick="toggleNotif()">Fechar</span></div><div style="padding:20px;text-align:center;color:var(--text-muted);font-size:13px">Nenhuma notificação</div>';
}

function buildNotifications() {
  const list = document.getElementById('notifList');
  if(!list) return;
  const items = [];

  // 1) Metas atingidas
  goals.forEach(g => {
    if(g.current >= g.target && g.target > 0) {
      items.push({
        icon:'✅', bg:'rgba(16,185,129,0.1)',
        text:`<strong>Meta atingida!</strong> ${escapeHtml(g.name)} alcançou R$${g.current.toLocaleString('pt-BR')}`,
        time:'recente'
      });
    }
  });

  // 2) Métodos com prejuízo
  METHODS_CATALOG.forEach(m => {
    const s = getMethodStats(m.name);
    if(s.lucro < 0 && s.count > 0) {
      items.push({
        icon:'⚠️', bg:'rgba(244,63,94,0.1)',
        text:`<strong>Alerta:</strong> ${escapeHtml(m.name)} está com prejuízo de R$${Math.abs(s.lucro).toLocaleString('pt-BR')}`,
        time:'agora'
      });
    }
  });

  // 3) Trial: dias restantes
  try {
    const start = localStorage.getItem('bancapro-trial-start');
    if(start) {
      const d = new Date(start);
      const elapsed = Math.floor((Date.now() - d.getTime()) / (1000*60*60*24));
      const left = Math.max(7 - elapsed, 0);
      if(left > 0 && left <= 3) {
        items.push({
          icon:'⏰', bg:'rgba(245,158,11,0.1)',
          text:`<strong>Trial:</strong> ${left} ${left===1?'dia restante':'dias restantes'} no plano gratuito`,
          time:'recente'
        });
      }
    }
  } catch(e) {}

  // 4) Última transação adicionada
  if(transactions.length > 0) {
    const t = transactions[0];
    const sign = t.type === 'income' ? '+' : '-';
    items.push({
      icon: t.type==='income' ? '💰' : '💸',
      bg: t.type==='income' ? 'rgba(16,185,129,0.1)' : 'rgba(244,63,94,0.1)',
      text:`<strong>Última transação:</strong> ${escapeHtml(t.desc)} (${sign}R$${t.value.toLocaleString('pt-BR')})`,
      time: dateBR(t.date)
    });
  }

  if(items.length === 0) {
    list.innerHTML = '<div style="padding:24px;text-align:center;color:var(--text-muted);font-size:13px">Nenhuma notificação ativa 🎉</div>';
    const dot = document.getElementById('notifDot');
    if(dot) dot.style.display = 'none';
    return;
  }

  list.innerHTML = items.map(n => `
    <div class="notif-item">
      <div class="notif-icon" style="background:${n.bg}">${n.icon}</div>
      <div><div class="notif-text">${n.text}</div><div class="notif-time">${n.time}</div></div>
    </div>
  `).join('');

  const dot = document.getElementById('notifDot');
  if(dot) dot.style.display = '';
}
document.addEventListener('click', e => {
  if(!e.target.closest('#notifPanel') && !e.target.closest('#notifBtn') && notifOpen) {
    notifOpen = false;
    document.getElementById('notifPanel').classList.remove('open');
  }
});

// ══════════════════════════════════════════════
//  MODAL
// ══════════════════════════════════════════════
// Data de hoje (ou de uma data) em YYYY-MM-DD no fuso LOCAL — evita o atraso de 1 dia do toISOString (UTC)
function isoDateLocal(d){ d = d || new Date(); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
function openTxModal() {
  document.getElementById('txType').value = 'income';
  document.getElementById('txModal').classList.add('open');
  const today = isoDateLocal();
  const dateInput = document.getElementById('txDate');
  dateInput.value = today;
  dateInput.max = today;
  setTimeout(() => document.getElementById('txValue').focus(), 100);
}
function openTxModalExpense() {
  document.getElementById('txType').value = 'expense';
  document.getElementById('txModal').classList.add('open');
  const today = isoDateLocal();
  const dateInput = document.getElementById('txDate');
  if(!dateInput.value) dateInput.value = today;
  dateInput.max = today;
  setTimeout(() => document.getElementById('txValue').focus(), 100);
}
function closeTxModal() { document.getElementById('txModal').classList.remove('open'); }
function saveTransaction() {
  const val = parseFloat(document.getElementById('txValue').value);
  if(!val || val <= 0) { showToast('Informe um valor válido!','error'); return; }
  const dateVal = document.getElementById('txDate').value;
  if(!dateVal) { showToast('Selecione uma data!','error'); return; }
  const today = isoDateLocal();
  if(dateVal > today) { showToast('A data não pode ser no futuro!','error'); return; }
  const type = document.getElementById('txType').value;
  const method = document.getElementById('txMethod').value;
  const desc = document.getElementById('txDesc').value || (type==='income'?'Entrada':'Despesa');
  transactions.unshift({id:Date.now(), date:dateVal, desc, method, type, value:val});
  closeTxModal();
  showToast(`${type==='income'?'Entrada':'Despesa'} de R$${val.toFixed(2)} registrada!`, type==='income'?'success':'info');
  document.getElementById('txValue').value='';
  document.getElementById('txDesc').value='';
  recomputeAll();
  persistState();
}

// ── BANCA INICIAL (saldo de partida) ──
function openSaldoInicialModal() {
  loadSaldoInicial();
  const inp = document.getElementById('saldoInicialInput');
  if(inp) inp.value = SALDO_BASE ? SALDO_BASE : '';
  document.getElementById('saldoInicialModal').classList.add('open');
  setTimeout(() => { if(inp) inp.focus(); }, 100);
}
function closeSaldoInicialModal() {
  document.getElementById('saldoInicialModal').classList.remove('open');
}
function saveSaldoInicial() {
  const raw = document.getElementById('saldoInicialInput').value;
  const val = parseFloat(raw);
  if(raw !== '' && (!isFinite(val) || val < 0)) {
    showToast('Informe um valor válido (0 ou maior)!','error');
    return;
  }
  const final = (raw === '' || !isFinite(val)) ? 0 : val;
  try { localStorage.setItem('bancapro-saldo-inicial', String(final)); } catch(e) {}
  SALDO_BASE = final;
  if (typeof schedulePush === 'function') schedulePush();
  closeSaldoInicialModal();
  recomputeAll();
  showToast('Banca inicial definida: ' + fmtBRL(final), 'success');
}

// ══════════════════════════════════════════════
//  SYNC ENGINE — recalcula tudo a partir de `transactions`
// ══════════════════════════════════════════════
// Catálogo oficial dos métodos (cores, ícones, metas)
// ── CATÁLOGO DE MÉTODOS — editável e persistente ──
const DEFAULT_METHODS_CATALOG = [
  {name:'Surebet',     icon:'🎯', color:'#fbbf24', color2:'#eab308', meta:5000},
  {name:'Delay',       icon:'⏱',  color:'#34d399', color2:'#14b8a6', meta:4000},
  {name:'Métodos',     icon:'💼', color:'#6366f1', color2:'#1d4ed8', meta:3800},
  {name:'Freebet',     icon:'🎁', color:'#f43f5e', color2:'#dc2626', meta:3000},
  {name:'iGaming',     icon:'🎮', color:'#8b5cf6', color2:'#9333ea', meta:2000},
  {name:'Duplo Green', icon:'🟢', color:'#22d3ee', color2:'#3b82f6', meta:3500},
];
let METHODS_CATALOG = JSON.parse(JSON.stringify(DEFAULT_METHODS_CATALOG));

// Helpers de formatação
function fmtBRL(v, withSign=false) {
  const sign = withSign && v > 0 ? '+' : (v < 0 ? '-' : '');
  return sign + 'R$ ' + Math.abs(v).toLocaleString('pt-BR', {minimumFractionDigits:0, maximumFractionDigits:2});
}
function fmtBRLshort(v) { return 'R$ ' + Math.abs(v).toLocaleString('pt-BR', {maximumFractionDigits:0}); }
function dateBR(iso) {
  if(!iso) return '';
  const [y,m,d] = iso.split('-');
  if(!d) return iso;
  return d+'/'+m+'/'+y.slice(-2);
}

// Agrega dados de UM método a partir de transactions
function getMethodStats(methodName) {
  const txs = transactions.filter(t => t.method === methodName);
  const receita  = txs.filter(t => t.type === 'income').reduce((s,t) => s + t.value, 0);
  const despesas = txs.filter(t => t.type === 'expense').reduce((s,t) => s + t.value, 0);
  const lucro = receita - despesas;
  // ROI = lucro / despesas. Se não houver despesas, usa lucro/receita como proxy (margem)
  let roi;
  if(despesas > 0) {
    roi = (lucro / despesas) * 100;
  } else if(receita > 0) {
    roi = 100; // sem custos = 100% de margem
  } else {
    roi = 0;
  }
  return {receita, despesas, lucro, roi, count: txs.length};
}

function recomputeAll() {
  loadSaldoInicial();
  // 1) KPIs do topo — agora respeitam o período ativo (Hoje/Semana/Mês/Ano)
  applyPeriodToKPIs(currentPeriod === 'day' ? 'day' : (currentPeriod || 'month'));

  // 1b) Métricas globais (usadas em outros lugares)
  const totalReceita  = transactions.filter(t=>t.type==='income').reduce((s,t)=>s+t.value, 0);
  const totalDespesas = transactions.filter(t=>t.type==='expense').reduce((s,t)=>s+t.value, 0);
  const lucroTotal    = totalReceita - totalDespesas;
  const saldoTotal    = SALDO_BASE + lucroTotal;

  // 2) Stat chips (janelas de tempo)
  // IMPORTANTE: comparamos como STRING "YYYY-MM-DD" pra evitar bug de fuso horário.
  // (new Date('2026-05-20') é UTC midnight, que no Brasil vira 21:00 do dia anterior)
  const now = new Date();
  const todayStr = now.getFullYear() + '-' +
    String(now.getMonth()+1).padStart(2,'0') + '-' +
    String(now.getDate()).padStart(2,'0');
  // Semana = últimos 7 dias incluindo hoje
  const weekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6);
  const weekStartStr = weekStart.getFullYear() + '-' +
    String(weekStart.getMonth()+1).padStart(2,'0') + '-' +
    String(weekStart.getDate()).padStart(2,'0');
  // Mês atual = primeiro dia do mês
  const monthStartStr = now.getFullYear() + '-' +
    String(now.getMonth()+1).padStart(2,'0') + '-01';

  const signed = t => t.type==='income' ? t.value : -t.value;
  const lucroHoje    = transactions.filter(t => t.date === todayStr).reduce((s,t)=>s+signed(t), 0);
  const lucroSemana  = transactions.filter(t => t.date >= weekStartStr && t.date <= todayStr).reduce((s,t)=>s+signed(t), 0);
  const lucroMes     = transactions.filter(t => t.date >= monthStartStr && t.date <= todayStr).reduce((s,t)=>s+signed(t), 0);

  const methodsAtivos = METHODS_CATALOG.filter(m => getMethodStats(m.name).count > 0).length;

  setTextSafe('statReceitaTotal',  fmtBRLshort(totalReceita));
  setTextSafe('statLucroHoje',     (lucroHoje>=0?'+':'') + fmtBRLshort(Math.abs(lucroHoje)).replace('R$', (lucroHoje<0?'-R$':'R$')));
  setTextSafe('statLucroSemanal',  (lucroSemana>=0?'+':'') + fmtBRLshort(Math.abs(lucroSemana)).replace('R$', (lucroSemana<0?'-R$':'R$')));
  setTextSafe('statLucroMensal',   (lucroMes>=0?'+':'') + fmtBRLshort(Math.abs(lucroMes)).replace('R$', (lucroMes<0?'-R$':'R$')));
  setTextSafe('statMetodosAtivos', methodsAtivos + ' / ' + METHODS_CATALOG.length);
  setTextSafe('statTransacoes',    transactions.length.toLocaleString('pt-BR'));

  // cores dos lucros
  const cHoje = document.getElementById('statLucroHoje');
  const cSem  = document.getElementById('statLucroSemanal');
  const cMes  = document.getElementById('statLucroMensal');
  if(cHoje) cHoje.style.color = lucroHoje>=0 ? 'var(--green)' : 'var(--red)';
  if(cSem)  cSem.style.color  = lucroSemana>=0 ? 'var(--green)' : 'var(--red)';
  if(cMes)  cMes.style.color  = lucroMes>=0 ? 'var(--green)' : 'var(--red)';

  // 3) Histórico recente (Dashboard, 6 itens)
  renderRecentTransactions();
  // 4) Tabela completa de transações
  renderAllTransactions(saldoTotal);
  // 5) Cards de método + ranking
  renderMethodCards();
  renderRanking();
  // 6) Gráficos do Dashboard que dependem das transações
  if(typeof buildMethodCategoryChart === 'function') buildMethodCategoryChart();
  if(typeof buildDashboardPieChart === 'function') buildDashboardPieChart();
  // 7) Gráficos da aba Relatórios
  if(typeof buildReportCharts === 'function') buildReportCharts();
  // 8) Notificações dinâmicas
  if(typeof buildNotifications === 'function') buildNotifications();
  // 9) KPIs do Comparativo Mensal (puxam de transactions)
  if(typeof renderCompareKPIs === 'function') renderCompareKPIs();
  // 10) Gráfico Evolução Financeira (principal)
  if(typeof buildEvoChart === 'function' && document.getElementById('mainChart')) {
    buildEvoChart(currentEvoMode,
      document.getElementById('evoDateFrom')?.value,
      document.getElementById('evoDateTo')?.value
    );
  }
  // 11) Gráfico "Evolução por Método" da aba Métodos
  if(typeof initMethodEvolution === 'function' && document.getElementById('methodEvolutionChart')) {
    initMethodEvolution();
  }
}

function setTextSafe(id, txt) {
  const el = document.getElementById(id);
  if(el) el.textContent = txt;
}

function renderRecentTransactions() {
  const body = document.getElementById('recentTxBody');
  if(!body) return;
  const rows = transactions.slice(0, 6).map(t => {
    const sign = t.type==='income' ? '+' : '-';
    const cls  = t.type==='income' ? 'income' : 'expense';
    const arrow = t.type==='income' ? '↑ Entrada' : '↓ Despesa';
    return `<tr>
      <td>${dateBR(t.date).slice(0,5)}</td>
      <td>${escapeHtml(t.desc)}</td>
      <td><span class="tx-method-pill">${escapeHtml(t.method)}</span></td>
      <td><span class="tx-type-badge ${cls}">${arrow}</span></td>
      <td class="tx-amount ${cls}">${sign}R$ ${t.value.toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
    </tr>`;
  }).join('');
  body.innerHTML = rows;
}

// estado do filtro de transações
let txFilter = { from: '', to: '', method: '', type: '' };

function applyTxFilter() {
  txFilter.from   = document.getElementById('filterDateFrom').value || '';
  txFilter.to     = document.getElementById('filterDateTo').value || '';
  txFilter.method = document.getElementById('filterMethod').value || '';
  txFilter.type   = document.getElementById('filterType').value || '';
  recomputeAll();
}

function clearTxFilter() {
  txFilter = { from: '', to: '', method: '', type: '' };
  document.getElementById('filterDateFrom').value = '';
  document.getElementById('filterDateTo').value = '';
  document.getElementById('filterMethod').value = '';
  document.getElementById('filterType').value = '';
  recomputeAll();
}

function getFilteredTransactions() {
  return transactions.filter(t => {
    if(txFilter.from   && t.date < txFilter.from) return false;
    if(txFilter.to     && t.date > txFilter.to) return false;
    if(txFilter.method && t.method !== txFilter.method) return false;
    if(txFilter.type   && t.type !== txFilter.type) return false;
    return true;
  });
}

async function deleteTransaction(id) {
  const t = transactions.find(x => x.id === id);
  if(!t) return;
  const ok = await customConfirm(
    `Excluir a transação "${t.desc}" (${t.type==='income'?'+':'-'}R$ ${t.value.toFixed(2)})?`,
    'Excluir transação',
    'Excluir'
  );
  if(!ok) return;
  transactions = transactions.filter(x => x.id !== id);
  recomputeAll();
  persistState();
  showToast('Transação excluída.','info');
}

// ══════════════════════════════════════════════
//  EXPORTAÇÃO — CSV (Excel) e PDF (via window.print)
// ══════════════════════════════════════════════
function exportTransactionsCSV() {
  const data = getFilteredTransactions();
  if(data.length === 0) { showToast('Nenhuma transação para exportar.','error'); return; }
  // header
  const headers = ['Data','Descrição','Categoria','Método','Tipo','Valor (R$)'];
  // BOM pra Excel reconhecer UTF-8 (acentos)
  let csv = '\uFEFF' + headers.join(';') + '\n';
  data.forEach(t => {
    const tag = inferTag(t);
    const valor = (t.type==='income' ? t.value : -t.value).toFixed(2).replace('.', ',');
    const row = [
      dateBR(t.date),
      `"${(t.desc||'').replace(/"/g,'""')}"`,
      tag,
      t.method,
      t.type==='income' ? 'Entrada' : 'Despesa',
      valor
    ];
    csv += row.join(';') + '\n';
  });
  const blob = new Blob([csv], {type:'text/csv;charset=utf-8;'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'apostack-transacoes-' + new Date().toISOString().slice(0,10) + '.csv';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast(`✅ ${data.length} transações exportadas para CSV (abre no Excel).`, 'success');
}

function exportTransactionsPDF() {
  const data = getFilteredTransactions();
  if(data.length === 0) { showToast('Nenhuma transação para exportar.','error'); return; }
  // Monta uma página HTML formatada e abre o diálogo de impressão (usuário salva como PDF)
  const totalReceita  = data.filter(t=>t.type==='income').reduce((s,t)=>s+t.value, 0);
  const totalDespesas = data.filter(t=>t.type==='expense').reduce((s,t)=>s+t.value, 0);
  const lucro = totalReceita - totalDespesas;

  const win = window.open('', '_blank');
  if(!win) { showToast('O navegador bloqueou a janela. Permita pop-ups e tente de novo.','error'); return; }
  win.document.write(`
    <!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"/>
    <title>Relatório de Transações — Apostack</title>
    <style>
      body { font-family: 'Inter', system-ui, sans-serif; padding: 32px; color: #0f172a; max-width: 1100px; margin: 0 auto; }
      h1 { font-size: 24px; margin: 0 0 4px; }
      .sub { color: #64748b; font-size: 12px; margin-bottom: 24px; }
      .summary { display: flex; gap: 12px; margin-bottom: 24px; }
      .stat { flex: 1; border: 1px solid #e5e7eb; border-radius: 8px; padding: 12px; }
      .stat-label { font-size: 11px; color: #64748b; text-transform: uppercase; letter-spacing: 0.5px; }
      .stat-value { font-size: 18px; font-weight: 700; margin-top: 4px; }
      .green { color: #059669; }
      .red { color: #dc2626; }
      table { width: 100%; border-collapse: collapse; font-size: 12px; }
      th { text-align: left; padding: 10px; background: #f8fafc; border-bottom: 2px solid #e5e7eb; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: #475569; }
      td { padding: 9px 10px; border-bottom: 1px solid #f1f5f9; }
      tr:nth-child(even) td { background: #fafbfc; }
      .footer { margin-top: 32px; font-size: 11px; color: #94a3b8; text-align: center; }
      @media print { body { padding: 16px; } }
    </style></head><body>
      <h1>Relatório de Transações</h1>
      <div class="sub">Apostack — Emitido em ${new Date().toLocaleString('pt-BR')}</div>
      <div class="summary">
        <div class="stat"><div class="stat-label">Receita</div><div class="stat-value green">R$ ${totalReceita.toLocaleString('pt-BR',{minimumFractionDigits:2})}</div></div>
        <div class="stat"><div class="stat-label">Despesas</div><div class="stat-value red">R$ ${totalDespesas.toLocaleString('pt-BR',{minimumFractionDigits:2})}</div></div>
        <div class="stat"><div class="stat-label">Lucro</div><div class="stat-value ${lucro>=0?'green':'red'}">${lucro>=0?'+':'-'}R$ ${Math.abs(lucro).toLocaleString('pt-BR',{minimumFractionDigits:2})}</div></div>
        <div class="stat"><div class="stat-label">Transações</div><div class="stat-value">${data.length}</div></div>
      </div>
      <table>
        <thead><tr><th>Data</th><th>Descrição</th><th>Categoria</th><th>Método</th><th>Tipo</th><th style="text-align:right">Valor</th></tr></thead>
        <tbody>
        ${data.map(t => {
          const sign = t.type==='income' ? '+' : '-';
          const cls = t.type==='income' ? 'green' : 'red';
          return `<tr>
            <td>${dateBR(t.date)}</td>
            <td>${(t.desc||'').replace(/</g,'&lt;')}</td>
            <td>${inferTag(t)}</td>
            <td>${t.method}</td>
            <td>${t.type==='income'?'Entrada':'Despesa'}</td>
            <td class="${cls}" style="text-align:right;font-weight:600">${sign}R$ ${t.value.toLocaleString('pt-BR',{minimumFractionDigits:2})}</td>
          </tr>`;
        }).join('')}
        </tbody>
      </table>
      <div class="footer">Gerado por Apostack · ${new Date().toLocaleDateString('pt-BR')}</div>
      <script>setTimeout(() => window.print(), 300);<\/script>
    </body></html>
  `);
  win.document.close();
  showToast('📥 Janela de impressão aberta. Escolha "Salvar como PDF".', 'info');
}

function exportReportPDF() {
  // Mesma coisa, mas explicitamente nomeado pra Relatórios
  exportTransactionsPDF();
}

function renderAllTransactions(currentBalance) {
  const body = document.getElementById('txTableBody');
  if(!body) return;
  const filtered = getFilteredTransactions();
  const count = document.getElementById('txCountLabel');
  if(count) {
    if(filtered.length === transactions.length) {
      count.textContent = transactions.length.toLocaleString('pt-BR');
    } else {
      count.textContent = filtered.length.toLocaleString('pt-BR') + ' de ' + transactions.length.toLocaleString('pt-BR');
    }
  }

  // resumo do filtro
  const hasFilter = txFilter.from || txFilter.to || txFilter.method || txFilter.type;
  const summary = document.getElementById('filterSummary');
  const summaryText = document.getElementById('filterSummaryText');
  if(summary && summaryText) {
    if(hasFilter) {
      const parts = [];
      if(txFilter.from)   parts.push('de ' + dateBR(txFilter.from));
      if(txFilter.to)     parts.push('até ' + dateBR(txFilter.to));
      if(txFilter.method) parts.push('método: ' + txFilter.method);
      if(txFilter.type)   parts.push('tipo: ' + (txFilter.type==='income'?'Entrada':'Despesa'));
      summaryText.textContent = '🔍 Filtros ativos: ' + parts.join(' · ') + ` — exibindo ${filtered.length} de ${transactions.length} transações.`;
      summary.style.display = 'block';
    } else {
      summary.style.display = 'none';
    }
  }

  if(filtered.length === 0) {
    body.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:32px;color:var(--text-muted)">Nenhuma transação encontrada com esses filtros.</td></tr>';
    return;
  }

  // calcula saldo regressivo a partir do saldo atual (considera só transações listadas)
  // Quando há filtro, o saldo mostra o saldo geral *naquele ponto da timeline original*
  // Pra simplificar: ordena por data desc e desfaz a partir do saldo atual da transação mais recente NÃO filtrada
  // Aqui vamos mostrar o saldo da entrada considerando a posição na lista completa
  const fullSorted = [...transactions].sort((a,b) => (b.date+b.id).localeCompare(a.date+a.id));
  const balanceMap = {};
  let running = currentBalance != null ? currentBalance : (SALDO_BASE + transactions.reduce((s,t) => s + (t.type==='income'?t.value:-t.value), 0));
  fullSorted.forEach(t => {
    balanceMap[t.id] = running;
    running -= (t.type==='income' ? t.value : -t.value);
  });

  const rows = filtered.map(t => {
    const sign = t.type==='income' ? '+' : '-';
    const cls  = t.type==='income' ? 'income' : 'expense';
    const arrow = t.type==='income' ? '↑ Entrada' : '↓ Despesa';
    const balanceNow = balanceMap[t.id] || 0;
    const tag = inferTag(t);
    return `<tr>
      <td data-label="Data">${dateBR(t.date)}</td>
      <td data-label="Descrição">${escapeHtml(t.desc)}</td>
      <td data-label="Categoria"><span class="tag">${tag}</span></td>
      <td data-label="Método"><span class="tx-method-pill">${escapeHtml(t.method)}</span></td>
      <td data-label="Tipo"><span class="tx-type-badge ${cls}">${arrow}</span></td>
      <td data-label="Valor" class="tx-amount ${cls}">${sign}R$ ${t.value.toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
      <td data-label="Saldo">${fmtBRLshort(balanceNow)}</td>
      <td data-label="" style="text-align:right"><button class="goal-action-btn danger" onclick="deleteTransaction(${t.id})" title="Excluir" aria-label="Excluir transação">🗑️</button></td>
    </tr>`;
  }).join('');
  body.innerHTML = rows;
}

function inferTag(t) {
  if(t.type === 'expense') {
    const d = (t.desc||'').toLowerCase();
    if(d.includes('taxa')) return 'Taxa';
    if(d.includes('custo') || d.includes('operac')) return 'Operação';
    if(d.includes('perd')) return 'Perda';
    return 'Despesa';
  }
  return 'Ganho';
}

function renderMethodCards() {
  const grid = document.getElementById('methodCardsGrid');
  if(!grid) return;
  const cards = METHODS_CATALOG.map(m => {
    const s = getMethodStats(m.name);
    const metaPct = s.lucro > 0 ? Math.min((s.lucro/m.meta)*100, 100) : 0;
    const metaPctRaw = s.lucro > 0 ? (s.lucro/m.meta)*100 : 0;
    const isNegative = s.lucro < 0;
    const badge = isNegative ? '<div class="method-badge warn">⚠️ Alerta</div>' : '<div class="method-badge">Ativo</div>';
    const lucroClass = isNegative ? 'red' : 'green';
    const lucroDisplay = (isNegative ? '-' : '') + fmtBRLshort(Math.abs(s.lucro));
    const roiClass = isNegative ? 'style="color:var(--red)"' : '';
    const roiDisplay = s.count === 0 ? '—' : s.roi.toFixed(0)+'%';
    const barColor = isNegative ? 'var(--red)' : '';
    const barBgStyle = isNegative ? 'background:rgba(244,63,94,0.1)' : '';
    const metaInfo = isNegative ? `<span style="color:var(--red)">Revisar estratégia</span>` : `<span>${s.count} transações</span>`;
    return `
      <div class="method-card" style="--m-color:${m.color};--m-color2:${m.color2}">
        <div class="method-header"><div class="method-name">${m.icon} ${escapeHtml(m.name)}</div>${badge}</div>
        <div class="method-stats">
          <div><div class="method-stat-label">Receita</div><div class="method-stat-value">${fmtBRLshort(s.receita)}</div></div>
          <div><div class="method-stat-label">Despesas</div><div class="method-stat-value red">${fmtBRLshort(s.despesas)}</div></div>
          <div><div class="method-stat-label">Lucro</div><div class="method-stat-value ${lucroClass}">${lucroDisplay}</div></div>
          <div><div class="method-stat-label">ROI</div><div class="method-stat-value" ${roiClass}>${roiDisplay}</div></div>
        </div>
        <div>
          <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text-muted);margin-bottom:4px">
            <span>Meta: R$${m.meta.toLocaleString('pt-BR')}</span><span>${metaPctRaw.toFixed(1)}%</span>
          </div>
          <div class="method-roi-bar" style="${barBgStyle}"><div class="method-roi-fill" style="width:${metaPct}%;${barColor?'background:'+barColor:''}"></div></div>
        </div>
        <div class="method-meta">${metaInfo}<span>${s.count > 0 ? (s.count + ' tx') : 'Sem dados'}</span></div>
      </div>
    `;
  }).join('');
  grid.innerHTML = cards;
}

function renderRanking() {
  const list = document.getElementById('rankingList');
  if(!list) return;
  // ordena por lucro descendente
  const ranked = METHODS_CATALOG
    .map(m => ({...m, stats: getMethodStats(m.name)}))
    .sort((a,b) => b.stats.lucro - a.stats.lucro);
  const maxLucro = Math.max(...ranked.map(r => Math.abs(r.stats.lucro))) || 1;
  list.innerHTML = ranked.map((r, idx) => {
    const medals = ['gold','silver','bronze'];
    const medalIcons = ['🥇','🥈','🥉'];
    const numCls = idx < 3 ? medals[idx] : '';
    const numIcon = idx < 3 ? medalIcons[idx] : (idx+1);
    const isNeg = r.stats.lucro < 0;
    const widthPct = Math.max(0, (Math.abs(r.stats.lucro)/maxLucro)*100);
    const roiTxt = r.stats.count === 0 ? '—' : r.stats.roi.toFixed(0)+'%';
    const lucroDisplay = (isNeg ? '-' : '') + fmtBRLshort(Math.abs(r.stats.lucro));
    return `
      <div class="rank-item">
        <div class="rank-num ${numCls}">${numIcon}</div>
        <div class="rank-name">${r.icon} ${escapeHtml(r.name)}</div>
        <div class="rank-bar-wrap"><div class="rank-bar" style="width:${isNeg?0:widthPct}%;background:linear-gradient(90deg,${r.color},${r.color2})"></div></div>
        <div class="rank-roi" ${isNeg?'style="color:var(--red)"':''}>${lucroDisplay}<span class="rank-roi-pct"> · ${roiTxt} ROI</span></div>
      </div>
    `;
  }).join('');
}

// ══════════════════════════════════════════════
//  GERENCIAMENTO DO CATÁLOGO DE MÉTODOS
// ══════════════════════════════════════════════
function openMethodsCatalogModal() {
  renderMethodsCatalogEditor();
  document.getElementById('methodsCatalogModal').classList.add('open');
}
function closeMethodsCatalogModal() {
  document.getElementById('methodsCatalogModal').classList.remove('open');
}

function renderMethodsCatalogEditor() {
  const list = document.getElementById('methodsCatalogList');
  if(METHODS_CATALOG.length === 0) {
    list.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-muted);font-size:13px">Nenhum método. Clique em <b>+ Adicionar método</b> abaixo.</div>';
    return;
  }
  list.innerHTML = METHODS_CATALOG.map((m, idx) => methodCatalogRowHtml(m, idx)).join('');
}

function methodCatalogRowHtml(m, idx) {
  const c1 = m.color || '#6366f1';
  const c2 = m.color2 || c1;
  return `
    <div class="method-cat-row" data-original-name="${escapeHtml(m.name)}" style="background:var(--bg-secondary);border:1px solid var(--glass-border);border-radius:10px;padding:10px;display:grid;grid-template-columns:48px 1.5fr 1fr 90px 90px 36px;gap:8px;align-items:center">
      <input class="form-input" type="text" maxlength="4" value="${escapeHtml(m.icon||'🎯')}" data-field="icon" placeholder="🎯" style="padding:8px;text-align:center;font-size:18px"/>
      <input class="form-input" type="text" value="${escapeHtml(m.name)}" data-field="name" placeholder="Nome do método" style="padding:8px"/>
      <input class="form-input" type="number" value="${m.meta||0}" data-field="meta" placeholder="Meta R$" step="any" min="0" style="padding:8px"/>
      <div style="display:flex;flex-direction:column;align-items:center;gap:2px">
        <input type="color" value="${c1}" data-field="color" style="width:100%;height:30px;padding:2px;cursor:pointer;background:var(--bg-card);border:1px solid var(--glass-border);border-radius:6px"/>
        <span style="font-size:9px;color:var(--text-muted)">Cor 1</span>
      </div>
      <div style="display:flex;flex-direction:column;align-items:center;gap:2px">
        <input type="color" value="${c2}" data-field="color2" style="width:100%;height:30px;padding:2px;cursor:pointer;background:var(--bg-card);border:1px solid var(--glass-border);border-radius:6px"/>
        <span style="font-size:9px;color:var(--text-muted)">Cor 2</span>
      </div>
      <button class="goal-action-btn danger" onclick="removeMethodCatalogRow(this)" title="Remover" aria-label="Remover">🗑️</button>
    </div>
  `;
}

function addMethodCatalogRow() {
  const list = document.getElementById('methodsCatalogList');
  const newRow = methodCatalogRowHtml({name:'', icon:'🎯', color:'#6366f1', color2:'#8b5cf6', meta:0}, METHODS_CATALOG.length);
  // remove placeholder se existir
  if(list.querySelector('.method-cat-row') === null) list.innerHTML = '';
  list.insertAdjacentHTML('beforeend', newRow);
  list.scrollTop = list.scrollHeight;
  const last = list.lastElementChild;
  if(last) {
    const nameInput = last.querySelector('[data-field="name"]');
    if(nameInput) nameInput.focus();
  }
}

function removeMethodCatalogRow(btn) {
  btn.closest('.method-cat-row').remove();
}

async function resetMethodsCatalogToDefaults() {
  const ok = await customConfirm(
    'Restaurar os 6 métodos originais? Isso vai sobrescrever a lista atual no editor (mas só salva quando você clicar em Salvar).',
    'Restaurar métodos padrão',
    'Restaurar',
    false
  );
  if(!ok) return;
  METHODS_CATALOG = JSON.parse(JSON.stringify(DEFAULT_METHODS_CATALOG));
  renderMethodsCatalogEditor();
}

async function saveMethodsCatalog() {
  const rows = document.querySelectorAll('#methodsCatalogList .method-cat-row');
  const updated = [];
  const renamed = []; // [{oldName, newName}]
  const removed = []; // [oldName]
  let invalid = false;
  const seen = new Set();

  rows.forEach(row => {
    const icon  = (row.querySelector('[data-field="icon"]').value || '🎯').trim() || '🎯';
    const name  = row.querySelector('[data-field="name"]').value.trim();
    const meta  = parseFloat(row.querySelector('[data-field="meta"]').value) || 0;
    const color = row.querySelector('[data-field="color"]').value || '#6366f1';
    const color2= row.querySelector('[data-field="color2"]').value || color;
    if(!name) { invalid = true; return; }
    if(seen.has(name.toLowerCase())) { invalid = 'dup:'+name; return; }
    seen.add(name.toLowerCase());

    const original = row.dataset.originalName;
    if(original && original !== name) renamed.push({oldName: original, newName: name});

    updated.push({name, icon, color, color2, meta});
  });

  if(invalid === true)                          { showToast('Cada método precisa de um nome!','error'); return; }
  if(typeof invalid === 'string' && invalid.startsWith('dup:')) {
    showToast(`Método duplicado: "${invalid.slice(4)}". Cada nome precisa ser único.`,'error'); return;
  }

  // identificar métodos REMOVIDOS (estavam no catálogo, sumiram do editor)
  const newNames = new Set(updated.map(m => m.name));
  const renamedFrom = new Set(renamed.map(r => r.oldName));
  METHODS_CATALOG.forEach(m => {
    if(!newNames.has(m.name) && !renamedFrom.has(m.name)) removed.push(m.name);
  });

  // Avisar se há transações órfãs por causa de remoções
  let orphanCount = 0;
  removed.forEach(n => { orphanCount += transactions.filter(t => t.method === n).length; });
  if(orphanCount > 0) {
    const ok = await customConfirm(
      `Você removeu ${removed.length} método(s) (${removed.join(', ')}) que tem ${orphanCount} transação(ões) associada(s). Essas transações continuarão na tabela mas não aparecerão em gráficos/cards. Confirma?`,
      '⚠️ Métodos com transações',
      'Confirmar remoção'
    );
    if(!ok) return;
  }

  // Aplicar renomeações nas transações, metas e comparativo
  if(renamed.length > 0) {
    renamed.forEach(({oldName, newName}) => {
      transactions.forEach(t => { if(t.method === oldName) t.method = newName; });
      methodsCompare.forEach(m => { if(m.name === oldName) m.name = newName; });
    });
  }

  METHODS_CATALOG = updated;
  closeMethodsCatalogModal();
  recomputeAll();
  rebuildMethodSelector();
  persistState();

  let msg = '✅ Métodos atualizados';
  if(renamed.length > 0) msg += ` · ${renamed.length} renomeado(s)`;
  if(removed.length > 0) msg += ` · ${removed.length} removido(s)`;
  showToast(msg, 'success');
}

// Reconstrói o <select> de método no modal de Nova Transação
function rebuildMethodSelector() {
  const sel = document.getElementById('txMethod');
  if(!sel) return;
  const prev = sel.value;
  sel.innerHTML = METHODS_CATALOG.map(m => `<option value="${escapeHtml(m.name)}">${escapeHtml(m.name)}</option>`).join('');
  // tenta restaurar valor anterior
  if(prev && METHODS_CATALOG.some(m => m.name === prev)) sel.value = prev;
}

// ══════════════════════════════════════════════
//  CONTAS DEPOSITADAS (casas de aposta)
// ══════════════════════════════════════════════
// Catálogo de casas regulamentadas no Brasil (SPA/MF).
// Logos são iniciais estilizadas — paleta inspirada na identidade visual de cada uma.
const HOUSES_CATALOG = [
  {name:'Superbet',   color:'#dc2626', initials:'S'},
  {name:'bet365',     color:'#005a30', initials:'b'},
  {name:'Betano',     color:'#ff6900', initials:'B'},
  {name:'Blaze',      color:'#ff4d4d', initials:'b'},
  {name:'KTO',        color:'#00cc66', initials:'K'},
  {name:'Novibet',    color:'#f7c200', initials:'N'},
  {name:'Sportingbet',color:'#ffd700', initials:'S'},
  {name:'Brazino777', color:'#c8102e', initials:'B'},
  {name:'BetMGM',     color:'#bf9b30', initials:'M'},
  {name:'Estrelabet', color:'#ffcc00', initials:'E'},
  {name:'Betnacional',color:'#1cc31c', initials:'B'},
  {name:'BetdaSorte', color:'#7c3aed', initials:'B'},
  {name:'Esportes da Sorte', color:'#06b6d4', initials:'E'},
  {name:'Jonbet',     color:'#3aff3a', initials:'J'},
  {name:'7K Bet',     color:'#fb923c', initials:'7'},
  {name:'Pixbet',     color:'#1e90ff', initials:'P'},
  {name:'Vbet',       color:'#ffc107', initials:'V'},
  {name:'Stake',      color:'#1ab57e', initials:'S'},
  {name:'EsporteNet', color:'#16a34a', initials:'E'},
  {name:'Multibet',   color:'#8b5cf6', initials:'M'},
  {name:'Luvabet',    color:'#fb923c', initials:'L'},
  {name:'BR4bet',     color:'#dc2626', initials:'B'},
  {name:'Gol de Bet', color:'#22c55e', initials:'G'},
  {name:'Hiperbet',   color:'#0ea5e9', initials:'H'},
  {name:'Rivalo',     color:'#e11d48', initials:'R'},
  {name:'PlayUZU',    color:'#f59e0b', initials:'P'},
  {name:'Energia.bet',color:'#84cc16', initials:'E'},
  {name:'Brasil Bet', color:'#16a34a', initials:'B'},
  {name:'Esportiva.bet', color:'#0891b2', initials:'E'},
];

let accounts = [];                  // [{id, house, customName?, color, initials, balance, date, note, createdAt}]
let selectedHouseInModal = null;    // house object atualmente selecionado
let editingAccountId = null;        // id da conta sendo editada, ou null para criar

// Persistência
const ACCOUNTS_KEY = 'bancapro-accounts';
function persistAccounts() {
  try { localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(accounts)); } catch(e) {}
  if (typeof schedulePush === 'function') schedulePush();
}
function loadAccounts() {
  try {
    const raw = localStorage.getItem(ACCOUNTS_KEY);
    if(raw) {
      const parsed = JSON.parse(raw);
      if(Array.isArray(parsed)) accounts = parsed;
    }
  } catch(e) {}
}

function openAccountModal(accountId) {
  editingAccountId = accountId || null;
  const titleEl = document.getElementById('accountModalTitle');
  const subEl   = document.getElementById('accountModalSub');
  const delBtn  = document.getElementById('accountDeleteBtn');

  if(editingAccountId) {
    const a = accounts.find(x => x.id === editingAccountId);
    if(!a) { editingAccountId = null; return; }
    titleEl.textContent = '✏️ Editar Conta';
    subEl.textContent   = 'Altere o saldo ou os dados dessa conta';
    delBtn.style.display = 'inline-flex';
    selectedHouseInModal = HOUSES_CATALOG.find(h => h.name === a.house) || {name: a.customName || a.house, color:a.color, initials:a.initials, custom:true};
    document.getElementById('accountAmount').value = a.balance;
    document.getElementById('accountDate').value = a.date;
    document.getElementById('accountNote').value = a.note || '';
  } else {
    titleEl.textContent = '🏦 Nova Conta Depositada';
    subEl.textContent   = 'Registre o saldo que você tem numa casa de aposta';
    delBtn.style.display = 'none';
    selectedHouseInModal = null;
    document.getElementById('accountAmount').value = '';
    const today = isoDateLocal();
    const dateInput = document.getElementById('accountDate');
    dateInput.value = today; dateInput.max = today;
    document.getElementById('accountNote').value = '';
    document.getElementById('customHouseName').value = '';
  }
  renderHouseSelector();
  document.getElementById('accountModal').classList.add('open');
  setTimeout(() => {
    const amount = document.getElementById('accountAmount');
    if(editingAccountId && amount) amount.focus();
  }, 100);
}

function closeAccountModal() {
  document.getElementById('accountModal').classList.remove('open');
  editingAccountId = null;
  selectedHouseInModal = null;
}

// Nome do arquivo do logo a partir do nome da casa (ex.: "Esportes da Sorte" -> "esportesdasorte")
function houseLogoSlug(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Domínio de cada casa — usado pra puxar o ícone (favicon) automaticamente
const HOUSE_DOMAINS = {
  'Superbet':'superbet.com', 'bet365':'bet365.com', 'Betano':'betano.com', 'Blaze':'blaze.com',
  'KTO':'kto.com', 'Novibet':'novibet.com', 'Sportingbet':'sportingbet.com', 'Brazino777':'brazino777.com',
  'BetMGM':'betmgm.com', 'Estrelabet':'estrelabet.com', 'Betnacional':'betnacional.com', 'BetdaSorte':'betdasorte.com',
  'Esportes da Sorte':'esportesdasorte.com', 'Jonbet':'jonbet.com', '7K Bet':'', 'Pixbet':'pixbet.com',
  'Vbet':'vbet.com', 'Stake':'stake.com', 'EsporteNet':'esportenet.com',
  'Multibet':'', 'Luvabet':'', 'BR4bet':'br4.bet', 'Gol de Bet':'goldebet.com',
  'Hiperbet':'', 'Rivalo':'rivalo.com', 'PlayUZU':'playuzu.com', 'Energia.bet':'energia.bet',
  'Brasil Bet':'brasilbet.com', 'Esportiva.bet':'esportiva.bet'
};
function houseIconUrl(name) {
  const d = HOUSE_DOMAINS[name];
  return d ? `https://www.google.com/s2/favicons?domain=${d}&sz=64` : '';
}

// Tenta a próxima fonte de imagem (formatos/favicon); se acabarem, mostra o selo colorido
function houseImgError(img) {
  let fb = [];
  try { fb = JSON.parse(img.getAttribute('data-fb') || '[]'); } catch(e) {}
  if (fb.length) {
    const next = fb.shift();
    img.setAttribute('data-fb', JSON.stringify(fb));
    img.src = next;
  } else {
    img.style.display = 'none';
    const b = img.parentNode.querySelector('.house-dd-dot');
    if (b) b.style.display = 'flex';
  }
}

function renderHouseSelector() {
  const sel = document.getElementById('houseSelector');
  if(!sel) return;
  const cur = selectedHouseInModal;
  // Valor mostrado no "gatilho" do dropdown
  let valueHtml;
  if (cur && cur.custom) {
    valueHtml = `<span class="house-dd-value" style="color:#6366f1">OUTRA</span>`;
  } else if (cur && cur.name) {
    valueHtml = `<span class="house-dd-value" style="color:${cur.color}">${escapeHtml(cur.name.toUpperCase())}</span>`;
  } else {
    valueHtml = `<span class="house-dd-value placeholder">SELECIONE UMA CASA</span>`;
  }
  // Itens do dropdown: ícone (favicon) da casa + nome colorido.
  // Logo local (logos/<slug>.png) tem prioridade; se faltar, usa o favicon do site;
  // se ambos falharem, fica só o nome colorido (onerror remove a img).
  const items = HOUSES_CATALOG.map(h => {
    const isSel = cur && !cur.custom && cur.name === h.name;
    const slug = houseLogoSlug(h.name);
    const fav = houseIconUrl(h.name);
    // Tenta vários formatos de arquivo local; depois o favicon; por fim, o selo colorido
    const candidates = [`logos/${slug}.png`, `logos/${slug}.jpg`, `logos/${slug}.jpeg`, `logos/${slug}.webp`];
    if (fav) candidates.push(fav);
    const first = candidates[0];
    const rest = escapeHtml(JSON.stringify(candidates.slice(1)));
    return `<div class="house-dd-item ${isSel ? 'selected' : ''}" onclick="selectHouse('${escapeHtml(h.name)}')">
        <img class="house-dd-logo" src="${first}" alt="" data-fb="${rest}" onerror="houseImgError(this)">
        <span class="house-dd-dot" style="background:${h.color};display:none">${escapeHtml(h.initials)}</span>
        <span class="house-dd-item-name">${escapeHtml(h.name)}</span>
      </div>`;
  }).join('');
  const customSelected = cur && cur.custom;
  const customItem = `<div class="house-dd-item custom ${customSelected ? 'selected' : ''}" onclick="selectHouse('__custom__')">
      <span class="house-dd-dot custom">+</span>
      <span class="house-dd-item-name" style="color:var(--text-secondary)">Outra casa</span>
    </div>`;
  sel.innerHTML = `
    <div class="house-dd">
      <div class="house-dd-caption">CASA SELECIONADA</div>
      <button type="button" class="house-dd-trigger" onclick="toggleHouseDropdown(event)">
        ${valueHtml}
        <span class="house-dd-caret">▾</span>
      </button>
      <div class="house-dd-menu" id="houseDdMenu">${items}${customItem}</div>
    </div>
  `;
  document.getElementById('customHouseGroup').style.display = customSelected ? 'block' : 'none';
}

function toggleHouseDropdown(e) {
  if(e) e.stopPropagation();
  const menu = document.getElementById('houseDdMenu');
  if(!menu) return;
  const willOpen = !menu.classList.contains('open');
  menu.classList.toggle('open', willOpen);
  if(willOpen) {
    setTimeout(() => document.addEventListener('click', closeHouseDropdownOnce, { once:true }), 0);
  }
}
function closeHouseDropdownOnce() {
  const menu = document.getElementById('houseDdMenu');
  if(menu) menu.classList.remove('open');
}

function selectHouse(name) {
  if(name === '__custom__') {
    selectedHouseInModal = { name: '', color: '#6366f1', initials: '?', custom: true };
  } else {
    const h = HOUSES_CATALOG.find(x => x.name === name);
    if(h) selectedHouseInModal = h;
  }
  renderHouseSelector();
}

async function saveAccount() {
  if(!selectedHouseInModal) {
    showToast('Selecione uma casa de aposta!','error'); return;
  }
  let house, color, initials, customName = null;
  if(selectedHouseInModal.custom) {
    const cn = document.getElementById('customHouseName').value.trim();
    if(!cn) { showToast('Digite o nome da casa!','error'); return; }
    house = cn;
    customName = cn;
    color = '#6366f1';
    initials = cn.charAt(0).toUpperCase();
  } else {
    house = selectedHouseInModal.name;
    color = selectedHouseInModal.color;
    initials = selectedHouseInModal.initials;
  }
  const amount = parseFloat(document.getElementById('accountAmount').value);
  if(isNaN(amount) || amount < 0) { showToast('Informe um saldo válido!','error'); return; }
  const date = document.getElementById('accountDate').value || isoDateLocal();
  const note = document.getElementById('accountNote').value.trim();

  if(editingAccountId) {
    const a = accounts.find(x => x.id === editingAccountId);
    if(a) {
      a.house = house; a.customName = customName; a.color = color; a.initials = initials;
      a.balance = amount; a.date = date; a.note = note;
    }
    showToast(`Conta "${house}" atualizada!`,'success');
  } else {
    // Conflito: já existe conta dessa casa?
    const existing = accounts.find(x => x.house.toLowerCase() === house.toLowerCase());
    if(existing) {
      const ok = await customConfirm(
        `Já existe uma conta na ${house} com saldo de R$ ${existing.balance.toFixed(2)}. Deseja substituir pelo novo saldo de R$ ${amount.toFixed(2)}?`,
        'Conta já cadastrada',
        'Substituir',
        false
      );
      if(!ok) return;
      existing.balance = amount; existing.date = date; existing.note = note;
      existing.color = color; existing.initials = initials;
      showToast(`Saldo da ${house} atualizado!`,'success');
    } else {
      accounts.push({
        id: Date.now(),
        house, customName, color, initials,
        balance: amount, date, note,
        createdAt: Date.now()
      });
      showToast(`Conta na ${house} cadastrada com R$ ${amount.toFixed(2)}!`,'success');
    }
  }
  closeAccountModal();
  renderAccounts();
  persistAccounts();
}

async function deleteAccount() {
  if(!editingAccountId) return;
  const a = accounts.find(x => x.id === editingAccountId);
  if(!a) return;
  const ok = await customConfirm(
    `Excluir a conta "${a.house}" (saldo R$ ${a.balance.toFixed(2)})?`,
    'Excluir conta',
    'Excluir'
  );
  if(!ok) return;
  accounts = accounts.filter(x => x.id !== editingAccountId);
  closeAccountModal();
  renderAccounts();
  persistAccounts();
  showToast(`Conta "${a.house}" excluída.`,'info');
}

// Abre o modal estilizado de depósito/retirada (substitui o prompt() nativo)
let _balanceAdjust = null; // { id, delta }
function quickAdjustBalance(id, delta) {
  const a = accounts.find(x => x.id === id);
  if(!a) return;
  _balanceAdjust = { id: id, delta: delta };
  const isDep = delta > 0;
  setTextSafe('balanceModalTitle', (isDep ? '💰 Depositar em ' : '💸 Retirar de ') + a.house);
  setTextSafe('balanceModalSub', 'Saldo atual: ' + fmtBRL(a.balance));
  const inp = document.getElementById('balanceModalValue');
  if(inp) inp.value = '';
  const ok = document.getElementById('balanceModalOk');
  if(ok) ok.textContent = isDep ? 'Depositar' : 'Retirar';
  document.getElementById('balanceModal').classList.add('open');
  setTimeout(() => { if(inp) inp.focus(); }, 100);
}
function closeBalanceModal() {
  document.getElementById('balanceModal').classList.remove('open');
  _balanceAdjust = null;
}
async function confirmBalanceAdjust() {
  if(!_balanceAdjust) return;
  const id = _balanceAdjust.id, delta = _balanceAdjust.delta;
  const a = accounts.find(x => x.id === id);
  if(!a) { closeBalanceModal(); return; }
  const v = parseFloat(String(document.getElementById('balanceModalValue').value || '').replace(',','.'));
  if(isNaN(v) || v < 0) { showToast('Valor inválido!','error'); return; }
  if(delta > 0) {
    a.balance += v;
    showToast(`+R$ ${v.toFixed(2)} adicionado em ${a.house}. Novo saldo: R$ ${a.balance.toFixed(2)}`,'success');
  } else {
    if(v > a.balance) {
      const okc = await customConfirm(
        `Você está retirando R$ ${v.toFixed(2)} mas só tem R$ ${a.balance.toFixed(2)}. O saldo ficará negativo. Confirma?`,
        'Saldo insuficiente', 'Confirmar', false
      );
      if(!okc) return; // mantém o modal aberto pra ajustar o valor
    }
    a.balance -= v;
    showToast(`-R$ ${v.toFixed(2)} retirado de ${a.house}. Novo saldo: R$ ${a.balance.toFixed(2)}`,'info');
  }
  a.date = isoDateLocal();
  closeBalanceModal();
  renderAccounts();
  persistAccounts();
}

function renderAccounts() {
  const grid = document.getElementById('accountsGrid');
  const empty = document.getElementById('accountsEmpty');
  if(!grid) return;

  // Filtro + sort
  const q = (document.getElementById('accountSearch')?.value || '').toLowerCase().trim();
  const sortMode = document.getElementById('accountSort')?.value || 'value-desc';
  let list = accounts.filter(a => !q || a.house.toLowerCase().includes(q) || (a.note||'').toLowerCase().includes(q));
  switch(sortMode) {
    case 'value-desc': list.sort((a,b) => b.balance - a.balance); break;
    case 'value-asc':  list.sort((a,b) => a.balance - b.balance); break;
    case 'name-asc':   list.sort((a,b) => a.house.localeCompare(b.house, 'pt-BR')); break;
    case 'recent':     list.sort((a,b) => (b.createdAt||0) - (a.createdAt||0)); break;
  }

  if(accounts.length === 0) {
    grid.style.display = 'none';
    if(empty) empty.style.display = 'block';
  } else {
    grid.style.display = 'grid';
    if(empty) empty.style.display = 'none';
  }

  grid.innerHTML = list.map(a => {
    let balanceClass = '';
    let cardClass = 'account-card';
    if(a.balance === 0) { balanceClass = 'zero'; cardClass += ' empty-balance'; }
    else if(a.balance < 50) { balanceClass = 'low'; cardClass += ' low-balance'; }
    const dateStr = a.date ? dateBR(a.date) : '—';
    const noteHtml = a.note ? `<div class="account-note">📝 ${escapeHtml(a.note)}</div>` : '';
    return `
      <div class="${cardClass}" style="--house-color:${a.color}" onclick="openAccountModal(${a.id})">
        <div class="account-head">
          <div class="house-logo" style="--house-color:${a.color};background:${a.color}">${escapeHtml(a.initials)}</div>
          <div style="min-width:0;flex:1">
            <div class="house-name">${escapeHtml(a.house)}</div>
            <div class="house-meta">Atualizado em ${dateStr}</div>
          </div>
        </div>
        <div class="account-balance ${balanceClass}">${fmtBRL(a.balance)}</div>
        ${noteHtml}
        <div class="account-actions" onclick="event.stopPropagation()">
          <button class="account-quick-btn add" onclick="quickAdjustBalance(${a.id}, 1)">＋ Depositar</button>
          <button class="account-quick-btn sub" onclick="quickAdjustBalance(${a.id}, -1)">－ Retirar</button>
        </div>
      </div>
    `;
  }).join('');

  // KPIs
  const total = accounts.reduce((s,a) => s + a.balance, 0);
  const top = accounts.length > 0 ? accounts.reduce((max,a) => a.balance > max.balance ? a : max, accounts[0]) : null;
  const low = accounts.filter(a => a.balance < 50);
  setTextSafe('accTotalValue', fmtBRL(total));
  setTextSafe('accTotalSub', accounts.length + (accounts.length === 1 ? ' conta cadastrada' : ' contas cadastradas'));
  setTextSafe('accTopValue', top ? top.house : '—');
  setTextSafe('accTopSub', top ? fmtBRL(top.balance) : 'Sem contas');
  setTextSafe('accLowCount', low.length);
  setTextSafe('accLowSub', low.length > 0 ? low.map(a => a.house).slice(0,3).join(', ') + (low.length > 3 ? '…' : '') : 'Nenhuma conta com saldo baixo');
  setTextSafe('accCount', accounts.length);
}

function exportAccountsCSV() {
  if(accounts.length === 0) { showToast('Nenhuma conta para exportar.','error'); return; }
  const headers = ['Casa de Aposta','Saldo (R$)','Última atualização','Observação'];
  let csv = '\uFEFF' + headers.join(';') + '\n';
  accounts.forEach(a => {
    const row = [
      `"${a.house.replace(/"/g,'""')}"`,
      a.balance.toFixed(2).replace('.', ','),
      dateBR(a.date),
      `"${(a.note||'').replace(/"/g,'""')}"`
    ];
    csv += row.join(';') + '\n';
  });
  const total = accounts.reduce((s,a) => s + a.balance, 0);
  csv += '\n;TOTAL;' + total.toFixed(2).replace('.',',') + ';\n';
  const blob = new Blob([csv], {type:'text/csv;charset=utf-8;'});
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'apostack-contas-' + new Date().toISOString().slice(0,10) + '.csv';
  document.body.appendChild(link); link.click(); document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast(`✅ ${accounts.length} contas exportadas (Total: ${fmtBRL(total)})`, 'success');
}

// ══════════════════════════════════════════════
//  GOALS (Metas) — sistema totalmente dinâmico
// ══════════════════════════════════════════════
// Cada meta tem id único, nome, ícone, valor atual, meta e (opcional) cor
// color: string hex (ex: "#6366f1") ou null = cor automática baseada no status
let goals = [];
let editingGoalId = null; // null = criar, número = editar

function openGoalModal(goalId) {
  editingGoalId = goalId || null;
  const titleEl = document.getElementById('goalModalTitle');
  const subEl   = document.getElementById('goalModalSub');
  const saveBtn = document.getElementById('goalSaveBtn');

  if(editingGoalId) {
    const g = goals.find(x => x.id === editingGoalId);
    if(!g) { editingGoalId = null; return; }
    titleEl.textContent = '✏️ Editar Meta';
    subEl.textContent   = 'Altere os valores ou o nome dessa meta';
    saveBtn.textContent = 'Atualizar →';
    document.getElementById('goalName').value    = g.name;
    document.getElementById('goalIcon').value    = g.icon;
    document.getElementById('goalTarget').value  = g.target;
    document.getElementById('goalCurrent').value = g.current;
  } else {
    titleEl.textContent = '🎯 Nova Meta';
    subEl.textContent   = 'Defina um objetivo financeiro pra acompanhar';
    saveBtn.textContent = 'Salvar →';
    document.getElementById('goalName').value    = '';
    document.getElementById('goalIcon').value    = '';
    document.getElementById('goalTarget').value  = '';
    document.getElementById('goalCurrent').value = '0';
  }
  document.getElementById('goalModal').classList.add('open');
  setTimeout(()=>document.getElementById('goalName').focus(), 100);
}

function closeGoalModal() {
  document.getElementById('goalModal').classList.remove('open');
  editingGoalId = null;
}

function saveGoal() {
  const name    = document.getElementById('goalName').value.trim();
  const icon    = document.getElementById('goalIcon').value.trim() || '🎯';
  const target  = parseFloat(document.getElementById('goalTarget').value);
  const current = parseFloat(document.getElementById('goalCurrent').value) || 0;

  if(!name)               { showToast('Informe o nome da meta!','error'); return; }
  if(!target || target<=0){ showToast('Informe um valor de meta válido!','error'); return; }

  if(editingGoalId) {
    const g = goals.find(x => x.id === editingGoalId);
    if(g) { g.name = name; g.icon = icon; g.target = target; g.current = current; }
    showToast(`Meta "${name}" atualizada!`, 'success');
  } else {
    goals.push({id: Date.now(), name, icon, target, current});
    showToast(`Meta "${name}" criada!`, current >= target ? 'success' : 'info');
  }

  closeGoalModal();
  renderGoals();
  persistState();
}

async function deleteGoal(id) {
  const g = goals.find(x => x.id === id);
  if(!g) return;
  const ok = await customConfirm(
    `Excluir a meta "${g.name}"? Essa ação não pode ser desfeita.`,
    'Excluir meta',
    'Excluir'
  );
  if(!ok) return;
  goals = goals.filter(x => x.id !== id);
  renderGoals();
  persistState();
  showToast(`Meta "${g.name}" excluída.`, 'info');
}

// ── Adicionar progresso rápido (manual) ──
let progressGoalId = null;
function openGoalProgress(id) {
  const g = goals.find(x => x.id === id);
  if(!g) return;
  progressGoalId = id;
  const fmt = v => (v < 0 ? '-R$ ' : 'R$ ') + Math.abs(v).toLocaleString('pt-BR', {minimumFractionDigits:0, maximumFractionDigits:2});
  const sub = document.getElementById('goalProgressSub');
  if(sub) sub.textContent = `${g.icon} ${g.name} — atual: ${fmt(g.current)} de R$ ${g.target.toLocaleString('pt-BR')}`;
  const inp = document.getElementById('goalProgressInput');
  if(inp) inp.value = '';
  document.getElementById('goalProgressModal').classList.add('open');
  setTimeout(() => { if(inp) inp.focus(); }, 100);
}
function closeGoalProgress() {
  document.getElementById('goalProgressModal').classList.remove('open');
  progressGoalId = null;
}
function addGoalProgress() {
  const g = goals.find(x => x.id === progressGoalId);
  if(!g) { closeGoalProgress(); return; }
  const amount = parseFloat(document.getElementById('goalProgressInput').value);
  if(!isFinite(amount) || amount === 0) { showToast('Informe um valor (use - para subtrair)!','error'); return; }
  g.current += amount;
  const reached = g.current >= g.target;
  closeGoalProgress();
  renderGoals();
  persistState();
  const sign = amount > 0 ? '+' : '-';
  showToast(`${sign}R$ ${Math.abs(amount).toLocaleString('pt-BR',{minimumFractionDigits:0,maximumFractionDigits:2})} em "${g.name}"` + (reached ? ' — meta atingida! 🎉' : ''), reached ? 'success' : 'info');
}

function renderGoals() {
  const list = document.getElementById('goalsList');
  if(!list) return;

  if(goals.length === 0) {
    list.innerHTML = '<div style="text-align:center;padding:24px;color:var(--text-muted);font-size:13px">Nenhuma meta cadastrada. Clique em <b>+ Nova Meta</b> para começar.</div>';
    refreshGoalsKPIs();
    return;
  }

  const fmt = v => v.toLocaleString('pt-BR', {minimumFractionDigits:0, maximumFractionDigits:2});

  list.innerHTML = goals.map(g => {
    const pct = (g.current / g.target) * 100;
    let statusColor, statusIcon, statusLabel;
    if(g.current < 0) {
      statusColor = 'var(--red)'; statusIcon = '❌'; statusLabel = 'Negativo';
    } else if(g.current >= g.target) {
      statusColor = 'var(--green)'; statusIcon = '✅'; statusLabel = pct.toFixed(1)+'%';
    } else {
      statusColor = 'var(--yellow)'; statusIcon = ''; statusLabel = pct.toFixed(1)+'%';
    }
    const currentStr = (g.current < 0 ? '-R$ ' : 'R$ ') + fmt(Math.abs(g.current));
    const targetStr  = 'R$ ' + fmt(g.target);

    // ── BARRA: gradiente proporcional ao progresso ──
    // Se negativo: barra vermelha com largura mínima (sinal de alerta).
    // Se atingido (>=100%): verde sólido.
    // Caso intermediário (0-99%): gradiente vermelho→laranja→verde mapeado ao tamanho TOTAL da meta,
    //   então a parte preenchida revela só o pedaço do gradiente até onde o progresso chegou.
    let barWidth, barStyle;
    if(g.current < 0) {
      barWidth = 8;
      barStyle = 'background:linear-gradient(90deg,#dc2626,#f43f5e)';
    } else if(pct >= 100) {
      barWidth = 100;
      barStyle = 'background:linear-gradient(90deg,#10b981,#34d399)';
    } else {
      barWidth = Math.max(2, pct); // mínimo 2% pra ser visível mesmo em valores baixos
      // Truque CSS: o gradiente ocupa o tamanho de 100% da META (não da barra preenchida),
      // então conforme a barra cresce, mais do gradiente aparece.
      const gradientWidthPct = (100 / Math.max(pct, 1)) * 100;
      barStyle = `background:linear-gradient(90deg,#f43f5e 0%,#f59e0b 50%,#10b981 100%);background-size:${gradientWidthPct.toFixed(1)}% 100%;background-position:left center;background-repeat:no-repeat`;
    }

    return `
      <div class="goal-row" data-goal-id="${g.id}">
        <div style="display:flex;justify-content:space-between;align-items:center;font-size:13px;font-weight:600;margin-bottom:6px;gap:8px;flex-wrap:wrap">
          <span>${escapeHtml(g.icon)} ${escapeHtml(g.name)}</span>
          <span style="display:inline-flex;align-items:center;gap:6px">
            <span style="color:${statusColor}">${currentStr} / ${targetStr} ${statusIcon} ${statusLabel}</span>
            <span class="goal-actions">
              <button class="goal-action-btn" onclick="openGoalProgress(${g.id})" title="Adicionar progresso" aria-label="Adicionar progresso">➕</button>
              <button class="goal-action-btn" onclick="openGoalModal(${g.id})" title="Editar" aria-label="Editar">✏️</button>
              <button class="goal-action-btn danger" onclick="deleteGoal(${g.id})" title="Excluir" aria-label="Excluir">🗑️</button>
            </span>
          </span>
        </div>
        <div class="progress-bar"><div class="progress-fill" style="width:${barWidth.toFixed(1)}%;${barStyle}"></div></div>
      </div>
    `;
  }).join('');

  refreshGoalsKPIs();
}

function refreshGoalsKPIs() {
  const atingidas = goals.filter(g => g.current >= g.target).length;
  const progresso = goals.filter(g => g.current >= 0 && g.current < g.target).length;
  const abaixo    = goals.filter(g => g.current < 0).length;
  const metaTotal = goals.reduce((s,g) => s + g.target, 0);
  const total     = goals.length;

  document.getElementById('goalsAtingidas').textContent    = atingidas;
  document.getElementById('goalsAtingidasSub').textContent = 'de ' + total + ' metas';
  document.getElementById('goalsProgresso').textContent    = progresso;
  document.getElementById('goalsAbaixo').textContent       = abaixo;
  document.getElementById('goalsMetaTotal').textContent    = 'R$ ' + metaTotal.toLocaleString('pt-BR');

  // Card "Metas Atingidas" do Dashboard
  const chip = document.getElementById('statMetasAtingidas');
  if(chip) chip.textContent = atingidas + ' / ' + total;
}

// escapa HTML pra evitar XSS via nome da meta
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// ══════════════════════════════════════════════
//  SUBSCRIPTION / TRIAL
// ══════════════════════════════════════════════
const TRIAL_DAYS = 7;
const SUBSCRIPTION_PRICE = 24.90;
const SUBSCRIPTION_PRICE_ANNUAL = 199;

function loadTrialState() {
  let start = null;
  try { start = localStorage.getItem('bancapro-trial-start'); } catch(e) {}
  if(!start) {
    start = new Date().toISOString();
    try { localStorage.setItem('bancapro-trial-start', start); } catch(e) {}
  }
  return new Date(start);
}

function updateTrialBanner() {
  const startEl = document.getElementById('trialDaysLeft');
  if(!startEl) return; // não estamos na seção
  const start = loadTrialState();
  const now = new Date();
  const msPerDay = 1000 * 60 * 60 * 24;
  const elapsed = Math.floor((now - start) / msPerDay);
  const dayNum  = Math.min(elapsed + 1, TRIAL_DAYS);
  const left = Math.max(TRIAL_DAYS - elapsed, 0);
  const pct  = Math.min((elapsed / TRIAL_DAYS) * 100, 100);
  const endDate = new Date(start.getTime() + TRIAL_DAYS * msPerDay);

  startEl.textContent = left;
  const endEl = document.getElementById('trialEndDate');
  if(endEl) endEl.textContent = endDate.toLocaleDateString('pt-BR');
  const fill = document.getElementById('trialProgressFill');
  if(fill) fill.style.width = pct.toFixed(1) + '%';
  const used = document.getElementById('trialUsedLabel');
  if(used) used.textContent = 'Dia ' + dayNum + ' de ' + TRIAL_DAYS;
  const pctLabel = document.getElementById('trialPctLabel');
  if(pctLabel) pctLabel.textContent = Math.round(pct) + '% concluído';

  // Atualiza data no histórico de assinatura
  const sh = document.getElementById('subHistoryDate');
  if(sh) {
    const d = start;
    sh.textContent = String(d.getDate()).padStart(2,'0') + '/' + String(d.getMonth()+1).padStart(2,'0') + '/' + String(d.getFullYear()).slice(-2);
  }
}

function subscribeNow(plan) {
  let url = (plan === 'anual') ? window.CHECKOUT_ANUAL : window.CHECKOUT_MENSAL;
  if (url && /^https?:\/\//.test(url) && String(url).indexOf('COLE_') !== 0) {
    // Preenche o email do usuário no checkout, pra assinatura casar com a conta
    let email = (currentAuthUser && currentAuthUser.email) || '';
    if (!email) { try { email = localStorage.getItem('bancapro-user-email') || ''; } catch(e){} }
    if (email) url += (url.indexOf('?') === -1 ? '?' : '&') + 'email=' + encodeURIComponent(email);
    showToast('Abrindo o checkout seguro…','info');
    window.location.href = url;
  } else {
    showToast('Checkout ainda não configurado — falta o link do Kirvano.','error');
  }
}
function continueTrialToast() {
  showToast('Tudo certo! Aproveite seus dias grátis 🎉','success');
}

function toggleFaq(el) {
  const item = el.closest('.faq-item');
  if(!item) return;
  item.classList.toggle('open');
}

// ══════════════════════════════════════════════
//  SETTINGS
// ══════════════════════════════════════════════
let logoStyle = 'single';
function setLogoStyle(style){
  logoStyle = style;
  document.getElementById('logoStyleSingle').classList.toggle('active', style==='single');
  document.getElementById('logoStyleDouble').classList.toggle('active', style==='double');
  document.getElementById('logoSplitGroup').style.display = style==='double' ? 'block' : 'none';
  updatePlatformName();
}
function updatePlatformName() {
  const name = document.getElementById('platformName').value || 'Apostack';
  const c1 = document.getElementById('logoColor1')?.value || '#ffffff';
  const el = document.getElementById('sidebarLogoText');
  if(logoStyle === 'double' && name.length > 1){
    const c2 = document.getElementById('logoColor2')?.value || '#6366f1';
    const split = Math.min(Math.max(parseInt(document.getElementById('logoSplit')?.value)||3,1), name.length-1);
    const a = name.slice(0, name.length-split);
    const b = name.slice(name.length-split);
    el.innerHTML = '<span style="color:'+c1+'">'+a+'</span><span style="color:'+c2+'">'+b+'</span>';
  } else {
    el.innerHTML = '<span style="color:'+c1+'">'+name+'</span>';
  }
  // Sem logo customizada: usa a logo padrão (logo.png); se o arquivo faltar, mostra a inicial
  if(!customLogoDataUrl) {
    const initial = name.charAt(0).toUpperCase();
    const defImg = `<img src="brand/icon.png" alt="${initial}" style="width:100%;height:100%;object-fit:contain;border-radius:6px" onerror="this.replaceWith(document.createTextNode('${initial}'))"/>`;
    const sideIcon = document.getElementById('sidebarLogoIcon');
    const authIcon = document.getElementById('authLogoIcon');
    if(sideIcon) sideIcon.innerHTML = defImg;
    if(authIcon) authIcon.innerHTML = defImg;
  }
  document.title = name + ' — Gestão Financeira';
}

// ══════════════════════════════════════════════
//  LOGO & FAVICON UPLOAD
// ══════════════════════════════════════════════
let customLogoDataUrl = null;
let customFaviconDataUrl = null;
const MAX_FILE_BYTES = 2 * 1024 * 1024; // 2 MB — evita estourar localStorage

function handleLogoUpload(e) {
  const file = e.target.files && e.target.files[0];
  if(file) readImageFile(file, applyLogo, 'logo');
  e.target.value = ''; // reset pra permitir re-upload do mesmo arquivo
}
function handleLogoDrop(e) {
  e.preventDefault();
  e.currentTarget.style.borderColor = '';
  const file = e.dataTransfer.files && e.dataTransfer.files[0];
  if(file) readImageFile(file, applyLogo, 'logo');
}
function handleFaviconUpload(e) {
  const file = e.target.files && e.target.files[0];
  if(file) readImageFile(file, applyFavicon, 'favicon');
  e.target.value = '';
}
function handleFaviconDrop(e) {
  e.preventDefault();
  e.currentTarget.style.borderColor = '';
  const file = e.dataTransfer.files && e.dataTransfer.files[0];
  if(file) readImageFile(file, applyFavicon, 'favicon');
}

// Reduz a imagem pra um tamanho pequeno (mantém a sincronização leve e confiável).
// SVG ou falha de canvas → mantém o original.
function downscaleImage(dataUrl, maxDim, cb) {
  try {
    const img = new Image();
    img.onload = function() {
      try {
        let w = img.naturalWidth || img.width;
        let h = img.naturalHeight || img.height;
        if(!w || !h) { cb(dataUrl); return; }
        if(w > maxDim || h > maxDim) {
          const scale = maxDim / Math.max(w, h);
          w = Math.max(1, Math.round(w * scale));
          h = Math.max(1, Math.round(h * scale));
        }
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        const out = canvas.toDataURL('image/png');
        cb(out && out.length < dataUrl.length ? out : dataUrl);
      } catch(e) { cb(dataUrl); }
    };
    img.onerror = function(){ cb(dataUrl); };
    img.src = dataUrl;
  } catch(e) { cb(dataUrl); }
}

async function readImageFile(file, callback, kind) {
  if(!file.type.startsWith('image/')) {
    showToast('Selecione um arquivo de imagem válido!','error'); return;
  }
  if(file.size > MAX_FILE_BYTES) {
    showToast('Arquivo muito grande! Máximo: 2 MB','error'); return;
  }
  const reader = new FileReader();
  reader.onload = e => {
    const maxDim = kind === 'favicon' ? 64 : 256;   // logo pequena = sync leve
    downscaleImage(e.target.result, maxDim, async (finalUrl) => {
      callback(finalUrl);
      showToast('Salvando…','info');
      const err = (typeof pushUserData === 'function') ? await pushUserData() : null;
      if (err) showToast('Erro ao salvar na nuvem: ' + (err.message || err), 'error');
      else showToast(kind==='logo' ? '✅ Logo salva!' : '✅ Favicon salvo!', 'success');
    });
  };
  reader.onerror = () => showToast('Erro ao ler o arquivo','error');
  reader.readAsDataURL(file);
}

function applyLogo(dataUrl) {
  customLogoDataUrl = dataUrl;
  // monta o HTML da imagem (substitui o texto "B")
  const imgHtml = `<img src="${dataUrl}" alt="Logo" style="width:100%;height:100%;object-fit:contain;border-radius:6px"/>`;
  const sideIcon = document.getElementById('sidebarLogoIcon');
  const authIcon = document.getElementById('authLogoIcon');
  if(sideIcon) sideIcon.innerHTML = imgHtml;
  if(authIcon) authIcon.innerHTML = imgHtml;
  // preview no card de upload
  const preview = document.getElementById('logoPreview');
  const previewImg = document.getElementById('logoPreviewImg');
  const uploadIcon = document.getElementById('logoUploadIcon');
  const uploadText = document.getElementById('logoUploadText');
  const removeBtn  = document.getElementById('logoRemoveBtn');
  if(previewImg) previewImg.src = dataUrl;
  if(preview) preview.style.display = 'block';
  if(uploadIcon) uploadIcon.style.display = 'none';
  if(uploadText) uploadText.textContent = 'Clique para trocar a logo';
  if(removeBtn) removeBtn.style.display = 'inline-block';
  // persiste
  try { localStorage.setItem('bancapro-logo', dataUrl); } catch(e) {}
}

function removeLogo() {
  customLogoDataUrl = null;
  const sideIcon = document.getElementById('sidebarLogoIcon');
  const authIcon = document.getElementById('authLogoIcon');
  const name = document.getElementById('platformName')?.value || 'Apostack';
  const initial = name.charAt(0).toUpperCase();
  if(sideIcon) sideIcon.innerHTML = initial;
  if(authIcon) authIcon.innerHTML = initial;
  // reseta UI do upload
  const preview = document.getElementById('logoPreview');
  const uploadIcon = document.getElementById('logoUploadIcon');
  const uploadText = document.getElementById('logoUploadText');
  const removeBtn  = document.getElementById('logoRemoveBtn');
  if(preview) preview.style.display = 'none';
  if(uploadIcon) uploadIcon.style.display = '';
  if(uploadText) uploadText.textContent = 'Arraste ou clique para enviar logo (PNG, SVG)';
  if(removeBtn) removeBtn.style.display = 'none';
  try { localStorage.removeItem('bancapro-logo'); } catch(e) {}
  if (typeof schedulePush === 'function') schedulePush();
  showToast('Logo removida','info');
}

function applyFavicon(dataUrl) {
  customFaviconDataUrl = dataUrl;
  const link = document.getElementById('appFavicon') || document.querySelector('link[rel="icon"]');
  if(link) link.href = dataUrl;
  // preview
  const preview = document.getElementById('faviconPreview');
  const previewImg = document.getElementById('faviconPreviewImg');
  const uploadIcon = document.getElementById('faviconUploadIcon');
  const uploadText = document.getElementById('faviconUploadText');
  const removeBtn  = document.getElementById('faviconRemoveBtn');
  if(previewImg) previewImg.src = dataUrl;
  if(preview) preview.style.display = 'block';
  if(uploadIcon) uploadIcon.style.display = 'none';
  if(uploadText) uploadText.textContent = 'Clique para trocar o favicon';
  if(removeBtn) removeBtn.style.display = 'inline-block';
  try { localStorage.setItem('bancapro-favicon', dataUrl); } catch(e) {}
}

function removeFavicon() {
  customFaviconDataUrl = null;
  // restaura SVG padrão
  const defaultHref = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect width='100' height='100' rx='22' fill='%236366f1'/><text x='50' y='66' font-family='Arial,sans-serif' font-size='62' font-weight='800' fill='%23fff' text-anchor='middle'>B</text></svg>";
  const link = document.getElementById('appFavicon');
  if(link) link.href = defaultHref;
  const preview = document.getElementById('faviconPreview');
  const uploadIcon = document.getElementById('faviconUploadIcon');
  const uploadText = document.getElementById('faviconUploadText');
  const removeBtn  = document.getElementById('faviconRemoveBtn');
  if(preview) preview.style.display = 'none';
  if(uploadIcon) uploadIcon.style.display = '';
  if(uploadText) uploadText.textContent = 'Enviar favicon (.ico, .png 32x32)';
  if(removeBtn) removeBtn.style.display = 'none';
  try { localStorage.removeItem('bancapro-favicon'); } catch(e) {}
  if (typeof schedulePush === 'function') schedulePush();
  showToast('Favicon restaurado','info');
}

function loadStoredBranding() {
  try {
    const logo = localStorage.getItem('bancapro-logo');
    if(logo) applyLogo(logo);
    const fav = localStorage.getItem('bancapro-favicon');
    if(fav) applyFavicon(fav);
  } catch(e) {}
}

// ── Salvar / restaurar Identidade da Plataforma ──
async function savePlatformIdentity() {
  try {
    const name = (document.getElementById('platformName')?.value || '').trim() || 'Apostack';
    localStorage.setItem('bancapro-platform-name', name);
    localStorage.setItem('bancapro-slogan', (document.getElementById('settingsSlogan')?.value || '').trim());
    localStorage.setItem('bancapro-logo-style', logoStyle);
    if(document.getElementById('logoColor1')) localStorage.setItem('bancapro-logo-color1', document.getElementById('logoColor1').value);
    if(document.getElementById('logoColor2')) localStorage.setItem('bancapro-logo-color2', document.getElementById('logoColor2').value);
    if(document.getElementById('logoSplit'))  localStorage.setItem('bancapro-logo-split',  document.getElementById('logoSplit').value);
  } catch(e) {}
  updatePlatformName();
  showToast('Salvando…','info');
  const err = (typeof pushUserData === 'function') ? await pushUserData() : null;
  if (err) showToast('Erro ao salvar na nuvem: ' + (err.message || err), 'error');
  else showToast('Identidade salva com sucesso!','success');
}

// ── Salvar Aparência (cor principal) — o tema já é salvo no setTheme ──
async function saveAppearance() {
  try {
    const cs = getComputedStyle(document.documentElement);
    const accent  = cs.getPropertyValue('--accent').trim();
    const accent2 = cs.getPropertyValue('--accent2').trim();
    if(accent)  localStorage.setItem('bancapro-accent', accent);
    if(accent2) localStorage.setItem('bancapro-accent2', accent2);
  } catch(e) {}
  showToast('Salvando…','info');
  const err = (typeof pushUserData === 'function') ? await pushUserData() : null;
  if (err) showToast('Erro ao salvar na nuvem: ' + (err.message || err), 'error');
  else showToast('Aparência salva com sucesso!','success');
}

// ── Restaura as configs salvas (chamado no carregamento) ──
function loadPlatformSettings() {
  try {
    const name   = localStorage.getItem('bancapro-platform-name');
    const slogan = localStorage.getItem('bancapro-slogan');
    const style  = localStorage.getItem('bancapro-logo-style');
    const c1     = localStorage.getItem('bancapro-logo-color1');
    const c2     = localStorage.getItem('bancapro-logo-color2');
    const split  = localStorage.getItem('bancapro-logo-split');
    const accent = localStorage.getItem('bancapro-accent');
    const accent2= localStorage.getItem('bancapro-accent2');

    const pn = document.getElementById('platformName');
    if(name && pn) pn.value = name;
    const sl = document.getElementById('settingsSlogan');
    if(slogan && sl) sl.value = slogan;
    // mostra o slogan como tagline na tela de login
    const authSl = document.getElementById('authSlogan');
    if(authSl){ if(slogan){ authSl.textContent = slogan; authSl.style.display=''; } else { authSl.style.display='none'; } }
    if(c1 && document.getElementById('logoColor1')) document.getElementById('logoColor1').value = c1;
    if(c2 && document.getElementById('logoColor2')) document.getElementById('logoColor2').value = c2;
    if(split && document.getElementById('logoSplit')) document.getElementById('logoSplit').value = split;

    // só rebuilda o logo se o usuário customizou algo (senão mantém o padrão)
    if(name || c1 || c2 || style) {
      if(style) setLogoStyle(style); else updatePlatformName();
    }

    if(accent) {
      document.documentElement.style.setProperty('--accent', accent);
      document.documentElement.style.setProperty('--accent2', accent2 || accent);
      document.querySelectorAll('.swatch').forEach(s => {
        const st = s.getAttribute('style') || '';
        s.classList.toggle('active', st.indexOf(accent) !== -1);
      });
      const cc = document.getElementById('customColor');
      if(cc) cc.value = accent;
    }
  } catch(e) {}
}
function updateUserName() {
  document.getElementById('sidebarUserName').textContent = document.getElementById('settingsUserName').value || 'Admin';
}

async function saveProfile() {
  const name  = document.getElementById('settingsUserName').value.trim() || 'Admin';
  const email = document.getElementById('settingsUserEmail').value.trim();
  if(email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    showToast('E-mail inválido!','error');
    return;
  }

  // --- troca de senha (opcional) ---
  const cur = (document.getElementById('settingsCurPwd')||{}).value || '';
  const nw  = (document.getElementById('settingsNewPwd')||{}).value || '';
  const nw2 = (document.getElementById('settingsNewPwd2')||{}).value || '';
  const wantsPwd = cur || nw || nw2;
  if (wantsPwd) {
    if (!cur || !nw || !nw2) { showToast('Pra trocar a senha, preencha a senha atual, a nova e a confirmação.','error'); return; }
    if (nw.length < 6)       { showToast('A nova senha precisa de pelo menos 6 caracteres.','error'); return; }
    if (nw !== nw2)          { showToast('A nova senha e a confirmação não conferem.','error'); return; }
    const ok = await changePassword(cur, nw);
    if (!ok) return; // changePassword já avisou o erro
  }

  try {
    localStorage.setItem('bancapro-user-name', name);
    if(email) localStorage.setItem('bancapro-user-email', email);
  } catch(e) {}
  if (typeof schedulePush === 'function') schedulePush();
  updateUserName();
  // Atualiza avatar (inicial)
  document.querySelectorAll('.user-avatar').forEach(el => { el.textContent = name.charAt(0).toUpperCase(); });
  // limpa os campos de senha
  ['settingsCurPwd','settingsNewPwd','settingsNewPwd2'].forEach(id => { const e=document.getElementById(id); if(e) e.value=''; });
  showToast(wantsPwd ? 'Perfil e senha atualizados com sucesso!' : 'Perfil atualizado com sucesso!','success');
}

// Troca a senha de verdade (confere a senha atual antes). Retorna true se deu certo.
async function changePassword(currentPwd, newPwd) {
  const sb = getSb();
  if (sb) {
    try {
      const { data: sess } = await sb.auth.getUser();
      const email = sess && sess.user ? sess.user.email : '';
      if (!email) { showToast('Sessão não encontrada. Entre novamente.','error'); return false; }
      // confere a senha atual reautenticando
      const { error: reauthErr } = await sb.auth.signInWithPassword({ email, password: currentPwd });
      if (reauthErr) { showToast('Senha atual incorreta.','error'); return false; }
      const { error: updErr } = await sb.auth.updateUser({ password: newPwd });
      if (updErr) { showToast('Não foi possível trocar a senha: ' + (updErr.message||''),'error'); return false; }
      return true;
    } catch(e) { showToast('Erro ao trocar a senha.','error'); return false; }
  } else {
    try {
      const sid = localStorage.getItem(LOCAL_SESSION_KEY);
      const users = localGetUsers();
      const u = users.find(x => x.id === sid);
      if (!u) { showToast('Sessão não encontrada.','error'); return false; }
      const h = await hashPassword(currentPwd, u.salt);
      if (h !== u.passHash) { showToast('Senha atual incorreta.','error'); return false; }
      u.passHash = await hashPassword(newPwd, u.salt);
      localSetUsers(users);
      return true;
    } catch(e) { showToast('Erro ao trocar a senha.','error'); return false; }
  }
}

function loadProfile() {
  try {
    const name = localStorage.getItem('bancapro-user-name');
    if(name) {
      const ni = document.getElementById('settingsUserName');
      if(ni) ni.value = name;
      const sb = document.getElementById('sidebarUserName');
      if(sb) sb.textContent = name;
      document.querySelectorAll('.user-avatar').forEach(el => { el.textContent = name.charAt(0).toUpperCase(); });
    }
    const email = localStorage.getItem('bancapro-user-email');
    if(email) {
      const ei = document.getElementById('settingsUserEmail');
      if(ei) ei.value = email;
    }
  } catch(e) {}
}
function setAccent(color, color2, el) {
  document.documentElement.style.setProperty('--accent', color);
  document.documentElement.style.setProperty('--accent2', color2);
  document.querySelectorAll('.swatch').forEach(s => s.classList.remove('active'));
  el.classList.add('active');
  showToast('Cor aplicada com sucesso!','success');
}
function applyCustomColor() {
  const c = document.getElementById('customColor').value;
  document.documentElement.style.setProperty('--accent', c);
  document.documentElement.style.setProperty('--accent2', c);
  showToast('Cor personalizada aplicada!','success');
}
// Atalho de tema na topbar (alterna claro/escuro)
function toggleTheme() {
  let cur = 'dark';
  try { cur = localStorage.getItem('bancapro-theme') || 'dark'; } catch(e){}
  const next = cur === 'light' ? 'dark' : 'light';
  setTheme(next);
  updateThemeBtn(next);
}
function updateThemeBtn(theme) {
  if (!theme) { try { theme = localStorage.getItem('bancapro-theme') || 'dark'; } catch(e){ theme = 'dark'; } }
  const btn = document.getElementById('themeBtn');
  if (btn) {
    btn.textContent = theme === 'light' ? '🌙' : '☀️';
    btn.title = theme === 'light' ? 'Mudar para escuro' : 'Mudar para claro';
  }
}

function setTheme(theme, el) {
  document.querySelectorAll('.theme-btn').forEach(b => b.classList.remove('active'));
  if(el) el.classList.add('active');
  try { localStorage.setItem('bancapro-theme', theme); } catch(e) {}
  const root = document.documentElement;
  if(theme === 'light') {
    root.classList.remove('dark'); root.classList.add('light');
    root.style.setProperty('--bg-primary','#f8fafc');
    root.style.setProperty('--bg-secondary','#eef2f7');
    root.style.setProperty('--bg-card','#ffffff');
    root.style.setProperty('--text-primary','#0f172a');
    root.style.setProperty('--text-secondary','#475569');
    root.style.setProperty('--text-muted','#94a3b8');
    root.style.setProperty('--border','rgba(15,23,42,0.08)');
    root.style.setProperty('--border-hover','rgba(15,23,42,0.18)');
    root.style.setProperty('--glass','rgba(15,23,42,0.03)');
    root.style.setProperty('--glass-border','rgba(15,23,42,0.08)');
    root.style.setProperty('--topbar-bg','rgba(248,250,252,0.97)');
    root.style.setProperty('--shadow','0 4px 24px rgba(15,23,42,0.06)');
    root.style.setProperty('--shadow-card','0 2px 12px rgba(15,23,42,0.05)');
  } else {
    root.classList.remove('light'); root.classList.add('dark');
    root.style.setProperty('--bg-primary','#060d18');
    root.style.setProperty('--bg-secondary','#081120');
    root.style.setProperty('--bg-card','#0d1626');
    root.style.setProperty('--text-primary','#f1f5f9');
    root.style.setProperty('--text-secondary','#94a3b8');
    root.style.setProperty('--text-muted','#475569');
    root.style.setProperty('--border','rgba(255,255,255,0.06)');
    root.style.setProperty('--border-hover','rgba(255,255,255,0.12)');
    root.style.setProperty('--glass','rgba(255,255,255,0.03)');
    root.style.setProperty('--glass-border','rgba(255,255,255,0.08)');
    root.style.setProperty('--topbar-bg','rgba(6,13,24,0.85)');
    root.style.setProperty('--shadow','0 4px 32px rgba(0,0,0,0.4)');
    root.style.setProperty('--shadow-card','0 2px 16px rgba(0,0,0,0.3)');
  }
  // Rebuild charts with new theme colors
  applyChartDefaults();
  chartDefaults = getChartDefaults();
  if(typeof buildEvoChart === 'function') {
    buildEvoChart(currentEvoMode,
      document.getElementById('evoDateFrom')?.value,
      document.getElementById('evoDateTo')?.value
    );
  }
  // Reset sub-chart init flags to force rebuild on next visit
  window._reportChartsInit = false;
  window._compareInit = false;
  window._methodEvoInit = false;
  // sincroniza o tema na conta (entre aparelhos)
  if (typeof schedulePush === 'function') schedulePush();
}

// ══════════════════════════════════════════════
//  TOAST
// ══════════════════════════════════════════════
function showToast(msg, type='info') {
  const icons = {success:'✅',error:'❌',info:'ℹ️',warning:'⚠️'};
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.innerHTML = `<span>${icons[type]||'ℹ️'}</span><span>${msg}</span>`;
  document.getElementById('toastContainer').appendChild(t);
  setTimeout(() => t.remove(), 3500);
}

// ══════════════════════════════════════════════
//  CUSTOM CONFIRM (substitui o confirm() nativo)
// ══════════════════════════════════════════════
function customConfirm(message, title = 'Confirmar ação', confirmLabel = 'Confirmar', isDanger = true) {
  return new Promise(resolve => {
    const modal = document.getElementById('confirmModal');
    const titleEl = document.getElementById('confirmTitle');
    const msgEl = document.getElementById('confirmMessage');
    const okBtn = document.getElementById('confirmOkBtn');
    const cancelBtn = document.getElementById('confirmCancelBtn');
    if(!modal) { resolve(window.confirm(message)); return; } // fallback de segurança

    titleEl.textContent = title;
    msgEl.textContent = message;
    okBtn.textContent = confirmLabel;
    okBtn.className = isDanger ? 'btn-danger' : 'btn-primary';
    okBtn.style.padding = '9px 20px';
    modal.classList.add('open');
    setTimeout(() => okBtn.focus(), 80);

    function cleanup() {
      modal.classList.remove('open');
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      document.removeEventListener('keydown', onKey);
    }
    function onOk()     { cleanup(); resolve(true); }
    function onCancel() { cleanup(); resolve(false); }
    function onKey(e)   { if(e.key === 'Enter') onOk(); }
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    document.addEventListener('keydown', onKey);
  });
}

// ══════════════════════════════════════════════
//  CHARTS
// ══════════════════════════════════════════════
function getChartColors() {
  const isDark = !document.documentElement.classList.contains('light');
  return {
    text: isDark ? '#94a3b8' : '#475569',
    grid: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(15,23,42,0.06)',
    border: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(15,23,42,0.08)',
    tooltipBg: isDark ? '#1a1f2e' : '#ffffff',
    tooltipBorder: isDark ? 'rgba(255,255,255,0.12)' : 'rgba(15,23,42,0.12)',
    tooltipTitle: isDark ? '#f1f5f9' : '#0f172a',
    tooltipBody: isDark ? '#94a3b8' : '#475569',
  };
}
function applyChartDefaults() {
  const cc = getChartColors();
  Chart.defaults.color = cc.text;
  Chart.defaults.borderColor = cc.border;
}
applyChartDefaults();

function getChartDefaults() {
  const cc = getChartColors();
  return {
    plugins: { legend: { display: false } },
    scales: {
      x: { grid: { color: cc.grid }, ticks: { color: cc.text, font: { size: 11 } } },
      y: { grid: { color: cc.grid }, ticks: { color: cc.text, font: { size: 11 } } }
    }
  };
}
let chartDefaults = getChartDefaults();

// ══════════════════════════════════════════════
//  EVOLUÇÃO FINANCEIRA — DADOS E LÓGICA
// ══════════════════════════════════════════════
// Constrói o dataset de evolução a partir de `transactions`
function buildEvoDatasetFor(mode, fromDate, toDate) {
  const monthShort = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
  const today = new Date();
  // Formata a data em YYYY-MM-DD usando o fuso LOCAL (toISOString usa UTC e atrasa 1 dia no Brasil)
  const isoLocal = d => d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');

  if(mode === 'yearly') {
    // Últimos 12 meses encerrando no mês atual
    const labels = [], saldo = [], lucro = [], despesas = [], receita = [];
    let runningSaldo = SALDO_BASE;
    // Primeiro precisamos calcular o saldo de início do período de 12 meses atrás
    // Soma das transações ANTES do início desse período
    const startYear  = today.getFullYear();
    const startMonth = today.getMonth() - 11;
    const periodStart = new Date(startYear, startMonth, 1);
    // compara como string YYYY-MM-DD (evita o bug de fuso do new Date('YYYY-MM-DD') = UTC)
    const periodStartStr = periodStart.getFullYear()+'-'+String(periodStart.getMonth()+1).padStart(2,'0')+'-01';
    transactions.forEach(t => {
      if((t.date||'') < periodStartStr) runningSaldo += (t.type==='income' ? t.value : -t.value);
    });
    for(let i = 11; i >= 0; i--) {
      const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
      const y = d.getFullYear(), m = d.getMonth();
      const monthYM = String(y) + '-' + String(m+1).padStart(2,'0');
      let monthRec = 0, monthDes = 0;
      transactions.forEach(t => {
        if((t.date||'').slice(0,7) === monthYM) {
          if(t.type === 'income')  monthRec += t.value;
          if(t.type === 'expense') monthDes += t.value;
        }
      });
      const monthLuc = monthRec - monthDes;
      runningSaldo += monthLuc;
      labels.push(monthShort[m] + '/' + String(y).slice(-2));
      saldo.push(runningSaldo);
      lucro.push(monthLuc);
      despesas.push(monthDes);
      receita.push(monthRec);
    }
    return { subtitle: 'Últimos 12 meses', labels, saldo, lucro, despesas, receita, isDaily: false };
  }

  if(mode === '30d' || mode === '7d') {
    const days = mode === '7d' ? 7 : 30;
    const labels = [], saldo = [], lucro = [], despesas = [], receita = [];
    // saldo inicial = SALDO_BASE + tudo antes do período
    let runningSaldo = SALDO_BASE;
    const periodStart = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (days-1));
    const periodStartStr = periodStart.getFullYear()+'-'+String(periodStart.getMonth()+1).padStart(2,'0')+'-'+String(periodStart.getDate()).padStart(2,'0');
    transactions.forEach(t => {
      if((t.date||'') < periodStartStr) runningSaldo += (t.type==='income' ? t.value : -t.value);
    });
    for(let i = days - 1; i >= 0; i--) {
      const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
      const iso = isoLocal(d);
      let dayRec = 0, dayDes = 0;
      transactions.forEach(t => {
        if(t.date === iso) {
          if(t.type === 'income')  dayRec += t.value;
          if(t.type === 'expense') dayDes += t.value;
        }
      });
      const dayLuc = dayRec - dayDes;
      runningSaldo += dayLuc;
      labels.push(iso);
      saldo.push(runningSaldo);
      lucro.push(dayLuc);
      despesas.push(dayDes);
      receita.push(dayRec);
    }
    return { subtitle: `Últimos ${days} dias`, labels, saldo, lucro, despesas, receita, isDaily: true };
  }

  if(mode === 'today') {
    // Plota UM PONTO POR TRANSAÇÃO do dia (em ordem de criação) — deixa a linha
    // dinâmica em vez de uma reta. Sem hora real, usamos o horário de criação (id).
    const iso = isoLocal(today);
    // Saldo no início do dia (antes das transações de hoje)
    let saldoInicio = SALDO_BASE;
    transactions.forEach(t => {
      if((t.date||'') < iso) saldoInicio += (t.type==='income' ? t.value : -t.value);
    });
    const hoje = transactions.filter(t => t.date === iso).slice().sort((a,b) => (a.id||0) - (b.id||0));
    const labels = ['Início'], saldo = [saldoInicio], lucro = [0], despesas = [0], receita = [0];
    let rSaldo = saldoInicio, rRec = 0, rDes = 0;
    hoje.forEach((t, i) => {
      if(t.type === 'income') { rRec += t.value; rSaldo += t.value; }
      else                    { rDes += t.value; rSaldo -= t.value; }
      let lbl;
      if(i === hoje.length - 1) lbl = 'Agora';
      else { const d = new Date(t.id); lbl = isNaN(d.getTime()) ? String(i+1) : (String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0')); }
      labels.push(lbl);
      saldo.push(rSaldo); lucro.push(rRec - rDes); despesas.push(rDes); receita.push(rRec);
    });
    // sem transações hoje: garante 2 pontos pra desenhar a linha (reta no saldo atual)
    if(hoje.length === 0) { labels.push('Agora'); saldo.push(saldoInicio); lucro.push(0); despesas.push(0); receita.push(0); }
    return {
      subtitle: 'Hoje — ' + today.toLocaleDateString('pt-BR'),
      labels, saldo, lucro, despesas, receita, isDaily: false
    };
  }

  // custom (intervalo livre via fromDate/toDate)
  if(mode === 'custom' && fromDate && toDate) {
    const labels = [], saldo = [], lucro = [], despesas = [], receita = [];
    let runningSaldo = SALDO_BASE;
    const periodStart = new Date(fromDate);
    transactions.forEach(t => {
      if((t.date||'') < fromDate) runningSaldo += (t.type==='income' ? t.value : -t.value);
    });
    const end = new Date(toDate);
    for(let d = new Date(periodStart); d <= end; d.setDate(d.getDate()+1)) {
      const iso = isoLocal(d);
      let dayRec = 0, dayDes = 0;
      transactions.forEach(t => {
        if(t.date === iso) {
          if(t.type === 'income')  dayRec += t.value;
          if(t.type === 'expense') dayDes += t.value;
        }
      });
      const dayLuc = dayRec - dayDes;
      runningSaldo += dayLuc;
      labels.push(iso);
      saldo.push(runningSaldo);
      lucro.push(dayLuc);
      despesas.push(dayDes);
      receita.push(dayRec);
    }
    return { subtitle: 'Personalizado', labels, saldo, lucro, despesas, receita, isDaily: true };
  }

  // fallback
  return { subtitle: '—', labels: [], saldo: [], lucro: [], despesas: [], receita: [], isDaily: false };
}

let mainChartInstance = null;
let currentEvoMode = 'today';

function buildEvoChart(mode, fromDate, toDate) {
  const w = window.innerWidth;
  const isMobile = w <= 768;
  const wrap = document.getElementById('mainChartWrap');
  if(wrap) wrap.style.height = (w <= 640 ? 280 : w <= 1024 ? 360 : 400) + 'px';
  const canvas = document.getElementById('mainChart');

  // Constrói dataset a partir de transactions (custom usa from/to)
  let src = buildEvoDatasetFor(mode, fromDate, toDate);
  let labels = src.labels;
  let saldo = src.saldo;
  let lucro = src.lucro;
  let despesas = src.despesas;
  let receita = src.receita;
  const isDaily = src.isDaily;

  // Hoje/7d/Personalizado: ajusta o eixo Y pra linha ocupar o gráfico e mostrar os desvios.
  // Se a banca for grande, o eixo dá ZOOM na faixa do saldo (em vez de começar no
  // zero), senão o saldo fica colado no topo e parece reto. Nunca abaixo de 0.
  let yMin, yMax, zoomedToSaldo = false;
  if(mode === 'today' || mode === '7d' || mode === 'custom') {
    const all = saldo.concat(lucro, receita, despesas).filter(v => isFinite(v));
    const sal = saldo.filter(v => isFinite(v));
    if(all.length && sal.length) {
      const aLo = Math.min.apply(null, all), aHi = Math.max.apply(null, all);
      const sLo = Math.min.apply(null, sal), sHi = Math.max.apply(null, sal);
      const aRange = (aHi - aLo) || Math.abs(aHi) || 1;
      const sVar = sHi - sLo;
      // Saldo "some" no eixo cheio? então dá zoom só na faixa do saldo.
      if(sVar > 0 && sVar < aRange * 0.30) {
        const pad = sVar * 0.4;
        yMin = Math.max(0, sLo - pad);
        yMax = sHi + pad;
        zoomedToSaldo = true;
      } else {
        const pad = aRange * 0.1;
        yMin = Math.max(0, aLo - pad);
        yMax = aHi + pad;
      }
    }
  }

  // Aviso quando o zoom-saldo deixa Lucro/Receita/Despesa fora da escala
  const axisNote = document.getElementById('evoAxisNote');
  if(axisNote) {
    let hideNote = true;
    if(zoomedToSaldo && yMin != null) {
      const flows = lucro.concat(receita, despesas).filter(v => isFinite(v));
      // se algum valor de fluxo cai abaixo do yMin, ele fica fora do grafico
      if(flows.length && Math.min.apply(null, flows) < yMin) hideNote = false;
    }
    axisNote.style.display = hideNote ? 'none' : '';
  }

  if(mode === 'custom' && fromDate && toDate) {
    document.getElementById('evoSubtitle').textContent = 'Personalizado — '+fmtLabel(fromDate)+' a '+fmtLabel(toDate);
  } else {
    document.getElementById('evoSubtitle').textContent = src.subtitle;
  }

  const ctx = canvas.getContext('2d');
  const gradH = (wrap && wrap.clientHeight) ? wrap.clientHeight : 400;
  const saldoGrad = ctx.createLinearGradient(0,0,0,gradH);
  saldoGrad.addColorStop(0,'rgba(99,102,241,0.25)'); saldoGrad.addColorStop(1,'rgba(99,102,241,0)');
  const lucroGrad = ctx.createLinearGradient(0,0,0,gradH);
  lucroGrad.addColorStop(0,'rgba(16,185,129,0.2)'); lucroGrad.addColorStop(1,'rgba(16,185,129,0)');

  if(mainChartInstance) mainChartInstance.destroy();

  mainChartInstance = new Chart(ctx, {
    type:'line',
    data:{
      labels,
      datasets:[
        {label:'Saldo',   data:saldo,    borderColor:'#6366f1',backgroundColor:saldoGrad,borderWidth:2.5,fill:true, tension:0.4,pointRadius:isMobile?2:3,pointHoverRadius:6,pointBackgroundColor:'#6366f1'},
        {label:'Lucro',   data:lucro,    borderColor:'#10b981',backgroundColor:lucroGrad,borderWidth:2,  fill:true, tension:0.4,pointRadius:isMobile?2:3,pointHoverRadius:5,pointBackgroundColor:'#10b981'},
        {label:'Receita', data:receita,  borderColor:'#f59e0b',borderWidth:1.5,fill:false,tension:0.4,pointRadius:0,pointHoverRadius:4,borderDash:[2,3]},
        {label:'Despesas',data:despesas, borderColor:'#f43f5e',borderWidth:1.5,fill:false,tension:0.4,pointRadius:0,pointHoverRadius:4,borderDash:[4,4]},
      ]
    },
    options:{
      responsive:true,
      maintainAspectRatio:false,
      interaction:{mode:'index',intersect:false},
      layout:{padding:{top:8,right:8,left:0,bottom:0}},
      plugins:{
        legend:{display:false},
        tooltip:{
          mode:'index',intersect:false,
          backgroundColor:getChartColors().tooltipBg,
          borderColor:getChartColors().tooltipBorder,
          borderWidth:1,
          padding:14,
          titleColor:getChartColors().tooltipTitle,
          titleFont:{size:12,weight:'bold'},
          bodyColor:getChartColors().tooltipBody,
          bodyFont:{size:12},
          callbacks:{
            title(items){
              const raw = items[0].label;
              if(isDaily && raw.includes('-')){
                const p = raw.split('-');   // YYYY-MM-DD (sem new Date pra não ter fuso)
                return p[2]+'/'+p[1]+'/'+p[0];
              }
              return raw;
            },
            label(ctx){
              const v = ctx.raw;
              const fmt = new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(v);
              return ' '+ctx.dataset.label+': '+fmt;
            }
          }
        }
      },
      scales:{
        x:{
          grid:{color:getChartColors().grid,drawBorder:false},
          ticks:{
            color:getChartColors().text,font:{size:10},
            maxRotation:0,
            maxTicksLimit: isMobile ? 6 : 12,
            callback(val,idx){
              const lbl = labels[idx];
              if(isDaily && lbl && lbl.includes('-')){
                const p = lbl.split('-');   // YYYY-MM-DD (sem new Date pra não ter fuso)
                return p[2]+'/'+p[1];
              }
              return lbl;
            }
          }
        },
        y:{
          // Hoje/7d: eixo ajustado ao valor real do período (mostra os desvios); demais: automático
          min: yMin,
          max: yMax,
          grid:{color:getChartColors().grid,drawBorder:false},
          ticks:{
            color:getChartColors().text,font:{size:10},
            callback(v){
              if(Math.abs(v) >= 1000){
                var n = v/1000;
                // mostra 1 casa decimal quando o tick nao e um milhar inteiro (evita "4k 4k 3k 3k")
                return (Math.abs(n - Math.round(n)) < 0.05 ? Math.round(n) : n.toFixed(1)) + 'k';
              }
              return 'R$'+v;
            }
          },
          position:'left'
        }
      }
    }
  });
}

function fmtLabel(dateStr){
  if(!dateStr) return '';
  const p = String(dateStr).split('-');   // YYYY-MM-DD → dd/mm/yyyy (sem fuso)
  if(p.length === 3) return p[2]+'/'+p[1]+'/'+p[0];
  const d=new Date(dateStr);
  return String(d.getDate()).padStart(2,'0')+'/'+String(d.getMonth()+1).padStart(2,'0')+'/'+d.getFullYear();
}

function setEvoMode(mode, el){
  document.querySelectorAll('.evo-btn').forEach(b=>b.classList.remove('active'));
  el.classList.add('active');
  currentEvoMode = mode;
  const dr = document.getElementById('evoDateRange');
  if(mode==='custom'){
    dr.style.display='flex';
    // pré-preenche com os últimos 30 dias (relativo a hoje)
    const today = new Date();
    const ago   = new Date(); ago.setDate(ago.getDate() - 30);
    document.getElementById('evoDateFrom').value = isoDateLocal(ago);
    document.getElementById('evoDateTo').value   = isoDateLocal(today);
    document.getElementById('evoDateTo').max     = isoDateLocal(today);
    applyCustomRange();
  } else {
    dr.style.display='none';
    buildEvoChart(mode);
  }
}

function applyCustomRange(){
  const from = document.getElementById('evoDateFrom').value;
  const to   = document.getElementById('evoDateTo').value;
  if(from && to) buildEvoChart('custom', from, to);
}

function initCharts() {
  // MAIN CHART — inicializa no modo da aba ativa no HTML (default: Hoje)
  const activeBtn = document.querySelector('.evo-btn.active');
  const initialMode = (activeBtn && activeBtn.dataset && activeBtn.dataset.mode) || 'today';
  currentEvoMode = initialMode;
  buildEvoChart(initialMode);

  // Resize responsivo
  window.addEventListener('resize',()=>{
    buildEvoChart(currentEvoMode,
      document.getElementById('evoDateFrom')?.value,
      document.getElementById('evoDateTo')?.value
    );
  });

  // METHOD CHART — "Por Categoria" (Abr vs Mai) — dinâmico, derivado de transactions
  buildMethodCategoryChart();

  // DONUT CHART — Distribuição de lucro por método — dinâmico
  buildDashboardPieChart();
}

// ── Gráficos do Dashboard que dependem das transações ──
let dashMethodChartInstance = null;
let dashPieChartInstance = null;

function getMonthlyByMethodFromTx(year, monthIdx) {
  // retorna { 'Surebet': {receita, despesas, lucro}, ... }
  const byMethod = {};
  METHODS_CATALOG.forEach(m => byMethod[m.name] = {receita:0, despesas:0, lucro:0});
  const targetYM = String(year) + '-' + String(monthIdx+1).padStart(2,'0');
  transactions.forEach(t => {
    if((t.date||'').slice(0,7) !== targetYM) return;
    if(!byMethod[t.method]) return;
    if(t.type === 'income')  byMethod[t.method].receita  += t.value;
    if(t.type === 'expense') byMethod[t.method].despesas += t.value;
    byMethod[t.method].lucro = byMethod[t.method].receita - byMethod[t.method].despesas;
  });
  return byMethod;
}

function buildMethodCategoryChart() {
  const canvas = document.getElementById('methodChart');
  if(!canvas) return;
  const ctxMC = canvas.getContext('2d');
  if(dashMethodChartInstance) dashMethodChartInstance.destroy();

  // Pega o mês atual e o anterior baseado em "hoje"
  const now = new Date();
  const yMaio = now.getFullYear(); const mMaio = now.getMonth();
  const dPrev = new Date(yMaio, mMaio - 1, 1);
  const yAbr  = dPrev.getFullYear(); const mAbr = dPrev.getMonth();

  const labels = METHODS_CATALOG.map(m => m.name);
  const dataPrev = METHODS_CATALOG.map(m => getMonthlyByMethodFromTx(yAbr, mAbr)[m.name].receita);
  const dataCurr = METHODS_CATALOG.map(m => getMonthlyByMethodFromTx(yMaio, mMaio)[m.name].receita);

  const prevName = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'][mAbr];
  const currName = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'][mMaio];

  // gradientes
  const prevGrad = ctxMC.createLinearGradient(0,0,0,300);
  prevGrad.addColorStop(0,'#64748b'); prevGrad.addColorStop(1,'#94a3b8');
  const currGrad = ctxMC.createLinearGradient(0,0,0,300);
  currGrad.addColorStop(0,'#10b981'); currGrad.addColorStop(1,'#34d399');

  dashMethodChartInstance = new Chart(ctxMC, {
    type:'bar',
    data:{
      labels,
      datasets:[
        {label:prevName, data:dataPrev, backgroundColor:prevGrad, borderRadius:{topLeft:6,topRight:6,bottomLeft:0,bottomRight:0}, borderSkipped:false, barPercentage:0.55, categoryPercentage:0.72, maxBarThickness:22},
        {label:currName, data:dataCurr, backgroundColor:currGrad, borderRadius:{topLeft:6,topRight:6,bottomLeft:0,bottomRight:0}, borderSkipped:false, barPercentage:0.55, categoryPercentage:0.72, maxBarThickness:22}
      ]
    },
    options:{
      responsive:true, maintainAspectRatio:false,
      layout:{padding:{top:8,right:6,left:0,bottom:0}},
      plugins:{
        legend:{display:false},
        tooltip:{
          backgroundColor:getChartColors().tooltipBg, borderColor:getChartColors().tooltipBorder, borderWidth:1, padding:12,
          titleColor:getChartColors().tooltipTitle, bodyColor:getChartColors().tooltipBody, displayColors:false,
          callbacks:{
            title(items){ return 'Método: '+items[0].label; },
            label(c){
              const ds = c.chart.data.datasets;
              const i = c.dataIndex;
              const prev = ds[0].data[i], curr = ds[1].data[i];
              const fmt = v => 'R$ '+v.toLocaleString('pt-BR');
              if(c.datasetIndex===0){
                const lines = [prevName+': '+fmt(prev), currName+': '+fmt(curr)];
                const variacao = prev === 0 ? (curr > 0 ? 100 : 0) : ((curr-prev)/prev)*100;
                const sign = variacao >= 0 ? '+' : '';
                lines.push('Variação: '+sign+variacao.toFixed(1)+'%');
                return lines;
              }
              return null;
            }
          }
        }
      },
      scales:{
        x:{grid:{display:false}, ticks:{color:getChartColors().text, font:{size:12}, maxRotation:0}},
        y:{grid:{color:getChartColors().grid, drawBorder:false}, ticks:{color:getChartColors().text, font:{size:12}, callback(v){ if(Math.abs(v)>=1000){ var n=v/1000; return (Math.abs(n-Math.round(n))<0.05?Math.round(n):n.toFixed(1))+'k'; } return v; }}}
      }
    }
  });
}

function buildDashboardPieChart() {
  const canvas = document.getElementById('pieChart');
  if(!canvas) return;
  if(dashPieChartInstance) dashPieChartInstance.destroy();
  // distribuição do lucro do mês atual por método
  const now = new Date();
  const stats = getMonthlyByMethodFromTx(now.getFullYear(), now.getMonth());
  // só métodos com lucro positivo entram no donut (donut não suporta negativos)
  const items = METHODS_CATALOG
    .map(m => ({name:m.name, color:m.color, lucro: Math.max(0, stats[m.name].lucro)}))
    .filter(x => x.lucro > 0);
  const labels = items.map(x => x.name);
  const data = items.map(x => x.lucro);
  const colors = items.map(x => x.color);

  dashPieChartInstance = new Chart(canvas.getContext('2d'), {
    type:'doughnut',
    data:{ labels, datasets:[{data, backgroundColor:colors, borderWidth:0, hoverOffset:10}] },
    options:{
      responsive:true, maintainAspectRatio:false, cutout:'68%', radius:'78%',
      layout:{ padding:{ top:4, bottom:4 } },
      plugins:{
        legend:{ display:true, position:'bottom', labels:{color:getChartColors().text, padding:10, font:{size:11}, boxWidth:10, boxHeight:10, usePointStyle:true, pointStyle:'circle'} },
        tooltip:{ backgroundColor:getChartColors().tooltipBg, borderColor:getChartColors().tooltipBorder, borderWidth:1, padding:12, titleColor:getChartColors().tooltipTitle, bodyColor:getChartColors().tooltipBody, callbacks:{label(c){const total=c.dataset.data.reduce((a,b)=>a+b,0); const pct=((c.raw/total)*100).toFixed(1); return ' R$'+c.raw.toLocaleString('pt-BR')+' ('+pct+'%)'}}}
      }
    }
  });
}

let reportLineChart=null, reportPieChart=null, reportRoiChart=null;

function getMonthAggregatesFromTx() {
  // Retorna mapa {YYYY-MM: {receita, despesas, lucro}}
  const map = {};
  transactions.forEach(t => {
    const ym = (t.date||'').slice(0,7);
    if(!ym) return;
    if(!map[ym]) map[ym] = {receita:0, despesas:0, lucro:0};
    if(t.type==='income')  map[ym].receita  += t.value;
    if(t.type==='expense') map[ym].despesas += t.value;
    map[ym].lucro = map[ym].receita - map[ym].despesas;
  });
  return map;
}

function buildReportCharts() {
  // 1) LINE CHART — Receita vs Despesas vs Lucro mês a mês
  const aggregates = getMonthAggregatesFromTx();
  const months = Object.keys(aggregates).sort();
  const monthNames = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
  const labels = months.map(ym => {
    const [y,m] = ym.split('-');
    return monthNames[parseInt(m,10)-1] + '/' + y.slice(-2);
  });
  const dataReceita  = months.map(ym => aggregates[ym].receita);
  const dataLucro    = months.map(ym => aggregates[ym].lucro);
  const dataDespesas = months.map(ym => aggregates[ym].despesas);

  const ctx = document.getElementById('reportChart');
  if(ctx) {
    const ctxRC = ctx.getContext('2d');
    if(reportLineChart) reportLineChart.destroy();
    const g1 = ctxRC.createLinearGradient(0,0,0,320);
    g1.addColorStop(0,'rgba(59,130,246,0.25)'); g1.addColorStop(1,'rgba(59,130,246,0)');
    reportLineChart = new Chart(ctxRC, {
      type:'line',
      data:{
        labels,
        datasets:[
          {label:'Receita',  data:dataReceita,  borderColor:'#3b82f6', backgroundColor:g1, fill:true,  borderWidth:2.5, tension:0.4, pointRadius:3, pointHoverRadius:5},
          {label:'Lucro',    data:dataLucro,    borderColor:'#10b981', fill:false, borderWidth:2,   tension:0.4, pointRadius:3, pointHoverRadius:5},
          {label:'Despesas', data:dataDespesas, borderColor:'#f43f5e', fill:false, borderWidth:2,   tension:0.4, pointRadius:3, pointHoverRadius:5, borderDash:[4,4]},
        ]
      },
      options:{
        ...chartDefaults, responsive:true, maintainAspectRatio:false,
        layout:{padding:{top:4,right:8,left:0,bottom:0}},
        interaction:{mode:'index', intersect:false},
        plugins:{legend:{display:true, position:'top', align:'end', labels:{color:getChartColors().text, font:{size:11}, boxWidth:12, boxHeight:12, usePointStyle:true, pointStyle:'circle', padding:14}}}
      }
    });
  }

  // 2) DONUT — Distribuição de DESPESAS por método (QUALQUER método, inclusive "Geral"/custom)
  const expenseByMethod = {};
  transactions.forEach(t => {
    if(t.type==='expense') {
      expenseByMethod[t.method] = (expenseByMethod[t.method] || 0) + t.value;
    }
  });
  const expPalette = ['#6366f1','#f43f5e','#f59e0b','#10b981','#8b5cf6','#22d3ee','#ec4899','#14b8a6','#64748b'];
  const expItems = Object.keys(expenseByMethod)
    .map((name, i) => {
      const m = METHODS_CATALOG.find(x => x.name === name);
      return { name, color: m ? m.color : expPalette[i % expPalette.length], value: expenseByMethod[name] };
    })
    .filter(x => x.value > 0)
    .sort((a,b) => b.value - a.value);

  const expCanvas = document.getElementById('expenseChart');
  if(expCanvas) {
    if(reportPieChart) { reportPieChart.destroy(); reportPieChart = null; }
    const expWrap = expCanvas.parentElement;
    let expEmpty = expWrap ? expWrap.querySelector('.chart-empty-msg') : null;
    if(expItems.length === 0) {
      // estado vazio amigável (em vez de gráfico em branco)
      expCanvas.style.display = 'none';
      if(expWrap && !expEmpty) {
        expEmpty = document.createElement('div');
        expEmpty.className = 'chart-empty-msg';
        expEmpty.style.cssText = 'text-align:center;color:var(--text-muted);font-size:13px;padding:20px;line-height:1.5';
        expEmpty.innerHTML = '<div style="font-size:32px;margin-bottom:8px">💸</div>Nenhuma despesa registrada ainda.<br>Lance transações do tipo <b>Despesa</b> para ver a distribuição.';
        expWrap.appendChild(expEmpty);
      }
    } else {
      expCanvas.style.display = '';
      if(expEmpty) expEmpty.remove();
      reportPieChart = new Chart(expCanvas.getContext('2d'), {
        type:'doughnut',
        data:{
          labels: expItems.map(x=>x.name),
          datasets:[{data: expItems.map(x=>x.value), backgroundColor: expItems.map(x=>x.color), borderWidth:0, hoverOffset:8}]
        },
        options:{
          responsive:true, maintainAspectRatio:true, cutout:'62%',
          plugins:{
            legend:{display:true, position:'bottom', labels:{color:getChartColors().text, font:{size:11}, boxWidth:10, boxHeight:10, usePointStyle:true, pointStyle:'circle', padding:8}},
            tooltip:{callbacks:{label(c){ const total=c.dataset.data.reduce((a,b)=>a+b,0); const pct=total?((c.raw/total)*100).toFixed(1):'0'; return ' R$ '+c.raw.toLocaleString('pt-BR')+' ('+pct+'%)';}}}
          }
        }
      });
    }
  }

  // 3) BAR — ROI por método
  const roiData = METHODS_CATALOG
    .map(m => ({name:m.name, roi: Math.round(getMethodStats(m.name).roi)}))
    .sort((a,b) => b.roi - a.roi);

  const roiCanvas = document.getElementById('roiChart');
  if(roiCanvas) {
    if(reportRoiChart) reportRoiChart.destroy();
    reportRoiChart = new Chart(roiCanvas.getContext('2d'), {
      type:'bar',
      data:{
        labels: roiData.map(x=>x.name),
        datasets:[{data: roiData.map(x=>x.roi), backgroundColor:d=>d.raw<0?'rgba(244,63,94,0.7)':'rgba(99,102,241,0.7)', borderRadius:6, maxBarThickness:38, categoryPercentage:0.75, barPercentage:0.85}]
      },
      options:{
        ...chartDefaults, responsive:true, maintainAspectRatio:false,
        layout:{padding:{top:24,right:6,left:0,bottom:0}},
        plugins:{legend:{display:false}, tooltip:{callbacks:{label:c=>' ROI: '+c.raw+'%'}}},
        scales:{
          x:{...(chartDefaults.scales&&chartDefaults.scales.x), ticks:{...((chartDefaults.scales&&chartDefaults.scales.x&&chartDefaults.scales.x.ticks)||{}), color:getChartColors().text}},
          y:{...(chartDefaults.scales&&chartDefaults.scales.y), ticks:{...((chartDefaults.scales&&chartDefaults.scales.y&&chartDefaults.scales.y.ticks)||{}), color:getChartColors().text, callback:v=>v+'%'}}
        }
      },
      plugins:[{
        id:'roiValueLabels',
        afterDatasetsDraw(chart){
          const {ctx} = chart;
          const meta = chart.getDatasetMeta(0);
          const isDark = !document.documentElement.classList.contains('light');
          ctx.save();
          ctx.font = '600 11px Inter, system-ui, sans-serif';
          ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
          meta.data.forEach((bar,i)=>{
            const v = chart.data.datasets[0].data[i];
            ctx.fillStyle = v < 0 ? '#f43f5e' : (isDark ? '#cbd5e1' : '#475569');
            const y = v >= 0 ? bar.y - 6 : bar.y + 14;
            ctx.fillText(v + '%', bar.x, y);
          });
          ctx.restore();
        }
      }]
    });
  }
}

function initReportCharts() { buildReportCharts(); }

// ══════════════════════════════════════════════
//  COMPARATIVO (mês atual vs anterior) — auto-sincronizado com transactions
//  Pode ser editado manualmente (vira override e ignora o auto)
// ══════════════════════════════════════════════
let useAutoCompare = true; // se true: ignora `methodsCompare` e calcula de transactions

let methodsCompare = [];
let compareChartInstance = null;

// Calcula receita por método nos 2 últimos meses presentes em transactions
function getAutoMethodsCompare() {
  const aggregates = getMonthAggregatesFromTx();
  const months = Object.keys(aggregates).sort();
  if(months.length < 1) return [];
  const currYM = months[months.length-1];
  const prevYM = months.length >= 2 ? months[months.length-2] : null;

  // receita por método em cada mês
  const byMethodMonth = {};
  METHODS_CATALOG.forEach(m => byMethodMonth[m.name] = {curr:0, prev:0});
  transactions.forEach(t => {
    if(t.type !== 'income') return;
    if(!byMethodMonth[t.method]) return;
    const ym = (t.date||'').slice(0,7);
    if(ym === currYM) byMethodMonth[t.method].curr += t.value;
    if(ym === prevYM) byMethodMonth[t.method].prev += t.value;
  });
  return METHODS_CATALOG.map((m, idx) => ({
    id: idx+1, name:m.name, icon:m.icon,
    abril: byMethodMonth[m.name].prev,
    maio:  byMethodMonth[m.name].curr
  }));
}

function getActiveMethodsCompare() {
  return useAutoCompare ? getAutoMethodsCompare() : methodsCompare;
}

function renderCompareSection() {
  renderCompareChart();
  renderCompareBars();
  renderCompareKPIs();
}

function renderCompareKPIs() {
  const aggregates = getMonthAggregatesFromTx();
  const months = Object.keys(aggregates).sort();
  if(months.length === 0) return;
  const currYM = months[months.length-1];
  const prevYM = months.length >= 2 ? months[months.length-2] : null;
  const curr = aggregates[currYM] || {receita:0, despesas:0, lucro:0};
  const prev = prevYM ? (aggregates[prevYM] || {receita:0, despesas:0, lucro:0}) : {receita:0, despesas:0, lucro:0};

  const monthNames = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
  const monthShort = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
  const [y1,m1] = currYM.split('-');
  const currLabel = monthNames[parseInt(m1,10)-1] + ' ' + y1;
  const currShort = monthShort[parseInt(m1,10)-1];
  let prevLabel = 'Sem dados anteriores', prevShort = '—';
  if(prevYM) {
    const [y2,m2] = prevYM.split('-');
    prevLabel = monthNames[parseInt(m2,10)-1] + ' ' + y2;
    prevShort = monthShort[parseInt(m2,10)-1];
  }

  // Atualiza subtítulo
  const sub = document.getElementById('compareSubtitle');
  if(sub) sub.textContent = prevLabel + ' vs ' + currLabel;

  // Helper de variação
  const pctChange = (prevVal, currVal) => {
    if(prevVal === 0) return currVal === 0 ? 0 : 100;
    return ((currVal - prevVal) / Math.abs(prevVal)) * 100;
  };
  const fmtDelta = (v) => (v >= 0 ? '+' : '-') + 'R$ ' + Math.abs(v).toLocaleString('pt-BR');
  const fmtMoney = (v) => 'R$ ' + Math.abs(v).toLocaleString('pt-BR');
  const arrow = (v) => v >= 0 ? '▲' : '▼';
  const sign = (v, suffix='%') => (v >= 0 ? '+' : '') + v.toFixed(1) + suffix;

  // Receita
  const dRec = curr.receita - prev.receita;
  const pctRec = pctChange(prev.receita, curr.receita);
  setTextSafe('cmpReceitaValue', fmtDelta(dRec));
  const cmpRecPct = document.getElementById('cmpReceitaPct');
  if(cmpRecPct) {
    cmpRecPct.textContent = `${arrow(dRec)} ${sign(pctRec)} vs ${prevShort}`;
    cmpRecPct.className = 'kpi-change ' + (dRec >= 0 ? 'up' : 'down');
  }
  setTextSafe('cmpReceitaSub', `${prevShort}: ${fmtMoney(prev.receita)} → ${currShort}: ${fmtMoney(curr.receita)}`);

  // Lucro
  const dLuc = curr.lucro - prev.lucro;
  const pctLuc = pctChange(prev.lucro, curr.lucro);
  setTextSafe('cmpLucroValue', fmtDelta(dLuc));
  const cmpLucPct = document.getElementById('cmpLucroPct');
  if(cmpLucPct) {
    cmpLucPct.textContent = `${arrow(dLuc)} ${sign(pctLuc)} vs ${prevShort}`;
    cmpLucPct.className = 'kpi-change ' + (dLuc >= 0 ? 'up' : 'down');
  }
  // Lucro pode ser negativo nos dois meses, então mostra com sinal
  const fmtSigned = v => (v < 0 ? '-' : '') + 'R$ ' + Math.abs(v).toLocaleString('pt-BR');
  setTextSafe('cmpLucroSub', `${prevShort}: ${fmtSigned(prev.lucro)} → ${currShort}: ${fmtSigned(curr.lucro)}`);

  // Despesas (note: redução é "boa", então "down" é verde aqui — mas mantemos a convenção visual existente)
  const dDes = curr.despesas - prev.despesas;
  const pctDes = pctChange(prev.despesas, curr.despesas);
  setTextSafe('cmpDespValue', fmtDelta(dDes));
  const cmpDesPct = document.getElementById('cmpDespPct');
  if(cmpDesPct) {
    cmpDesPct.textContent = `${arrow(dDes)} ${sign(pctDes)} vs ${prevShort}`;
    // Despesa: subir é ruim (vermelho/down), descer é bom (verde/up)
    cmpDesPct.className = 'kpi-change ' + (dDes <= 0 ? 'up' : 'down');
  }
  setTextSafe('cmpDespSub', `${prevShort}: ${fmtMoney(prev.despesas)} → ${currShort}: ${fmtMoney(curr.despesas)}`);

  // ROI = lucro/despesa
  const roiCurr = curr.despesas > 0 ? (curr.lucro / curr.despesas) * 100 : (curr.receita > 0 ? 100 : 0);
  const roiPrev = prev.despesas > 0 ? (prev.lucro / prev.despesas) * 100 : (prev.receita > 0 ? 100 : 0);
  const dRoi = roiCurr - roiPrev; // diferença em pontos percentuais (pp)
  const pctRoiChange = roiPrev !== 0 ? ((roiCurr - roiPrev) / Math.abs(roiPrev)) * 100 : 0;
  // formata com até 1 casa decimal, sem o ".0" quando é número redondo
  const num1 = n => { const r = Math.round(n*10)/10; return r % 1 === 0 ? r.toLocaleString('pt-BR') : r.toLocaleString('pt-BR',{minimumFractionDigits:1,maximumFractionDigits:1}); };
  const roiValueTxt = (dRoi >= 0 ? '+' : '') + num1(dRoi) + ' pp';
  setTextSafe('cmpRoiValue', roiValueTxt);
  const cmpRoiPct = document.getElementById('cmpRoiPct');
  if(cmpRoiPct) {
    cmpRoiPct.textContent = `${arrow(dRoi)} ${sign(pctRoiChange)} ${dRoi >= 0 ? 'melhora' : 'queda'}`;
    cmpRoiPct.className = 'kpi-change ' + (dRoi >= 0 ? 'up' : 'down');
  }
  setTextSafe('cmpRoiSub', `${prevShort}: ${num1(roiPrev)}% → ${currShort}: ${num1(roiCurr)}%`);

  // Atualiza o banner de modo (auto/manual)
  const banner = document.getElementById('compareAutoBanner');
  if(banner) {
    if(useAutoCompare) {
      banner.style.display = 'flex';
      banner.innerHTML = '🔄 <span><strong>Modo automático</strong> — dados calculados das suas transações reais. <a onclick="resetCompareToAuto()" style="color:var(--accent);cursor:pointer;text-decoration:underline">Atualizar</a></span>';
    } else {
      banner.style.display = 'flex';
      banner.innerHTML = '✏️ <span><strong>Modo manual</strong> — valores foram editados. <a onclick="resetCompareToAuto()" style="color:var(--accent);cursor:pointer;text-decoration:underline">Voltar para automático</a></span>';
    }
  }
}

function resetCompareToAuto() {
  useAutoCompare = true;
  try { localStorage.setItem('bancapro-compare-auto', '1'); } catch(e) {}
  renderCompareSection();
  showToast('Modo automático ativado — comparativo agora segue suas transações.','success');
}

function renderCompareChart() {
  const canvas = document.getElementById('compareChart');
  if(!canvas) return;
  if(compareChartInstance) compareChartInstance.destroy();
  const active = getActiveMethodsCompare();
  // Nomes dinâmicos baseados nos meses reais
  const aggregates = getMonthAggregatesFromTx();
  const months = Object.keys(aggregates).sort();
  const monthNames = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
  let labelPrev = 'Mês anterior', labelCurr = 'Mês atual';
  if(useAutoCompare && months.length >= 1) {
    const ymCurr = months[months.length-1];
    const [y1,m1] = ymCurr.split('-');
    labelCurr = monthNames[parseInt(m1,10)-1] + ' ' + y1;
    if(months.length >= 2) {
      const ymPrev = months[months.length-2];
      const [y2,m2] = ymPrev.split('-');
      labelPrev = monthNames[parseInt(m2,10)-1] + ' ' + y2;
    }
  } else if(!useAutoCompare) {
    labelPrev = 'Abril 2026'; labelCurr = 'Maio 2026';
  }
  const labels = active.map(m => m.name);
  const abrData = active.map(m => m.abril);
  const maiData = active.map(m => m.maio);
  compareChartInstance = new Chart(canvas.getContext('2d'), {
    type:'bar',
    data:{
      labels,
      datasets:[
        {label:labelPrev, data:abrData, backgroundColor:'rgba(99,102,241,0.5)', borderRadius:6, maxBarThickness:34, categoryPercentage:0.7, barPercentage:0.8},
        {label:labelCurr, data:maiData, backgroundColor:d=>d.raw<0?'rgba(244,63,94,0.5)':'rgba(16,185,129,0.5)', borderRadius:6, maxBarThickness:34, categoryPercentage:0.7, barPercentage:0.8}
      ]
    },
    options:{
      ...chartDefaults,
      responsive:true,
      maintainAspectRatio:false,
      layout:{padding:{top:4,right:6,left:0,bottom:0}},
      plugins:{legend:{display:true,position:'top',align:'center',labels:{color:getChartColors().text,font:{size:11},boxWidth:12,boxHeight:12,usePointStyle:true,pointStyle:'circle',padding:14}}}
    }
  });
}

function renderCompareBars() {
  const list = document.getElementById('compareBarsList');
  if(!list) return;
  const active = getActiveMethodsCompare();
  if(active.length === 0) {
    list.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-muted);font-size:13px">Sem transações para comparar. Adicione transações ou edite manualmente.</div>';
    return;
  }
  const sorted = [...active].sort((a,b) => {
    const va = a.abril === 0 ? 0 : ((a.maio - a.abril)/a.abril);
    const vb = b.abril === 0 ? 0 : ((b.maio - b.abril)/b.abril);
    return vb - va;
  });
  const maxVal = Math.max(...active.flatMap(m => [Math.abs(m.abril), Math.abs(m.maio)])) || 1;
  const fmt = v => v.toLocaleString('pt-BR');

  list.innerHTML = sorted.map(m => {
    const grew = m.abril === 0 ? 0 : ((m.maio - m.abril) / m.abril) * 100;
    const widthAbr = (Math.abs(m.abril)/maxVal)*100;
    const widthMai = (Math.abs(m.maio)/maxVal)*100;
    let trendTxt, trendColor;
    if(m.maio < 0) { trendTxt = '▼ Queda'; trendColor = 'var(--red)'; }
    else if(m.abril === 0 && m.maio > 0) { trendTxt = 'novo'; trendColor = 'var(--green)'; }
    else if(grew >= 0) { trendTxt = '+'+grew.toFixed(1)+'%'; trendColor = 'var(--green)'; }
    else { trendTxt = grew.toFixed(1)+'%'; trendColor = 'var(--red)'; }
    const abrStr = (m.abril < 0 ? '-R$' : 'R$') + fmt(Math.abs(m.abril));
    const maiStr = (m.maio  < 0 ? '-R$' : 'R$') + fmt(Math.abs(m.maio));
    const barAColor = m.abril < 0 ? 'var(--red)' : 'var(--accent)';
    const barBColor = m.maio  < 0 ? 'var(--red)' : 'var(--green)';
    return `
      <div class="compare-bar-wrap">
        <div class="compare-label">
          <span>${escapeHtml(m.icon)} ${escapeHtml(m.name)}</span>
          <span>Abr: ${abrStr} → Mai: ${maiStr} <span style="color:${trendColor}">${trendTxt}</span></span>
        </div>
        <div class="compare-bar"${m.maio<0?' style="background:rgba(244,63,94,0.1)"':''}>
          <div class="compare-bar-a" style="width:${widthAbr}%;background:${barAColor}"></div>
          <div class="compare-bar-b" style="width:${widthMai}%;background:${barBColor}"></div>
        </div>
      </div>
    `;
  }).join('');
}

// ── MODAL DE EDIÇÃO ──
function openMethodsCompareModal() {
  renderMethodsCompareEditor();
  document.getElementById('methodsCompareModal').classList.add('open');
}
function closeMethodsCompareModal() {
  document.getElementById('methodsCompareModal').classList.remove('open');
}
function renderMethodsCompareEditor() {
  const list = document.getElementById('methodsCompareList');
  const source = getActiveMethodsCompare();
  list.innerHTML = source.map(m => `
    <div class="method-edit-row" data-id="${m.id}" style="display:grid;grid-template-columns:50px 1fr 120px 120px 36px;gap:8px;align-items:center;background:var(--bg-secondary);border:1px solid var(--glass-border);border-radius:8px;padding:8px">
      <input class="form-input" type="text" value="${escapeHtml(m.icon)}" maxlength="4" data-field="icon" style="padding:8px;text-align:center;font-size:16px"/>
      <input class="form-input" type="text" value="${escapeHtml(m.name)}" data-field="name" placeholder="Nome do método" style="padding:8px"/>
      <input class="form-input" type="number" value="${m.abril}" data-field="abril" placeholder="Mês anterior" step="any" style="padding:8px"/>
      <input class="form-input" type="number" value="${m.maio}" data-field="maio" placeholder="Mês atual" step="any" style="padding:8px"/>
      <button class="goal-action-btn danger" onclick="removeMethodCompareRow(this)" title="Remover" aria-label="Remover">🗑️</button>
    </div>
  `).join('');
}
function removeMethodCompareRow(btn) {
  btn.closest('.method-edit-row').remove();
}
function addMethodCompare() {
  const list = document.getElementById('methodsCompareList');
  const tempId = 'new-' + Date.now();
  list.insertAdjacentHTML('beforeend', `
    <div class="method-edit-row" data-id="${tempId}" style="display:grid;grid-template-columns:50px 1fr 120px 120px 36px;gap:8px;align-items:center;background:var(--bg-secondary);border:1px solid var(--glass-border);border-radius:8px;padding:8px">
      <input class="form-input" type="text" value="🎯" maxlength="4" data-field="icon" style="padding:8px;text-align:center;font-size:16px"/>
      <input class="form-input" type="text" value="" data-field="name" placeholder="Nome do método" style="padding:8px"/>
      <input class="form-input" type="number" value="0" data-field="abril" placeholder="Abril" step="any" style="padding:8px"/>
      <input class="form-input" type="number" value="0" data-field="maio" placeholder="Maio" step="any" style="padding:8px"/>
      <button class="goal-action-btn danger" onclick="removeMethodCompareRow(this)" title="Remover" aria-label="Remover">🗑️</button>
    </div>
  `);
  list.scrollTop = list.scrollHeight;
  list.lastElementChild.querySelector('[data-field="name"]').focus();
}
async function saveMethodsCompare() {
  const rows = document.querySelectorAll('#methodsCompareList .method-edit-row');
  const updated = [];
  let invalid = false;
  rows.forEach(row => {
    const icon  = (row.querySelector('[data-field="icon"]').value || '🎯').trim() || '🎯';
    const name  = row.querySelector('[data-field="name"]').value.trim();
    const abril = parseFloat(row.querySelector('[data-field="abril"]').value) || 0;
    const maio  = parseFloat(row.querySelector('[data-field="maio"]').value) || 0;
    if(!name) { invalid = true; return; }
    const existing = String(row.dataset.id).startsWith('new-') ? null : methodsCompare.find(m => m.id === parseInt(row.dataset.id));
    updated.push({
      id: existing ? existing.id : Date.now() + updated.length,
      name, icon, abril, maio
    });
  });
  if(invalid) { showToast('Cada método precisa de um nome!','error'); return; }
  if(updated.length === 0) {
    const ok = await customConfirm('Você está removendo TODOS os métodos. Confirma?', 'Remover todos os métodos', 'Remover tudo');
    if(!ok) return;
  }
  methodsCompare = updated;
  useAutoCompare = false; // edição manual → vira override
  try { localStorage.setItem('bancapro-compare-auto', '0'); } catch(e) {}
  closeMethodsCompareModal();
  renderCompareSection();
  persistState();
  showToast('Comparativo atualizado (modo manual).', 'success');
}

function initCompareChart() {
  // Lê preferência salva
  try {
    const flag = localStorage.getItem('bancapro-compare-auto');
    if(flag === '0') useAutoCompare = false;
    else if(flag === '1') useAutoCompare = true;
  } catch(e) {}
  renderCompareSection();
}

let methodEvolutionInstance = null;

function buildMethodEvolutionDataset() {
  // Constrói lucro mensal por método nos últimos 6 meses
  const monthShort = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
  const today = new Date();
  const labels = [];
  const monthsYM = [];
  for(let i = 5; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
    labels.push(monthShort[d.getMonth()]);
    monthsYM.push(d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0'));
  }

  // Para cada método do catálogo, calcular lucro de cada mês
  const datasets = METHODS_CATALOG.map(m => {
    const data = monthsYM.map(ym => {
      let receita = 0, despesas = 0;
      transactions.forEach(t => {
        if(t.method === m.name && (t.date || '').slice(0,7) === ym) {
          if(t.type === 'income') receita += t.value;
          if(t.type === 'expense') despesas += t.value;
        }
      });
      return receita - despesas;
    });
    return {
      label: m.name,
      data,
      borderColor: m.color,
      backgroundColor: m.color,
      pointBackgroundColor: m.color,
      fill: false,
      borderWidth: 2.5,
      tension: 0.4,
      pointRadius: 4.5,
      pointHoverRadius: 6.5,
    };
  });
  return { labels, datasets };
}

function initMethodEvolution() {
  const canvas = document.getElementById('methodEvolutionChart');
  if(!canvas) return;
  if(methodEvolutionInstance) methodEvolutionInstance.destroy();

  const {labels, datasets} = buildMethodEvolutionDataset();

  // Detectar se tem alguma data — caso vazio, mostrar mensagem amigável depois
  const hasData = datasets.some(ds => ds.data.some(v => v !== 0));

  methodEvolutionInstance = new Chart(canvas.getContext('2d'), {
    type:'line',
    data:{ labels, datasets },
    options:{
      responsive:true, maintainAspectRatio:false,
      interaction:{mode:'index',intersect:false},
      layout:{padding:{top:6,right:10,left:0,bottom:0}},
      plugins:{
        legend:{
          display:true, position:'top', align:'end',
          labels:{color:getChartColors().text, font:{size:12}, padding:14, boxWidth:11, boxHeight:11, usePointStyle:true, pointStyle:'circle'}
        },
        tooltip:{
          backgroundColor:getChartColors().tooltipBg, borderColor:getChartColors().tooltipBorder, borderWidth:1, padding:12,
          titleColor:getChartColors().tooltipTitle, bodyColor:getChartColors().tooltipBody,
          callbacks:{ label(c){ return c.dataset.label + ': ' + (c.raw < 0 ? '-' : '') + 'R$ ' + Math.abs(c.raw).toLocaleString('pt-BR'); } }
        }
      },
      scales:{
        x:{grid:{color:getChartColors().grid, drawBorder:false}, ticks:{color:getChartColors().text, font:{size:11}}},
        y:{grid:{color:getChartColors().grid, drawBorder:false}, ticks:{color:getChartColors().text, font:{size:11}, callback(v){return v>=1000?(v/1000).toFixed(1)+'k':(v<=-1000?(v/1000).toFixed(1)+'k':v)}}}
      }
    }
  });

  // Se não houver dados, mostrar overlay informativo
  const wrap = canvas.parentElement;
  let overlay = wrap.querySelector('.evo-empty-overlay');
  if(!hasData) {
    if(!overlay) {
      overlay = document.createElement('div');
      overlay.className = 'evo-empty-overlay';
      overlay.style.cssText = 'position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;background:rgba(15,23,42,0.6);backdrop-filter:blur(2px);border-radius:14px;pointer-events:none;text-align:center;padding:20px';
      overlay.innerHTML = '<div style="font-size:36px;margin-bottom:8px">📊</div><div style="font-size:14px;font-weight:600;color:var(--text-secondary)">Sem dados nos últimos 6 meses</div><div style="font-size:12px;color:var(--text-muted);margin-top:4px">Adicione transações para ver a evolução por método</div>';
      wrap.style.position = 'relative';
      wrap.appendChild(overlay);
    }
  } else if(overlay) {
    overlay.remove();
  }
}

// ══════════════════════════════════════════════
//  LIVE UPDATE
// ══════════════════════════════════════════════
setInterval(() => {
  const methods = ['Surebet','Delay','Freebet','Duplo Green'];
  const m = methods[Math.floor(Math.random()*methods.length)];
  const v = (Math.random()*200+50).toFixed(0);
  // silently update
}, 30000);

// ══════════════════════════════════════════════
//  MOBILE MENU BUTTON VISIBILITY
// ══════════════════════════════════════════════
const mq = window.matchMedia('(max-width:768px)');
function checkMQ(e) {
  document.querySelector('.menu-btn').style.display = e.matches ? 'flex' : 'none';
}
mq.addEventListener('change', checkMQ);
checkMQ(mq);

// Carrega logo/favicon salvos antes mesmo do login (pra atualizar a tela de login)
loadStoredBranding();
loadPlatformSettings();
// Deixa o ícone do botão de tema na topbar coerente com o tema atual
updateThemeBtn();

// ══════════════════════════════════════════════
//  MONITORAMENTO DE ERROS (registra no Supabase)
// ══════════════════════════════════════════════
let _errCount = 0;
const _errSeen = new Set();
function logClientError(message, source, stack) {
  try {
    if (_errCount >= 15) return;                 // limite por sessão (evita flood)
    const key = String(message || '').slice(0, 140);
    if (_errSeen.has(key)) return;
    _errSeen.add(key); _errCount++;
    const sb = (typeof getSb === 'function') ? getSb() : null;
    if (!sb) return;                              // só registra em modo nuvem
    let email = '';
    try { email = (currentAuthUser && currentAuthUser.email) || localStorage.getItem('bancapro-user-email') || ''; } catch(e){}
    sb.from('error_logs').insert({
      email: email || null,
      message: String(message || '').slice(0, 500),
      source: String(source || location.href).slice(0, 300),
      stack: stack ? String(stack).slice(0, 2000) : null,
      user_agent: (navigator.userAgent || '').slice(0, 300)
    }).then(function(){}, function(){});
  } catch(e) {}
}
window.addEventListener('error', function(e) {
  logClientError(e.message, (e.filename || '') + ':' + (e.lineno || ''), e.error && e.error.stack);
});
window.addEventListener('unhandledrejection', function(e) {
  const r = e.reason;
  logClientError('Promise: ' + (r && r.message ? r.message : r), location.href, r && r.stack);
});

// ══════════════════════════════════════════════
//  ACESSIBILIDADE
// ══════════════════════════════════════════════
// ESC fecha modais e painel de notificações
document.addEventListener('keydown', e => {
  if(e.key === 'Escape' || e.key === 'Esc') {
    const openModal = document.querySelector('.modal-overlay.open');
    if(openModal) { openModal.classList.remove('open'); return; }
    if(notifOpen) { notifOpen = false; document.getElementById('notifPanel').classList.remove('open'); return; }
    const sidebar = document.getElementById('sidebar');
    if(sidebar && sidebar.classList.contains('open')) closeSidebar();
  }
  // Focus trap: Tab dentro do modal cicla
  if(e.key === 'Tab') {
    const openModal = document.querySelector('.modal-overlay.open');
    if(!openModal) return;
    const focusable = openModal.querySelectorAll('button, [href], input:not([type="hidden"]), select, textarea, [tabindex]:not([tabindex="-1"])');
    if(focusable.length === 0) return;
    const first = focusable[0], last = focusable[focusable.length-1];
    if(e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if(!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
});

// Click no backdrop do modal também fecha
document.querySelectorAll('.modal-overlay').forEach(overlay => {
  overlay.addEventListener('click', e => {
    if(e.target === overlay) overlay.classList.remove('open');
  });
});

// ═══════════════════════════════════════════════
//  CALCULADORA (Surebet / Stake / Proteção de duplo)
// ═══════════════════════════════════════════════
function calcMoney(v){ if(!isFinite(v)) v=0; return 'R$ ' + v.toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2}); }
function calcPct(v){ if(!isFinite(v)) v=0; return v.toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2}) + '%'; }
function calcNum(id){ var el=document.getElementById(id); if(!el) return 0; var n=parseFloat(String(el.value||'').replace(',','.')); return isFinite(n)?n:0; }

var _calcReady = false;
function calcInit(){
  if(_calcReady){ sbCompute(); calcStake(); calcProtecao(); return; }
  _calcReady = true;
  var sel=document.getElementById('sbCount');
  if(sel){ var h=''; for(var i=2;i<=8;i++){ h+='<option value="'+i+'">'+i+' casas</option>'; } sel.innerHTML=h; }
  if(sbTryLoadFromUrl()){ if(sel) sel.value=String(SB.n); sbRenderCasas(); sbCompute(); }
  else sbSetCount(2);
  calcStake();
  if(PD.length===0){ PD.push(pdDefaultBet()); PD.push(pdDefaultBet()); }
  pdRenderBets();
  calcProtecao();
}
function switchCalc(which, el){
  document.querySelectorAll('.calc-panel').forEach(function(p){ p.classList.remove('active'); });
  var panel=document.getElementById('calc-'+which); if(panel) panel.classList.add('active');
  if(el){ el.parentElement.querySelectorAll('.period-tab').forEach(function(t){ t.classList.remove('active'); }); el.classList.add('active'); }
}

// ── SUREBET ──
var SB = { n:2, fixed:0, casas:[] };
function sbDefaultCasa(i){ return { nome:'Casa '+(i+1), tipo:'back', odd:2, stake:100, comissao:0, aumento:0, freebet:false, cashback:0, recompensa:0 }; }
function sbSetCount(n){
  n = parseInt(n,10)||2;
  SB.n = n;
  while(SB.casas.length < n) SB.casas.push(sbDefaultCasa(SB.casas.length));
  SB.casas = SB.casas.slice(0,n);
  if(SB.fixed >= n) SB.fixed = 0;
  var sel=document.getElementById('sbCount'); if(sel) sel.value=String(n);
  sbRenderCasas();
  sbCompute();
}
function sbRenderCasas(){
  var wrap=document.getElementById('sbCasas'); if(!wrap) return;
  wrap.innerHTML = SB.casas.map(function(c,i){
    var isLay = c.tipo==='lay';
    var stakeLabel = isLay ? 'Stake da Lay (R$)' : 'Stake (R$)';
    return '<div class="sb-casa">'
      + '<div class="sb-casa-head"><span class="sb-casa-title">Casa '+(i+1)+'</span></div>'
      + '<div class="form-group"><label class="form-label">Nome</label><input class="form-input" type="text" value="'+escapeHtml(c.nome)+'" oninput="sbField('+i+',\'nome\',this.value)"></div>'
      + '<div class="sb-tipo">'
      +   '<button class="sb-tipo-btn'+(!isLay?' active-back':'')+'" onclick="sbSetTipo('+i+',\'back\')">Back</button>'
      +   '<button class="sb-tipo-btn'+(isLay?' active-lay':'')+'" onclick="sbSetTipo('+i+',\'lay\')">Lay</button>'
      + '</div>'
      + '<div class="form-group"><label class="form-label">Odd</label><input class="form-input" type="number" min="1" step="0.01" value="'+c.odd+'" oninput="sbField('+i+',\'odd\',this.value)"><div class="sb-real" id="sbReal'+i+'">Real: —</div></div>'
      + '<div class="form-group"><label class="form-label">'+stakeLabel+'</label><input class="form-input" id="sbStake'+i+'" type="number" min="0" step="0.01" value="'+c.stake+'" oninput="sbStakeInput('+i+',this.value)"></div>'
      + '<div class="sb-resp" id="sbResp'+i+'" style="'+(isLay?'':'display:none')+'">Responsabilidade <b id="sbRespVal'+i+'">R$ 0,00</b></div>'
      + '<div class="sb-row">'
      +   '<div class="form-group"><label class="form-label">Comissão %</label><input class="form-input" type="number" min="0" step="0.1" value="'+c.comissao+'" oninput="sbField('+i+',\'comissao\',this.value)"></div>'
      +   '<div class="form-group"><label class="form-label">Aumento %</label><input class="form-input" type="number" min="0" step="0.1" value="'+c.aumento+'" oninput="sbField('+i+',\'aumento\',this.value)"></div>'
      + '</div>'
      + '<div class="sb-row">'
      +   '<div class="form-group"><label class="form-label">Cashback (R$) <span class="sb-hint-q" title="Valor devolvido se esta aposta perder">se perder</span></label><input class="form-input" type="number" min="0" step="0.01" value="'+c.cashback+'" oninput="sbField('+i+',\'cashback\',this.value)"></div>'
      +   '<div class="form-group"><label class="form-label">Recompensa (R$) <span class="sb-hint-q" title="Bônus/recompensa fixo que você ganha por apostar aqui">bônus fixo</span></label><input class="form-input" type="number" min="0" step="0.01" value="'+c.recompensa+'" oninput="sbField('+i+',\'recompensa\',this.value)"></div>'
      + '</div>'
      + (isLay ? '' : '<label class="sb-freebet"><input type="checkbox" '+(c.freebet?'checked':'')+' onchange="sbField('+i+',\'freebet\',this.checked)"> Freebet (stake não retorna)</label>')
      + '<div class="sb-result">'
      +   '<div class="sb-result-line"><span class="lbl">📈 Lucro</span><span class="val" id="sbCasaLucro'+i+'">R$ 0,00</span></div>'
      +   '<div class="sb-result-line"><span class="lbl">📊 ROI</span><span class="val" id="sbCasaRoi'+i+'">0,00%</span></div>'
      + '</div>'
      + '<button class="sb-fixar'+(SB.fixed===i?' active':'')+'" id="sbFixar'+i+'" onclick="sbFixar('+i+')">'+(SB.fixed===i?'✓ Stake fixa':'Fixar stake')+'</button>'
    + '</div>';
  }).join('');
}
function sbSetTipo(i, tipo){ SB.casas[i].tipo = tipo; if(tipo==='lay') SB.casas[i].freebet=false; sbRenderCasas(); sbCompute(); }
function sbField(i, key, val){
  if(key==='nome') SB.casas[i].nome=val;
  else if(key==='freebet') SB.casas[i].freebet=!!val;
  else SB.casas[i][key]=parseFloat(String(val).replace(',','.'))||0;
  sbCompute();
}
function sbStakeInput(i, val){
  SB.casas[i].stake=parseFloat(String(val).replace(',','.'))||0;
  SB.fixed=i;
  sbUpdateFixarButtons();
  sbCompute();
}
function sbFixar(i){ SB.fixed=i; sbUpdateFixarButtons(); sbCompute(); }
function sbUpdateFixarButtons(){
  SB.casas.forEach(function(c,i){
    var b=document.getElementById('sbFixar'+i);
    if(b){ b.classList.toggle('active', SB.fixed===i); b.textContent = SB.fixed===i ? '✓ Stake fixa' : 'Fixar stake'; }
  });
}
function sbBoosted(c){ return (c.odd||0) * (1 + (c.aumento||0)/100); }
// Multiplicador sobre o DINHEIRO EM RISCO (back: stake; lay: responsabilidade)
function sbEffOdd(c){
  var boosted = sbBoosted(c);
  var cm = 1 - (c.comissao||0)/100;
  if(c.tipo==='lay') return boosted>1 ? (1 + cm/(boosted-1)) : 0;     // lay convertido em "back equivalente"
  var win = (boosted - 1) * cm;
  return c.freebet ? win : (1 + win);                                 // back (freebet: stake não retorna)
}
// Converte o valor digitado (back: stake; lay: stake da lay) em dinheiro em risco
function sbRiskFromInput(c){ return c.tipo==='lay' ? (c.stake||0) * Math.max(0, sbBoosted(c)-1) : (c.stake||0); }
// Converte dinheiro em risco de volta no valor exibido no campo
function sbInputFromRisk(c, risk){ if(c.tipo==='lay'){ var d=sbBoosted(c)-1; return d>0 ? risk/d : 0; } return risk; }
function sbCompute(){
  var n=SB.n; if(n<1) return;
  var fixed=SB.casas[SB.fixed]||SB.casas[0];
  // C = lucro-base (retorno líquido descontando o cashback da casa fixa); equaliza o lucro entre os resultados
  var C = sbRiskFromInput(fixed)*sbEffOdd(fixed) - (fixed.cashback||0);
  var CBtotal=0, RECtotal=0, total=0;
  SB.casas.forEach(function(c){ CBtotal += (c.cashback||0); RECtotal += (c.recompensa||0); });
  SB.casas.forEach(function(c,i){
    var m=sbEffOdd(c);
    var Rk = C + (c.cashback||0);               // retorno bruto alvo desta casa
    var risk = (i===SB.fixed) ? sbRiskFromInput(c) : (m>0 ? Rk/m : 0);
    if(i!==SB.fixed){
      c.stake = sbInputFromRisk(c, risk);
      var inp=document.getElementById('sbStake'+i);
      if(inp && document.activeElement!==inp) inp.value=(isFinite(c.stake)?c.stake:0).toFixed(2);
    }
    if(!c.freebet) total += risk;
    // atualiza badge "Real" e responsabilidade
    setTextSafe('sbReal'+i, 'Real: ' + (isFinite(sbBoosted(c))?sbBoosted(c):0).toFixed(3).replace('.',','));
    var resp=document.getElementById('sbResp'+i);
    if(resp){
      if(c.tipo==='lay'){ resp.style.display=''; setTextSafe('sbRespVal'+i, calcMoney(sbRiskFromInput(c))); }
      else resp.style.display='none';
    }
  });
  var lucro = C + CBtotal + RECtotal - total;   // lucro garantido (igual em qualquer resultado)
  var roi=total>0 ? (lucro/total*100) : 0;
  var col = lucro>=0?'var(--green)':'var(--red)';
  SB.casas.forEach(function(c,i){
    var le=document.getElementById('sbCasaLucro'+i), re=document.getElementById('sbCasaRoi'+i);
    if(le){ le.textContent=calcMoney(lucro); le.style.color=col; }
    if(re){ re.textContent=calcPct(roi); re.style.color=col; }
  });
  setTextSafe('sbTotal', calcMoney(total));
  setTextSafe('sbLucro', calcMoney(lucro));
  setTextSafe('sbRoi', calcPct(roi));
  var sl=document.getElementById('sbLucro'), sr=document.getElementById('sbRoi');
  if(sl) sl.style.color=col; if(sr) sr.style.color=col;
  var hint=document.getElementById('sbHint');
  if(hint){
    if(lucro>0.005) hint.innerHTML='<span style="color:var(--green)">✅ Surebet! Lucro garantido em qualquer resultado.</span>';
    else if(lucro<-0.005) hint.innerHTML='<span style="color:var(--red)">⚠️ Não é surebet: daria prejuízo. Ajuste as odds.</span>';
    else hint.innerHTML='<span style="color:var(--text-muted)">Empata (break-even): sem lucro nem prejuízo.</span>';
  }
}

// Lucro garantido atual (mesma conta do resumo)
function sbCurrentProfit(){
  var fixed=SB.casas[SB.fixed]||SB.casas[0];
  var C = sbRiskFromInput(fixed)*sbEffOdd(fixed) - (fixed.cashback||0);
  var CBtotal=0, RECtotal=0, total=0;
  SB.casas.forEach(function(c){ CBtotal+=(c.cashback||0); RECtotal+=(c.recompensa||0); });
  SB.casas.forEach(function(c,i){
    var m=sbEffOdd(c); var Rk=C+(c.cashback||0);
    var risk=(i===SB.fixed)?sbRiskFromInput(c):(m>0?Rk/m:0);
    if(!c.freebet) total+=risk;
  });
  return { lucro:(C+CBtotal+RECtotal-total), total:total };
}
function sbState(){ return { n:SB.n, fixed:SB.fixed, casas:SB.casas }; }
function sbCopyLink(){
  try {
    var data = btoa(unescape(encodeURIComponent(JSON.stringify(sbState()))));
    var link = location.origin + location.pathname + '?sb=' + data;
    if(navigator.clipboard){ navigator.clipboard.writeText(link).then(function(){ showToast('🔗 Link copiado!','success'); }, function(){ showToast('Copie: '+link,'info'); }); }
    else showToast('Copie: '+link,'info');
  } catch(e){ showToast('Não foi possível gerar o link.','error'); }
}
function sbCopyTexto(){
  var r=sbCurrentProfit();
  var linhas = SB.casas.map(function(c,i){
    var tipo = c.tipo==='lay'?'Lay':'Back';
    var valor = c.tipo==='lay' ? ('Stake lay '+calcMoney(c.stake)+' (resp. '+calcMoney(sbRiskFromInput(c))+')') : ('Stake '+calcMoney(c.stake));
    return (i+1)+') '+c.nome+' — '+tipo+' @ '+sbBoosted(c).toFixed(3).replace('.',',')+' · '+valor;
  });
  var txt = '📊 Surebet\n' + linhas.join('\n')
    + '\nStake total: '+calcMoney(r.total)
    + '\nLucro garantido: '+calcMoney(r.lucro)+' ('+calcPct(r.total>0?r.lucro/r.total*100:0)+')';
  if(navigator.clipboard){ navigator.clipboard.writeText(txt).then(function(){ showToast('📄 Texto copiado!','success'); }, function(){ showToast('Não foi possível copiar.','error'); }); }
  else showToast('Copie manualmente.','info');
}
function sbTryLoadFromUrl(){
  try {
    var p=new URLSearchParams(location.search).get('sb'); if(!p) return false;
    var obj=JSON.parse(decodeURIComponent(escape(atob(p))));
    if(obj && obj.casas && obj.casas.length){ SB.n=obj.n||obj.casas.length; SB.fixed=obj.fixed||0; SB.casas=obj.casas; return true; }
  } catch(e){}
  return false;
}

// ── STAKE (odd aumentada / Kelly fracionado) ──
function calcStake(){
  var banca=calcNum('stkBanca'), oddN=calcNum('stkOddN'), oddA=calcNum('stkOddA');
  var aumento = (oddN>0) ? ((oddA-oddN)/oddN*100) : 0;
  setTextSafe('stkAumento', calcPct(aumento));
  var sub=document.getElementById('stkAumentoSub');
  if(sub) sub.textContent = (oddN>0&&oddA>0) ? ('De '+oddN.toFixed(2)+' para '+oddA.toFixed(2)) : '—';
  var p = oddN>1 ? 1/oddN : 0;
  var b = oddA-1;
  var f = b>0 ? (b*p-(1-p))/b : 0;
  var frac = Math.max(0, f/10);
  var stake = banca*frac;
  setTextSafe('stkStake', calcMoney(stake));
  setTextSafe('stkPct', calcPct(frac*100));
  var stEl=document.getElementById('stkStake'); if(stEl) stEl.style.color = stake>0?'var(--green)':'var(--text-muted)';
}

// ── PROTEÇÃO DE DUPLO (hedge / encerramento) ──
var PD = [];
function pdDefaultBet(){ return {casa:'', valor:0, odd:1.5, comissao:0, aumento:0}; }
function pdAddBet(){ PD.push(pdDefaultBet()); pdRenderBets(); calcProtecao(); }
function pdRemoveBet(i){ PD.splice(i,1); if(PD.length===0) PD.push(pdDefaultBet()); pdRenderBets(); calcProtecao(); }
function pdRenderBets(){
  var wrap=document.getElementById('pdBets'); if(!wrap) return;
  wrap.innerHTML = PD.map(function(b,i){
    return '<div class="pd-bet">'
     + '<div class="pd-bet-head"><span>Aposta '+(i+1)+'</span>'+(PD.length>1?'<button class="pd-del" onclick="pdRemoveBet('+i+')" title="Remover">🗑</button>':'')+'</div>'
     + '<div class="form-group" style="margin-bottom:10px"><label class="form-label">Casa de aposta</label><input class="form-input" type="text" value="'+escapeHtml(b.casa)+'" placeholder="Digite a casa" oninput="pdField('+i+',\'casa\',this.value)"></div>'
     + '<div class="sb-row">'
     +   '<div class="form-group" style="margin-bottom:0"><label class="form-label">Valor (R$)</label><input class="form-input" type="number" min="0" step="0.01" value="'+b.valor+'" oninput="pdField('+i+',\'valor\',this.value)"></div>'
     +   '<div class="form-group" style="margin-bottom:0"><label class="form-label">Odd</label><input class="form-input" type="number" min="1" step="0.01" value="'+b.odd+'" oninput="pdField('+i+',\'odd\',this.value)"></div>'
     + '</div>'
   + '</div>';
  }).join('');
}
function pdField(i,key,val){
  if(key==='casa') PD[i].casa=val; else PD[i][key]=parseFloat(String(val).replace(',','.'))||0;
  calcProtecao();
}
function calcProtecao(){
  var totalRetorno=0, totalStake=0;
  PD.forEach(function(b){
    var boosted=(b.odd||0)*(1+(b.aumento||0)/100);
    totalRetorno += (b.valor||0)*boosted;
    totalStake += (b.valor||0);
  });
  setTextSafe('pdTotal', calcMoney(totalRetorno));
  var oddP=calcNum('pdProtOdd'), comP=calcNum('pdProtCom');
  var mP = 1 + (oddP-1)*(1-comP/100);
  var P = mP>0 ? totalRetorno/mP : 0;
  var lucro = P*(mP-1) - totalStake;
  setTextSafe('pdStake', calcMoney(P));
  setTextSafe('pdLucro', calcMoney(lucro));
  var le=document.getElementById('pdLucro'); if(le) le.style.color = lucro>=0?'var(--green)':'var(--red)';
}

// ═══════════════════════════════════════════════
//  ANOTAÇÕES
// ═══════════════════════════════════════════════
var NOTES = [];
var _notesReady = false;
var _notesSaveTimer = null;
function notesLoad(){
  try { NOTES = JSON.parse(localStorage.getItem('bancapro-notes')||'[]'); if(!Array.isArray(NOTES)) NOTES=[]; }
  catch(e){ NOTES=[]; }
}
function notesSaveLocal(){ try { localStorage.setItem('bancapro-notes', JSON.stringify(NOTES)); } catch(e){} }
function notesSave(){ notesSaveLocal(); if(typeof schedulePush==='function') schedulePush(); }
function notesPushDebounced(){
  notesSaveLocal(); // localStorage sempre atualizado na hora (não perde nada ao fechar)
  if(_notesSaveTimer) clearTimeout(_notesSaveTimer);
  _notesSaveTimer = setTimeout(function(){ if(typeof schedulePush==='function') schedulePush(); }, 800);
}
function notesInit(){ notesLoad(); notesRender(); _notesReady=true; }
function notesFmtDate(ts){
  if(!ts) return '';
  try { var d=new Date(ts); return 'Editado em '+d.toLocaleDateString('pt-BR')+' '+d.toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'}); } catch(e){ return ''; }
}
function notesRender(){
  var grid=document.getElementById('notesGrid'), empty=document.getElementById('notesEmpty');
  if(!grid) return;
  if(!NOTES.length){ grid.innerHTML=''; if(empty) empty.style.display=''; return; }
  if(empty) empty.style.display='none';
  grid.innerHTML = NOTES.map(function(n){
    return '<div class="note-card">'
      + '<div class="note-head">'
      +   '<input class="note-title" placeholder="Título" value="'+escapeHtml(n.title||'')+'" oninput="notesEdit('+n.id+',\'title\',this.value)">'
      +   '<button class="note-del" title="Excluir" onclick="notesDelete('+n.id+')">🗑</button>'
      + '</div>'
      + '<textarea class="note-body" placeholder="Escreva sua anotação…" oninput="notesEdit('+n.id+',\'body\',this.value)">'+escapeHtml(n.body||'')+'</textarea>'
      + '<div class="note-date" id="noteDate'+n.id+'">'+notesFmtDate(n.updated)+'</div>'
    + '</div>';
  }).join('');
}
function notesAdd(){
  if(!_notesReady) notesLoad();
  NOTES.unshift({ id:Date.now(), title:'', body:'', updated:Date.now() });
  notesSave();
  notesRender();
  setTimeout(function(){ var t=document.querySelector('#notesGrid .note-title'); if(t) t.focus(); }, 50);
}
function notesEdit(id, field, value){
  var n=NOTES.filter(function(x){return x.id===id;})[0]; if(!n) return;
  n[field]=value; n.updated=Date.now();
  setTextSafe('noteDate'+id, notesFmtDate(n.updated));
  notesPushDebounced();
}
async function notesDelete(id){
  var ok = (typeof customConfirm==='function')
    ? await customConfirm('Excluir esta anotação? Não dá pra desfazer.','Excluir anotação','Excluir',true)
    : confirm('Excluir esta anotação?');
  if(!ok) return;
  NOTES = NOTES.filter(function(x){return x.id!==id;});
  notesSave();
  notesRender();
  if(typeof showToast==='function') showToast('Anotação excluída.','info');
}
