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
// 2. The Pair Manager Class
class PairManager {
    private poly: Polymarket;
    private kalshi: Kalshi;

    private polyInternalId: string;
    private kalshiInternalId: string;

    // We now track BOTH token IDs for Polymarket
    private polyOutcomeIdYes: string | null = null;
    private polyOutcomeIdNo: string | null = null;
    private kalshiOutcomeId: string | null = null;

    // Our local, live-updating dual orderbooks
    private latestPolyBook: { yes: any, no: any } | null = null;
    private latestKalshiBook: { yes: any, no: any } | null = null;

    private isRunning: boolean = false;
    private pollIntervalMs: number = 2000;

    constructor(polyId: string, kalshiId: string) {
        this.polyInternalId = polyId;
        this.kalshiInternalId = kalshiId;

        this.poly = new Polymarket(); // Anonymous

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

            // Save both the YES (index 0) and NO (index 1) token IDs
            this.polyOutcomeIdYes = clobTokenIds[0];
            this.polyOutcomeIdNo = clobTokenIds[1];
            this.kalshiOutcomeId = this.kalshiInternalId;

            console.log(`[System] Beginning Dual-Orderbook Polling... \n`);
            this.isRunning = true;

            this.pollPoly();
            this.pollKalshi();

        } catch (error) {
            console.error(`[Error] Initialization failed:`, error);
        }
    }

    // --- Polymarket REST Polling Loop ---
    private async pollPoly() {
        if (!this.polyOutcomeIdYes || !this.polyOutcomeIdNo || !this.isRunning) return;

        try {
            // Fetch both books concurrently to save time
            const [yesResponse, noResponse] = await Promise.all([
                fetch(`https://clob.polymarket.com/book?token_id=${this.polyOutcomeIdYes}`),
                fetch(`https://clob.polymarket.com/book?token_id=${this.polyOutcomeIdNo}`)
            ]);

            const yesData = await yesResponse.json();
            const noData = await noResponse.json();

            // Helper to parse Poly strings to floats and sort
            const formatBook = (data: any) => ({
                bids: (data.bids || []).map((b: any) => ({ price: parseFloat(b.price), size: parseFloat(b.size) })).sort((a: any, b: any) => b.price - a.price),
                asks: (data.asks || []).map((a: any) => ({ price: parseFloat(a.price), size: parseFloat(a.size) })).sort((a: any, b: any) => a.price - b.price)
            });

            // Save our complete local state
            this.latestPolyBook = {
                yes: formatBook(yesData),
                no: formatBook(noData)
            };

            this.printState('Polymarket');
        } catch (error: any) {
            console.error(`\n[Poly Fetch Error]`, error.message || error);
        } finally {
            if (this.isRunning) setTimeout(() => this.pollPoly(), this.pollIntervalMs);
        }
    }

    // --- Kalshi REST Polling Loop ---
    private async pollKalshi() {
        if (!this.kalshiOutcomeId || !this.isRunning) return;

        try {
            const response = await fetch(`https://api.elections.kalshi.com/trade-api/v2/markets/${this.kalshiOutcomeId}/orderbook`);
            if (!response.ok) throw new Error(`Kalshi API HTTP ${response.status}`);

            const data = await response.json();

            // Kalshi gives us raw Bids for Yes and Bids for No. 
            const rawYesBids = (data.orderbook?.yes || []).map((b: any) => ({ price: b[0] / 100, size: b[1] }));
            const rawNoBids = (data.orderbook?.no || []).map((b: any) => ({ price: b[0] / 100, size: b[1] }));

            // We mathematically derive the Asks to build complete, standard books
            const deriveAsks = (oppositeBids: any[]) => oppositeBids.map(b => ({
                price: Number((1.00 - b.price).toFixed(2)),
                size: b.size
            })).sort((a, b) => a.price - b.price);

            this.latestKalshiBook = {
                yes: {
                    bids: rawYesBids.sort((a: any, b: any) => b.price - a.price),
                    asks: deriveAsks(rawNoBids) // Ask Yes = 1 - Bid No
                },
                no: {
                    bids: rawNoBids.sort((a: any, b: any) => b.price - a.price),
                    asks: deriveAsks(rawYesBids) // Ask No = 1 - Bid Yes
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
        if (!this.latestPolyBook || !this.latestKalshiBook) return;

        // ANSI Magic: If we've already drawn the dashboard once, move the cursor UP 
        // by the exact number of lines we printed, and clear everything below it.
        // This creates a static dashboard effect without clearing the whole console history.
        if (this.renderedLines > 0) {
            process.stdout.write(`\x1B[${this.renderedLines}A\x1B[J`);
        }

        // Helper to format price and volume cleanly (e.g., "94.0¢ [  5.2k]")
        const formatLevel = (lvl: any) => {
            if (!lvl) return "     ---    ".padEnd(17);
            const price = (lvl.price * 100).toFixed(1) + "¢";
            const size = lvl.size >= 1000 ? (lvl.size / 1000).toFixed(1) + "k" : Math.floor(lvl.size).toString();
            return `${price.padStart(5)} [${size.padStart(6)}]`.padEnd(17);
        };

        // Helper to construct a dual-sided orderbook block
        const renderBook = (title: string, poly: any, kalshi: any) => {
            let str = `  === ${title} ===\n`;
            str += `  EXCHANGE     |  POLYMARKET         |  KALSHI\n`;

            // Print top 3 Asks in reverse order (so the lowest/best Ask sits right above the spread line)
            for (let i = 2; i >= 0; i--) {
                str += `  Ask ${i + 1}        |  ${formatLevel(poly.asks[i])} |  ${formatLevel(kalshi.asks[i])}\n`;
            }
            str += `  -------------+---------------------+---------------------\n`;

            // Print top 3 Bids (so the highest/best Bid sits directly under the spread line)
            for (let i = 0; i < 3; i++) {
                str += `  Bid ${i + 1}        |  ${formatLevel(poly.bids[i])} |  ${formatLevel(kalshi.bids[i])}\n`;
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

        // Calculate exactly how many lines this string takes up so we know how far to move up next time
        this.renderedLines = output.split('\n').length - 1;

        // Print the block
        process.stdout.write(output);
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