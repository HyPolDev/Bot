import fs from 'fs';
import WebSocket from 'ws';
import crypto from 'crypto';
import { logger } from '../logger.js';

export class KalshiWS {
    private outcomeId: string;
    private isRunning: boolean = false;
    private ws: WebSocket | null = null;
    private onUpdate: (source: string, book: any) => void;

    private kalshiBooks = {
        yes: new Map<number, number>(),
        no: new Map<number, number>()
    };

    constructor(outcomeId: string, onUpdate: (source: string, book: any) => void) {
        this.outcomeId = outcomeId;
        this.onUpdate = onUpdate;
    }

    public start() {
        this.isRunning = true;
        this.connect();
    }

    public stop() {
        this.isRunning = false;
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
    }

    private normalizePrice(raw: any): number | null {
        const n = typeof raw === 'string' ? Number(raw) : Number(raw);
        if (!Number.isFinite(n)) return null;
        // If price is already decimal (< 1), keep as-is. Otherwise treat as cents.
        const dec = n > 1 ? n / 100 : n;
        if (!Number.isFinite(dec)) return null;
        if (dec < 0 || dec > 1) return null;
        return Number(dec.toFixed(4));
    }

    private normalizeSize(raw: any): number | null {
        const n = typeof raw === 'string' ? Number(raw) : Number(raw);
        if (!Number.isFinite(n)) return null;
        return n;
    }

    private connect() {
        if (!this.isRunning) return;

        const timestamp = Date.now().toString();
        const method = "GET";
        const wsPath = "/trade-api/ws/v2";
        const msgString = timestamp + method + wsPath;

        let signature = "";
        try {
            const privateKey = process.env.KALSHI_PRIVATE_KEY || (() => {
                try {
                    return fs.readFileSync(process.env.KALSHI_KEY_PATH || '', 'utf-8');
                } catch {
                    return '';
                }
            })();

            if (!privateKey) {
                logger.error("\n[KalshiWS] Missing private key. Set KALSHI_PRIVATE_KEY or KALSHI_KEY_PATH.");
                // Retry later in case env is updated at runtime.
                setTimeout(() => this.connect(), 10000);
                return;
            }

            const sign = crypto.createSign('SHA256');
            sign.update(msgString);
            sign.end();

            signature = sign.sign({
                key: privateKey,
                padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
                saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST
            }, 'base64');
        } catch (e) {
            logger.error("\n[KalshiWS] Failed to generate RSA Signature.", e);
            return;
        }

        const ws = new WebSocket(`wss://api.elections.kalshi.com${wsPath}`, {
            headers: {
                'KALSHI-ACCESS-KEY': process.env.KALSHI_API_KEY || '',
                'KALSHI-ACCESS-SIGNATURE': signature,
                'KALSHI-ACCESS-TIMESTAMP': timestamp
            }
        });
        this.ws = ws;

        ws.on('open', () => {
            const subscribeMsg = {
                id: 1,
                cmd: "subscribe",
                params: { channels: ["orderbook_delta"], market_ticker: this.outcomeId }
            };
            ws.send(JSON.stringify(subscribeMsg));
        });

        ws.on('message', (data: WebSocket.RawData) => {
            try {
                const payload = JSON.parse(data.toString());

                if (payload.type === 'error') {
                    logger.error(`[KalshiWS] Error payload: ${JSON.stringify(payload)}`);
                    return;
                }

                if (payload.type === 'orderbook_snapshot') {
                    this.kalshiBooks.yes.clear();
                    this.kalshiBooks.no.clear();

                    const msg = payload.msg || {};
                    const yesArr = msg.yes_dollars_fp || [];
                    const noArr = msg.no_dollars_fp || [];

                    yesArr.forEach((b: any) => {
                        const price = this.normalizePrice(b[0]);
                        const size = this.normalizeSize(b[1]);
                        if (price === null || size === null) return;
                        this.kalshiBooks.yes.set(price, size);
                    });

                    noArr.forEach((b: any) => {
                        const price = this.normalizePrice(b[0]);
                        const size = this.normalizeSize(b[1]);
                        if (price === null || size === null) return;
                        this.kalshiBooks.no.set(price, size);
                    });

                    this.emitUpdate();
                }
                else if (payload.type === 'orderbook_delta') {
                    const msg = payload.msg || {};
                    const price = this.normalizePrice(msg.price_dollars || msg.price);
                    const delta = this.normalizeSize(msg.delta_fp || msg.delta);
                    const sideStr = (msg.side || "").toLowerCase();

                    if (price === null || delta === null) return;

                    const targetMap = sideStr === 'yes' ? this.kalshiBooks.yes :
                        sideStr === 'no' ? this.kalshiBooks.no : null;

                    if (targetMap) {
                        const currentSize = targetMap.get(price) || 0;
                        const newSize = currentSize + delta;

                        if (newSize <= 0) targetMap.delete(price);
                        else targetMap.set(price, newSize);

                        this.emitUpdate();
                    }
                }
            } catch (e) {
                // Silently swallow non-JSON pings
            }
        });

        const pingInterval = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) ws.ping();
        }, 10000);

        ws.on('close', () => {
            clearInterval(pingInterval);
            if (this.isRunning) setTimeout(() => this.connect(), 5000);
        });

        ws.on('error', (err) => {
            logger.error(`[KalshiWS] Socket error: ${err.message}`);
        });
    }

    private emitUpdate() {
        const deriveAsks = (oppositeBidsMap: Map<number, number>) => {
            return Array.from(oppositeBidsMap.entries())
                .map(([price, size]) => {
                    const askPrice = Number((1.00 - price).toFixed(4));
                    if (!Number.isFinite(askPrice) || askPrice < 0 || askPrice > 1) return null;
                    return { price: askPrice, size };
                })
                .filter((v: any) => v !== null)
                .sort((a: any, b: any) => a.price - b.price);
        };

        const yesBids = Array.from(this.kalshiBooks.yes.entries())
            .map(([price, size]) => ({ price, size })).sort((a, b) => b.price - a.price);

        const noBids = Array.from(this.kalshiBooks.no.entries())
            .map(([price, size]) => ({ price, size })).sort((a, b) => b.price - a.price);

        const completeBook = {
            yes: { bids: yesBids, asks: deriveAsks(this.kalshiBooks.no) },
            no: { bids: noBids, asks: deriveAsks(this.kalshiBooks.yes) }
        };

        this.onUpdate('Kalshi[WS]', completeBook);
    }
}
