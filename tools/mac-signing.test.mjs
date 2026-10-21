import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { signBundle, signingIdentity, verifyBundle } from './mac-signing.mjs';

test('local certificate preserves identity across changed binaries and rejects tampering', { skip: process.platform !== 'darwin' }, (t) => {
  const root = mkdtempSync(join(tmpdir(), 'steward-signing-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fingerprint = signingIdentity();
  const make = (version) => {
    const bundle = join(root, `v${version}`, 'Steward.app');
    mkdirSync(join(bundle, 'Contents/MacOS'), { recursive: true });
    mkdirSync(join(bundle, 'Contents/Resources/node/bin'), { recursive: true });
    execFileSync('/usr/bin/clang', ['-x', 'c', '-', '-o', join(bundle, 'Contents/MacOS/StewardLauncher')], { input: `int main(void) { return ${version}; }\n` });
    cpSync(join(bundle, 'Contents/MacOS/StewardLauncher'), join(bundle, 'Contents/Resources/node/bin/node'));
    writeFileSync(join(bundle, 'Contents/Info.plist'), `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.steward.launcher</string><key>CFBundleExecutable</key><string>StewardLauncher</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>${version}</string></dict></plist>`);
    writeFileSync(join(bundle, 'Contents/Resources/data.txt'), 'original');
    signBundle(bundle);
    return bundle;
  };
  const first = make(1);
  const second = make(2);
  assert.notDeepEqual(readFileSync(join(first, 'Contents/MacOS/StewardLauncher')), readFileSync(join(second, 'Contents/MacOS/StewardLauncher')));
  const requirement = (bundle) => {
    const result = execFileSync('/usr/bin/codesign', ['-d', '-r-', bundle], { encoding: 'utf8' });
    return result.replace(/^.*designated => /s, '').trim();
  };
  const originalRequirement = requirement(first);
  assert.equal(requirement(second), originalRequirement);
  execFileSync('/usr/bin/codesign', ['--verify', '-R', `=${originalRequirement}`, second]);
  assert.equal(verifyBundle(second, fingerprint).fingerprint, fingerprint);
  assert.throws(() => verifyBundle(second, '0'.repeat(40)), /identity changed/);
  writeFileSync(join(second, 'Contents/Resources/data.txt'), 'tampered');
  assert.throws(() => verifyBundle(second), /codesign/);
  writeFileSync(join(first, 'Contents/Resources/node/bin/node'), 'tampered helper');
  assert.throws(() => verifyBundle(first), /codesign/);
});
