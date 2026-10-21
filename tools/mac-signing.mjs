#!/usr/bin/env node
// Local signing identity: private key stays in Keychain, never in the repository.
import { execFileSync } from 'node:child_process';
import { X509Certificate, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, openSync, closeSync, readSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const identityFile = join(homedir(), 'Library/Application Support/Steward/signing/identity.json');
const identifier = 'com.steward.launcher';
function run(program, args, options = {}) {
  try { return execFileSync(program, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options }).trim(); }
  catch (error) { throw new Error(`${program} ${args[0]} failed: ${String(error.stderr || error.code || 'unknown error').trim()}`); }
}

export function signingIdentity() {
  if (process.platform !== 'darwin') throw new Error('macOS signing requires macOS');
  const fingerprint = process.env.STEWARD_SIGNING_IDENTITY || (existsSync(identityFile) ? JSON.parse(readFileSync(identityFile, 'utf8')).fingerprint : '');
  if (!/^[a-f0-9]{40}$/i.test(fingerprint)) throw new Error('No pinned signing identity. Run npm run signing:setup once; builds never generate a replacement identity.');
  const identities = run('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning']);
  if (!identities.toUpperCase().includes(fingerprint.toUpperCase())) throw new Error('The configured signing certificate/private key is missing, expired or untrusted in Keychain. Restore the original identity; do not silently replace it.');
  return fingerprint.toUpperCase();
}

function setup() {
  if (existsSync(identityFile) || process.env.STEWARD_SIGNING_IDENTITY) {
    console.log(`Reusing signing identity ${signingIdentity()}`);
    return;
  }
  try {
    const existing = execFileSync('/usr/bin/security', ['find-certificate', '-c', 'Steward Local Development', '-p'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    if (existing) throw new Error('A Steward certificate already exists without its identity manifest. Restore the original manifest or set STEWARD_SIGNING_IDENTITY to its SHA-1; no new key was generated.');
  } catch (error) { if (!error.status) throw error; }
  const temporary = mkdtempSync(join(tmpdir(), 'steward-signing-'));
  chmodSync(temporary, 0o700);
  try {
    const key = join(temporary, 'key.pem');
    const cert = join(temporary, 'certificate.pem');
    const p12 = join(temporary, 'identity.p12');
    const extensions = join(temporary, 'extensions.cnf');
    writeFileSync(extensions, 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=critical,codeSigning\n');
    const request = join(temporary, 'request.pem');
    run('/usr/bin/openssl', ['req', '-new', '-newkey', 'rsa:3072', '-nodes', '-keyout', key, '-out', request, '-subj', '/CN=Steward Local Development']);
    chmodSync(key, 0o600);
    run('/usr/bin/openssl', ['x509', '-req', '-in', request, '-signkey', key, '-out', cert, '-days', '3650', '-sha256', '-extfile', extensions]);
    const password = randomBytes(32).toString('hex');
    run('/usr/bin/openssl', ['pkcs12', '-export', '-inkey', key, '-in', cert, '-out', p12, '-passout', 'env:STEWARD_P12_PASSWORD'], { env: { ...process.env, STEWARD_P12_PASSWORD: password } });
    const keychain = run('/usr/bin/security', ['default-keychain', '-d', 'user']).replaceAll('"', '').trim();
    run('/usr/bin/security', ['import', p12, '-k', keychain, '-P', password, '-T', '/usr/bin/codesign']);
    // User trust only, limited to code signing; no system-wide root changes.
    run('/usr/bin/security', ['add-trusted-cert', '-r', 'trustRoot', '-p', 'codeSign', '-k', keychain, cert]);
    const fingerprint = new X509Certificate(readFileSync(cert)).fingerprint.replaceAll(':', '');
    mkdirSync(dirname(identityFile), { recursive: true, mode: 0o700 });
    writeFileSync(join(dirname(identityFile), 'certificate.pem'), readFileSync(cert), { mode: 0o600 });
    writeFileSync(identityFile, JSON.stringify({ fingerprint, name: 'Steward Local Development', createdAt: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600 });
    console.log(`Configured persistent local identity ${signingIdentity()}. Private key is in ${keychain}.`);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

const machoMagic = new Set(['cffaedfe', 'cefaedfe', 'feedfacf', 'feedface', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca']);
function isMachO(path) {
  const fd = openSync(path, 'r');
  try { const bytes = Buffer.alloc(4); return readSync(fd, bytes, 0, 4, 0) === 4 && machoMagic.has(bytes.toString('hex')); }
  finally { closeSync(fd); }
}

export function signBundle(bundle) {
  const fingerprint = signingIdentity();
  function sign(path, outer = false) {
    run('/usr/bin/codesign', ['--force', '--sign', fingerprint, '--timestamp=none', ...(outer ? ['--identifier', identifier] : []), path]);
  }
  function walk(path) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (entry.name === '_CodeSignature') continue;
        walk(child);
        if (/\.(app|framework|xpc|appex)$/.test(entry.name)) sign(child);
      } else if (entry.isFile() && isMachO(child)) sign(child);
    }
  }
  walk(bundle);
  writeFileSync(join(bundle, 'Contents/Resources/steward-signing.json'), JSON.stringify({ identifier, fingerprint }) + '\n');
  sign(bundle, true);
  verifyBundle(bundle, fingerprint);
  console.log(`Signed and verified ${bundle} with ${fingerprint}`);
}

export function verifyBundle(bundle, expectedFingerprint) {
  const metadata = JSON.parse(readFileSync(join(bundle, 'Contents/Resources/steward-signing.json'), 'utf8'));
  if (metadata.identifier !== identifier || !/^[a-f0-9]{40}$/i.test(metadata.fingerprint)) throw new Error('Invalid app signing metadata');
  if (expectedFingerprint && metadata.fingerprint.toUpperCase() !== expectedFingerprint.toUpperCase()) throw new Error('App signing identity changed. Explicit identity migration is required.');
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
  run('/usr/bin/codesign', ['--verify', '-R', `=identifier "${identifier}" and certificate leaf = H"${metadata.fingerprint}"`, bundle]);
  return metadata;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, bundle] = process.argv.slice(2);
    if (command === 'setup') setup();
    else if (command === 'sign' && bundle) signBundle(resolve(bundle));
    else if (command === 'verify' && bundle) console.log(verifyBundle(resolve(bundle), signingIdentity()));
    else throw new Error('Usage: node tools/mac-signing.mjs setup|sign APP|verify APP');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
