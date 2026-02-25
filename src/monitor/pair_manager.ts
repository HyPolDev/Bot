import fs from 'fs';
import pmxt from 'pmxtjs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 1. Interfaces matching your JSON structure
interface UnifiedMarket {
    internal_id: string;
    platform: string;
    original_url_slug: string; // We will use this to search Polymarket
    market_question: string;
}

interface CandidatePair {
    polyMarket: UnifiedMarket;
    kalshiMarket: UnifiedMarket;
    score: number;
}

// 2. The Pair Manager Class
class PairManager {
    private poly: pmxt.Polymarket;
    private kalshi: pmxt.Kalshi;

    private polyMarketSlug: string;
    private kalshiInternalId: string;

    // PMXT requires the specific outcomeId for deep-dive operations
    private polyOutcomeId: string | null = null;
    private kalshiOutcomeId: string | null = null;

    private latestPolyBook: pmxt.OrderBook | null = null;
    private latestKalshiBook: pmxt.OrderBook | null = null;

    // Controls the polling loops
    private isRunning: boolean = false;
    private pollIntervalMs: number = 2000; // Poll every 2 seconds

    constructor(polySlug: string, kalshiId: string) {
        this.polyMarketSlug = polySlug;
        this.kalshiInternalId = kalshiId;

        // Initialize the exchanges (this automatically starts the background PMXT server)
        this.poly = new pmxt.Polymarket();
        this.kalshi = new pmxt.Kalshi();
    }

    public async start() {
        console.log(`[System] Initializing Pair Manager...`);
        console.log(`[System] Polymarket Slug: ${this.polyMarketSlug} | Kalshi ID: ${this.kalshiInternalId}`);

        try {
            // Step A: Fetch the full market data to get the correct outcome IDs
            // For Polymarket, we search by slug
            const polyResults = await this.poly.fetchMarkets({ slug: this.polyMarketSlug });
            if (!polyResults || polyResults.length === 0) {
                throw new Error(`Polymarket market not found for slug: ${this.polyMarketSlug}`);
            }
            const polyMarket = polyResults[0];

            // For Kalshi, we can use the internal_id directly as the outcomeId for the orderbook
            // (The documentation notes that the Kalshi market ticker IS the outcomeId)
            this.kalshiOutcomeId = this.kalshiInternalId;

            // Polymarket requires extracting the specific CLOB Token ID from the outcomes array
            this.polyOutcomeId = polyMarket.outcomes[0].id;

            console.log(`[System] Successfully mapped outcome IDs. Beginning Orderbook Polling... \n`);

            this.isRunning = true;

            // Step B: Start the concurrent polling loops in the background
            this.pollPoly();
            this.pollKalshi();

        } catch (error) {
            console.error(`[Error] Failed to initialize market data:`, error);
        }
    }

    // --- Polymarket REST Polling Loop ---
    private async pollPoly() {
        if (!this.polyOutcomeId || !this.isRunning) return;

        try {
            this.latestPolyBook = await this.poly.fetchOrderBook(this.polyOutcomeId);
            this.printState('Polymarket');
        } catch (error) {
            // Silently catch transient network errors so the loop doesn't crash
        } finally {
            if (this.isRunning) {
                setTimeout(() => this.pollPoly(), this.pollIntervalMs);
            }
        }
    }

    // --- Kalshi REST Polling Loop ---
    private async pollKalshi() {
        if (!this.kalshiOutcomeId || !this.isRunning) return;

        try {
            this.latestKalshiBook = await this.kalshi.fetchOrderBook(this.kalshiOutcomeId);
            this.printState('Kalshi');
        } catch (error) {
            // Silently catch transient network errors
        } finally {
            if (this.isRunning) {
                setTimeout(() => this.pollKalshi(), this.pollIntervalMs);
            }
        }
    }

    // --- Output Formatter ---
    private printState(source: string) {
        // Ensure we have data for both before printing to avoid confusing logs
        if (!this.latestPolyBook || !this.latestKalshiBook) return;

        // Safely extract the best bid and ask, defaulting to 0 if the book is empty
        const pBid = this.latestPolyBook.bids[0]?.price || 0;
        const pAsk = this.latestPolyBook.asks[0]?.price || 0;
        const kBid = this.latestKalshiBook.bids[0]?.price || 0;
        const kAsk = this.latestKalshiBook.asks[0]?.price || 0;

        // Using process.stdout.write with a carriage return (\r) to update the console in place 
        process.stdout.write(
            `\r[Tick: ${source.padEnd(10)}] ` +
            `POLY | Bid: ${(pBid * 100).toFixed(1)}¢ Ask: ${(pAsk * 100).toFixed(1)}¢ || ` +
            `KALSHI | Bid: ${(kBid * 100).toFixed(1)}¢ Ask: ${(kAsk * 100).toFixed(1)}¢      `
        );
    }
}

// 3. Main Execution Bootstrapper
async function run() {

    //const DATA_DIR = path.posix.join(process.cwd(), 'data');
    //const pairsFile = path.posix.join(DATA_DIR, 'market_pairs.json');

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

    // Create the manager using the URL slug for Poly and the internal ID (ticker) for Kalshi
    const manager = new PairManager(
        testPair.polyMarket.original_url_slug,
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