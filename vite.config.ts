import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, '.', '');
    return {
      server: {
        port: 3000,
        host: '0.0.0.0',
      },
      plugins: [react()],
      define: {
        'process.env.API_KEY': JSON.stringify(env.GEMINI_API_KEY),
        'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY)
      },
      resolve: {
        alias: {
          '@': path.resolve(__dirname, '.'),
        }
      },
      // The ETL Web Worker must emit an ES module so it can participate in
      // code-splitting alongside the manualChunks config below.
      worker: {
        format: 'es',
      },
      build: {
        // Raise the warning ceiling now that heavy libs are split out into their
        // own cacheable chunks (see manualChunks below).
        chunkSizeWarningLimit: 900,
        rollupOptions: {
          output: {
            // Split large third-party libraries into separate chunks so they
            // load in parallel and cache independently of app code — the app
            // shell no longer ships as one 2.5 MB monolith.
            manualChunks(id) {
              if (!id.includes('node_modules')) return undefined;
              // xlsx and html2canvas are loaded via dynamic import(). Return
              // undefined so rollup keeps them in their own async chunks instead
              // of the catch-all 'vendor' below (which would load them eagerly).
              if (id.includes('xlsx') || id.includes('html2canvas')) return undefined;
              if (id.includes('@duckdb')) return 'vendor-duckdb';
              if (id.includes('chart.js') || id.includes('react-chartjs-2') || id.includes('chartjs-chart-treemap')) return 'vendor-charts';
              if (id.includes('react-simple-maps') || id.includes('d3-scale') || id.includes('d3-') || id.includes('topojson')) return 'vendor-maps';
              if (id.includes('framer-motion')) return 'vendor-motion';
              if (id.includes('react-grid-layout')) return 'vendor-grid';
              if (id.includes('react-dom') || id.includes('/react/') || id.includes('scheduler')) return 'vendor-react';
              return 'vendor';
            },
          },
        },
      },
    };
});
