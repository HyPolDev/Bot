import { PolymarketWS } from '../utils/exchanges/polymarket_ws.js';
import { KalshiWS } from '../utils/exchanges/kalshi_ws.js';
import fs from 'fs';

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

    // --- ARBITRAGE THROTTLING CONTROLS ---
    private lastArbitrageTime: number = 0;
    private readonly ARBITRAGE_COOLDOWN_MS: number = 10000; // 10 seconds

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

                this.evaluateArbitrage();

                if (this.onUIUpdate) this.onUIUpdate();
            });

            this.kalshiWsClient = new KalshiWS(this.pairData.kalshiMarket.internal_id, (source, fullBook) => {
                this.latestKalshiBook = fullBook;

                this.evaluateArbitrage();

                if (this.onUIUpdate) this.onUIUpdate();
            });

            this.polyWsClient.start();
            this.kalshiWsClient.start();

        } catch (error) {
            console.error(`[Error] Failed to start manager for ${this.pairData.polyMarket.internal_id}`, error);
        }
    }

    public attachViewer(callback: () => void) {
        this.onUIUpdate = callback;
    }

    public detachViewer() {
        this.onUIUpdate = null;
    }

    private evaluateArbitrage() {
        if (!this.latestKalshiBook) return;

        const now = Date.now();
        // 1. Guard Clause: If we are still in cooldown, exit immediately to save CPU
        if (now - this.lastArbitrageTime < this.ARBITRAGE_COOLDOWN_MS) {
            return;
        }

        const polyYesAsks = this.latestPolyBook.yes?.asks || [];
        const polyNoAsks = this.latestPolyBook.no?.asks || [];
        const kalshiYesAsks = this.latestKalshiBook.yes?.asks || [];
        const kalshiNoAsks = this.latestKalshiBook.no?.asks || [];

        const polyYesFirst = polyYesAsks[0];
        const polyNoFirst = polyNoAsks[0];
        const kalshiYesFirst = kalshiYesAsks[0];
        const kalshiNoFirst = kalshiNoAsks[0];

        // Polymarket 1st layer of yes asks + kalshi 1st layer of no asks < 0.97
        if (polyYesFirst && kalshiNoFirst) {
            const combinedPrice = polyYesFirst.price + kalshiNoFirst.price;
            if (combinedPrice < 0.97) {
                this.logArbitrageOpportunity('PolyYes_KalshiNo', polyYesFirst, kalshiNoFirst);
                this.lastArbitrageTime = now; // 2. Lock the cooldown
                return; // Exit so we don't accidentally double-fire the inverse trade
            }
        }

        // Polymarket 1st layer of no asks + kalshi 1st layer of yes asks < 0.97
        if (polyNoFirst && kalshiYesFirst) {
            const combinedPrice = polyNoFirst.price + kalshiYesFirst.price;
            if (combinedPrice < 0.97) {
                this.logArbitrageOpportunity('PolyNo_KalshiYes', polyNoFirst, kalshiYesFirst);
                this.lastArbitrageTime = now; // 2. Lock the cooldown
            }
        }
    }

    private logArbitrageOpportunity(type: 'PolyYes_KalshiNo' | 'PolyNo_KalshiYes', polyAsk: any, kalshiAsk: any) {
        const time = new Date().toISOString();
        const marketA = this.pairData.polyMarket.market_question;
        const marketB = this.pairData.kalshiMarket.market_question;

        let msg = '';
        if (type === 'PolyYes_KalshiNo') {
            msg = `[arbitrage oportunity detected at "${time}" between markets [${marketA}, ${marketB}], ${polyAsk.size} yes asks at ${polyAsk.price} price in polygon, ${kalshiAsk.size} no asks at ${kalshiAsk.price} price in kalshi]\n`;
        } else {
            msg = `[arbitrage oportunity detected at "${time}" between markets [${marketA}, ${marketB}], ${kalshiAsk.size} yes asks at ${kalshiAsk.price} price in kalshi, ${polyAsk.size} no asks at ${polyAsk.price} price in polygon]\n`;
        }

        fs.appendFileSync('arbitrage_opportunities.txt', msg, 'utf8');
    }
}