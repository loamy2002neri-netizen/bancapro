// ════════════════════════════════════════════════════════════════
//  storage.js — Helper centralizado de localStorage
//
//  Propósito: dar nome e categoria pra cada key `bancapro-*` em vez
//  de espalhar strings hard-coded pelo script.js. Facilita:
//   - Limpar dados ao trocar de conta sem esquecer key residual
//   - Migrar/renomear keys no futuro
//   - Auditar quem usa o quê
//
//  IMPORTANTE: este arquivo NAO substitui localStorage direto em todo
//  lugar (45+ usos). Refatorar gradual. Por enquanto vale pros pontos
//  criticos: troca de conta (enterApp/logout) e Storage.clearUserData().
// ════════════════════════════════════════════════════════════════

window.Storage = (function(){
  // ─── Categorias de keys ─────────────────────────────────────────
  //
  //   IDENTITY  — dados que mudam por usuario (limpar ao trocar conta)
  //   SETTINGS  — preferencias da plataforma (manter entre contas)
  //   DATA      — dados do usuario logado (limpar com identity)
  //   SESSION   — estado temporario, derivavel (limpar com identity)
  //
  const KEYS = {
    IDENTITY: [
      'bancapro-user-email',
      'bancapro-user-name',
      'bancapro-user-created-at',
      'bancapro-avatar',
      'bancapro-profile-avatar',
      'bancapro-profile-display-name',
      'bancapro-profile-photo',
      'bancapro-display-name',
      'bancapro-is-affiliate',
      'bancapro-affiliate-vip',
      'bancapro-plan-label'
    ],
    DATA: [
      'bancapro-transactions',
      'bancapro-goals',
      'bancapro-notes',
      'bancapro-saldo-inicial',
      'bancapro-methods-catalog',
      'bancapro-methods-compare',
      'bancapro-compare-auto'
    ],
    SESSION: [
      'bancapro-trial-start',
      'bancapro-rank-positions-today',
      'bancapro-rank-positions-week',
      'bancapro-rank-positions-month',
      'bancapro-rank-positions-all',
      'bancapro-rank-positions-geral',
      'bancapro-last-tier-idx',
      'bancapro-visited-ranking',
      'bancapro-ref',
      'bancapro-hidden-cards'
    ],
    SETTINGS: [
      'bancapro-theme',
      'bancapro-platform-name',
      'bancapro-slogan',
      'bancapro-logo',
      'bancapro-favicon',
      'bancapro-logo-style',
      'bancapro-logo-color1',
      'bancapro-logo-color2',
      'bancapro-logo-split',
      'bancapro-accent',
      'bancapro-accent2',
      // Flags de onboarding 1x-na-vida: devem sobreviver a logout
      // pra nao reaparecer toda vez que o user volta na conta
      'bancapro-welcome-seen',
      'bancapro-tour-done',
      'bancapro-onboarding-dismissed',
      'bancapro-onboarding-shown'
    ]
  };

  function safe(fn){ try { return fn(); } catch(e){ return null; } }

  // ─── API publica ────────────────────────────────────────────────

  // Pega valor cru pela chave (string ou null)
  function get(key){
    return safe(() => localStorage.getItem(key));
  }

  // Salva valor cru (string)
  function set(key, value){
    safe(() => localStorage.setItem(key, value));
  }

  // Remove uma chave
  function remove(key){
    safe(() => localStorage.removeItem(key));
  }

  // Pega JSON (parseado) ou null
  function getJSON(key){
    const raw = get(key);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch(e){ return null; }
  }

  // Salva JSON (stringify)
  function setJSON(key, obj){
    set(key, JSON.stringify(obj));
  }

  // Limpa dados de IDENTIDADE + DATA + SESSION
  // Mantem SETTINGS (theme, branding, etc).
  // Usar em logout e troca de conta.
  function clearUserData(){
    [].concat(KEYS.IDENTITY, KEYS.DATA, KEYS.SESSION).forEach(remove);
    // Limpa tambem chaves user_data dinamicas (bancapro-userdata-{userid})
    safe(() => {
      Object.keys(localStorage).forEach(k => {
        if (k.indexOf('bancapro-userdata-') === 0) localStorage.removeItem(k);
      });
    });
  }

  // Limpa SETTINGS tambem — uso raro (reset total do app)
  function clearAll(){
    clearUserData();
    KEYS.SETTINGS.forEach(remove);
  }

  // Helpers pros campos mais comuns (atalho)
  function getUserEmail(){ return (get('bancapro-user-email') || '').toLowerCase(); }
  function getUserName() { return get('bancapro-user-name') || ''; }
  function getTheme()    { return get('bancapro-theme') || 'dark'; }
  function getPlanLabel(){ return get('bancapro-plan-label') || 'Free'; }

  return {
    KEYS, get, set, remove, getJSON, setJSON,
    clearUserData, clearAll,
    getUserEmail, getUserName, getTheme, getPlanLabel
  };
})();
