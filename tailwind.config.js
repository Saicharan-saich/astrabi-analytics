/** @type {import('tailwindcss').Config} */

// ── Brand colour system ────────────────────────────────────────────────
// The logo is blue + green, and index.css already declares azure (#4f80ff)
// as the single accent. Components, however, historically painted the accent
// with Tailwind's `violet` and `indigo` scales, so the UI mixed three accents
// (azure tokens, violet/indigo components, an unused teal `brand`).
//
// Rather than rewrite ~1,400 class names, `violet` and `indigo` are remapped
// to two harmonised blues from the logo: `violet-*` → azure (bright accent),
// `indigo-*` → royal (deeper partner for gradients). Existing gradients such
// as `from-violet-500 to-indigo-500` become a calm single-hue blue gloss.
// `brand-*` aliases azure for new code. White text on the 600 shades passes
// WCAG AA (≥5:1); 300/400 text on the dark surface stays ≥5.5:1.
const azure = {
  50: '#eef3ff',
  100: '#dbe6ff',
  200: '#bfd2ff',
  300: '#94b3ff',
  400: '#6d95ff',
  500: '#4f80ff',
  600: '#3565e8',
  700: '#2c55c8',
  800: '#2a479f',
  900: '#263f83',
  950: '#1a2650',
};

const royal = {
  50: '#eef2fc',
  100: '#dce4f9',
  200: '#bccbf3',
  300: '#8fa8ea',
  400: '#6d8ae6',
  500: '#4f6fdc',
  600: '#3d58c4',
  700: '#3247a0',
  800: '#2c3c80',
  900: '#273466',
  950: '#192142',
};

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
        brand: azure,
        violet: azure,
        indigo: royal,
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
