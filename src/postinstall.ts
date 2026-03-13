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
  // Try apt (Debian/Ubuntu)
  if (which('apt-get')) {
    try {
      console.log(`[whtyce] Installing ${pkg} via apt-get...`);
      execSync(`apt-get install -y ${pkg} 2>/dev/null`, { stdio: 'inherit' });
      return true;
    } catch {
      // Try with sudo
      try {
        execSync(`sudo apt-get install -y ${pkg}`, { stdio: 'inherit' });
        return true;
      } catch {}
    }
  }
  // Try yum (RHEL/CentOS)
  if (which('yum')) {
    try {
      console.log(`[whtyce] Installing ${pkg} via yum...`);
      execSync(`sudo yum install -y ${pkg}`, { stdio: 'inherit' });
      return true;
    } catch {}
  }
  // Try apk (Alpine)
  if (which('apk')) {
    try {
      console.log(`[whtyce] Installing cmake build-base via apk...`);
      execSync(`apk add --no-cache cmake build-base`, { stdio: 'inherit' });
      return true;
    } catch {}
  }
  // Try brew (macOS)
  if (which('brew')) {
    try {
      console.log(`[whtyce] Installing cmake via brew...`);
      execSync(`brew install cmake`, { stdio: 'inherit' });
      return true;
    } catch {}
  }
  return false;
}

// Check cmake
if (!which('cmake')) {
  console.log('[whtyce] cmake not found, attempting to install build tools...');
  if (!tryInstall(['cmake', 'build-essential'])) {
    console.warn('[whtyce] Could not install cmake automatically.');
    console.warn('[whtyce] Please install cmake and build tools manually:');
    console.warn('[whtyce]   Ubuntu/Debian: sudo apt install cmake build-essential');
    console.warn('[whtyce]   macOS: brew install cmake');
    console.warn('[whtyce]   Alpine: apk add cmake build-base');
  }
}

// Check make/gcc
if (!which('make') || !which('gcc')) {
  if (which('apt-get')) {
    try {
      execSync('apt-get install -y build-essential 2>/dev/null || sudo apt-get install -y build-essential', { stdio: 'inherit' });
    } catch {}
  }
}

// Check tmux
if (!which('tmux')) {
  console.log('[whtyce] tmux not found, attempting to install...');
  if (!tryInstall(['tmux'])) {
    console.warn('[whtyce] Could not install tmux automatically.');
    console.warn('[whtyce] Please install tmux manually.');
  }
}

// Check ffmpeg (optional, for voice messages)
if (!which('ffmpeg')) {
  console.log('[whtyce] ffmpeg not found, attempting to install (needed for voice messages)...');
  tryInstall(['ffmpeg']);
}

console.log('[whtyce] Setup complete.');
