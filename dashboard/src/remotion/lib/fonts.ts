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
 * the in-browser preview/export (dashboard/public) and the headless render
 * service (remotion/public). Variable axes let one file cover every weight.
 *
 * IMPORTANT: this file is duplicated at remotion/src/lib/fonts.ts — keep both
 * copies in sync, and keep the .ttf files in both public/fonts dirs.
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
];

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
  return SUBTITLE_FONTS[fontFamily] ?? fontFamily;
}
