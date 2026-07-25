// Submit a built artifact to Apple's notary service and staple the ticket.
//
// Signing proves WHO built the app; notarizing proves Apple scanned it. Without
// notarization macOS still warns on first open ("unidentified developer"), so
// this is the step that makes a download open cleanly for other people.
//
// Usage:
//   node scripts/notarize.js                       # newest .dmg in dist/
//   node scripts/notarize.js dist/<name>.dmg       # a specific artifact
//   node scripts/notarize.js dist/mac/Some.app     # zipped automatically
//
// Credentials come from electron/.env (git-ignored) or the environment:
//   APPLE_ID="you@example.com"
//   APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"   # appleid.apple.com
//   APPLE_TEAM_ID="..."                            # optional, defaults below

const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ELECTRON_DIR = path.join(__dirname, '..');
const DIST_DIR = path.join(ELECTRON_DIR, 'dist');
const DEFAULT_TEAM_ID = '257JN3YM2Y';

// Minimal .env reader: KEY=value / KEY="value", skipping blanks and comments.
// Real env vars win so CI can override without editing the file.
const envPath = path.join(ELECTRON_DIR, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || line.trim().startsWith('#')) continue;
    const [, key, rawValue] = match;
    if (process.env[key]) continue;
    process.env[key] = rawValue.replace(/^["']|["']$/g, '');
  }
}

const appleId = process.env.APPLE_ID;
const password = process.env.APP_SPECIFIC_PASSWORD;
const teamId = process.env.APPLE_TEAM_ID || DEFAULT_TEAM_ID;

if (!appleId || !password) {
  // Exit 0, not 1: a missing credential should leave you with a signed (if not
  // notarized) build rather than failing the whole package run.
  console.log('Skipping notarization — set APPLE_ID and APP_SPECIFIC_PASSWORD in electron/.env');
  process.exit(0);
}

function resolveTarget(arg) {
  if (!arg) {
    if (!fs.existsSync(DIST_DIR)) throw new Error(`no dist/ directory at ${DIST_DIR}`);
    const dmgs = fs.readdirSync(DIST_DIR)
      .filter((f) => f.endsWith('.dmg'))
      .map((f) => path.join(DIST_DIR, f))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    if (dmgs.length === 0) throw new Error(`no .dmg found in ${DIST_DIR} — package first`);
    return dmgs[0];
  }

  const resolved = path.resolve(arg);
  if (!fs.existsSync(resolved)) throw new Error(`not found: ${resolved}`);

  return resolved;
}

let target;
try {
  target = resolveTarget(process.argv[2]);
} catch (err) {
  console.error(`notarize: ${err.message}`);
  process.exit(1);
}

// The notary service only accepts .zip, .pkg, or .dmg — a raw .app bundle is
// rejected during pre-flight. Zip it (ditto preserves the symlinks and
// extended attributes that code signatures depend on; a plain `zip` can
// invalidate the signature). Stapling still has to target the ORIGINAL .app,
// since the ticket cannot be attached to a throwaway archive.
let uploadPath = target;
let stapleTarget = target;
let tempDir = null;

if (target.endsWith('.app')) {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notarize-'));
  uploadPath = path.join(tempDir, `${path.basename(target, '.app')}.zip`);
  console.log(`Archiving ${path.basename(target)} for submission...`);
  execFileSync('ditto', ['-c', '-k', '--keepParent', target, uploadPath], { stdio: 'inherit' });
}

function cleanup() {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
}
process.on('exit', cleanup);

console.log(`Submitting ${path.basename(uploadPath)} to Apple (team ${teamId})...`);
console.log('This uploads the whole artifact and waits for the scan — expect several minutes.');
execFileSync('xcrun', [
  'notarytool', 'submit', uploadPath,
  '--apple-id', appleId,
  '--team-id', teamId,
  '--password', password,
  '--wait',
], { stdio: 'inherit' });

// Stapling attaches the ticket so Gatekeeper can verify offline. This targets
// the original artifact, not the temporary zip.
console.log('Stapling notarization ticket...');
execFileSync('xcrun', ['stapler', 'staple', stapleTarget], { stdio: 'inherit' });

console.log(`\nDone. Verify with:\n  spctl -a -vvv "${stapleTarget}"`);
