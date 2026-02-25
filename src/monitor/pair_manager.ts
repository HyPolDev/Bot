import fs from 'fs';
import { Polymarket, Kalshi } from 'pmxtjs';
import pmxt from 'pmxtjs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import WebSocket from 'ws'; // <-- NEW: Native WebSockets

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
            this.pollKalshi(); // <-- Still on REST (for now)

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

    // --- Kalshi REST Polling Loop ---
    private async pollKalshi() {
        if (!this.kalshiOutcomeId || !this.isRunning) return;

        try {
            const response = await fetch(`https://api.elections.kalshi.com/trade-api/v2/markets/${this.kalshiOutcomeId}/orderbook`);
            if (!response.ok) throw new Error(`Kalshi API HTTP ${response.status}`);

            const data = await response.json();

            const rawYesBids = (data.orderbook?.yes || []).map((b: any) => ({ price: b[0] / 100, size: b[1] }));
            const rawNoBids = (data.orderbook?.no || []).map((b: any) => ({ price: b[0] / 100, size: b[1] }));

            const deriveAsks = (oppositeBids: any[]) => oppositeBids.map(b => ({
                price: Number((1.00 - b.price).toFixed(2)),
                size: b.size
            })).sort((a, b) => a.price - b.price);

            this.latestKalshiBook = {
                yes: {
                    bids: rawYesBids.sort((a: any, b: any) => b.price - a.price),
                    asks: deriveAsks(rawNoBids)
                },
                no: {
                    bids: rawNoBids.sort((a: any, b: any) => b.price - a.price),
                    asks: deriveAsks(rawYesBids)
                }
            };

            this.printState('Kalshi');
        } catch (error: any) {
            console.error(`\n[Kalshi Fetch Error]`, error.message || error);
        } finally {
            if (this.isRunning) setTimeout(() => this.pollKalshi(), this.pollIntervalMs);
        }
    }

    private renderedLines: number = 0;

    // --- Output Formatter ---
    private printState(source: string) {
        if (!this.latestKalshiBook) return; // Wait for Kalshi's first REST poll to finish

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