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
exports.startServer = startServer;
// Suppress onnxruntime warnings
process.env.ORT_LOG_LEVEL = '3';
process.env.ORT_LOGGING_LEVEL = '3';
const express_1 = __importDefault(require("express"));
const http_1 = __importDefault(require("http"));
const ws_1 = __importDefault(require("ws"));
const path_1 = __importDefault(require("path"));
const child_process_1 = require("child_process");
const telegram_1 = require("./telegram");
function startServer(config) {
    const { port, secret, tmuxSession } = config;
    // --- Whisper ---
    let whisperPipeline = null;
    let whisperLoading = false;
    let whisperReady = false;
    async function loadWhisper() {
        if (!config.whisperEnabled)
            return;
        if (whisperLoading || whisperReady)
            return;
        whisperLoading = true;
        console.log('[whisper] Loading model...');
        const origStderrWrite = process.stderr.write.bind(process.stderr);
        process.stderr.write = ((chunk, ...args) => {
            const str = typeof chunk === 'string' ? chunk : chunk.toString();
            if (str.includes('onnxruntime') || str.includes('Removing initializer'))
                return true;
            return origStderrWrite(chunk, ...args);
        });
        try {
            const { pipeline } = await Promise.resolve().then(() => __importStar(require('@xenova/transformers')));
            whisperPipeline = await pipeline('automatic-speech-recognition', config.whisperModel, { quantized: true });
            whisperReady = true;
            console.log('[whisper] Ready');
        }
        catch (err) {
            console.error('[whisper] Failed to load:', err.message);
            whisperLoading = false;
        }
        finally {
            process.stderr.write = origStderrWrite;
        }
    }
    loadWhisper();
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
        // Allow C-<letter> patterns
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
            const floatArray = wavBufferToFloat32(buffer);
            const result = await whisperPipeline(floatArray, {
                chunk_length_s: 30, stride_length_s: 5, return_timestamps: false,
            });
            const text = result.text?.trim() || '';
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
                getWhisperPipeline: () => whisperPipeline,
                isWhisperReady: () => whisperReady,
                autoAuthUserId: config.tgUserId || undefined,
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
        const os = require('os');
        const interfaces = os.networkInterfaces();
        for (const name of Object.keys(interfaces)) {
            for (const iface of interfaces[name] || []) {
                if (iface.family === 'IPv4' && !iface.internal)
                    return iface.address;
            }
        }
        return 'localhost';
    }
    function wavBufferToFloat32(buffer) {
        let dataOffset = 44;
        for (let i = 0; i < buffer.length - 4; i++) {
            if (buffer[i] === 0x64 && buffer[i + 1] === 0x61 && buffer[i + 2] === 0x74 && buffer[i + 3] === 0x61) {
                dataOffset = i + 8;
                break;
            }
        }
        const samples = (buffer.length - dataOffset) / 2;
        const float32 = new Float32Array(samples);
        for (let i = 0; i < samples; i++) {
            const offset = dataOffset + i * 2;
            if (offset + 1 < buffer.length) {
                float32[i] = buffer.readInt16LE(offset) / 32768.0;
            }
        }
        return float32;
    }
    // --- Start Telegram if token provided ---
    if (config.tgBotToken) {
        tgBot = new telegram_1.TmateTelegramBot({
            token: config.tgBotToken,
            tmuxSession,
            getWhisperPipeline: () => whisperPipeline,
            isWhisperReady: () => whisperReady,
            autoAuthUserId: config.tgUserId || undefined,
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
        // CLI handles printing restart command
        setTimeout(() => process.exit(0), 100);
    });
    process.on('SIGTERM', () => {
        shutdown();
        setTimeout(() => process.exit(0), 100);
    });
}
