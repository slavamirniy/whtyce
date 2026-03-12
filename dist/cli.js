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
    // Don't exit — keep running
});
process.on('unhandledRejection', (reason) => {
    console.error('[crash] Unhandled rejection:', reason?.message || reason);
    // Don't exit — keep running
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
    --no-whisper             Disable Whisper voice model
    -h, --help               Show this help
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
    const requestedPort = args.port ? parseInt(args.port, 10) : 0;
    const port = requestedPort || await findFreePort(8075);
    const secret = args.secret || crypto_1.default.randomBytes(8).toString('hex');
    const config = {
        port,
        secret,
        tgBotToken: args.tgToken || process.env.TG_BOT_TOKEN || '',
        tgUserId: args.tgUser ? parseInt(args.tgUser, 10) : (process.env.TG_USER_ID ? parseInt(process.env.TG_USER_ID, 10) : 0),
        whisperEnabled: !args.noWhisper,
        whisperModel: process.env.WHISPER_MODEL || 'Xenova/whisper-base',
        tmuxSession: process.env.TMUX_SESSION || 'whtyce',
    };
    // Build restart command on exit
    const buildRestartCmd = () => {
        const parts = ['whtyce'];
        parts.push('-p', String(config.port));
        parts.push('-s', config.secret);
        if (config.tgBotToken)
            parts.push('-t', config.tgBotToken);
        if (config.tgUserId)
            parts.push('-u', String(config.tgUserId));
        if (!config.whisperEnabled)
            parts.push('--no-whisper');
        return parts.join(' ');
    };
    const cleanup = () => {
        console.log('\n');
        console.log('  To restart with same settings:');
        console.log(`  $ ${buildRestartCmd()}`);
        console.log('');
    };
    process.on('SIGINT', () => { cleanup(); });
    process.on('SIGTERM', () => { cleanup(); });
    (0, server_1.startServer)(config);
}
main().catch(err => {
    console.error('Fatal:', err.message);
    process.exit(1);
});
