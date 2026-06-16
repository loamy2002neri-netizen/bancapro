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
  // Re-renderiza o ranking se ele estiver visível (atualiza meu lucro na hora)
  var rs = document.getElementById('sec-ranking');
  if (rs && rs.classList.contains('active') && typeof renderUserRanking === 'function') {
    setTimeout(renderUserRanking, 100);
  }
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

// Helper: flags de onboarding (tour, welcome) sufixadas com userId.
// Antes eram globais e mantinham flag entre contas — usuario novo no mesmo
// browser nao via tour porque flag do user anterior estava setada.
function onboardingKey(base){
  return currentUserId ? base + '-' + currentUserId : base;
}

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
  'bancapro-notes',
  'bancapro-avatar'
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

// Baixa o "banco" do usuário e popula o localStorage para os loaders existentes lerem.
//
// BUG ANTERIOR: clearUserLocal() + applyBlob cego sobrescrevia tx locais nao
// sincronizadas (caso comum: push 800ms nao rodou porque user fechou aba).
// Resultado: transacoes cadastradas no celular sumiam ao reabrir o app.
//
// FIX: merge inteligente — preserva itens locais que ainda nao foram pra cloud
// e funde com cloud por ID. Em caso de conflito, vence o mais recente.
async function pullUserData(userId) {
  // BUG CRITICO ANTERIOR (vazamento entre contas):
  //   Snapshot do localStorage + merge fazia tx de USER A vazar pra USER B
  //   no mesmo browser. Cenario: A loga, cadastra tx, sai. B loga no mesmo
  //   aparelho. pullUserData(B) snapshotava tx de A que ainda estava em
  //   localStorage (logout falhou ou foi parcial) -> merge -> B via tx de A.
  //
  //   LGPD violation grave. Reportado por usuario real.
  //
  // FIX: snapshot SO eh confiavel se foi do MESMO userId. Salvamos o
  //   userId-owner do localStorage atual. Se nao bate com quem vai pullar,
  //   descarta snapshot — sem merge. Cloud vira fonte unica de verdade.
  const OWNER_KEY = 'bancapro-local-owner-userid';
  const previousOwner = (() => {
    try { return localStorage.getItem(OWNER_KEY); } catch(e){ return null; }
  })();
  const sameOwner = previousOwner && previousOwner === String(userId);

  // 1. Salva snapshot SO SE o localStorage atual pertence ao mesmo user
  //    Caso contrario, descarta — nao corremos risco de merge cross-user.
  const localBefore = {};
  if (sameOwner) {
    SYNC_KEYS.forEach(k => {
      try { const v = localStorage.getItem(k); if (v != null) localBefore[k] = v; } catch(e){}
    });
  }
  const hadPendingPush = sameOwner && (() => {
    try { return localStorage.getItem('bancapro-push-pending-' + userId) === '1'; } catch(e){ return false; }
  })();

  clearUserLocal();
  // Marca novo dono do localStorage — TODO push subsequente eh dele
  try { localStorage.setItem(OWNER_KEY, String(userId)); } catch(e){}

  // 2. Baixa cloud
  let cloudBlob = null;
  const sb = getSb();
  if (sb) {
    try {
      const { data, error } = await sb.from('user_data').select('data').eq('user_id', userId).maybeSingle();
      if (!error) cloudBlob = data && data.data ? data.data : null;
      else console.warn('pullUserData', error);
    } catch(e) { console.warn('pullUserData', e); }
  } else {
    try {
      const raw = localStorage.getItem('bancapro-userdata-' + userId);
      if (raw) cloudBlob = JSON.parse(raw);
    } catch(e){}
  }

  // 3. Aplica cloud primeiro (base)
  applyBlob(cloudBlob);

  // 4. Merge: se tinha push pendente OU se local tem dados extras, funde
  //    Foco nos arrays (transactions, goals, accounts) onde perda eh critica.
  const ARRAY_KEYS = ['bancapro-transactions','bancapro-goals','bancapro-accounts'];
  let merged = false;
  ARRAY_KEYS.forEach(k => {
    try {
      const cloudArr = cloudBlob && cloudBlob[k] ? JSON.parse(cloudBlob[k]) : [];
      const localArr = localBefore[k] ? JSON.parse(localBefore[k]) : [];
      if (!Array.isArray(cloudArr) || !Array.isArray(localArr)) return;
      if (localArr.length === 0) return; // nada pra mesclar

      // Indexa por id
      const byId = new Map();
      cloudArr.forEach(item => { if (item && item.id != null) byId.set(String(item.id), item); });

      // Merge: tx local que nao esta no cloud entra; conflito = mais recente vence
      let added = 0;
      localArr.forEach(item => {
        if (!item || item.id == null) return;
        const id = String(item.id);
        const existing = byId.get(id);
        if (!existing) {
          byId.set(id, item);
          added++;
        } else {
          // Mesma id em ambos — vence o mais recente
          const localStamp = new Date(item.created_at || item.updated_at || 0).getTime();
          const cloudStamp = new Date(existing.created_at || existing.updated_at || 0).getTime();
          if (localStamp > cloudStamp) byId.set(id, item);
        }
      });

      const finalArr = Array.from(byId.values());
      // Ordena: tx por created_at desc (mais novo primeiro), igual o app espera
      if (k === 'bancapro-transactions'){
        finalArr.sort((a, b) => {
          const ta = new Date(a.created_at || 0).getTime();
          const tb = new Date(b.created_at || 0).getTime();
          return tb - ta;
        });
      }
      localStorage.setItem(k, JSON.stringify(finalArr));
      if (added > 0) merged = true;
    } catch(e) { console.warn('merge ' + k, e); }
  });

  // 5. Se houve merge OU havia push pendente, agenda novo push pra mandar tudo pra cloud
  if (merged || hadPendingPush) {
    console.log('[pullUserData] merge detectado, agendando push pra sincronizar');
    if (typeof schedulePush === 'function') schedulePush();
  }
}

// Salva o "banco" do usuário.
//
// BUG CRITICO ANTERIOR: debounce de 800ms + push que so rodava na aba ativa
// faziam transacoes sumirem. Cenario tipico: user cadastrava tx no celular,
// bloqueava o aparelho antes dos 800ms, browser pausava timer, push nunca
// rodava. Ao reabrir, pullUserData() apagava local e baixava cloud (sem a
// tx nova) -> dado perdido.
//
// FIX:
//  1. Debounce reduzido pra 250ms
//  2. beforeunload/pagehide/visibilitychange forcam push imediato
//  3. Flag _pendingPush detecta push que ficou no ar, retry no proximo abrir
//  4. Push falhou? Retry com backoff (3s, 8s, 20s) ate funcionar
let _pushTimer = null;
let _pendingPush = false;       // true entre schedulePush() e pushUserData() concluir
let _retryTimer = null;
let _retryDelay = 3000;         // backoff inicial
const _PUSH_DEBOUNCE = 250;     // antes era 800
const _PUSH_RETRY_DELAYS = [3000, 8000, 20000];

function schedulePush() {
  if (!currentUserId) return;
  _pendingPush = true;
  // Marca no localStorage que tem push pendente — sobrevive reload
  try { localStorage.setItem('bancapro-push-pending-' + currentUserId, '1'); } catch(e){}
  clearTimeout(_pushTimer);
  _pushTimer = setTimeout(pushUserData, _PUSH_DEBOUNCE);
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
      if (error) {
        console.warn('pushUserData', error);
        _schedulePushRetry();
        return error;
      }
      // SUCESSO: limpa flag de pending + reseta backoff
      _pendingPush = false;
      _retryDelay = _PUSH_RETRY_DELAYS[0];
      clearTimeout(_retryTimer);
      try { localStorage.removeItem('bancapro-push-pending-' + currentUserId); } catch(e){}
      // Se a aba ranking estiver aberta, re-fetch
      var rs = document.getElementById('sec-ranking');
      if (rs && rs.classList.contains('active') && typeof renderUserRanking === 'function'){
        setTimeout(renderUserRanking, 300);
      }
      return null;
    } catch(e) {
      console.warn('pushUserData', e);
      _schedulePushRetry();
      return e;
    }
  } else {
    try {
      localStorage.setItem('bancapro-userdata-' + currentUserId, JSON.stringify(blob));
      _pendingPush = false;
      try { localStorage.removeItem('bancapro-push-pending-' + currentUserId); } catch(e){}
      return null;
    }
    catch(e){ return e; }
  }
}

// Backoff exponencial pra push falho — protege contra rede ruim
function _schedulePushRetry(){
  clearTimeout(_retryTimer);
  const idx = Math.min(_PUSH_RETRY_DELAYS.indexOf(_retryDelay) + 1, _PUSH_RETRY_DELAYS.length - 1);
  _retryDelay = _PUSH_RETRY_DELAYS[idx];
  _retryTimer = setTimeout(() => {
    if (_pendingPush && currentUserId) pushUserData();
  }, _retryDelay);
}

// Push imediato quando aba vai pra background OU vai ser fechada.
// CRITICO pra mobile: browser pausa setTimeout quando user bloqueia tela.
function _flushPushNow(){
  if (!_pendingPush || !currentUserId) return;
  clearTimeout(_pushTimer);
  pushUserData(); // fire and forget — beforeunload nao espera promise
}

// Listeners de "aba ta saindo" — registrados 1x
if (typeof window !== 'undefined' && !window._apostackPushFlushRegistered){
  window._apostackPushFlushRegistered = true;
  window.addEventListener('beforeunload', _flushPushNow);
  window.addEventListener('pagehide', _flushPushNow);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') _flushPushNow();
  });
}

// Entra no app depois de autenticado
async function enterApp(user) {
  currentUserId = user.id;
  document.getElementById('authScreen').style.display = 'none';
  document.getElementById('appLayout').style.display = 'flex';
  await pullUserData(user.id);
  try {
    // Detecta troca de conta: se email diferente do anterior, limpa tudo
    // de identidade/data/sessao via helper centralizado.
    var lastEmail = (window.Storage ? Storage.getUserEmail() : (localStorage.getItem('bancapro-user-email') || '').toLowerCase());
    var currEmail = (user.email || '').toLowerCase();
    if (lastEmail && currEmail && lastEmail !== currEmail){
      // Conta DIFERENTE — limpa tudo do user anterior
      if (window.Storage) Storage.clearUserData();
    }
    // SEMPRE sobrescreve com dados do user atual (bug fix anterior: nao usa
    // `if (!getItem)` que mantinha dados antigos quando trocava conta)
    if (user.email) localStorage.setItem('bancapro-user-email', user.email);
    const metaName = user.user_metadata && user.user_metadata.name;
    if (metaName) localStorage.setItem('bancapro-user-name', metaName);
    if (user.created_at) {
      localStorage.setItem('bancapro-user-created-at', user.created_at);
      // Sincroniza trial-start com o created_at REAL (fix do bug "trial acabou")
      localStorage.setItem('bancapro-trial-start', user.created_at);
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
  // Atualiza o label do plano no sidebar (Free/Trial/Plus/Pro/Administrador)
  try { cachePlanLabel(user); } catch(e){}
  // Onboarding: mostra welcome modal na 1a visita autenticada
  try { if (typeof maybeShowWelcome === 'function') maybeShowWelcome(); } catch(e){}
  // Tour guiado de 12 passos pra usuarios novos (zero/poucas transacoes).
  // Veteranos sao auto-marcados como "ja viu" silenciosamente.
  try { if (typeof maybeStartTour === 'function') maybeStartTour(); } catch(e){}
  // Menu Admin/Afiliados só para o dono + Zona de Perigo (acao destrutiva)
  try {
    const isOwner = OWNER_EMAILS.includes((user.email || '').toLowerCase());
    const navAdmin = document.getElementById('navAdmin');
    if (navAdmin) navAdmin.style.display = isOwner ? '' : 'none';
    const navAfiliados = document.getElementById('navAfiliados');
    if (navAfiliados) navAfiliados.style.display = isOwner ? '' : 'none';
    // Zona de Perigo (Apagar todos os dados) — so owner
    const dangerZone = document.getElementById('dangerZoneCard');
    if (dangerZone) dangerZone.style.display = isOwner ? '' : 'none';
  } catch(e){}
  // Registra a indicação (?ref) e libera o painel do afiliado.
  // RESTRICAO: 'Minhas Indicacoes' agora aparece SOMENTE pra afiliados VIP
  // (linha 50% fixo). Usuarios novos NAO veem mais o painel — feature de
  // afiliacao foi descontinuada pra base geral. Owners sempre veem.
  try {
    await recordReferralIfAny(user);
    const sb = getSb();
    const navAf = document.getElementById('navAfiliado');
    let isVip = false;
    if (sb) {
      try {
        const r = await sb.rpc('get_my_affiliate');
        isVip = !!(r.data && r.data.length);
        try { localStorage.setItem('bancapro-is-affiliate', isVip ? '1' : '0'); } catch(e){}
        try { localStorage.setItem('bancapro-affiliate-vip', isVip ? '1' : '0'); } catch(e){}
      } catch(e){}
    }
    // Mostra nav SO se for VIP. Owner tambem ve (acima ja libera navAfiliados).
    const isOwner2 = OWNER_EMAILS.includes((user.email || '').toLowerCase());
    const showAff = isVip || isOwner2;
    if (navAf) navAf.style.display = showAff ? '' : 'none';
    // Tabbar mobile: alterna 'Indicar' (VIP) com 'Métodos' (fallback nao-VIP)
    const mtbAf = document.getElementById('mtbAfiliado');
    const mtbMet = document.getElementById('mtbMethods');
    if (mtbAf) mtbAf.style.display = showAff ? '' : 'none';
    if (mtbMet) mtbMet.style.display = showAff ? 'none' : '';
  } catch(e){}
  // Voltou do checkout? mostra "obrigado" e reconfere a assinatura
  try {
    if (new URLSearchParams(location.search).get('assinatura') === 'ok') handleReturnFromCheckout();
  } catch(e){}
}

// ─── Controle de acesso por assinatura ───
// OWNER_EMAILS vem de config.js (window.OWNERS.emails) — single source of truth.
// Fallback hard-coded mantido caso config.js nao carregue (defesa em profundidade).
const OWNER_EMAILS = (window.OWNERS && Array.isArray(window.OWNERS.emails) && window.OWNERS.emails.length)
  ? window.OWNERS.emails.map(e => String(e).toLowerCase())
  : ['loamy2002neri@gmail.com', 'loamy69zzz@gmail.com'];

// Cacheia o label do plano (Free/Trial/Plus/Pro/Administrador) pra exibir no sidebar
// instantaneamente no proximo reload via hydrateSidebar (sem flash de "Apostador")
async function cachePlanLabel(user){
  try {
    const email = (user && user.email || '').toLowerCase();
    if (!email) return;
    let label = 'Free';

    if (OWNER_EMAILS.includes(email)){
      label = 'Administrador';
    } else {
      const sb = getSb();
      if (sb){
        try {
          const { data } = await sb.from('subscribers').select('status,plan,valid_until')
            .eq('email', email).maybeSingle();
          const naoExpirou = !data || !data.valid_until || new Date(data.valid_until).getTime() > Date.now();
          if (data && data.status === 'active' && naoExpirou){
            const planName = data.plan || '';
            label = /anual|annual|yearly/i.test(planName) ? 'Pro' : 'Plus';
          }
        } catch(e){}
      }
      // Fallback pro Trial se ainda tá nos 7 dias iniciais
      if (label === 'Free' && user && user.created_at){
        const end = new Date(new Date(user.created_at).getTime() + TRIAL_DAYS * 86400000);
        if (end.getTime() > Date.now()) label = 'Trial';
      }
    }

    try { localStorage.setItem('bancapro-plan-label', label); } catch(e){}
    const roleEl = document.getElementById('sidebarUserRole');
    if (roleEl) roleEl.textContent = label;
    try { if (typeof updateAllUpgradeUI === 'function') updateAllUpgradeUI(); } catch(e){}
  } catch(e){}
}

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

// Popula stats personalizados do trial (transacoes, tier, dias ativos)
function populatePaywallStats(){
  try {
    let txCount = 0, distinctDays = 0, maxProfit = 0;
    if (typeof transactions !== 'undefined' && Array.isArray(transactions)){
      txCount = transactions.length;
      const daysSet = new Set();
      let profit = 0;
      for (const t of transactions){
        if (t && t.date) daysSet.add(String(t.date).slice(0,10));
        const v = Number(t.value) || 0;
        if (t.type === 'income') profit += v;
        else if (t.type === 'expense') profit -= v;
      }
      distinctDays = daysSet.size;
      maxProfit = Math.max(0, Math.round(profit));
    }
    const tier = (typeof rankComputeCurrent === 'function') ? rankComputeCurrent(maxProfit).current : null;
    const elTx = document.getElementById('paywallStatTx');
    const elTier = document.getElementById('paywallStatTier');
    const elTierLbl = document.getElementById('paywallStatTierLbl');
    const elDays = document.getElementById('paywallStatDays');
    if (elTx) elTx.textContent = txCount > 0 ? txCount : '—';
    if (elDays) elDays.textContent = distinctDays > 0 ? distinctDays : '—';
    if (elTier && elTierLbl){
      if (tier && tier.name){
        elTier.textContent = tier.name;
        elTier.style.fontSize = '18px';
        elTierLbl.textContent = 'tier alcançado';
      } else {
        elTier.textContent = '—';
      }
    }
  } catch(e){}
}

function showPaywall() {
  const el = document.getElementById('paywallOverlay');
  if (el) el.style.display = 'flex';
  populatePaywallStats();
}
function hidePaywall() { const el = document.getElementById('paywallOverlay'); if (el) el.style.display = 'none'; }

// Re-checagem de acesso durante a sessao (alem do enterApp inicial)
// Pega usuario do Supabase ou cache local, verifica se ainda pode acessar
let _lastAccessCheck = 0;
async function recheckAccess(){
  // Throttle: nao roda mais do que 1x por 30s
  const now = Date.now();
  if (now - _lastAccessCheck < 30000) return;
  _lastAccessCheck = now;
  try {
    if (!currentAuthUser) return;
    const allowed = await checkAccess(currentAuthUser);
    if (!allowed){
      showPaywall();
    }
  } catch(e){}
}

// Hook na navegacao (depois do goTo executar): re-valida
const _origGoToForRecheck = window.goTo;
if (typeof _origGoToForRecheck === 'function'){
  window.goTo = function(){
    const r = _origGoToForRecheck.apply(this, arguments);
    setTimeout(recheckAccess, 100);
    return r;
  };
}

// Quando a aba volta ao foco (usuario voltou ao app depois de horas)
window.addEventListener('focus', () => { recheckAccess(); });

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

// ── Tier system pro usuario comum (10% a 35% por nivel) ──
// Modelo simplificado: 30% pra todos os usuarios comuns, 50% pra VIP
const AFF_RATE_COMMON = 30;
const AFF_RATE_VIP    = 50;

// Mantida pra compat (codigo legado pode chamar)
function affComputeTier(activeCount){
  return { tier:null, next:null, rate:AFF_RATE_COMMON, progress:100 };
}

function affUpdateTierCard(activeCount, isVip){
  const card = document.getElementById('affTierCard');
  if (!card) return;
  const eyebrow  = document.getElementById('affTierEyebrow');
  const nameEl   = document.getElementById('affTierName');
  const rateEl   = document.getElementById('affTierRate');
  const progress = document.getElementById('affTierProgress');
  const howFoot  = document.getElementById('affHowFoot');
  const heroImg  = document.getElementById('affHeroImg');
  const tiersCard = document.querySelector('.aff-tiers-card');

  if (progress) progress.style.display = 'none';
  if (tiersCard) tiersCard.style.display = 'none';

  // Programa de afiliacao agora e EXCLUSIVO pra VIPs (50%). Quem nao for VIP
  // (ex: owner sem flag VIP) nao ve nenhum card de afiliacao — esconde tudo.
  if (!isVip){
    card.style.display = 'none';
    return;
  }

  card.style.display = '';
  card.classList.add('is-vip');
  if (heroImg) heroImg.src = 'brand/icones%20afiliados/06_partner.png';
  if (eyebrow) eyebrow.textContent = 'Plano especial';
  if (nameEl)  nameEl.textContent  = 'Afiliado VIP';
  if (rateEl)  rateEl.textContent  = 'Comissão especial: 50% recorrente';
  if (howFoot) howFoot.textContent = 'Você possui uma comissão especial de 50% recorrente em suas indicações ativas.';
}

// ── Helper: deriva codigo de indicacao do email pra usuario comum ──
function affDeriveCodeFromEmail(email){
  // Codigo anonimo determinKstico no formato "refuser" + 6 caracteres.
  // Por que: muita gente nao se cadastra quando ve o codigo de outra pessoa
  // (ex: LOAMYZZZ69 expoe o email do indicador). Codigo neutro tipo "refuser4a9c2f"
  // gera curiosidade sem expor identidade.
  // Determinismo: usa o user_id (UUID do Supabase) quando disponivel — sempre o mesmo,
  // facil de replicar no SQL (right(replace(uid::text,'-',''), 6)).
  // Fallback (modo local sem auth): hash do email.
  var uid = '';
  try { uid = (window.currentAuthUser && window.currentAuthUser.id) || ''; } catch(e){}
  if (uid){
    var raw = String(uid).replace(/-/g, '').toLowerCase();
    if (raw.length >= 6) return 'refuser' + raw.slice(-6);
  }
  // Fallback: hash determinKstico do email (djb2 + sdbm em base36)
  if (!email) return 'refuser000000';
  var s = String(email).trim().toLowerCase();
  var h1 = 5381, h2 = 52711;
  for (var i = 0; i < s.length; i++){
    var c = s.charCodeAt(i);
    h1 = ((h1 << 5) + h1 + c) >>> 0;
    h2 = ((h2 << 5) - h2 + c) >>> 0;
  }
  var combined = (h1 ^ (h2 << 1)) >>> 0;
  var hash = combined.toString(36);
  if (hash.length < 6) hash = (h2.toString(36) + hash).slice(0, 6);
  return 'refuser' + hash.slice(0, 6);
}

// ── Afiliado: painel próprio ("Minhas Indicações") — agora pra TODOS ──
async function renderMyAffiliatePanel() {
  var sb = getSb();
  var isVip = false;
  var a = null;

  // Tenta buscar dados de afiliado VIP
  if (sb){
    try {
      var r = await sb.rpc('get_my_affiliate');
      if (!r.error && r.data && r.data.length){
        a = r.data[0];
        isVip = true;
      }
    } catch(e){}
  }

  // Se eh VIP: usa dados do RPC (comissao fixa 50%)
  // Se eh usuario comum: gera codigo do email + zera contadores
  // Resolve email do usuario logado
  var myEmail = '';
  try { myEmail = (currentAuthUser && currentAuthUser.email) || localStorage.getItem('bancapro-user-email') || ''; } catch(e){}
  myEmail = (myEmail || '').toLowerCase();

  // Pega stats reais via RPC nova
  var stats = null;
  if (sb && myEmail){
    try {
      var s = await sb.rpc('get_my_referral_stats', { p_email: myEmail });
      if (!s.error && s.data && s.data.length) stats = s.data[0];
    } catch(e){}
  }

  var totalReferrals = stats?.total_referrals || 0;
  var activeCount    = stats?.active_paid || 0;
  var pendingBal     = Number(stats?.pending_balance || 0);
  var availableBal   = Number(stats?.available_balance || 0);
  var paidBal        = Number(stats?.paid_balance || 0);
  var isVipReal      = !!stats?.is_vip || isVip;
  // Comissao fixa: 30% pra comum, 50% pra VIP
  var pctReal        = isVipReal ? AFF_RATE_VIP : AFF_RATE_COMMON;

  // Codigo / link: usa o do VIP se tiver, senao deriva do email
  var code = isVipReal && a ? a.code : affDeriveCodeFromEmail(myEmail);
  var link = location.origin + '/?ref=' + code;

  // Comissao mensal estimada (apenas display): nao temos MRR per-referred ainda; usa pendente como proxy
  var monthlyEstimate = pendingBal;

  setTextSafe('myAffCode', code);
  setTextSafe('myAffLink', link);
  setTextSafe('myAffCommission', (isVipReal ? 'comissão especial de 50%' : pctReal + '%'));
  setTextSafe('myAffIndicados', totalReferrals);
  setTextSafe('myAffAtivos', activeCount);
  setTextSafe('affEntradas', _affMoney(monthlyEstimate));
  setTextSafe('affPendente', _affMoney(pendingBal));
  setTextSafe('affSaldo', _affMoney(availableBal));
  setTextSafe('affSaidas', _affMoney(paidBal));

  affUpdateTierCard(activeCount, isVipReal);

  // Lista de indicados via RPC nova
  var listEl = document.getElementById('myAffList');
  if (listEl){
    try {
      var rr = await sb.rpc('get_my_referrals_list', { p_email: myEmail });
      var rows = rr.data || [];
      if (!rows.length){
        listEl.innerHTML = '<div class="empty-state-sub" style="text-align:center;padding:24px 0">Você ainda não tem indicados.<br/>Compartilhe seu link e comece a ganhar comissão recorrente.</div>';
      } else {
        var html = rows.map(function(r){
          var dt = r.created_at ? new Date(r.created_at).toLocaleDateString('pt-BR') : '—';
          var st = r.is_active_paid
            ? '<span style="color:var(--green);font-weight:600">Ativo</span>'
            : '<span style="color:var(--text-muted);font-weight:600">Cadastrado</span>';
          var last = r.last_payment_at ? new Date(r.last_payment_at).toLocaleDateString('pt-BR') : '—';
          var maskEmail = String(r.referred_email||'').replace(/^(.{2}).*?@/, '$1***@');
          return '<tr>'+
            '<td data-label="Pessoa">'+escapeHtml(r.referred_name || maskEmail)+'</td>'+
            '<td data-label="Email">'+escapeHtml(maskEmail)+'</td>'+
            '<td data-label="Entrou">'+dt+'</td>'+
            '<td data-label="Status">'+st+'</td>'+
            '<td data-label="Comissão" style="text-align:right;font-weight:700">'+_affMoney(r.total_commission||0)+'</td>'+
            '<td data-label="Último pagamento" style="color:var(--text-muted);font-size:12px">'+last+'</td>'+
          '</tr>';
        }).join('');
        listEl.innerHTML = '<div style="overflow-x:auto"><table class="admin-table">'+
          '<thead><tr><th>Pessoa</th><th>Email</th><th>Entrou</th><th>Status</th><th style="text-align:right">Comissão</th><th>Último pagamento</th></tr></thead>'+
          '<tbody>'+html+'</tbody></table></div>';
      }
    } catch(e){
      listEl.innerHTML = '<div class="empty-state-sub">Erro ao carregar.</div>';
    }
  }

  renderMyWithdrawals(availableBal);
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
// ══════════════════════════════════════════════
//  ADMIN — Saques de afiliados (sistema com niveis)
// ══════════════════════════════════════════════
let _affAdminFilter = 'pending';

function affAdminSwitchTab(btn, filter){
  _affAdminFilter = filter;
  document.querySelectorAll('.aff-tab-btn').forEach(b => b.classList.remove('is-active'));
  if (btn) btn.classList.add('is-active');
  renderAffWithdrawalsAdmin();
}

function _affAdminStatusBadge(st){
  const map = {
    pending:  ['Pendente',  'rgba(247,147,30,.15)', '#f7931e', 'rgba(247,147,30,.4)'],
    approved: ['Aprovado',  'rgba(124,92,255,.15)', '#a78bfa', 'rgba(124,92,255,.4)'],
    paid:     ['Pago',      'rgba(16,185,129,.15)', '#34d399', 'rgba(16,185,129,.4)'],
    rejected: ['Rejeitado', 'rgba(239,68,68,.15)',  '#f87171', 'rgba(239,68,68,.4)'],
    canceled: ['Cancelado', 'rgba(255,255,255,.05)','var(--text-muted)','var(--border)']
  };
  const m = map[st] || ['—','rgba(255,255,255,.05)','var(--text-muted)','var(--border)'];
  return '<span style="display:inline-block;background:'+m[1]+';color:'+m[2]+';border:1px solid '+m[3]+';padding:2px 9px;border-radius:5px;font-size:10.5px;font-weight:700;letter-spacing:.5px">'+m[0]+'</span>';
}

async function renderAffWithdrawalsAdmin(){
  const el = document.getElementById('adminAffWithdrawals');
  if (!el) return;
  const sb = getSb();
  if (!sb){ el.innerHTML = '<div class="empty-state-sub">Disponível só com o banco na nuvem.</div>'; return; }
  el.innerHTML = '<div class="empty-state-sub">Carregando…</div>';
  try {
    const filter = _affAdminFilter === 'all' ? null : _affAdminFilter;
    const { data, error } = await sb.rpc('admin_list_affiliate_withdrawals', { p_status: filter });
    if (error){ el.innerHTML = '<div class="empty-state-sub">Acesso restrito ou erro: '+(error.message||'')+'</div>'; return; }
    if (!data || !data.length){ el.innerHTML = '<div class="empty-state-sub">Nenhum saque '+(_affAdminFilter === 'all' ? '' : _affAdminFilter)+'.</div>'; return; }

    const rows = data.map(w => {
      const dt = w.requested_at ? new Date(w.requested_at).toLocaleDateString('pt-BR') + ' às ' + new Date(w.requested_at).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'}) : '—';
      const valor = 'R$ ' + (Number(w.amount)||0).toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2});
      const saldo = 'R$ ' + (Number(w.available_balance)||0).toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2});
      const hasFunds = Number(w.available_balance) >= Number(w.amount);
      const fundsColor = hasFunds ? '#34d399' : '#f87171';
      const pixKey = escapeHtml(w.pix_key || '—');
      const pixType = escapeHtml(w.pix_key_type || '—');
      const holder = escapeHtml(w.holder_name || '—');
      const affEmail = escapeHtml(w.affiliate_email || '');
      const idAttr = escapeHtml(w.id);
      const noteEsc = escapeHtml(w.admin_note || '');

      let actions = '';
      if (w.status === 'pending'){
        actions =
          '<button class="aff-act-btn aff-act-pay" onclick="affAdminMarkPaid(\''+idAttr+'\',\''+affEmail+'\','+w.amount+')">Marcar como pago</button>'+
          '<button class="aff-act-btn aff-act-reject" onclick="affAdminReject(\''+idAttr+'\',\''+affEmail+'\')">Rejeitar</button>';
      } else if (w.admin_note){
        actions = '<div class="aff-act-note">'+noteEsc+'</div>';
      }

      return '<tr class="aff-wd-row">'+
        '<td data-label="Solicitado">'+dt+'</td>'+
        '<td data-label="Afiliado"><div style="font-weight:700">'+affEmail+'</div><div style="font-size:11px;color:var(--text-muted)">'+w.active_referrals+' ativo(s)</div></td>'+
        '<td data-label="Valor"><div style="font-weight:800;font-size:15px">'+valor+'</div><div style="font-size:11px;color:'+fundsColor+'">saldo: '+saldo+'</div></td>'+
        '<td data-label="Pix"><div style="font-weight:600">'+holder+'</div><div style="font-size:11px;color:var(--text-muted)">'+pixType+': <span style="color:var(--text);font-family:monospace">'+pixKey+'</span></div></td>'+
        '<td data-label="Status">'+_affAdminStatusBadge(w.status)+'</td>'+
        '<td data-label="Ações" style="text-align:right;white-space:nowrap">'+actions+'</td>'+
      '</tr>';
    }).join('');

    el.innerHTML = '<div style="overflow-x:auto"><table class="admin-table">'+
      '<thead><tr><th>Solicitado</th><th>Afiliado</th><th>Valor</th><th>Pix</th><th>Status</th><th style="text-align:right">Ações</th></tr></thead>'+
      '<tbody>'+rows+'</tbody></table></div>';
  } catch(e){
    el.innerHTML = '<div class="empty-state-sub">Erro ao carregar.</div>';
  }
}

async function affAdminMarkPaid(id, email, amount){
  const valor = 'R$ ' + (Number(amount)||0).toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2});
  const ok = await customConfirm(
    'Marcar como PAGO o saque de '+valor+' para '+email+'?\n\nVocê já fez o Pix? Esta ação subtrai do saldo disponível do afiliado.',
    'Confirmar pagamento',
    'Sim, marcar como pago'
  );
  if (!ok) return;
  const sb = getSb();
  if (!sb){ showToast('Disponível só com o banco na nuvem.','error'); return; }
  try {
    const r = await sb.rpc('admin_mark_withdrawal_paid', { p_id: id, p_note: null });
    if (r.error){ showToast('Erro: '+(r.error.message||''),'error'); return; }
    showToast('Saque marcado como pago.','success');
    renderAffWithdrawalsAdmin();
  } catch(e){ showToast('Erro ao processar.','error'); }
}

async function affAdminReject(id, email){
  const reason = await customPrompt(
    'Por que rejeitar o saque de '+email+'? (motivo será mostrado pro afiliado)',
    'Rejeitar saque',
    'Ex: chave Pix inválida'
  );
  if (!reason) return;
  const sb = getSb();
  if (!sb){ showToast('Disponível só com o banco na nuvem.','error'); return; }
  try {
    const r = await sb.rpc('admin_reject_withdrawal', { p_id: id, p_reason: reason });
    if (r.error){ showToast('Erro: '+(r.error.message||''),'error'); return; }
    showToast('Saque rejeitado.','info');
    renderAffWithdrawalsAdmin();
  } catch(e){ showToast('Erro ao processar.','error'); }
}

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
    var newEmail = (user.email||'').toLowerCase();
    // Normaliza pra lowercase — o novo formato "refuser..." eh case-insensitive
    var code = ref.trim().toLowerCase();

    // Resolve o codigo -> email do indicador (via RPC criada no Supabase)
    var referrerEmail = null;
    try {
      var r = await sb.rpc('resolve_referral_code', { p_code: code });
      if (r.data) referrerEmail = String(r.data).toLowerCase();
    } catch(e){}

    // Antifraude: nao permite autoindicacao
    if (referrerEmail && referrerEmail === newEmail) return;

    // Salva com schema completo + mantem compat com schema antigo (email, ref)
    var row = {
      email: newEmail,
      ref: code,
      referred_email: newEmail,
      referral_code: code
    };
    if (referrerEmail) row.referrer_email = referrerEmail;

    await sb.from('referrals').upsert(row, { onConflict:'referred_email', ignoreDuplicates:true });
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

// ══════════════════════════════════════════════
//  MODERACAO DO RANKING (admin: banir cheaters)
// ══════════════════════════════════════════════
function _rankModFmt(v){
  return 'R$ ' + (Number(v)||0).toLocaleString('pt-BR', { minimumFractionDigits:0, maximumFractionDigits:0 });
}

async function renderRankingModeration(){
  const el = document.getElementById('adminBanList');
  if (!el) return;
  const sb = getSb();
  if (!sb){ el.innerHTML = '<div class="empty-state-sub">Disponível só com o banco na nuvem.</div>'; return; }
  el.innerHTML = '<div class="empty-state-sub">Carregando…</div>';
  try {
    const { data, error } = await sb.rpc('admin_list_users_for_ranking');
    if (error){ el.innerHTML = '<div class="empty-state-sub">Acesso restrito ou erro: '+(error.message||'')+'</div>'; return; }
    if (!data || !data.length){ el.innerHTML = '<div class="empty-state-sub">Nenhum usuário com transações ainda.</div>'; return; }
    const rows = data.map(u => {
      const emailAttr = escapeHtml(u.email || '');
      const proBadge = u.is_pro
        ? '<span style="background:rgba(168,85,247,.18);color:#a78bfa;padding:2px 8px;border-radius:6px;font-size:10px;font-weight:700">PRO</span>'
        : '<span style="color:var(--text-muted);font-size:10px">FREE</span>';
      const banBadge = u.is_banned
        ? '<span style="background:rgba(239,68,68,.18);color:#f87171;padding:2px 8px;border-radius:6px;font-size:10px;font-weight:700">BANIDO</span>'
        : '';
      const rowStyle = u.is_banned ? 'opacity:.55' : '';
      const actionBtn = u.is_banned
        ? `<button class="btn-ghost" style="padding:5px 12px;font-size:11px;color:#34d399" onclick="adminUnbanRankingUser('${emailAttr}')">✓ Desbanir</button>`
        : `<button class="btn-ghost" style="padding:5px 12px;font-size:11px;color:#f87171" onclick="adminBanRankingUser('${emailAttr}','${escapeHtml(u.display_name||'')}')">🚫 Banir</button>`;
      return `<tr style="${rowStyle}">
        <td data-label="Nome">${escapeHtml(u.display_name||'—')} ${banBadge}</td>
        <td data-label="E-mail" style="font-size:11px;color:var(--text-muted)">${escapeHtml(u.email||'—')}</td>
        <td data-label="Plano">${proBadge}</td>
        <td data-label="Lucro total" style="font-weight:700">${_rankModFmt(u.total_profit)}</td>
        <td data-label="TX">${u.tx_count||0}</td>
        <td data-label="Dias">${u.active_days||0}</td>
        <td data-label="" style="text-align:right;white-space:nowrap">${actionBtn}</td>
      </tr>`;
    }).join('');
    el.innerHTML = `<div style="overflow-x:auto"><table class="admin-table">
      <thead><tr><th>Nome</th><th>E-mail</th><th>Plano</th><th>Lucro total</th><th>TX</th><th>Dias</th><th style="text-align:right">Ações</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;
  } catch(e){
    el.innerHTML = '<div class="empty-state-sub">Erro ao carregar.</div>';
  }
}

async function adminBanRankingUser(email, displayName){
  const ok = await customConfirm(
    'Banir "'+(displayName||email)+'" do ranking?\n\nEle vai sumir das 4 abas (Hoje, Semana, Mês, Geral).\nVocê pode desbanir depois.',
    'Banir do ranking',
    'Banir'
  );
  if (!ok) return;
  const sb = getSb();
  if (!sb){ showToast('Disponível só com o banco na nuvem.','error'); return; }
  try {
    const r = await sb.rpc('admin_ban_from_ranking', { p_email: email, p_reason: null });
    if (r.error){ showToast('Erro: '+(r.error.message||'não foi possível'),'error'); return; }
    showToast('🚫 Banido: '+(displayName||email),'info');
    renderRankingModeration();
  } catch(e){ showToast('Erro ao banir.','error'); }
}

async function adminUnbanRankingUser(email){
  const sb = getSb();
  if (!sb){ showToast('Disponível só com o banco na nuvem.','error'); return; }
  try {
    const r = await sb.rpc('admin_unban_from_ranking', { p_email: email });
    if (r.error){ showToast('Erro: '+(r.error.message||'não foi possível'),'error'); return; }
    showToast('✅ Desbanido: '+email,'success');
    renderRankingModeration();
  } catch(e){ showToast('Erro ao desbanir.','error'); }
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
  // Meta Pixel: Purchase + Subscribe — usuario retornou do checkout com sucesso
  try {
    if (typeof fbq === 'function') {
      // Tenta inferir valor do plano via URL ou padrao mensal
      let value = 24.90, plan = 'Plus Mensal';
      try {
        const p = new URLSearchParams(location.search).get('plano');
        if (p === 'anual') { value = 199; plan = 'Pro Anual'; }
      } catch(e){}
      fbq('track', 'Subscribe', {
        value: value,
        currency: 'BRL',
        predicted_ltv: value * 6,
        content_name: 'Apostack ' + plan
      });
      // Purchase como fallback (alguns templates de campanha usam Purchase)
      fbq('track', 'Purchase', {
        value: value,
        currency: 'BRL',
        content_name: 'Apostack ' + plan
      });
    }
  } catch(e){}
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

  // Detalhes do plano em estilo Notion (clean, info-dense)
  const isAnnual = /anual|annual|yearly/i.test(planName);
  const isOwner = planName === 'Acesso de Dono';

  // Features incluidas (Notion-style "What's included")
  const planFeatures = isOwner ? [
    'Acesso total e permanente',
    'Todas as funcionalidades Pro',
    'Painel de moderação e admin',
    'Conta vitalícia da plataforma'
  ] : (isActive ? (isAnnual ? [
    'Tudo do Plus, sem limite',
    'Badge azul Pro no ranking',
    'Aparece direto nas 4 abas (sem critérios)',
    'Suporte prioritário direto',
    'Acesso antecipado a novos recursos'
  ] : [
    'Dashboard completo em tempo real',
    'Relatórios e Comparativo mensal',
    'Calculadora profissional',
    'Ranking entre apostadores',
    'Sincronização entre dispositivos'
  ]) : [
    '7 dias para explorar tudo',
    'Acesso a todas as features Pro',
    'Sem cobrança automática',
    'Cancele a qualquer momento'
  ]);

  if (isActive || isTrial) {
    const statusTxt = isOwner ? 'Vitalício' : (isActive ? 'Ativo' : 'Trial ativo');
    const statusVariant = isOwner ? 'owner' : (isActive ? 'active' : 'trial');
    const dl = daysLeft != null ? `${daysLeft} ${daysLeft === 1 ? 'dia' : 'dias'}` : '∞';
    const renewLabel = isOwner ? 'Acesso permanente' : (isActive ? 'Próxima cobrança' : 'Trial encerra em');
    const renewValue = isOwner ? '—' : validStr;
    const pricePerPeriod = isOwner ? 'Grátis' : (isActive ? (isAnnual ? 'R$ 199,00 / ano' : 'R$ 24,90 / mês') : 'Em teste');

    const ctaPrimary = isTrial
      ? '<button class="sub-mgmt-btn primary" onclick="goTo(\'recharge\')">Assinar agora</button>'
      : (isOwner ? '' : '<button class="sub-mgmt-btn primary" onclick="goTo(\'recharge\')">Mudar plano</button>');
    const ctaSecondary = isOwner ? '' : '<button class="sub-mgmt-btn ghost" onclick="goTo(\'recharge\')">Histórico e fatura</button>';

    el.innerHTML = `
      <div class="sub-mgmt-head">
        <div class="sub-mgmt-head-left">
          <div class="sub-mgmt-plan">${escapeHtml(planName)}</div>
          <div class="sub-mgmt-price">${pricePerPeriod}</div>
        </div>
        <div class="sub-mgmt-status sub-mgmt-status-${statusVariant}">
          <span class="sub-mgmt-status-dot"></span>${statusTxt}
        </div>
      </div>

      <div class="sub-mgmt-rows">
        <div class="sub-mgmt-row">
          <span class="sub-mgmt-row-k">${renewLabel}</span>
          <span class="sub-mgmt-row-v">${renewValue}</span>
        </div>
        <div class="sub-mgmt-row">
          <span class="sub-mgmt-row-k">Tempo restante</span>
          <span class="sub-mgmt-row-v ${daysLeft != null && daysLeft <= 3 && !isOwner ? 'is-warning' : ''}">${dl}</span>
        </div>
        <div class="sub-mgmt-row">
          <span class="sub-mgmt-row-k">Método de pagamento</span>
          <span class="sub-mgmt-row-v sub-mgmt-row-muted">${isOwner ? '—' : (isActive ? 'Kirvano · Pix/Cartão' : 'Nenhum')}</span>
        </div>
      </div>

      <div class="sub-mgmt-divider"></div>

      <div class="sub-mgmt-features">
        <div class="sub-mgmt-features-label">O que está incluso</div>
        <ul class="sub-mgmt-features-list">
          ${planFeatures.map(f => `<li><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5L20 7"/></svg><span>${escapeHtml(f)}</span></li>`).join('')}
        </ul>
      </div>

      ${(ctaPrimary || ctaSecondary) ? `<div class="sub-mgmt-actions">${ctaPrimary}${ctaSecondary}</div>` : ''}
    `;
  } else {
    el.innerHTML = `
      <div class="sub-mgmt-head">
        <div class="sub-mgmt-head-left">
          <div class="sub-mgmt-plan">Sem assinatura ativa</div>
          <div class="sub-mgmt-price">Seu período de teste expirou</div>
        </div>
        <div class="sub-mgmt-status sub-mgmt-status-inactive">
          <span class="sub-mgmt-status-dot"></span>Inativo
        </div>
      </div>

      <div class="sub-mgmt-divider"></div>

      <p class="sub-mgmt-empty">Assine o Plus ou Pro para recuperar acesso completo às métricas, ranking e relatórios que você usava no trial.</p>

      <div class="sub-mgmt-actions">
        <button class="sub-mgmt-btn primary" onclick="goTo('recharge')">Ver planos</button>
        <button class="sub-mgmt-btn ghost" onclick="logout()">Sair da conta</button>
      </div>
    `;
  }
}

// ══════════════════════════════════════════════
//  RATE LIMIT no login (defesa anti brute-force)
// ══════════════════════════════════════════════
// Track de tentativas falhas por email + IP-ish (limitado em browser).
// Progressive delay:
//   0-2 erros: sem delay
//   3 erros:  espera 5s
//   4 erros:  espera 15s
//   5+ erros: espera 30s
//   10+ erros: lockout 5min (login bloqueado)
// Reset em login OK ou apos 1h.
function _loginAttemptsKey(email){ return 'bancapro-login-attempts-' + (email||'').toLowerCase(); }
function _getLoginAttempts(email){
  try {
    const raw = localStorage.getItem(_loginAttemptsKey(email));
    if (!raw) return { count: 0, lastFail: 0, lockedUntil: 0 };
    const obj = JSON.parse(raw);
    // Reset se passou 1 hora sem tentar (deu tempo de o user lembrar)
    if (obj.lastFail && (Date.now() - obj.lastFail) > 3600000){
      return { count: 0, lastFail: 0, lockedUntil: 0 };
    }
    return obj;
  } catch(e){ return { count: 0, lastFail: 0, lockedUntil: 0 }; }
}
function _setLoginAttempts(email, obj){
  try { localStorage.setItem(_loginAttemptsKey(email), JSON.stringify(obj)); } catch(e){}
}
function _clearLoginAttempts(email){
  try { localStorage.removeItem(_loginAttemptsKey(email)); } catch(e){}
}
function _registerLoginFailure(email){
  const a = _getLoginAttempts(email);
  a.count = (a.count || 0) + 1;
  a.lastFail = Date.now();
  // Lockout apos 10 falhas
  if (a.count >= 10) a.lockedUntil = Date.now() + (5 * 60 * 1000); // 5 minutos
  _setLoginAttempts(email, a);
  return a;
}
function _checkLoginRateLimit(email){
  // Retorna: { allowed: bool, waitMs: ms, reason: string }
  const a = _getLoginAttempts(email);
  const now = Date.now();
  // Lockout ativo?
  if (a.lockedUntil && a.lockedUntil > now){
    const left = Math.ceil((a.lockedUntil - now) / 60000);
    return { allowed: false, waitMs: a.lockedUntil - now, reason: 'Muitas tentativas. Aguarde ' + left + ' min ou recupere sua senha.' };
  }
  // Delay progressivo apos 3+ falhas
  const sinceLastFail = a.lastFail ? (now - a.lastFail) : Infinity;
  let requiredWait = 0;
  if (a.count >= 5) requiredWait = 30000;
  else if (a.count >= 4) requiredWait = 15000;
  else if (a.count >= 3) requiredWait = 5000;
  if (requiredWait && sinceLastFail < requiredWait){
    const left = Math.ceil((requiredWait - sinceLastFail) / 1000);
    return { allowed: false, waitMs: requiredWait - sinceLastFail, reason: 'Aguarde ' + left + 's antes de tentar de novo.' };
  }
  return { allowed: true };
}

async function doLogin() {
  const email = (document.getElementById('loginEmail').value || '').trim().toLowerCase();
  const password = document.getElementById('loginPassword').value || '';
  if (!email || !password) { showToast('Preencha email e senha.','error'); return; }

  // Rate limit check ANTES de tentar autenticar
  const rl = _checkLoginRateLimit(email);
  if (!rl.allowed){
    showToast(rl.reason, 'error');
    return;
  }

  const sb = getSb();
  if (sb) {
    showToast('Entrando…','info');
    try {
      const { data, error } = await sb.auth.signInWithPassword({ email, password });
      if (error) {
        const a = _registerLoginFailure(email);
        // Aviso especial se tá perto do lockout
        if (a.count >= 7 && a.count < 10){
          showToast('Email ou senha incorretos. Faltam ' + (10 - a.count) + ' tentativas até bloqueio temporário.','error');
        } else if (a.count >= 10){
          showToast('Muitas tentativas. Login bloqueado por 5 minutos.','error');
        } else {
          showToast('Email ou senha incorretos.','error');
        }
        return;
      }
      _clearLoginAttempts(email); // Login OK: zera contador
      await enterApp(data.user);
    } catch(e) {
      _registerLoginFailure(email);
      showToast('Erro ao entrar. Tente novamente.','error');
    }
  } else {
    const u = localGetUsers().find(x => x.email === email);
    if (!u) { _registerLoginFailure(email); showToast('Email ou senha incorretos.','error'); return; }
    const h = await hashPassword(password, u.salt);
    if (h !== u.passHash) { _registerLoginFailure(email); showToast('Email ou senha incorretos.','error'); return; }
    _clearLoginAttempts(email);
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
        // Checa se já tem assinatura ativa pelo email (caso tenha pago antes de criar conta)
        try {
          const jaAssinou = await hasActiveSubscription(email);
          if (jaAssinou) {
            showToast('Pagamento reconhecido! Sua assinatura já está ativa 🎉','success');
          }
        } catch(e){}
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
  // Limpa identidade + data + sessao do user atual via helper centralizado.
  // Mantem SETTINGS (theme, branding) entre sessoes.
  try { if (window.Storage) Storage.clearUserData(); } catch(e){}
  clearUserLocal();
  currentUserId = null;
  location.reload();
}

function showLogin() { document.getElementById('loginForm').style.display='block'; document.getElementById('registerForm').style.display='none'; document.getElementById('resetForm').style.display='none'; }
// Quando user vem da landing via /?modo=cadastro -> abre direto o form
// de criar conta. /?modo=recuperar -> abre form de recuperar senha.
(function autoDetectAuthMode(){
  function apply(){
    try {
      const params = new URLSearchParams(location.search);
      const modo = (params.get('modo') || '').toLowerCase();
      const assinaturaOk = params.get('assinatura') === 'ok';
      if (modo === 'cadastro' || modo === 'register' || assinaturaOk){
        setTimeout(() => {
          if (typeof showRegister === 'function') showRegister();
          if (assinaturaOk){
            const banner = document.getElementById('paidSignupBanner');
            if (banner) banner.style.display = 'block';
            const email = document.getElementById('regEmail');
            if (email) setTimeout(() => email.focus(), 200);
          }
        }, 100);
      } else if (modo === 'recuperar' || modo === 'reset'){
        setTimeout(() => { if (typeof showReset === 'function') showReset(); }, 100);
      }
    } catch(e){}
  }
  if (document.readyState !== 'loading') apply();
  else document.addEventListener('DOMContentLoaded', apply);
})();
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

// Modo demo (?demo=1&tab=NAME) — usado pra screenshots da landing page
(function demoMode(){
  try{
    var p = new URLSearchParams(location.search);
    if(p.get('demo') !== '1') return;
    var tab = p.get('tab') || 'dashboard';
    function go(){
      try{
        // Reset visual pra default Apostack dark
        document.documentElement.classList.remove('light');
        document.documentElement.classList.add('dark');
        try{ localStorage.removeItem('bancapro-theme'); }catch(e){}
        try{ localStorage.removeItem('bancapro-platform-name'); }catch(e){}
        try{ localStorage.removeItem('bancapro-logo'); }catch(e){}
        document.getElementById('authScreen').style.display='none';
        document.getElementById('appLayout').style.display='flex';
        document.querySelectorAll('.section').forEach(function(s){s.classList.remove('active');});
        var sec = document.getElementById('sec-'+tab);
        if(sec) sec.classList.add('active');
        // Trigger inits específicos por seção
        try{
          if(tab==='methods' && typeof initMethodEvolution==='function') setTimeout(initMethodEvolution,150);
          if(tab==='methods' && typeof renderMethodsRanking==='function') setTimeout(renderMethodsRanking,150);
          if(tab==='transactions' && typeof renderAllTransactions==='function') setTimeout(renderAllTransactions,200);
          if(tab==='reports' && typeof initReportCharts==='function') setTimeout(initReportCharts,200);
          if(tab==='ranking' && typeof renderUserRanking==='function') setTimeout(renderUserRanking,200);
          if(tab==='dashboard' && typeof rankUpdateDashCard==='function') setTimeout(rankUpdateDashCard,250);
        }catch(e){}
        var now=new Date();
        function tAt(h,m){var d=new Date(now);d.setHours(h,m,0,0);return d.getTime();}
        function iso(d){return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');}
        function dISO(off){var d=new Date(now);d.setDate(d.getDate()-off);return iso(d);}
        try{ SALDO_BASE=40000; }catch(e){}
        var tx = [];
        // Inject 30 dias de transações pra populiar os charts
        for(var i=29; i>=0; i--){
          var date = dISO(i);
          if(i%3===0) tx.push({id:Date.now()+i*100,type:'income',value:Math.round(200+Math.random()*400),method:'Surebet',date:date,desc:'Surebet '+date});
          if(i%4===0) tx.push({id:Date.now()+i*100+1,type:'income',value:Math.round(100+Math.random()*200),method:'Freebet',date:date,desc:'Freebet '+date});
          if(i%5===0) tx.push({id:Date.now()+i*100+2,type:'expense',value:Math.round(50+Math.random()*150),method:'iGaming',date:date,desc:'iGaming '+date});
          if(i%6===0) tx.push({id:Date.now()+i*100+3,type:'income',value:Math.round(150+Math.random()*250),method:'Stake',date:date,desc:'Stake '+date});
        }
        // Garante streak de 7 dias seguidos (demo do streak counter)
        for(var s=6; s>=0; s--){
          var sDate = dISO(s);
          if (!tx.some(t => t.date === sDate)) tx.push({id:Date.now()+5000+s,type:'income',value:Math.round(120+Math.random()*180),method:'Surebet',date:sDate,desc:'Surebet '+sDate});
        }
        // Hoje
        tx.push({id:tAt(8,0),type:'income',value:8420,method:'Surebet',date:iso(now),desc:'Surebet hoje'});
        tx.push({id:tAt(12,0),type:'expense',value:2380,method:'iGaming',date:iso(now),desc:'iGaming hoje'});
        transactions = tx;
        try{ saveTransactions && saveTransactions(); }catch(e){}
        // Atualiza KPIs
        try{
          if(document.getElementById('kpi-saldo')) document.getElementById('kpi-saldo').textContent='R$ 48.500';
          if(document.getElementById('kpi-lucro')) document.getElementById('kpi-lucro').textContent='+R$ 8.420';
          if(document.getElementById('kpi-despesas')) document.getElementById('kpi-despesas').textContent='R$ 2.380';
          if(document.getElementById('kpi-roi')) document.getElementById('kpi-roi').textContent='18,4%';
        }catch(e){}
        if(typeof buildEvoChart==='function') buildEvoChart('today');
        if(typeof buildMethodCategoryChart==='function') buildMethodCategoryChart();
        if(typeof buildDashboardPieChart==='function') buildDashboardPieChart();
        // Inject notas demo pra anotações
        try{
          window.NOTES = [
            {id:'n1',title:'Surebet · 28/05',body:'Bet365 demorou pra aceitar. Tentar Pinnacle primeiro nas próximas surebets.',color:'green',date:Date.now()-3*86400000},
            {id:'n2',title:'Freebet · 25/05',body:'Stake virou R$ 50 quando devia ser R$ 30. Cuidado com calculadora em odds altas.',color:'yellow',date:Date.now()-6*86400000},
            {id:'n3',title:'iGaming · 22/05',body:'Voltei pro iGaming, R$ 400 abaixo em 1 noite. Cortar de vez.',color:'red',date:Date.now()-9*86400000},
            {id:'n4',title:'Stake · 20/05',body:'Boa sequência em over 2.5. Manter padrão até dar 10 apostas pra avaliar.',color:'blue',date:Date.now()-11*86400000}
          ];
          if(typeof notesRender==='function') notesRender();
        }catch(e){}
        // Reports charts
        try{ if(typeof initReportCharts==='function') setTimeout(initReportCharts,150); }catch(e){}
        // Esconde sidebar pra screenshot ficar focado no conteúdo
        var sb=document.getElementById('sidebar'); if(sb) sb.style.display='none';
        var bc=document.querySelector('.topbar-breadcrumb'); if(bc) bc.textContent='Apostack';
      }catch(err){ console.error('demo error',err); }
    }
    if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',go); else setTimeout(go,200);
  }catch(e){}
})();

// Restaura sessão ao abrir a página (auto-login se já estiver logado)
(async function restoreSession(){
  // Se em modo demo, não restaura sessão
  try{ if(new URLSearchParams(location.search).get('demo')==='1') return; }catch(e){}
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
  // Bloqueia 'afiliado' pra quem nao for VIP nem owner (feature restrita)
  try {
    if (section === 'afiliado'){
      const isVip = localStorage.getItem('bancapro-affiliate-vip') === '1';
      const email = (localStorage.getItem('bancapro-user-email') || '').toLowerCase();
      const isOwner = (typeof OWNER_EMAILS !== 'undefined') && OWNER_EMAILS.indexOf(email) >= 0;
      if (!isVip && !isOwner){
        // Silenciosamente redireciona pro dashboard — nao expoe a feature
        section = 'dashboard';
      }
    }
  } catch(e){}
  // Intercepta navegacao do Free pra features Pro: mostra upsell modal
  try {
    const label = (typeof getCurrentPlanLabel === 'function') ? getCurrentPlanLabel() : 'Free';
    if (label === 'Free' && PRO_LOCKED_SECTIONS.indexOf(section) >= 0){
      openProUpsellModal(section);
      return;
    }
  } catch(e){}
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
  const labels = {dashboard:'Dashboard',methods:'Categoria',transactions:'Transações',accounts:'Contas Depositadas',recharge:'Assinatura',reports:'Relatórios',goals:'Metas',compare:'Comparativo',calculadora:'Calculadora',anotacoes:'Anotações',ranking:'Ranking',settings:'Configurações',help:'Ajuda',admin:'Admin',afiliado:'Minhas Indicações',afiliados:'Afiliados',personalizar:'Personalizar'};
  var _bc = document.getElementById('breadcrumb'); if(_bc) _bc.textContent = labels[section] || section;
  closeSidebar();
  if(section === 'reports') setTimeout(initReportCharts, 100);
  if(section === 'compare') setTimeout(initCompareChart, 100);
  if(section === 'methods') setTimeout(initMethodEvolution, 100);
  if(section === 'ranking') setTimeout(function(){ if(typeof renderUserRanking==='function') renderUserRanking(); }, 60);
  else if(typeof rankStopLivePolling === 'function') rankStopLivePolling(); // para polling ao sair da aba ranking
  if(section === 'dashboard') setTimeout(function(){ if(typeof rankUpdateDashCard==='function') rankUpdateDashCard(); }, 100);
  if(section === 'recharge') setTimeout(updateTrialBanner, 50);
  if(section === 'settings') { setTimeout(renderSubscriptionCard, 50); setTimeout(applyAvatar, 50); }
  if(section === 'personalizar') setTimeout(renderCardCustomizer, 50);
  if(section === 'admin') setTimeout(() => { renderAdminStats(); renderAdminUsers(); renderRankingModeration(); renderAdminErrors(); }, 50);
  // Recalcula banners/avisos do trial pra evitar duplicacao em features Pro
  setTimeout(() => { if (typeof updateAllUpgradeUI === 'function') updateAllUpgradeUI(); }, 30);
  if(section === 'afiliados') setTimeout(() => { renderAffiliatesAdmin(); renderWithdrawalsAdmin(); if (typeof renderAffWithdrawalsAdmin === 'function') renderAffWithdrawalsAdmin(); }, 50);
  if(section === 'afiliado')  setTimeout(renderMyAffiliatePanel, 50);
  if(section === 'calculadora') setTimeout(calcInit, 50);
  if(section === 'anotacoes') setTimeout(notesInit, 50);
  // Sincroniza o estado ativo da bottom tab bar mobile
  if (typeof updateMobileTabActive === 'function') setTimeout(updateMobileTabActive, 30);
}

// ══════════════════════════════════════════════
//  CUSTOMIZAR CARDS — cada card individual pode ser escondido
//  pelo usuario nas Configuracoes. Salvo em localStorage.
//  Estilo widgets do iOS — voce escolhe o que aparece.
// ══════════════════════════════════════════════

// Catalogo de cards customizaveis — agrupados por secao
// icon: SVG path | accent: cor do icone | desc: subtitulo curto
var CARDS_CATALOG = [
  { section: 'Dashboard', sectionIcon: 'home', items: [
    {
      key: 'dash-stats',
      title: 'Mini-stats',
      desc: 'Receita, Lucro Hoje/7d/30d, Categorias, Transações, Metas',
      icon: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
      accent: '#22d3ee'
    },
    {
      key: 'dash-rank',
      title: 'Sua posição no Ranking',
      desc: 'Card com sua colocação atual e streak',
      icon: '<path d="M8 21h8M12 17v4M7 4h10v6a5 5 0 01-10 0V4z"/>',
      accent: '#f59e0b'
    },
    {
      key: 'dash-evo',
      title: 'Evolução Financeira',
      desc: 'Gráfico principal de saldo/lucro ao longo do tempo',
      icon: '<path d="M3 17l6-6 4 4 8-9"/><path d="M14 6h7v7"/>',
      accent: '#6366f1'
    },
    {
      key: 'dash-categoria',
      title: 'Por Categoria',
      desc: 'Gráfico de barras comparando categorias',
      icon: '<path d="M4 21V8M10 21V4M16 21V12M22 21H2"/>',
      accent: '#ec4899'
    }
  ]},
  { section: 'Categoria', sectionIcon: 'briefcase', items: [
    {
      key: 'met-ranking',
      title: 'Ranking de Categorias',
      desc: 'Top categorias mais lucrativas do mês',
      icon: '<path d="M8 21h8M12 17v4M7 4h10v6a5 5 0 01-10 0V4z"/>',
      accent: '#fbbf24'
    },
    {
      key: 'met-grid',
      title: 'Cards de Categorias',
      desc: 'Cards individuais de cada categoria (Futebol, Basquete, Tênis...)',
      icon: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
      accent: '#a78bfa'
    },
    {
      key: 'met-evo',
      title: 'Evolução por Categoria',
      desc: 'Gráfico de cada categoria ao longo dos meses',
      icon: '<path d="M3 17l6-6 4 4 8-9"/>',
      accent: '#10b981'
    }
  ]},
  { section: 'Relatórios', sectionIcon: 'chart', items: [
    {
      key: 'rep-evo',
      title: 'Receita vs Despesas vs Lucro',
      desc: 'Evolução mensal completa em gráfico de linha',
      icon: '<path d="M3 3v18h18"/><path d="M7 14l4-4 4 4 5-6"/>',
      accent: '#3b82f6'
    },
    // rep-heatmap removido temporariamente do catalog enquanto o card
    // fica oculto em producao (feature flag _isHeatmapEnabled em script.js).
    // Quando liberar, descomentar:
    // {
    //   key: 'rep-heatmap',
    //   title: 'Calendário de Atividade',
    //   desc: 'Heatmap dos últimos 6 meses — apostas ou lucro por dia',
    //   icon: '<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
    //   accent: '#10b981'
    // },
    {
      key: 'rep-despesas',
      title: 'Distribuição de Despesas',
      desc: 'Donut com % de despesas por categoria',
      icon: '<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 019 9"/>',
      accent: '#ef4444'
    },
    {
      key: 'rep-lucro',
      title: 'Distribuição de Lucro',
      desc: 'Donut com % de lucro por categoria',
      icon: '<circle cx="12" cy="12" r="9"/><path d="M3 12a9 9 0 0118 0"/>',
      accent: '#f59e0b'
    }
  ]},
  { section: 'Comparativo', sectionIcon: 'compare', items: [
    {
      key: 'cmp-kpis',
      title: 'KPIs Comparativos',
      desc: 'Receita, Lucro, Despesas e ROI mês a mês',
      icon: '<rect x="3" y="12" width="4" height="8" rx="1"/><rect x="10" y="6" width="4" height="14" rx="1"/><rect x="17" y="3" width="4" height="17" rx="1"/>',
      accent: '#22d3ee'
    },
    {
      key: 'cmp-chart',
      title: 'Comparativo por Categoria',
      desc: 'Gráfico de barras mês anterior vs atual',
      icon: '<path d="M3 6h7M3 12h11M3 18h6"/><path d="M17 4l4 4-4 4"/>',
      accent: '#a78bfa'
    },
    {
      key: 'cmp-detail',
      title: 'Análise Detalhada',
      desc: 'Lista expandida com barras por categoria',
      icon: '<path d="M4 6h16M4 12h16M4 18h10"/>',
      accent: '#ec4899'
    }
  ]}
];

// Cards que ficam desligados por padrao (usuario ativa em Personalizar se quiser)
var DEFAULT_HIDDEN_CARDS = ['dash-categoria'];

function getHiddenCards(){
  try {
    var raw = localStorage.getItem('bancapro-hidden-cards');
    if (raw === null){
      // Primeira vez do usuario — aplica os defaults
      localStorage.setItem('bancapro-hidden-cards', JSON.stringify(DEFAULT_HIDDEN_CARDS));
      return DEFAULT_HIDDEN_CARDS.slice();
    }
    return JSON.parse(raw);
  } catch(e){ return DEFAULT_HIDDEN_CARDS.slice(); }
}
function setHiddenCards(list){
  try { localStorage.setItem('bancapro-hidden-cards', JSON.stringify(list)); } catch(e){}
}
function isCardHidden(key){
  return getHiddenCards().indexOf(key) >= 0;
}
function applyCardVisibility(){
  var hidden = getHiddenCards();
  // Mostra todos primeiro
  document.querySelectorAll('[data-card]').forEach(function(el){
    el.classList.remove('card-hidden');
  });
  // Esconde os que estao na lista
  hidden.forEach(function(key){
    document.querySelectorAll('[data-card="' + key + '"]').forEach(function(el){
      el.classList.add('card-hidden');
    });
  });
}
function toggleCardVisibility(key){
  var hidden = getHiddenCards();
  var idx = hidden.indexOf(key);
  var willBeOn = idx >= 0; // se estava hidden, vai ficar ON
  if (idx >= 0) hidden.splice(idx, 1);
  else hidden.push(key);
  setHiddenCards(hidden);
  applyCardVisibility();
  // Atualiza o switch + card parent visual
  var sw = document.querySelector('[data-card-toggle="' + key + '"]');
  if (sw){
    sw.classList.toggle('is-on', willBeOn);
    var card = sw.closest('.cust-card');
    if (card){
      card.classList.toggle('is-on', willBeOn);
      card.classList.toggle('is-off', !willBeOn);
    }
  }
  if (typeof showToast === 'function'){
    showToast(willBeOn ? 'Card mostrado' : 'Card escondido', 'info');
  }
}
function renderCardCustomizer(){
  var container = document.getElementById('cardCustomizerList');
  if (!container) return;
  var hidden = getHiddenCards();
  var html = '';
  CARDS_CATALOG.forEach(function(group){
    // Header da secao com pill
    html += '<div class="cust-section">'
          + '  <div class="cust-section-pill">' + group.section + '</div>'
          + '</div>';
    // Cards individuais
    group.items.forEach(function(it){
      var isOn = hidden.indexOf(it.key) < 0;
      html += '<div class="cust-card ' + (isOn ? 'is-on' : 'is-off') + '" onclick="toggleCardVisibility(\'' + it.key + '\')">'
            + '  <div class="cust-card-icon" style="background:' + it.accent + '20;color:' + it.accent + '">'
            + '    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + it.icon + '</svg>'
            + '  </div>'
            + '  <div class="cust-card-text">'
            + '    <div class="cust-card-title">' + it.title + '</div>'
            + '    <div class="cust-card-desc">' + it.desc + '</div>'
            + '  </div>'
            + '  <div class="cust-switch ' + (isOn ? 'is-on' : '') + '" data-card-toggle="' + it.key + '"></div>'
            + '</div>';
    });
  });
  container.innerHTML = html;
}
// Aplica visibilidade ao carregar
document.addEventListener('DOMContentLoaded', applyCardVisibility);
if (document.readyState !== 'loading') applyCardVisibility();

// ══════════════════════════════════════════════
//  MOBILE NAV — Bottom Tab Bar + "Mais" Action Sheet
//  Faz a versao mobile sentir como app nativo.
//  Mapeia atalhos da tabbar pras secoes internas, mantem o estado ativo.
// ══════════════════════════════════════════════
function mobileNav(tab){
  // Mapeia label da tab pra secao real do app
  var map = {
    dashboard: 'dashboard',
    ranking:   'ranking',
    afiliado:  'afiliado',
    transactions: 'transactions',
    methods:    'methods',
    accounts:   'accounts',
    settings:   'settings',
    anotacoes:  'anotacoes',
    goals:      'goals',
    reports:    'reports',
    compare:    'compare',
    calc:       'calculadora',
    afiliados:  'afiliados',
    admin:      'admin',
    recharge:   'recharge',
    personalizar: 'personalizar',
    help:       'help'
  };
  var sec = map[tab] || tab;
  // Fecha sheet "Mais" se estiver aberta
  closeMobileMoreSheet();
  // Navega pra secao
  if (typeof goTo === 'function') goTo(sec);
  // Atualiza estado ativo da tabbar
  setTimeout(updateMobileTabActive, 30);
}

function updateMobileTabActive(){
  // Marca o item ativo da tabbar com base na secao ativa atual
  var active = document.querySelector('.section.active');
  var secId = active ? active.id : '';
  var tab = '';
  if (secId === 'sec-dashboard') tab = 'dashboard';
  else if (secId === 'sec-ranking') tab = 'ranking';
  else if (secId === 'sec-afiliado') tab = 'afiliado';
  document.querySelectorAll('.mt-item').forEach(function(el){
    if (el.getAttribute('data-tab') === tab) el.classList.add('is-active');
    else el.classList.remove('is-active');
  });
}

function mobileNavMore(){
  // Garante que a sheet exista no DOM (criada lazy na 1a vez)
  var sheet = document.getElementById('mobileMoreSheet');
  if (!sheet){
    sheet = document.createElement('div');
    sheet.id = 'mobileMoreSheet';
    sheet.className = 'mobile-more-sheet';
    sheet.innerHTML = ''
      + '<div class="mms-card" onclick="event.stopPropagation()">'
      + '  <div class="mms-handle"></div>'
      + '  <div class="mms-title">Mais opções</div>'
      + '  <button class="mms-item" onclick="mobileNav(\'transactions\')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7h18M3 12h18M3 17h18"/></svg>Transações</button>'
      + '  <button class="mms-item" onclick="mobileNav(\'methods\')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="3"/><path d="M3 10h18"/></svg>Categoria</button>'
      + '  <button class="mms-item" onclick="mobileNav(\'accounts\')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2h14a2 2 0 002-2v-2"/><path d="M16 12h5"/></svg>Contas Depositadas</button>'
      + '  <button class="mms-item" onclick="mobileNav(\'goals\')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5"/></svg>Metas</button>'
      + '  <button class="mms-item" onclick="mobileNav(\'reports\')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="M7 14l4-4 4 4 5-6"/></svg>Relatórios</button>'
      + '  <button class="mms-item" onclick="mobileNav(\'compare\')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h7M3 12h11M3 18h6"/><path d="M17 4l4 4-4 4"/></svg>Comparativo</button>'
      + '  <button class="mms-item" onclick="mobileNav(\'calc\')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 7h8M8 11h2M12 11h2M16 11h0M8 15h2M12 15h2M16 15h0M8 19h2M12 19h2M16 19h0"/></svg>Calculadora</button>'
      + '  <button class="mms-item" onclick="mobileNav(\'anotacoes\')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h12l4 4v12H4z"/><path d="M16 4v4h4M8 12h8M8 16h6"/></svg>Anotações</button>'
      + '  <button class="mms-item" onclick="mobileNav(\'settings\')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3h0a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8v0a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z"/></svg>Configurações</button>'
      + '  <button class="mms-item" onclick="mobileNav(\'help\')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 015.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>Ajuda</button>'
      + '  <button class="mms-item mms-item-accent" onclick="mobileNav(\'personalizar\')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l2.4 4.8L20 9l-4 4 .9 5.5L12 16l-4.9 2.5L8 13 4 9l5.6-1.2z"/></svg>Personalizar</button>'
      + '  <button class="mms-item mms-item-pro" onclick="mobileNav(\'recharge\')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l3 6 7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1z"/></svg>Assinatura</button>'
      + '  <div class="mms-divider" id="mmsOwnerDivider" style="display:none"></div>'
      + '  <button class="mms-item mms-item-owner" id="mmsAdmin" onclick="mobileNav(\'admin\')" style="display:none"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l8 4v6c0 5-3.5 9-8 10-4.5-1-8-5-8-10V6l8-4z"/><path d="M9 12l2 2 4-4"/></svg>Admin</button>'
      + '  <button class="mms-item mms-item-owner" id="mmsAfiliadosOwner" onclick="mobileNav(\'afiliados\')" style="display:none"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.5"/><path d="M2 21c1-4 4-6 7-6s6 2 7 6"/><circle cx="17" cy="7" r="2.5"/><path d="M22 15c-.5-2-2-3.5-4-3.5"/></svg>Afiliados</button>'
      + '  <div class="mms-divider"></div>'
      + '  <button class="mms-item is-danger" onclick="closeMobileMoreSheet(); if(typeof logout===\'function\') logout();"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><path d="M16 17l5-5-5-5M21 12H9"/></svg>Sair da conta</button>'
      + '</div>';
    sheet.addEventListener('click', closeMobileMoreSheet);
    document.body.appendChild(sheet);
  }
  // Mostra Admin/Afiliados SO se for owner (verifica toda vez que abre o sheet)
  try {
    const email = (localStorage.getItem('bancapro-user-email') || '').toLowerCase();
    const isOwner = (typeof OWNER_EMAILS !== 'undefined') && OWNER_EMAILS.indexOf(email) >= 0;
    const admBtn = document.getElementById('mmsAdmin');
    const afoBtn = document.getElementById('mmsAfiliadosOwner');
    const divider = document.getElementById('mmsOwnerDivider');
    if (admBtn) admBtn.style.display = isOwner ? '' : 'none';
    if (afoBtn) afoBtn.style.display = isOwner ? '' : 'none';
    if (divider) divider.style.display = isOwner ? '' : 'none';
  } catch(e){}
  sheet.classList.add('is-open');
}

function closeMobileMoreSheet(){
  var sh = document.getElementById('mobileMoreSheet');
  if (sh) sh.classList.remove('is-open');
}

// Inicia o estado ativo da tabbar assim que o app carrega
document.addEventListener('DOMContentLoaded', function(){
  setTimeout(updateMobileTabActive, 200);
});

function setPeriod(p, el) {
  currentPeriod = p;
  document.querySelectorAll('.period-tab').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
  // Filtra transações de acordo com o período e atualiza os 4 KPIs
  applyPeriodToKPIs(p);
  // Sincroniza o filtro do grafico (Evolucao Financeira) com o do topo
  try {
    const evoMode = { day:'today', week:'7d', month:'30d', year:'yearly' }[p];
    if (evoMode){
      const btn = document.querySelector('.evo-btn[data-mode="'+evoMode+'"]');
      if (btn && typeof setEvoMode === 'function') setEvoMode(evoMode, btn);
    }
  } catch(e){}
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

  // Atualiza subtítulos pra contexto (texto adaptado ao periodo)
  const periodSuffix = {
    'day':   { lucro:'Lucro hoje',                  desp:'Despesas hoje',                  roi:'Retorno médio hoje'         },
    'week':  { lucro:'Lucro nos últimos 7 dias',    desp:'Despesas nos últimos 7 dias',    roi:'Retorno médio em 7 dias'    },
    'month': { lucro:'Lucro nos últimos 30 dias',   desp:'Despesas nos últimos 30 dias',   roi:'Retorno médio em 30 dias'   },
    'year':  { lucro:'Lucro no ano atual',          desp:'Despesas no ano atual',          roi:'Retorno médio no ano atual' }
  }[p] || { lucro:'Lucro nos últimos 30 dias', desp:'Despesas nos últimos 30 dias', roi:'Retorno médio em 30 dias' };
  const subSaldo = document.getElementById('kpi-saldo-sub');
  if(subSaldo) subSaldo.textContent = (SALDO_BASE > 0 ? 'Banca: ' + fmtBRL(SALDO_BASE) : 'Saldo atual da banca');
  const subLucro = document.getElementById('kpi-lucro-sub');
  if(subLucro) subLucro.textContent = periodSuffix.lucro;
  const subDespesas = document.getElementById('kpi-despesas-sub');
  if(subDespesas) subDespesas.textContent = periodSuffix.desp;
  const subRoi = document.getElementById('kpi-roi-sub');
  if(subRoi) subRoi.textContent = periodSuffix.roi;
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
//  USER MENU (dropdown no rodape da sidebar)
// ══════════════════════════════════════════════
function toggleUserMenu(e) {
  if (e) e.stopPropagation();
  const menu = document.getElementById('userMenu');
  const pill = document.getElementById('userPill');
  if (!menu) return;
  const isOpen = menu.classList.toggle('open');
  if (pill) pill.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
}
function closeUserMenu() {
  const menu = document.getElementById('userMenu');
  const pill = document.getElementById('userPill');
  if (menu) menu.classList.remove('open');
  if (pill) pill.setAttribute('aria-expanded', 'false');
}
// Fecha o menu ao clicar fora ou apertar Esc
document.addEventListener('click', function(e){
  const menu = document.getElementById('userMenu');
  const pill = document.getElementById('userPill');
  if (!menu || !menu.classList.contains('open')) return;
  if (pill && pill.contains(e.target)) return;
  if (menu.contains(e.target)) return;
  closeUserMenu();
});
document.addEventListener('keydown', function(e){
  if (e.key === 'Escape') closeUserMenu();
});

// ══════════════════════════════════════════════
//  TOUR / PASSO-A-PASSO (onboarding)
// ══════════════════════════════════════════════
const TOUR_STEPS = [
  // ===== DASHBOARD =====
  {
    selector: '.kpi-grid',
    title: 'Seus 4 indicadores principais',
    desc: 'Saldo, lucro, despesas e ROI atualizados em tempo real. O coração do painel.',
    section: 'dashboard'
  },
  {
    selector: '.period-tabs',
    title: 'Filtre por período',
    desc: 'Veja seus números de Hoje, Semana, Mês ou Ano. Cada filtro recalcula tudo automaticamente.',
    section: 'dashboard'
  },
  {
    selector: '#mainChartWrap',
    title: 'Evolução Financeira',
    desc: 'Acompanhe sua banca subindo (ou descendo) no gráfico. Tabs internas: Hoje, 7 Dias, 30 Dias, Anual e Personalizado.',
    section: 'dashboard'
  },
  {
    selector: '.txbtn',
    title: 'Nova Transação',
    desc: 'O botão mais importante. Registre cada depósito, saque ou resultado aqui. É o que alimenta todo o painel.',
    section: 'dashboard'
  },
  // ===== MÉTODOS =====
  {
    selector: '#sec-methods .page-header',
    title: 'Gestão de Categoria',
    desc: 'Acompanhe a performance de cada esporte: Futebol, Basquete, Tênis, MMA/UFC, E-sports, Cassino. Ranking e gráfico mostram em qual você lucra mais.',
    section: 'methods'
  },
  // ===== TRANSAÇÕES =====
  {
    selector: '#sec-transactions .page-header',
    title: 'Transações',
    desc: 'Histórico completo de tudo que entrou e saiu da banca. Filtre por data, método ou tipo. Exporte PDF ou Excel.',
    section: 'transactions'
  },
  // ===== CONTAS DEPOSITADAS =====
  {
    selector: '#sec-accounts .page-header',
    title: 'Contas Depositadas',
    desc: 'Saldo individual por casa de aposta (Bet365, Betano, Pinnacle, etc). Não esqueça dinheiro parado em casa nenhuma.',
    section: 'accounts'
  },
  // ===== RELATÓRIOS =====
  {
    selector: '#sec-reports .page-header',
    title: 'Relatórios',
    desc: 'Análise completa com filtros de período (7d, 30d, 90d, ano, tudo ou personalizado) e categoria: Receita vs Despesa, Distribuição e ROI por categoria. Exporte em PDF ou Excel.',
    section: 'reports'
  },
  // ===== METAS =====
  {
    selector: '#sec-goals .page-header',
    title: 'Sistema de Metas',
    desc: 'Defina objetivos por método ou geral. A Apostack mostra seu progresso e quanto falta pra bater.',
    section: 'goals'
  },
  // ===== COMPARATIVO =====
  {
    selector: '#sec-compare .page-header',
    title: 'Comparativo Mensal',
    desc: 'Compare o mês atual com o anterior: receita, lucro, despesas e ROI. Veja onde melhorou e onde piorou.',
    section: 'compare'
  },
  // ===== CALCULADORA =====
  {
    selector: '#sec-calculadora .page-header',
    title: 'Calculadora',
    desc: 'Surebet, stake e proteção de duplo. Coloca os dados, ela faz a conta. Zero erro de divisão.',
    section: 'calculadora'
  },
  // ===== ANOTAÇÕES =====
  {
    selector: '#sec-anotacoes .page-header',
    title: 'Anotações',
    desc: 'Suas notas, estratégias e lembretes. Aquela aposta que deu errado e você quer lembrar pra não repetir? Anota aqui.',
    section: 'anotacoes'
  },
  // ===== CONFIGURAÇÕES =====
  {
    selector: '#sec-settings .page-header',
    title: 'Configurações',
    desc: 'Personalize a plataforma, troque sua foto, mude o tema, gerencie sua assinatura e acesse o suporte.',
    section: 'settings'
  }
];

let currentTourStep = 0;

function startTour() {
  if (typeof goTo === 'function') goTo('dashboard', null);
  currentTourStep = 0;
  document.getElementById('tourBackdrop').hidden = false;
  document.getElementById('tourSpotlight').hidden = false;
  document.getElementById('tourTooltip').hidden = false;
  setTimeout(function(){ showTourStep(0); }, 300);
}

function showTourStep(idx) {
  const step = TOUR_STEPS[idx];
  if (!step) return closeTour();
  if (step.section && typeof goTo === 'function') {
    const activeSec = document.querySelector('.section.active');
    if (!activeSec || activeSec.id !== 'sec-' + step.section) {
      goTo(step.section, null);
    }
  }
  const target = document.querySelector(step.selector);
  if (!target) {
    return setTimeout(function(){ currentTourStep++; showTourStep(currentTourStep); }, 200);
  }
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  setTimeout(function(){ positionTour(target, step, idx); }, 350);
}

function positionTour(target, step, idx) {
  const rect = target.getBoundingClientRect();
  const padding = 10;
  const spot = document.getElementById('tourSpotlight');
  spot.style.top = (rect.top - padding) + 'px';
  spot.style.left = (rect.left - padding) + 'px';
  spot.style.width = (rect.width + padding * 2) + 'px';
  spot.style.height = (rect.height + padding * 2) + 'px';

  document.getElementById('tourTag').textContent = 'PASSO ' + (idx + 1) + ' DE ' + TOUR_STEPS.length;
  document.getElementById('tourTitle').textContent = step.title;
  document.getElementById('tourDesc').textContent = step.desc;
  document.getElementById('tourProgressBar').style.width = ((idx + 1) / TOUR_STEPS.length * 100) + '%';
  document.getElementById('tourNextBtn').textContent = (idx === TOUR_STEPS.length - 1) ? 'Concluir ✓' : 'Próximo ›';

  const tooltip = document.getElementById('tourTooltip');
  const tooltipW = tooltip.offsetWidth || 340;
  const tooltipH = tooltip.offsetHeight || 220;
  const margin = 20;
  const vw = window.innerWidth, vh = window.innerHeight;

  // Tenta colocar à direita; se não couber, à esquerda; senão, embaixo
  let left, top;
  if (rect.right + margin + tooltipW <= vw) {
    left = rect.right + margin;
    top = rect.top + (rect.height / 2) - (tooltipH / 2);
  } else if (rect.left - margin - tooltipW >= 0) {
    left = rect.left - margin - tooltipW;
    top = rect.top + (rect.height / 2) - (tooltipH / 2);
  } else if (rect.bottom + margin + tooltipH <= vh) {
    left = Math.max(margin, Math.min(rect.left, vw - tooltipW - margin));
    top = rect.bottom + margin;
  } else {
    left = Math.max(margin, Math.min(rect.left, vw - tooltipW - margin));
    top = Math.max(margin, rect.top - tooltipH - margin);
  }
  top = Math.max(margin, Math.min(top, vh - tooltipH - margin));
  tooltip.style.left = left + 'px';
  tooltip.style.top = top + 'px';
}

function nextTourStep() {
  currentTourStep++;
  if (currentTourStep >= TOUR_STEPS.length) return closeTour();
  showTourStep(currentTourStep);
}

function closeTour() {
  document.getElementById('tourBackdrop').hidden = true;
  document.getElementById('tourSpotlight').hidden = true;
  document.getElementById('tourTooltip').hidden = true;
  try { localStorage.setItem(onboardingKey('bancapro-tour-done'), '1'); } catch(e){}
}

function maybeStartTour() {
  try {
    // Se ja marcado como visto, nao mostra
    if (localStorage.getItem(onboardingKey('bancapro-tour-done')) === '1') return;
    // Veteranos: usuario que ja tem 3+ transacoes claramente nao precisa
    // de tour (ja entendeu o app). Marca como visto silenciosamente
    // pra nao incomodar nas proximas sessoes.
    let txCount = 0;
    if (typeof transactions !== 'undefined' && Array.isArray(transactions)) txCount = transactions.length;
    else { try { txCount = (JSON.parse(localStorage.getItem('bancapro-transactions') || '[]')||[]).length; } catch(e){} }
    if (txCount >= 3){
      try { localStorage.setItem(onboardingKey('bancapro-tour-done'), '1'); } catch(e){}
      return;
    }
    // Usuario novo (zero ou poucas transacoes) — mostra o tour.
    // Se welcome modal estiver aberto, espera ele fechar — senao briga de
    // z-index faz o welcome tapar o tour e o user nao ve nada.
    function tryStart(){
      const w = document.getElementById('welcomeModal');
      const welcomeOpen = w && getComputedStyle(w).display !== 'none';
      if (welcomeOpen) {
        setTimeout(tryStart, 500);
        return;
      }
      startTour();
    }
    setTimeout(tryStart, 1500);
  } catch(e){}
}

// Reposiciona o tour quando a janela for redimensionada
window.addEventListener('resize', function(){
  if (document.getElementById('tourTooltip') && !document.getElementById('tourTooltip').hidden) {
    showTourStep(currentTourStep);
  }
});

// ══════════════════════════════════════════════
//  AVATAR / FOTO DE PERFIL
// ══════════════════════════════════════════════
const AVATAR_KEY = 'bancapro-avatar';

function getAvatarInitial() {
  const v = document.getElementById('settingsUserName')?.value;
  const t = document.getElementById('sidebarUserName')?.textContent;
  const src = (v || t || 'A').trim();
  return (src[0] || 'A').toUpperCase();
}

function applyAvatar() {
  let dataUrl = null;
  try { dataUrl = localStorage.getItem(AVATAR_KEY); } catch(e){}
  // Avatar no rodape da sidebar
  const sb = document.querySelector('.user-pill .user-avatar');
  if (sb) {
    if (dataUrl) {
      sb.style.backgroundImage = 'url('+dataUrl+')';
      sb.style.backgroundSize = 'cover';
      sb.style.backgroundPosition = 'center';
      sb.textContent = '';
    } else {
      sb.style.backgroundImage = '';
      sb.textContent = getAvatarInitial();
    }
  }
  // Preview na pagina Configuracoes
  const img = document.getElementById('profileAvatarImg');
  const fallback = document.getElementById('profileAvatarFallback');
  const removeBtn = document.getElementById('avatarRemoveBtn');
  if (img && fallback) {
    if (dataUrl) {
      img.src = dataUrl;
      img.style.display = 'block';
      fallback.style.display = 'none';
      if (removeBtn) removeBtn.style.display = '';
    } else {
      img.removeAttribute('src');
      img.style.display = 'none';
      fallback.style.display = '';
      fallback.textContent = getAvatarInitial();
      if (removeBtn) removeBtn.style.display = 'none';
    }
  }
}

function handleAvatarUpload(e) {
  const file = e.target?.files?.[0];
  if (!file) return;
  if (file.size > 2 * 1024 * 1024) {
    alert('Imagem muito grande. Maximo 2 MB.');
    e.target.value = '';
    return;
  }
  const reader = new FileReader();
  reader.onload = function(ev) {
    const img = new Image();
    img.onload = function() {
      // Redimensiona pra 256x256 max (mantem proporcao) e converte pra jpeg leve
      const MAX = 256;
      let w = img.naturalWidth, h = img.naturalHeight;
      if (w >= h) { if (w > MAX) { h = Math.round(h * (MAX/w)); w = MAX; } }
      else { if (h > MAX) { w = Math.round(w * (MAX/h)); h = MAX; } }
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      let dataUrl;
      try { dataUrl = c.toDataURL('image/jpeg', 0.85); } catch(err) {
        alert('Nao foi possivel processar a imagem: ' + err.message);
        return;
      }
      try { localStorage.setItem(AVATAR_KEY, dataUrl); } catch(err) {
        alert('Sem espaco para salvar a foto. Tente uma imagem menor.');
        return;
      }
      applyAvatar();
      if (typeof schedulePush === 'function') schedulePush();
    };
    img.onerror = function(){ alert('Nao consegui ler essa imagem. Tente outra.'); };
    img.src = ev.target.result;
  };
  reader.onerror = function(){ alert('Erro ao ler o arquivo.'); };
  reader.readAsDataURL(file);
  // Limpa o input pra permitir reupload da mesma foto
  e.target.value = '';
}

function removeAvatar() {
  try { localStorage.removeItem(AVATAR_KEY); } catch(e){}
  applyAvatar();
  if (typeof schedulePush === 'function') schedulePush();
}

// Carrega o avatar no startup e quando voltar ao app
document.addEventListener('DOMContentLoaded', applyAvatar);

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

  // 3) Trial: dias restantes (usa helper que prioriza user.created_at)
  try {
    const d = getTrialStartDate();
    if(d) {
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

  // 5) Streak em risco — prioridade máxima
  try {
    if (typeof rankComputeStreak === 'function'){
      const sk = rankComputeStreak();
      if (sk.atRisk && sk.current > 0){
        items.unshift({
          icon:'⚠️', bg:'rgba(245,158,11,0.18)',
          text:`<strong>Sua sequência de ${sk.current} ${sk.current===1?'dia':'dias'} está em risco!</strong> Registre uma transação hoje pra manter o streak.`,
          time:'agora'
        });
      } else if (sk.current === 7 || sk.current === 14 || sk.current === 30 || sk.current === 60 || sk.current === 100){
        items.push({
          icon: sk.current >= 30 ? '👑' : '🔥', bg:'rgba(251,146,60,0.14)',
          text:`<strong>${sk.current} dias seguidos!</strong> ${sk.current >= 30 ? 'Você virou um lendário do streak.' : 'Continue assim — você está construindo o hábito.'}`,
          time:'recente'
        });
      }
    }
  } catch(e){}

  // 6) Tier atual + progresso pro próximo
  try {
    let profit = 0;
    for (let i = 0; i < transactions.length; i++){
      const t = transactions[i]; const v = Number(t.value) || 0;
      if (t.type === 'income') profit += v; else if (t.type === 'expense') profit -= v;
    }
    profit = Math.max(0, Math.round(profit));
    if (profit > 0 && typeof rankComputeCurrent === 'function'){
      const { current, next } = rankComputeCurrent(profit);
      if (next){
        const remaining = next.min - profit;
        const pct = ((profit - current.min) / (next.min - current.min) * 100).toFixed(0);
        items.push({
          icon:'🏆', bg:'rgba(124,92,255,0.12)',
          text:`<strong>Tier atual: ${current.name}</strong> — ${pct}% pra ${next.name}. Faltam R$ ${remaining.toLocaleString('pt-BR')}.`,
          time:'agora'
        });
      } else {
        items.push({
          icon:'⭐', bg:'rgba(250,204,21,0.14)',
          text:`<strong>Tier máximo: ${current.name}!</strong> Você é o topo absoluto do ranking.`,
          time:'agora'
        });
      }
    }
  } catch(e){}

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
// ID da transacao sendo editada (null = criacao nova)
let _editingTxId = null;

// ══════════════════════════════════════════════
//  COMPROVANTES — anexo de imagem por transação
//  - 1 imagem por tx (igual Mobills)
//  - Comprime automatico (max 1024px, JPEG 0.75) ~80KB por imagem
//  - Armazena como base64 dentro da tx.attachment
//  - Fullscreen ao clicar
// ══════════════════════════════════════════════

// Buffer do comprovante da tx atualmente sendo cadastrada/editada (base64 data URL)
let _pendingTxAttachment = null;

const TX_ATTACHMENT_MAX_DIM = 1024;
const TX_ATTACHMENT_QUALITY = 0.75;
const TX_ATTACHMENT_MAX_INPUT_SIZE = 5 * 1024 * 1024; // 5MB

async function handleTxAttachment(event){
  const file = event.target.files && event.target.files[0];
  if (!file) return;
  if (file.size > TX_ATTACHMENT_MAX_INPUT_SIZE){
    showToast('Imagem muito grande. Limite: 5MB.', 'error');
    event.target.value = '';
    return;
  }
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)){
    showToast('Use uma imagem JPG, PNG ou WEBP.', 'error');
    event.target.value = '';
    return;
  }
  try {
    showToast('Comprimindo imagem…', 'info');
    const compressed = await _compressImage(file);
    _pendingTxAttachment = compressed;
    _renderTxAttachmentUI();
    showToast('Comprovante anexado!', 'success');
  } catch(e){
    console.warn('handleTxAttachment', e);
    showToast('Não foi possível processar a imagem.', 'error');
  }
  event.target.value = '';
}

function _compressImage(file){
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('read error'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('image load error'));
      img.onload = () => {
        try {
          let { width, height } = img;
          if (width > TX_ATTACHMENT_MAX_DIM || height > TX_ATTACHMENT_MAX_DIM){
            const ratio = Math.min(TX_ATTACHMENT_MAX_DIM / width, TX_ATTACHMENT_MAX_DIM / height);
            width = Math.round(width * ratio);
            height = Math.round(height * ratio);
          }
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, width, height);
          const dataUrl = canvas.toDataURL('image/jpeg', TX_ATTACHMENT_QUALITY);
          resolve(dataUrl);
        } catch(e){ reject(e); }
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function _renderTxAttachmentUI(){
  const empty = document.getElementById('txAttachmentEmpty');
  const preview = document.getElementById('txAttachmentPreview');
  const img = document.getElementById('txAttachmentImg');
  const sizeEl = document.getElementById('txAttachmentSize');
  if (!empty || !preview) return;
  if (_pendingTxAttachment){
    empty.style.display = 'none';
    preview.style.display = 'block';
    if (img) img.src = _pendingTxAttachment;
    if (sizeEl){
      // base64 string ~= 4/3 do tamanho real
      const approxBytes = Math.round(_pendingTxAttachment.length * 0.75);
      const kb = (approxBytes / 1024).toFixed(0);
      sizeEl.textContent = `~${kb} KB`;
    }
  } else {
    empty.style.display = 'block';
    preview.style.display = 'none';
    if (img) img.src = '';
  }
}

function removeTxAttachment(){
  _pendingTxAttachment = null;
  _renderTxAttachmentUI();
}

function openTxAttachmentFullscreen(){
  if (!_pendingTxAttachment) return;
  _openAttachmentFullscreen(_pendingTxAttachment);
}

function _openAttachmentFullscreen(dataUrl){
  const wrap = document.getElementById('attachmentFullscreen');
  const img = document.getElementById('attachmentFullscreenImg');
  const dl = document.getElementById('attachmentDownloadBtn');
  if (!wrap || !img) return;
  img.src = dataUrl;
  if (dl) dl.href = dataUrl;
  wrap.style.display = 'flex';
}

function closeAttachmentFullscreen(){
  const wrap = document.getElementById('attachmentFullscreen');
  if (wrap) wrap.style.display = 'none';
}

// Permite ESC fechar fullscreen
document.addEventListener('keydown', e => {
  if (e.key === 'Escape'){
    const wrap = document.getElementById('attachmentFullscreen');
    if (wrap && wrap.style.display !== 'none') closeAttachmentFullscreen();
  }
});

function openTxModal() {
  _editingTxId = null;
  _pendingTxAttachment = null;
  _renderTxAttachmentUI();
  setTxModalMode('create');
  document.getElementById('txType').value = 'income';
  document.getElementById('txValue').value = '';
  document.getElementById('txDesc').value = '';
  document.getElementById('txModal').classList.add('open');
  const today = isoDateLocal();
  const dateInput = document.getElementById('txDate');
  dateInput.value = today;
  dateInput.max = today;
  setTimeout(() => document.getElementById('txValue').focus(), 100);
}
function openTxModalExpense() {
  _editingTxId = null;
  _pendingTxAttachment = null;
  _renderTxAttachmentUI();
  setTxModalMode('create');
  document.getElementById('txType').value = 'expense';
  document.getElementById('txValue').value = '';
  document.getElementById('txDesc').value = '';
  document.getElementById('txModal').classList.add('open');
  const today = isoDateLocal();
  const dateInput = document.getElementById('txDate');
  if(!dateInput.value) dateInput.value = today;
  dateInput.max = today;
  setTimeout(() => document.getElementById('txValue').focus(), 100);
}
function closeTxModal() {
  document.getElementById('txModal').classList.remove('open');
  _editingTxId = null;
  _pendingTxAttachment = null;
  const fileInput = document.getElementById('txAttachmentFile');
  if (fileInput) fileInput.value = '';
}

// Abre o modal preenchido com dados da transacao pra edicao
function editTransaction(id){
  const tx = transactions.find(t => t.id === id);
  if (!tx) { showToast('Transação não encontrada','error'); return; }
  _editingTxId = id;
  _pendingTxAttachment = tx.attachment || null;
  _renderTxAttachmentUI();
  setTxModalMode('edit');
  document.getElementById('txType').value = tx.type;
  document.getElementById('txValue').value = tx.value;
  document.getElementById('txDate').value = tx.date;
  document.getElementById('txDate').max = isoDateLocal();
  document.getElementById('txMethod').value = tx.method;
  document.getElementById('txDesc').value = tx.desc;
  document.getElementById('txModal').classList.add('open');
  setTimeout(() => document.getElementById('txValue').focus(), 100);
}

// Atualiza titulo + label do botao salvar conforme o modo
function setTxModalMode(mode){
  const title = document.querySelector('#txModal .modal-title, #txModal h2, #txModal h3');
  const saveBtn = document.querySelector('#txModal .btn-primary');
  if (mode === 'edit'){
    if (title) title.textContent = 'Editar transação';
    if (saveBtn) saveBtn.innerHTML = 'Salvar alterações';
  } else {
    if (title) title.textContent = 'Nova Transação';
    if (saveBtn) saveBtn.innerHTML = 'Salvar →';
  }
}

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
  const nowIso = isoDateLocal();

  // Comprovante anexado (null se nenhum). attachment = base64 data URL ou null.
  const attachment = _pendingTxAttachment || null;

  // Edicao: atualiza a tx existente sem mexer no id nem created_at
  if (_editingTxId){
    const idx = transactions.findIndex(t => t.id === _editingTxId);
    if (idx >= 0){
      transactions[idx] = Object.assign({}, transactions[idx], {
        date: dateVal, desc, method, type, value: val, attachment
        // Mantem id e created_at originais (importante pro anti-backdate do ranking)
      });
      closeTxModal();
      showToast('Transação atualizada!', 'success');
      document.getElementById('txValue').value='';
      document.getElementById('txDesc').value='';
      recomputeAll();
      persistState();
      return;
    }
  }

  // Criacao nova
  // created_at = momento real em que a transacao foi cadastrada (NAO eh o tx.date, que pode ser backdated)
  // Usado pelo ranking HOJE pra evitar que tx backdated (date=ontem, registrada hoje) vaze pro topo de hoje.
  transactions.unshift({id:Date.now(), date:dateVal, desc, method, type, value:val, created_at:nowIso, attachment});
  closeTxModal();
  // Avisa o usuario quando ele backdata pra outro dia — explica que NAO conta pro HOJE
  if (dateVal !== nowIso){
    showToast(`Registrada com data de ${dateVal.split('-').reverse().join('/')} — nao conta no ranking de Hoje`, 'info');
  } else {
    showToast(`${type==='income'?'Entrada':'Despesa'} de R$${val.toFixed(2)} registrada!`, type==='income'?'success':'info');
  }
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
  {name:'Futebol',     icon:'⚽', color:'#10b981', color2:'#059669', meta:5000},
  {name:'Basquete',    icon:'🏀', color:'#f59e0b', color2:'#d97706', meta:3000},
  {name:'Tênis',       icon:'🎾', color:'#84cc16', color2:'#65a30d', meta:2500},
  {name:'MMA / UFC',   icon:'🥊', color:'#ef4444', color2:'#dc2626', meta:2000},
  {name:'E-sports',    icon:'🎮', color:'#8b5cf6', color2:'#7c3aed', meta:2000},
  {name:'Cassino',     icon:'🎰', color:'#f43f5e', color2:'#e11d48', meta:1500},
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
  if (typeof rankUpdateDashCard === 'function') rankUpdateDashCard();
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
  // Re-avalia alertas inteligentes quando dados mudam
  try { if (typeof renderSmartAlerts === 'function') renderSmartAlerts(); } catch(e){}
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
    const isSelected = _bulkSelectedTxIds.has(String(t.id));
    return `<tr draggable="true" data-tx-id="${t.id}" ondragstart="txDragStart(event)" ondragover="txDragOver(event)" ondragleave="txDragLeave(event)" ondrop="txDrop(event)" ondragend="txDragEnd(event)" ${isSelected ? 'style="background:rgba(239,68,68,0.08)"' : ''}>
      <td data-label="" style="text-align:center"><input type="checkbox" class="bulk-tx-checkbox" data-tx-id="${t.id}" ${isSelected ? 'checked' : ''} onchange="bulkToggleTx('${t.id}', this.checked)" onclick="event.stopPropagation()" style="cursor:pointer;width:16px;height:16px"/></td>
      <td data-label="" class="tx-drag-handle" title="Arraste pra reordenar" aria-label="Arrastar transação">⋮⋮</td>
      <td data-label="Data">${dateBR(t.date)}</td>
      <td data-label="Descrição">${escapeHtml(t.desc)}</td>
      <td data-label="Categoria"><span class="tag">${tag}</span></td>
      <td data-label="Método"><span class="tx-method-pill">${escapeHtml(t.method)}</span></td>
      <td data-label="Tipo"><span class="tx-type-badge ${cls}">${arrow}</span></td>
      <td data-label="Valor" class="tx-amount ${cls}">${sign}R$ ${t.value.toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
      <td data-label="Saldo">${fmtBRLshort(balanceNow)}</td>
      <td data-label="" style="text-align:right;white-space:nowrap">
        <button class="goal-action-btn" onclick="editTransaction(${t.id})" title="Editar" aria-label="Editar transação" style="margin-right:6px">✏️</button>
        <button class="goal-action-btn danger" onclick="deleteTransaction(${t.id})" title="Excluir" aria-label="Excluir transação">🗑️</button>
      </td>
    </tr>`;
  }).join('');
  body.innerHTML = rows;
  _bulkUpdateUI();
}

// ══════════════════════════════════════════════
//  BULK DELETE — selecionar varias tx e apagar de uma vez
//  Util pra limpar contaminacao de bug antigo de sync OU faxina geral.
// ══════════════════════════════════════════════
const _bulkSelectedTxIds = new Set();

function bulkToggleTx(id, checked){
  const sid = String(id);
  if (checked) _bulkSelectedTxIds.add(sid);
  else _bulkSelectedTxIds.delete(sid);
  // Destaca/limpa a row visualmente
  const row = document.querySelector('tr[data-tx-id="' + id + '"]');
  if (row) row.style.background = checked ? 'rgba(239,68,68,0.08)' : '';
  _bulkUpdateUI();
}

function bulkSelectAll(){
  // Seleciona TODAS as tx visiveis (respeitando filtro atual)
  const filtered = getFilteredTransactions();
  filtered.forEach(t => _bulkSelectedTxIds.add(String(t.id)));
  // Atualiza checkboxes na tela
  document.querySelectorAll('.bulk-tx-checkbox').forEach(cb => {
    cb.checked = true;
    const row = cb.closest('tr');
    if (row) row.style.background = 'rgba(239,68,68,0.08)';
  });
  const headerCb = document.getElementById('bulkSelectAllHeader');
  if (headerCb) headerCb.checked = true;
  _bulkUpdateUI();
}

function bulkClearSelection(){
  _bulkSelectedTxIds.clear();
  document.querySelectorAll('.bulk-tx-checkbox').forEach(cb => {
    cb.checked = false;
    const row = cb.closest('tr');
    if (row) row.style.background = '';
  });
  const headerCb = document.getElementById('bulkSelectAllHeader');
  if (headerCb) headerCb.checked = false;
  _bulkUpdateUI();
}

function bulkToggleAllHeader(checked){
  if (checked) bulkSelectAll();
  else bulkClearSelection();
}

function _bulkUpdateUI(){
  const count = _bulkSelectedTxIds.size;
  const bar = document.getElementById('bulkActionBar');
  const countEl = document.getElementById('bulkSelectedCount');
  const delCountEl = document.getElementById('bulkDeleteCount');
  if (countEl) countEl.textContent = count;
  if (delCountEl) delCountEl.textContent = count;
  if (bar){
    if (count > 0){
      bar.style.display = 'flex';
    } else {
      bar.style.display = 'none';
    }
  }
}

async function bulkDeleteSelected(){
  const count = _bulkSelectedTxIds.size;
  if (count === 0) { showToast('Nenhuma transação selecionada.', 'info'); return; }

  // Confirmacao com nome custom da quantidade
  const ok = await customConfirm(
    `Apagar ${count} transação(ões) selecionada(s)? Isso não pode ser desfeito.`,
    '⚠️ Apagar em lote',
    `Apagar ${count}`
  );
  if (!ok) return;

  const idsToDelete = new Set([..._bulkSelectedTxIds].map(String));
  const beforeLen = transactions.length;
  transactions = transactions.filter(t => !idsToDelete.has(String(t.id)));
  const deletedCount = beforeLen - transactions.length;

  _bulkSelectedTxIds.clear();
  recomputeAll();
  persistState();

  showToast(`${deletedCount} transação(ões) apagada(s).`, 'success');
}

// ══════════════════════════════════════════════
//  DRAG & DROP — reordenar transacoes
//  User pediu: arrastar tx pra cima/baixo na lista (corrige ordem
//  quando o usuario insere uma tx hoje que deveria estar antes de
//  outra ja existente).
// ══════════════════════════════════════════════
let _txDragId = null;

function txDragStart(e){
  _txDragId = Number(e.currentTarget.dataset.txId);
  e.currentTarget.classList.add('is-dragging');
  e.dataTransfer.effectAllowed = 'move';
  // Necessario pra Firefox aceitar drag
  try { e.dataTransfer.setData('text/plain', String(_txDragId)); } catch(err){}
}

function txDragOver(e){
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const row = e.currentTarget;
  if (Number(row.dataset.txId) === _txDragId) return;
  // Highlight: linha cima se cursor na metade superior, baixo se inferior
  const rect = row.getBoundingClientRect();
  const isUpper = (e.clientY - rect.top) < rect.height / 2;
  row.classList.remove('tx-drop-above', 'tx-drop-below');
  row.classList.add(isUpper ? 'tx-drop-above' : 'tx-drop-below');
}

function txDragLeave(e){
  e.currentTarget.classList.remove('tx-drop-above', 'tx-drop-below');
}

function txDrop(e){
  e.preventDefault();
  const targetId = Number(e.currentTarget.dataset.txId);
  e.currentTarget.classList.remove('tx-drop-above', 'tx-drop-below');
  if (!_txDragId || targetId === _txDragId) return;
  // Determina se foi solto na metade superior ou inferior
  const rect = e.currentTarget.getBoundingClientRect();
  const isUpper = (e.clientY - rect.top) < rect.height / 2;

  const fromIdx = transactions.findIndex(t => t.id === _txDragId);
  let toIdx = transactions.findIndex(t => t.id === targetId);
  if (fromIdx < 0 || toIdx < 0) return;

  // Remove o item arrastado
  const [item] = transactions.splice(fromIdx, 1);

  // Recalcula targetIdx depois da remocao
  toIdx = transactions.findIndex(t => t.id === targetId);
  if (!isUpper) toIdx += 1;

  // Insere na nova posicao
  transactions.splice(toIdx, 0, item);

  showToast('Ordem da transação atualizada','success');
  recomputeAll();
  persistState();
}

function txDragEnd(e){
  e.currentTarget.classList.remove('is-dragging');
  document.querySelectorAll('tr.tx-drop-above, tr.tx-drop-below').forEach(el => {
    el.classList.remove('tx-drop-above','tx-drop-below');
  });
  _txDragId = null;
}

// ── Touch (mobile) drag-and-drop ──
// HTML5 drag/drop nativo nao funciona em celular pq o touch eh
// usado pelo scroll. Implementamos manual com touchstart/move/end.
// User segura no handle, arrasta com dedo, solta na posicao desejada.
let _txTouchRow = null;        // <tr> sendo arrastada
let _txTouchTargetRow = null;  // <tr> alvo do drop atual
let _txTouchScrollTimer = null;

function txTouchStart(e){
  const handle = e.target.closest('.tx-drag-handle');
  if (!handle) return;
  const row = handle.closest('tr[data-tx-id]');
  if (!row) return;
  e.preventDefault();
  e.stopPropagation();
  _txDragId = Number(row.dataset.txId);
  _txTouchRow = row;
  row.classList.add('is-dragging');
  // Vibra (se disponivel) pra dar feedback de "lift"
  try { if (navigator.vibrate) navigator.vibrate(30); } catch(err){}
}

function txTouchMove(e){
  if (!_txTouchRow) return;
  e.preventDefault();
  const touch = e.touches[0];
  if (!touch) return;
  // Acha o elemento embaixo do dedo
  const el = document.elementFromPoint(touch.clientX, touch.clientY);
  const row = el ? el.closest('tr[data-tx-id]') : null;
  // Limpa highlight anterior se mudou de row
  if (_txTouchTargetRow && _txTouchTargetRow !== row){
    _txTouchTargetRow.classList.remove('tx-drop-above','tx-drop-below');
  }
  _txTouchTargetRow = row;
  if (!row || Number(row.dataset.txId) === _txDragId) return;
  // Highlight cima/baixo baseado em qual metade do row o dedo ta
  const rect = row.getBoundingClientRect();
  const isUpper = (touch.clientY - rect.top) < rect.height / 2;
  row.classList.remove('tx-drop-above','tx-drop-below');
  row.classList.add(isUpper ? 'tx-drop-above' : 'tx-drop-below');

  // Auto-scroll se chegou perto do topo/fundo da tela
  const winH = window.innerHeight;
  if (touch.clientY < 90){
    window.scrollBy(0, -6);
  } else if (touch.clientY > winH - 90){
    window.scrollBy(0, 6);
  }
}

function txTouchEnd(e){
  if (!_txTouchRow) return;
  _txTouchRow.classList.remove('is-dragging');
  // Se tem target valido, faz o reorder
  if (_txTouchTargetRow && _txDragId){
    const targetId = Number(_txTouchTargetRow.dataset.txId);
    if (targetId !== _txDragId){
      const touch = e.changedTouches[0];
      const rect = _txTouchTargetRow.getBoundingClientRect();
      const isUpper = touch ? (touch.clientY - rect.top) < rect.height / 2 : true;

      const fromIdx = transactions.findIndex(t => t.id === _txDragId);
      let toIdx = transactions.findIndex(t => t.id === targetId);
      if (fromIdx >= 0 && toIdx >= 0){
        const [item] = transactions.splice(fromIdx, 1);
        toIdx = transactions.findIndex(t => t.id === targetId);
        if (!isUpper) toIdx += 1;
        transactions.splice(toIdx, 0, item);
        try { if (navigator.vibrate) navigator.vibrate([20,30,20]); } catch(err){}
        showToast('Ordem da transação atualizada','success');
        recomputeAll();
        persistState();
      }
    }
    _txTouchTargetRow.classList.remove('tx-drop-above','tx-drop-below');
  }
  _txTouchRow = null;
  _txTouchTargetRow = null;
  _txDragId = null;
}

// Bind global no body — captura touchstart no handle e impede o scroll
// nativo durante o drag.
document.addEventListener('touchstart', function(e){
  if (e.target.closest && e.target.closest('.tx-drag-handle')) txTouchStart(e);
}, { passive: false });
document.addEventListener('touchmove', function(e){
  if (_txTouchRow) txTouchMove(e);
}, { passive: false });
document.addEventListener('touchend', function(e){
  if (_txTouchRow) txTouchEnd(e);
}, { passive: false });

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

// Resolve a data de inicio do trial com PRIORIDADE pro user.created_at do Supabase.
// Bug que existia: localStorage 'bancapro-trial-start' setado em sessao antiga (modo demo)
// nao era resetado quando o user criava conta nova — entao "trial acabou" aparecia
// imediatamente mesmo em conta criada hoje.
// Agora: se ha user autenticado, usa SEMPRE o created_at dele (e atualiza o cache local).
function getTrialStartDate(){
  var start = null;
  // 1) Prioridade: user.created_at (Supabase) — fonte de verdade
  try {
    var user = currentAuthUser;
    if (user && user.created_at){
      start = user.created_at;
      // Sincroniza o cache local com o created_at real
      try { localStorage.setItem('bancapro-trial-start', start); } catch(e){}
      return new Date(start);
    }
  } catch(e){}
  // 2) Fallback: localStorage (modo demo sem auth)
  try { start = localStorage.getItem('bancapro-trial-start'); } catch(e){}
  if (!start){
    start = new Date().toISOString();
    try { localStorage.setItem('bancapro-trial-start', start); } catch(e){}
  }
  return new Date(start);
}

function loadTrialState() {
  return getTrialStartDate();
}

// ═══════════════════════════════════════════
//  TRIAL STICKY BANNER + UPGRADE NAV + PRO LOCK
// ═══════════════════════════════════════════
const PRO_LOCKED_SECTIONS = ['reports','compare','calculadora'];

function getCurrentPlanLabel(){
  try { return localStorage.getItem('bancapro-plan-label') || 'Free'; } catch(e){ return 'Free'; }
}

function isPaidPlan(label){
  return label === 'Plus' || label === 'Pro' || label === 'Administrador';
}

function updateTrialStickyBanner(){
  const el = document.getElementById('trialStickyBanner');
  if (!el) return;
  const label = getCurrentPlanLabel();
  if (label !== 'Trial'){ el.classList.remove('show'); return; }
  // Se estiver numa secao Pro com a nota inline visivel, esconde o global
  // pra evitar dois banners dizendo o mesmo
  try {
    const activeSec = document.querySelector('.section.active');
    if (activeSec){
      const inlineNote = activeSec.querySelector('.trial-ending-note[data-pro-warning]');
      if (inlineNote && inlineNote.style.display !== 'none'){
        el.classList.remove('show');
        return;
      }
    }
  } catch(e){}
  // Calcula dias restantes (usa created_at do user quando disponivel — anti-bug)
  const startDate = getTrialStartDate();
  const msPerDay = 86400000;
  const elapsed = Math.floor((Date.now() - startDate.getTime()) / msPerDay);
  const left = Math.max(TRIAL_DAYS - elapsed, 0);
  // So aparece a partir do 3o dia (quando faltam 5 dias ou menos).
  // Primeiros 2 dias o user explora sem pressao de banner.
  if (left > 5){
    el.classList.remove('show');
    return;
  }
  const daysEl = document.getElementById('trialStickyDays');
  const txtEl  = document.getElementById('trialStickyText');
  const tailEl = document.getElementById('trialStickyTail');
  if (daysEl) daysEl.textContent = left;
  if (txtEl){
    if (left === 0){
      txtEl.innerHTML = '<b>Seu trial acabou.</b> Assine para recuperar acesso completo';
    } else if (left === 1){
      txtEl.innerHTML = 'Último dia do trial — <b>assine antes que expire</b>';
    } else {
      txtEl.innerHTML = 'Seu trial termina em <b><span id="trialStickyDays">'+left+' dias</span></b>';
    }
  }
  if (tailEl && left > 1) tailEl.style.display = '';
  el.classList.add('show');
}

function trialBannerClick(){
  if (typeof subscribeNow === 'function') subscribeNow('mensal');
  else if (typeof showPaywall === 'function') showPaywall();
}

function updateUpgradeProNav(){
  const el = document.getElementById('navUpgradePro');
  if (!el) return;
  const label = getCurrentPlanLabel();
  el.style.display = isPaidPlan(label) ? 'none' : '';
}

function upgradeNavClick(ev){
  if (ev && ev.preventDefault) ev.preventDefault();
  if (typeof subscribeNow === 'function') subscribeNow('mensal');
  else if (typeof showPaywall === 'function') showPaywall();
}

function updateProLockNavs(){
  const label = getCurrentPlanLabel();
  // Trial e pagos veem normal; so Free pos-trial ve cadeado
  const showLock = (label === 'Free');
  PRO_LOCKED_SECTIONS.forEach(sec => {
    const items = document.querySelectorAll('.nav-item[onclick*="goTo(\''+sec+'\'"]');
    items.forEach(it => {
      if (showLock) it.classList.add('is-pro-locked');
      else it.classList.remove('is-pro-locked');
    });
  });
}

// Trial countdown nos avisos das features Pro (so quando Trial e dias <= 2)
function updateProSectionWarnings(){
  const notes = document.querySelectorAll('.trial-ending-note[data-pro-warning]');
  if (!notes.length) return;
  const label = getCurrentPlanLabel();
  if (label !== 'Trial'){ notes.forEach(n => n.style.display = 'none'); return; }
  // Calcula dias restantes (usa helper que prioriza user.created_at)
  const startDate = getTrialStartDate();
  const elapsed = Math.floor((Date.now() - startDate.getTime()) / 86400000);
  const left = Math.max(TRIAL_DAYS - elapsed, 0);
  // So mostra quando faltam 2 dias ou menos
  if (left > 2){ notes.forEach(n => n.style.display = 'none'); return; }
  document.querySelectorAll('.trialEndingDays').forEach(s => s.textContent = left);
  notes.forEach(n => n.style.display = '');
}

// Modal de upsell Pro (estilo Canva — preview da feature bloqueada)
const PRO_UPSELL_DATA = {
  reports: {
    title: 'Desbloqueie Relatórios avançados',
    sub: 'Análises detalhadas de performance por período, método e estratégia. Veja gráficos, distribuição de despesas e ROI por método.',
    preview: `<svg viewBox="0 0 320 140" fill="none" xmlns="http://www.w3.org/2000/svg">
      <defs><linearGradient id="upsRep" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#a78bfa" stop-opacity=".95"/><stop offset="1" stop-color="#7c5cff" stop-opacity=".4"/></linearGradient></defs>
      <rect x="30" y="80" width="32" height="50" rx="3" fill="url(#upsRep)"/>
      <rect x="74" y="55" width="32" height="75" rx="3" fill="url(#upsRep)"/>
      <rect x="118" y="35" width="32" height="95" rx="3" fill="url(#upsRep)"/>
      <rect x="162" y="60" width="32" height="70" rx="3" fill="url(#upsRep)"/>
      <rect x="206" y="20" width="32" height="110" rx="3" fill="url(#upsRep)"/>
      <rect x="250" y="45" width="32" height="85" rx="3" fill="url(#upsRep)"/>
      <line x1="20" y1="130" x2="300" y2="130" stroke="rgba(255,255,255,.15)" stroke-width="1"/>
      <circle cx="270" cy="30" r="3" fill="#34d399"/><circle cx="270" cy="30" r="6" fill="#34d399" fill-opacity=".3"/>
    </svg>`
  },
  compare: {
    title: 'Desbloqueie o Comparativo mensal',
    sub: 'Compare meses lado a lado para identificar tendências, ajustar estratégias e ver sua evolução real ao longo do tempo.',
    preview: `<svg viewBox="0 0 320 140" fill="none" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="upsC1" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#a78bfa"/><stop offset="1" stop-color="#7c5cff" stop-opacity=".4"/></linearGradient>
        <linearGradient id="upsC2" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#34d399"/><stop offset="1" stop-color="#10b981" stop-opacity=".4"/></linearGradient>
      </defs>
      <rect x="50" y="60" width="50" height="70" rx="4" fill="url(#upsC1)"/>
      <rect x="110" y="35" width="50" height="95" rx="4" fill="url(#upsC2)"/>
      <rect x="180" y="80" width="50" height="50" rx="4" fill="url(#upsC1)"/>
      <rect x="240" y="50" width="50" height="80" rx="4" fill="url(#upsC2)"/>
      <line x1="40" y1="130" x2="300" y2="130" stroke="rgba(255,255,255,.15)" stroke-width="1"/>
      <text x="75" y="22" fill="rgba(255,255,255,.55)" font-size="9" font-family="system-ui">Mai</text>
      <text x="135" y="22" fill="#34d399" font-size="9" font-family="system-ui" font-weight="700">Jun ↑</text>
      <text x="205" y="22" fill="rgba(255,255,255,.55)" font-size="9" font-family="system-ui">Jul</text>
      <text x="265" y="22" fill="#34d399" font-size="9" font-family="system-ui" font-weight="700">Ago</text>
    </svg>`
  },
  calculadora: {
    title: 'Desbloqueie a Calculadora Pro',
    sub: 'Surebet, stake ideal, ROI, breakeven e simulações de cenários para apostar com matemática do seu lado, não no instinto.',
    preview: `<svg viewBox="0 0 320 140" fill="none" xmlns="http://www.w3.org/2000/svg">
      <defs><linearGradient id="upsCalc" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#a78bfa" stop-opacity=".2"/><stop offset="1" stop-color="#7c5cff" stop-opacity=".05"/></linearGradient></defs>
      <rect x="80" y="14" width="160" height="112" rx="10" fill="url(#upsCalc)" stroke="rgba(167,139,250,.42)" stroke-width="1"/>
      <rect x="90" y="22" width="140" height="24" rx="4" fill="rgba(255,255,255,.08)"/>
      <text x="218" y="40" fill="#34d399" font-size="13" font-family="system-ui" font-weight="700" text-anchor="end">R$ 2.847,50</text>
      <text x="98" y="40" fill="rgba(255,255,255,.45)" font-size="9" font-family="system-ui">ROI esperado</text>
      <g fill="rgba(255,255,255,.08)">
        <rect x="92" y="56" width="32" height="28" rx="4"/>
        <rect x="128" y="56" width="32" height="28" rx="4"/>
        <rect x="164" y="56" width="32" height="28" rx="4"/>
        <rect x="200" y="56" width="22" height="28" rx="4"/>
        <rect x="92" y="88" width="32" height="28" rx="4"/>
        <rect x="128" y="88" width="32" height="28" rx="4"/>
        <rect x="164" y="88" width="32" height="28" rx="4"/>
      </g>
      <rect x="200" y="88" width="22" height="28" rx="4" fill="#7c5cff"/>
      <g fill="rgba(255,255,255,.55)" font-size="11" font-family="system-ui" text-anchor="middle">
        <text x="108" y="74">7</text><text x="144" y="74">8</text><text x="180" y="74">9</text>
        <text x="108" y="106">4</text><text x="144" y="106">5</text><text x="180" y="106">6</text>
      </g>
      <text x="211" y="74" fill="rgba(255,255,255,.55)" font-size="11" font-family="system-ui" text-anchor="middle">÷</text>
      <text x="211" y="106" fill="#fff" font-size="11" font-family="system-ui" text-anchor="middle" font-weight="700">=</text>
    </svg>`
  }
};

function openProUpsellModal(section){
  const el = document.getElementById('proUpsellModal');
  if (!el) return;
  const data = PRO_UPSELL_DATA[section] || PRO_UPSELL_DATA.reports;
  const titleEl = document.getElementById('upsellTitle');
  const subEl = document.getElementById('upsellSub');
  const previewEl = document.getElementById('upsellPreviewContent');
  if (titleEl) titleEl.textContent = data.title;
  if (subEl) subEl.textContent = data.sub;
  if (previewEl) previewEl.innerHTML = data.preview;
  // Destaca o extra correspondente
  el.querySelectorAll('.upsell-extra').forEach(x => {
    x.classList.toggle('is-current', x.getAttribute('data-extra') === section);
  });
  el.classList.add('open');
  el.style.display = 'flex';
}
function closeProUpsellModal(ev){
  if (ev && ev.target && ev.target.id !== 'proUpsellModal' && ev.type === 'click' && ev.currentTarget?.id !== 'proUpsellModal') return;
  const el = document.getElementById('proUpsellModal');
  if (!el) return;
  el.classList.remove('open');
  el.style.display = 'none';
}
// Esc fecha o modal
document.addEventListener('keydown', e => {
  if (e.key === 'Escape'){
    const el = document.getElementById('proUpsellModal');
    if (el && el.style.display !== 'none') closeProUpsellModal();
  }
});

function updateAllUpgradeUI(){
  try { updateTrialStickyBanner(); } catch(e){}
  try { updateUpgradeProNav(); } catch(e){}
  try { updateProLockNavs(); } catch(e){}
  try { updateProSectionWarnings(); } catch(e){}
  try { updateOnboardingCard(); } catch(e){}
}

// ═══════════════════════════════════════════
//  WELCOME MODAL + ONBOARDING CHECKLIST
// ═══════════════════════════════════════════
function openWelcomeModal(){
  const el = document.getElementById('welcomeModal');
  if (!el) return;
  el.classList.add('open');
  el.style.display = 'flex';
}
function closeWelcomeModal(ev){
  if (ev && ev.target && ev.target.id !== 'welcomeModal' && ev.type === 'click' && ev.currentTarget?.id !== 'welcomeModal') return;
  const el = document.getElementById('welcomeModal');
  if (!el) return;
  el.classList.remove('open');
  el.style.display = 'none';
  try { localStorage.setItem(onboardingKey('bancapro-welcome-seen'), '1'); } catch(e){}
}
document.addEventListener('keydown', e => {
  if (e.key === 'Escape'){
    const el = document.getElementById('welcomeModal');
    if (el && el.style.display !== 'none') closeWelcomeModal();
  }
});

// Mostra o welcome 1x na 1a visita autenticada
function maybeShowWelcome(){
  try {
    if (localStorage.getItem(onboardingKey('bancapro-welcome-seen')) === '1') return;
    // So mostra se ja tiver email (= logado)
    const email = (localStorage.getItem('bancapro-user-email')||'').trim();
    if (!email) return;
    // Veterano: usuario que ja tem 1+ transacao claramente nao precisa
    // de 'bem-vindo'. Marca como visto silenciosamente.
    let txCount = 0;
    if (typeof transactions !== 'undefined' && Array.isArray(transactions)) txCount = transactions.length;
    else { try { txCount = (JSON.parse(localStorage.getItem('bancapro-transactions') || '[]')||[]).length; } catch(e){} }
    if (txCount >= 1){
      try { localStorage.setItem(onboardingKey('bancapro-welcome-seen'), '1'); } catch(e){}
      return;
    }
    // Delay pequeno pra UI hidratar
    setTimeout(openWelcomeModal, 1200);
  } catch(e){}
}

// Onboarding checklist: detecta progresso e mostra/esconde
function getOnboardingProgress(){
  const done = {};
  try {
    // Banca inicial definida (chave real: bancapro-saldo-inicial)
    const banca = parseFloat(localStorage.getItem('bancapro-saldo-inicial') || '0');
    if (banca > 0) done.banca = true;
    // Pelo menos 1 metodo cadastrado (chave real: bancapro-methods-catalog)
    let methods = [];
    try { methods = JSON.parse(localStorage.getItem('bancapro-methods-catalog') || '[]'); } catch(e){}
    if (!Array.isArray(methods) || methods.length === 0){
      try { methods = JSON.parse(localStorage.getItem('bancapro-methods-compare') || '[]'); } catch(e){}
    }
    // Tambem aceita se ha transacoes (ja indica que tem metodo cadastrado)
    if ((Array.isArray(methods) && methods.length > 0) || (typeof transactions !== 'undefined' && Array.isArray(transactions) && transactions.length > 0)) done.metodo = true;
    // Pelo menos 1 transacao (memoria global + fallback localStorage)
    let txs = [];
    if (typeof transactions !== 'undefined' && Array.isArray(transactions)) txs = transactions;
    else { try { txs = JSON.parse(localStorage.getItem('bancapro-transactions') || '[]'); } catch(e){} }
    if (Array.isArray(txs) && txs.length > 0) done.transacao = true;
    // Pelo menos 1 meta
    let goalsList = [];
    if (typeof goals !== 'undefined' && Array.isArray(goals)) goalsList = goals;
    else { try { goalsList = JSON.parse(localStorage.getItem('bancapro-goals') || '[]'); } catch(e){} }
    if (Array.isArray(goalsList) && goalsList.length > 0) done.meta = true;
    // Visitou Ranking (chave explicita)
    if (localStorage.getItem('bancapro-visited-ranking') === '1') done.ranking = true;
    // Fallback: se ja tem >=3 transacoes E os outros 4 passos estao OK,
    // assume que ranking ja foi visto (usuario claramente engajado).
    // Sem isso, o card fica preso em "4 de 5" pra sempre quando o hook
    // de goTo nao registrou a visita (ex: app recarregado antes do click).
    if (!done.ranking && done.banca && done.metodo && done.transacao && done.meta){
      const txLen = (typeof transactions !== 'undefined' && Array.isArray(transactions))
        ? transactions.length
        : (function(){ try { return (JSON.parse(localStorage.getItem('bancapro-transactions')||'[]')||[]).length; } catch(e){ return 0; } })();
      if (txLen >= 3){
        done.ranking = true;
        try { localStorage.setItem('bancapro-visited-ranking', '1'); } catch(e){}
      }
    }
  } catch(e){}
  return done;
}

function updateOnboardingCard(){
  const card = document.getElementById('onboardingCard');
  if (!card) return;
  // Regra: aparece UMA UNICA VEZ na vida do usuario.
  // Se ja foi visto (em qualquer momento), nunca mais mostra.
  try {
    if (localStorage.getItem(onboardingKey('bancapro-onboarding-dismissed')) === '1' ||
        localStorage.getItem(onboardingKey('bancapro-onboarding-shown')) === '1'){
      card.style.display = 'none';
      return;
    }
  } catch(e){}
  const done = getOnboardingProgress();
  const totalSteps = 5;
  const doneCount = Object.keys(done).length;
  // Tudo concluido (caso comum: usuario veterano abrindo conta nova ou admin):
  // nao mostra o card e marca como dismissed pra nao reaparecer.
  if (doneCount >= totalSteps){
    card.style.display = 'none';
    try {
      localStorage.setItem(onboardingKey('bancapro-onboarding-dismissed'), '1');
      localStorage.setItem(onboardingKey('bancapro-onboarding-shown'), '1');
    } catch(e){}
    return;
  }
  card.style.display = '';
  // Marca como ja exibido pra nao reaparecer em sessoes futuras
  try { localStorage.setItem(onboardingKey('bancapro-onboarding-shown'), '1'); } catch(e){}
  // Marca steps concluidos
  card.querySelectorAll('.onboarding-step').forEach(step => {
    const k = step.getAttribute('data-step');
    if (done[k]) step.classList.add('is-done');
    else step.classList.remove('is-done');
  });
  // Atualiza subtitulo com progresso
  const sub = document.getElementById('onboardingProgress');
  if (sub){
    if (doneCount === 0) sub.textContent = 'Complete pra começar a tirar valor do Apostack';
    else sub.textContent = doneCount + ' de ' + totalSteps + ' completos · continue pra liberar tudo';
  }
}

function dismissOnboarding(){
  try { localStorage.setItem(onboardingKey('bancapro-onboarding-dismissed'), '1'); } catch(e){}
  const card = document.getElementById('onboardingCard');
  if (card) card.style.display = 'none';
}

// ══════════════════════════════════════════════
//  SMART ALERTS (notificacoes contextuais no Dashboard)
//  - Sem aposta ha X dias / ROI caiu / Meta batida / Empty states
//  - Dispensaveis individualmente (flag por ID em localStorage)
// ══════════════════════════════════════════════
function _smartAlertsDismissedSet(){
  try {
    const raw = localStorage.getItem('bancapro-smart-alerts-dismissed') || '[]';
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr : []);
  } catch(e){ return new Set(); }
}

function dismissSmartAlert(id){
  try {
    const s = _smartAlertsDismissedSet();
    s.add(id);
    localStorage.setItem('bancapro-smart-alerts-dismissed', JSON.stringify([...s]));
  } catch(e){}
  renderSmartAlerts();
}

function _daysSince(dateStr){
  if (!dateStr) return null;
  const d = new Date(dateStr + (dateStr.length === 10 ? 'T00:00:00' : ''));
  if (isNaN(d.getTime())) return null;
  const today = new Date();
  today.setHours(0,0,0,0);
  d.setHours(0,0,0,0);
  return Math.floor((today - d) / 86400400);
}

function computeSmartAlerts(){
  // Apenas alertas com VALOR REAL — sem nag, sem 'cobranca'.
  // User pode desativar tudo em Personalizar (flag abaixo).
  try {
    if (localStorage.getItem('bancapro-smart-alerts-off') === '1') return [];
  } catch(e){}

  const alerts = [];
  const txs = (typeof transactions !== 'undefined' && Array.isArray(transactions)) ? transactions : [];
  const gls = (typeof goals !== 'undefined' && Array.isArray(goals)) ? goals : [];
  const monthYear = new Date().toISOString().slice(0,7);

  // 1. META BATIDA — celebra conquista (mais importante)
  if (gls.length > 0 && txs.length > 0){
    const totalLucro = txs.reduce((s,t) => s + (t.type === 'income' ? (parseFloat(t.value)||0) : -(parseFloat(t.value)||0)), 0);
    gls.forEach(g => {
      const target = parseFloat(g.target) || 0;
      if (target > 0 && totalLucro >= target){
        alerts.push({
          id: 'goal-' + (g.id || g.name) + '-' + monthYear,
          priority: 1,
          icon: '🎯',
          color: '#10b981',
          title: 'Meta batida: ' + (g.name || 'Meta'),
          desc: 'Você ultrapassou R$ ' + target.toLocaleString('pt-BR') + ' de lucro. Continue assim!',
          action: { label: 'Ver metas', fn: "goTo('goals')" }
        });
      }
    });
  }

  // 2. ROI CAIU significativamente — alerta de problema real
  if (txs.length >= 10){
    const today = new Date(); today.setHours(0,0,0,0);
    const d7  = new Date(today); d7.setDate(today.getDate() - 7);
    const d14 = new Date(today); d14.setDate(today.getDate() - 14);
    const toKey = (d) => d.toISOString().slice(0,10);
    let lucroA = 0, despesaA = 0, lucroB = 0, despesaB = 0;
    txs.forEach(t => {
      if (!t.date) return;
      const v = parseFloat(t.value) || 0;
      const isInc = t.type === 'income';
      if (t.date >= toKey(d7)){
        if (isInc) lucroA += v; else despesaA += v;
      } else if (t.date >= toKey(d14)){
        if (isInc) lucroB += v; else despesaB += v;
      }
    });
    const roiA = despesaA > 0 ? ((lucroA - despesaA) / despesaA) * 100 : 0;
    const roiB = despesaB > 0 ? ((lucroB - despesaB) / despesaB) * 100 : 0;
    const diff = roiA - roiB;
    if (roiB > 0 && diff <= -15){
      alerts.push({
        id: 'roi-drop-' + monthYear,
        priority: 2,
        icon: '📉',
        color: '#f59e0b',
        title: 'ROI caiu ' + Math.abs(Math.round(diff)) + '% essa semana',
        desc: 'De ' + Math.round(roiB) + '% pra ' + Math.round(roiA) + '%. Vale dar uma olhada em qual categoria tá queimando.',
        action: { label: 'Ver relatórios', fn: "goTo('reports')" }
      });
    }
  }

  // 3. BEM-VINDO DE VOLTA — apenas apos >=14 dias inativo (sumiu mesmo)
  if (txs.length > 0){
    const sorted = txs.slice().sort((a,b) => (b.date || '').localeCompare(a.date || ''));
    const lastDate = sorted[0]?.date;
    const days = _daysSince(lastDate);
    if (days !== null && days >= 14){
      alerts.push({
        id: 'inactive-14d-' + monthYear,
        priority: 3,
        icon: '👋',
        color: '#a78bfa',
        title: 'Que bom te ver de volta!',
        desc: 'Faz ' + days + ' dias desde sua última transação. Bora atualizar?',
        action: { label: 'Lançar agora', fn: 'openTxModal()' }
      });
    }
  }

  alerts.sort((a,b) => (a.priority||99) - (b.priority||99));
  return alerts;
}

function renderSmartAlerts(){
  const wrap = document.getElementById('smartAlerts');
  if (!wrap) return;
  const dismissed = _smartAlertsDismissedSet();
  const all = computeSmartAlerts();
  // Max 1 alerta visivel — manter dashboard CALMO. Mostra o de maior prioridade.
  const visible = all.filter(a => !dismissed.has(a.id)).slice(0, 1);
  if (visible.length === 0){
    wrap.style.display = 'none';
    wrap.innerHTML = '';
    return;
  }
  wrap.style.display = '';
  wrap.innerHTML = visible.map(a => ''
    + '<div class="smart-alert" data-id="' + escapeHtml(a.id) + '" style="--alert-color:' + a.color + '">'
    + '  <div class="smart-alert-icon" style="background:' + a.color + '20;color:' + a.color + '">' + a.icon + '</div>'
    + '  <div class="smart-alert-content">'
    + '    <div class="smart-alert-title">' + escapeHtml(a.title) + '</div>'
    + '    <div class="smart-alert-desc">' + escapeHtml(a.desc) + '</div>'
    + '  </div>'
    + '  <div class="smart-alert-actions">'
    + (a.action ? '    <button class="smart-alert-btn" onclick="' + a.action.fn + '">' + escapeHtml(a.action.label) + '</button>' : '')
    + '    <button class="smart-alert-dismiss" onclick="dismissSmartAlert(\'' + a.id.replace(/'/g,"\\'") + '\')" aria-label="Dispensar">'
    + '      <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18M6 6l12 12"/></svg>'
    + '    </button>'
    + '  </div>'
    + '</div>'
  ).join('');
}

// Roda em momentos chave: load do dashboard + a cada 60s + apos tx
(function initSmartAlertsTimer(){
  function safeRender(){ try { renderSmartAlerts(); } catch(e){} }
  if (document.readyState !== 'loading') setTimeout(safeRender, 800);
  else document.addEventListener('DOMContentLoaded', () => setTimeout(safeRender, 800));
  setInterval(safeRender, 60000);
})();

// Toggle on/off em Configuracoes — desliga tudo se user nao quiser
function setSmartAlertsEnabled(enabled){
  try { localStorage.setItem('bancapro-smart-alerts-off', enabled ? '0' : '1'); } catch(e){}
  // Atualiza visual do switch (.cust-switch)
  const box = document.getElementById('toggleSmartAlertsBox');
  if (box){
    if (enabled) box.classList.add('is-on');
    else box.classList.remove('is-on');
  }
  // Re-renderiza ja
  renderSmartAlerts();
}

// Aplica estado inicial do toggle ao carregar
(function initSmartAlertsToggle(){
  function apply(){
    try {
      const off = localStorage.getItem('bancapro-smart-alerts-off') === '1';
      const cb = document.getElementById('toggleSmartAlerts');
      const box = document.getElementById('toggleSmartAlertsBox');
      if (cb) cb.checked = !off;
      if (box){
        if (off) box.classList.remove('is-on');
        else box.classList.add('is-on');
      }
    } catch(e){}
  }
  if (document.readyState !== 'loading') setTimeout(apply, 200);
  else document.addEventListener('DOMContentLoaded', () => setTimeout(apply, 200));
})();

// Banner explicativo da aba 'Contas Depositadas' — pode ser dispensado
// pelo X e nao volta a aparecer (flag em localStorage).
function dismissAccountsInfoBanner(){
  try { localStorage.setItem('bancapro-accounts-info-dismissed', '1'); } catch(e){}
  const b = document.getElementById('accountsInfoBanner');
  if (b) b.style.display = 'none';
}

// Aplica estado dispensado ao carregar o app
(function initAccountsInfoBanner(){
  function apply(){
    try {
      if (localStorage.getItem('bancapro-accounts-info-dismissed') === '1'){
        const b = document.getElementById('accountsInfoBanner');
        if (b) b.style.display = 'none';
      }
    } catch(e){}
  }
  if (document.readyState !== 'loading') setTimeout(apply, 50);
  else document.addEventListener('DOMContentLoaded', apply);
})();

function onboardingGo(step){
  // Roteador dos passos do checklist
  switch(step){
    case 'banca': goTo('settings'); setTimeout(() => { const b = document.querySelector('[onclick*="openSaldoInicialModal"]'); if (b) b.click(); }, 350); break;
    case 'metodo': goTo('methods'); break;
    case 'transacao': openTxModal(); break;
    case 'meta': goTo('goals'); break;
    case 'ranking': goTo('ranking'); try { localStorage.setItem('bancapro-visited-ranking', '1'); } catch(e){} break;
  }
}

// Quando entra no Ranking, marca como visitado pro checklist.
// Tenta hookar imediato; se goTo nao existir ainda, reagenda ate existir.
(function hookRankingVisit(){
  function install(){
    const orig = window.goTo;
    if (typeof orig !== 'function') return false;
    if (orig.__ob_rank_hooked) return true;
    const wrapped = function(section, el){
      if (section === 'ranking'){
        try { localStorage.setItem('bancapro-visited-ranking', '1'); } catch(e){}
        try { setTimeout(updateOnboardingCard, 50); } catch(e){}
      }
      return orig.apply(this, arguments);
    };
    wrapped.__ob_rank_hooked = true;
    window.goTo = wrapped;
    return true;
  }
  if (install()) return;
  // Retry ate 20x (1s total) caso goTo seja definido depois
  let tries = 0;
  const id = setInterval(() => {
    if (install() || ++tries > 20) clearInterval(id);
  }, 50);
})();

// Roda a cada minuto pra atualizar dias do trial sem precisar reload
setInterval(updateAllUpgradeUI, 60000);
document.addEventListener('DOMContentLoaded', () => setTimeout(updateAllUpgradeUI, 800));

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
    // Meta Pixel: InitiateCheckout — dispara antes de redirecionar pro Kirvano
    try {
      if (typeof fbq === 'function') {
        const value = (plan === 'anual') ? 199 : 24.90;
        fbq('track', 'InitiateCheckout', {
          content_name: 'Apostack ' + (plan === 'anual' ? 'Pro Anual' : 'Plus Mensal'),
          content_category: 'subscription',
          value: value,
          currency: 'BRL'
        });
      }
    } catch(e){}
    showToast('Abrindo o checkout seguro…','info');
    window.location.href = url;
  } else {
    showToast('Checkout ainda não configurado — falta o link do Kirvano.','error');
  }
}
function continueTrialToast() {
  showToast('Tudo certo! Aproveite seus dias grátis 🎉','success');
}

// Re-valida o plano do usuario com o Supabase e atualiza o banner.
// Chamado quando a aba volta a ganhar foco (user volta do Kirvano)
// e periodicamente. Garante que apos assinar, o banner trial some
// sem precisar recarregar a pagina.
async function refreshPlanAndUI(){
  try {
    if (!currentAuthUser) return;
    await cachePlanLabel(currentAuthUser);
    if (typeof updateAllUpgradeUI === 'function') updateAllUpgradeUI();
    if (typeof updateTrialStickyBanner === 'function') updateTrialStickyBanner();
  } catch(e){}
}

// Refresh quando aba volta a ser visivel (ex: user voltou do checkout Kirvano)
document.addEventListener('visibilitychange', function(){
  if (document.visibilityState === 'visible') refreshPlanAndUI();
});
window.addEventListener('focus', refreshPlanAndUI);
// Refresh periodico a cada 90s enquanto app esta aberto (cobre o caso
// do user assinar em outra aba e voltar pra essa)
setInterval(function(){
  if (document.visibilityState === 'visible') refreshPlanAndUI();
}, 90000);

// REMOVIDO: definicao antiga conflitava com toggleFaq() da Central de Ajuda
// (linha ~8274). A versao consolidada abaixo lida com AMBOS os FAQs:
// - .faq-item (pagina de Assinatura/Recharge — usa class 'open')
// - .help-faq-item (Central de Ajuda — usa class 'is-open')
// Funcao unificada no fim do script.js (RESTART tour + toggleFaq).

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
  document.getElementById('sidebarUserName').textContent = document.getElementById('settingsUserName').value || 'Apostador';
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

  // CRITICO: sincroniza nome com auth metadata do Supabase.
  // Sem isso, RPC get_leaderboard cai no fallback do email-prefix
  // e ranking mostra "kingmetodoss" em vez de "Loamy neri".
  try {
    const sb = getSb();
    if (sb) {
      const { error: metaErr } = await sb.auth.updateUser({ data: { name } });
      if (metaErr) console.warn('Erro ao atualizar nome no Supabase:', metaErr.message);
    }
  } catch(e) { console.warn('Erro updateUser metadata:', e); }

  if (typeof schedulePush === 'function') schedulePush();
  updateUserName();
  // Atualiza avatar (inicial)
  document.querySelectorAll('.user-avatar').forEach(el => { el.textContent = name.charAt(0).toUpperCase(); });
  // Re-fetch leaderboard pra refletir nome novo
  try { if (typeof renderUserRanking === 'function'){ const rs = document.getElementById('sec-ranking'); if (rs && rs.classList.contains('active')) setTimeout(renderUserRanking, 800); } } catch(e){}
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
      // Atualiza role: owner -> Administrador, senao usa cache do plano (Free/Trial/Plus/Pro)
      try {
        const roleEl = document.getElementById('sidebarUserRole');
        if (roleEl && typeof OWNER_EMAILS !== 'undefined'){
          const isOwner = OWNER_EMAILS.includes(email.toLowerCase());
          if (isOwner) {
            roleEl.textContent = 'Administrador';
          } else {
            const cached = localStorage.getItem('bancapro-plan-label') || 'Free';
            roleEl.textContent = cached;
          }
        }
      } catch(e){}
    }
    // Re-aplica foto do avatar (se houver) — pullUserData limpou e re-aplicou o localStorage,
    // mas applyAvatar do DOMContentLoaded rodou antes de o avatar voltar da nuvem
    if (typeof applyAvatar === 'function') applyAvatar();
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
  // Troca PNGs do ranking pra versao do tema certo (com/sem sombra)
  try {
    if (typeof renderUserRanking === 'function' && document.getElementById('sec-ranking')?.classList.contains('active')){
      renderUserRanking();
    }
    if (typeof rankUpdateDashCard === 'function') rankUpdateDashCard();
  } catch(e){}
  // sincroniza o tema na conta (entre aparelhos)
  if (typeof schedulePush === 'function') schedulePush();
}

// ══════════════════════════════════════════════
//  TOAST
// ══════════════════════════════════════════════
// Suporte por email: copia o email pro clipboard e tenta abrir o cliente.
// mailto: nao funciona se o usuario nao tem cliente de email padrao (caso
// comum no Windows sem Outlook) — entao o copy garante que o email fica
// disponivel pra colar no Gmail/webmail mesmo.
function contactByEmail(subject){
  const email = 'suporteapostack@gmail.com';
  const sub = subject || 'Suporte Apostack';
  try {
    if (navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(email).then(
        function(){ showToast('📋 Email copiado: ' + email,'success'); },
        function(){ showToast('Nosso email: ' + email,'info'); }
      );
    } else {
      showToast('Nosso email: ' + email,'info');
    }
  } catch(e){
    showToast('Nosso email: ' + email,'info');
  }
  // Bonus: tenta abrir cliente de email se existir. Sem garantia.
  try {
    window.location.href = 'mailto:' + email + '?subject=' + encodeURIComponent(sub);
  } catch(e){}
  return false;
}

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
let currentEvoMode = '30d';

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

// ══════════════════════════════════════════════
//  FILTROS AVANCADOS — Relatorios
// ══════════════════════════════════════════════
var reportFilters = { period: '30d', customFrom: '', customTo: '', categories: [] };
(function loadReportFilters(){
  try {
    const raw = localStorage.getItem('bancapro-report-filters');
    if (raw){
      const obj = JSON.parse(raw);
      if (obj && typeof obj === 'object'){
        reportFilters = Object.assign(reportFilters, obj);
      }
    }
  } catch(e){}
})();
function saveReportFilters(){
  try { localStorage.setItem('bancapro-report-filters', JSON.stringify(reportFilters)); } catch(e){}
}

// Calcula intervalo de datas baseado no preset
function _reportDateRange(){
  const today = new Date(); today.setHours(0,0,0,0);
  const toKey = (d) => d.toISOString().slice(0,10);
  let from = null, to = toKey(today);
  switch (reportFilters.period){
    case '7d': {
      const d = new Date(today); d.setDate(today.getDate() - 6);
      from = toKey(d); break;
    }
    case '30d': {
      const d = new Date(today); d.setDate(today.getDate() - 29);
      from = toKey(d); break;
    }
    case '90d': {
      const d = new Date(today); d.setDate(today.getDate() - 89);
      from = toKey(d); break;
    }
    case 'month': {
      const d = new Date(today.getFullYear(), today.getMonth(), 1);
      from = toKey(d); break;
    }
    case 'year': {
      const d = new Date(today.getFullYear(), 0, 1);
      from = toKey(d); break;
    }
    case 'all': {
      from = null; to = null; break;
    }
    case 'custom': {
      from = reportFilters.customFrom || null;
      to = reportFilters.customTo || null;
      break;
    }
  }
  return { from, to };
}

// Retorna transactions filtradas pelos filtros do relatorio
function getFilteredReportTxs(){
  if (typeof transactions === 'undefined' || !Array.isArray(transactions)) return [];
  const { from, to } = _reportDateRange();
  const cats = reportFilters.categories || [];
  return transactions.filter(t => {
    if (!t || !t.date) return false;
    if (from && t.date < from) return false;
    if (to && t.date > to) return false;
    if (cats.length && cats.indexOf(t.method) < 0) return false;
    return true;
  });
}

function setReportFilter(key, value){
  if (key === 'period'){
    reportFilters.period = value;
    if (value !== 'custom'){
      // Esconde inputs custom se trocar pra outro preset
      const ci = document.getElementById('reportCustomInputs');
      if (ci) ci.style.display = 'none';
    }
  } else if (key === 'customFrom'){
    reportFilters.customFrom = value;
    reportFilters.period = 'custom';
  } else if (key === 'customTo'){
    reportFilters.customTo = value;
    reportFilters.period = 'custom';
  }
  saveReportFilters();
  refreshReportFiltersUI();
  // Re-renderiza todos os charts com filtros aplicados
  try { buildReportCharts(); } catch(e){}
}

function toggleReportCategory(category){
  const idx = reportFilters.categories.indexOf(category);
  if (idx >= 0) reportFilters.categories.splice(idx, 1);
  else reportFilters.categories.push(category);
  saveReportFilters();
  refreshReportFiltersUI();
  try { buildReportCharts(); } catch(e){}
}

function toggleReportCustomPeriod(){
  const el = document.getElementById('reportCustomInputs');
  if (!el) return;
  const showing = el.style.display !== 'none';
  el.style.display = showing ? 'none' : 'flex';
  if (!showing && (!reportFilters.customFrom || !reportFilters.customTo)){
    // Preencher com valores default ao abrir
    const today = new Date();
    const d30 = new Date(today); d30.setDate(today.getDate() - 30);
    if (!reportFilters.customFrom) reportFilters.customFrom = d30.toISOString().slice(0,10);
    if (!reportFilters.customTo) reportFilters.customTo = today.toISOString().slice(0,10);
    const f = document.getElementById('reportDateFrom');
    const t = document.getElementById('reportDateTo');
    if (f) f.value = reportFilters.customFrom;
    if (t) t.value = reportFilters.customTo;
  }
}

function clearReportFilters(){
  reportFilters = { period: '30d', customFrom: '', customTo: '', categories: [] };
  saveReportFilters();
  refreshReportFiltersUI();
  try { buildReportCharts(); } catch(e){}
}

// Atualiza visual: chips ativos, contador, botao limpar
function refreshReportFiltersUI(){
  // Botoes de periodo
  document.querySelectorAll('.rf-period-btn').forEach(b => {
    const p = b.getAttribute('data-period');
    if (p === reportFilters.period) b.classList.add('is-active');
    else b.classList.remove('is-active');
  });
  // Inputs custom
  const f = document.getElementById('reportDateFrom');
  const t = document.getElementById('reportDateTo');
  if (f && reportFilters.customFrom) f.value = reportFilters.customFrom;
  if (t && reportFilters.customTo) t.value = reportFilters.customTo;
  if (reportFilters.period === 'custom'){
    const ci = document.getElementById('reportCustomInputs');
    if (ci) ci.style.display = 'flex';
  }
  // Chips de categoria
  const chipsEl = document.getElementById('reportCategoryChips');
  if (chipsEl && typeof METHODS_CATALOG !== 'undefined' && Array.isArray(METHODS_CATALOG)){
    chipsEl.innerHTML = METHODS_CATALOG.map(m => {
      const isActive = reportFilters.categories.indexOf(m.name) >= 0;
      return '<button class="rf-chip' + (isActive ? ' is-active' : '') + '"'
        + ' onclick="toggleReportCategory(\'' + m.name.replace(/'/g, "\\'") + '\')">'
        + '<span class="rf-chip-icon">' + (m.icon || '•') + '</span>'
        + escapeHtml(m.name)
        + '</button>';
    }).join('');
  }
  // Sumario
  const sumEl = document.getElementById('reportSummary');
  if (sumEl){
    const total = (typeof transactions !== 'undefined') ? transactions.length : 0;
    const filtered = getFilteredReportTxs().length;
    if (filtered === total){
      sumEl.innerHTML = 'Mostrando todas as <b>' + total + '</b> transações';
    } else {
      sumEl.innerHTML = 'Mostrando <b>' + filtered + '</b> de ' + total + ' transações';
    }
  }
  // Botao limpar so aparece se ha filtros ativos
  const clearBtn = document.getElementById('reportClearBtn');
  if (clearBtn){
    const hasFilters = reportFilters.period !== '30d' || reportFilters.categories.length > 0
      || reportFilters.customFrom || reportFilters.customTo;
    clearBtn.style.display = hasFilters ? '' : 'none';
  }
}

function buildReportCharts() {
  // Distribuicao de Lucro (donut) — agora no Relatorios.
  // A canvas #pieChart foi MOVIDA do dashboard pra ca, entao precisamos
  // chamar a builder ao abrir Relatorios.
  if (typeof buildDashboardPieChart === 'function') buildDashboardPieChart();

  // Atualiza UI de filtros (chips, sumario, etc) antes de renderizar
  try { refreshReportFiltersUI(); } catch(e){}

  // Pega txs filtradas (periodo + categorias selecionadas)
  // Salva original pra restaurar depois caso buildDashboardPieChart precise
  const _filteredTxs = getFilteredReportTxs();

  // 1) LINE CHART — Receita vs Despesas vs Lucro mês a mês (com filtros)
  const aggregates = (function(){
    const map = {};
    _filteredTxs.forEach(t => {
      const ym = (t.date||'').slice(0,7);
      if (!ym) return;
      if (!map[ym]) map[ym] = { receita:0, despesas:0, lucro:0 };
      if (t.type === 'income')  map[ym].receita  += t.value;
      if (t.type === 'expense') map[ym].despesas += t.value;
      map[ym].lucro = map[ym].receita - map[ym].despesas;
    });
    return map;
  })();
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
    const wrap = ctx.parentElement;
    const emptyMsg = wrap ? wrap.querySelector('.chart-empty-msg') : null;
    if (emptyMsg) emptyMsg.remove();
    if(reportLineChart) { reportLineChart.destroy(); reportLineChart = null; }
    ctx.style.display = '';
    const ctxRC = ctx.getContext('2d');
    const g1 = ctxRC.createLinearGradient(0,0,0,320);
    g1.addColorStop(0,'rgba(59,130,246,0.25)'); g1.addColorStop(1,'rgba(59,130,246,0)');
    // Sempre line chart (como era originalmente). Com 1 ponto so, Chart.js
    // renderiza o ponto destacado — visual conhecido pelos usuarios.
    reportLineChart = new Chart(ctxRC, {
      type:'line',
      data:{
        labels,
        datasets:[
          {label:'Receita',  data:dataReceita,  borderColor:'#3b82f6', backgroundColor:g1, fill:true,  borderWidth:2.5, tension:0.4, pointRadius:4, pointHoverRadius:6},
          {label:'Lucro',    data:dataLucro,    borderColor:'#10b981', fill:false, borderWidth:2,   tension:0.4, pointRadius:4, pointHoverRadius:6},
          {label:'Despesas', data:dataDespesas, borderColor:'#f43f5e', fill:false, borderWidth:2,   tension:0.4, pointRadius:4, pointHoverRadius:6, borderDash:[4,4]},
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
  _filteredTxs.forEach(t => {
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

  // ROI por Metodo removido (a pedido do user). Distribuicao de Lucro
  // assume o lugar dele no chart-grid do Relatorios.
}

function initReportCharts() {
  buildReportCharts();
  // Heatmap so renderiza se o card estiver visivel (preview/localhost por enquanto)
  try {
    if (_isHeatmapEnabled()) {
      const card = document.getElementById('heatmapCard');
      if (card) card.style.display = '';
      renderActivityHeatmap();
    }
  } catch(e){}
}

// Feature flag: heatmap visivel apenas em preview/localhost ou via ?heatmap=1
function _isHeatmapEnabled(){
  try {
    const h = location.hostname || '';
    if (h === 'localhost' || h === '127.0.0.1' || h.startsWith('192.168.') || h.endsWith('.local')) return true;
    if (new URLSearchParams(location.search).get('heatmap') === '1') return true;
    return false;
  } catch(e){ return false; }
}

// ══════════════════════════════════════════════
//  CALENDÁRIO HEATMAP (estilo GitHub) — atividade dos últimos 6 meses
// ══════════════════════════════════════════════
var _heatmapMetric = 'count'; // 'count' | 'profit'

function setHeatmapMetric(metric, btn){
  _heatmapMetric = (metric === 'profit') ? 'profit' : 'count';
  document.querySelectorAll('.heatmap-tab').forEach(t => t.classList.remove('is-active'));
  if (btn) btn.classList.add('is-active');
  // Atualiza o texto explicativo segundo a metrica
  const help = document.getElementById('heatmapHelp');
  if (help){
    if (_heatmapMetric === 'profit'){
      help.innerHTML = 'Cada quadrado = 1 dia. <b style="color:#10b981">Verde = lucrou</b> · <b style="color:#ef4444">Vermelho = perdeu</b> · Cinza = dia sem aposta.';
    } else {
      help.innerHTML = 'Cada quadrado = 1 dia. <b>Verde mais forte = mais apostas no dia.</b> Cinza = dia sem aposta.';
    }
  }
  renderActivityHeatmap();
}

function _heatDateKey(d){
  // YYYY-MM-DD em horario local (nao UTC) pra nao deslocar dias
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,'0');
  const dd = String(d.getDate()).padStart(2,'0');
  return y+'-'+m+'-'+dd;
}

function _heatBuildBuckets(){
  // Map: 'YYYY-MM-DD' -> { count, profit }
  const map = {};
  if (typeof transactions === 'undefined' || !Array.isArray(transactions)) return map;
  transactions.forEach(t => {
    if (!t || !t.date) return;
    const key = t.date; // tx.date ja eh YYYY-MM-DD
    if (!map[key]) map[key] = { count: 0, profit: 0 };
    map[key].count++;
    const v = parseFloat(t.value) || 0;
    map[key].profit += (t.type === 'income') ? v : -v;
  });
  return map;
}

function _heatLevel(val, max, metric){
  if (!val) return 0;
  if (metric === 'profit'){
    // Escala sequencial 1..6 matching mockup (vinho->lilas)
    const ratio = Math.abs(val) / max;
    if (ratio > 0.83) return 6;
    if (ratio > 0.66) return 5;
    if (ratio > 0.5) return 4;
    if (ratio > 0.33) return 3;
    if (ratio > 0.16) return 2;
    return 1;
  }
  const ratio = val / max;
  if (ratio > 0.75) return 4;
  if (ratio > 0.5) return 3;
  if (ratio > 0.25) return 2;
  return 1;
}

function renderActivityHeatmap(){
  const wrap = document.getElementById('heatmapWrap');
  const empty = document.getElementById('heatmapEmpty');
  const legend = document.getElementById('heatmapLegend');
  const summary = document.getElementById('heatmapSummary');
  if (!wrap) return;

  const buckets = _heatBuildBuckets();
  const hasAny = Object.keys(buckets).length > 0;
  if (!hasAny){
    wrap.innerHTML = '';
    if (empty) { empty.style.display='block'; wrap.appendChild(empty); }
    if (legend) legend.style.display='none';
    return;
  }
  if (empty) empty.style.display='none';

  // 6 meses: hoje - 26 semanas. Alinhado em domingo (col=0).
  const today = new Date();
  today.setHours(0,0,0,0);
  const dow = today.getDay(); // 0=dom..6=sab
  const endCol = dow; // ultimo dia preenche ate essa linha
  const totalWeeks = 26;
  const totalDays = totalWeeks * 7;
  // Comeca de "totalDays" dias atras, ajustado pra domingo
  const start = new Date(today);
  start.setDate(today.getDate() - totalDays + 1 + (6 - endCol)); // alinha
  // Re-ajusta pra cair em domingo
  while (start.getDay() !== 0) start.setDate(start.getDate()-1);

  // Coleta valores existentes pro escala (max)
  const metric = _heatmapMetric;
  let maxVal = 0;
  let totalCount = 0;
  let totalProfit = 0;
  Object.keys(buckets).forEach(k => {
    const b = buckets[k];
    totalCount += b.count;
    totalProfit += b.profit;
    const v = (metric === 'profit') ? Math.abs(b.profit) : b.count;
    if (v > maxVal) maxVal = v;
  });
  if (maxVal === 0) maxVal = 1;

  // Monta SVG-like grid: colunas = semanas, linhas = dias da semana
  const cellSize = 26;
  const gap = 5;
  const monthLabelH = 46; // 2 linhas: mes + ano
  const dowLabelW = 28;
  const cols = totalWeeks;
  const rows = 7;
  const gridW = cols * (cellSize + gap);
  const gridH = rows * (cellSize + gap);
  const svgW = gridW + dowLabelW + 4;
  const svgH = gridH + monthLabelH + 2;

  let svg = '<svg width="'+svgW+'" height="'+svgH+'" viewBox="0 0 '+svgW+' '+svgH+'" class="heatmap-svg" preserveAspectRatio="xMinYMin meet" role="img" aria-label="Heatmap de atividade dos últimos 6 meses">';

  // Labels de dia — todas 7 linhas, 1 letra (posicao desambigua)
  const dowLabels = ['D','S','T','Q','Q','S','S'];
  for (let i = 0; i < 7; i++){
    const y = monthLabelH + i * (cellSize + gap) + cellSize - 2;
    svg += '<text x="0" y="'+y+'" class="heatmap-dow">'+dowLabels[i]+'</text>';
  }

  // Labels de mes — coloca quando primeira semana do mes aparece
  const monthNames = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
  let lastMonth = -1;
  // Itera semanas e dias
  const cells = [];
  for (let w = 0; w < cols; w++){
    for (let r = 0; r < rows; r++){
      const d = new Date(start);
      d.setDate(start.getDate() + w*7 + r);
      if (d > today) continue; // futuro nao mostra
      const key = _heatDateKey(d);
      const b = buckets[key];
      const val = b ? (metric === 'profit' ? b.profit : b.count) : 0;
      const level = b ? _heatLevel(val, maxVal, metric) : 0;
      const x = dowLabelW + w * (cellSize + gap);
      const y = monthLabelH + r * (cellSize + gap);
      const tooltip = _heatTooltip(d, b, metric);
      // Modo profit: escala sequencial 6 cores (vinho->lilas). Modo apostas: verde
      const baseCls = (metric === 'profit') ? 'heatmap-cell-p' : 'heatmap-cell';
      const cls = baseCls + ' level-'+level;
      cells.push('<rect x="'+x+'" y="'+y+'" width="'+cellSize+'" height="'+cellSize+'" rx="4" class="'+cls+'" data-date="'+key+'" data-tooltip="'+tooltip+'" />');

      // Label do mes + ano — primeira semana de cada mes na linha 0
      if (r === 0 && d.getMonth() !== lastMonth){
        lastMonth = d.getMonth();
        svg += '<text x="'+x+'" y="'+(monthLabelH-28)+'" class="heatmap-month">'+monthNames[d.getMonth()]+'</text>';
        svg += '<text x="'+x+'" y="'+(monthLabelH-12)+'" class="heatmap-year">'+d.getFullYear()+'</text>';
      }
    }
  }
  svg += cells.join('');
  svg += '</svg>';

  wrap.innerHTML = svg;

  // Liga tooltip nativo via mouseover
  wrap.querySelectorAll('.heatmap-cell').forEach(c => {
    c.addEventListener('mouseenter', _heatShowTooltip);
    c.addEventListener('mouseleave', _heatHideTooltip);
    c.addEventListener('click', _heatCellClick);
  });

  // Legenda + sumario
  if (legend){
    legend.style.display='flex';
    const legendItems = document.getElementById('heatmapLegendItems');
    if (legendItems){
      if (metric === 'profit'){
        // Legenda compacta estilo mockup mas com vermelho->verde divergente
        // (mantem semantica: vermelho perdeu, verde lucrou)
        legendItems.innerHTML =
          '<span class="heatmap-legitem-label">Menos lucro</span>' +
          '<span class="heatmap-legitem-scale">' +
            '<span class="heatmap-cell-p level-1"></span>' +
            '<span class="heatmap-cell-p level-2"></span>' +
            '<span class="heatmap-cell-p level-3"></span>' +
            '<span class="heatmap-cell-p level-4"></span>' +
            '<span class="heatmap-cell-p level-5"></span>' +
            '<span class="heatmap-cell-p level-6"></span>' +
          '</span>' +
          '<span class="heatmap-legitem-label">Mais lucro</span>';
      } else {
        // Modo apostas: escala verde com numeros reais
        const q = Math.max(1, Math.round(maxVal / 4));
        legendItems.innerHTML =
          '<span class="heatmap-legitem"><span class="heatmap-cell level-0"></span>0 apostas</span>' +
          '<span class="heatmap-legitem"><span class="heatmap-cell level-1"></span>1 aposta</span>' +
          '<span class="heatmap-legitem"><span class="heatmap-cell level-2"></span>até ' + (q*2) + '</span>' +
          '<span class="heatmap-legitem"><span class="heatmap-cell level-3"></span>até ' + (q*3) + '</span>' +
          '<span class="heatmap-legitem"><span class="heatmap-cell level-4"></span>' + (q*3+1) + ' ou mais</span>';
      }
    }
  }

  // Renderiza painel de Insights + barra de Resumo (so quando tem dados)
  try { renderHeatmapInsights(buckets, start, today); } catch(e){}
  try { renderHeatmapSummaryBar(start, today); } catch(e){}
}

// ─── Insights (painel lateral direito) ───
function renderHeatmapInsights(buckets, start, end){
  const panel = document.getElementById('heatmapInsights');
  if (!panel) return;
  const keys = Object.keys(buckets);
  if (!keys.length){ panel.style.display='none'; return; }
  panel.style.display = '';

  const totalDays = Math.max(1, Math.round((end - start) / 86400000));
  const activeDays = keys.length;
  const pct = Math.round((activeDays / totalDays) * 100);

  // Maior lucro diario
  let maxProfit = -Infinity, maxProfitDate = null;
  keys.forEach(k => { if (buckets[k].profit > maxProfit){ maxProfit = buckets[k].profit; maxProfitDate = k; }});

  // Melhor sequencia (consecutiva de dias ATIVOS)
  const sortedKeys = keys.slice().sort();
  let bestStreak = 0, bestStart = null, bestEnd = null;
  let curStreak = 1, curStart = sortedKeys[0];
  for (let i = 1; i < sortedKeys.length; i++){
    const prev = new Date(sortedKeys[i-1] + 'T00:00:00');
    const cur = new Date(sortedKeys[i] + 'T00:00:00');
    const diff = Math.round((cur - prev) / 86400000);
    if (diff === 1){ curStreak++; }
    else {
      if (curStreak > bestStreak){ bestStreak = curStreak; bestStart = curStart; bestEnd = sortedKeys[i-1]; }
      curStreak = 1; curStart = sortedKeys[i];
    }
  }
  if (curStreak > bestStreak){ bestStreak = curStreak; bestStart = curStart; bestEnd = sortedKeys[sortedKeys.length-1]; }

  // Media semanal (lucro total / numero de semanas com pelo menos 1 dia ativo)
  let totalProfit = 0;
  keys.forEach(k => totalProfit += buckets[k].profit);
  const weeksWithActivity = Math.max(1, Math.ceil(activeDays / 7));
  const avgWeek = totalProfit / weeksWithActivity;

  const fmtBR = v => v.toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2});
  const fmtDay = k => {
    const d = new Date(k+'T00:00:00');
    return d.toLocaleDateString('pt-BR',{day:'2-digit',month:'short'}).replace('.','');
  };

  document.getElementById('insDiasAtivos').textContent = activeDays;
  document.getElementById('insDiasAtivosSub').textContent = 'de ' + totalDays + ' dias';
  document.getElementById('insDiasAtivosPct').textContent = pct + '%';

  document.getElementById('insSequencia').textContent = bestStreak + ' dia' + (bestStreak !== 1 ? 's' : '');
  document.getElementById('insSequenciaSub').textContent = bestStart ? (fmtDay(bestStart) + (bestStart !== bestEnd ? ' – ' + fmtDay(bestEnd) : '')) : '—';

  const lucroEl = document.getElementById('insMaiorLucro');
  if (maxProfit > 0){
    lucroEl.textContent = 'R$ ' + fmtBR(maxProfit);
    lucroEl.className = 'is-pos';
  } else if (maxProfit < 0){
    lucroEl.textContent = '-R$ ' + fmtBR(Math.abs(maxProfit));
    lucroEl.className = 'is-neg';
  } else {
    lucroEl.textContent = 'R$ 0,00';
    lucroEl.className = '';
  }
  document.getElementById('insMaiorLucroSub').textContent = maxProfitDate ? fmtDay(maxProfitDate) : '—';

  const mediaEl = document.getElementById('insMediaSemana');
  if (avgWeek >= 0){
    mediaEl.textContent = 'R$ ' + fmtBR(avgWeek);
    mediaEl.className = 'is-pos';
  } else {
    mediaEl.textContent = '-R$ ' + fmtBR(Math.abs(avgWeek));
    mediaEl.className = 'is-neg';
  }
}

// ─── Resumo do periodo (barra inferior) ───
function renderHeatmapSummaryBar(start, end){
  const bar = document.getElementById('heatmapSummaryBar');
  if (!bar) return;
  if (typeof transactions === 'undefined' || !Array.isArray(transactions) || !transactions.length){
    bar.style.display='none'; return;
  }
  bar.style.display = '';

  const startKey = _heatDateKey(start);
  const endKey = _heatDateKey(end);
  const inRange = transactions.filter(t => t && t.date && t.date >= startKey && t.date <= endKey);

  let lucro = 0, totalStake = 0, countStake = 0;
  inRange.forEach(t => {
    const v = parseFloat(t.value) || 0;
    if (t.type === 'income') lucro += v;
    else { lucro -= v; totalStake += v; countStake++; }
  });
  const apostas = inRange.length;
  const avgStake = countStake ? (totalStake / countStake) : 0;
  const roi = totalStake > 0 ? ((lucro / totalStake) * 100) : 0;

  // Bankroll atual = saldo inicial + lucro total geral (todas as txs)
  let saldoInicial = 0;
  try { saldoInicial = parseFloat(localStorage.getItem('bancapro-saldo-inicial') || '0') || 0; } catch(e){}
  let totalLucroAll = 0;
  transactions.forEach(t => {
    const v = parseFloat(t.value) || 0;
    totalLucroAll += (t.type === 'income') ? v : -v;
  });
  const bankroll = saldoInicial + totalLucroAll;

  const fmtBR = v => v.toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2});
  const fmtDay = d => d.toLocaleDateString('pt-BR',{day:'2-digit',month:'short',year:'numeric'}).replace('.','');

  document.getElementById('sumPeriodo').textContent = 'De ' + fmtDay(start) + ' até ' + fmtDay(end);

  const lucroEl = document.getElementById('sumLucro');
  if (lucro >= 0){
    lucroEl.textContent = 'R$ ' + fmtBR(lucro);
    lucroEl.className = 'heatmap-summary-kpi-val is-pos';
  } else {
    lucroEl.textContent = '-R$ ' + fmtBR(Math.abs(lucro));
    lucroEl.className = 'heatmap-summary-kpi-val is-neg';
  }

  document.getElementById('sumApostas').textContent = apostas;

  const roiEl = document.getElementById('sumRoi');
  roiEl.textContent = (roi >= 0 ? '' : '-') + Math.abs(roi).toFixed(1).replace('.',',') + '%';
  roiEl.className = 'heatmap-summary-kpi-val ' + (roi >= 0 ? 'is-pos' : 'is-neg');

  document.getElementById('sumStake').textContent = 'R$ ' + fmtBR(avgStake);
  document.getElementById('sumBankroll').textContent = 'R$ ' + fmtBR(bankroll);
}

function _heatTooltip(date, bucket, metric){
  const d = date.toLocaleDateString('pt-BR', { weekday:'short', day:'2-digit', month:'short' });
  if (!bucket){ return d + ' — sem atividade'; }
  if (metric === 'profit'){
    const sign = bucket.profit >= 0 ? '+' : '-';
    return d + ' — ' + bucket.count + ' tx · ' + sign + 'R$ ' + Math.abs(bucket.profit).toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2});
  }
  return d + ' — ' + bucket.count + ' transação' + (bucket.count !== 1 ? 'ões' : '');
}

var _heatTooltipEl = null;
function _heatShowTooltip(ev){
  const cell = ev.currentTarget;
  const text = cell.getAttribute('data-tooltip') || '';
  if (!_heatTooltipEl){
    _heatTooltipEl = document.createElement('div');
    _heatTooltipEl.className = 'heatmap-tooltip';
    document.body.appendChild(_heatTooltipEl);
  }
  _heatTooltipEl.textContent = text;
  _heatTooltipEl.style.display = 'block';
  const r = cell.getBoundingClientRect();
  const tw = _heatTooltipEl.offsetWidth;
  const th = _heatTooltipEl.offsetHeight;
  let left = r.left + r.width/2 - tw/2 + window.scrollX;
  let top  = r.top - th - 8 + window.scrollY;
  left = Math.max(8, Math.min(left, window.scrollX + window.innerWidth - tw - 8));
  if (top < window.scrollY + 8) top = r.bottom + 8 + window.scrollY;
  _heatTooltipEl.style.left = left + 'px';
  _heatTooltipEl.style.top  = top + 'px';
}
function _heatHideTooltip(){
  if (_heatTooltipEl) _heatTooltipEl.style.display = 'none';
}
function _heatCellClick(ev){
  // Click numa celula filtra Transacoes pela data
  const key = ev.currentTarget.getAttribute('data-date');
  if (!key) return;
  if (typeof goTo === 'function') goTo('transactions');
  // Aplica filtro de busca pela data no campo de search das transacoes
  setTimeout(() => {
    const searchInput = document.querySelector('#txSearch, #transactionsSearch, [id*="earch"][placeholder]');
    if (searchInput){
      const br = key.split('-').reverse().join('/');
      searchInput.value = br;
      searchInput.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }, 200);
}


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

  // Mobile (<960px): legend mais compacta pra nao ocupar mais espaco que o grafico
  const isMobile = window.innerWidth < 960;
  const legendCfg = isMobile
    ? { font:{size:10}, padding:6, boxWidth:8, boxHeight:8 }
    : { font:{size:12}, padding:14, boxWidth:11, boxHeight:11 };

  methodEvolutionInstance = new Chart(canvas.getContext('2d'), {
    type:'line',
    data:{ labels, datasets },
    options:{
      responsive:true, maintainAspectRatio:false,
      interaction:{mode:'index',intersect:false},
      layout:{padding:{top:6,right:10,left:0,bottom:0}},
      plugins:{
        legend:{
          display:true, position:'top', align:isMobile?'center':'end',
          labels:{color:getChartColors().text, ...legendCfg, usePointStyle:true, pointStyle:'circle'}
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
      overlay.innerHTML = '<div style="width:48px;height:48px;border-radius:12px;background:rgba(124,92,255,.12);border:1px solid rgba(124,92,255,.32);display:flex;align-items:center;justify-content:center;margin-bottom:10px;color:#a78bfa"><svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 20h18M7 20V12M12 20V8M17 20v-6"/></svg></div><div style="font-size:14px;font-weight:600;color:var(--text-secondary)">Sem dados nos últimos 6 meses</div><div style="font-size:12px;color:var(--text-muted);margin-top:4px">Adicione transações para ver a evolução por método</div>';
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

// ═══════════════════════════════════════════════════════════════
// RANKING
// ═══════════════════════════════════════════════════════════════
const RANK_TIERS = [
  { idx:1,  name:'Ferro',     min:0,        color:'#9CA4B3', g1:'#C9D0DA', g2:'#7B8596', desc:'Iniciante. Cada real lucrado é um passo na sua jornada.' },
  { idx:2,  name:'Bronze',    min:1000,     color:'#C58147', g1:'#F0B06B', g2:'#9A5B22', desc:'Você já saiu do zero. O primeiro milhar de lucro está na conta.' },
  { idx:3,  name:'Prata',     min:3000,     color:'#D2DAE6', g1:'#F8FBFF', g2:'#AAB4C3', desc:'Apostador consistente. Seu lucro já está acima da média.' },
  { idx:4,  name:'Ouro',      min:5000,     color:'#F0CA53', g1:'#FFF2A6', g2:'#D8A100', desc:'Apostador disciplinado. Você opera com método e resultado.' },
  { idx:5,  name:'Platina',   min:10000,    color:'#A3BECF', g1:'#D8ECF7', g2:'#6E90A7', desc:'Veterano. Cinco dígitos de lucro. Você domina a gestão da banca.' },
  { idx:6,  name:'Esmeralda', min:20000,    color:'#329F84', g1:'#59F1B6', g2:'#0B6B52', desc:'Estrategista. Suas decisões são baseadas em dados, e o lucro mostra.' },
  { idx:7,  name:'Safira',    min:50000,    color:'#5085E4', g1:'#8FC4FF', g2:'#1746C9', desc:'Apostador profissional. Meio centena de mil em lucro acumulado.' },
  { idx:8,  name:'Rubi',      min:75000,    color:'#C53F63', g1:'#FF6A8C', g2:'#8B123A', desc:'Top 30%. Poucos apostadores chegam neste patamar de lucro.' },
  { idx:9,  name:'Diamante',  min:100000,   color:'#BEE3FF', g1:'#FFFFFF', g2:'#7DC7FF', desc:'Elite. Seis dígitos de lucro acumulado. Sua gestão é referência.' },
  { idx:10, name:'Mestre',    min:150000,   color:'#9462E3', g1:'#CFA2FF', g2:'#5A22C8', desc:'Mestre da banca. Disciplina e lucro em altíssimo nível.' },
  { idx:11, name:'Elite',     min:250000,   color:'#49B7CA', g1:'#8BF3FF', g2:'#067C95', desc:'Top 5%. Você está entre os melhores apostadores.' },
  { idx:12, name:'Lendário',  min:500000,   color:'#E98E35', g1:'#FFD36B', g2:'#D34A00', desc:'Lendário. Meio milhão de reais em lucro acumulado.' },
  { idx:13, name:'Imortal',   min:700000,   color:'#A66CE4', g1:'#E1B8FF', g2:'#6120C4', desc:'Status raro. Pouquíssimos apostadores chegam aqui.' },
  { idx:14, name:'Supremo',   min:850000,   color:'gradient',g1:'#7D3CFF', via:'#4ACBFF', g2:'#E86BFF', desc:'Status supremo. A um passo do milhão em lucro acumulado.' },
  { idx:15, name:'Apex',      min:1000000,  color:'#F2C230', g1:'#FFF8D1', via:'#F2C230', g2:'#C99200', desc:'O topo absoluto. R$ 1 milhão em lucro acumulado. Você é o melhor.' }
];

function rankFormatMin(n){
  if (n === 0) return 'R$ 0';
  if (n >= 1000000){
    const m = n / 1000000;
    const str = m === Math.floor(m) ? String(m) : m.toFixed(1).replace('.',',');
    return 'R$ ' + str + 'M+';
  }
  if (n >= 1000){
    const k = n / 1000;
    const str = k >= 10 ? String(Math.round(k)) : k.toFixed(1).replace('.0','').replace('.',',');
    return 'R$ ' + str + 'k+';
  }
  return 'R$ ' + n + '+';
}
function rankFormatValue(n){
  if (n < 1000) return 'R$ ' + n.toFixed(0);
  return 'R$ ' + n.toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

// Mapeamento tier.idx -> nome do arquivo PNG em brand/ranking/
const RANK_IMAGE_FILES = {
  1:'01-ferro', 2:'02-bronze', 3:'03-prata', 4:'04-ouro', 5:'05-platina',
  6:'06-esmeralda', 7:'07-safira', 8:'08-rubi', 9:'09-diamante', 10:'10-mestre',
  11:'11-elite', 12:'12-lendario', 13:'13-imortal', 14:'14-supremo', 15:'15-apex'
};

// Detecta tema atual e retorna a pasta de PNGs apropriada.
// Tema escuro: brand/ranking/ (PNGs originais com sombra/glow)
// Tema claro:  brand/ranking tema claro/ (versoes sem sombra)
function rankImagesFolder(){
  try {
    if (document.documentElement.classList.contains('light')) return 'brand/ranking tema claro';
  } catch(e){}
  return 'brand/ranking';
}
function medalsFolder(){
  try {
    if (document.documentElement.classList.contains('light')) return 'brand/ranking tema claro';
  } catch(e){}
  return 'brand/medals';
}

function rankShieldSVG(tier){
  // Usa imagem PNG premium dos ranks (brand/ranking/ ou tema claro)
  if (tier && tier.idx && RANK_IMAGE_FILES[tier.idx]){
    return '<img class="rank-shield-img" src="'+rankImagesFolder()+'/'+RANK_IMAGE_FILES[tier.idx]+'.png" alt="'+tier.name+'" loading="eager"/>';
  }
  // Fallback SVG (caso falte alguma imagem)
  const uid = 'rk'+(tier?.idx||0)+'_'+Math.random().toString(36).slice(2,8);
  const g1 = tier.g1, g2 = tier.g2;
  const isSupreme = tier.color === 'gradient';
  // Gradient principal (4 stops pra profundidade extra)
  const mainStops = isSupreme
    ? '<stop offset="0" stop-color="#fbbf24"/><stop offset="0.25" stop-color="#ec4899"/><stop offset="0.55" stop-color="#a855f7"/><stop offset="0.85" stop-color="#3b82f6"/><stop offset="1" stop-color="#22d3ee"/>'
    : '<stop offset="0" stop-color="'+g1+'"/><stop offset="0.45" stop-color="'+tier.color+'"/><stop offset="0.85" stop-color="'+g2+'"/><stop offset="1" stop-color="rgba(0,0,0,.4)"/>';
  const defs = '<defs>'+
    '<linearGradient id="'+uid+'_main" x1="0" y1="0" x2="0" y2="1">'+mainStops+'</linearGradient>'+
    // Highlight radial superior (especular metalico)
    '<radialGradient id="'+uid+'_highlight" cx="32%" cy="22%" r="55%">'+
      '<stop offset="0" stop-color="rgba(255,255,255,.85)"/>'+
      '<stop offset="0.4" stop-color="rgba(255,255,255,.25)"/>'+
      '<stop offset="1" stop-color="rgba(255,255,255,0)"/>'+
    '</radialGradient>'+
    // Glow externo na base
    '<radialGradient id="'+uid+'_glow" cx="50%" cy="100%" r="80%">'+
      '<stop offset="0" stop-color="'+(isSupreme?'#a855f7':tier.color)+'" stop-opacity=".65"/>'+
      '<stop offset="1" stop-color="'+(isSupreme?'#a855f7':tier.color)+'" stop-opacity="0"/>'+
    '</radialGradient>'+
    // Rim shine (borda iluminada no topo)
    '<linearGradient id="'+uid+'_rim" x1="0" y1="0" x2="0" y2="1">'+
      '<stop offset="0" stop-color="rgba(255,255,255,.45)"/>'+
      '<stop offset="0.4" stop-color="rgba(255,255,255,0)"/>'+
    '</linearGradient>'+
    // Sombra interna gradiente vertical
    '<linearGradient id="'+uid+'_shadow" x1="0" y1="0.5" x2="0" y2="1">'+
      '<stop offset="0" stop-color="rgba(0,0,0,0)"/>'+
      '<stop offset="1" stop-color="rgba(0,0,0,.35)"/>'+
    '</linearGradient>'+
    '</defs>';
  const glowBg = '<ellipse cx="30" cy="62" rx="22" ry="6" fill="url(#'+uid+'_glow)"/>';

  let shape = '', emblem = '';

  // Tier 1-5: Shield shapes (Ferro/Bronze/Prata/Ouro/Platina)
  if (tier.idx <= 5) {
    const shieldPath = 'M30 6 L52 14 V30 C52 46 42 58 30 64 C18 58 8 46 8 30 V14 Z';
    shape = '<path d="'+shieldPath+'" fill="url(#'+uid+'_main)" stroke="rgba(0,0,0,.4)" stroke-width="1.3" stroke-linejoin="round"/>'+
            // Sombra interna na base
            '<path d="'+shieldPath+'" fill="url(#'+uid+'_shadow)"/>'+
            // Highlight especular
            '<path d="'+shieldPath+'" fill="url(#'+uid+'_highlight)"/>'+
            // Rim shine na borda superior
            '<path d="M30 6 L52 14 V20 C52 22 51 24 49 25 L30 14 L11 25 C9 24 8 22 8 20 V14 Z" fill="url(#'+uid+'_rim)" opacity=".8"/>';
    if (tier.idx === 1) emblem = '<path d="M22 28 L30 22 L38 28 L35 40 L25 40 Z" fill="rgba(255,255,255,.45)"/>';
    else if (tier.idx === 2) emblem = '<path d="M30 22 L36 28 V40 H24 V28 Z" fill="rgba(255,255,255,.55)"/><path d="M30 22 V40" stroke="rgba(0,0,0,.25)" stroke-width="1"/>';
    else if (tier.idx === 3) emblem = '<circle cx="30" cy="32" r="7" fill="rgba(255,255,255,.65)"/><circle cx="30" cy="32" r="3" fill="rgba(255,255,255,.9)"/>';
    else if (tier.idx === 4) emblem = '<path d="M30 22 L33 30 L41 30 L34.5 35 L37 43 L30 38 L23 43 L25.5 35 L19 30 L27 30 Z" fill="rgba(255,255,255,.9)"/>';
    else emblem = '<path d="M22 32 Q30 22 38 32 Q34 38 30 38 Q26 38 22 32 Z" fill="rgba(255,255,255,.7)"/><circle cx="30" cy="32" r="2" fill="rgba(255,255,255,.95)"/>';
  }
  // Tier 6-8: Cut gems (Esmeralda/Safira/Rubi)
  else if (tier.idx <= 8) {
    // Gema lapidada com 5 facetas pra realismo
    shape = '<path d="M30 8 L48 22 L42 58 L18 58 L12 22 Z" fill="url(#'+uid+'_main)" stroke="rgba(0,0,0,.4)" stroke-width="1.3" stroke-linejoin="round"/>'+
            // Faceta superior esquerda (highlight forte)
            '<path d="M30 8 L12 22 L30 32 Z" fill="rgba(255,255,255,.4)"/>'+
            // Faceta superior direita
            '<path d="M30 8 L48 22 L30 32 Z" fill="rgba(255,255,255,.18)"/>'+
            // Faceta inferior esquerda (sombra)
            '<path d="M12 22 L30 32 L18 58 Z" fill="rgba(0,0,0,.22)"/>'+
            // Faceta inferior direita (sombra mais escura)
            '<path d="M48 22 L30 32 L42 58 Z" fill="rgba(0,0,0,.32)"/>'+
            // Linhas de divisão das facetas
            '<path d="M30 8 L30 32" stroke="rgba(255,255,255,.35)" stroke-width=".7"/>'+
            '<path d="M12 22 L30 32" stroke="rgba(255,255,255,.18)" stroke-width=".7"/>'+
            '<path d="M48 22 L30 32" stroke="rgba(255,255,255,.12)" stroke-width=".7"/>'+
            '<path d="M30 32 L42 58" stroke="rgba(0,0,0,.25)" stroke-width=".7"/>'+
            '<path d="M30 32 L18 58" stroke="rgba(0,0,0,.2)" stroke-width=".7"/>'+
            // Sparkle pequeno no topo
            '<circle cx="22" cy="20" r="2.5" fill="rgba(255,255,255,.7)"/>'+
            '<circle cx="22" cy="20" r="1" fill="rgba(255,255,255,.95)"/>';
  }
  // Tier 9: Diamond
  else if (tier.idx === 9) {
    shape = '<path d="M30 8 L52 26 L30 64 L8 26 Z" fill="url(#'+uid+'_main)" stroke="rgba(0,0,0,.35)" stroke-width="1.4" stroke-linejoin="round"/>'+
            // Faceta topo direita (brilho forte)
            '<path d="M30 8 L52 26 L30 26 Z" fill="rgba(255,255,255,.55)"/>'+
            // Faceta topo esquerda
            '<path d="M8 26 L30 26 L30 8 Z" fill="rgba(255,255,255,.3)"/>'+
            // Faceta inferior direita (sombra)
            '<path d="M30 26 L52 26 L30 64 Z" fill="rgba(0,0,0,.2)"/>'+
            // Faceta inferior esquerda
            '<path d="M30 26 L8 26 L30 64 Z" fill="rgba(0,0,0,.08)"/>'+
            // Centro divisor
            '<path d="M8 26 L52 26" stroke="rgba(255,255,255,.4)" stroke-width=".8"/>'+
            // Sparkles
            '<circle cx="20" cy="20" r="1.8" fill="rgba(255,255,255,.85)"/>'+
            '<circle cx="40" cy="14" r="1.2" fill="rgba(255,255,255,.7)"/>';
  }
  // Tier 10: Crown (Mestre)
  else if (tier.idx === 10) {
    shape = '<path d="M30 6 L52 14 V30 C52 46 42 58 30 64 C18 58 8 46 8 30 V14 Z" fill="url(#'+uid+'_main)" stroke="rgba(0,0,0,.3)" stroke-width="1.2"/>'+
            '<path d="M30 6 L52 14 V30 C52 34 51 38 49 41 L30 30 Z" fill="url(#'+uid+'_shine)" opacity=".5"/>';
    emblem = '<path d="M18 28 L22 36 L30 22 L38 36 L42 28 L40 44 L20 44 Z" fill="rgba(255,255,255,.92)" stroke="rgba(0,0,0,.2)" stroke-width=".5"/>'+
             '<circle cx="22" cy="36" r="1.6" fill="'+tier.color+'"/>'+
             '<circle cx="30" cy="22" r="1.6" fill="'+tier.color+'"/>'+
             '<circle cx="38" cy="36" r="1.6" fill="'+tier.color+'"/>';
  }
  // Tier 11: Lightning (Elite)
  else if (tier.idx === 11) {
    shape = '<circle cx="30" cy="34" r="26" fill="url(#'+uid+'_main)" stroke="rgba(0,0,0,.3)" stroke-width="1.2"/>'+
            '<path d="M10 22 Q30 8 50 22 Q42 28 30 28 Q18 28 10 22 Z" fill="url(#'+uid+'_shine)" opacity=".55"/>';
    emblem = '<path d="M33 18 L22 36 L29 36 L26 50 L40 30 L32 30 L37 18 Z" fill="rgba(255,255,255,.95)" stroke="rgba(0,0,0,.18)" stroke-width=".5"/>';
  }
  // Tier 12: Flame (Lendário)
  else if (tier.idx === 12) {
    shape = '<path d="M30 8 C44 18 48 30 44 42 C42 54 36 62 30 64 C24 62 18 54 16 42 C12 30 16 18 30 8 Z" fill="url(#'+uid+'_main)" stroke="rgba(0,0,0,.3)" stroke-width="1.2"/>';
    emblem = '<path d="M30 22 C36 28 38 36 35 44 C34 50 31 54 30 56 C29 54 26 50 25 44 C22 36 24 28 30 22 Z" fill="rgba(255,255,255,.85)"/>'+
             '<path d="M30 32 C32 36 33 40 32 44 C31 47 30 49 30 50 C30 49 29 47 28 44 C27 40 28 36 30 32 Z" fill="'+tier.color+'"/>';
  }
  // Tier 13: Eye (Imortal)
  else if (tier.idx === 13) {
    shape = '<path d="M30 6 L52 14 V30 C52 46 42 58 30 64 C18 58 8 46 8 30 V14 Z" fill="url(#'+uid+'_main)" stroke="rgba(0,0,0,.3)" stroke-width="1.2"/>'+
            '<path d="M30 6 L52 14 V30 C52 34 51 38 49 41 L30 30 Z" fill="url(#'+uid+'_shine)" opacity=".55"/>';
    emblem = '<path d="M14 34 Q30 22 46 34 Q30 46 14 34 Z" fill="rgba(255,255,255,.95)"/>'+
             '<circle cx="30" cy="34" r="6" fill="'+tier.color+'"/>'+
             '<circle cx="30" cy="34" r="2.5" fill="#000"/>';
  }
  // Tier 14: Rainbow gradient (Supremo)
  else if (tier.idx === 14) {
    shape = '<rect x="6" y="10" width="48" height="52" rx="6" fill="url(#'+uid+'_main)" stroke="rgba(255,255,255,.25)" stroke-width="1.4"/>'+
            '<rect x="9" y="13" width="42" height="14" rx="3" fill="rgba(255,255,255,.25)"/>'+
            '<rect x="9" y="46" width="42" height="13" rx="3" fill="rgba(0,0,0,.18)"/>';
    emblem = '<path d="M30 22 L34 30 L42 30 L36 35 L38 43 L30 38 L22 43 L24 35 L18 30 L26 30 Z" fill="rgba(255,255,255,.95)"/>';
  }
  // Tier 15: Apex Star (dark frame, gold star)
  else {
    shape = '<rect x="6" y="8" width="48" height="56" rx="6" fill="#0a0e1d" stroke="url(#'+uid+'_main)" stroke-width="2"/>'+
            '<rect x="10" y="12" width="40" height="48" rx="4" fill="rgba(250,204,21,.08)"/>';
    emblem = '<path d="M30 18 L34 28 L45 29 L37 36 L40 47 L30 41 L20 47 L23 36 L15 29 L26 28 Z" fill="url(#'+uid+'_main)" stroke="rgba(0,0,0,.3)" stroke-width=".5"/>';
  }

  return '<svg viewBox="0 0 60 70" xmlns="http://www.w3.org/2000/svg">'+defs+glowBg+shape+emblem+'</svg>';
}

function rankComputeCurrent(count){
  let current = RANK_TIERS[0];
  for (let i = 0; i < RANK_TIERS.length; i++){
    if (count >= RANK_TIERS[i].min) current = RANK_TIERS[i];
  }
  const next = RANK_TIERS[current.idx] || null; // tier idx is 1-based, next is at array[current.idx]
  return { current, next };
}

// Leaderboard global — lista mockada (até backend Supabase ter view de lucro por usuário)
const RANK_MOCK_USERS = [
  { name: 'Carlos M.',  profit: 1247380 },
  { name: 'Felipe G.',  profit: 932150  },
  { name: 'Rafael S.',  profit: 716420  },
  { name: 'Bruno T.',   profit: 642180  },
  { name: 'Lucas P.',   profit: 558900  },
  { name: 'Mateus L.',  profit: 489300  },
  { name: 'Vinícius R.',profit: 422150  },
  { name: 'Pedro H.',   profit: 380420  },
  { name: 'Diego A.',   profit: 318750  },
  { name: 'Thiago F.',  profit: 274100  },
  { name: 'Caio B.',    profit: 226880  },
  { name: 'Igor V.',    profit: 198450  },
  { name: 'Marcelo D.', profit: 172300  },
  { name: 'Anderson Q.',profit: 148720  },
  { name: 'Henrique J.',profit: 132100  },
  { name: 'Eduardo M.', profit: 109840  },
  { name: 'Gabriel R.', profit: 89320   },
  { name: 'Rodrigo S.', profit: 74180   },
  { name: 'Fernando V.',profit: 62450   },
  { name: 'André N.',   profit: 51230   },
  { name: 'Leonardo F.',profit: 42890   },
  { name: 'Daniel O.',  profit: 35610   },
  { name: 'Renato P.',  profit: 28740   },
  { name: 'Gustavo M.', profit: 22150   },
  { name: 'Vitor C.',   profit: 17320   },
  { name: 'Felipe O.',  profit: 13680   },
  { name: 'Murilo K.',  profit: 9420    },
  { name: 'Ricardo L.', profit: 6850    },
  { name: 'Otávio R.',  profit: 4120    },
  { name: 'Samuel A.',  profit: 2380    }
];

// Critérios pra entrar no ranking global (mantidos em sync com o RPC get_leaderboard)
// minActiveDays:2 — vitrine viva pra fase de tração (anti-cheat forte vem do minTx:10).
// Plano de evolução: subir pra 3 dias quando tiver ~100 usuários ativos.
const RANK_ELIGIBILITY = {
  minTx: 10,
  minActiveDays: 2,
  minProfit: 1
};

// Calcula o streak (dias consecutivos com transação registrada)
function rankComputeStreak(){
  const txs = (typeof transactions !== 'undefined' && Array.isArray(transactions)) ? transactions : [];
  const dates = Array.from(new Set(txs.map(t => t.date).filter(Boolean))).sort();
  if (dates.length === 0) return { current: 0, atRisk: false, longest: 0 };

  function dStr(d){ return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
  const today = dStr(new Date());
  const yest = new Date(); yest.setDate(yest.getDate() - 1);
  const yestStr = dStr(yest);

  const last = dates[dates.length - 1];

  // Streak quebrado: última transação é antes de ontem
  if (last < yestStr) return { current: 0, atRisk: false, longest: 0 };

  const atRisk = last === yestStr; // ainda não registrou hoje — em risco

  // Conta dias consecutivos voltando do último
  let current = 1;
  let prev = new Date(last);
  for (let i = dates.length - 2; i >= 0; i--){
    const this_d = new Date(dates[i]);
    const diff = Math.round((prev.getTime() - this_d.getTime()) / 86400000);
    if (diff === 1){ current++; prev = this_d; }
    else if (diff === 0){ /* mesma data, skip */ }
    else break;
  }

  // Também calcula o maior streak histórico (pra mostrar "recorde")
  let longest = 1, run = 1;
  for (let i = 1; i < dates.length; i++){
    const a = new Date(dates[i-1]);
    const b = new Date(dates[i]);
    const d = Math.round((b.getTime() - a.getTime()) / 86400000);
    if (d === 1) run++;
    else if (d > 1) run = 1;
    if (run > longest) longest = run;
  }
  return { current, atRisk, longest };
}

function rankComputeEligibility(){
  const txs = (typeof transactions !== 'undefined' && Array.isArray(transactions)) ? transactions : [];
  const txCount = txs.length;
  const distinctDays = new Set(txs.map(t => t.date).filter(Boolean)).size;
  let profit = 0;
  for (let i = 0; i < txs.length; i++){
    const v = Number(txs[i].value) || 0;
    if (txs[i].type === 'income') profit += v;
    else if (txs[i].type === 'expense') profit -= v;
  }
  // Pro/Plus/Administrador sao sempre elegiveis (independente de atividade local)
  let isPro = false;
  try {
    const planLabel = localStorage.getItem('bancapro-plan-label') || '';
    isPro = ['Plus','Pro','Administrador'].indexOf(planLabel) >= 0 || !!window._isProSubscriber;
  } catch(e){}
  return {
    txCount, distinctDays, profit: Math.max(0, profit), isPro,
    eligible: isPro || (txCount >= RANK_ELIGIBILITY.minTx
      && distinctDays >= RANK_ELIGIBILITY.minActiveDays
      && profit >= RANK_ELIGIBILITY.minProfit)
  };
}

// Normaliza nomes pra comparação (lowercase + trim + remove acentos + colapsa espaços)
function rankNormalizeName(n){
  return (n || '')
    .toString()
    .toLowerCase()
    .trim()
    .normalize('NFD')
    .replace(new RegExp('[\\u0300-\\u036f]', 'g'), '')
    .replace(/\s+/g, ' ');
}

function rankBuildLeaderboard(youProfit, youName, source){
  // Mock so eh usado quando NAO ha Supabase (modo local de demo)
  // Se Supabase esta conectado, source [] eh resposta valida = ninguem ainda
  const hasSb = (typeof getSb === 'function') && !!getSb();
  let base;
  if (Array.isArray(source)){
    base = source; // RPC respondeu (mesmo vazio) — usa o que veio
  } else if (!hasSb){
    base = RANK_MOCK_USERS; // local dev sem backend — mock visual
  } else {
    base = []; // ha Supabase mas cache ainda nao populou — vazio temporario
  }
  // Filtra contas de dono (admin) que possam vir do RPC.
  // Source of truth: config.js (window.OWNERS.signatures).
  // Pra adicionar/remover owner editar la — aqui so puxa.
  const OWNER_SIGNATURES = (window.OWNERS && Array.isArray(window.OWNERS.signatures) && window.OWNERS.signatures.length)
    ? window.OWNERS.signatures
    : ['loamy neri','loamy 2002','loamy2002','loamy 69','loamy69','loamyzito admin','loamy admin','admin loamy','apostack admin'];
  base = base.filter(u => {
    var raw = (u.name||'').toString().trim().toLowerCase();
    // Remove acentos pra comparacao mais flexivel
    var n = raw.normalize('NFD').replace(/[̀-ͯ]/g, '');
    for (var i = 0; i < OWNER_SIGNATURES.length; i++){
      if (n.indexOf(OWNER_SIGNATURES[i]) >= 0) return false;
    }
    return true;
  });
  const all = base.map(u => Object.assign({ isYou: false }, u));

  // Donos (admin) NUNCA aparecem no ranking — nem pra si mesmos.
  // Bug anterior: usuario admin se via como participante do ranking porque o
  // codigo abaixo empurrava `me` pro array sem checar OWNER_EMAILS.
  let isOwner = false;
  try {
    var myEmail = (currentAuthUser && currentAuthUser.email || '').toLowerCase();
    if (!myEmail) myEmail = (localStorage.getItem('bancapro-user-email') || '').toLowerCase();
    isOwner = typeof OWNER_EMAILS !== 'undefined' && OWNER_EMAILS.indexOf(myEmail) >= 0;
  } catch(e){}

  const youNameNorm = rankNormalizeName(youName);

  // Procura minha entrada na lista (matching robusto: case-insensitive, sem acento, trim)
  const existing = youNameNorm
    ? all.findIndex(u => rankNormalizeName(u.name) === youNameNorm)
    : -1;

  let youIsPro = !!window._isProSubscriber;
  if (existing >= 0){
    youIsPro = !!all[existing].isPro;
    if (isOwner){
      // Admin nao deve aparecer — remove a entrada existente
      all.splice(existing, 1);
    } else {
      // Já estou no leaderboard (via Pro ou atividade) — marca como isYou
      // Mantém o profit do RPC (source-of-truth) e sobrescreve nome/isYou
      all[existing] = Object.assign({}, all[existing], { isYou: true, name: youName });
    }
  } else if (!isOwner) {
    // Não estou no leaderboard — só insere se passar nos critérios de elegibilidade
    // (e nao for admin)
    const elig = rankComputeEligibility();
    if (elig.eligible){
      const me = { name: youName || 'Você', profit: youProfit, isYou: true, isPro: youIsPro };
      all.push(me);
    }
  }

  all.sort((a, b) => b.profit - a.profit);
  return all;
}

// Busca leaderboard real do Supabase via RPC get_leaderboard (computa lucro de todos os usuários da user_data)
let _rankRealUsers = null;
let _rankPollTimer = null;
let _rankLastProfit = -1;

function rankStartLivePolling(){
  rankStopLivePolling();
  _rankPollTimer = setInterval(async function(){
    // Para se a aba ranking saiu de cena
    const sec = document.getElementById('sec-ranking');
    if (!sec || !sec.classList.contains('active')){ rankStopLivePolling(); return; }
    // Recalcula meu lucro local (caso eu tenha registrado transação)
    let myProfit = 0;
    if (typeof transactions !== 'undefined' && Array.isArray(transactions)){
      for (let i = 0; i < transactions.length; i++){
        const t = transactions[i];
        const v = Number(t.value) || 0;
        if (t.type === 'income') myProfit += v;
        else if (t.type === 'expense') myProfit -= v;
      }
    }
    const count = Math.max(0, Math.round(myProfit));
    // Empurra meu user_data atualizado (pra outros usuários verem meu lucro)
    if (typeof schedulePush === 'function') schedulePush();
    const real = await rankFetchLeaderboard();
    if (real && real.length > 0){
      _rankRealUsers = real;
      rankRenderBoard(count);
      _rankLastProfit = count;
    }
  }, 20000); // a cada 20s
}
function rankStopLivePolling(){
  if (_rankPollTimer){ clearInterval(_rankPollTimer); _rankPollTimer = null; }
}

async function rankFetchLeaderboard(){
  try {
    const sb = (typeof getSb === 'function') ? getSb() : null;
    if (!sb) return null;
    const { data, error } = await sb.rpc('get_leaderboard');
    if (error) { console.warn('rankFetchLeaderboard', error.message); return null; }
    if (!data || !data.length) return [];
    return data.map(r => ({
      name: r.display_name || 'Apostador',
      profit: Number(r.profit) || 0,
      isPro: !!r.is_pro,
      avatar: r.avatar || null
    }));
  } catch(e) { console.warn('rankFetchLeaderboard', e); return null; }
}

function rankUserInitials(name){
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0,2).toUpperCase();
  return (parts[0][0] + parts[parts.length-1][0]).toUpperCase();
}

// 👑 Banner do Campeão do Mês (sempre puxa do leaderboard mensal)
function renderRankChampion(){
  const banner = document.getElementById('rankChampionBanner');
  if (!banner) return;
  // Tenta achar o Top 1 do mês — pode ser dado real ou mock
  const monthData = _rankRealUsersMonth || (_rankPeriod === 'all' ? null : null);
  if (!monthData || !monthData.length){ banner.style.display = 'none'; return; }
  const top1 = monthData.slice().sort((a, b) => b.profit - a.profit)[0];
  if (!top1 || top1.profit <= 0){ banner.style.display = 'none'; return; }
  banner.style.display = 'flex';
  document.getElementById('rankChampionName').textContent = top1.name;
  document.getElementById('rankChampionProfit').textContent = rankFormatValue(top1.profit);
  const { current } = rankComputeCurrent(top1.profit);
  document.getElementById('rankChampionShield').innerHTML = rankShieldSVG(current);
}

// 🎯 Card "Sua posição" hero
function renderRankMyPos(youProfit, currentTier){
  const card = document.getElementById('rankMyPosCard');
  if (!card) return;
  let youName = (localStorage.getItem('bancapro-user-name')||'').trim() || 'Você';
  const source = rankRealUsersForPeriod();
  const board_users = rankBuildLeaderboard(youProfit, youName, source);
  const yourPos = board_users.findIndex(u => u.isYou) + 1;
  const elig = rankComputeEligibility();

  // Não-elegível: mostra card no estado "locked" com onde estaria
  card.className = 'rank-mypos';
  card.style.display = 'block';

  let displayPos = yourPos;
  let isInList = yourPos > 0;
  if (!isInList){
    const realRanked = board_users.filter(u => !u.isYou);
    displayPos = realRanked.filter(u => u.profit >= youProfit).length + 1;
    card.classList.add('is-locked');
  }
  if (yourPos === 1) card.classList.add('is-top');

  document.getElementById('rankMyPosNum').textContent = '#' + displayPos;
  document.getElementById('rankMyPosName').textContent = youName;
  document.getElementById('rankMyPosTier').textContent = currentTier.name;
  document.getElementById('rankMyPosShield').innerHTML = rankShieldSVG(currentTier);
  document.getElementById('rankMyPosProfit').textContent = rankFormatValue(youProfit);

  // Delta vs sessao anterior
  const deltaEl = document.getElementById('rankMyPosDelta');
  if (deltaEl){
    const cache = rankReadPositionCache(_rankPeriod);
    const prev = cache[youName];
    if (prev && prev !== displayPos){
      if (prev > displayPos){ deltaEl.className = 'rank-mypos-delta is-up'; deltaEl.textContent = '▲ ' + (prev - displayPos) + ' posição' + (prev - displayPos > 1 ? 'es' : ''); }
      else { deltaEl.className = 'rank-mypos-delta is-down'; deltaEl.textContent = '▼ ' + (displayPos - prev) + ' posição' + (displayPos - prev > 1 ? 'es' : ''); }
    } else if (prev === displayPos){
      deltaEl.className = 'rank-mypos-delta is-same'; deltaEl.textContent = '— manteve';
    } else {
      deltaEl.textContent = '';
    }
  }

  // Texto + progresso pra ultrapassar próximo
  const progEl = document.getElementById('rankMyPosProgressLabel');
  const fillEl = document.getElementById('rankMyPosProgressFill');
  if (displayPos === 1){
    if (progEl) progEl.innerHTML = '🏆 <b>Você está no topo do ranking!</b> Continue lucrando pra manter a posição.';
    if (fillEl) fillEl.style.width = '100%';
  } else {
    const ahead = isInList ? board_users[yourPos - 2] : board_users[displayPos - 2];
    if (ahead){
      const diff = ahead.profit - youProfit;
      if (progEl) progEl.innerHTML = 'Faltam <b>'+rankFormatValue(diff)+'</b> pra ultrapassar <span class="ahead">'+escapeHtml(ahead.name)+'</span> no <b>#'+(displayPos - 1)+'</b>';
      // Progresso: quanto do gap entre eu e o próximo já cobri (relativo ao gap com o de baixo)
      let pct = 0;
      if (isInList && board_users[yourPos]){
        const below = board_users[yourPos];
        const span = ahead.profit - below.profit;
        if (span > 0) pct = Math.min(100, Math.max(5, ((youProfit - below.profit) / span) * 100));
        else pct = 50;
      } else {
        pct = 30;
      }
      if (fillEl) fillEl.style.width = pct + '%';
    } else {
      if (progEl) progEl.textContent = 'Continue registrando suas transações pra subir.';
      if (fillEl) fillEl.style.width = '50%';
    }
  }
}

// Medalhas premium (Top 1/2/3) — imagens em brand/medals/ ou tema claro
function rankMedalSVG(rank){
  const r = (rank === 1 || rank === 2 || rank === 3) ? rank : 3;
  return '<img class="rank-medal-img" src="'+medalsFolder()+'/'+r+'.png" alt="'+r+'º lugar" loading="eager"/>';
}

// 🥇🥈🥉 Pódio Top 3
function renderRankPodium(youProfit){
  const podiumWrap = document.getElementById('rankPodium');
  if (!podiumWrap) return;
  let youName = (localStorage.getItem('bancapro-user-name')||'').trim() || 'Você';
  const source = rankRealUsersForPeriod();
  const board_users = rankBuildLeaderboard(youProfit, youName, source);
  if (board_users.length < 3){ podiumWrap.style.display = 'none'; return; }
  podiumWrap.style.display = 'grid';
  const top3 = board_users.slice(0, 3);

  const proBadge = '<span class="rank-podium-pro" title="Pro"><svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="podProGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3ba9f5"/><stop offset="1" stop-color="#0f7dc6"/></linearGradient></defs><path fill="url(#podProGrad)" d="M22.25 12c0-1.43-.88-2.67-2.19-3.34.46-1.39.2-2.9-.81-3.91s-2.52-1.27-3.91-.81c-.66-1.31-1.91-2.19-3.34-2.19s-2.67.88-3.33 2.19c-1.4-.46-2.91-.2-3.92.81S3.48 7.27 3.94 8.66C2.63 9.33 1.75 10.57 1.75 12s.88 2.66 2.19 3.34c-.46 1.39-.2 2.9.81 3.91s2.52 1.26 3.91.81c.67 1.31 1.91 2.19 3.34 2.19s2.68-.88 3.34-2.19c1.39.45 2.9.2 3.91-.81s1.27-2.52.81-3.91c1.31-.68 2.19-1.91 2.19-3.34z"/><path d="M9.64 13.06l-2.06-2.06-1.42 1.41 3.48 3.48 6.86-6.86-1.42-1.42z" fill="#fff"/></svg></span>';
  const labels = { 1:'1º LUGAR', 2:'2º LUGAR', 3:'3º LUGAR' };

  [1,2,3].forEach(rank => {
    const u = top3[rank - 1];
    const slot = document.getElementById('rankPodium' + rank);
    if (!slot) return;
    const { current } = rankComputeCurrent(u.profit);
    const youCls = u.isYou ? 'is-you' : '';
    slot.className = 'rank-podium-slot rank-podium-' + rank + ' ' + youCls;
    // Avatar: prioridade — (1) foto vinda do RPC, (2) localStorage se 'voce',
    // (3) iniciais como fallback
    let avatarHTML = rankUserInitials(u.name);
    if (u.avatar){
      avatarHTML = '<img src="'+escapeHtml(u.avatar)+'" alt="" onerror="this.style.display=\'none\'"/>';
    } else if (u.isYou){
      try {
        const dataUrl = localStorage.getItem('bancapro-avatar');
        if (dataUrl) avatarHTML = '<img src="'+escapeHtml(dataUrl)+'" alt="" onerror="this.style.display=\'none\'"/>';
      } catch(e){}
    }
    // Esconde o nome "Você" do corpo quando for placeholder (avatar + borda já indicam)
    const displayName = (u.isYou && (u.name === 'Você' || !u.name)) ? '' : u.name;
    slot.innerHTML =
      '<div class="rank-podium-medal-corner">'+rankMedalSVG(rank)+'</div>'+
      '<div class="rank-podium-avatar">'+avatarHTML+'</div>'+
      '<div class="rank-podium-rank">'+labels[rank]+'</div>'+
      '<div class="rank-podium-shield rank-shield">'+rankShieldSVG(current)+'</div>'+
      (displayName ? '<div class="rank-podium-name">'+escapeHtml(displayName)+(u.isPro ? proBadge : '')+'</div>' : '')+
      '<div class="rank-podium-tier-name">'+escapeHtml(current.name)+'</div>'+
      '<div class="rank-podium-profit">'+rankFormatValue(u.profit)+'</div>';
  });
}

function rankPodiumClick(rank){
  /* Reservado pra futuro: abrir perfil do top X */
}

function rankRenderBoard(youProfit){
  const board = document.getElementById('rankBoard');
  const foot = document.getElementById('rankBoardFoot');
  const meta = document.getElementById('rankGlobalMeta');
  if (!board) return;

  let youName = 'Você';
  try {
    const localName = (localStorage.getItem('bancapro-user-name')||'').trim();
    if (localName) youName = localName;
    else if (typeof CURRENT_USER !== 'undefined' && CURRENT_USER && CURRENT_USER.name) youName = CURRENT_USER.name;
  } catch(e){}

  const source = rankRealUsersForPeriod();
  const board_users = rankBuildLeaderboard(youProfit, youName, source);
  const yourPos = board_users.findIndex(u => u.isYou) + 1;
  const isYouInList = yourPos > 0;
  const total = board_users.length;

  if (meta){
    if (isYouInList){
      meta.innerHTML = '<b>'+total.toLocaleString('pt-BR')+'</b> apostadores · Sua posição <b>#'+yourPos+'</b>';
    } else {
      meta.innerHTML = '<b>'+total.toLocaleString('pt-BR')+'</b> apostadores ranqueados';
    }
  }

  // Pega cache de posições anteriores pra computar ▲/▼
  const posCache = rankReadPositionCache(_rankPeriod);
  const newPositions = {};
  board_users.forEach((u, i) => { newPositions[u.name] = i + 1; });

  // Lista comeca apos o podio (se houver). Podio exige 3+; com <3 mostra tudo na lista
  const skipCount = board_users.length >= 3 ? 3 : 0;
  const top = board_users.slice(skipCount, 10);
  const rows = [];
  for (let i = 0; i < top.length; i++){
    rows.push({ user: top[i], pos: i + skipCount + 1 });
  }
  if (yourPos > 10){
    rows.push({ divider: true });
    const start = Math.max(10, yourPos - 3);
    const end = Math.min(total, yourPos + 2);
    for (let i = start; i < end; i++){
      rows.push({ user: board_users[i], pos: i + 1 });
    }
  }

  const proBadgeHTML = '<span class="rank-pro-badge" title="Assinante Pro">'+
    '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">'+
      '<defs>'+
        '<linearGradient id="proBadgeGrad" x1="0" y1="0" x2="0" y2="1">'+
          '<stop offset="0" stop-color="#3ba9f5"/>'+
          '<stop offset="0.5" stop-color="#1d9bf0"/>'+
          '<stop offset="1" stop-color="#0f7dc6"/>'+
        '</linearGradient>'+
      '</defs>'+
      '<path fill="url(#proBadgeGrad)" stroke="rgba(0,0,0,.12)" stroke-width=".4" d="M22.25 12c0-1.43-.88-2.67-2.19-3.34.46-1.39.2-2.9-.81-3.91s-2.52-1.27-3.91-.81c-.66-1.31-1.91-2.19-3.34-2.19s-2.67.88-3.33 2.19c-1.4-.46-2.91-.2-3.92.81S3.48 7.27 3.94 8.66C2.63 9.33 1.75 10.57 1.75 12s.88 2.66 2.19 3.34c-.46 1.39-.2 2.9.81 3.91s2.52 1.26 3.91.81c.67 1.31 1.91 2.19 3.34 2.19s2.68-.88 3.34-2.19c1.39.45 2.9.2 3.91-.81s1.27-2.52.81-3.91c1.31-.68 2.19-1.91 2.19-3.34z"/>'+
      '<path d="M9.64 13.06l-2.06-2.06-1.42 1.41 3.48 3.48 6.86-6.86-1.42-1.42z" fill="#fff"/>'+
    '</svg>'+
  '</span>';

  // Estado vazio: ninguem qualificou na janela atual ainda
  const periodLabel = (_rankPeriod === 'today' ? 'hoje' :
                       _rankPeriod === 'week'  ? 'esta semana' :
                       _rankPeriod === 'month' ? 'este mês' : 'no geral');
  if (board_users.length === 0){
    // Mensagem adaptada: Pro ja elegivel ve "Voce ainda nao lucrou X" / Free ve "Ninguem ainda"
    const elig = rankComputeEligibility();
    let titleTxt, subTxt;
    if (elig.isPro){
      titleTxt = 'Você ainda não lucrou ' + periodLabel;
      subTxt = 'Lucre R$ 1+ na janela e seu nome aparece direto no ranking.';
    } else if (elig.eligible){
      titleTxt = 'Ninguém entrou no ranking ' + periodLabel + ' ainda';
      subTxt = 'Seja o primeiro: lucre R$ 1+ na janela.';
    } else {
      titleTxt = 'Ninguém entrou no ranking ' + periodLabel + ' ainda';
      subTxt = 'Seja o primeiro: lucre R$ 1+ na janela e cumpra os critérios de atividade.';
    }
    board.innerHTML =
      '<div class="rank-empty-state">' +
        '<div class="rank-empty-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l8 4v6c0 5-3.5 9-8 10-4.5-1-8-5-8-10V6l8-4z"/><path d="M8 11l3 3 5-5"/></svg></div>' +
        '<div class="rank-empty-title">'+titleTxt+'</div>' +
        '<div class="rank-empty-sub">'+subTxt+'</div>' +
      '</div>';
    const listWrap = document.getElementById('rankListWrap');
    if (listWrap) listWrap.style.display = '';
    const listTitle = document.getElementById('rankListTitle');
    if (listTitle) listTitle.style.display = 'none';
    if (meta) meta.innerHTML = 'Ranking vazio ' + periodLabel;
    return;
  }

  // Se ha 1-3 usuarios: tudo cabe no podio, lista nao mostra nada
  // entao escondemos o titulo "Classificacao completa" pra nao parecer bug
  const listWrap = document.getElementById('rankListWrap');
  const listTitle = document.getElementById('rankListTitle');
  if (board_users.length <= 3){
    if (listTitle) listTitle.style.display = 'none';
  } else {
    if (listTitle) listTitle.style.display = '';
  }

  board.innerHTML = rows.map(r => {
    if (r.divider) return '<div class="rank-row-divider">· · ·</div>';
    const u = r.user;
    const { current } = rankComputeCurrent(u.profit);
    const youCls = u.isYou ? 'is-you' : '';
    const proCls = u.isPro ? 'is-pro' : '';
    const initials = rankUserInitials(u.name);
    // Avatar com prioridade: foto do RPC > localStorage do 'voce' > iniciais
    let avatarInner = initials;
    if (u.avatar){
      avatarInner = '<img src="'+escapeHtml(u.avatar)+'" alt="" onerror="this.style.display=\'none\'; this.parentElement.textContent=\''+initials.replace(/'/g, "\\'")+'\'"/>';
    } else if (u.isYou){
      try {
        const dataUrl = localStorage.getItem('bancapro-avatar');
        if (dataUrl) avatarInner = '<img src="'+escapeHtml(dataUrl)+'" alt="" onerror="this.style.display=\'none\'"/>';
      } catch(e){}
    }
    const proBadge = u.isPro ? proBadgeHTML : '';
    // Position delta ▲/▼ (vs sessão anterior)
    const prevPos = posCache[u.name];
    let deltaHtml = '';
    if (prevPos && prevPos !== r.pos){
      if (prevPos > r.pos){
        deltaHtml = '<span class="rank-row-delta is-up" title="Subiu '+(prevPos - r.pos)+' posições">▲ '+(prevPos - r.pos)+'</span>';
      } else {
        deltaHtml = '<span class="rank-row-delta is-down" title="Caiu '+(r.pos - prevPos)+' posições">▼ '+(r.pos - prevPos)+'</span>';
      }
    }
    return '<div class="rank-row '+youCls+' '+proCls+'">'+
      '<div class="rank-row-pos">#'+r.pos+'</div>'+
      '<div class="rank-row-avatar">'+avatarInner+'</div>'+
      '<div class="rank-row-name">'+escapeHtml(u.name)+proBadge+(u.isYou ? '<b>VOCÊ</b>' : '')+deltaHtml+'</div>'+
      '<div class="rank-row-tier"><span class="rank-shield">'+rankShieldSVG(current)+'</span><span class="rank-row-tier-name">'+escapeHtml(current.name)+'</span></div>'+
      '<div class="rank-row-profit">'+rankFormatValue(u.profit)+'</div>'+
    '</div>';
  }).join('');

  // Atualiza texto do titulo (visibilidade ja tratada acima)
  if (listTitle){
    listTitle.textContent = board_users.length > 3 ? 'Demais classificados' : 'Classificação completa';
  }

  // Salva cache de posições pra próxima visita comparar
  rankWritePositionCache(_rankPeriod, newPositions);

  // Foot: só mostra mensagem de bloqueio pra usuários free não-ranqueados
  if (foot){
    const elig = rankComputeEligibility();
    if (isYouInList || elig.isPro){
      foot.innerHTML = '';
    } else {
      const missing = [];
      if (elig.txCount < RANK_ELIGIBILITY.minTx) missing.push('<b>'+(RANK_ELIGIBILITY.minTx - elig.txCount)+' transações</b>');
      if (elig.distinctDays < RANK_ELIGIBILITY.minActiveDays) missing.push('<b>'+(RANK_ELIGIBILITY.minActiveDays - elig.distinctDays)+' dias de atividade</b>');
      foot.innerHTML = '🔒 Pra entrar na temporada faltam: ' + missing.join(' · ') +
        ' <br/><span style="color:#5a657f">— ou assine o <b style="color:#a282ff">Pro</b> e apareça imediatamente</span>';
    }
  }
}

function renderUserRanking(){
  const sec = document.getElementById('sec-ranking');
  if (!sec) return;
  updateRankTabCountdown();
  // Lucro depende do periodo (Geral = sempre / Mes/Semana/Hoje = janela filtrada)
  let profit = 0;
  if (_rankPeriod === 'month'){
    profit = rankComputeMonthProfit();
  } else if (_rankPeriod === 'today'){
    profit = rankComputeTodayProfit();
  } else if (_rankPeriod === 'week'){
    profit = rankComputeWeekProfit();
  } else if (typeof transactions !== 'undefined' && Array.isArray(transactions)){
    for (let i = 0; i < transactions.length; i++){
      const t = transactions[i];
      const v = Number(t.value) || 0;
      if (t.type === 'income') profit += v;
      else if (t.type === 'expense') profit -= v;
    }
  }
  const count = Math.max(0, Math.round(profit));
  const { current, next } = rankComputeCurrent(count);

  // Current rank card
  const setText = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
  const setHTML = (id, v) => { const e = document.getElementById(id); if (e) e.innerHTML = v; };

  const idxEl = document.getElementById('rankCurrentIdx');
  if (idxEl) idxEl.innerHTML = '<b>T'+current.idx+' · '+current.idx+'/15</b>';
  setText('rankCurrentName', current.name);
  setText('rankCurrentCount', rankFormatValue(count));
  setHTML('rankShieldCurrent', rankShieldSVG(current));
  setHTML('rankShieldBottom', rankShieldSVG(current));
  setHTML('rankShieldHead', rankShieldSVG(current));
  setText('rankHeadName', current.name);
  setText('rankBottomName', current.name);
  setText('rankBottomDesc', current.desc);
  setText('rankBottomPos', current.idx);
  setText('rankBottomMin', rankFormatValue(current.min));

  if (next){
    setText('rankNextName', next.name);
    setText('rankNextRemaining', rankFormatValue(Math.max(0, next.min - count)));
    setText('rankCurrentMin', rankFormatValue(current.min));
    setText('rankNextMin', rankFormatValue(next.min));
    const span = next.min - current.min;
    const pct = span > 0 ? Math.min(100, Math.max(0, ((count - current.min) / span) * 100)) : 100;
    setText('rankCurrentPct', pct.toFixed(1) + '%');
    const fill = document.getElementById('rankProgressFill');
    if (fill) fill.style.width = pct + '%';
    setText('rankBottomNext', next.name);
  } else {
    setText('rankNextName', 'Topo');
    setText('rankNextRemaining', 'R$ 0');
    setText('rankCurrentPct', '100%');
    const fill = document.getElementById('rankProgressFill');
    if (fill) fill.style.width = '100%';
    setText('rankBottomNext', '—');
  }

  // Próximos níveis (current + 2 next)
  const upcoming = [];
  for (let i = current.idx; i < Math.min(current.idx + 3, 15); i++) upcoming.push(RANK_TIERS[i]);
  const listEl = document.getElementById('rankNextList');
  if (listEl){
    listEl.innerHTML = upcoming.map(t =>
      '<div class="rank-next-item"><span class="rank-shield rank-shield-xs">'+rankShieldSVG(t)+'</span>'+
      '<div><div class="rni-name">'+t.name+'</div><div class="rni-min">'+rankFormatMin(t.min)+'</div></div></div>'
    ).join('');
  }

  // Leaderboard — render imediato com cache (ou mock), depois busca real e re-pinta
  rankRenderBoard(count);
  renderRankPodium(count);
  renderRankMyPos(count, current);
  renderRankChampion();
  // Cada periodo tem seu fetcher e cache proprios
  let fetcher;
  if (_rankPeriod === 'all') fetcher = rankFetchLeaderboard;
  else if (_rankPeriod === 'today') fetcher = rankFetchLeaderboardToday;
  else if (_rankPeriod === 'week') fetcher = rankFetchLeaderboardWeek;
  else fetcher = rankFetchLeaderboardMonth;
  const periodAtFetch = _rankPeriod;
  fetcher().then(real => {
    // Atualiza o cache MESMO se vier [] — ai a UI mostra vazio em vez de mock
    if (Array.isArray(real)){
      if (periodAtFetch === 'all') _rankRealUsers = real;
      else if (periodAtFetch === 'today') _rankRealUsersToday = real;
      else if (periodAtFetch === 'week') _rankRealUsersWeek = real;
      else _rankRealUsersMonth = real;
      if (_rankPeriod === periodAtFetch){
        rankRenderBoard(count);
        renderRankPodium(count);
        renderRankMyPos(count, current);
        renderRankChampion();
      }
    }
  });
  rankStartLivePolling();

  // 15 tier bars
  const barsEl = document.getElementById('rankBars');
  if (barsEl){
    barsEl.innerHTML = RANK_TIERS.map(t => {
      const isCurrent = t.idx === current.idx;
      const isLocked = t.idx > current.idx;
      const heightPct = 22 + Math.pow(t.idx / 15, 1.4) * 76;
      const iconColor = t.color === 'gradient' ? (t.via || '#a855f7') : t.color;
      const fillBg = t.color === 'gradient'
        ? 'linear-gradient(180deg,'+t.g1+' 0%,'+(t.via || '#a855f7')+' 50%,'+t.g2+' 100%)'
        : (t.via
            ? 'linear-gradient(180deg,'+t.g1+' 0%,'+t.via+' 50%,'+t.g2+' 100%)'
            : 'linear-gradient(180deg,'+t.g1+' 0%,'+t.color+' 60%,'+t.g2+' 100%)');
      const shineDelay = ((t.idx * 0.3) % 4).toFixed(1) + 's';
      const tooltip = t.name + ' · ' + rankFormatMin(t.min) + (t.desc ? ' — ' + t.desc.split('.')[0] : '');
      // Classes progressivas baseadas no tier idx
      let groupCls = '';
      if (t.idx === 15) groupCls = ' is-apex';
      else if (t.idx === 14) groupCls = ' is-supremo-tier';
      else if (t.idx === 13) groupCls = ' is-godlike-tier';
      else if (t.idx >= 10) groupCls = ' is-elite-tier';
      else if (t.idx >= 7) groupCls = ' is-pro-tier';
      return '<div class="rank-tier-bar '+(isCurrent?'is-current ':'')+(isLocked?'is-locked':'')+groupCls+'" style="--ticon:'+iconColor+';--shine-delay:'+shineDelay+'" title="'+tooltip.replace(/"/g,'&quot;')+'">'+
        '<div class="rank-tier-label">'+t.name+'</div>'+
        '<div class="rank-tier-icon-badge"><div class="rank-tier-icon">'+rankShieldSVG(t)+'</div></div>'+
        '<div class="rank-tier-tube"><div class="rank-tier-fill" style="height:'+heightPct+'%;background:'+fillBg+'"></div></div>'+
        '<div class="rank-tier-num">'+String(t.idx).padStart(2,'0')+'</div>'+
        '<div class="rank-tier-mintag">MIN. LUCRO</div>'+
        '<div class="rank-tier-min">'+rankFormatMin(t.min)+'</div>'+
      '</div>';
    }).join('');
  }

  // Atualiza o card de ranking no Dashboard (build leaderboard local pra ele)
  var _yName = (localStorage.getItem('bancapro-user-name')||'').trim() || 'Você';
  var _dashBoard = rankBuildLeaderboard(count, _yName, _rankRealUsers);
  rankRenderDashCard(count, current, _dashBoard);

  // Atualiza streak no topbar (visivel em todas as abas)
  updateTopbarStreak();

  // Detecta se o user subiu de tier desde a ultima visita
  detectTierUp(current);
}

// ─── Ranking — periodos ───
// 'today' e 'week' atualmente fazem fallback pra 'month' no backend
// (interface preparada — quando o RPC existir, plug and play)
let _rankPeriod = 'month'; // 'today' / 'week' / 'month' / 'all' — Mês como default
let _rankRealUsersMonth = null;
let _rankRealUsersToday = null;
let _rankRealUsersWeek = null;

// Helper: pega o cache real do periodo atual
function rankRealUsersForPeriod(){
  if (_rankPeriod === 'all') return _rankRealUsers;
  if (_rankPeriod === 'today') return _rankRealUsersToday;
  if (_rankPeriod === 'week') return _rankRealUsersWeek;
  return _rankRealUsersMonth;
}

function switchRankPeriod(period){
  _rankPeriod = period;
  ['Today','Week','Month','All'].forEach(suf => {
    const el = document.getElementById('rankTab' + suf);
    if (el) el.classList.toggle('is-active', period === suf.toLowerCase());
  });
  const sub = document.getElementById('rankSeasonSub');
  if (sub){
    if (period === 'all') sub.textContent = 'Geral · Todos os tempos';
    else if (period === 'month') sub.textContent = 'Corrida mensal — reset em ' + rankCountdownToMonthEnd().replace('reseta em ','');
    else if (period === 'week') sub.textContent = 'Top da semana — janela de 7 dias';
    else if (period === 'today') sub.textContent = 'Top de hoje — dia corrente';
  }
  if (typeof renderUserRanking === 'function') renderUserRanking();
}

function rankCountdownToMonthEnd(){
  const now = new Date();
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 1, 0, 0, 0);
  const diff = end.getTime() - now.getTime();
  const days = Math.ceil(diff / 86400000);
  const hours = Math.floor((diff % 86400000) / 3600000);
  if (days <= 0) return hours + 'h';
  if (days === 1) return '1 dia';
  return days + ' dias';
}

function updateRankTabCountdown(){
  if (_rankPeriod === 'month'){
    const sub = document.getElementById('rankSeasonSub');
    if (sub) sub.textContent = 'Corrida mensal — reset em ' + rankCountdownToMonthEnd();
  }
}

// Filtra transações pra mês atual (usado quando o ranking mensal precisa do meu lucro)
function rankComputeMonthProfit(){
  if (typeof transactions === 'undefined' || !Array.isArray(transactions)) return 0;
  const now = new Date();
  const ym = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
  let profit = 0;
  for (let i = 0; i < transactions.length; i++){
    const t = transactions[i];
    if (!t.date || !String(t.date).startsWith(ym)) continue;
    const v = Number(t.value) || 0;
    if (t.type === 'income') profit += v;
    else if (t.type === 'expense') profit -= v;
  }
  return Math.max(0, Math.round(profit));
}

// Filtra transacoes do dia corrente (YYYY-MM-DD)
// Anti-backdate: se a tx tem created_at, exige que TAMBEM seja de hoje.
// Caso contrario alguem podia adicionar tx hoje com data=ontem e contar no ranking de hoje (e vice-versa).
function rankComputeTodayProfit(){
  if (typeof transactions === 'undefined' || !Array.isArray(transactions)) return 0;
  const now = new Date();
  const ymd = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
  let profit = 0;
  for (let i = 0; i < transactions.length; i++){
    const t = transactions[i];
    if (!t.date || String(t.date).slice(0,10) !== ymd) continue;
    // Se tem created_at, exige que tambem caia em HOJE (anti-backdate)
    if (t.created_at && String(t.created_at).slice(0,10) !== ymd) continue;
    const v = Number(t.value) || 0;
    if (t.type === 'income') profit += v;
    else if (t.type === 'expense') profit -= v;
  }
  return Math.max(0, Math.round(profit));
}

// Filtra transacoes dos ultimos 7 dias (hoje inclusive)
function rankComputeWeekProfit(){
  if (typeof transactions === 'undefined' || !Array.isArray(transactions)) return 0;
  const now = new Date();
  const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6, 0, 0, 0).getTime();
  let profit = 0;
  for (let i = 0; i < transactions.length; i++){
    const t = transactions[i];
    if (!t.date) continue;
    const tDate = new Date(String(t.date).slice(0,10) + 'T00:00:00').getTime();
    if (isNaN(tDate) || tDate < cutoff) continue;
    const v = Number(t.value) || 0;
    if (t.type === 'income') profit += v;
    else if (t.type === 'expense') profit -= v;
  }
  return Math.max(0, Math.round(profit));
}

// Cache de posições anteriores pra detectar ▲/▼ subiu/caiu
function rankReadPositionCache(period){
  try {
    const raw = localStorage.getItem('bancapro-rank-positions-' + period);
    return raw ? JSON.parse(raw) : {};
  } catch(e){ return {}; }
}
function rankWritePositionCache(period, positions){
  try { localStorage.setItem('bancapro-rank-positions-' + period, JSON.stringify(positions)); } catch(e){}
}

// Tenta buscar leaderboard mensal do Supabase (RPC get_leaderboard_monthly)
let _monthRpcWarned = false;
async function rankFetchLeaderboardMonth(){
  try {
    const sb = (typeof getSb === 'function') ? getSb() : null;
    if (!sb) return null;
    const { data, error } = await sb.rpc('get_leaderboard_monthly');
    if (error){
      if (!_monthRpcWarned){ console.warn('rankFetchLeaderboardMonth', error.message); _monthRpcWarned = true; }
      return null;
    }
    if (!data || !data.length) return [];
    return data.map(r => ({
      name: r.display_name || 'Apostador',
      profit: Number(r.profit) || 0,
      isPro: !!r.is_pro,
      avatar: r.avatar || null
    }));
  } catch(e){
    if (!_monthRpcWarned){ console.warn('rankFetchLeaderboardMonth', e); _monthRpcWarned = true; }
    return null;
  }
}

// Leaderboard de hoje (RPC get_leaderboard_today — soma transacoes do dia corrente)
let _todayRpcWarned = false;
async function rankFetchLeaderboardToday(){
  try {
    const sb = (typeof getSb === 'function') ? getSb() : null;
    if (!sb) return null;
    const { data, error } = await sb.rpc('get_leaderboard_today');
    if (error){
      if (!_todayRpcWarned){ console.warn('rankFetchLeaderboardToday', error.message); _todayRpcWarned = true; }
      return null;
    }
    if (!data || !data.length) return [];
    return data.map(r => ({
      name: r.display_name || 'Apostador',
      profit: Number(r.profit) || 0,
      isPro: !!r.is_pro,
      avatar: r.avatar || null
    }));
  } catch(e){
    if (!_todayRpcWarned){ console.warn('rankFetchLeaderboardToday', e); _todayRpcWarned = true; }
    return null;
  }
}

// Leaderboard da semana (RPC get_leaderboard_weekly — soma ultimos 7 dias)
let _weekRpcWarned = false;
async function rankFetchLeaderboardWeek(){
  try {
    const sb = (typeof getSb === 'function') ? getSb() : null;
    if (!sb) return null;
    const { data, error } = await sb.rpc('get_leaderboard_weekly');
    if (error){
      if (!_weekRpcWarned){ console.warn('rankFetchLeaderboardWeek', error.message); _weekRpcWarned = true; }
      return null;
    }
    if (!data || !data.length) return [];
    return data.map(r => ({
      name: r.display_name || 'Apostador',
      profit: Number(r.profit) || 0,
      isPro: !!r.is_pro,
      avatar: r.avatar || null
    }));
  } catch(e){
    if (!_weekRpcWarned){ console.warn('rankFetchLeaderboardWeek', e); _weekRpcWarned = true; }
    return null;
  }
}

// Atualiza o chip de streak no topbar (visível em todas as abas)
function updateTopbarStreak(){
  const el = document.getElementById('topbarStreak');
  if (!el) return;
  const streak = rankComputeStreak();
  if (streak.current > 0){
    el.style.display = '';
    el.className = 'topbar-streak' + (streak.atRisk ? ' is-at-risk' : '') + (streak.current >= 7 ? ' is-record' : '');
    document.getElementById('topbarStreakNum').textContent = streak.current;
    document.getElementById('topbarStreakFlame').textContent = streak.atRisk ? '⚠️' : (streak.current >= 30 ? '👑' : '🔥');
  } else {
    el.style.display = 'none';
  }
}

// Detecta tier-up: se o tier atual for maior que o ultimo cacheado, mostra celebração
// Flag de sessão: primeira chamada apenas sincroniza o cache (silent), evitando
// modal disparar no load inicial quando o cache local está desatualizado
let _tierUpSessionStarted = false;
function detectTierUp(currentTier){
  if (!currentTier) return;
  // Skip em demo mode — demo nao representa progressao real do usuario
  try {
    if (new URLSearchParams(location.search).get('demo') === '1') return;
  } catch(e){}
  try {
    const lastIdxRaw = localStorage.getItem('bancapro-last-tier-idx');
    const lastIdx = lastIdxRaw ? parseInt(lastIdxRaw, 10) : 0;

    // Primeira chamada da sessão: silent sync (não mostra modal)
    // Isso evita o modal disparar no load quando o cache estiver desatualizado
    // (ex: user logou em outro device e o tier cresceu antes desta sessão)
    if (!_tierUpSessionStarted){
      _tierUpSessionStarted = true;
      if (currentTier.idx !== lastIdx){
        localStorage.setItem('bancapro-last-tier-idx', String(currentTier.idx));
      }
      return;
    }

    // Chamadas seguintes na mesma sessão — agora sim, modal real quando user sobe
    if (currentTier.idx > lastIdx){
      showTierUpModal(currentTier);
      localStorage.setItem('bancapro-last-tier-idx', String(currentTier.idx));
    } else if (currentTier.idx < lastIdx){
      // Caiu (raro, ex: correção de lucro) — só atualiza cache
      localStorage.setItem('bancapro-last-tier-idx', String(currentTier.idx));
    }
  } catch(e){}
}

function showTierUpModal(tier){
  const overlay = document.getElementById('tierUpOverlay');
  if (!overlay) return;
  const isSupreme = tier.color === 'gradient';
  const color = isSupreme ? '#a855f7' : tier.color;
  const color2 = isSupreme ? '#ec4899' : tier.g1;
  overlay.style.setProperty('--tier-up-color', color);
  overlay.style.setProperty('--tier-up-color-2', color2);
  document.getElementById('tierUpShield').innerHTML = rankShieldSVG(tier);
  document.getElementById('tierUpTitleName').textContent = tier.name;
  document.getElementById('tierUpSubtitle').innerHTML = 'Tier <b>'+tier.idx+' de 15</b> · '+rankFormatMin(tier.min).replace('+',' acumulados');
  document.getElementById('tierUpDesc').textContent = tier.desc;
  // Confetti
  const confetti = document.getElementById('tierUpConfetti');
  if (confetti){
    const colors = ['#facc15','#a282ff','#10b981','#f43f5e','#3b82f6','#fb923c'];
    let html = '';
    for (let i = 0; i < 35; i++){
      const c = colors[i % colors.length];
      const left = (i * 3 + (i*7)%20);
      const delay = (i*0.08).toFixed(2);
      const dur = (2.4 + (i%5)*0.3).toFixed(2);
      html += '<span style="left:'+left+'%;background:'+c+';animation-delay:'+delay+'s;animation-duration:'+dur+'s"></span>';
    }
    confetti.innerHTML = html;
  }
  overlay.classList.add('is-active');
}

function closeTierUpModal(e){
  if (e && e.target && e.target.id !== 'tierUpOverlay') return;
  const overlay = document.getElementById('tierUpOverlay');
  if (overlay) overlay.classList.remove('is-active');
}

// Wrapper assíncrono — busca o leaderboard e renderiza o card do Dashboard
async function rankUpdateDashCard(){
  if (!document.getElementById('dashRankCard')) return;
  let profit = 0;
  if (typeof transactions !== 'undefined' && Array.isArray(transactions)){
    for (let i = 0; i < transactions.length; i++){
      const t = transactions[i];
      const v = Number(t.value) || 0;
      if (t.type === 'income') profit += v;
      else if (t.type === 'expense') profit -= v;
    }
  }
  const count = Math.max(0, Math.round(profit));
  const { current } = rankComputeCurrent(count);
  const real = await rankFetchLeaderboard();
  if (real && real.length > 0) _rankRealUsers = real;
  let youName = (localStorage.getItem('bancapro-user-name')||'').trim() || 'Você';
  const board_users = rankBuildLeaderboard(count, youName, _rankRealUsers);
  rankRenderDashCard(count, current, board_users);
  updateTopbarStreak();
  detectTierUp(current);
}

// Card do Dashboard — mostra "Você está em #X" puxando user pra abrir Ranking
function rankRenderDashCard(profit, currentTier, board_users){
  const card = document.getElementById('dashRankCard');
  if (!card) return;

  const youName = (localStorage.getItem('bancapro-user-name')||'').trim() || 'Você';
  const elig = rankComputeEligibility();

  // Tenta achar minha entrada no leaderboard
  const me = board_users ? board_users.find(u => u.isYou) : null;
  const myPos = me ? board_users.findIndex(u => u.isYou) + 1 : 0;
  const totalRanked = board_users ? board_users.length : 0;
  const isPro = me ? !!me.isPro : !!window._isProSubscriber;

  // Limpa classes
  card.className = 'dash-rank-card';
  card.style.display = 'flex';

  const proSvg = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">'+
    '<defs><linearGradient id="dashProGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3ba9f5"/><stop offset="1" stop-color="#0f7dc6"/></linearGradient></defs>'+
    '<path fill="url(#dashProGrad)" d="M22.25 12c0-1.43-.88-2.67-2.19-3.34.46-1.39.2-2.9-.81-3.91s-2.52-1.27-3.91-.81c-.66-1.31-1.91-2.19-3.34-2.19s-2.67.88-3.33 2.19c-1.4-.46-2.91-.2-3.92.81S3.48 7.27 3.94 8.66C2.63 9.33 1.75 10.57 1.75 12s.88 2.66 2.19 3.34c-.46 1.39-.2 2.9.81 3.91s2.52 1.26 3.91.81c.67 1.31 1.91 2.19 3.34 2.19s2.68-.88 3.34-2.19c1.39.45 2.9.2 3.91-.81s1.27-2.52.81-3.91c1.31-.68 2.19-1.91 2.19-3.34z"/>'+
    '<path d="M9.64 13.06l-2.06-2.06-1.42 1.41 3.48 3.48 6.86-6.86-1.42-1.42z" fill="#fff"/></svg>';
  const proBadge = isPro ? '<span class="pro-mini-badge">'+proSvg+'</span>' : '';

  // Ícone do tier atual
  const tierIcon = rankShieldSVG(currentTier);
  document.getElementById('dashRankIcon').innerHTML = tierIcon;

  // Streak — só mostra se tiver pelo menos 1 dia de atividade
  const streak = rankComputeStreak();
  const streakEl = document.getElementById('dashStreak');
  if (streakEl){
    if (streak.current > 0){
      streakEl.style.display = 'flex';
      streakEl.className = 'dash-streak' + (streak.atRisk ? ' is-at-risk' : '') + (streak.current >= 30 ? ' is-king' : (streak.current >= 7 ? ' is-record' : ''));
      document.getElementById('dashStreakNum').textContent = streak.current;
      document.getElementById('dashStreakLabel').textContent = streak.current === 1 ? 'DIA' : 'DIAS SEGUIDOS';
    } else {
      streakEl.style.display = 'none';
    }
  }

  if (me && myPos > 0){
    // User ranqueado
    if (myPos <= 3) card.classList.add('is-podium');
    if (isPro) card.classList.add('is-pro');
    document.getElementById('dashRankTag').textContent = 'SUA POSIÇÃO NO RANKING';
    document.getElementById('dashRankMain').innerHTML = 'Você está em <b>#'+myPos+'</b> de '+totalRanked+ proBadge;
    if (myPos === 1){
      document.getElementById('dashRankSub').innerHTML = '🏆 Topo do ranking. Continue lucrando pra manter a posição.';
    } else {
      const ahead = board_users[myPos - 2];
      const diff = ahead ? ahead.profit - profit : 0;
      document.getElementById('dashRankSub').innerHTML = 'Faltam <b>'+rankFormatValue(diff)+'</b> pra ultrapassar <b>'+escapeHtml(ahead.name)+'</b>';
    }
  } else if (elig.eligible){
    // Elegível mas ainda não carregou — raro
    document.getElementById('dashRankTag').textContent = 'RANKING GLOBAL';
    document.getElementById('dashRankMain').innerHTML = 'Você está no ranking' + proBadge;
    document.getElementById('dashRankSub').textContent = 'Veja sua posição completa →';
  } else {
    // Bloqueado
    card.classList.add('is-locked');
    document.getElementById('dashRankTag').textContent = 'RANKING GLOBAL';
    const realRanked = board_users ? board_users.filter(u => !u.isYou) : [];
    const wouldBePos = realRanked.filter(u => u.profit >= profit).length + 1;
    document.getElementById('dashRankMain').innerHTML = 'Você estaria em <b>#'+wouldBePos+'</b>' + proBadge;
    const missing = [];
    if (elig.txCount < RANK_ELIGIBILITY.minTx) missing.push((RANK_ELIGIBILITY.minTx - elig.txCount)+' transações');
    if (elig.distinctDays < RANK_ELIGIBILITY.minActiveDays) missing.push((RANK_ELIGIBILITY.minActiveDays - elig.distinctDays)+' dias de atividade');
    document.getElementById('dashRankSub').innerHTML = '🔒 Faltam <b>'+missing.join(' · ')+'</b> pra entrar';
  }
}

// ══════════════════════════════════════════════
//  FAQ — accordion da Central de Ajuda
// ══════════════════════════════════════════════
function restartTour(){
  try { localStorage.removeItem(onboardingKey('bancapro-tour-done')); } catch(e){}
  if (typeof startTour === 'function') startTour();
}

function toggleFaq(btn){
  if (!btn) return;
  // Caso 1: FAQ antigo (pagina de Assinatura/Recharge) — .faq-item com class 'open'
  const legacyItem = btn.closest('.faq-item');
  if (legacyItem){
    legacyItem.classList.toggle('open');
    return;
  }
  // Caso 2: FAQ novo (Central de Ajuda) — .help-faq-item com class 'is-open'
  const item = btn.closest('.help-faq-item');
  if (!item) return;
  const expanded = item.classList.toggle('is-open');
  btn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  // Fecha os outros do mesmo grupo pra UX limpa (1 aberto por vez)
  if (expanded){
    const all = item.parentElement ? item.parentElement.querySelectorAll('.help-faq-item.is-open') : [];
    all.forEach(it => { if (it !== item){ it.classList.remove('is-open'); const b = it.querySelector('.help-faq-q'); if (b) b.setAttribute('aria-expanded','false'); } });
  }
}
