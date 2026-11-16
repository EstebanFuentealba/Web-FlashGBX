if (typeof window === 'undefined') {
  self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
  self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

  self.addEventListener('fetch', event => {
    if (!event.request.url.startsWith(self.registration.scope)) return;

    event.respondWith((async () => {
      const response = await fetch(event.request);
      if (response.status === 0) return response;

      const headers = new Headers(response.headers);
      headers.set('Cross-Origin-Opener-Policy', 'same-origin');
      headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
      headers.set('Cross-Origin-Resource-Policy', 'same-origin');
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    })());
  });
} else if (window.isSecureContext && !window.crossOriginIsolated && navigator.serviceWorker) {
  const serviceWorker = navigator.serviceWorker;
  const scriptURL = document.currentScript.src;

  // A claimed page needs a fresh navigation to apply the isolation headers.
  serviceWorker.addEventListener('controllerchange', () => {
    if (serviceWorker.controller?.scriptURL === scriptURL) window.location.reload();
  }, { once: true });

  serviceWorker.register(scriptURL).catch(error => {
    console.error('No se pudo activar el aislamiento de origen en GitHub Pages.', error);
  });
}
