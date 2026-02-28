import { PolymarketWS } from '../utils/exchanges/polymarket_ws.js';
import { KalshiWS } from '../utils/exchanges/kalshi_ws.js';
import { PortfolioManager } from '../portfolio/portfolio_manager.js';
import { RiskManager } from '../portfolio/risk_manager.js';
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
    public readonly pairId: string; // Unique ID for the portfolio ledger

    private polyWsClient: PolymarketWS | null = null;
    private kalshiWsClient: KalshiWS | null = null;

    // Global State Singletons passed from Orchestrator
    private portfolio: PortfolioManager;
    private risk: RiskManager;

    public latestPolyBook: { yes: any, no: any } = { yes: { bids: [], asks: [] }, no: { bids: [], asks: [] } };
    public latestKalshiBook: { yes: any, no: any } | null = null;

    private onUIUpdate: (() => void) | null = null;

    private lastArbitrageTime: number = 0;
    private readonly ARBITRAGE_COOLDOWN_MS: number = 10000;

    private readonly PAPER_TRADE_MODE: boolean = true;
    private readonly SIMULATED_LATENCY_MS: number = 1000;

    constructor(pair: CandidatePair, portfolio: PortfolioManager, risk: RiskManager) {
        this.pairData = pair;
        this.pairId = `${pair.polyMarket.internal_id}_${pair.kalshiMarket.internal_id}`;
        this.portfolio = portfolio;
        this.risk = risk;
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

                this.evaluateEntry();
                if (this.onUIUpdate) this.onUIUpdate();
            });

            this.kalshiWsClient = new KalshiWS(this.pairData.kalshiMarket.internal_id, (source, fullBook) => {
                this.latestKalshiBook = fullBook;

                this.evaluateEntry();
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

    // Renamed from evaluateArbitrage to evaluateEntry to prepare for evaluateExit
    private evaluateEntry() {
        if (!this.latestKalshiBook) return;

        const now = Date.now();
        if (now - this.lastArbitrageTime < this.ARBITRAGE_COOLDOWN_MS) return;

        const polyYesFirst = this.latestPolyBook.yes?.asks?.[0];
        const polyNoFirst = this.latestPolyBook.no?.asks?.[0];
        const kalshiYesFirst = this.latestKalshiBook.yes?.asks?.[0];
        const kalshiNoFirst = this.latestKalshiBook.no?.asks?.[0];

        const alignment = this.pairData.outcomeAlignment;

        if (alignment === 1) {
            if (polyYesFirst && kalshiNoFirst && (polyYesFirst.price + kalshiNoFirst.price < 0.97)) {
                this.processEntrySignal('PolyYes_KalshiNo', polyYesFirst, kalshiNoFirst);
                return;
            }
            if (polyNoFirst && kalshiYesFirst && (polyNoFirst.price + kalshiYesFirst.price < 0.97)) {
                this.processEntrySignal('PolyNo_KalshiYes', polyNoFirst, kalshiYesFirst);
                return;
            }
        } else if (alignment === -1) {
            if (polyYesFirst && kalshiYesFirst && (polyYesFirst.price + kalshiYesFirst.price < 0.97)) {
                this.processEntrySignal('PolyYes_KalshiYes_Flipped', polyYesFirst, kalshiYesFirst);
                return;
            }
            if (polyNoFirst && kalshiNoFirst && (polyNoFirst.price + kalshiNoFirst.price < 0.97)) {
                this.processEntrySignal('PolyNo_KalshiNo_Flipped', polyNoFirst, kalshiNoFirst);
                return;
            }
        }
    }

    private processEntrySignal(type: string, polyAskTarget: any, kalshiAskTarget: any) {
        const approvedSize = this.risk.calculateApprovedSize(
            this.pairId,
            polyAskTarget.price,
            kalshiAskTarget.price,
            polyAskTarget.size,
            kalshiAskTarget.size
        );

        if (approvedSize > 0) {
            this.lastArbitrageTime = Date.now(); // Lock cooldown

            if (this.PAPER_TRADE_MODE) {
                this.executePaperTrade(type, polyAskTarget, kalshiAskTarget, approvedSize);
            } else {
                // Future Live Execution
            }
        }
    }

    private async executePaperTrade(type: string, detectedPolyAsk: any, detectedKalshiAsk: any, approvedSize: number) {
        const timeDetected = new Date().toISOString();
        const detectedSpread = (detectedPolyAsk.price + detectedKalshiAsk.price).toFixed(3);

        // 1. Simulate Latency
        await new Promise(resolve => setTimeout(resolve, this.SIMULATED_LATENCY_MS));

        // 2. Fetch fresh orderbook state
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

        // 3. Evaluate Slippage & Final Fill Size
        let realizedSpreadStr = "FAILED (ORDERBOOK EMPTIED/MOVED)";
        let successFlag = "❌ MISSED";
        let filledSize = 0;

        if (execPolyAsk && execKalshiAsk) {
            const realizedSpread = execPolyAsk.price + execKalshiAsk.price;

            // If spread is still under 0.99, we execute
            if (realizedSpread <= 0.99) {
                // Re-calculate size in case liquidity dropped during the 1-second delay
                filledSize = Math.min(approvedSize, execPolyAsk.size, execKalshiAsk.size);

                if (filledSize > 0) {
                    realizedSpreadStr = realizedSpread.toFixed(3);
                    successFlag = "✅ CAPTURED";

                    // OPEN THE POSITION IN THE PORTFOLIO LEDGER
                    this.portfolio.openPosition(
                        this.pairId,
                        this.pairData.polyMarket.market_question,
                        type,
                        filledSize,
                        execPolyAsk.price,
                        execKalshiAsk.price
                    );
                }
            } else {
                realizedSpreadStr = `${realizedSpread.toFixed(3)} (TOO HIGH)`;
                successFlag = "⚠️ SLIPPED";
            }
        }

        // 4. Log the result
        const msg = `
==================================================
[${timeDetected}] PAPER TRADE TRIGGERED: ${type}
Market: ${this.pairData.polyMarket.market_question.substring(0, 80)}...
Approved Attempt Size: ${approvedSize} contracts

--- DETECTION (T=0) | Target Spread: ${detectedSpread} ---
Poly   : ${detectedPolyAsk.size.toString().padStart(6)} shares @ ${detectedPolyAsk.price.toFixed(3)}
Kalshi : ${detectedKalshiAsk.size.toString().padStart(6)} shares @ ${detectedKalshiAsk.price.toFixed(3)}

--- EXECUTION (T+${this.SIMULATED_LATENCY_MS}ms) ---
Poly   : ${execPolyAsk ? execPolyAsk.size.toString().padStart(6) + ' shares @ ' + execPolyAsk.price.toFixed(3) : 'BOOK EMPTY'}
Kalshi : ${execKalshiAsk ? execKalshiAsk.size.toString().padStart(6) + ' shares @ ' + execKalshiAsk.price.toFixed(3) : 'BOOK EMPTY'}

-> REALIZED SPREAD: ${realizedSpreadStr}  ${successFlag}
-> FILLED SIZE: ${filledSize}
==================================================\n`;

        fs.appendFileSync('arbitrage_opportunities.txt', msg, 'utf8');
    }
}