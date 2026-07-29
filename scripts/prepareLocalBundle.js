/**
 * prepareLocalBundle.js
 *
 * Prepares the local aioncore bundle from a local build output so that
 * `bun run start` / `bun run dev` uses the local aioncore binary with all
 * agents (including springboard, samsara, etc.) embedded.
 *
 * This creates `resources/bundled-aioncore/{platform}-{arch}/` with:
 *   - aioncore[.exe]
 *   - managed-resources/
 *   - manifest.json
 *
 * Resolution order:
 *   1. AIONUI_BACKEND_LOCAL_BINARY env (explicit path to aioncore binary)
 *   2. Default: ../AionCore/target/release/aioncore[.exe]
 *
 * Usage:
 *   node scripts/prepareLocalBundle.js
 *   node scripts/prepareLocalBundle.js --debug
 *   AIONUI_BACKEND_LOCAL_BINARY=/path/to/aioncore node scripts/prepareLocalBundle.js
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const RESOURCES_DIR = path.join(PROJECT_ROOT, 'resources');
const BUNDLED_DIR = path.join(RESOURCES_DIR, 'bundled-aioncore');

function getBinaryName(platform) {
  return platform === 'win32' ? 'aioncore.exe' : 'aioncore';
}

function ensureDirectory(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function removeDirectorySafe(dirPath) {
  fs.rmSync(dirPath, { recursive: true, force: true });
}

function copyFileSafe(sourcePath, targetPath) {
  ensureDirectory(path.dirname(targetPath));
  fs.copyFileSync(sourcePath, targetPath);
}

function copyDirectorySafe(sourcePath, targetPath) {
  ensureDirectory(path.dirname(targetPath));
  fs.cpSync(sourcePath, targetPath, { recursive: true, force: true });
}

function writeJson(filePath, payload) {
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
}

function resolveLocalBinary() {
  const envPath = process.env.AIONUI_BACKEND_LOCAL_BINARY;
  if (envPath && envPath.trim()) {
    const candidate = path.resolve(envPath.trim());
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
    console.warn(`  AIONUI_BACKEND_LOCAL_BINARY not found: ${candidate}`);
  }

  // Default: look for AionCore next to brainbook6
  const defaultPath = path.resolve(
    __dirname,
    '..',
    '..',
    'AionCore',
    'target',
    'release',
    getBinaryName(process.platform)
  );
  if (fs.existsSync(defaultPath) && fs.statSync(defaultPath).isFile()) {
    return defaultPath;
  }

  // Fallback: debug build
  const debugPath = path.resolve(__dirname, '..', '..', 'AionCore', 'target', 'debug', getBinaryName(process.platform));
  if (fs.existsSync(debugPath) && fs.statSync(debugPath).isFile()) {
    console.log('  Using debug build of aioncore');
    return debugPath;
  }

  return null;
}

function prepareManagedResources(binaryPath, targetDir) {
  const bundleOut = path.join(targetDir, 'managed-resources');
  const dataDir = path.join(targetDir, '.prepare-data');

  removeDirectorySafe(bundleOut);
  removeDirectorySafe(dataDir);
  ensureDirectory(bundleOut);
  ensureDirectory(dataDir);

  console.log(`  Preparing managed resources under ${path.relative(process.cwd(), bundleOut)}`);
  execSync(`"${binaryPath}" --data-dir "${dataDir}" prepare-managed-resources --bundle-out "${bundleOut}"`, {
    stdio: 'inherit',
    env: { ...process.env, AIONUI_BUNDLED_MANAGED_RESOURCES: '' },
  });

  removeDirectorySafe(dataDir);
  return bundleOut;
}

function main() {
  const isDebug = process.argv.includes('--debug');
  const platform = process.platform;
  const arch = process.arch;
  const runtimeKey = `${platform}-${arch}`;
  const binaryName = getBinaryName(platform);

  console.log(`[local-bundle] Preparing local aioncore bundle for ${runtimeKey}`);

  const binaryPath = resolveLocalBinary();
  if (!binaryPath) {
    console.error(
      `[local-bundle] aioncore binary not found. Set AIONUI_BACKEND_LOCAL_BINARY or place it at:\n` +
        `  ../AionCore/target/release/${binaryName}\n` +
        `  ../AionCore/target/debug/${binaryName}`
    );
    process.exit(1);
  }

  console.log(`  Using binary: ${binaryPath}`);

  // Clean and prepare target directory
  const targetDir = path.join(BUNDLED_DIR, runtimeKey);
  removeDirectorySafe(targetDir);
  ensureDirectory(targetDir);

  // Copy binary
  const targetBinaryPath = path.join(targetDir, binaryName);
  copyFileSafe(binaryPath, targetBinaryPath);

  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(targetBinaryPath, 0o755);
    } catch {}
  }

  // Prepare managed resources
  prepareManagedResources(targetBinaryPath, targetDir);

  // Write manifest
  const manifest = {
    platform,
    arch,
    version: 'local',
    generatedAt: new Date().toISOString(),
    sourceType: 'local-bundle',
    source: { path: binaryPath },
    files: [binaryName, 'managed-resources/'],
  };
  writeJson(path.join(targetDir, 'manifest.json'), manifest);

  console.log(`[local-bundle] Done: resources/bundled-aioncore/${runtimeKey}/`);
  console.log(`  Binary: ${path.relative(process.cwd(), targetBinaryPath)}`);
  console.log(`  Managed resources: ${path.relative(process.cwd(), path.join(targetDir, 'managed-resources'))}`);

  if (isDebug) {
    console.log('\n  Manifest:');
    console.log(JSON.stringify(manifest, null, 2));
  }
}

main();
