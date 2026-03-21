import * as fs from 'fs';
import path from 'path';

class UnifiedLogger {
    private logFile: string;

    constructor() {
        this.logFile = path.join(process.cwd(), 'arbitrage.log');
        // We will use synchronous writes to guarantee logs flush to disk before any potential process exits
    }

    private formatMessage(level: string, message: string, ...optionalParams: any[]): string {
        const timestamp = new Date().toISOString();
        const baseMsg = `[${timestamp}] [${level}] ${message}`;
        if (optionalParams.length > 0) {
            return `${baseMsg} ${optionalParams.map(p => p instanceof Error ? p.stack || p.message : typeof p === 'object' ? JSON.stringify(p) : p).join(' ')}`;
        }
        return baseMsg;
    }

    public info(message: string, ...optionalParams: any[]) {
        const formatted = this.formatMessage('INFO', message, ...optionalParams);
        fs.appendFileSync(this.logFile, formatted + '\n');
    }

    public system(message: string, ...optionalParams: any[]) {
        const formatted = this.formatMessage('SYSTEM', message, ...optionalParams);
        fs.appendFileSync(this.logFile, formatted + '\n');
    }

    public warn(message: string, ...optionalParams: any[]) {
        const formatted = this.formatMessage('WARN', message, ...optionalParams);
        fs.appendFileSync(this.logFile, formatted + '\n');
    }

    public error(message: string, ...optionalParams: any[]) {
        const formatted = this.formatMessage('ERROR', message, ...optionalParams);
        fs.appendFileSync(this.logFile, formatted + '\n');
    }

    // For critical boot-up sequences where we MUST see it in the terminal before UI starts
    public systemTerm(message: string, ...optionalParams: any[]) {
        console.log(message, ...optionalParams);
        this.info(message, ...optionalParams);
    }
}

export const logger = new UnifiedLogger();
