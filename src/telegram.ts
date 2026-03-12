import TelegramBot from 'node-telegram-bot-api';
import { execSync, spawn } from 'child_process';

// Lazy import — canvas is optional
let createCanvas: any = null;
try {
  createCanvas = require('canvas').createCanvas;
} catch {
  console.log('[telegram] canvas not available — install system deps for Telegram screenshots');
}
import fs from 'fs';
import crypto from 'crypto';

interface TelegramBotConfig {
  token: string;
  tmuxSession: string;
  getWhisperPipeline: () => any;
  isWhisperReady: () => boolean;
  autoAuthUserId?: number;
}

function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
}

function capturePaneText(session: string): string {
  try {
    return execSync(`tmux capture-pane -t ${session} -p`, {
      encoding: 'utf-8',
      maxBuffer: 1024 * 1024,
    });
  } catch {
    return '(tmux session not available)';
  }
}

function renderTerminalImage(text: string): Buffer | null {
  if (!createCanvas) return null;
  const lines = text.split('\n');
  const fontSize = 14;
  const lineHeight = 18;
  const paddingX = 12;
  const paddingY = 10;
  const charWidth = 8.4;

  const maxLineLen = Math.max(...lines.map(l => l.length), 40);
  const width = Math.ceil(maxLineLen * charWidth + paddingX * 2);
  const height = Math.max(lines.length * lineHeight + paddingY * 2, 100);

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#1a1a2e';
  ctx.fillRect(0, 0, width, height);

  ctx.font = `${fontSize}px "Courier New", "Liberation Mono", monospace`;
  ctx.fillStyle = '#e0e0e0';
  ctx.textBaseline = 'top';

  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i], paddingX, paddingY + i * lineHeight);
  }

  return canvas.toBuffer('image/png');
}

function generateCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 5; i++) {
    code += chars[crypto.randomInt(chars.length)];
  }
  return code;
}

export class TmateTelegramBot {
  private bot: TelegramBot;
  private config: TelegramBotConfig;
  private authorizedChat: number | null = null;
  private screenMsgId: number | null = null;
  private lastScreenContent = '';
  private updateInterval: NodeJS.Timeout | null = null;
  private accessCode: string;
  private botUsername: string | null = null;
  private updating = false;

  constructor(config: TelegramBotConfig) {
    this.config = config;
    this.accessCode = generateCode();
    this.bot = new TelegramBot(config.token, { polling: true });

    // Fetch bot username
    this.bot.getMe().then(me => {
      this.botUsername = me.username || null;
      console.log(`[telegram] Bot: @${this.botUsername}`);
    }).catch(() => {});

    this.setupHandlers();

    // Auto-authorize if user ID provided
    if (config.autoAuthUserId) {
      this.authorize(config.autoAuthUserId);
    }
  }

  getAccessCode(): string {
    return this.accessCode;
  }

  getBotUsername(): string | null {
    return this.botUsername;
  }

  isConnected(): boolean {
    return this.authorizedChat !== null;
  }

  private setupHandlers() {
    this.bot.onText(/\/start(.*)/, (msg, match) => {
      const chatId = msg.chat.id;
      const code = (match?.[1] || '').trim();

      if (this.authorizedChat === chatId) {
        this.bot.sendMessage(chatId, 'Already connected. Send text to type in terminal.');
        return;
      }

      if (this.authorizedChat !== null) {
        this.bot.sendMessage(chatId, 'Another session is already connected.');
        return;
      }

      if (code === this.accessCode) {
        this.authorize(chatId);
      } else {
        this.bot.sendMessage(chatId, 'Send the 5-letter access code to connect.');
      }
    });

    this.bot.on('message', async (msg) => {
      const chatId = msg.chat.id;

      if (this.authorizedChat !== chatId) {
        if (msg.text && msg.text.trim().toUpperCase() === this.accessCode) {
          if (this.authorizedChat !== null) {
            this.bot.sendMessage(chatId, 'Another session is already connected.');
            return;
          }
          this.authorize(chatId);
          return;
        }
        if (msg.text && !msg.text.startsWith('/')) {
          this.bot.sendMessage(chatId, 'Send the 5-letter access code to connect.');
        }
        return;
      }

      if (msg.text && !msg.text.startsWith('/')) {
        this.sendToTmux(msg.text);
        this.sendToTmuxSpecial('Enter');
        // Delete user message to keep chat clean
        this.bot.deleteMessage(chatId, msg.message_id).catch(() => {});
        setTimeout(() => this.refreshScreen(), 500);
      }

      if (msg.voice || msg.audio) {
        // Delete user voice message
        this.bot.deleteMessage(chatId, msg.message_id).catch(() => {});
        await this.handleVoice(chatId, msg);
      }
    });

    this.bot.on('callback_query', async (query) => {
      const chatId = query.message?.chat.id;
      if (!chatId || this.authorizedChat !== chatId) {
        this.bot.answerCallbackQuery(query.id, { text: 'Not authorized' });
        return;
      }

      const actions: Record<string, [string, string]> = {
        'refresh': ['', 'Refreshed'],
        'enter': ['Enter', 'Enter sent'],
        'ctrlc': ['C-c', 'Ctrl+C sent'],
        'arrowup': ['Up', 'Up sent'],
        'arrowdown': ['Down', 'Down sent'],
      };

      const action = actions[query.data || ''];
      if (action) {
        if (action[0]) this.sendToTmuxSpecial(action[0]);
        this.bot.answerCallbackQuery(query.id, { text: action[1] });
        setTimeout(() => this.refreshScreen(), action[0] ? 300 : 0);
      }
    });

    this.bot.onText(/\/screen/, (msg) => {
      if (this.authorizedChat === msg.chat.id) this.refreshScreen();
    });

    this.bot.onText(/\/ctrl (.+)/, (msg, match) => {
      if (this.authorizedChat !== msg.chat.id) return;
      const key = match?.[1]?.trim();
      if (key) {
        this.sendToTmuxSpecial(`C-${key}`);
        setTimeout(() => this.refreshScreen(), 300);
      }
    });

    this.bot.onText(/\/tab/, (msg) => {
      if (this.authorizedChat !== msg.chat.id) return;
      this.sendToTmuxSpecial('Tab');
      setTimeout(() => this.refreshScreen(), 300);
    });

    this.bot.onText(/\/esc/, (msg) => {
      if (this.authorizedChat !== msg.chat.id) return;
      this.sendToTmuxSpecial('Escape');
      setTimeout(() => this.refreshScreen(), 300);
    });
  }

  private authorize(chatId: number) {
    this.authorizedChat = chatId;
    this.bot.sendMessage(chatId, [
      'Connected to tmate-mobile!',
      '',
      'Send any text \u2014 it gets typed + Enter.',
      'Send voice message \u2014 speech-to-text.',
      '',
      '/screen \u2014 screenshot',
      '/ctrl c \u2014 Ctrl+C',
      '/tab \u2014 Tab',
      '/esc \u2014 Escape',
    ].join('\n'));

    // Send initial screenshot, then start auto-update
    setTimeout(async () => {
      await this.sendNewScreenshot(chatId);
      this.startAutoUpdate();
    }, 500);
  }

  private startAutoUpdate() {
    if (this.updateInterval) clearInterval(this.updateInterval);

    this.updateInterval = setInterval(() => {
      if (this.authorizedChat === null) {
        if (this.updateInterval) clearInterval(this.updateInterval);
        return;
      }
      this.refreshScreen();
    }, 3000);
  }

  // Core: refresh screen by editing existing message, or send new if needed
  private async refreshScreen() {
    if (this.authorizedChat === null || this.updating) return;
    this.updating = true;

    try {
      const text = stripAnsi(capturePaneText(this.config.tmuxSession));
      if (text === this.lastScreenContent && this.screenMsgId) {
        return; // No changes
      }
      this.lastScreenContent = text;

      const chatId = this.authorizedChat;
      const imgBuf = renderTerminalImage(text);
      if (!imgBuf) return;

      if (this.screenMsgId) {
        // Try to edit existing message
        try {
          await this.bot.editMessageMedia(
            {
              type: 'photo',
              media: 'attach://screen.png',
            } as TelegramBot.InputMediaPhoto,
            {
              chat_id: chatId,
              message_id: this.screenMsgId,
            }
          );
          // Re-attach keyboard after editMessageMedia
          const keyboard = this.getKeyboard();
          await this.bot.editMessageReplyMarkup(keyboard, {
            chat_id: chatId,
            message_id: this.screenMsgId,
          }).catch(() => {});
          return;
        } catch {
          // Edit failed, send new
          this.screenMsgId = null;
        }
      }

      await this.sendNewScreenshot(chatId);
    } catch (err: any) {
      console.error('[telegram] Screen update error:', err.message);
    } finally {
      this.updating = false;
    }
  }

  private getKeyboard(): TelegramBot.InlineKeyboardMarkup {
    return {
      inline_keyboard: [
        [
          { text: 'Refresh', callback_data: 'refresh' },
          { text: 'Enter', callback_data: 'enter' },
          { text: 'Ctrl+C', callback_data: 'ctrlc' },
        ],
        [
          { text: 'Up', callback_data: 'arrowup' },
          { text: 'Down', callback_data: 'arrowdown' },
        ],
      ],
    };
  }

  private async sendNewScreenshot(chatId: number) {
    try {
      const text = stripAnsi(capturePaneText(this.config.tmuxSession));
      this.lastScreenContent = text;
      const imgBuf = renderTerminalImage(text);
      if (!imgBuf) return;
      const oldMsgId = this.screenMsgId;

      const sent = await this.bot.sendPhoto(chatId, imgBuf, {
        reply_markup: this.getKeyboard(),
      }, {
        filename: 'screen.png',
        contentType: 'image/png',
      });

      this.screenMsgId = sent.message_id;

      // Delete old message AFTER new one is sent
      if (oldMsgId && oldMsgId !== sent.message_id) {
        this.bot.deleteMessage(chatId, oldMsgId).catch(() => {});
      }
    } catch (err: any) {
      console.error('[telegram] Failed to send screenshot:', err.message);
    }
  }

  private async handleVoice(chatId: number, msg: TelegramBot.Message) {
    if (!this.config.isWhisperReady()) {
      this.bot.sendMessage(chatId, 'Whisper is still loading...');
      return;
    }

    const fileId = msg.voice?.file_id || msg.audio?.file_id;
    if (!fileId) return;

    const statusMsg = await this.bot.sendMessage(chatId, 'Transcribing...');

    try {
      const filePath = await this.bot.downloadFile(fileId, '/tmp');
      const wavPath = `/tmp/tg_voice_${Date.now()}.wav`;
      try {
        execSync(`ffmpeg -i "${filePath}" -ar 16000 -ac 1 -f wav "${wavPath}" -y 2>/dev/null`);
      } catch {
        fs.copyFileSync(filePath, wavPath);
      }

      const wavBuffer = fs.readFileSync(wavPath);
      const floatArray = wavBufferToFloat32(wavBuffer);

      const whisper = this.config.getWhisperPipeline();
      const result = await whisper(floatArray, {
        chunk_length_s: 30,
        stride_length_s: 5,
        return_timestamps: false,
      });

      const text = result.text?.trim() || '';

      try { fs.unlinkSync(filePath); } catch {}
      try { fs.unlinkSync(wavPath); } catch {}

      if (text) {
        this.sendToTmux(text);
        this.sendToTmuxSpecial('Enter');
        await this.bot.editMessageText(`Sent: ${text}`, {
          chat_id: chatId,
          message_id: statusMsg.message_id,
        });
        setTimeout(() => this.refreshScreen(), 500);
      } else {
        await this.bot.editMessageText('Could not transcribe audio.', {
          chat_id: chatId,
          message_id: statusMsg.message_id,
        });
      }
    } catch (err: any) {
      console.error('[telegram] Voice error:', err.message);
      await this.bot.editMessageText('Transcription failed: ' + err.message, {
        chat_id: chatId,
        message_id: statusMsg.message_id,
      }).catch(() => {});
    }
  }

  private sendToTmux(text: string) {
    const child = spawn('tmux', ['send-keys', '-t', this.config.tmuxSession, '-l', text]);
    child.on('error', () => {});
  }

  private sendToTmuxSpecial(key: string) {
    const child = spawn('tmux', ['send-keys', '-t', this.config.tmuxSession, key]);
    child.on('error', () => {});
  }

  stop() {
    if (this.updateInterval) clearInterval(this.updateInterval);
    this.bot.stopPolling();
  }
}

function wavBufferToFloat32(buffer: Buffer): Float32Array {
  let dataOffset = 44;
  for (let i = 0; i < buffer.length - 4; i++) {
    if (buffer[i] === 0x64 && buffer[i+1] === 0x61 && buffer[i+2] === 0x74 && buffer[i+3] === 0x61) {
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
