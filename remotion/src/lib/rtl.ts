import type { CaptionWord } from "./types";

// Right-to-left scripts we care about for captions (Arabic covers Persian/Urdu).
const RTL_CHARS = /[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Thaana}\p{Script=Syriac}]/u;

/** True if the text contains any right-to-left script characters. */
export function isRTL(text: string): boolean {
  return RTL_CHARS.test(text);
}

/**
 * Dominant text direction for a caption block: "rtl" when more words are RTL
 * than LTR, else "ltr". Text-based (works for any backend, not just Soniox).
 */
export function dominantDir(words: CaptionWord[]): "rtl" | "ltr" {
  let rtl = 0;
  for (const w of words) if (isRTL(w.text)) rtl++;
  return rtl > words.length - rtl ? "rtl" : "ltr";
}
