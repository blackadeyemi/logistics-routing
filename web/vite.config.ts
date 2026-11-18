import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig(({ mode }) => {
  // Settings live in the repo root .env, shared with docker compose. Only
  // VITE_ prefixed values reach the browser bundle.
  const envDir = fileURLToPath(new URL('..', import.meta.url));
  const env = loadEnv(mode, envDir, '');
  // Where api-node listens on this machine: API_HOST_PORT from the root
  // .env, or API_PROXY_TARGET to point somewhere else.
  const apiTarget = env.API_PROXY_TARGET || `http://localhost:${env.API_HOST_PORT || 3000}`;

  return {
    envDir,
    plugins: [
      react(),
      VitePWA({
        registerType: 'autoUpdate',
        includeAssets: ['mark.svg', 'fonts/inter/Inter.woff2', 'apple-touch-icon-180x180.png'],
        manifest: {
          id: '/driver/',
          name: 'Logistics Routing Driver',
          short_name: 'Driver',
          description: 'Today\'s stops, status updates and directions. Works with poor or no network.',
          start_url: '/driver/?source=pwa',
          scope: '/driver/',
          display: 'standalone',
          orientation: 'portrait',
          background_color: '#0f172a',
          theme_color: '#0f172a',
          icons: [
            { src: '/pwa-64x64.png', sizes: '64x64', type: 'image/png' },
            { src: '/pwa-192x192.png', sizes: '192x192', type: 'image/png' },
            { src: '/pwa-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
            { src: '/maskable-icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          ],
        },
        workbox: {
          // App shell offline. API calls are never cached by the service
          // worker: the driver app keeps its own copy of the route.
          navigateFallback: '/index.html',
          navigateFallbackDenylist: [/^\/api\//],
          globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        },
        devOptions: { enabled: false },
      }),
    ],
    server: {
      host: true,
      port: 5173,
      // Laragon proxies http://logistics-routing.test to this server.
      allowedHosts: ['logistics-routing.test'],
      proxy: {
        '/api': { target: apiTarget, changeOrigin: true, rewrite: (p) => p.replace(/^\/api/, '') },
      },
    },
    preview: {
      host: true,
      port: 4173,
      proxy: {
        '/api': { target: apiTarget, changeOrigin: true, rewrite: (p) => p.replace(/^\/api/, '') },
      },
    },
  };
});
