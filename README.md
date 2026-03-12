# whtyce

Mobile terminal with voice input. Run a command, get a link, control your server from your phone.

## Install

```bash
# System deps
apt install -y tmux ffmpeg build-essential python3 libcairo2-dev libjpeg-dev libpango1.0-dev libgif-dev librsvg2-dev libvips-dev

# Install whtyce
npm install -g github:slavamirniy/whtyce
```

If sharp fails during install, run with `--ignore-scripts` and then install whisper separately:

```bash
npm install -g --ignore-scripts github:slavamirniy/whtyce
cd $(npm root -g)/whtyce && npm install --ignore-scripts @xenova/transformers canvas
```

## Usage

```bash
whtyce
```

That's it. It finds a free port, starts the server, and prints the URL.

### Options

```
-p, --port <port>       Port (default: auto-find free port)
-s, --secret <secret>   URL secret (default: random)
-t, --tg-token <token>  Telegram bot token
-u, --tg-user <id>      Telegram user ID (auto-authorize, skip code)
--no-whisper             Disable Whisper voice model (saves ~400MB RAM)
-h, --help              Show help
```

### Example

```bash
# Basic — just get a link
whtyce

# With Telegram bot
whtyce -t 123456789:ABCdefGHIjklMNOpqrsTUVwxyz

# Full setup — auto-authorize your Telegram, no whisper
whtyce -t 123456789:ABC... -u 87654321 --no-whisper

# Fixed port
whtyce -p 3000
```

When you stop whtyce (Ctrl+C), it prints the command to restart with the same settings.

## Features

- **Mobile-first web terminal** — xterm.js with touch-friendly UI, quick keys bar
- **Voice input** — Whisper speech-to-text, record from browser, preview before sending
- **Telegram bot** — control terminal from Telegram:
  - Send text messages — typed into terminal + Enter
  - Send voice messages — transcribed and typed
  - One persistent screenshot message that updates in-place (no spam)
  - Inline buttons: Refresh, Enter, Ctrl+C, Up, Down
  - User messages are auto-deleted to keep chat clean
  - One connection per session
- **Setup from web UI** — paste Telegram bot token in settings, get a code, click deep link to open bot
- **Auto-port** — finds a free port automatically
- **Crash-resistant** — uncaught exceptions don't kill the process
- **URL auth** — session protected by secret token in URL
- **Clean shutdown** — tmux session killed on exit

## Requirements

- **Node.js 18+**
- **tmux**
- **ffmpeg** — for Telegram voice messages
- **System libs** — `build-essential python3 libcairo2-dev libjpeg-dev libpango1.0-dev libgif-dev librsvg2-dev libvips-dev` (for canvas + sharp)

## How it works

whtyce creates a tmux session and streams it to a web page via WebSocket. Input from the browser (keyboard, touch, voice) is sent back to tmux. The Telegram bot renders terminal screenshots as images and sends them to your chat.
