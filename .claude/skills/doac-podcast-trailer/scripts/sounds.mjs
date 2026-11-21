// Fetch the trailer's sound effects from HyperFrames' sound library (run by sfx.py, not by hand).
// usage: node sounds.mjs <dest_dir> '<{"boom": {"heygen": "search words", "bundled": "impact-bass-1"}, ...}>'
// Signed in to HeyGen (`hyperframes auth login`, or $HEYGEN_API_KEY): each sound is searched in HeyGen's library.
// Not signed in: HyperFrames' bundled, free-to-use effects are used. Prints {mode, files: {kind: path}, notes} as JSON.
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [dest, spec] = process.argv.slice(2);
const want = JSON.parse(spec);
const pkg = process.env.DOAC_HF_PKG;
const audio = pkg && join(pkg, "dist/skills/media-use/audio");
const out = { mode: "none", files: {}, notes: [] };
mkdirSync(dest, { recursive: true });

async function lib(name) {
  return import(pathToFileURL(join(audio, "scripts/lib", name)).href);
}

try {
  if (!audio || !existsSync(audio)) throw new Error("HyperFrames sound library not found: run setup.sh, then source env.sh");
  const { heygenCredential, heygenAuthHeaders } = await lib("heygen.mjs");
  const { resolveSfx } = await lib("sfx.mjs");
  const signedIn = Boolean(heygenCredential()?.headers);
  out.mode = signedIn ? "heygen" : "bundled";
  const cues = Object.entries(want).map(([kind, q]) => ({ id: kind, name: signedIn ? q.heygen : q.bundled }));
  const { sfx, anomalies } = await resolveSfx({
    cues, heygenOK: signedIn, headers: signedIn ? heygenAuthHeaders() : {},
    hyperframesDir: dest, sfxLibDir: join(audio, "assets/sfx"),
  });
  for (const s of sfx) out.files[s.id] = join(dest, s.file);
  out.notes.push(...anomalies);
  // A HeyGen search that found nothing falls back to the bundled effect for that sound.
  for (const [kind, q] of Object.entries(want)) {
    const src = join(audio, "assets/sfx", `${q.bundled}.mp3`);
    if (!out.files[kind] && existsSync(src)) {
      const to = join(dest, "assets/sfx", `${q.bundled}.mp3`);
      mkdirSync(join(dest, "assets/sfx"), { recursive: true });
      copyFileSync(src, to);
      out.files[kind] = to;
    }
  }
} catch (e) {
  out.notes.push(String(e.message || e));
}
console.log(JSON.stringify(out));
