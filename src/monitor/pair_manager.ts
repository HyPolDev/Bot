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
    finalRankScore?: number;
    outcomeAlignment: 1 | -1;
}

export class PairManager {
    public pairData: CandidatePair;

    private polyWsClient: PolymarketWS | null = null;
    private kalshiWsClient: KalshiWS | null = null;

    public latestPolyBook: { yes: any, no: any } = { yes: { bids: [], asks: [] }, no: { bids: [], asks: [] } };
    public latestKalshiBook: { yes: any, no: any } | null = null;

    private onUIUpdate: (() => void) | null = null;

    private lastArbitrageTime: number = 0;
    private readonly ARBITRAGE_COOLDOWN_MS: number = 10000;

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
        if (now - this.lastArbitrageTime < this.ARBITRAGE_COOLDOWN_MS) return;

        const polyYesFirst = this.latestPolyBook.yes?.asks?.[0];
        const polyNoFirst = this.latestPolyBook.no?.asks?.[0];
        const kalshiYesFirst = this.latestKalshiBook.yes?.asks?.[0];
        const kalshiNoFirst = this.latestKalshiBook.no?.asks?.[0];

        const alignment = this.pairData.outcomeAlignment;

        // --- SCENARIO 1: Outcomes are Aligned (+1) ---
        if (alignment === 1) {
            // Poly Yes Ask + Kalshi No Ask
            if (polyYesFirst && kalshiNoFirst && (polyYesFirst.price + kalshiNoFirst.price < 0.97)) {
                this.logArbitrageOpportunity('PolyYes_KalshiNo', polyYesFirst, kalshiNoFirst);
                this.lastArbitrageTime = now;
                return;
            }
            // Poly No Ask + Kalshi Yes Ask
            if (polyNoFirst && kalshiYesFirst && (polyNoFirst.price + kalshiYesFirst.price < 0.97)) {
                this.logArbitrageOpportunity('PolyNo_KalshiYes', polyNoFirst, kalshiYesFirst);
                this.lastArbitrageTime = now;
            }
        }
        // --- SCENARIO 2: Outcomes are Flipped (-1) ---
        else if (alignment === -1) {
            // Because outcomes are flipped, Poly Yes = Kalshi No. 
            // Therefore, a hedge requires buying Poly Yes AND Kalshi Yes.
            if (polyYesFirst && kalshiYesFirst && (polyYesFirst.price + kalshiYesFirst.price < 0.97)) {
                this.logArbitrageOpportunity('PolyYes_KalshiYes (Flipped)', polyYesFirst, kalshiYesFirst);
                this.lastArbitrageTime = now;
                return;
            }
            // The inverse hedge: Poly No AND Kalshi No
            if (polyNoFirst && kalshiNoFirst && (polyNoFirst.price + kalshiNoFirst.price < 0.97)) {
                this.logArbitrageOpportunity('PolyNo_KalshiNo (Flipped)', polyNoFirst, kalshiNoFirst);
                this.lastArbitrageTime = now;
            }
        }
    }

    private logArbitrageOpportunity(type: string, polyAsk: any, kalshiAsk: any) {
        const time = new Date().toISOString();
        const marketA = this.pairData.polyMarket.market_question;
        const marketB = this.pairData.kalshiMarket.market_question;

        const msg = `[${time}] ARBITRAGE DETECTED [Spread: ${(polyAsk.price + kalshiAsk.price).toFixed(3)}]
        Type: ${type}
        Poly   : ${polyAsk.size} shares @ ${polyAsk.price} | ${marketA}
        Kalshi : ${kalshiAsk.size} shares @ ${kalshiAsk.price} | ${marketB}
        --------------------------------------------------\n`;

        fs.appendFileSync('arbitrage_opportunities.txt', msg, 'utf8');
    }
}