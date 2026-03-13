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

// --- Whisper model name normalization ---

function normalizeWhisperModel(model?: string): string {
  if (!model) return '';
  // Convert old Xenova format like "Xenova/whisper-base" to just "base"
  const match = model.match(/whisper-(\w+)/);
  if (match) return match[1];
  return model;
}

async function downloadWithProgress(url: string, dest: string): Promise<void> {
  const resp = await fetch(url, { redirect: 'follow' });
  if (!resp.ok) throw new Error(`Download failed: ${resp.status}`);
  const total = parseInt(resp.headers.get('content-length') || '0', 10);
  const dir = path.dirname(dest);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const fileStream = fs.createWriteStream(dest + '.tmp');
  const reader = resp.body as any;
  let downloaded = 0;
  let lastLog = 0;

  for await (const chunk of reader) {
    fileStream.write(chunk);
    downloaded += chunk.length;
    const now = Date.now();
    if (total && now - lastLog > 500) {
      const pct = Math.round(downloaded / total * 100);
      const mb = (downloaded / 1024 / 1024).toFixed(1);
      const totalMb = (total / 1024 / 1024).toFixed(1);
      process.stdout.write(`\r[whisper] Downloading model... ${pct}% (${mb}/${totalMb} MB)`);
      lastLog = now;
    }
  }
  fileStream.end();
  await new Promise<void>((resolve, reject) => {
    fileStream.on('finish', resolve);
    fileStream.on('error', reject);
  });
  fs.renameSync(dest + '.tmp', dest);
  if (total) console.log(`\r[whisper] Downloaded ${(total / 1024 / 1024).toFixed(1)} MB                `);
}

function runWithProgress(cmd: string, args: string[], cwd: string, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let lastLog = 0;

    const onData = (data: Buffer) => {
      const text = data.toString();
      const now = Date.now();
      const pctMatch = text.match(/\[\s*(\d+)%\]/);
      if (pctMatch) {
        process.stdout.write(`\r[whisper] ${label}... ${pctMatch[1]}%`);
      } else if (now - lastLog > 2000) {
        process.stdout.write(`\r[whisper] ${label}...`);
        lastLog = now;
      }
    };

    proc.stdout?.on('data', onData);
    proc.stderr?.on('data', onData);
    proc.on('close', (code) => {
      process.stdout.write('\n');
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited with code ${code}`));
    });
    proc.on('error', reject);
  });
}

async function installWhisperModel(modelName: string): Promise<boolean> {
  try {
    const constants = await import('nodejs-whisper/dist/constants');
    const whisperCppPath = constants.WHISPER_CPP_PATH;
    const modelFile = (constants.MODEL_OBJECT as Record<string, string>)[modelName];
    if (!modelFile) {
      console.error(`[whisper] Unknown model: ${modelName}`);
      return false;
    }

    const modelsDir = path.join(whisperCppPath, 'models');
    const modelPath = path.join(modelsDir, modelFile);
    const execPath = path.join(whisperCppPath, 'build', 'bin', 'whisper-cli');

    // Download model if needed
    if (!fs.existsSync(modelPath)) {
      const url = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${modelFile}`;
      console.log(`[whisper] Downloading ${modelName} model...`);
      await downloadWithProgress(url, modelPath);
    } else {
      console.log(`[whisper] Model "${modelName}" already downloaded`);
    }

    // Build whisper.cpp if needed
    if (!fs.existsSync(execPath)) {
      console.log('[whisper] Building whisper.cpp...');
      await runWithProgress('cmake', ['-B', 'build'], whisperCppPath, 'Configuring');
      await runWithProgress('cmake', ['--build', 'build', '--config', 'Release'], whisperCppPath, 'Compiling');
      console.log('[whisper] Build complete');
    } else {
      console.log('[whisper] whisper.cpp already built');
    }

    return true;
  } catch (err: any) {
    console.error(`[whisper] Failed: ${err.message}`);
    return false;
  }
}

// --- Commands ---

async function cmdInstall() {
  console.log('[whtyce] Checking system dependencies...');
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
  if (missing.length > 0) {
    console.log(`\n[whtyce] Installing: ${missing.join(', ')}...`);
    if (!tryInstall(missing)) {
      console.error('[whtyce] Some dependencies could not be installed.');
      console.error(`[whtyce] Try manually: sudo apt install ${missing.join(' ')}`);
      process.exit(1);
    }
  }
  console.log('[whtyce] System dependencies OK\n');

  // Install whisper model
  const saved = loadSavedConfig();
  const whisperModel = normalizeWhisperModel(saved.whisperModel) || 'base';
  console.log('[whtyce] Preparing whisper voice recognition...');
  await installWhisperModel(whisperModel);
  console.log('[whtyce] All done!');
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

  // Pre-install whisper model in foreground so user sees progress
  const args = parseArgs(argv);
  const saved = loadSavedConfig();
  const whisperEnabled = args.noWhisper ? false : (saved.whisperEnabled !== undefined ? saved.whisperEnabled : true);
  const whisperModel = normalizeWhisperModel(saved.whisperModel) || process.env.WHISPER_MODEL || 'base';

  if (whisperEnabled) {
    await installWhisperModel(whisperModel);
  }

  const port = args.port ? parseInt(args.port as string, 10) : (saved.port || await findFreePort(8075));
  const secret = (args.secret as string) || saved.secret || crypto.randomBytes(8).toString('hex');

  // Save secret for reuse
  if (!saved.secret) {
    saved.secret = secret;
    saveConfig(saved as any);
  }

  // Ensure log dir
  if (!fs.existsSync(WHTYCE_DIR)) fs.mkdirSync(WHTYCE_DIR, { recursive: true });

  // Truncate log file for fresh start
  fs.writeFileSync(LOG_FILE, '');

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

  // Wait for server to be ready, tailing logs in the meantime
  console.log('[whtyce] Starting daemon...');
  const healthUrl = `http://127.0.0.1:${port}/health`;
  let ready = false;
  let logOffset = 0;

  for (let i = 0; i < 120; i++) {
    await new Promise(r => setTimeout(r, 500));

    // Show new log lines
    try {
      const logContent = fs.readFileSync(LOG_FILE, 'utf-8');
      if (logContent.length > logOffset) {
        const newContent = logContent.substring(logOffset);
        process.stdout.write(newContent);
        logOffset = logContent.length;
      }
    } catch {}

    // Check if daemon died
    if (!isRunning(child.pid!)) {
      console.error('\n[whtyce] Daemon exited unexpectedly. Check: whtyce logs');
      clearState();
      process.exit(1);
    }

    // Check health
    try {
      const resp = await fetch(healthUrl);
      if (resp.ok) { ready = true; break; }
    } catch {}
  }

  // Flush remaining logs
  try {
    const logContent = fs.readFileSync(LOG_FILE, 'utf-8');
    if (logContent.length > logOffset) {
      process.stdout.write(logContent.substring(logOffset));
    }
  } catch {}

  if (ready) {
    console.log(`\n[whtyce] Ready! ${url}`);
  } else {
    console.error('\n[whtyce] Timeout waiting for server. Check: whtyce logs');
  }
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
    whisperEnabled: args.noWhisper ? false : (saved.whisperEnabled !== undefined ? saved.whisperEnabled : true),
    whisperModel: normalizeWhisperModel(saved.whisperModel) || process.env.WHISPER_MODEL || 'base',
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
      await cmdInstall();
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
