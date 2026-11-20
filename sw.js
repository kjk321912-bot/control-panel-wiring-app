// 제어판 배선 — 로더 서비스워커 (앱 파일은 인증 뒤 캐시 'cpw-app' 에 풀려 있고, 여기서 기한을 보며 내준다)
const SHELL_VER = 'ebe6542392';
const SHELL = 'cpw-shell-' + SHELL_VER, APP = 'cpw-app', LIC = 'cpw-lic', FONT = 'cpw-font';
const FILES = ['./', 'index.html', 'lic.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png', 'icons/apple-touch-icon.png'];
const SCOPE = new URL('./', self.location).href;

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('cpw-shell-') && k !== SHELL).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

async function licExp() {
  try {
    const r = await (await caches.open(LIC)).match(new URL('lic.json', SCOPE).href);
    if (!r) return 0;
    return +(await r.json()).payload.split('|')[3] || 0;
  } catch (_) { return 0; }
}

async function serveApp(req) {
  const url = new URL(req.url);
  if (url.pathname.endsWith('/app/')) url.pathname += 'index.html';
  const hit = await (await caches.open(APP)).match(url.href, { ignoreSearch: true });
  if (!hit) return fetch(req); // 풀어 둔 앱이 없으면 공개된 안내 쪽지(app/index.html)가 로더로 돌려보냄
  if (Date.now() >= (await licExp())) return Response.redirect(SCOPE, 302); // 사용권이 없거나 기한이 지남
  return hit;
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(caches.open(FONT).then(async c => {
      const hit = await c.match(req);
      if (hit) return hit;
      try { const res = await fetch(req); if (res.ok || res.type === 'opaque') c.put(req, res.clone()); return res; }
      catch (_) { return new Response('', { status: 503 }); }
    }));
    return;
  }
  if (url.origin !== location.origin || !url.href.startsWith(SCOPE)) return;
  const path = url.href.slice(SCOPE.length);
  if (path.startsWith('enc/')) return; // 암호문은 캐시하지 않고 항상 서버에서
  if (path.startsWith('app/')) { e.respondWith(serveApp(req)); return; }
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req, { cache: 'no-store' }).then(res => { const cp = res.clone(); caches.open(SHELL).then(c => c.put('index.html', cp)); return res; })
      .catch(() => caches.match('index.html')));
    return;
  }
  e.respondWith(caches.match(req, { ignoreSearch: true }).then(hit => hit || fetch(req)));
});
