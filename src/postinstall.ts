#!/usr/bin/env node
// Postinstall: just check and install deps silently
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

const needed: string[] = [];
if (!which('cmake')) needed.push('cmake');
if (!which('make') || !which('gcc')) needed.push('build-essential');
if (!which('tmux')) needed.push('tmux');

if (needed.length > 0) {
  console.log(`[whtyce] Installing: ${needed.join(', ')}...`);
  tryInstall(needed);
}

if (!which('ffmpeg')) tryInstall(['ffmpeg']);
