import type { Plugin } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import { defineConfig } from "vitest/config";

/** Base path of the project page on GitHub Pages. */
export const BASE = "/english-vera/";

/**
 * Content Security Policy, injected only in production builds (dev needs Vite's inline
 * styles and HMR). GitHub Pages cannot set headers, so it lives in a <meta> tag.
 */
export const CSP = [
  "default-src 'self'",
  "connect-src 'self' https://api.anthropic.com https://api.github.com",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "media-src 'self' data:",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

function cspPlugin(): Plugin {
  return {
    name: "vera-csp",
    apply: "build",
    transformIndexHtml(html) {
      return html.replace(
        "<head>",
        `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}">`,
      );
    },
  };
}

export default defineConfig({
  base: BASE,
  plugins: [
    cspPlugin(),
    VitePWA({
      registerType: "prompt",
      injectRegister: null,
      includeAssets: ["favicon.svg", "apple-touch-icon.png"],
      manifest: {
        id: BASE,
        name: "Vera",
        short_name: "Vera",
        description: "Tutor vocale di inglese",
        lang: "it",
        start_url: BASE,
        scope: BASE,
        display: "standalone",
        background_color: "#f4f5f3",
        theme_color: "#14171a",
        icons: [
          { src: "icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icons/icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,ico,png,svg,woff2,webmanifest}"],
        globIgnores: ["**/*-cyrillic*", "**/*-greek*", "**/*-vietnamese*", "**/*-latin-ext-*"],
        navigateFallback: `${BASE}index.html`,
        // Never cache the APIs: the user's data and key must not sit in a cache.
        runtimeCaching: [],
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
      },
    }),
  ],
  build: {
    target: "es2022",
    sourcemap: false,
  },
  test: {
    include: ["tests/unit/**/*.test.ts", "src/**/*.test.ts"],
    environment: "node",
  },
});
