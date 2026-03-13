import express from 'express';
import http from 'http';
import WebSocket from 'ws';
import path from 'path';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import { execSync, spawn, ChildProcess } from 'child_process';
import { TmateTelegramBot } from './telegram';

export interface ServerConfig {
  port: number;
  secret: string;
  tgBotToken: string;
  tgUserId: number;
  whisperEnabled: boolean;
  whisperModel: string;
  tmuxSession: string;
  threadsEnabled: boolean;
}

export interface SavedConfig {
  tgBotToken?: string;
  tgUserId?: number;
  threadsEnabled?: boolean;
  whisperEnabled?: boolean;
  whisperModel?: string;
  tmuxSession?: string;
  port?: number;
  secret?: string;
  threadIds?: Record<string, number>;
}

const CONFIG_DIR = path.join(os.homedir(), '.whtyce');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

export function loadSavedConfig(): SavedConfig {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    }
  } catch {}
  return {};
}

export function saveConfig(saved: SavedConfig) {
  try {
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(saved, null, 2));
  } catch (err: any) {
    console.error('[config] Failed to save:', err.message);
  }
}

export function startServer(config: ServerConfig) {
  const { port, secret } = config;
  let tmuxSession = config.tmuxSession;

  // --- Whisper (nodejs-whisper / whisper.cpp) ---
  let whisperLoading = false;
  let whisperReady = false;

  async function loadWhisper() {
    if (!config.whisperEnabled) return;
    if (whisperLoading || whisperReady) return;
    whisperLoading = true;

    try {
      const constants = await import('nodejs-whisper/dist/constants');
      const whisperCppPath = constants.WHISPER_CPP_PATH;
      const modelFile = (constants.MODEL_OBJECT as Record<string, string>)[config.whisperModel];
      if (!modelFile) throw new Error(`Unknown model: ${config.whisperModel}`);

      const modelsDir = path.join(whisperCppPath, 'models');
      const modelPath = path.join(modelsDir, modelFile);
      const execPath = path.join(whisperCppPath, 'build', 'bin', 'whisper-cli');

      // Step 1: Download model if needed
      if (!fs.existsSync(modelPath)) {
        const url = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${modelFile}`;
        console.log(`[whisper] Downloading ${config.whisperModel} model...`);
        await downloadWithProgress(url, modelPath);
      } else {
        console.log(`[whisper] Model "${config.whisperModel}" already downloaded`);
      }

      // Step 2: Build whisper.cpp if needed
      if (!fs.existsSync(execPath)) {
        console.log('[whisper] Building whisper.cpp...');
        await runWithProgress('cmake', ['-B', 'build'], whisperCppPath, 'Configuring');
        await runWithProgress('cmake', ['--build', 'build', '--config', 'Release'], whisperCppPath, 'Compiling');
      } else {
        console.log('[whisper] whisper.cpp already built');
      }

      whisperReady = true;
      console.log('[whisper] Ready');
    } catch (err: any) {
      console.error('[whisper] Failed to load:', err.message);
      whisperLoading = false;
    }
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
      if (total && now - lastLog > 1000) {
        const pct = Math.round(downloaded / total * 100);
        const mb = (downloaded / 1024 / 1024).toFixed(1);
        const totalMb = (total / 1024 / 1024).toFixed(1);
        process.stdout.write(`\r[whisper] Downloading... ${pct}% (${mb}/${totalMb} MB)`);
        lastLog = now;
      }
    }
    fileStream.end();
    await new Promise<void>((resolve, reject) => {
      fileStream.on('finish', resolve);
      fileStream.on('error', reject);
    });
    fs.renameSync(dest + '.tmp', dest);
    if (total) console.log(`\r[whisper] Downloaded ${(total / 1024 / 1024).toFixed(1)} MB`);
  }

  function runWithProgress(cmd: string, args: string[], cwd: string, label: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
      let lastLog = 0;
      let lines = 0;

      const onData = (data: Buffer) => {
        const text = data.toString();
        lines += text.split('\n').length - 1;
        const now = Date.now();
        // Parse cmake build progress like [  5%]
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

  loadWhisper();

  function stripTimestamps(text: string): string {
    return text.replace(/\[\d{2}:\d{2}:\d{2}\.\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}\.\d{3}\]\s*/g, '').trim();
  }

  async function transcribeAudio(wavPath: string): Promise<string> {
    const { nodewhisper } = await import('nodejs-whisper');
    const result = await nodewhisper(wavPath, {
      modelName: config.whisperModel,
      whisperOptions: { outputInText: true },
      logger: { debug: () => {}, error: console.error, log: () => {} },
    });
    return stripTimestamps(result || '');
  }

  // --- Tmux ---
  function ensureTmuxSession() {
    try {
      execSync(`tmux kill-session -t ${tmuxSession} 2>/dev/null`);
    } catch {}
    execSync(`tmux new-session -d -s ${tmuxSession} -x 120 -y 40 -c "${process.cwd()}"`);
  }

  function killTmuxSession() {
    try {
      execSync(`tmux kill-session -t ${tmuxSession} 2>/dev/null`);
    } catch {}
  }

  function tmuxSendKeys(keys: string) {
    const child = spawn('tmux', ['send-keys', '-t', tmuxSession, '-l', keys]);
    child.on('error', () => {});
  }

  function tmuxSendSpecial(key: string) {
    const allowed = new Set([
      'Enter', 'Tab', 'Escape', 'Up', 'Down', 'Left', 'Right',
      'Home', 'End', 'BSpace', 'DC', 'PageUp', 'PageDown',
    ]);
    if (allowed.has(key) || /^C-[a-z]$/.test(key)) {
      const child = spawn('tmux', ['send-keys', '-t', tmuxSession, key]);
      child.on('error', () => {});
    }
  }

  function tmuxResize(cols: number, rows: number) {
    const c = Math.max(1, Math.min(500, Math.floor(cols)));
    const r = Math.max(1, Math.min(200, Math.floor(rows)));
    try {
      execSync(`tmux resize-window -t ${tmuxSession} -x ${c} -y ${r} 2>/dev/null`);
    } catch {}
  }

  function tmuxCapture(): string {
    try {
      return execSync(`tmux capture-pane -t ${tmuxSession} -p -e`, {
        encoding: 'utf-8',
        maxBuffer: 1024 * 1024,
      });
    } catch {
      return '';
    }
  }

  // --- Streamer ---
  class TmuxStreamer {
    private pipeProc: ChildProcess | null = null;
    private clients = new Set<WebSocket>();
    private lastContent = '';
    private pollInterval: NodeJS.Timeout | null = null;

    start() {
      ensureTmuxSession();
      this.startPolling();
    }

    private startPolling() {
      this.pollInterval = setInterval(() => {
        if (this.clients.size === 0) return;
        const content = tmuxCapture();
        if (content !== this.lastContent) {
          this.lastContent = content;
          const msg = JSON.stringify({ type: 'screen', data: content });
          this.clients.forEach(ws => {
            if (ws.readyState === WebSocket.OPEN) ws.send(msg);
          });
        }
      }, 50);
    }

    addClient(ws: WebSocket) {
      this.clients.add(ws);
      const content = tmuxCapture();
      if (content) ws.send(JSON.stringify({ type: 'screen', data: content }));
    }

    removeClient(ws: WebSocket) { this.clients.delete(ws); }

    stop() {
      if (this.pollInterval) clearInterval(this.pollInterval);
      if (this.pipeProc) this.pipeProc.kill();
    }
  }

  const streamer = new TmuxStreamer();

  // --- Express ---
  const app = express();
  const server = http.createServer(app);
  const SESSION_PATH = `/s/${secret}`;

  function authCheck(req: express.Request, res: express.Response, next: express.NextFunction): void {
    if (req.path.startsWith(SESSION_PATH) || req.path.startsWith('/api/' + secret)) {
      next();
    } else if (req.path === '/health') {
      next();
    } else {
      res.status(403).send('Forbidden');
    }
  }

  app.use(authCheck);
  app.use(express.json({ limit: '50mb' }));
  app.use(SESSION_PATH, express.static(path.join(__dirname, '..', 'public')));

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', whisper: whisperReady });
  });

  // --- Config API ---
  app.get(`/api/${secret}/config`, (_req, res) => {
    res.json({
      tgBotToken: config.tgBotToken || '',
      tgUserId: config.tgUserId || 0,
      threadsEnabled: config.threadsEnabled,
      whisperEnabled: config.whisperEnabled,
      whisperModel: config.whisperModel,
      tmuxSession: config.tmuxSession,
      // Status info
      whisperReady,
      whisperLoading,
      tgActive: tgBot !== null,
      tgConnected: tgBot?.isConnected() ?? false,
      tgCode: tgBot?.getAccessCode() ?? null,
      tgBotUsername: tgBot?.getBotUsername() ?? null,
    });
  });

  app.post(`/api/${secret}/config`, (req, res) => {
    const body = req.body;
    const saved = loadSavedConfig();
    let tgRestart = false;

    // Telegram settings
    if (body.tgBotToken !== undefined) {
      const newToken = String(body.tgBotToken || '').trim();
      if (newToken !== config.tgBotToken) {
        config.tgBotToken = newToken;
        saved.tgBotToken = newToken;
        tgRestart = true;
      }
    }
    if (body.tgUserId !== undefined) {
      const newId = parseInt(body.tgUserId, 10) || 0;
      if (newId !== config.tgUserId) {
        config.tgUserId = newId;
        saved.tgUserId = newId;
        tgRestart = true;
      }
    }
    if (body.threadsEnabled !== undefined) {
      const newVal = !!body.threadsEnabled;
      if (newVal !== config.threadsEnabled) {
        config.threadsEnabled = newVal;
        saved.threadsEnabled = newVal;
        tgRestart = true;
      }
    }

    // Whisper settings (saved for next restart)
    if (body.whisperEnabled !== undefined) {
      config.whisperEnabled = !!body.whisperEnabled;
      saved.whisperEnabled = config.whisperEnabled;
      if (config.whisperEnabled && !whisperReady && !whisperLoading) {
        loadWhisper();
      }
    }
    if (body.whisperModel !== undefined) {
      const newModel = String(body.whisperModel).trim();
      if (newModel && newModel !== config.whisperModel) {
        config.whisperModel = newModel;
        saved.whisperModel = newModel;
        // Model change requires restart to take effect
      }
    }

    // Tmux session
    if (body.tmuxSession !== undefined) {
      const newSession = String(body.tmuxSession).trim();
      if (newSession && newSession !== config.tmuxSession) {
        config.tmuxSession = newSession;
        saved.tmuxSession = newSession;
        tmuxSession = newSession;
        tgRestart = true;
      }
    }

    // Save to disk
    saveConfig(saved);

    // Restart telegram bot if needed
    if (tgRestart) {
      if (tgBot) { tgBot.stop(); tgBot = null; }
      if (config.tgBotToken) {
        try {
          tgBot = new TmateTelegramBot({
            token: config.tgBotToken,
            tmuxSession: config.tmuxSession,
            transcribeAudio: transcribeAudio,
            isWhisperReady: () => whisperReady,
            autoAuthUserId: config.tgUserId || undefined,
            threadsEnabled: config.threadsEnabled,
            onUserAuthorized: (userId) => {
              config.tgUserId = userId;
              const s = loadSavedConfig();
              s.tgUserId = userId;
              saveConfig(s);
              console.log(`[config] Saved authorized user ID: ${userId}`);
            },
            onThreadsChanged: (threadIds) => {
              const s = loadSavedConfig();
              s.threadIds = threadIds;
              saveConfig(s);
            },
            savedThreadIds: loadSavedConfig().threadIds,
          });
          console.log(`[telegram] Bot restarted, code: ${tgBot.getAccessCode()}`);
        } catch (err: any) {
          console.error('[telegram] Failed to start bot:', err.message);
        }
      }
    }

    // Return updated state
    res.json({
      ok: true,
      tgBotToken: config.tgBotToken,
      tgUserId: config.tgUserId,
      threadsEnabled: config.threadsEnabled,
      whisperEnabled: config.whisperEnabled,
      whisperModel: config.whisperModel,
      tmuxSession: config.tmuxSession,
      whisperReady,
      whisperLoading,
      tgActive: tgBot !== null,
      tgConnected: tgBot?.isConnected() ?? false,
      tgCode: tgBot?.getAccessCode() ?? null,
      tgBotUsername: tgBot?.getBotUsername() ?? null,
    });
  });

  // --- Whisper status ---
  app.get(`/api/${secret}/whisper-status`, (_req, res) => {
    res.json({ ready: whisperReady, loading: whisperLoading });
  });

  app.post(`/api/${secret}/transcribe`, async (req, res) => {
    if (!whisperReady) {
      res.status(503).json({ error: 'Whisper model is still loading.' });
      return;
    }
    const audioData = req.body.audio;
    if (!audioData) {
      res.status(400).json({ error: 'No audio data' });
      return;
    }
    try {
      const buffer = Buffer.from(audioData, 'base64');
      const wavPath = path.join(os.tmpdir(), `whtyce_web_${Date.now()}.wav`);
      fs.writeFileSync(wavPath, buffer);

      const { nodewhisper } = await import('nodejs-whisper');
      const result = await nodewhisper(wavPath, {
        modelName: config.whisperModel,
        whisperOptions: { outputInText: true },
        logger: { debug: () => {}, error: console.error, log: () => {} },
      });
      const text = stripTimestamps(result || '');
      try { fs.unlinkSync(wavPath); } catch {}
      console.log(`[whisper] "${text.substring(0, 80)}${text.length > 80 ? '...' : ''}"`);
      res.json({ text });
    } catch (err: any) {
      console.error('[whisper] Error:', err.message);
      res.status(500).json({ error: 'Transcription failed', details: err.message });
    }
  });

  // --- Telegram Bot ---
  let tgBot: TmateTelegramBot | null = null;

  app.get(`/api/${secret}/telegram/status`, (_req, res) => {
    res.json({
      active: tgBot !== null,
      connected: tgBot?.isConnected() ?? false,
      code: tgBot?.getAccessCode() ?? null,
      botUsername: tgBot?.getBotUsername() ?? null,
    });
  });

  app.post(`/api/${secret}/telegram/setup`, (req, res) => {
    const { token } = req.body;
    if (!token || typeof token !== 'string' || token.trim().length < 10) {
      res.status(400).json({ error: 'Invalid bot token' });
      return;
    }
    if (tgBot) { tgBot.stop(); tgBot = null; }
    try {
      tgBot = new TmateTelegramBot({
        token: token.trim(),
        tmuxSession,
        transcribeAudio: transcribeAudio,
        isWhisperReady: () => whisperReady,
        autoAuthUserId: config.tgUserId || undefined,
        threadsEnabled: config.threadsEnabled,
        onUserAuthorized: (userId) => {
          config.tgUserId = userId;
          const s = loadSavedConfig();
          s.tgUserId = userId;
          saveConfig(s);
          console.log(`[config] Saved authorized user ID: ${userId}`);
        },
        onThreadsChanged: (threadIds) => {
          const s = loadSavedConfig();
          s.threadIds = threadIds;
          saveConfig(s);
        },
        savedThreadIds: loadSavedConfig().threadIds,
      });
      const code = tgBot.getAccessCode();
      console.log(`[telegram] Bot started, code: ${code}`);
      res.json({ ok: true, code });
    } catch (err: any) {
      console.error('[telegram] Failed to start bot:', err.message);
      res.status(500).json({ error: 'Failed to start bot: ' + err.message });
    }
  });

  app.post(`/api/${secret}/telegram/disconnect`, (_req, res) => {
    if (tgBot) { tgBot.stop(); tgBot = null; }
    res.json({ ok: true });
  });

  // --- WebSocket ---
  const wss = new WebSocket.Server({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url || '', `http://${request.headers.host}`);
    if (url.pathname !== `/ws/${secret}`) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  });

  wss.on('connection', (ws: WebSocket) => {
    streamer.addClient(ws);
    ws.on('message', (msg: WebSocket.Data) => {
      try {
        const parsed = JSON.parse(msg.toString());
        switch (parsed.type) {
          case 'input':
            if (typeof parsed.data === 'string') tmuxSendKeys(parsed.data);
            break;
          case 'special':
            if (typeof parsed.data === 'string') tmuxSendSpecial(parsed.data);
            break;
          case 'resize':
            if (typeof parsed.cols === 'number' && typeof parsed.rows === 'number') {
              tmuxResize(parsed.cols, parsed.rows);
            }
            break;
          case 'ping':
            ws.send(JSON.stringify({ type: 'pong' }));
            break;
        }
      } catch {}
    });
    ws.on('close', () => { streamer.removeClient(ws); });
    ws.send(JSON.stringify({ type: 'ready' }));
  });

  // --- Helpers ---
  function getExternalIP(): string {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name] || []) {
        if (iface.family === 'IPv4' && !iface.internal) return iface.address;
      }
    }
    return 'localhost';
  }

  // --- Start Telegram if token provided ---
  if (config.tgBotToken) {
    tgBot = new TmateTelegramBot({
      token: config.tgBotToken,
      tmuxSession,
      transcribeAudio: transcribeAudio,
      isWhisperReady: () => whisperReady,
      autoAuthUserId: config.tgUserId || undefined,
      threadsEnabled: config.threadsEnabled,
      onUserAuthorized: (userId) => {
        config.tgUserId = userId;
        const s = loadSavedConfig();
        s.tgUserId = userId;
        saveConfig(s);
        console.log(`[config] Saved authorized user ID: ${userId}`);
      },
      onThreadsChanged: (threadIds) => {
        const s = loadSavedConfig();
        s.threadIds = threadIds;
        saveConfig(s);
      },
      savedThreadIds: loadSavedConfig().threadIds,
    });
  }

  // --- Start ---
  server.listen(port, '0.0.0.0', () => {
    const ip = getExternalIP();
    const url = `http://${ip}:${port}${SESSION_PATH}/`;
    console.log('');
    console.log('  ==========================================');
    console.log('  whtyce is running!');
    console.log('  ==========================================');
    console.log('');
    console.log(`  URL: ${url}`);
    console.log('');
    if (tgBot) {
      console.log(`  Telegram bot active, code: ${tgBot.getAccessCode()}`);
      console.log('');
    }
    if (!config.whisperEnabled) {
      console.log('  Whisper: disabled');
      console.log('');
    }
    console.log('  ==========================================');
    console.log('');
    streamer.start();
  });

  // --- Shutdown ---
  const shutdown = () => {
    streamer.stop();
    if (tgBot) tgBot.stop();
    killTmuxSession();
    server.close();
  };

  process.on('SIGINT', () => {
    console.log('\nShutting down...');
    shutdown();
    setTimeout(() => process.exit(0), 100);
  });

  process.on('SIGTERM', () => {
    shutdown();
    setTimeout(() => process.exit(0), 100);
  });
}
