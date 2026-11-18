import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { cp, chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const run = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const nodeVersion = '22.23.5';
const triple = 'aarch64-apple-darwin';
const binary = join(root, 'src-tauri/binaries', `node-${triple}`);
const resources = join(root, 'src-tauri/resources/sidecar');
const sdkSource = join(root, 'node_modules/@recallai/desktop-sdk');
const uuidSource = join(root, 'node_modules/uuid');

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  throw new Error('This sample prepares a Tauri sidecar for Apple Silicon macOS only.');
}

async function exists(path) {
  try { await stat(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function prepareNode() {
  if (await exists(binary)) {
    const { stdout } = await run(binary, ['--version']);
    if (stdout.trim() === `v${nodeVersion}`) return;
  }

  const archiveName = `node-v${nodeVersion}-darwin-arm64.tar.gz`;
  const baseUrl = `https://nodejs.org/dist/v${nodeVersion}`;
  const sumsResponse = await fetch(`${baseUrl}/SHASUMS256.txt`, { signal: AbortSignal.timeout(30_000) });
  if (!sumsResponse.ok) throw new Error(`Node checksum download failed: HTTP ${sumsResponse.status}`);
  const checksumLine = (await sumsResponse.text()).split('\n').find((line) => line.endsWith(`  ${archiveName}`));
  if (!checksumLine) throw new Error(`Node release did not list ${archiveName}`);
  const expectedHash = checksumLine.split(' ')[0];

  const temporary = await mkdtemp(join(tmpdir(), 'recall-tauri-node-'));
  try {
    const archive = join(temporary, archiveName);
    const response = await fetch(`${baseUrl}/${archiveName}`, { signal: AbortSignal.timeout(180_000) });
    if (!response.ok || !response.body) throw new Error(`Node download failed: HTTP ${response.status}`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(archive));
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(archive)) hash.update(chunk);
    if (hash.digest('hex') !== expectedHash) throw new Error('Node archive checksum did not match SHASUMS256.txt');

    await run('tar', ['-xzf', archive, '-C', temporary, `node-v${nodeVersion}-darwin-arm64/bin/node`]);
    await mkdir(dirname(binary), { recursive: true });
    await copyFile(join(temporary, `node-v${nodeVersion}-darwin-arm64/bin/node`), binary);
    await chmod(binary, 0o755);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function prepareSdk() {
  const sdkPackage = JSON.parse(await readFile(join(sdkSource, 'package.json'), 'utf8'));
  // The SDK's runtime entry uses uuid. Its tar dependency is only used by setup.js.
  const dependencies = Object.keys(sdkPackage.dependencies ?? {}).sort();
  if (dependencies.join(',') !== 'tar,uuid') {
    throw new Error(`Review SDK runtime dependencies before packaging: ${dependencies.join(', ')}`);
  }
  if (!(await exists(join(sdkSource, 'desktop_sdk_macos_exe')))) {
    throw new Error('Recall SDK native binary is missing. Run npm ci first.');
  }
  const stagedPackage = join(resources, 'node_modules/@recallai/desktop-sdk/package.json');
  const stagedVersion = await exists(stagedPackage)
    ? JSON.parse(await readFile(stagedPackage, 'utf8')).version
    : null;
  if (stagedVersion !== sdkPackage.version || !(await exists(join(resources, 'node_modules/uuid/package.json')))) {
    await rm(resources, { recursive: true, force: true });
    await mkdir(join(resources, 'node_modules/@recallai'), { recursive: true });
    await cp(sdkSource, join(resources, 'node_modules/@recallai/desktop-sdk'), { recursive: true });
    await cp(uuidSource, join(resources, 'node_modules/uuid'), { recursive: true });
  }
  await copyFile(join(root, 'sidecar/index.cjs'), join(resources, 'index.cjs'));
}

await prepareNode();
await prepareSdk();
console.log(`Tauri sidecar ready: Node v${nodeVersion}, Recall SDK resources staged`);
