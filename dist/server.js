"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadSavedConfig = loadSavedConfig;
exports.saveConfig = saveConfig;
exports.startServer = startServer;
const express_1 = __importDefault(require("express"));
const http_1 = __importDefault(require("http"));
const ws_1 = __importDefault(require("ws"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const os_1 = __importDefault(require("os"));
const child_process_1 = require("child_process");
const telegram_1 = require("./telegram");
const CONFIG_DIR = path_1.default.join(os_1.default.homedir(), '.whtyce');
const CONFIG_FILE = path_1.default.join(CONFIG_DIR, 'config.json');
function loadSavedConfig() {
    try {
        if (fs_1.default.existsSync(CONFIG_FILE)) {
            return JSON.parse(fs_1.default.readFileSync(CONFIG_FILE, 'utf-8'));
        }
    }
    catch { }
    return {};
}
function saveConfig(saved) {
    try {
        if (!fs_1.default.existsSync(CONFIG_DIR)) {
            fs_1.default.mkdirSync(CONFIG_DIR, { recursive: true });
        }
        fs_1.default.writeFileSync(CONFIG_FILE, JSON.stringify(saved, null, 2));
    }
    catch (err) {
        console.error('[config] Failed to save:', err.message);
    }
}
function startServer(config) {
    const { port, secret } = config;
    let tmuxSession = config.tmuxSession;
    // --- Whisper (nodejs-whisper / whisper.cpp) ---
    let whisperLoading = false;
    let whisperReady = false;
    async function loadWhisper() {
        if (!config.whisperEnabled)
            return;
        if (whisperLoading || whisperReady)
            return;
        whisperLoading = true;
        try {
            const constants = await Promise.resolve().then(() => __importStar(require('nodejs-whisper/dist/constants')));
            const whisperCppPath = constants.WHISPER_CPP_PATH;
            const modelFile = constants.MODEL_OBJECT[config.whisperModel];
            if (!modelFile)
                throw new Error(`Unknown model: ${config.whisperModel}`);
            const modelsDir = path_1.default.join(whisperCppPath, 'models');
            const modelPath = path_1.default.join(modelsDir, modelFile);
            const execPath = path_1.default.join(whisperCppPath, 'build', 'bin', 'whisper-cli');
            // Step 1: Download model if needed
            if (!fs_1.default.existsSync(modelPath)) {
                const url = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${modelFile}`;
                console.log(`[whisper] Downloading ${config.whisperModel} model...`);
                await downloadWithProgress(url, modelPath);
            }
            else {
                console.log(`[whisper] Model "${config.whisperModel}" already downloaded`);
            }
            // Step 2: Build whisper.cpp if needed
            if (!fs_1.default.existsSync(execPath)) {
                console.log('[whisper] Building whisper.cpp...');
                await runWithProgress('cmake', ['-B', 'build'], whisperCppPath, 'Configuring');
                await runWithProgress('cmake', ['--build', 'build', '--config', 'Release'], whisperCppPath, 'Compiling');
            }
            else {
                console.log('[whisper] whisper.cpp already built');
            }
            whisperReady = true;
            console.log('[whisper] Ready');
        }
        catch (err) {
            console.error('[whisper] Failed to load:', err.message);
            whisperLoading = false;
        }
    }
    async function downloadWithProgress(url, dest) {
        const resp = await fetch(url, { redirect: 'follow' });
        if (!resp.ok)
            throw new Error(`Download failed: ${resp.status}`);
        const total = parseInt(resp.headers.get('content-length') || '0', 10);
        const dir = path_1.default.dirname(dest);
        if (!fs_1.default.existsSync(dir))
            fs_1.default.mkdirSync(dir, { recursive: true });
        const fileStream = fs_1.default.createWriteStream(dest + '.tmp');
        const reader = resp.body;
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
        await new Promise((resolve, reject) => {
            fileStream.on('finish', resolve);
            fileStream.on('error', reject);
        });
        fs_1.default.renameSync(dest + '.tmp', dest);
        if (total)
            console.log(`\r[whisper] Downloaded ${(total / 1024 / 1024).toFixed(1)} MB`);
    }
    function runWithProgress(cmd, args, cwd, label) {
        return new Promise((resolve, reject) => {
            const proc = (0, child_process_1.spawn)(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
            let lastLog = 0;
            let lines = 0;
            const onData = (data) => {
                const text = data.toString();
                lines += text.split('\n').length - 1;
                const now = Date.now();
                // Parse cmake build progress like [  5%]
                const pctMatch = text.match(/\[\s*(\d+)%\]/);
                if (pctMatch) {
                    process.stdout.write(`\r[whisper] ${label}... ${pctMatch[1]}%`);
                }
                else if (now - lastLog > 2000) {
                    process.stdout.write(`\r[whisper] ${label}...`);
                    lastLog = now;
                }
            };
            proc.stdout?.on('data', onData);
            proc.stderr?.on('data', onData);
            proc.on('close', (code) => {
                process.stdout.write('\n');
                if (code === 0)
                    resolve();
                else
                    reject(new Error(`${cmd} exited with code ${code}`));
            });
            proc.on('error', reject);
        });
    }
    loadWhisper();
    function stripTimestamps(text) {
        return text.replace(/\[\d{2}:\d{2}:\d{2}\.\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}\.\d{3}\]\s*/g, '').trim();
    }
    async function transcribeAudio(wavPath) {
        const { nodewhisper } = await Promise.resolve().then(() => __importStar(require('nodejs-whisper')));
        const result = await nodewhisper(wavPath, {
            modelName: config.whisperModel,
            whisperOptions: { outputInText: true },
            logger: { debug: () => { }, error: console.error, log: () => { } },
        });
        return stripTimestamps(result || '');
    }
    // --- Tmux ---
    function ensureTmuxSession() {
        try {
            (0, child_process_1.execSync)(`tmux kill-session -t ${tmuxSession} 2>/dev/null`);
        }
        catch { }
        (0, child_process_1.execSync)(`tmux new-session -d -s ${tmuxSession} -x 120 -y 40 -c "${process.cwd()}"`);
    }
    function killTmuxSession() {
        try {
            (0, child_process_1.execSync)(`tmux kill-session -t ${tmuxSession} 2>/dev/null`);
        }
        catch { }
    }
    function tmuxSendKeys(keys) {
        const child = (0, child_process_1.spawn)('tmux', ['send-keys', '-t', tmuxSession, '-l', keys]);
        child.on('error', () => { });
    }
    function tmuxSendSpecial(key) {
        const allowed = new Set([
            'Enter', 'Tab', 'Escape', 'Up', 'Down', 'Left', 'Right',
            'Home', 'End', 'BSpace', 'DC', 'PageUp', 'PageDown',
        ]);
        if (allowed.has(key) || /^C-[a-z]$/.test(key)) {
            const child = (0, child_process_1.spawn)('tmux', ['send-keys', '-t', tmuxSession, key]);
            child.on('error', () => { });
        }
    }
    function tmuxResize(cols, rows) {
        const c = Math.max(1, Math.min(500, Math.floor(cols)));
        const r = Math.max(1, Math.min(200, Math.floor(rows)));
        try {
            (0, child_process_1.execSync)(`tmux resize-window -t ${tmuxSession} -x ${c} -y ${r} 2>/dev/null`);
        }
        catch { }
    }
    function tmuxCapture() {
        try {
            return (0, child_process_1.execSync)(`tmux capture-pane -t ${tmuxSession} -p -e`, {
                encoding: 'utf-8',
                maxBuffer: 1024 * 1024,
            });
        }
        catch {
            return '';
        }
    }
    // --- Streamer ---
    class TmuxStreamer {
        constructor() {
            this.pipeProc = null;
            this.clients = new Set();
            this.lastContent = '';
            this.pollInterval = null;
        }
        start() {
            ensureTmuxSession();
            this.startPolling();
        }
        startPolling() {
            this.pollInterval = setInterval(() => {
                if (this.clients.size === 0)
                    return;
                const content = tmuxCapture();
                if (content !== this.lastContent) {
                    this.lastContent = content;
                    const msg = JSON.stringify({ type: 'screen', data: content });
                    this.clients.forEach(ws => {
                        if (ws.readyState === ws_1.default.OPEN)
                            ws.send(msg);
                    });
                }
            }, 50);
        }
        addClient(ws) {
            this.clients.add(ws);
            const content = tmuxCapture();
            if (content)
                ws.send(JSON.stringify({ type: 'screen', data: content }));
        }
        removeClient(ws) { this.clients.delete(ws); }
        stop() {
            if (this.pollInterval)
                clearInterval(this.pollInterval);
            if (this.pipeProc)
                this.pipeProc.kill();
        }
    }
    const streamer = new TmuxStreamer();
    // --- Express ---
    const app = (0, express_1.default)();
    const server = http_1.default.createServer(app);
    const SESSION_PATH = `/s/${secret}`;
    function authCheck(req, res, next) {
        if (req.path.startsWith(SESSION_PATH) || req.path.startsWith('/api/' + secret)) {
            next();
        }
        else if (req.path === '/health') {
            next();
        }
        else {
            res.status(403).send('Forbidden');
        }
    }
    app.use(authCheck);
    app.use(express_1.default.json({ limit: '50mb' }));
    app.use(SESSION_PATH, express_1.default.static(path_1.default.join(__dirname, '..', 'public')));
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
            if (tgBot) {
                tgBot.stop();
                tgBot = null;
            }
            if (config.tgBotToken) {
                try {
                    tgBot = new telegram_1.TmateTelegramBot({
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
                }
                catch (err) {
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
            const wavPath = path_1.default.join(os_1.default.tmpdir(), `whtyce_web_${Date.now()}.wav`);
            fs_1.default.writeFileSync(wavPath, buffer);
            const { nodewhisper } = await Promise.resolve().then(() => __importStar(require('nodejs-whisper')));
            const result = await nodewhisper(wavPath, {
                modelName: config.whisperModel,
                whisperOptions: { outputInText: true },
                logger: { debug: () => { }, error: console.error, log: () => { } },
            });
            const text = stripTimestamps(result || '');
            try {
                fs_1.default.unlinkSync(wavPath);
            }
            catch { }
            console.log(`[whisper] "${text.substring(0, 80)}${text.length > 80 ? '...' : ''}"`);
            res.json({ text });
        }
        catch (err) {
            console.error('[whisper] Error:', err.message);
            res.status(500).json({ error: 'Transcription failed', details: err.message });
        }
    });
    // --- Telegram Bot ---
    let tgBot = null;
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
        if (tgBot) {
            tgBot.stop();
            tgBot = null;
        }
        try {
            tgBot = new telegram_1.TmateTelegramBot({
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
        }
        catch (err) {
            console.error('[telegram] Failed to start bot:', err.message);
            res.status(500).json({ error: 'Failed to start bot: ' + err.message });
        }
    });
    app.post(`/api/${secret}/telegram/disconnect`, (_req, res) => {
        if (tgBot) {
            tgBot.stop();
            tgBot = null;
        }
        res.json({ ok: true });
    });
    // --- WebSocket ---
    const wss = new ws_1.default.Server({ noServer: true });
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
    wss.on('connection', (ws) => {
        streamer.addClient(ws);
        ws.on('message', (msg) => {
            try {
                const parsed = JSON.parse(msg.toString());
                switch (parsed.type) {
                    case 'input':
                        if (typeof parsed.data === 'string')
                            tmuxSendKeys(parsed.data);
                        break;
                    case 'special':
                        if (typeof parsed.data === 'string')
                            tmuxSendSpecial(parsed.data);
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
            }
            catch { }
        });
        ws.on('close', () => { streamer.removeClient(ws); });
        ws.send(JSON.stringify({ type: 'ready' }));
    });
    // --- Helpers ---
    function getExternalIP() {
        const interfaces = os_1.default.networkInterfaces();
        for (const name of Object.keys(interfaces)) {
            for (const iface of interfaces[name] || []) {
                if (iface.family === 'IPv4' && !iface.internal)
                    return iface.address;
            }
        }
        return 'localhost';
    }
    // --- Start Telegram if token provided ---
    if (config.tgBotToken) {
        tgBot = new telegram_1.TmateTelegramBot({
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
        if (tgBot)
            tgBot.stop();
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
