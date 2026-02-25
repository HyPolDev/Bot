import fs from 'fs';
import { Polymarket, Kalshi } from 'pmxtjs';
import pmxt from 'pmxtjs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import WebSocket from 'ws';
import crypto from 'crypto';

dotenv.config({ override: true });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 1. Interfaces
interface UnifiedMarket {
    internal_id: string;
    platform: string;
    original_url_slug: string;
    market_question: string;
}

interface CandidatePair {
    polyMarket: UnifiedMarket;
    kalshiMarket: UnifiedMarket;
    score: number;
    finalRankScore: number;
}

// 2. The Pair Manager Class
class PairManager {
    private poly: Polymarket;
    private kalshi: Kalshi;

    private polyInternalId: string;
    private kalshiInternalId: string;

    private polyOutcomeIdYes: string | null = null;
    private polyOutcomeIdNo: string | null = null;
    private kalshiOutcomeId: string | null = null;

    // Local dashboard state (Initialized to empty arrays to prevent crashes)
    private latestPolyBook: { yes: any, no: any } = { yes: { bids: [], asks: [] }, no: { bids: [], asks: [] } };
    private latestKalshiBook: { yes: any, no: any } | null = null;

    // NEW: Delta Maps for lightning-fast WebSocket orderbook merging
    private polyBooks = {
        yes: { bids: new Map<number, number>(), asks: new Map<number, number>() },
        no: { bids: new Map<number, number>(), asks: new Map<number, number>() }
    };

    private kalshiBooks = {
        yes: new Map<number, number>(),
        no: new Map<number, number>()
    };

    private isRunning: boolean = false;
    private pollIntervalMs: number = 2000;

    constructor(polyId: string, kalshiId: string) {
        this.polyInternalId = polyId;
        this.kalshiInternalId = kalshiId;

        // PMXT is loaded and authenticated here. It is standing by to execute 
        // trade orders later, even though we are bypassing it for data fetching right now.
        this.poly = new Polymarket();

        const kalshiOptions: any = {};
        if (process.env.KALSHI_API_KEY) kalshiOptions.apiKey = process.env.KALSHI_API_KEY;
        if (process.env.KALSHI_KEY_PATH && fs.existsSync(process.env.KALSHI_KEY_PATH)) {
            kalshiOptions.privateKey = fs.readFileSync(process.env.KALSHI_KEY_PATH, 'utf-8');
        }
        this.kalshi = new Kalshi(kalshiOptions);
    }

    public async start() {
        console.log(`[System] Initializing Pair Manager...`);
        try {
            console.log(`[System] Fetching Polymarket Token IDs...`);
            const polyResponse = await fetch(`https://gamma-api.polymarket.com/markets/${this.polyInternalId}`);
            if (!polyResponse.ok) throw new Error(`Gamma API HTTP ${polyResponse.status}`);

            const polyMarketData = await polyResponse.json();
            const clobTokenIds = JSON.parse(polyMarketData.clobTokenIds);

            this.polyOutcomeIdYes = clobTokenIds[0];
            this.polyOutcomeIdNo = clobTokenIds[1];
            this.kalshiOutcomeId = this.kalshiInternalId;

            console.log(`[System] Beginning Dual-Orderbook Streams... \n`);
            this.isRunning = true;

            // Start the streams
            this.streamPoly(); // <-- Upgraded to WebSockets
            this.streamKalshi(); // <-- Still on REST (for now)

        } catch (error) {
            console.error(`[Error] Initialization failed:`, error);
        }
    }

    // --- Polymarket WEBSOCKET Stream (Lightning Fast) ---
    private streamPoly() {
        if (!this.polyOutcomeIdYes || !this.polyOutcomeIdNo || !this.isRunning) return;

        const ws = new WebSocket('wss://ws-subscriptions-clob.polymarket.com/ws/market');

        ws.on('open', () => {
            // Subscribe to both Yes and No token orderbooks
            const subscribeMsg = {
                assets_ids: [this.polyOutcomeIdYes, this.polyOutcomeIdNo],
                type: "market",
            };
            ws.send(JSON.stringify(subscribeMsg));
        });

        ws.on('message', (data: WebSocket.RawData) => {
            const rawMsg = data.toString();

            // Intercept heartbeat responses before JSON parsing
            if (rawMsg === "PONG") return;

            try {
                const msg = JSON.parse(rawMsg);

                // 1. Initial Snapshot: Overwrite the whole book
                if (msg.event_type === 'book') {
                    const isYes = msg.asset_id === this.polyOutcomeIdYes;
                    const targetMap = isYes ? this.polyBooks.yes : this.polyBooks.no;

                    targetMap.bids.clear();
                    targetMap.asks.clear();

                    msg.bids.forEach((b: any) => targetMap.bids.set(parseFloat(b.price), parseFloat(b.size)));
                    msg.asks.forEach((a: any) => targetMap.asks.set(parseFloat(a.price), parseFloat(a.size)));

                    this.updatePolyDashboard(isYes);
                }

                // 2. Real-Time Deltas: Merge changes into the book
                else if (msg.event_type === 'price_change') {
                    let updatedYes = false;
                    let updatedNo = false;

                    msg.price_changes.forEach((change: any) => {
                        const isYes = change.asset_id === this.polyOutcomeIdYes;
                        const targetMap = isYes ? this.polyBooks.yes : this.polyBooks.no;

                        const price = parseFloat(change.price);
                        const size = parseFloat(change.size);
                        const mapToUpdate = change.side === 'BUY' ? targetMap.bids : targetMap.asks;

                        // If size is 0, the order was cancelled or filled. Remove it.
                        if (size === 0) {
                            mapToUpdate.delete(price);
                        } else {
                            mapToUpdate.set(price, size);
                        }

                        if (isYes) updatedYes = true;
                        else updatedNo = true;
                    });

                    if (updatedYes) this.updatePolyDashboard(true);
                    if (updatedNo) this.updatePolyDashboard(false);
                }
            } catch (e) {
                // If Polymarket sends any other non-JSON weirdness, catch it safely
                console.error("[System] Failed to parse Poly message:", rawMsg);
            }
        });

        // Polymarket drops connections if it doesn't hear a heartbeat every 10 seconds
        const pingInterval = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) ws.send("PING");
        }, 10000);

        ws.on('close', () => {
            clearInterval(pingInterval);
            // Self-Healing: Reconnect instantly if the websocket drops
            setTimeout(() => this.streamPoly(), 500);
        });

        ws.on('error', () => {
            // Silently swallow network blips to prevent terminal crashes
        });
    }

    // Helper to format the Poly Maps back into arrays for the dashboard
    private updatePolyDashboard(isYes: boolean) {
        const targetMap = isYes ? this.polyBooks.yes : this.polyBooks.no;

        const bids = Array.from(targetMap.bids.entries())
            .map(([price, size]) => ({ price, size }))
            .sort((a, b) => b.price - a.price); // Descending (Best Bid first)

        const asks = Array.from(targetMap.asks.entries())
            .map(([price, size]) => ({ price, size }))
            .sort((a, b) => a.price - b.price); // Ascending (Best Ask first)

        if (isYes) {
            this.latestPolyBook.yes = { bids, asks };
        } else {
            this.latestPolyBook.no = { bids, asks };
        }

        // Instantly update the terminal
        this.printState('Poly[WS]');
    }

    // --- Kalshi WEBSOCKET Stream (Lightning Fast) ---
    // --- Kalshi WEBSOCKET Stream (Lightning Fast) ---
    private streamKalshi() {
        if (!this.kalshiOutcomeId || !this.isRunning) return;

        // 1. Generate the Kalshi V2 Authentication Cryptography
        const timestamp = Date.now().toString();
        const method = "GET";
        const wsPath = "/trade-api/ws/v2"; // <-- FIXED 404 URL PATH
        const msgString = timestamp + method + wsPath;

        let signature = "";
        try {
            const privateKey = fs.readFileSync(process.env.KALSHI_KEY_PATH || '', 'utf-8');
            const sign = crypto.createSign('SHA256');
            sign.update(msgString);
            sign.end();

            // Kalshi requires strict RSA-PSS padding
            signature = sign.sign({
                key: privateKey,
                padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
                saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST
            }, 'base64');
        } catch (e) {
            console.error("\n[System] Failed to generate Kalshi RSA Signature. Check your private key path.");
            return;
        }

        // 2. Connect with Full Auth Headers
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
                params: {
                    channels: ["orderbook_delta"],
                    market_tickers: [this.kalshiOutcomeId]
                }
            };
            ws.send(JSON.stringify(subscribeMsg));
        });

        ws.on('message', (data: WebSocket.RawData) => {
            try {
                const payload = JSON.parse(data.toString());

                // LOUD ERROR: Catch Kalshi explicitly rejecting our subscription
                if (payload.type === 'error') {
                    console.error(`\n[Kalshi WS Error] Code: ${payload.msg?.code} | Msg: ${payload.msg?.msg}`);
                    return;
                }

                if (payload.type === 'orderbook_snapshot') {
                    this.kalshiBooks.yes.clear();
                    this.kalshiBooks.no.clear();

                    (payload.msg.yes || []).forEach((b: any) => this.kalshiBooks.yes.set(b[0] / 100, b[1]));
                    (payload.msg.no || []).forEach((b: any) => this.kalshiBooks.no.set(b[0] / 100, b[1]));

                    this.updateKalshiDashboard();
                }
                else if (payload.type === 'orderbook_delta') {
                    const price = payload.msg.price / 100;
                    const delta = payload.msg.delta;
                    const sideStr = (payload.msg.side || "").toLowerCase();

                    const targetMap = sideStr === 'yes' ? this.kalshiBooks.yes :
                        sideStr === 'no' ? this.kalshiBooks.no : null;

                    if (targetMap) {
                        const currentSize = targetMap.get(price) || 0;
                        const newSize = currentSize + delta;

                        if (newSize <= 0) targetMap.delete(price);
                        else targetMap.set(price, newSize);

                        this.updateKalshiDashboard();
                    }
                }
            } catch (e) {
                // Silently swallow non-JSON pings
            }
        });

        const pingInterval = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) ws.ping(); // Kalshi expects a native 0x9 frame
        }, 10000);

        ws.on('close', (code, reason) => {
            clearInterval(pingInterval);
            if (code !== 1000) { // Log unexpected drops
                console.error(`\n[Kalshi WS Closed] Code: ${code} Reason: ${reason.toString() || 'Unknown'}`);
            }
            setTimeout(() => this.streamKalshi(), 5000);
        });

        ws.on('error', (err) => {
            console.error(`\n[Kalshi WS Network Error]`, err.message);
        });
    }

    // Helper to format the Kalshi Maps and derive Asks for the dashboard
    private updateKalshiDashboard() {
        // Derive asks by subtracting the opposite side's bid from $1.00
        const deriveAsks = (oppositeBidsMap: Map<number, number>) => {
            return Array.from(oppositeBidsMap.entries())
                .map(([price, size]) => ({ price: Number((1.00 - price).toFixed(2)), size }))
                .sort((a, b) => a.price - b.price); // Ascending (Best Ask first)
        };

        const yesBids = Array.from(this.kalshiBooks.yes.entries())
            .map(([price, size]) => ({ price, size }))
            .sort((a, b) => b.price - a.price); // Descending (Best Bid first)

        const noBids = Array.from(this.kalshiBooks.no.entries())
            .map(([price, size]) => ({ price, size }))
            .sort((a, b) => b.price - a.price); // Descending (Best Bid first)

        this.latestKalshiBook = {
            yes: { bids: yesBids, asks: deriveAsks(this.kalshiBooks.no) },
            no: { bids: noBids, asks: deriveAsks(this.kalshiBooks.yes) }
        };

        this.printState('Kalshi[WS]');
    }

    private renderedLines: number = 0;

    // --- Output Formatter ---
    private printState(source: string) {
        // UN-FROZEN: Draw Polymarket even if Kalshi is dead
        if (!this.latestKalshiBook) {
            process.stdout.write(`\r[Tick: ${source.padEnd(10)}] Poly connected. Waiting on Kalshi...      `);
            return;
        }

        if (this.renderedLines > 0) {
            process.stdout.write(`\x1B[${this.renderedLines}A\x1B[J`);
        }

        const formatLevel = (lvl: any) => {
            if (!lvl) return "     ---    ".padEnd(17);
            const price = (lvl.price * 100).toFixed(1) + "¢";
            const size = lvl.size >= 1000 ? (lvl.size / 1000).toFixed(1) + "k" : Math.floor(lvl.size).toString();
            return `${price.padStart(5)} [${size.padStart(6)}]`.padEnd(17);
        };

        const renderBook = (title: string, poly: any, kalshi: any) => {
            let str = `  === ${title} ===\n`;
            str += `  EXCHANGE     |  POLYMARKET        |  KALSHI\n`;

            for (let i = 2; i >= 0; i--) {
                str += `  Ask ${i + 1}        |  ${formatLevel(poly?.asks[i])} |  ${formatLevel(kalshi?.asks[i])}\n`;
            }
            str += `  -------------+--------------------+---------------------\n`;

            for (let i = 0; i < 3; i++) {
                str += `  Bid ${i + 1}        |  ${formatLevel(poly?.bids[i])} |  ${formatLevel(kalshi?.bids[i])}\n`;
            }
            return str;
        };

        let output = `\n=============================================================\n`;
        output += ` TICK: ${source.padEnd(10)} | ARBITRAGER LIVE DASHBOARD\n`;
        output += `=============================================================\n`;
        output += renderBook('YES OUTCOME', this.latestPolyBook.yes, this.latestKalshiBook.yes);
        output += `\n`;
        output += renderBook('NO OUTCOME', this.latestPolyBook.no, this.latestKalshiBook.no);
        output += `=============================================================\n`;

        this.renderedLines = output.split('\n').length - 1;
        process.stdout.write(output);
    }
}

// 3. Main Execution Bootstrapper
async function run() {
    const pairsFile = path.join(process.cwd(), 'src/test/__fixtures__/test_market_pairs.json');

    if (!fs.existsSync(pairsFile)) {
        console.error(`[Error] ${pairsFile} not found.`);
        return;
    }

    const rawData = fs.readFileSync(pairsFile, 'utf-8');
    const pairs: CandidatePair[] = JSON.parse(rawData);

    if (pairs.length === 0) return;

    const testPair = pairs[0];

    const manager = new PairManager(
        testPair.polyMarket.internal_id,
        testPair.kalshiMarket.internal_id
    );

    await manager.start();
}

process.on('SIGINT', async () => {
    console.log('\n[System] Shutting down PMXT server...');
    await pmxt.stopServer();
    process.exit(0);
});

run();