export interface ServerConfig {
    port: number;
    secret: string;
    tgBotToken: string;
    tgUserId: number;
    whisperEnabled: boolean;
    whisperModel: string;
    tmuxSession: string;
}
export declare function startServer(config: ServerConfig): void;
