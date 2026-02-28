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

    // --- ARBITRAGE THROTTLING & EXECUTION CONTROLS ---
    private lastArbitrageTime: number = 0;
    private readonly ARBITRAGE_COOLDOWN_MS: number = 10000; // 10s cooldown

    // Toggle for when we are ready to build live execution
    private readonly PAPER_TRADE_MODE: boolean = true;
    private readonly SIMULATED_LATENCY_MS: number = 1000; // 1 sec simulated execution delay

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
        // Guard Clause: Block subsequent triggers while execution/cooldown is happening
        if (now - this.lastArbitrageTime < this.ARBITRAGE_COOLDOWN_MS) return;

        const polyYesFirst = this.latestPolyBook.yes?.asks?.[0];
        const polyNoFirst = this.latestPolyBook.no?.asks?.[0];
        const kalshiYesFirst = this.latestKalshiBook.yes?.asks?.[0];
        const kalshiNoFirst = this.latestKalshiBook.no?.asks?.[0];

        const alignment = this.pairData.outcomeAlignment;

        // --- SCENARIO 1: Outcomes are Aligned (+1) ---
        if (alignment === 1) {
            if (polyYesFirst && kalshiNoFirst && (polyYesFirst.price + kalshiNoFirst.price < 0.97)) {
                this.lastArbitrageTime = now; // Lock immediately
                this.triggerExecution('PolyYes_KalshiNo', polyYesFirst, kalshiNoFirst);
                return;
            }
            if (polyNoFirst && kalshiYesFirst && (polyNoFirst.price + kalshiYesFirst.price < 0.97)) {
                this.lastArbitrageTime = now;
                this.triggerExecution('PolyNo_KalshiYes', polyNoFirst, kalshiYesFirst);
                return;
            }
        }
        // --- SCENARIO 2: Outcomes are Flipped (-1) ---
        else if (alignment === -1) {
            if (polyYesFirst && kalshiYesFirst && (polyYesFirst.price + kalshiYesFirst.price < 0.97)) {
                this.lastArbitrageTime = now;
                this.triggerExecution('PolyYes_KalshiYes_Flipped', polyYesFirst, kalshiYesFirst);
                return;
            }
            if (polyNoFirst && kalshiNoFirst && (polyNoFirst.price + kalshiNoFirst.price < 0.97)) {
                this.lastArbitrageTime = now;
                this.triggerExecution('PolyNo_KalshiNo_Flipped', polyNoFirst, kalshiNoFirst);
                return;
            }
        }
    }

    // Router for Paper vs Live Trading
    private triggerExecution(type: string, polyAskTarget: any, kalshiAskTarget: any) {
        if (this.PAPER_TRADE_MODE) {
            // Fire and forget the async paper trade simulation
            this.executePaperTrade(type, polyAskTarget, kalshiAskTarget);
        } else {
            // TODO: Plug in Live Execution Engine here later
            // e.g., ExecutionEngine.execute(type, pairData, polyAskTarget, kalshiAskTarget);
        }
    }

    // --- PAPER TRADING SIMULATOR ---
    private async executePaperTrade(type: string, detectedPolyAsk: any, detectedKalshiAsk: any) {
        const timeDetected = new Date().toISOString();
        const detectedSpread = (detectedPolyAsk.price + detectedKalshiAsk.price).toFixed(3);

        // 1. Simulate the delay of network requests, API rate limits, and cryptographic signing
        await new Promise(resolve => setTimeout(resolve, this.SIMULATED_LATENCY_MS));

        // 2. Fetch the fresh state of the books T+1000ms later
        let execPolyAsk: any = null;
        let execKalshiAsk: any = null;

        switch (type) {
            case 'PolyYes_KalshiNo':
                execPolyAsk = this.latestPolyBook.yes?.asks?.[0];
                execKalshiAsk = this.latestKalshiBook!.no?.asks?.[0];
                break;
            case 'PolyNo_KalshiYes':
                execPolyAsk = this.latestPolyBook.no?.asks?.[0];
                execKalshiAsk = this.latestKalshiBook!.yes?.asks?.[0];
                break;
            case 'PolyYes_KalshiYes_Flipped':
                execPolyAsk = this.latestPolyBook.yes?.asks?.[0];
                execKalshiAsk = this.latestKalshiBook!.yes?.asks?.[0];
                break;
            case 'PolyNo_KalshiNo_Flipped':
                execPolyAsk = this.latestPolyBook.no?.asks?.[0];
                execKalshiAsk = this.latestKalshiBook!.no?.asks?.[0];
                break;
        }

        // 3. Log the comparison to file
        this.logPaperTradeResult(timeDetected, type, detectedSpread, detectedPolyAsk, detectedKalshiAsk, execPolyAsk, execKalshiAsk);
    }

    private logPaperTradeResult(
        timeDetected: string,
        type: string,
        detectedSpread: string,
        detPoly: any, detKalshi: any,
        execPoly: any, execKalshi: any
    ) {
        const marketA = this.pairData.polyMarket.market_question;

        // Calculate realized spread. If orderbook emptied out completely, mark as FAILED
        let realizedSpreadStr = "FAILED (ORDERBOOK EMPTIED)";
        let successFlag = "❌ MISSED";

        if (execPoly && execKalshi) {
            const realizedSpread = execPoly.price + execKalshi.price;
            realizedSpreadStr = realizedSpread.toFixed(3);
            if (realizedSpread < 0.99) { // We still made some profit even if it slipped
                successFlag = "✅ CAPTURED";
            } else {
                successFlag = "⚠️ SLIPPED (UNPROFITABLE)";
            }
        }

        const msg = `
        ==================================================
        [${timeDetected}] PAPER TRADE TRIGGERED: ${type}
        Market: ${marketA.substring(0, 80)}...
            
        --- DETECTION (T=0) | Target Spread: ${detectedSpread} ---
        Poly   : ${detPoly.size.toString().padStart(6)} shares @ ${detPoly.price.toFixed(3)}
        Kalshi : ${detKalshi.size.toString().padStart(6)} shares @ ${detKalshi.price.toFixed(3)}
            
        --- EXECUTION (T+${this.SIMULATED_LATENCY_MS}ms) ---
        Poly   : ${execPoly ? execPoly.size.toString().padStart(6) + ' shares @ ' + execPoly.price.toFixed(3) : 'BOOK EMPTY'}
        Kalshi : ${execKalshi ? execKalshi.size.toString().padStart(6) + ' shares @ ' + execKalshi.price.toFixed(3) : 'BOOK EMPTY'}
            
        -> REALIZED SPREAD: ${realizedSpreadStr}  ${successFlag}
        ==================================================\n`;

        fs.appendFileSync('arbitrage_opportunities.txt', msg, 'utf8');
    }
}