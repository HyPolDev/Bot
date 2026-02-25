import { PolymarketWS } from '../utils/exchanges/polymarket_ws.ts';
import { KalshiWS } from '../utils/exchanges/kalshi_ws.ts';

export interface UnifiedMarket {
    internal_id: string;
    platform: string;
    original_url_slug: string;
    market_question: string;
}

export interface CandidatePair {
    polyMarket: UnifiedMarket;
    kalshiMarket: UnifiedMarket;
    score: number;
    finalRankScore: number;
}

export class PairManager {
    public pairData: CandidatePair; // Public so the CLI can read the market question

    private polyWsClient: PolymarketWS | null = null;
    private kalshiWsClient: KalshiWS | null = null;

    // Public getters so the CLI can read the state anytime
    public latestPolyBook: { yes: any, no: any } = { yes: { bids: [], asks: [] }, no: { bids: [], asks: [] } };
    public latestKalshiBook: { yes: any, no: any } | null = null;

    // A callback the CLI can attach to trigger a screen re-render
    private onUIUpdate: (() => void) | null = null;

    constructor(pair: CandidatePair) {
        this.pairData = pair;
    }

    public async start() {
        try {
            const polyResponse = await fetch(`https://gamma-api.polymarket.com/markets/${this.pairData.polyMarket.internal_id}`);
            if (!polyResponse.ok) throw new Error(`Gamma API HTTP ${polyResponse.status}`);

            const polyMarketData = await polyResponse.json();
            const clobTokenIds = JSON.parse(polyMarketData.clobTokenIds);

            this.polyWsClient = new PolymarketWS(clobTokenIds[0], clobTokenIds[1], (source, updatedSide) => {
                if (updatedSide.isYes) this.latestPolyBook.yes = { bids: updatedSide.bids, asks: updatedSide.asks };
                else this.latestPolyBook.no = { bids: updatedSide.bids, asks: updatedSide.asks };

                // Trigger Arbitrage Evaluation here eventually
                // this.evaluateArbitrage();

                if (this.onUIUpdate) this.onUIUpdate(); // Tell the CLI to re-render
            });

            this.kalshiWsClient = new KalshiWS(this.pairData.kalshiMarket.internal_id, (source, fullBook) => {
                this.latestKalshiBook = fullBook;

                // Trigger Arbitrage Evaluation here eventually
                // this.evaluateArbitrage();

                if (this.onUIUpdate) this.onUIUpdate(); // Tell the CLI to re-render
            });

            this.polyWsClient.start();
            this.kalshiWsClient.start();

        } catch (error) {
            console.error(`[Error] Failed to start manager for ${this.pairData.polyMarket.internal_id}`, error);
        }
    }

    // CLI uses this to hook into the data stream
    public attachViewer(callback: () => void) {
        this.onUIUpdate = callback;
    }

    // CLI uses this to unhook when switching back to the menu
    public detachViewer() {
        this.onUIUpdate = null;
    }
}