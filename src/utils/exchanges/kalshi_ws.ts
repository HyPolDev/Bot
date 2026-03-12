import fs from 'fs';
import WebSocket from 'ws';
import crypto from 'crypto';

export class KalshiWS {
    private outcomeId: string;
    private isRunning: boolean = false;
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
            const privateKey = fs.readFileSync(process.env.KALSHI_KEY_PATH || '', 'utf-8');
            const sign = crypto.createSign('SHA256');
            sign.update(msgString);
            sign.end();

            signature = sign.sign({
                key: privateKey,
                padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
                saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST
            }, 'base64');
        } catch (e) {
            console.error("\n[KalshiWS] Failed to generate RSA Signature.");
            return;
        }

        const ws = new WebSocket(`wss://api.elections.kalshi.com${wsPath}`, {
            headers: {
                'KALSHI-ACCESS-KEY': process.env.KALSHI_API_KEY || '',
                'KALSHI-ACCESS-SIGNATURE': signature,
                'KALSHI-ACCESS-TIMESTAMP': timestamp
            }
        });

        ws.on('open', () => {
            const subscribeMsg = {
                id: 1,
                cmd: "subscribe",
                params: { channels: ["orderbook_delta"], market_tickers: [this.outcomeId] }
            };
            ws.send(JSON.stringify(subscribeMsg));
        });

        ws.on('message', (data: WebSocket.RawData) => {
            try {
                const payload = JSON.parse(data.toString());

                if (payload.type === 'error') return;

                if (payload.type === 'orderbook_snapshot') {
                    this.kalshiBooks.yes.clear();
                    this.kalshiBooks.no.clear();

                    const msg = payload.msg || {};
                    const yesArr = msg.yes || msg.orderbook?.yes || msg.orderbook_fp?.yes_dollars || [];
                    const noArr = msg.no || msg.orderbook?.no || msg.orderbook_fp?.no_dollars || [];

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
                    const price = this.normalizePrice(payload.msg?.price ?? payload.msg?.price_fp);
                    const delta = this.normalizeSize(payload.msg?.delta ?? payload.msg?.delta_fp);
                    const sideStr = (payload.msg?.side || "").toLowerCase();

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
            setTimeout(() => this.connect(), 5000);
        });

        ws.on('error', () => { });
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
                .sort((a, b) => a.price - b.price);
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
