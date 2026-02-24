import pmxt from 'pmxtjs';

// Define the structure based on pmxtjs docs
interface OrderLevel {
    price: number;
    size: number;
}

interface OrderBook {
    bids: OrderLevel[];
    asks: OrderLevel[];
    timestamp: number;
}

export class PairManager {
    private poly: any
    private kalshi: any;

    public polyOutcomeId: string;
    public kalshiOutcomeId: string;

    public latestPolyBook: OrderBook | null = null;
    public latestKalshiBook: OrderBook | null = null;

    constructor(
        polyExchange: any,
        kalshiExchange: any,
        polyOutcomeId: string,
        kalshiOutcomeId: string
    ) {
        // We pass the exchange instances in rather than creating them inside.
        // This prevents the "Boss" script from accidentally spinning up 
        // 10,000 separate sidecar servers later.
        this.poly = polyExchange;
        this.kalshi = kalshiExchange;
        this.polyOutcomeId = polyOutcomeId;
        this.kalshiOutcomeId = kalshiOutcomeId;
    }

    public async start() {
        console.log(`[Manager] Starting streams for Poly: ${this.polyOutcomeId} | Kalshi: ${this.kalshiOutcomeId}`);

        // We trigger both streams simultaneously without using 'await' 
        // so they run independently in the background.
        this.streamPoly();
        this.streamKalshi();
    }

    private async streamPoly() {
        while (true) {
            try {
                this.latestPolyBook = await this.poly.watchOrderBook(this.polyOutcomeId);
                this.printBooks(); // For testing: visually confirm updates
            } catch (error) {
                console.error(`[Poly Stream Error] ${this.polyOutcomeId}:`, error);
                // Self-healing: sleep for 2 seconds before attempting to reconnect
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }
    }

    private async streamKalshi() {
        while (true) {
            try {
                this.latestKalshiBook = await this.kalshi.watchOrderBook(this.kalshiOutcomeId);
                this.printBooks(); // For testing: visually confirm updates
            } catch (error) {
                console.error(`[Kalshi Stream Error] ${this.kalshiOutcomeId}:`, error);
                // Self-healing: sleep for 2 seconds before attempting to reconnect
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }
    }

    // A temporary helper to visualize the live orderbook in your terminal
    private printBooks() {
        if (!this.latestPolyBook || !this.latestKalshiBook) return;

        // Safely grab the top of the book (index 0), default to 0 if empty
        const polyBid = this.latestPolyBook.bids[0]?.price.toFixed(3) || '0.000';
        const polyAsk = this.latestPolyBook.asks[0]?.price.toFixed(3) || '0.000';

        const kalshiBid = this.latestKalshiBook.bids[0]?.price.toFixed(3) || '0.000';
        const kalshiAsk = this.latestKalshiBook.asks[0]?.price.toFixed(3) || '0.000';

        // Clears the console and overwrites the current line for a "live ticker" feel
        console.clear();
        console.log(`=== LIVE ORDERBOOK: Poly [${this.polyOutcomeId}] vs Kalshi [${this.kalshiOutcomeId}] ===\n`);
        console.log(`🔵 POLYMARKET | Best Bid: $${polyBid} | Best Ask: $${polyAsk}`);
        console.log(`🟢 KALSHI     | Best Bid: $${kalshiBid} | Best Ask: $${kalshiAsk}`);
        console.log(`\nWaiting for ticks... (Press Ctrl+C to exit)`);
    }
}

// =========================================
// TEST RUNNER (Execute this script directly)
// =========================================
async function testStandalone() {
    // 1. Initialize the shared exchanges
    const polyExchange = new pmxt.Polymarket();
    const kalshiExchange = new pmxt.Kalshi();

    // 2. Hardcode some known Outcome IDs to test (Replace these with real ones from your JSON)
    // Note: Polymarket uses long integer strings for outcomeIds (CLOB Token IDs).
    // Kalshi uses strings like 'KXNHL-26-VAN'.
    const testPolyOutcomeId = "10991849..."; // Replace with a real Poly outcomeId
    const testKalshiOutcomeId = "KXNHL-26-VAN"; // Replace with a real Kalshi outcomeId

    // 3. Create the manager and start it
    const manager = new PairManager(polyExchange, kalshiExchange, testPolyOutcomeId, testKalshiOutcomeId);
    await manager.start();
}

// Only run the test if this file is executed directly (not imported)
if (require.main === module) {
    testStandalone();
}