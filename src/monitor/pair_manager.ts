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
    public readonly pairId: string;

    private polyWsClient: PolymarketWS | null = null;
    private kalshiWsClient: KalshiWS | null = null;

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
                this.evaluateExit();
                if (this.onUIUpdate) this.onUIUpdate();
            });

            this.kalshiWsClient = new KalshiWS(this.pairData.kalshiMarket.internal_id, (source, fullBook) => {
                this.latestKalshiBook = fullBook;

                this.evaluateEntry();
                this.evaluateExit();
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

    // ==========================================
    // --- VWAP ENGINE ---
    // ==========================================
    private getKalshiTakerFee(price: number, size: number): number {
        const fee = 0.07 * size * price * (1 - price);
        return Math.ceil(fee * 100) / 100; // Kalshi rounds the total batch up to the nearest cent
    }

    private calculateSweep(
        polyLevels: any[], kalshiLevels: any[], isEntry: boolean, absoluteMax: number = Infinity
    ): { size: number, polyVwap: number, kalshiVwap: number, totalKalshiFees: number } {
        if (!polyLevels || !kalshiLevels) return { size: 0, polyVwap: 0, kalshiVwap: 0, totalKalshiFees: 0 };

        let pIdx = 0; let kIdx = 0;
        const pBook = polyLevels.map(l => ({ ...l }));
        const kBook = kalshiLevels.map(l => ({ ...l }));

        let totalShares = 0;
        let polyCost = 0;
        let kalshiCost = 0;
        let totalKalshiFees = 0;

        while (pIdx < pBook.length && kIdx < kBook.length && totalShares < absoluteMax) {
            const p = pBook[pIdx];
            const k = kBook[kIdx];

            // Approximate the fee for a single share to evaluate if this price level is profitable
            const kFeePerShare = 0.07 * k.price * (1 - k.price);

            // NET THRESHOLD CHECK (Including Fees)
            if (isEntry) {
                const netCostPerShare = p.price + k.price + kFeePerShare;
                // If it costs more than $0.985 to enter, it's not worth it. Break the sweep.
                if (netCostPerShare >= 0.985) break;
            } else {
                const netRevenuePerShare = p.price + k.price - kFeePerShare;
                // We will evaluate strict profitability against our specific entry cost later,
                // but we can set a hard floor here so we never sweep terrible bids.
                if (netRevenuePerShare < 0.97) break;
            }

            const overlap = Math.min(p.size, k.size);
            if (overlap <= 0) break;

            let safeTake = Math.floor(overlap / 2);
            safeTake = Math.min(safeTake, absoluteMax - totalShares);

            if (safeTake <= 0) break;

            totalShares += safeTake;
            polyCost += safeTake * p.price;
            kalshiCost += safeTake * k.price;

            // Accumulate the real batch fee
            totalKalshiFees += this.getKalshiTakerFee(k.price, safeTake);

            p.size -= overlap;
            k.size -= overlap;
            if (p.size <= 0) pIdx++;
            if (k.size <= 0) kIdx++;
        }

        return {
            size: totalShares,
            polyVwap: totalShares > 0 ? polyCost / totalShares : 0,
            kalshiVwap: totalShares > 0 ? kalshiCost / totalShares : 0,
            totalKalshiFees
        };
    }

    // ==========================================
    // --- ENTRY LOGIC ---
    // ==========================================
    private evaluateEntry() {
        if (!this.latestKalshiBook) return;
        const now = Date.now();
        if (now - this.lastArbitrageTime < this.ARBITRAGE_COOLDOWN_MS) return;

        const alignment = this.pairData.outcomeAlignment;

        if (alignment === 1) {
            this.checkAndTriggerEntry('PolyYes_KalshiNo', this.latestPolyBook.yes?.asks, this.latestKalshiBook.no?.asks);
            this.checkAndTriggerEntry('PolyNo_KalshiYes', this.latestPolyBook.no?.asks, this.latestKalshiBook.yes?.asks);
        } else if (alignment === -1) {
            this.checkAndTriggerEntry('PolyYes_KalshiYes_Flipped', this.latestPolyBook.yes?.asks, this.latestKalshiBook.yes?.asks);
            this.checkAndTriggerEntry('PolyNo_KalshiNo_Flipped', this.latestPolyBook.no?.asks, this.latestKalshiBook.no?.asks);
        }
    }

    private checkAndTriggerEntry(type: string, polyAsks: any[], kalshiAsks: any[]) {
        const sweep = this.calculateSweep(polyAsks, kalshiAsks, true);

        if (sweep.size > 0) {
            // Trick the RiskManager: We already halved the size in the sweeper, 
            // so we pass sweep.size * 2 into RiskManager so its internal halving returns our exact sweep size.
            const approvedSize = this.risk.calculateApprovedSize(
                this.pairId, sweep.polyVwap, sweep.kalshiVwap, sweep.size * 2, sweep.size * 2
            );

            if (approvedSize > 0) {
                this.lastArbitrageTime = Date.now();
                if (this.PAPER_TRADE_MODE) {
                    this.executePaperTrade(type, polyAsks, kalshiAsks, approvedSize, sweep.polyVwap + sweep.kalshiVwap);
                }
            }
        }
    }

    private async executePaperTrade(type: string, detectedPolyAsks: any[], detectedKalshiAsks: any[], approvedSize: number, detectedSpread: number) {
        const timeDetected = new Date().toISOString();
        await new Promise(resolve => setTimeout(resolve, this.SIMULATED_LATENCY_MS));

        let execPolyAsks: any[] = []; let execKalshiAsks: any[] = [];

        switch (type) {
            case 'PolyYes_KalshiNo': execPolyAsks = this.latestPolyBook.yes?.asks; execKalshiAsks = this.latestKalshiBook!.no?.asks; break;
            case 'PolyNo_KalshiYes': execPolyAsks = this.latestPolyBook.no?.asks; execKalshiAsks = this.latestKalshiBook!.yes?.asks; break;
            case 'PolyYes_KalshiYes_Flipped': execPolyAsks = this.latestPolyBook.yes?.asks; execKalshiAsks = this.latestKalshiBook!.yes?.asks; break;
            case 'PolyNo_KalshiNo_Flipped': execPolyAsks = this.latestPolyBook.no?.asks; execKalshiAsks = this.latestKalshiBook!.no?.asks; break;
        }

        // SWEEP THE FRESH ORDERBOOK AT T+1s
        const realSweep = this.calculateSweep(execPolyAsks, execKalshiAsks, true, approvedSize);

        let realizedSpreadStr = "FAILED (MOVED/EMPTIED)";
        let successFlag = "❌ MISSED";

        if (realSweep.size > 0) {
            const realizedSpread = realSweep.polyVwap + realSweep.kalshiVwap;
            // You can optionally add the fee to the spread calculation to strictly log the "net spread"
            const netSpread = realizedSpread + (realSweep.totalKalshiFees / realSweep.size);

            realizedSpreadStr = `${realizedSpread.toFixed(3)} (Net: ${netSpread.toFixed(3)})`;
            successFlag = "✅ CAPTURED";

            // STEP C: Pass realSweep.totalKalshiFees as the 7th argument!
            this.portfolio.openPosition(
                this.pairId, this.pairData.polyMarket.market_question, type,
                realSweep.size, realSweep.polyVwap, realSweep.kalshiVwap,
                realSweep.totalKalshiFees
            );
        }

        const msg = `
==================================================
[${timeDetected}] PAPER ENTRY: ${type}
Market: ${this.pairData.polyMarket.market_question.substring(0, 80)}...
Detection VWAP: ${detectedSpread.toFixed(3)} | Attempt Size: ${approvedSize}

--- EXECUTION (T+${this.SIMULATED_LATENCY_MS}ms) ---
-> REALIZED VWAP: ${realizedSpreadStr}  ${successFlag}
-> FILLED SIZE: ${realSweep.size}
==================================================\n`;

        fs.appendFileSync('arbitrage_opportunities.txt', msg, 'utf8');
    }

    // ==========================================
    // --- EXIT LOGIC ---
    // ==========================================
    private evaluateExit() {
        const position = this.portfolio.getPosition(this.pairId);
        if (!position || !this.latestKalshiBook) return;

        const now = Date.now();
        if (now - this.lastArbitrageTime < this.ARBITRAGE_COOLDOWN_MS) return;

        let targetPolyBids: any[] = []; let targetKalshiBids: any[] = [];

        switch (position.type) {
            case 'PolyYes_KalshiNo': targetPolyBids = this.latestPolyBook.yes?.bids; targetKalshiBids = this.latestKalshiBook.no?.bids; break;
            case 'PolyNo_KalshiYes': targetPolyBids = this.latestPolyBook.no?.bids; targetKalshiBids = this.latestKalshiBook.yes?.bids; break;
            case 'PolyYes_KalshiYes_Flipped': targetPolyBids = this.latestPolyBook.yes?.bids; targetKalshiBids = this.latestKalshiBook.yes?.bids; break;
            case 'PolyNo_KalshiNo_Flipped': targetPolyBids = this.latestPolyBook.no?.bids; targetKalshiBids = this.latestKalshiBook.no?.bids; break;
        }

        // SWEEP BIDS to check if we can sell profitably
        const sweep = this.calculateSweep(targetPolyBids, targetKalshiBids, false, position.size);

        if (sweep.size > 0) {
            this.lastArbitrageTime = now;
            if (this.PAPER_TRADE_MODE) {
                this.executePaperExit(position, targetPolyBids, targetKalshiBids, sweep.size, sweep.polyVwap + sweep.kalshiVwap);
            }
        }
    }

    private async executePaperExit(position: any, detectedPolyBids: any[], detectedKalshiBids: any[], approvedExitSize: number, detectedSpread: number) {
        const timeDetected = new Date().toISOString();
        await new Promise(resolve => setTimeout(resolve, this.SIMULATED_LATENCY_MS));

        let execPolyBids: any[] = []; let execKalshiBids: any[] = [];

        switch (position.type) {
            case 'PolyYes_KalshiNo': execPolyBids = this.latestPolyBook.yes?.bids; execKalshiBids = this.latestKalshiBook!.no?.bids; break;
            case 'PolyNo_KalshiYes': execPolyBids = this.latestPolyBook.no?.bids; execKalshiBids = this.latestKalshiBook!.yes?.bids; break;
            case 'PolyYes_KalshiYes_Flipped': execPolyBids = this.latestPolyBook.yes?.bids; execKalshiBids = this.latestKalshiBook!.yes?.bids; break;
            case 'PolyNo_KalshiNo_Flipped': execPolyBids = this.latestPolyBook.no?.bids; execKalshiBids = this.latestKalshiBook!.no?.bids; break;
        }

        // SWEEP FRESH BIDS AT T+1s
        const realSweep = this.calculateSweep(execPolyBids, execKalshiBids, false, approvedExitSize);

        let realizedBidStr = "FAILED (BUYERS DISAPPEARED)";
        let successFlag = "❌ MISSED EXIT";

        if (realSweep.size > 0) {
            // Include exit fees in the realized Vwap calculation for logging
            const exitFeePerShare = realSweep.totalKalshiFees / realSweep.size;
            const realizedBidVwap = realSweep.polyVwap + realSweep.kalshiVwap - exitFeePerShare;
            const entryCostPerShare = position.totalCost / position.size; // Use accurate cost basis

            if (realizedBidVwap > entryCostPerShare) {
                realizedBidStr = realizedBidVwap.toFixed(3);
                successFlag = "✅ PROFIT REALIZED";

                // STEP C: Pass realSweep.totalKalshiFees as the 5th argument!
                this.portfolio.closePosition(
                    this.pairId, realSweep.size,
                    realSweep.polyVwap, realSweep.kalshiVwap,
                    realSweep.totalKalshiFees
                );
            } else {
                realizedBidStr = `${realizedBidVwap.toFixed(3)} (TOO LOW)`;
                successFlag = "⚠️ SLIPPED (EXIT ABORTED to avoid loss)";
            }
        }

        const msg = `
==================================================
[${timeDetected}] PAPER EXIT: ${position.type}
Market: ${this.pairData.polyMarket.market_question.substring(0, 80)}...
Detection VWAP: ${detectedSpread.toFixed(3)} | Target Size: ${approvedExitSize}

--- EXECUTION (T+${this.SIMULATED_LATENCY_MS}ms) ---
-> REALIZED REVENUE VWAP: ${realizedBidStr}  ${successFlag}
-> SOLD SIZE: ${realSweep.size}
==================================================\n`;

        fs.appendFileSync('arbitrage_opportunities.txt', msg, 'utf8');
    }
}