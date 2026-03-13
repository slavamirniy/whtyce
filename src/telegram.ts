import TelegramBot from 'node-telegram-bot-api';
import { createCanvas } from 'canvas';
import { execSync, spawn } from 'child_process';
import fs from 'fs';
import crypto from 'crypto';

interface TelegramBotConfig {
  token: string;
  tmuxSession: string;
  getWhisperPipeline: () => any;
  isWhisperReady: () => boolean;
  autoAuthUserId?: number;
  threadsEnabled?: boolean;
  onUserAuthorized?: (userId: number) => void;
  onThreadsChanged?: (threadIds: Record<string, number>) => void;
  savedThreadIds?: Record<string, number>;
}

interface SessionState {
  threadId: number | null;
  screenMsgId: number | null;
  lastContent: string;
}

// Known bot commands (handled via both /cmd and //cmd)
const BOT_COMMANDS = new Set([
  'screen', 'ctrl', 'tab', 'esc', 'new', 'kill', 'sessions',
]);

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

// Image aspect ratio 17:26 (matches 340x520 Telegram preview), rendered at 2x
const IMG_WIDTH = 680;
const IMG_HEIGHT = 1040;
const IMG_FONT_SIZE = 18;
const IMG_LINE_HEIGHT = 22;
const IMG_PADDING_X = Math.round(IMG_WIDTH * 0.05);   // 5% = 34px
const IMG_PADDING_Y = Math.round(IMG_HEIGHT * 0.05);  // 5% = 52px
// Measure actual char width from the font
const _measureCanvas = createCanvas(100, 100);
const _measureCtx = _measureCanvas.getContext('2d');
_measureCtx.font = `${IMG_FONT_SIZE}px "Courier New", "Liberation Mono", monospace`;
const IMG_CHAR_WIDTH = _measureCtx.measureText('M').width;

// Calculated terminal dimensions that fit the image (respecting padding on ALL sides)
const TERM_COLS = Math.floor((IMG_WIDTH - IMG_PADDING_X * 2) / IMG_CHAR_WIDTH);
const TERM_ROWS = Math.floor((IMG_HEIGHT - IMG_PADDING_Y * 2) / IMG_LINE_HEIGHT);

function renderTerminalImage(text: string): Buffer {
  const canvas = createCanvas(IMG_WIDTH, IMG_HEIGHT);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#1a1a2e';
  ctx.fillRect(0, 0, IMG_WIDTH, IMG_HEIGHT);

  // Clip to content area so nothing bleeds past padding
  ctx.save();
  ctx.beginPath();
  ctx.rect(IMG_PADDING_X, IMG_PADDING_Y, IMG_WIDTH - IMG_PADDING_X * 2, IMG_HEIGHT - IMG_PADDING_Y * 2);
  ctx.clip();

  ctx.font = `${IMG_FONT_SIZE}px "Courier New", "Liberation Mono", monospace`;
  ctx.fillStyle = '#e0e0e0';
  ctx.textBaseline = 'top';

  const lines = text.split('\n');
  for (let i = 0; i < Math.min(lines.length, TERM_ROWS); i++) {
    const line = lines[i].length > TERM_COLS ? lines[i].slice(0, TERM_COLS) : lines[i];
    ctx.fillText(line, IMG_PADDING_X, IMG_PADDING_Y + i * IMG_LINE_HEIGHT);
  }

  ctx.restore();
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

function listTmuxSessions(): string[] {
  try {
    return execSync("tmux list-sessions -F '#{session_name}'", { encoding: 'utf-8' })
      .trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function createTmuxSession(name: string, cwd?: string): boolean {
  try {
    execSync(`tmux new-session -d -s ${JSON.stringify(name)} -x ${TERM_COLS} -y ${TERM_ROWS} -c "${cwd || process.cwd()}"`, {
      encoding: 'utf-8',
    });
    return true;
  } catch {
    return false;
  }
}

function resizeTmuxSession(name: string) {
  try {
    execSync(`tmux resize-window -t ${JSON.stringify(name)} -x ${TERM_COLS} -y ${TERM_ROWS} 2>/dev/null`, { encoding: 'utf-8' });
  } catch {}
}

function killTmuxSession(name: string): boolean {
  try {
    execSync(`tmux kill-session -t ${JSON.stringify(name)} 2>/dev/null`, { encoding: 'utf-8' });
    return true;
  } catch {
    return false;
  }
}

function generateSessionName(): string {
  const existing = listTmuxSessions();
  let i = 1;
  while (existing.includes(`s${i}`)) i++;
  return `s${i}`;
}

export class TmateTelegramBot {
  private bot: TelegramBot;
  private config: TelegramBotConfig;
  private authorizedChat: number | null = null;
  private accessCode: string;
  private botUsername: string | null = null;

  // Session management
  private sessions = new Map<string, SessionState>();
  private activeSession: string | null = null;

  // Rendering throttle
  private lastRenderTime = 0;
  private renderScheduled = false;
  private pollInterval: NodeJS.Timeout | null = null;
  private updating = false;

  constructor(config: TelegramBotConfig) {
    this.config = config;
    this.accessCode = generateCode();
    this.bot = new TelegramBot(config.token, { polling: true, filepath: true });

    this.bot.getMe().then(me => {
      this.botUsername = me.username || null;
      console.log(`[telegram] Bot: @${this.botUsername}`);
    }).catch(() => {});

    this.registerCommands();
    this.setupHandlers();

    if (config.autoAuthUserId) {
      this.authorize(config.autoAuthUserId);
    }
  }

  getAccessCode(): string { return this.accessCode; }
  getBotUsername(): string | null { return this.botUsername; }
  isConnected(): boolean { return this.authorizedChat !== null; }

  // --- Register bot commands with Telegram ---
  private registerCommands() {
    const commands: TelegramBot.BotCommand[] = [
      { command: 'screen', description: 'Take screenshot' },
      { command: 'ctrl', description: 'Send Ctrl+key (e.g. /ctrl c)' },
      { command: 'tab', description: 'Send Tab' },
      { command: 'esc', description: 'Send Escape' },
    ];
    if (this.config.threadsEnabled) {
      commands.push(
        { command: 'new', description: 'Create tmux session (/new [name])' },
        { command: 'kill', description: 'Kill tmux session (/kill <name>)' },
        { command: 'sessions', description: 'Refresh session list' },
      );
    }
    this.bot.setMyCommands(commands).catch((err: any) => {
      console.error('[telegram] Failed to set commands:', err.message);
    });
  }

  // --- Clean up old forum topics on startup to avoid duplicates ---
  private async cleanupOldTopics(chatId: number) {
    const savedIds = this.config.savedThreadIds;
    if (!savedIds || Object.keys(savedIds).length === 0) {
      console.log('[telegram] No saved topics to clean up');
      return;
    }

    console.log(`[telegram] Cleaning up ${Object.keys(savedIds).length} old topic(s)...`);
    for (const [name, threadId] of Object.entries(savedIds)) {
      try {
        await this.callApi('deleteForumTopic', {
          chat_id: chatId,
          message_thread_id: threadId,
        });
        console.log(`[telegram] Deleted old topic: ${name} (${threadId})`);
      } catch (err: any) {
        // Topic may already be gone — that's fine
        console.log(`[telegram] Could not delete old topic ${name}: ${err.message}`);
      }
    }

    // Clear saved thread IDs
    if (this.config.onThreadsChanged) {
      this.config.onThreadsChanged({});
    }
  }

  private setupHandlers() {
    // Single unified message handler
    this.bot.on('message', async (msg) => {
      const chatId = msg.chat.id;
      const text = msg.text || '';

      // --- /start is always a bot command (Telegram system) ---
      if (text.startsWith('/start')) {
        this.bot.deleteMessage(chatId, msg.message_id).catch(() => {});
        const code = text.replace(/^\/start\s*/, '').trim();
        if (this.authorizedChat === chatId) {
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
        return;
      }

      // --- Not authorized ---
      if (this.authorizedChat !== chatId) {
        if (text && text.trim().toUpperCase() === this.accessCode) {
          if (this.authorizedChat !== null) {
            this.bot.sendMessage(chatId, 'Another session is already connected.');
            return;
          }
          this.authorize(chatId);
          return;
        }
        return;
      }

      // --- //something → send /something to terminal (escape for slash commands) ---
      if (text.startsWith('//')) {
        const termText = text.slice(1); // strip one /, keep the other
        const targetSession = this.getSessionForThread(msg.message_thread_id) || this.activeSession;
        if (this.config.threadsEnabled && msg.message_thread_id) {
          const ts = this.getSessionForThread(msg.message_thread_id);
          if (ts && this.activeSession !== ts) this.activateSession(ts);
        }
        if (targetSession) {
          this.sendToTmux(targetSession, termText);
          this.sendToTmuxSpecial(targetSession, 'Enter');
        }
        this.bot.deleteMessage(chatId, msg.message_id).catch(() => {});
        setTimeout(() => this.scheduleRender(), 500);
        return;
      }

      // --- Known bot command: /screen, /ctrl, etc. ---
      if (text.startsWith('/')) {
        const cmdMatch = text.match(/^\/([a-zA-Z]+)(.*)/);
        if (cmdMatch && BOT_COMMANDS.has(cmdMatch[1].toLowerCase())) {
          this.bot.deleteMessage(chatId, msg.message_id).catch(() => {});
          this.handleBotCommand(msg, cmdMatch[1] + cmdMatch[2]);
          return;
        }
        // Unknown /command → falls through to terminal send below
      }

      // --- Auto-connect in threads mode ---
      if (this.config.threadsEnabled && msg.message_thread_id) {
        const threadSession = this.getSessionForThread(msg.message_thread_id);
        if (threadSession && this.activeSession !== threadSession) {
          this.activateSession(threadSession);
        }
      }

      const targetSession = this.getSessionForThread(msg.message_thread_id) || this.activeSession;

      // --- Text → send to terminal ---
      if (text) {
        if (targetSession) {
          this.sendToTmux(targetSession, text);
          this.sendToTmuxSpecial(targetSession, 'Enter');
        }
        this.bot.deleteMessage(chatId, msg.message_id).catch(() => {});
        setTimeout(() => this.scheduleRender(), 500);
        return;
      }

      // --- Voice → transcribe and send ---
      if (msg.voice || msg.audio) {
        this.bot.deleteMessage(chatId, msg.message_id).catch(() => {});
        await this.handleVoice(chatId, msg, targetSession);
      }
    });

    // --- Callback queries (buttons) ---
    this.bot.on('callback_query', async (query) => {
      const chatId = query.message?.chat.id;
      if (!chatId || this.authorizedChat !== chatId) {
        this.bot.answerCallbackQuery(query.id, { text: 'Not authorized' });
        return;
      }

      const data = query.data || '';

      // Connect to session
      if (data.startsWith('connect:')) {
        const sessionName = data.slice(8);
        this.activateSession(sessionName);
        this.bot.answerCallbackQuery(query.id, { text: `Connected to ${sessionName}` });
        return;
      }

      // Regular actions
      const actions: Record<string, [string, string]> = {
        'refresh': ['', 'Refreshed'],
        'enter': ['Enter', 'Enter sent'],
        'ctrlc': ['C-c', 'Ctrl+C sent'],
        'arrowup': ['Up', 'Up sent'],
        'arrowdown': ['Down', 'Down sent'],
      };

      const action = actions[data];
      if (action && this.activeSession) {
        if (action[0]) this.sendToTmuxSpecial(this.activeSession, action[0]);
        this.bot.answerCallbackQuery(query.id, { text: action[1] });
        if (action[0]) {
          setTimeout(() => this.scheduleRender(), 300);
        } else {
          this.scheduleRender();
        }
      }
    });
  }

  // --- Parse and execute bot command ---
  private handleBotCommand(msg: TelegramBot.Message, cmdText: string) {
    const parts = cmdText.trim().split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1).join(' ').trim();

    // Determine target session (from thread or active)
    const targetSession = this.getSessionForThread(msg.message_thread_id) || this.activeSession;

    switch (cmd) {
      case 'screen':
        if (this.activeSession) this.forceRender();
        break;

      case 'ctrl':
        if (args && targetSession) {
          this.sendToTmuxSpecial(targetSession, `C-${args}`);
          setTimeout(() => this.scheduleRender(), 300);
        }
        break;

      case 'tab':
        if (targetSession) {
          this.sendToTmuxSpecial(targetSession, 'Tab');
          setTimeout(() => this.scheduleRender(), 300);
        }
        break;

      case 'esc':
        if (targetSession) {
          this.sendToTmuxSpecial(targetSession, 'Escape');
          setTimeout(() => this.scheduleRender(), 300);
        }
        break;

      case 'new':
        if (this.config.threadsEnabled) {
          const name = args || generateSessionName();
          this.createSession(name);
        }
        break;

      case 'kill':
        if (this.config.threadsEnabled && args) {
          this.deleteSession(args);
        }
        break;

      case 'sessions':
        if (this.config.threadsEnabled) {
          this.syncSessions();
        }
        break;
    }
  }

  private persistThreadIds() {
    if (!this.config.onThreadsChanged) return;
    const ids: Record<string, number> = {};
    for (const [name, state] of this.sessions) {
      if (state.threadId) ids[name] = state.threadId;
    }
    this.config.onThreadsChanged(ids);
  }

  private getSessionForThread(threadId?: number): string | null {
    if (!threadId || !this.config.threadsEnabled) return null;
    for (const [name, state] of this.sessions) {
      if (state.threadId === threadId) return name;
    }
    return null;
  }

  private async authorize(chatId: number) {
    this.authorizedChat = chatId;

    // Save user ID to config for auto-auth on restart
    if (this.config.onUserAuthorized) {
      this.config.onUserAuthorized(chatId);
    }

    const lines = [
      'Connected to whtyce!',
      '',
      'Text \u2192 typed + Enter',
      'Voice \u2192 speech-to-text',
      '//cmd \u2192 sends /cmd to terminal',
      '',
      'Bot commands:',
      '/screen \u2014 screenshot',
      '/ctrl c \u2014 Ctrl+C',
      '/tab \u2014 Tab',
      '/esc \u2014 Escape',
    ];
    if (this.config.threadsEnabled) {
      lines.push('/new [name] \u2014 create session');
      lines.push('/kill <name> \u2014 delete session');
      lines.push('/sessions \u2014 refresh list');
    }
    await this.bot.sendMessage(chatId, lines.join('\n'));

    if (this.config.threadsEnabled) {
      // Clean up old forum topics before creating new ones
      await this.cleanupOldTopics(chatId);
      await this.syncSessions();
    } else {
      this.activeSession = this.config.tmuxSession;
      resizeTmuxSession(this.activeSession);
      this.sessions.set(this.activeSession, {
        threadId: null,
        screenMsgId: null,
        lastContent: '',
      });
      await this.sendNewScreenshot(this.activeSession!);
      this.startContentPolling();
    }
  }

  private async syncSessions() {
    if (!this.authorizedChat) return;
    const chatId = this.authorizedChat;
    const tmuxSessions = listTmuxSessions();

    if (tmuxSessions.length === 0) {
      this.bot.sendMessage(chatId, 'No tmux sessions found. Use /new to create one.');
      return;
    }

    for (const name of tmuxSessions) {
      if (this.sessions.has(name)) continue;

      try {
        const topic = await this.callApi('createForumTopic', {
          chat_id: chatId,
          name: `\uD83D\uDDA5 ${name}`,
          icon_color: 7322096,
        });

        this.sessions.set(name, {
          threadId: topic.message_thread_id,
          screenMsgId: null,
          lastContent: '',
        });

        await this.sendSessionPreview(name);
        this.persistThreadIds();
      } catch (err: any) {
        console.error(`[telegram] Failed to create topic for ${name}:`, err.message);
      }
    }

    // Remove dead sessions
    for (const [name, state] of this.sessions) {
      if (!tmuxSessions.includes(name)) {
        if (state.threadId) {
          this.callApi('deleteForumTopic', {
            chat_id: chatId,
            message_thread_id: state.threadId,
          }).catch(() => {});
        }
        this.sessions.delete(name);
        if (this.activeSession === name) this.activeSession = null;
      }
    }

    this.persistThreadIds();
    this.startContentPolling();
  }

  private async createSession(name: string) {
    if (!this.authorizedChat) return;
    const chatId = this.authorizedChat;

    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      this.bot.sendMessage(chatId, `Invalid name: "${name}". Use letters, digits, - or _`);
      return;
    }

    if (this.sessions.has(name)) {
      this.bot.sendMessage(chatId, `Session "${name}" already exists.`);
      return;
    }

    if (!createTmuxSession(name)) {
      this.bot.sendMessage(chatId, `Failed to create tmux session "${name}".`);
      return;
    }

    try {
      const topic = await this.callApi('createForumTopic', {
        chat_id: chatId,
        name: `\uD83D\uDDA5 ${name}`,
        icon_color: 7322096,
      });

      this.sessions.set(name, {
        threadId: topic.message_thread_id,
        screenMsgId: null,
        lastContent: '',
      });

      await this.sendSessionPreview(name);
      this.persistThreadIds();
      console.log(`[telegram] Created session: ${name}`);
    } catch (err: any) {
      console.error(`[telegram] Failed to create topic for ${name}:`, err.message);
      killTmuxSession(name);
    }
  }

  private async deleteSession(name: string) {
    if (!this.authorizedChat) return;
    const chatId = this.authorizedChat;
    const state = this.sessions.get(name);

    if (!state) {
      this.bot.sendMessage(chatId, `Session "${name}" not found.`);
      return;
    }

    if (this.activeSession === name) {
      this.activeSession = null;
    }

    killTmuxSession(name);

    if (state.threadId) {
      // Send redirect to main chat before deleting topic
      const remaining = [...this.sessions.keys()].filter(n => n !== name);
      const helpLines = [
        `Session "${name}" deleted.`,
        '',
        remaining.length > 0
          ? `Active sessions: ${remaining.join(', ')}`
          : 'No sessions left. Use /new to create one.',
        '',
        'Commands:',
        '/new [name] \u2014 create session',
        '/sessions \u2014 refresh list',
      ];
      await this.bot.sendMessage(chatId, helpLines.join('\n'));

      try {
        await this.callApi('deleteForumTopic', {
          chat_id: chatId,
          message_thread_id: state.threadId,
        });
      } catch (err: any) {
        console.error(`[telegram] Failed to delete topic for ${name}:`, err.message);
      }
    }

    this.sessions.delete(name);
    this.persistThreadIds();
    console.log(`[telegram] Deleted session: ${name}`);
  }

  private async sendSessionPreview(sessionName: string) {
    const state = this.sessions.get(sessionName);
    if (!state || !this.authorizedChat) return;

    // Skip if already has a screenshot
    if (state.screenMsgId) return;

    resizeTmuxSession(sessionName);
    const text = stripAnsi(capturePaneText(sessionName));
    state.lastContent = text;
    const imgBuf = renderTerminalImage(text);

    const sendOpts: any = {
      reply_markup: this.getKeyboard(sessionName),
    };
    if (state.threadId) sendOpts.message_thread_id = state.threadId;

    try {
      const sent = await this.bot.sendPhoto(this.authorizedChat, imgBuf, sendOpts, {
        filename: 'screen.png',
        contentType: 'image/png',
      });
      state.screenMsgId = sent.message_id;
      this.lastRenderTime = Date.now(); // prevent immediate re-render
    } catch (err: any) {
      console.error(`[telegram] Failed to send preview for ${sessionName}:`, err.message);
    }
  }

  private activateSession(sessionName: string) {
    const prevSession = this.activeSession;
    this.activeSession = sessionName;

    // Resize tmux to fit the screenshot image
    resizeTmuxSession(sessionName);

    if (prevSession && prevSession !== sessionName) {
      this.updateSessionKeyboard(prevSession);
    }

    this.updateSessionKeyboard(sessionName);
    this.forceRender();
  }

  private async updateSessionKeyboard(sessionName: string) {
    const state = this.sessions.get(sessionName);
    if (!state?.screenMsgId || !this.authorizedChat) return;

    try {
      await this.bot.editMessageReplyMarkup(this.getKeyboard(sessionName), {
        chat_id: this.authorizedChat,
        message_id: state.screenMsgId,
      });
    } catch {}
  }

  // --- Content polling with throttle ---

  private startContentPolling() {
    if (this.pollInterval) clearInterval(this.pollInterval);
    this.pollInterval = setInterval(() => {
      if (!this.activeSession || !this.authorizedChat) return;
      const state = this.sessions.get(this.activeSession);
      if (!state) return;

      const text = stripAnsi(capturePaneText(this.activeSession));
      if (text !== state.lastContent || !state.screenMsgId) {
        this.scheduleRender();
      }
    }, 500);
  }

  private scheduleRender() {
    if (this.renderScheduled || this.updating) return;
    const now = Date.now();
    const elapsed = now - this.lastRenderTime;
    const minInterval = 3000;

    if (elapsed >= minInterval) {
      this.doRender();
    } else {
      this.renderScheduled = true;
      setTimeout(() => {
        this.renderScheduled = false;
        this.doRender();
      }, minInterval - elapsed);
    }
  }

  private forceRender() {
    this.lastRenderTime = 0;
    this.renderScheduled = false;
    this.doRender();
  }

  private async doRender() {
    if (!this.activeSession || !this.authorizedChat || this.updating) return;
    this.updating = true;
    this.lastRenderTime = Date.now();

    const sessionName = this.activeSession;
    const state = this.sessions.get(sessionName);
    if (!state) { this.updating = false; return; }

    try {
      const text = stripAnsi(capturePaneText(sessionName));
      if (text === state.lastContent && state.screenMsgId) {
        return;
      }
      state.lastContent = text;

      const chatId = this.authorizedChat;
      const imgBuf = renderTerminalImage(text);

      if (state.screenMsgId) {
        try {
          const tmpFile = `/tmp/whtyce_screen_${Date.now()}.png`;
          fs.writeFileSync(tmpFile, imgBuf);
          try {
            await this.bot.editMessageMedia(
              {
                type: 'photo',
                media: `attach://${tmpFile}`,
              } as any,
              {
                chat_id: chatId,
                message_id: state.screenMsgId,
                reply_markup: this.getKeyboard(sessionName),
              } as any
            );
            return;
          } finally {
            try { fs.unlinkSync(tmpFile); } catch {}
          }
        } catch {
          // Edit failed — send new + delete old
        }
      }

      await this.sendNewScreenshot(sessionName);
    } catch (err: any) {
      console.error('[telegram] Render error:', err.message);
    } finally {
      this.updating = false;
    }
  }

  private getKeyboard(sessionName?: string): TelegramBot.InlineKeyboardMarkup {
    const isActive = sessionName === this.activeSession;

    if (this.config.threadsEnabled && sessionName) {
      if (isActive) {
        // Active: just action buttons, no Disconnect/Delete
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
      } else {
        // Inactive: just Connect
        return {
          inline_keyboard: [
            [{ text: '\uD83D\uDD0C Connect', callback_data: `connect:${sessionName}` }],
          ],
        };
      }
    }

    // Non-threads mode (single session)
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

  private async sendNewScreenshot(sessionName: string) {
    const state = this.sessions.get(sessionName);
    if (!state || !this.authorizedChat) return;

    try {
      const text = stripAnsi(capturePaneText(sessionName));
      state.lastContent = text;
      const imgBuf = renderTerminalImage(text);
      const oldMsgId = state.screenMsgId;

      // Delete old message first to avoid duplicates
      if (oldMsgId) {
        state.screenMsgId = null;
        await this.bot.deleteMessage(this.authorizedChat, oldMsgId).catch(() => {});
      }

      const sendOpts: any = {
        reply_markup: this.getKeyboard(sessionName),
      };
      if (state.threadId) sendOpts.message_thread_id = state.threadId;

      const sent = await this.bot.sendPhoto(this.authorizedChat, imgBuf, sendOpts, {
        filename: 'screen.png',
        contentType: 'image/png',
      });

      state.screenMsgId = sent.message_id;
    } catch (err: any) {
      console.error('[telegram] Failed to send screenshot:', err.message);
    }
  }

  private async handleVoice(chatId: number, msg: TelegramBot.Message, targetSession: string | null) {
    if (!this.config.isWhisperReady()) {
      this.bot.sendMessage(chatId, 'Whisper is still loading...');
      return;
    }

    const fileId = msg.voice?.file_id || msg.audio?.file_id;
    if (!fileId) return;

    // Auto-connect in threads
    if (this.config.threadsEnabled && msg.message_thread_id) {
      const threadSession = this.getSessionForThread(msg.message_thread_id);
      if (threadSession && this.activeSession !== threadSession) {
        this.activateSession(threadSession);
        targetSession = threadSession;
      }
    }

    const threadId = msg.message_thread_id;
    const statusOpts: any = {};
    if (threadId) statusOpts.message_thread_id = threadId;
    const statusMsg = await this.bot.sendMessage(chatId, 'Transcribing...', statusOpts);

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
        const session = targetSession || this.activeSession;
        if (session) {
          this.sendToTmux(session, text);
          this.sendToTmuxSpecial(session, 'Enter');
        }
        await this.bot.editMessageText(`\u2713 ${text}`, {
          chat_id: chatId,
          message_id: statusMsg.message_id,
        });
        setTimeout(() => {
          this.bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
        }, 3000);
        setTimeout(() => this.scheduleRender(), 500);
      } else {
        await this.bot.editMessageText('Could not transcribe audio.', {
          chat_id: chatId,
          message_id: statusMsg.message_id,
        });
        setTimeout(() => {
          this.bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
        }, 5000);
      }
    } catch (err: any) {
      console.error('[telegram] Voice error:', err.message);
      await this.bot.editMessageText('Transcription failed: ' + err.message, {
        chat_id: chatId,
        message_id: statusMsg.message_id,
      }).catch(() => {});
    }
  }

  private sendToTmux(session: string, text: string) {
    const child = spawn('tmux', ['send-keys', '-t', session, '-l', text]);
    child.on('error', () => {});
  }

  private sendToTmuxSpecial(session: string, key: string) {
    const child = spawn('tmux', ['send-keys', '-t', session, key]);
    child.on('error', () => {});
  }

  private async callApi(method: string, params: Record<string, any>): Promise<any> {
    const url = `https://api.telegram.org/bot${this.config.token}/${method}`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    const data = await resp.json() as any;
    if (!data.ok) throw new Error(data.description || 'API error');
    return data.result;
  }

  stop() {
    if (this.pollInterval) clearInterval(this.pollInterval);
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
