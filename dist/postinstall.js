#!/usr/bin/env node
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// Postinstall: just check and install deps silently
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
const needed = [];
if (!which('cmake'))
    needed.push('cmake');
if (!which('make') || !which('gcc'))
    needed.push('build-essential');
if (!which('tmux'))
    needed.push('tmux');
if (needed.length > 0) {
    console.log(`[whtyce] Installing: ${needed.join(', ')}...`);
    tryInstall(needed);
}
if (!which('ffmpeg'))
    tryInstall(['ffmpeg']);
