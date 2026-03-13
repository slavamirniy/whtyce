#!/usr/bin/env node
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const child_process_1 = require("child_process");
function which(cmd) {
    try {
        (0, child_process_1.execSync)(`which ${cmd} 2>/dev/null`, { encoding: 'utf-8' });
        return true;
    }
    catch {
        return false;
    }
}
function tryInstall(packages) {
    const pkg = packages.join(' ');
    if (which('apt-get')) {
        try {
            (0, child_process_1.execSync)(`apt-get install -y ${pkg} 2>/dev/null`, { stdio: 'inherit' });
            return true;
        }
        catch {
            try {
                (0, child_process_1.execSync)(`sudo apt-get install -y ${pkg}`, { stdio: 'inherit' });
                return true;
            }
            catch { }
        }
    }
    if (which('yum')) {
        try {
            (0, child_process_1.execSync)(`sudo yum install -y ${pkg}`, { stdio: 'inherit' });
            return true;
        }
        catch { }
    }
    if (which('apk')) {
        const apkPkg = packages.map(p => p === 'build-essential' ? 'build-base' : p).join(' ');
        try {
            (0, child_process_1.execSync)(`apk add --no-cache ${apkPkg}`, { stdio: 'inherit' });
            return true;
        }
        catch { }
    }
    if (which('brew')) {
        try {
            (0, child_process_1.execSync)(`brew install ${pkg}`, { stdio: 'inherit' });
            return true;
        }
        catch { }
    }
    return false;
}
const deps = [
    ['cmake', 'cmake'],
    ['make', 'build-essential'],
    ['gcc', 'build-essential'],
    ['tmux', 'tmux'],
    ['ffmpeg', 'ffmpeg'],
];
console.log('[whtyce] Checking system dependencies...');
const missing = [];
for (const [bin, pkg] of deps) {
    if (which(bin)) {
        console.log(`  ✓ ${bin}`);
    }
    else {
        console.log(`  ✗ ${bin} — missing`);
        if (!missing.includes(pkg))
            missing.push(pkg);
    }
}
if (missing.length === 0) {
    console.log('[whtyce] All dependencies OK');
}
else {
    console.log(`\n[whtyce] Installing: ${missing.join(', ')}...`);
    if (tryInstall(missing)) {
        console.log('[whtyce] Dependencies installed successfully');
    }
    else {
        console.warn('[whtyce] Could not auto-install. Please install manually:');
        console.warn(`  sudo apt install ${missing.join(' ')}`);
    }
}
