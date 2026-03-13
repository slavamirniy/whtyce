export interface ServerConfig {
    port: number;
    secret: string;
    tgBotToken: string;
    tgUserId: number;
    whisperEnabled: boolean;
    whisperModel: string;
    tmuxSession: string;
    threadsEnabled: boolean;
}
export interface SavedConfig {
    tgBotToken?: string;
    tgUserId?: number;
    threadsEnabled?: boolean;
    whisperEnabled?: boolean;
    whisperModel?: string;
    tmuxSession?: string;
    port?: number;
    threadIds?: Record<string, number>;
}
export declare function loadSavedConfig(): SavedConfig;
export declare function saveConfig(saved: SavedConfig): void;
export declare function startServer(config: ServerConfig): void;
