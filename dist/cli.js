#!/usr/bin/env node
"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const server_1 = require("./server");
const crypto_1 = __importDefault(require("crypto"));
const net_1 = __importDefault(require("net"));
// --- Crash protection ---
process.on('uncaughtException', (err) => {
    console.error('[crash] Uncaught exception:', err.message);
    console.error(err.stack);
});
process.on('unhandledRejection', (reason) => {
    console.error('[crash] Unhandled rejection:', reason?.message || reason);
});
function findFreePort(startPort) {
    return new Promise((resolve, reject) => {
        const server = net_1.default.createServer();
        server.unref();
        server.on('error', () => {
            resolve(findFreePort(startPort + 1));
        });
        server.listen(startPort, '0.0.0.0', () => {
            const addr = server.address();
            server.close(() => resolve(addr.port));
        });
    });
}
function printHelp() {
    console.log(`
  whtyce - mobile terminal with voice input

  Usage:
    whtyce [options]

  Options:
    -p, --port <port>       Port (default: auto-find free port)
    -s, --secret <secret>   URL secret (default: random)
    -t, --tg-token <token>  Telegram bot token
    -u, --tg-user <id>      Telegram user ID (auto-authorize)
    --threads                Enable Telegram threads (forum topics per tmux session)
    --no-whisper             Disable Whisper voice model
    -h, --help               Show this help

  All settings can be configured via the web UI and are saved
  to ~/.whtyce/config.json. CLI args override saved settings.
  `);
}
function parseArgs(argv) {
    const args = {};
    let i = 0;
    while (i < argv.length) {
        const arg = argv[i];
        if (arg === '-h' || arg === '--help') {
            args.help = true;
        }
        else if (arg === '--no-whisper') {
            args.noWhisper = true;
        }
        else if (arg === '--threads') {
            args.threads = true;
        }
        else if ((arg === '-p' || arg === '--port') && argv[i + 1]) {
            args.port = argv[++i];
        }
        else if ((arg === '-s' || arg === '--secret') && argv[i + 1]) {
            args.secret = argv[++i];
        }
        else if ((arg === '-t' || arg === '--tg-token') && argv[i + 1]) {
            args.tgToken = argv[++i];
        }
        else if ((arg === '-u' || arg === '--tg-user') && argv[i + 1]) {
            args.tgUser = argv[++i];
        }
        i++;
    }
    return args;
}
async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        printHelp();
        process.exit(0);
    }
    // Load saved config from ~/.whtyce/config.json
    const saved = (0, server_1.loadSavedConfig)();
    const requestedPort = args.port ? parseInt(args.port, 10) : (saved.port || 0);
    const port = requestedPort || await findFreePort(8075);
    const secret = args.secret || crypto_1.default.randomBytes(8).toString('hex');
    // CLI args override saved config
    const config = {
        port,
        secret,
        tgBotToken: args.tgToken || saved.tgBotToken || process.env.TG_BOT_TOKEN || '',
        tgUserId: args.tgUser
            ? parseInt(args.tgUser, 10)
            : (saved.tgUserId || (process.env.TG_USER_ID ? parseInt(process.env.TG_USER_ID, 10) : 0)),
        whisperEnabled: args.noWhisper ? false : (saved.whisperEnabled !== undefined ? saved.whisperEnabled : false),
        whisperModel: saved.whisperModel || process.env.WHISPER_MODEL || 'Xenova/whisper-small',
        tmuxSession: saved.tmuxSession || process.env.TMUX_SESSION || 'whtyce',
        threadsEnabled: args.threads ? true : (saved.threadsEnabled || false),
    };
    (0, server_1.startServer)(config);
}
main().catch(err => {
    console.error('Fatal:', err.message);
    process.exit(1);
});
