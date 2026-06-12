/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // Opus-style zinc dark palette (extracted from clip.opus.pro)
        background: "#0e1015", // app background
        canvas: "#09090b",     // deepest surface (editor canvas)
        surface: "#18181b",    // cards / panels (zinc-900)
        surface2: "#27272a",   // raised surface / secondary button (zinc-800)
        edge: "#27272a",       // borders / dividers
        fg: "#fafafa",         // primary text
        muted: "#9b9ea3",      // secondary text
        viral: "#3dd68c",      // keyword / positive green (use sparingly)
        // legacy accents (still used by not-yet-restyled tabs)
        primary: "#3b82f6",
        accent: "#8b5cf6",
      },
      fontFamily: {
        sans: ['Geist', 'Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'sans-serif'],
        display: ['Poppins', 'Geist', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
      animation: {
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
      }
    },
  },
  plugins: [],
}
