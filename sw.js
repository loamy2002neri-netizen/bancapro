// ══════════════════════════════════════════════
//  Apostack — Service Worker
//
//  Estrategia: stale-while-revalidate
//   - HTML: network-first (sempre busca novo, cai em cache se offline)
//   - CSS/JS/imagens: cache-first com revalidacao em background
//   - Supabase API: NUNCA cacheia (sempre rede)
//   - Cache versionado por VERSION — bump muda tudo
//
//  Pra Play Store (TWA via Bubblewrap/PWABuilder), SW eh recomendado
//  mas nao obrigatorio. Aqui melhora UX e habilita "instavel" no Chrome.
// ══════════════════════════════════════════════

const VERSION = 'apostack-v2';
const STATIC_CACHE = `${VERSION}-static`;
const RUNTIME_CACHE = `${VERSION}-runtime`;

// Assets criticos pra pre-cachear no install
const PRECACHE_URLS = [
  '/',
  '/style.css',
  '/script.js',
  '/storage.js',
  '/config.js',
  '/brand/icon.png',
  '/manifest.webmanifest'
];

// Hosts que NAO podem ser cacheados (API, auth, pagamento)
const NO_CACHE_HOSTS = [
  'supabase.co',
  'connect.facebook.net',
  'facebook.com',
  'pay.kirvano.com',
  'wa.me'
];

// ══ Install: pre-cache assets criticos ══
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then(cache => {
      // Falha silenciosamente em assets individuais (nao trava install)
      return Promise.allSettled(
        PRECACHE_URLS.map(url => cache.add(url).catch(() => null))
      );
    }).then(() => self.skipWaiting())
  );
});

// ══ Activate: limpa caches antigos ══
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key.indexOf(VERSION) !== 0)
          .map(key => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

// ══ Fetch: estrategia por tipo de request ══
self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);

  // Apenas GET — POST/PUT/DELETE sempre pra rede
  if (req.method !== 'GET') return;

  // Hosts excluidos (Supabase, Facebook, etc) — sempre rede
  if (NO_CACHE_HOSTS.some(host => url.host.includes(host))) {
    return; // deixa o browser tratar (network)
  }

  // HTML/documento: network-first
  if (req.mode === 'navigate' || req.destination === 'document') {
    event.respondWith(networkFirst(req));
    return;
  }

  // CSS/JS: network-first — logica e estilo DEVEM chegar frescos quando online.
  // Antes era stale-while-revalidate: servia a versao velha primeiro, entao fixes
  // criticos (ex: paywall) so pegavam na SEGUNDA abertura. Agora online = codigo novo.
  if (['style', 'script'].includes(req.destination)) {
    event.respondWith(networkFirst(req));
    return;
  }

  // Imagens/fontes: stale-while-revalidate (nao afetam logica, prioriza velocidade)
  if (['image', 'font'].includes(req.destination)) {
    event.respondWith(staleWhileRevalidate(req));
    return;
  }

  // Default: network-first com fallback cache
  event.respondWith(networkFirst(req));
});

// ══ Estrategias ══

async function networkFirst(req){
  try {
    const fresh = await fetch(req);
    // Cacheia respostas OK
    if (fresh.ok) {
      const cache = await caches.open(RUNTIME_CACHE);
      cache.put(req, fresh.clone()).catch(() => {});
    }
    return fresh;
  } catch(e) {
    // Offline: tenta cache
    const cached = await caches.match(req);
    if (cached) return cached;
    // Sem cache: pagina offline simples
    if (req.destination === 'document') {
      return new Response(
        '<!doctype html><meta charset="utf-8"><title>Apostack — Offline</title>' +
        '<style>body{font-family:system-ui;background:#060d18;color:#e2e8f0;padding:40px;text-align:center}h1{font-size:24px}p{color:#94a3b8}</style>' +
        '<h1>Sem conexão</h1><p>Verifique sua internet e tente novamente.</p>',
        { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
      );
    }
    throw e;
  }
}

async function staleWhileRevalidate(req){
  const cache = await caches.open(RUNTIME_CACHE);
  const cached = await cache.match(req);
  // Revalida em background
  const networkPromise = fetch(req).then(res => {
    if (res.ok) cache.put(req, res.clone()).catch(() => {});
    return res;
  }).catch(() => cached);
  // Retorna cache imediato OU espera rede
  return cached || networkPromise;
}
