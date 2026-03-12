#!/usr/bin/env node

import { startServer, ServerConfig } from './server';
import crypto from 'crypto';
import net from 'net';

// --- Crash protection ---
process.on('uncaughtException', (err) => {
  console.error('[crash] Uncaught exception:', err.message);
  console.error(err.stack);
  // Don't exit — keep running
});

process.on('unhandledRejection', (reason: any) => {
  console.error('[crash] Unhandled rejection:', reason?.message || reason);
  // Don't exit — keep running
});

function findFreePort(startPort: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', () => {
      resolve(findFreePort(startPort + 1));
    });
    server.listen(startPort, '0.0.0.0', () => {
      const addr = server.address() as net.AddressInfo;
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

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      args.help = true;
    } else if (arg === '--no-whisper') {
      args.noWhisper = true;
    } else if ((arg === '-p' || arg === '--port') && argv[i + 1]) {
      args.port = argv[++i];
    } else if ((arg === '-s' || arg === '--secret') && argv[i + 1]) {
      args.secret = argv[++i];
    } else if ((arg === '-t' || arg === '--tg-token') && argv[i + 1]) {
      args.tgToken = argv[++i];
    } else if ((arg === '-u' || arg === '--tg-user') && argv[i + 1]) {
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

  const requestedPort = args.port ? parseInt(args.port as string, 10) : 0;
  const port = requestedPort || await findFreePort(8075);
  const secret = (args.secret as string) || crypto.randomBytes(8).toString('hex');

  const config: ServerConfig = {
    port,
    secret,
    tgBotToken: (args.tgToken as string) || process.env.TG_BOT_TOKEN || '',
    tgUserId: args.tgUser ? parseInt(args.tgUser as string, 10) : (process.env.TG_USER_ID ? parseInt(process.env.TG_USER_ID, 10) : 0),
    whisperEnabled: !args.noWhisper,
    whisperModel: process.env.WHISPER_MODEL || 'Xenova/whisper-base',
    tmuxSession: process.env.TMUX_SESSION || 'whtyce',
  };

  // Build restart command on exit
  const buildRestartCmd = () => {
    const parts = ['whtyce'];
    parts.push('-p', String(config.port));
    parts.push('-s', config.secret);
    if (config.tgBotToken) parts.push('-t', config.tgBotToken);
    if (config.tgUserId) parts.push('-u', String(config.tgUserId));
    if (!config.whisperEnabled) parts.push('--no-whisper');
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

  startServer(config);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
