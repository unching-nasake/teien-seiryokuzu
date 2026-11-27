import { defineConfig } from 'vite';

// COOP/COEP ヘッダを付与し SharedArrayBuffer を有効化
const crossOriginIsolationPlugin = () => {
  const applyHeaders = (
    _req: unknown,
    res: { setHeader: (k: string, v: string) => void },
    next: () => void
  ) => {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    next();
  };
  return {
    name: 'cross-origin-isolation',
    configureServer(server: { middlewares: { use: (fn: typeof applyHeaders) => void } }) {
      server.middlewares.use(applyHeaders);
    },
    configurePreviewServer(server: { middlewares: { use: (fn: typeof applyHeaders) => void } }) {
      server.middlewares.use(applyHeaders);
    },
  };
};

export default defineConfig({
  plugins: [crossOriginIsolationPlugin()],
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'preact',
  },
  worker: {
    format: 'es',
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3000',
      },
      '/ws': {
        target: 'ws://127.0.0.1:3000',
        ws: true,
      },
    },
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
  },
});
