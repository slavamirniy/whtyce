# whtyce

Mobile terminal with voice input. Run one command — get a link, control your server from your phone.

## Quick Install

```bash
curl -fsSL https://raw.githubusercontent.com/slavamirniy/whtyce/master/install.sh | bash
```

This installs everything (Node.js, tmux, cmake, ffmpeg, whisper) and starts whtyce.

### Manual install

```bash
npm install -g https://github.com/slavamirniy/whtyce/releases/download/v1.1.0/whtyce-1.1.0.tgz
```

## Usage

```bash
whtyce                # start in background, print URL
whtyce stop           # stop
whtyce logs           # show daemon logs
whtyce install        # install/check all dependencies + whisper model
whtyce --no-whisper   # start without voice input
```

### Options

```
-p, --port <port>       Port (default: auto)
-s, --secret <secret>   URL secret (default: random, saved between restarts)
-t, --tg-token <token>  Telegram bot token
-u, --tg-user <id>      Telegram user ID (skip auth code)
--threads               Enable Telegram forum topics
--no-whisper            Disable voice input
```

### Examples

```bash
# Just get a link
whtyce

# With Telegram bot
whtyce -t 123456789:ABCdefGHIjklMNOpqrsTUVwxyz

# Full setup
whtyce -t 123456789:ABC... -u 87654321 --threads

# Fixed port, no whisper
whtyce -p 3000 --no-whisper
```

## Features

- **Background daemon** — starts detached, survives terminal close
- **Mobile-first web terminal** — touch-friendly UI with quick keys bar
- **Voice input** — Whisper (whisper.cpp) speech-to-text, enabled by default
- **Telegram bot** — control terminal from Telegram:
  - Text messages typed into terminal + Enter
  - Voice messages transcribed and typed
  - Live screenshot that updates in-place
  - Inline buttons: Refresh, Enter, Ctrl+C, Up, Down
  - Forum topics mode (`--threads`)
- **Auto-everything** — free port, saved secrets, auto-install deps
- **Settings UI** — configure Telegram bot token from the web page
- **URL auth** — session protected by secret in URL

## Config

Settings saved to `~/.whtyce/config.json`. Clean with:

```bash
rm -rf ~/.whtyce
```

## How it works

whtyce creates a tmux session and streams it to a web page via WebSocket. Input from the browser (keyboard, touch, voice) goes back to tmux. The Telegram bot renders terminal screenshots as images using canvas.
