#!/usr/bin/env node
import { execSync } from 'child_process';

function which(cmd: string): boolean {
  try {
    execSync(`which ${cmd} 2>/dev/null`, { encoding: 'utf-8' });
    return true;
  } catch {
    return false;
  }
}

function tryInstall(packages: string[]): boolean {
  const pkg = packages.join(' ');
  if (which('apt-get')) {
    try {
      execSync(`apt-get install -y ${pkg} 2>/dev/null`, { stdio: 'inherit' });
      return true;
    } catch {
      try { execSync(`sudo apt-get install -y ${pkg}`, { stdio: 'inherit' }); return true; } catch {}
    }
  }
  if (which('yum')) {
    try { execSync(`sudo yum install -y ${pkg}`, { stdio: 'inherit' }); return true; } catch {}
  }
  if (which('apk')) {
    const apkPkg = packages.map(p => p === 'build-essential' ? 'build-base' : p).join(' ');
    try { execSync(`apk add --no-cache ${apkPkg}`, { stdio: 'inherit' }); return true; } catch {}
  }
  if (which('brew')) {
    try { execSync(`brew install ${pkg}`, { stdio: 'inherit' }); return true; } catch {}
  }
  return false;
}

const deps: [string, string][] = [
  ['cmake', 'cmake'],
  ['make', 'build-essential'],
  ['gcc', 'build-essential'],
  ['tmux', 'tmux'],
  ['ffmpeg', 'ffmpeg'],
];

console.log('[whtyce] Checking system dependencies...');
const missing: string[] = [];
for (const [bin, pkg] of deps) {
  if (which(bin)) {
    console.log(`  ✓ ${bin}`);
  } else {
    console.log(`  ✗ ${bin} — missing`);
    if (!missing.includes(pkg)) missing.push(pkg);
  }
}

if (missing.length === 0) {
  console.log('[whtyce] All dependencies OK');
} else {
  console.log(`\n[whtyce] Installing: ${missing.join(', ')}...`);
  if (tryInstall(missing)) {
    console.log('[whtyce] Dependencies installed successfully');
  } else {
    console.warn('[whtyce] Could not auto-install. Please install manually:');
    console.warn(`  sudo apt install ${missing.join(' ')}`);
  }
}
