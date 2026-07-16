/** @type {import('tailwindcss').Config} */
export default {
  // Scan every source file so all utility classes used in JSX are compiled into
  // the bundle (replacing the runtime cdn.tailwindcss.com JIT).
  content: [
    './index.html',
    './index.tsx',
    './App.tsx',
    './components/**/*.{ts,tsx}',
    './services/**/*.{ts,tsx}',
    './store/**/*.{ts,tsx}',
    './hooks/**/*.{ts,tsx}',
  ],
  // darkMode left at the v3 default ('media') to match the Play CDN's behavior —
  // the app themes via `theme === 'dark' ? ...` conditionals + CSS variables, not
  // Tailwind `dark:` variants (there are none in the codebase).
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#f0fdfa',
          100: '#ccfbf1',
          500: '#14b8a6',
          600: '#0d9488',
          900: '#134e4a',
        },
        slate: {
          850: '#1e293b', // Custom dark shade used across the app
        },
      },
    },
  },
  // A few components build class names dynamically (e.g. `bg-${color}-500/15` in
  // AlertRuleWizard/DataCleaningPanel). The build-time scanner can't see those,
  // so safelist the exact color set and shades/opacities they use.
  safelist: [
    {
      pattern: /(bg|text|border)-(red|amber|blue|indigo|purple|teal|orange|cyan)-(50|300|500|600|700)/,
    },
    {
      pattern: /(bg|text|border)-(red|amber|blue|indigo|purple|teal|orange|cyan)-(500)\/(15|30)/,
    },
    {
      pattern: /bg-(red|amber|blue|indigo|purple|teal|orange|cyan)-50\/50/,
    },
  ],
};
