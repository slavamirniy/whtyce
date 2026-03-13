#!/usr/bin/env node

import { startServer, ServerConfig, loadSavedConfig, saveConfig } from './server';
import crypto from 'crypto';
import net from 'net';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync, spawn } from 'child_process';

const WHTYCE_DIR = path.join(os.homedir(), '.whtyce');
const PID_FILE = path.join(WHTYCE_DIR, 'daemon.pid');
const LOG_FILE = path.join(WHTYCE_DIR, 'whtyce.log');
const STATE_FILE = path.join(WHTYCE_DIR, 'state.json');

// --- Helpers ---

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
      try {
        execSync(`sudo apt-get install -y ${pkg}`, { stdio: 'inherit' });
        return true;
      } catch {}
    }
  }
  if (which('yum')) {
    try {
      execSync(`sudo yum install -y ${pkg}`, { stdio: 'inherit' });
      return true;
    } catch {}
  }
  if (which('apk')) {
    try {
      const apkPkg = packages.map(p => p === 'build-essential' ? 'build-base' : p).join(' ');
      execSync(`apk add --no-cache ${apkPkg}`, { stdio: 'inherit' });
      return true;
    } catch {}
  }
  if (which('brew')) {
    try {
      execSync(`brew install ${pkg}`, { stdio: 'inherit' });
      return true;
    } catch {}
  }
  return false;
}

function ensureDeps(): boolean {
  let ok = true;
  const needed: string[] = [];

  if (!which('cmake')) needed.push('cmake');
  if (!which('make') || !which('gcc')) needed.push('build-essential');
  if (!which('tmux')) needed.push('tmux');

  if (needed.length > 0) {
    console.log(`[whtyce] Installing: ${needed.join(', ')}...`);
    if (!tryInstall(needed)) {
      console.error(`[whtyce] Failed to install: ${needed.join(', ')}`);
      console.error('[whtyce] Install manually: sudo apt install cmake build-essential tmux');
      ok = false;
    }
  }

  if (!which('ffmpeg')) {
    console.log('[whtyce] Installing ffmpeg...');
    tryInstall(['ffmpeg']);
  }

  return ok;
}

function findFreePort(startPort: number): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.on('error', () => resolve(findFreePort(startPort + 1)));
    server.listen(startPort, '0.0.0.0', () => {
      const addr = server.address() as net.AddressInfo;
      server.close(() => resolve(addr.port));
    });
  });
}

function getExternalIP(): string {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
}

function readState(): { pid?: number; port?: number; secret?: string; url?: string } {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    }
  } catch {}
  return {};
}

function writeState(state: { pid: number; port: number; secret: string; url: string }) {
  if (!fs.existsSync(WHTYCE_DIR)) fs.mkdirSync(WHTYCE_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function clearState() {
  try { fs.unlinkSync(STATE_FILE); } catch {}
  try { fs.unlinkSync(PID_FILE); } catch {}
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function getDaemonPid(): number | null {
  const state = readState();
  if (state.pid && isRunning(state.pid)) return state.pid;
  clearState();
  return null;
}

// --- Commands ---

function cmdInstall() {
  console.log('[whtyce] Checking dependencies...');
  const deps = [
    ['cmake', 'cmake'],
    ['make', 'build-essential'],
    ['gcc', 'build-essential'],
    ['tmux', 'tmux'],
    ['ffmpeg', 'ffmpeg'],
  ];
  const missing: string[] = [];
  for (const [bin, pkg] of deps) {
    if (which(bin)) {
      console.log(`  ✓ ${bin}`);
    } else {
      console.log(`  ✗ ${bin}`);
      if (!missing.includes(pkg)) missing.push(pkg);
    }
  }
  if (missing.length === 0) {
    console.log('[whtyce] All dependencies installed.');
    return;
  }
  console.log(`\n[whtyce] Installing: ${missing.join(', ')}...`);
  if (tryInstall(missing)) {
    console.log('[whtyce] All dependencies installed.');
  } else {
    console.error('[whtyce] Some dependencies could not be installed.');
    console.error(`[whtyce] Try manually: sudo apt install ${missing.join(' ')}`);
    process.exit(1);
  }
}

async function cmdStart(argv: string[]) {
  // Check if already running
  const existingPid = getDaemonPid();
  if (existingPid) {
    const state = readState();
    console.log(state.url || `http://${getExternalIP()}:${state.port}/s/${state.secret}/`);
    return;
  }

  // Ensure deps
  ensureDeps();

  // Parse extra args
  const args = parseArgs(argv);
  const saved = loadSavedConfig();
  const port = args.port ? parseInt(args.port as string, 10) : (saved.port || await findFreePort(8075));
  const secret = (args.secret as string) || saved.secret || crypto.randomBytes(8).toString('hex');

  // Save secret for reuse
  if (!saved.secret) {
    saved.secret = secret;
    saveConfig(saved as any);
  }

  // Ensure log dir
  if (!fs.existsSync(WHTYCE_DIR)) fs.mkdirSync(WHTYCE_DIR, { recursive: true });

  // Spawn daemon
  const logFd = fs.openSync(LOG_FILE, 'a');
  const child = spawn(process.execPath, [__filename, '__daemon__', String(port), secret, ...argv], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env, WHTYCE_DAEMON: '1' },
  });

  const url = `http://${getExternalIP()}:${port}/s/${secret}/`;
  writeState({ pid: child.pid!, port, secret, url });
  child.unref();
  fs.closeSync(logFd);

  console.log(url);
}

function cmdStop() {
  const pid = getDaemonPid();
  if (!pid) {
    console.log('[whtyce] Not running.');
    return;
  }
  try {
    process.kill(pid, 'SIGTERM');
    console.log(`[whtyce] Stopped (pid ${pid}).`);
  } catch {
    console.log('[whtyce] Process already gone.');
  }
  clearState();
}

function cmdLogs() {
  if (!fs.existsSync(LOG_FILE)) {
    console.log('[whtyce] No logs yet.');
    return;
  }
  // Tail last 100 lines
  try {
    const content = execSync(`tail -100 ${JSON.stringify(LOG_FILE)}`, { encoding: 'utf-8' });
    process.stdout.write(content);
  } catch {
    process.stdout.write(fs.readFileSync(LOG_FILE, 'utf-8'));
  }
}

async function cmdDaemon(port: number, secret: string, argv: string[]) {
  const args = parseArgs(argv);
  const saved = loadSavedConfig();

  const config: ServerConfig = {
    port,
    secret,
    tgBotToken: (args.tgToken as string) || saved.tgBotToken || process.env.TG_BOT_TOKEN || '',
    tgUserId: args.tgUser
      ? parseInt(args.tgUser as string, 10)
      : (saved.tgUserId || (process.env.TG_USER_ID ? parseInt(process.env.TG_USER_ID, 10) : 0)),
    whisperEnabled: args.noWhisper ? false : (saved.whisperEnabled !== undefined ? saved.whisperEnabled : false),
    whisperModel: saved.whisperModel || process.env.WHISPER_MODEL || 'base',
    tmuxSession: saved.tmuxSession || process.env.TMUX_SESSION || 'whtyce',
    threadsEnabled: args.threads ? true : (saved.threadsEnabled || false),
  };

  process.on('uncaughtException', (err) => {
    console.error('[crash] Uncaught exception:', err.message);
    console.error(err.stack);
  });
  process.on('unhandledRejection', (reason: any) => {
    console.error('[crash] Unhandled rejection:', reason?.message || reason);
  });
  process.on('SIGTERM', () => {
    console.log('[whtyce] Shutting down...');
    clearState();
    process.exit(0);
  });

  startServer(config);
}

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === '--no-whisper') args.noWhisper = true;
    else if (arg === '--threads') args.threads = true;
    else if ((arg === '-p' || arg === '--port') && argv[i + 1]) args.port = argv[++i];
    else if ((arg === '-s' || arg === '--secret') && argv[i + 1]) args.secret = argv[++i];
    else if ((arg === '-t' || arg === '--tg-token') && argv[i + 1]) args.tgToken = argv[++i];
    else if ((arg === '-u' || arg === '--tg-user') && argv[i + 1]) args.tgUser = argv[++i];
    i++;
  }
  return args;
}

function printHelp() {
  console.log(`
  whtyce - mobile terminal with voice input

  Commands:
    whtyce start [options]  Start whtyce in background, print URL
    whtyce stop             Stop background process
    whtyce logs             Show recent logs
    whtyce install          Install system dependencies (tmux, cmake, etc.)

  Options (for start):
    -p, --port <port>       Port (default: auto)
    -s, --secret <secret>   URL secret (default: random, saved)
    -t, --tg-token <token>  Telegram bot token
    -u, --tg-user <id>      Telegram user ID
    --threads               Enable Telegram forum topics
    --no-whisper            Disable voice input

  Settings are saved to ~/.whtyce/config.json
  `);
}

// --- Main ---

async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0];

  // Internal daemon mode
  if (command === '__daemon__') {
    const port = parseInt(argv[1], 10);
    const secret = argv[2];
    await cmdDaemon(port, secret, argv.slice(3));
    return;
  }

  switch (command) {
    case 'install':
      cmdInstall();
      break;
    case 'start':
      await cmdStart(argv.slice(1));
      break;
    case 'stop':
      cmdStop();
      break;
    case 'logs':
      cmdLogs();
      break;
    case '-h':
    case '--help':
    case 'help':
      printHelp();
      break;
    default:
      // No subcommand = start
      await cmdStart(argv);
      break;
  }
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
