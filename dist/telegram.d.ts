interface TelegramBotConfig {
    token: string;
    tmuxSession: string;
    getWhisperPipeline: () => any;
    isWhisperReady: () => boolean;
    autoAuthUserId?: number;
}
export declare class TmateTelegramBot {
    private bot;
    private config;
    private authorizedChat;
    private screenMsgId;
    private lastScreenContent;
    private updateInterval;
    private accessCode;
    private botUsername;
    private updating;
    constructor(config: TelegramBotConfig);
    getAccessCode(): string;
    getBotUsername(): string | null;
    isConnected(): boolean;
    private setupHandlers;
    private authorize;
    private startAutoUpdate;
    private refreshScreen;
    private getKeyboard;
    private sendNewScreenshot;
    private handleVoice;
    private sendToTmux;
    private sendToTmuxSpecial;
    stop(): void;
}
export {};
