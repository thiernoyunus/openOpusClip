/**
 * Self-check for the afterSign notarization guard in electron-builder.js.
 * Run: node electron/notarize-guard.selfcheck.js
 *
 * What this protects: electron-builder logs ONE line ("skipped macOS
 * notarization") when it cannot find credentials, then builds artifacts that
 * look correct and show "Apple cannot check it for malicious software" on every
 * user's Mac. Release 1.0.17 shipped that way and needed the DMGs notarized by
 * hand afterwards. The guard turns that silent warning into a failed build.
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const config = require('./electron-builder.js');

const ctx = (appOutDir, platform = 'darwin') => ({
  electronPlatformName: platform,
  appOutDir,
  packager: { appInfo: { productFilename: 'openOpusClip' } },
});

const run = async (context) => {
  try {
    await config.afterSign(context);
    return null;
  } catch (err) {
    return err;
  }
};

(async () => {
  // 1. Credentials from electron/.env reach the names electron-builder reads.
  //    Without APPLE_APP_SPECIFIC_PASSWORD it silently skips notarization.
  if (fs.existsSync(path.join(__dirname, '.env'))) {
    for (const key of ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID']) {
      assert.ok(process.env[key], `${key} is not set — electron-builder would skip notarization`);
    }
    console.log('  ok  credentials mapped for electron-builder');
  } else {
    console.log('  --  skipped credential check (no electron/.env here)');
  }

  // 2. An app with no stapled ticket must FAIL the build, not warn.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'notarize-guard-'));
  fs.mkdirSync(path.join(tmp, 'openOpusClip.app'));
  const err = await run(ctx(tmp));
  assert.ok(err, 'an unstapled app was allowed through');
  assert.match(err.message, /no stapled notarization ticket/);
  console.log('  ok  unstapled app fails the build');

  // 3. Non-macOS builds are untouched (Windows has no notarization).
  assert.strictEqual(await run(ctx(tmp, 'win32')), null, 'the guard fired on a Windows build');
  console.log('  ok  windows build unaffected');

  // 4. The deliberate opt-out works, for local unsigned test builds.
  process.env.OPENSHORTS_SKIP_NOTARIZE = '1';
  delete require.cache[require.resolve('./electron-builder.js')];
  const optedOut = require('./electron-builder.js');
  assert.strictEqual(
    await optedOut.afterSign(ctx(tmp)).then(() => null, (e) => e),
    null,
    'OPENSHORTS_SKIP_NOTARIZE did not bypass the guard'
  );
  delete process.env.OPENSHORTS_SKIP_NOTARIZE;
  console.log('  ok  OPENSHORTS_SKIP_NOTARIZE opt-out works');

  // 5. The backstop: electron-builder skips afterSign entirely when signing
  //    did not happen, so macOS artifacts can be produced with the guard above
  //    never running. afterAllArtifactBuild must catch that.
  delete require.cache[require.resolve('./electron-builder.js')];
  const fresh = require('./electron-builder.js');
  const macBuild = {
    platformToTargets: new Map([[{ name: 'mac' }, new Map()]]),
    artifactPaths: [path.join(tmp, 'openOpusClip-9.9.9-arm64.dmg')],
  };
  const winBuild = {
    platformToTargets: new Map([[{ name: 'windows' }, new Map()]]),
    artifactPaths: [path.join(tmp, 'openOpusClip-9.9.9-x64.exe')],
  };
  const backstopErr = await fresh
    .afterAllArtifactBuild(macBuild)
    .then(() => null, (e) => e);
  assert.ok(backstopErr, 'macOS artifacts shipped without the guard ever running');
  assert.match(backstopErr.message, /guard never ran/);
  console.log('  ok  unsigned macOS build fails even though afterSign never runs');

  assert.strictEqual(
    await fresh.afterAllArtifactBuild(winBuild).then(() => null, (e) => e),
    null,
    'the backstop fired on a Windows-only build'
  );
  console.log('  ok  windows-only build unaffected by the backstop');

  // 6. A genuinely stapled app passes. Only runs where one is available.
  const stapled = path.join(__dirname, 'dist', 'mac-arm64');
  let isStapled = false;
  try {
    execFileSync('xcrun', ['stapler', 'validate', path.join(stapled, 'openOpusClip.app')], { stdio: 'pipe' });
    isStapled = true;
  } catch { /* not built, or not stapled */ }
  if (isStapled) {
    delete require.cache[require.resolve('./electron-builder.js')];
    const signed = require('./electron-builder.js');
    assert.strictEqual(
      await signed.afterSign(ctx(stapled)).then(() => null, (e) => e),
      null,
      'a stapled app was rejected'
    );
    console.log('  ok  stapled app passes');
    // ...and once an app is cleared, the backstop stays quiet.
    assert.strictEqual(
      await signed.afterAllArtifactBuild(macBuild).then(() => null, (e) => e),
      null,
      'the backstop fired after an app was cleared'
    );
    console.log('  ok  backstop quiet once an app is cleared');
  } else {
    console.log('  --  skipped stapled-app check (no stapled build in dist/)');
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('notarize-guard.selfcheck: all assertions passed');
})();
