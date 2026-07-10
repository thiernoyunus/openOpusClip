/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // OpusClip pixel targets (sampled from product screenshots)
        background: "#0b0b0d", // app / editor chrome
        canvas: "#000000",     // deepest surface (preview + timeline)
        surface: "#121214",    // cards / floating panels
        surface2: "#1a1a1d",   // raised surface / secondary button
        edge: "#222226",       // borders / dividers
        fg: "#f4f4f5",         // primary text
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
