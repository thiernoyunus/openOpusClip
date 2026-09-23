import { staticFile } from "remotion";

/**
 * CSS @font-face declaration for NotoSerif-Bold (bundled locally).
 * Use in components via: <style>{notoSerifFontFace}</style>
 */
export const NOTO_SERIF_FONT_FAMILY = "NotoSerif-Bold";

export const notoSerifFontFace = `
@font-face {
  font-family: '${NOTO_SERIF_FONT_FAMILY}';
  src: url('${staticFile("fonts/NotoSerif-Bold.ttf")}') format('truetype');
  font-weight: 700;
  font-style: normal;
}
`;

/**
 * Caption fonts bundled locally as variable TTFs. These render identically in
 * the in-browser preview/export and the headless render service. Variable axes
 * let one file cover every weight. The .ttf files live in remotion/public/fonts;
 * dashboard/public/fonts is a symlink to it, so there is a single copy.
 */
export const captionFontFaces = `
@font-face {
  font-family: 'Inter';
  src: url('${staticFile("fonts/Inter-Variable.ttf")}') format('truetype');
  font-weight: 100 900;
  font-style: normal;
  font-display: block;
}
@font-face {
  font-family: 'Space Grotesk';
  src: url('${staticFile("fonts/SpaceGrotesk-Variable.ttf")}') format('truetype');
  font-weight: 300 700;
  font-style: normal;
  font-display: block;
}
@font-face {
  font-family: 'Outfit';
  src: url('${staticFile("fonts/Outfit-Variable.ttf")}') format('truetype');
  font-weight: 100 900;
  font-style: normal;
  font-display: block;
}
@font-face {
  font-family: 'Montserrat';
  src: url('${staticFile("fonts/Montserrat-Variable.ttf")}') format('truetype');
  font-weight: 100 900;
  font-style: normal;
  font-display: block;
}
@font-face {
  font-family: 'Gabarito';
  src: url('${staticFile("fonts/Gabarito-Variable.ttf")}') format('truetype');
  font-weight: 100 900;
  font-style: normal;
  font-display: block;
}
@font-face {
  font-family: 'Anton';
  src: url('${staticFile("fonts/Anton-Regular.ttf")}') format('truetype');
  font-weight: 100 900;
  font-style: normal;
  font-display: block;
}
@font-face {
  font-family: 'Poppins';
  src: url('${staticFile("fonts/Poppins-ExtraBold.ttf")}') format('truetype');
  font-weight: 100 900;
  font-style: normal;
  font-display: block;
}
@font-face {
  font-family: 'Instrument Serif';
  src: url('${staticFile("fonts/InstrumentSerif-Regular.ttf")}') format('truetype');
  font-weight: 100 900;
  font-style: normal;
  font-display: block;
}
@font-face {
  /* DOAC template's serif-italic accent lines (italic-only family, latin +
     latin-ext subsets from @fontsource-variable/playfair-display, SIL OFL 1.1). */
  font-family: 'Playfair Display';
  src: url('${staticFile("fonts/PlayfairDisplay-Italic-latin.woff2")}') format('woff2');
  font-weight: 400 900;
  font-style: italic;
  font-display: block;
  unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
}
@font-face {
  font-family: 'Playfair Display';
  src: url('${staticFile("fonts/PlayfairDisplay-Italic-latinext.woff2")}') format('woff2');
  font-weight: 400 900;
  font-style: italic;
  font-display: block;
  unicode-range: U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF;
}
@font-face {
  /* Arabic/RTL fallback. Bold static covers every requested weight (it's a
     fallback for non-Latin glyphs, not a primary weight-variable face). */
  font-family: 'Noto Sans Arabic';
  src: url('${staticFile("fonts/NotoSansArabic-Bold.ttf")}') format('truetype');
  font-weight: 100 900;
  font-style: normal;
  font-display: block;
}
`;

/** Caption font families that need @font-face injection + a load wait before render. */
export const BUNDLED_CAPTION_FONTS = [
  "Inter",
  "Space Grotesk",
  "Outfit",
  "Montserrat",
  "Gabarito",
  "Anton",
  "Poppins",
  "Instrument Serif",
  // Not user-selectable: the DOAC template's italic accent face. Loaded as
  // italic (see CAPTION_FONT_LOAD_SPECS) since it has no upright style.
  "Playfair Display",
  // Not user-selectable; appended as the RTL fallback in getFontStack. Listed
  // here so the render service waits for it to load before rendering frames.
  "Noto Sans Arabic",
];

/** document.fonts.load() specs that make the render wait for every bundled face. */
export const CAPTION_FONT_LOAD_SPECS = BUNDLED_CAPTION_FONTS.map((f) =>
  f === "Playfair Display" ? `italic 600 64px "${f}"` : `700 64px "${f}"`
);

/**
 * Map of subtitle font families to their CSS-safe stacks. The first three are
 * bundled (see captionFontFaces); the rest are legacy system fonts kept for
 * back-compat with older saved projects.
 */
export const SUBTITLE_FONTS: Record<string, string> = {
  Inter: "'Inter', system-ui, -apple-system, sans-serif",
  "Space Grotesk": "'Space Grotesk', system-ui, sans-serif",
  Outfit: "'Outfit', system-ui, sans-serif",
  Montserrat: "'Montserrat', system-ui, sans-serif",
  Gabarito: "'Gabarito', system-ui, sans-serif",
  Anton: "'Anton', Impact, sans-serif",
  Poppins: "'Poppins', system-ui, sans-serif",
  "Instrument Serif": "'Instrument Serif', Georgia, serif",
  Verdana: "Verdana, Geneva, sans-serif",
  Arial: "Arial, Helvetica, sans-serif",
  Impact: "Impact, Haettenschweiler, sans-serif",
  Helvetica: "Helvetica, Arial, sans-serif",
  Georgia: "Georgia, 'Times New Roman', serif",
  "Courier New": "'Courier New', Courier, monospace",
};

export function getFontStack(fontFamily: string): string {
  // Append the Arabic/RTL fallback to every stack so non-Latin glyphs (Arabic,
  // Persian, Urdu) render instead of tofu boxes, while Latin keeps the chosen
  // font. The render service preloads 'Noto Sans Arabic' (see BUNDLED_CAPTION_FONTS).
  const base = SUBTITLE_FONTS[fontFamily] ?? fontFamily;
  return `${base}, 'Noto Sans Arabic'`;
}
