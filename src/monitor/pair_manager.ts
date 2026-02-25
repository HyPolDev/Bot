import fs from 'fs';
import { Polymarket, Kalshi } from 'pmxtjs';
import pmxt from 'pmxtjs'
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config({ override: true });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 1. Interfaces matching your JSON structure
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

    // PMXT requires the specific outcomeId for deep-dive operations
    private polyOutcomeId: string | null = null;
    private kalshiOutcomeId: string | null = null;

    private latestPolyBook: any | null = null;
    private latestKalshiBook: any | null = null;

    // Controls the polling loops
    private isRunning: boolean = false;
    private pollIntervalMs: number = 2000; // Poll every 2 seconds

    constructor(polyId: string, kalshiId: string) {
        this.polyInternalId = polyId;
        this.kalshiInternalId = kalshiId;

        // --- Polymarket (Anonymous Mode) ---
        // Orderbooks are public. Supplying a private key forces L2 proxy wallet derivation,
        // which fails if the wallet hasn't been initialized on-chain. We stay anonymous.
        this.poly = new Polymarket();

        // --- Kalshi (Auth Required) ---
        const kalshiOptions: any = {};
        if (process.env.KALSHI_API_KEY) {
            kalshiOptions.apiKey = process.env.KALSHI_API_KEY;
            console.log(`[Debug] Kalshi API Key Loaded: ${kalshiOptions.apiKey.substring(0, 5)}...`);
        } else {
            console.warn("[Warning] KALSHI_API_KEY not found in .env");
        }

        if (process.env.KALSHI_KEY_PATH && fs.existsSync(process.env.KALSHI_KEY_PATH)) {
            const rawKey = fs.readFileSync(process.env.KALSHI_KEY_PATH, 'utf-8');
            kalshiOptions.privateKey = rawKey;

            // Debug the key format (should start with -----BEGIN and have multiple lines)
            const isRSA = rawKey.includes('BEGIN RSA PRIVATE KEY');
            console.log(`[Debug] Kalshi RSA Key Loaded. Valid header format: ${isRSA}`);
            console.log(`[Debug] Kalshi RSA Key Length: ${rawKey.length} characters.`);
        } else {
            console.warn(`[Warning] Kalshi key file not found at ${process.env.KALSHI_KEY_PATH}`);
        }

        this.kalshi = new Kalshi(kalshiOptions);
    }

    public async start() {
        console.log(`[System] Initializing Pair Manager...`);
        console.log(`[System] Polymarket ID: ${this.polyInternalId} | Kalshi ID: ${this.kalshiInternalId}`);

        try {
            // Route around PMXT and fetch Polymarket data directly via Gamma API
            console.log(`[System] Fetching Polymarket Token IDs directly from Gamma API...`);
            const polyResponse = await fetch(`https://gamma-api.polymarket.com/markets/${this.polyInternalId}`);

            if (!polyResponse.ok) {
                throw new Error(`Gamma API failed with status: ${polyResponse.status}`);
            }

            const polyMarketData = await polyResponse.json();
            const clobTokenIds = JSON.parse(polyMarketData.clobTokenIds);
            console.log("[Debug] polymarket response data")
            console.log(polyMarketData)

            // Index 0 is standard for the "Yes" outcome
            this.polyOutcomeId = clobTokenIds[0];
            this.kalshiOutcomeId = this.kalshiInternalId;

            console.log(`[System] Poly Outcome ID: ${this.polyOutcomeId}`);
            console.log(`[System] Kalshi Outcome ID: ${this.kalshiOutcomeId}`);
            console.log(`[System] Beginning Orderbook Polling... \n`);

            this.isRunning = true;

            // Start the concurrent polling loops
            this.pollPoly();
            this.pollKalshi();

        } catch (error) {
            console.error(`[Error] Failed to initialize market data:`, error);
        }
    }

    // --- Polymarket REST Polling Loop ---
    // --- Polymarket REST Polling Loop ---
    // --- Polymarket REST Polling Loop (Native Fetch Override) ---
    // --- Polymarket REST Polling Loop (Native Fetch Override) ---
    private async pollPoly() {
        if (!this.polyOutcomeId || !this.isRunning) return;

        try {
            const response = await fetch(`https://clob.polymarket.com/book?token_id=${this.polyOutcomeId}`);

            if (!response.ok) {
                throw new Error(`CLOB API HTTP ${response.status}`);
            }

            const data = await response.json();

            // Map and sort Polymarket JSON. Prices and sizes are strings in the raw response.
            // Bids: Sort descending (highest price first)
            const sortedBids = (data.bids || [])
                .map((b: any) => ({ price: parseFloat(b.price), size: parseFloat(b.size) }))
                .sort((a: any, b: any) => b.price - a.price);

            // Asks: Sort ascending (lowest price first)
            const sortedAsks = (data.asks || [])
                .map((a: any) => ({ price: parseFloat(a.price), size: parseFloat(a.size) }))
                .sort((a: any, b: any) => a.price - b.price);

            this.latestPolyBook = {
                bids: sortedBids,
                asks: sortedAsks
            };

            this.printState('Polymarket');
        } catch (error: any) {
            console.error(`\n[Poly Fetch Error]`, error.message || error);
        } finally {
            if (this.isRunning) {
                setTimeout(() => this.pollPoly(), this.pollIntervalMs);
            }
        }
    }

    // --- Kalshi REST Polling Loop (Native Fetch Override) ---
    private async pollKalshi() {
        if (!this.kalshiOutcomeId || !this.isRunning) return;

        try {
            const response = await fetch(`https://api.elections.kalshi.com/trade-api/v2/markets/${this.kalshiOutcomeId}/orderbook`);

            if (!response.ok) {
                throw new Error(`Kalshi API HTTP ${response.status}`);
            }

            const data = await response.json();

            // Kalshi returns 'yes' and 'no' arrays containing [price_in_cents, quantity]
            // Bids for 'Yes' are in the 'yes' array. We sort descending to get the highest bid.
            const yesBids = (data.orderbook?.yes || [])
                .map((b: any) => ({ price: b[0] / 100, size: b[1] }))
                .sort((a: any, b: any) => b.price - a.price);

            // The Ask for 'Yes' is implied by the highest Bid for 'No' (1.00 - No_Bid = Yes_Ask)
            // We find the highest 'No' bid, then calculate the implied 'Yes' ask, and sort ascending.
            const yesAsks = (data.orderbook?.no || [])
                .map((b: any) => {
                    const noBidPrice = b[0] / 100;
                    const impliedYesAsk = 1.00 - noBidPrice;
                    // Format to 2 decimal places to avoid floating point weirdness like 0.06000000000000005
                    return { price: Number(impliedYesAsk.toFixed(2)), size: b[1] };
                })
                .sort((a: any, b: any) => a.price - b.price);

            this.latestKalshiBook = {
                bids: yesBids,
                asks: yesAsks
            };

            this.printState('Kalshi');
        } catch (error: any) {
            console.error(`\n[Kalshi Fetch Error]`, error.message || error);
        } finally {
            if (this.isRunning) {
                setTimeout(() => this.pollKalshi(), this.pollIntervalMs);
            }
        }
    }

    // --- Output Formatter ---
    private printState(source: string) {
        if (!this.latestPolyBook || !this.latestKalshiBook) {
            const missing = !this.latestPolyBook ? 'Polymarket' : 'Kalshi';
            process.stdout.write(`\r[Tick: ${source.padEnd(10)}] Still waiting on ${missing} to return data...      `);
            return;
        }

        const pBid = this.latestPolyBook.bids[0]?.price || 0;
        const pAsk = this.latestPolyBook.asks[0]?.price || 0;
        const kBid = this.latestKalshiBook.bids[0]?.price || 0;
        const kAsk = this.latestKalshiBook.asks[0]?.price || 0;

        process.stdout.write(
            `\r[Tick: ${source.padEnd(10)}] ` +
            `POLY | Bid: ${(pBid * 100).toFixed(1)}¢ Ask: ${(pAsk * 100).toFixed(1)}¢ || ` +
            `KALSHI | Bid: ${(kBid * 100).toFixed(1)}¢ Ask: ${(kAsk * 100).toFixed(1)}¢      `
        );
    }
}

// 3. Main Execution Bootstrapper
async function run() {
    const pairsFile = path.join(process.cwd(), 'src/test/__fixtures__/test_market_pairs.json');

    if (!fs.existsSync(pairsFile)) {
        console.error(`[Error] ${pairsFile} not found. Please run your matching script first.`);
        return;
    }

    const rawData = fs.readFileSync(pairsFile, 'utf-8');
    const pairs: CandidatePair[] = JSON.parse(rawData);

    if (pairs.length === 0) {
        console.log(`[System] No pairs found in the JSON file.`);
        return;
    }

    // Grab the very first pair for testing
    const testPair = pairs[0];

    // Create the manager using the internal IDs
    const manager = new PairManager(
        testPair.polyMarket.internal_id,
        testPair.kalshiMarket.internal_id
    );

    // Launch it
    await manager.start();
}

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n[System] Shutting down PMXT server...');
    await pmxt.stopServer();
    process.exit(0);
});

run();