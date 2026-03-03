import { PolymarketWS } from '../utils/exchanges/polymarket_ws.js';
import { KalshiWS } from '../utils/exchanges/kalshi_ws.js';
import { PortfolioManager } from '../portfolio/portfolio_manager.js';
import { RiskManager } from '../portfolio/risk_manager.js';
import { LiveEngine } from '../execution/live_engine.js'; // <-- 1. IMPORT ADDED
import fs from 'fs';

export interface UnifiedMarket {
    internal_id: string;
    platform: string;
    original_url_slug: string;
    market_question: string;
    market_rules: string;
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
    private liveEngine: LiveEngine; // <-- 2. ENGINE ADDED

    // <-- 3. TOKEN IDs ADDED (Required for Polymarket live orders)
    private polyYesTokenId: string = '';
    private polyNoTokenId: string = '';

    public latestPolyBook: { yes: any, no: any } = { yes: { bids: [], asks: [] }, no: { bids: [], asks: [] } };
    public latestKalshiBook: { yes: any, no: any } | null = null;

    private ghostLiquidity: Record<string, Map<number, number>> = {
        'poly_yes_asks': new Map(), 'poly_yes_bids': new Map(),
        'poly_no_asks': new Map(), 'poly_no_bids': new Map(),
        'kalshi_yes_asks': new Map(), 'kalshi_yes_bids': new Map(),
        'kalshi_no_asks': new Map(), 'kalshi_no_bids': new Map(),
    };

    private onUIUpdate: (() => void) | null = null;

    private lastArbitrageTime: number = 0;
    private readonly ARBITRAGE_COOLDOWN_MS: number = 10000;

    private readonly PAPER_TRADE_MODE: boolean;
    private readonly SIMULATED_LATENCY_MS: number = 1000;

    // <-- 4. CONSTRUCTOR UPDATED TO ACCEPT LIVE ENGINE
    constructor(pair: CandidatePair, portfolio: PortfolioManager, risk: RiskManager, liveEngine: LiveEngine) {
        this.pairData = pair;
        this.pairId = `${pair.polyMarket.internal_id}_${pair.kalshiMarket.internal_id}`;
        this.portfolio = portfolio;
        this.risk = risk;
        this.liveEngine = liveEngine;
        this.PAPER_TRADE_MODE = process.env.PAPER_TRADE !== "false";
    }

    public async start() {
        try {
            const polyResponse = await fetch(`https://gamma-api.polymarket.com/markets/${this.pairData.polyMarket.internal_id}`);
            if (!polyResponse.ok) throw new Error(`Gamma API HTTP ${polyResponse.status}`);

            const polyMarketData = await polyResponse.json();
            const clobTokenIds = JSON.parse(polyMarketData.clobTokenIds);

            // <-- 5. SAVE TOKEN IDs
            this.polyYesTokenId = clobTokenIds[0];
            this.polyNoTokenId = clobTokenIds[1];

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

    private applyGhostLiquidity(realLevels: any[] | undefined, ghostMap: Map<number, number>): any[] {
        if (!realLevels) return [];
        const adjusted = [];

        for (const level of realLevels) {
            const price = level.price;
            const realSize = level.size;
            const consumed = ghostMap.get(price) || 0;

            if (consumed > realSize) {
                ghostMap.set(price, realSize);
            }

            const remainingSize = realSize - (ghostMap.get(price) || 0);

            if (remainingSize > 0) {
                adjusted.push({ price, size: remainingSize });
            }
        }
        return adjusted;
    }

    private getKalshiTakerFee(price: number, size: number): number {
        const fee = 0.07 * size * price * (1 - price);
        return Math.ceil(fee * 100) / 100;
    }

    private calculateSweep(
        polyLevels: any[], kalshiLevels: any[], isEntry: boolean, absoluteMax: number = Infinity
    ): { size: number, polyVwap: number, kalshiVwap: number, totalKalshiFees: number, polyConsumed: Map<number, number>, kalshiConsumed: Map<number, number> } {

        const polyConsumed = new Map<number, number>();
        const kalshiConsumed = new Map<number, number>();

        if (!polyLevels || !kalshiLevels || polyLevels.length === 0 || kalshiLevels.length === 0) {
            return { size: 0, polyVwap: 0, kalshiVwap: 0, totalKalshiFees: 0, polyConsumed, kalshiConsumed };
        }

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

            const kFeePerShare = 0.07 * k.price * (1 - k.price);

            if (isEntry) {
                const netCostPerShare = p.price + k.price + kFeePerShare;
                if (netCostPerShare >= 0.99) break;
            } else {
                const netRevenuePerShare = p.price + k.price - kFeePerShare;
                if (netRevenuePerShare <= 0.99) break;
            }

            const overlap = Math.min(p.size, k.size);
            if (overlap <= 0) break;

            let safeTake = Math.floor(overlap / 2);
            safeTake = Math.min(safeTake, absoluteMax - totalShares);

            if (safeTake <= 0) break;

            totalShares += safeTake;
            polyCost += safeTake * p.price;
            kalshiCost += safeTake * k.price;
            totalKalshiFees += this.getKalshiTakerFee(k.price, safeTake);

            polyConsumed.set(p.price, (polyConsumed.get(p.price) || 0) + safeTake);
            kalshiConsumed.set(k.price, (kalshiConsumed.get(k.price) || 0) + safeTake);

            p.size -= overlap;
            k.size -= overlap;
            if (p.size <= 0) pIdx++;
            if (k.size <= 0) kIdx++;
        }

        return {
            size: totalShares,
            polyVwap: totalShares > 0 ? polyCost / totalShares : 0,
            kalshiVwap: totalShares > 0 ? kalshiCost / totalShares : 0,
            totalKalshiFees,
            polyConsumed,
            kalshiConsumed
        };
    }

    private evaluateEntry() {
        if (!this.latestKalshiBook) return;
        const now = Date.now();
        if (now - this.lastArbitrageTime < this.ARBITRAGE_COOLDOWN_MS) return;

        const alignment = this.pairData.outcomeAlignment;

        if (alignment === 1) {
            this.checkAndTriggerEntry('PolyYes_KalshiNo',
                this.applyGhostLiquidity(this.latestPolyBook.yes?.asks, this.ghostLiquidity['poly_yes_asks']),
                this.applyGhostLiquidity(this.latestKalshiBook.no?.asks, this.ghostLiquidity['kalshi_no_asks'])
            );
            this.checkAndTriggerEntry('PolyNo_KalshiYes',
                this.applyGhostLiquidity(this.latestPolyBook.no?.asks, this.ghostLiquidity['poly_no_asks']),
                this.applyGhostLiquidity(this.latestKalshiBook.yes?.asks, this.ghostLiquidity['kalshi_yes_asks'])
            );
        } else if (alignment === -1) {
            this.checkAndTriggerEntry('PolyYes_KalshiYes_Flipped',
                this.applyGhostLiquidity(this.latestPolyBook.yes?.asks, this.ghostLiquidity['poly_yes_asks']),
                this.applyGhostLiquidity(this.latestKalshiBook.yes?.asks, this.ghostLiquidity['kalshi_yes_asks'])
            );
            this.checkAndTriggerEntry('PolyNo_KalshiNo_Flipped',
                this.applyGhostLiquidity(this.latestPolyBook.no?.asks, this.ghostLiquidity['poly_no_asks']),
                this.applyGhostLiquidity(this.latestKalshiBook.no?.asks, this.ghostLiquidity['kalshi_no_asks'])
            );
        }
    }

    private checkAndTriggerEntry(type: string, polyAsks: any[], kalshiAsks: any[]) {
        const sweep = this.calculateSweep(polyAsks, kalshiAsks, true);

        if (sweep.size > 0) {
            const nominalPolySize = sweep.size * sweep.polyVwap;
            if (nominalPolySize < 1.00) return;

            const approvedSize = this.risk.calculateApprovedSize(
                this.pairId, sweep.polyVwap, sweep.kalshiVwap, sweep.size * 2, sweep.size * 2
            );

            if (approvedSize > 0) {
                this.lastArbitrageTime = Date.now();
                if (this.PAPER_TRADE_MODE) {
                    this.executePaperTrade(type, approvedSize, sweep.polyVwap + sweep.kalshiVwap);
                } else {
                    // <-- 6. LIVE ENTRY ROUTING
                    const polyAssetId = type.includes('PolyYes') ? this.polyYesTokenId : this.polyNoTokenId;
                    const kalshiSide = type.includes('KalshiYes') ? 'yes' : 'no';

                    this.liveEngine.executeOrder({
                        pairId: this.pairId,
                        tradeType: type,
                        targetSize: approvedSize,
                        polyAssetId: polyAssetId,
                        kalshiTicker: this.pairData.kalshiMarket.internal_id,
                        kalshiSide: kalshiSide as 'yes' | 'no',
                        polyMaxVwap: sweep.polyVwap,
                        kalshiMaxVwap: sweep.kalshiVwap,
                        isEntry: true
                    });
                }
            }
        }
    }

    private async executePaperTrade(type: string, approvedSize: number, detectedSpread: number) {
        // [Existing paper trade logic remains identical]
        const timeDetected = new Date().toISOString();
        await new Promise(resolve => setTimeout(resolve, this.SIMULATED_LATENCY_MS));

        let execPolyAsks: any[] = []; let execKalshiAsks: any[] = [];
        let polyKey = ''; let kalshiKey = '';

        switch (type) {
            case 'PolyYes_KalshiNo':
                polyKey = 'poly_yes_asks'; kalshiKey = 'kalshi_no_asks';
                execPolyAsks = this.applyGhostLiquidity(this.latestPolyBook.yes?.asks, this.ghostLiquidity[polyKey]);
                execKalshiAsks = this.applyGhostLiquidity(this.latestKalshiBook!.no?.asks, this.ghostLiquidity[kalshiKey]);
                break;
            case 'PolyNo_KalshiYes':
                polyKey = 'poly_no_asks'; kalshiKey = 'kalshi_yes_asks';
                execPolyAsks = this.applyGhostLiquidity(this.latestPolyBook.no?.asks, this.ghostLiquidity[polyKey]);
                execKalshiAsks = this.applyGhostLiquidity(this.latestKalshiBook!.yes?.asks, this.ghostLiquidity[kalshiKey]);
                break;
            case 'PolyYes_KalshiYes_Flipped':
                polyKey = 'poly_yes_asks'; kalshiKey = 'kalshi_yes_asks';
                execPolyAsks = this.applyGhostLiquidity(this.latestPolyBook.yes?.asks, this.ghostLiquidity[polyKey]);
                execKalshiAsks = this.applyGhostLiquidity(this.latestKalshiBook!.yes?.asks, this.ghostLiquidity[kalshiKey]);
                break;
            case 'PolyNo_KalshiNo_Flipped':
                polyKey = 'poly_no_asks'; kalshiKey = 'kalshi_no_asks';
                execPolyAsks = this.applyGhostLiquidity(this.latestPolyBook.no?.asks, this.ghostLiquidity[polyKey]);
                execKalshiAsks = this.applyGhostLiquidity(this.latestKalshiBook!.no?.asks, this.ghostLiquidity[kalshiKey]);
                break;
        }

        const realSweep = this.calculateSweep(execPolyAsks, execKalshiAsks, true, approvedSize);

        let realizedSpreadStr = "FAILED (MOVED/EMPTIED)";
        let successFlag = "❌ MISSED";

        if (realSweep.size > 0) {
            const realizedSpread = realSweep.polyVwap + realSweep.kalshiVwap;
            const netSpread = realizedSpread + (realSweep.totalKalshiFees / realSweep.size);

            realizedSpreadStr = `${realizedSpread.toFixed(3)} (Net: ${netSpread.toFixed(3)})`;
            successFlag = "✅ CAPTURED";

            const pGhostMap = this.ghostLiquidity[polyKey];
            for (const [price, size] of realSweep.polyConsumed.entries()) {
                pGhostMap.set(price, (pGhostMap.get(price) || 0) + size);
            }
            const kGhostMap = this.ghostLiquidity[kalshiKey];
            for (const [price, size] of realSweep.kalshiConsumed.entries()) {
                kGhostMap.set(price, (kGhostMap.get(price) || 0) + size);
            }

            this.portfolio.openPosition(
                this.pairId, this.pairData.polyMarket.market_question, type,
                realSweep.size, realSweep.polyVwap, realSweep.kalshiVwap, realSweep.totalKalshiFees
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

    private evaluateExit() {
        const position = this.portfolio.getPosition(this.pairId);
        if (!position || !this.latestKalshiBook) return;

        const now = Date.now();
        if (now - this.lastArbitrageTime < this.ARBITRAGE_COOLDOWN_MS) return;

        let targetPolyBids: any[] = []; let targetKalshiBids: any[] = [];

        switch (position.type) {
            case 'PolyYes_KalshiNo':
                targetPolyBids = this.applyGhostLiquidity(this.latestPolyBook.yes?.bids, this.ghostLiquidity['poly_yes_bids']);
                targetKalshiBids = this.applyGhostLiquidity(this.latestKalshiBook.no?.bids, this.ghostLiquidity['kalshi_no_bids']);
                break;
            case 'PolyNo_KalshiYes':
                targetPolyBids = this.applyGhostLiquidity(this.latestPolyBook.no?.bids, this.ghostLiquidity['poly_no_bids']);
                targetKalshiBids = this.applyGhostLiquidity(this.latestKalshiBook.yes?.bids, this.ghostLiquidity['kalshi_yes_bids']);
                break;
            case 'PolyYes_KalshiYes_Flipped':
                targetPolyBids = this.applyGhostLiquidity(this.latestPolyBook.yes?.bids, this.ghostLiquidity['poly_yes_bids']);
                targetKalshiBids = this.applyGhostLiquidity(this.latestKalshiBook.yes?.bids, this.ghostLiquidity['kalshi_yes_bids']);
                break;
            case 'PolyNo_KalshiNo_Flipped':
                targetPolyBids = this.applyGhostLiquidity(this.latestPolyBook.no?.bids, this.ghostLiquidity['poly_no_bids']);
                targetKalshiBids = this.applyGhostLiquidity(this.latestKalshiBook.no?.bids, this.ghostLiquidity['kalshi_no_bids']);
                break;
        }

        const sweep = this.calculateSweep(targetPolyBids, targetKalshiBids, false, position.size);

        if (sweep.size > 0) {
            const nominalPolySize = sweep.size * sweep.polyVwap;
            if (nominalPolySize < 1.00) return;

            this.lastArbitrageTime = now;
            if (this.PAPER_TRADE_MODE) {
                this.executePaperExit(position, sweep.size, sweep.polyVwap + sweep.kalshiVwap);
            } else {
                // <-- 7. LIVE EXIT ROUTING
                const polyAssetId = position.type.includes('PolyYes') ? this.polyYesTokenId : this.polyNoTokenId;
                const kalshiSide = position.type.includes('KalshiYes') ? 'yes' : 'no';

                this.liveEngine.executeOrder({
                    pairId: this.pairId,
                    tradeType: position.type,
                    targetSize: sweep.size,
                    polyAssetId: polyAssetId,
                    kalshiTicker: this.pairData.kalshiMarket.internal_id,
                    kalshiSide: kalshiSide as 'yes' | 'no',
                    polyMaxVwap: sweep.polyVwap,
                    kalshiMaxVwap: sweep.kalshiVwap,
                    isEntry: false
                });
            }
        }
    }

    private async executePaperExit(position: any, approvedExitSize: number, detectedSpread: number) {
        // [Existing paper exit logic remains identical]
        const timeDetected = new Date().toISOString();
        await new Promise(resolve => setTimeout(resolve, this.SIMULATED_LATENCY_MS));

        let execPolyBids: any[] = []; let execKalshiBids: any[] = [];
        let polyKey = ''; let kalshiKey = '';

        switch (position.type) {
            case 'PolyYes_KalshiNo':
                polyKey = 'poly_yes_bids'; kalshiKey = 'kalshi_no_bids';
                execPolyBids = this.applyGhostLiquidity(this.latestPolyBook.yes?.bids, this.ghostLiquidity[polyKey]);
                execKalshiBids = this.applyGhostLiquidity(this.latestKalshiBook!.no?.bids, this.ghostLiquidity[kalshiKey]);
                break;
            case 'PolyNo_KalshiYes':
                polyKey = 'poly_no_bids'; kalshiKey = 'kalshi_yes_bids';
                execPolyBids = this.applyGhostLiquidity(this.latestPolyBook.no?.bids, this.ghostLiquidity[polyKey]);
                execKalshiBids = this.applyGhostLiquidity(this.latestKalshiBook!.yes?.bids, this.ghostLiquidity[kalshiKey]);
                break;
            case 'PolyYes_KalshiYes_Flipped':
                polyKey = 'poly_yes_bids'; kalshiKey = 'kalshi_yes_bids';
                execPolyBids = this.applyGhostLiquidity(this.latestPolyBook.yes?.bids, this.ghostLiquidity[polyKey]);
                execKalshiBids = this.applyGhostLiquidity(this.latestKalshiBook!.yes?.bids, this.ghostLiquidity[kalshiKey]);
                break;
            case 'PolyNo_KalshiNo_Flipped':
                polyKey = 'poly_no_bids'; kalshiKey = 'kalshi_no_bids';
                execPolyBids = this.applyGhostLiquidity(this.latestPolyBook.no?.bids, this.ghostLiquidity[polyKey]);
                execKalshiBids = this.applyGhostLiquidity(this.latestKalshiBook!.no?.bids, this.ghostLiquidity[kalshiKey]);
                break;
        }

        const realSweep = this.calculateSweep(execPolyBids, execKalshiBids, false, approvedExitSize);

        let realizedBidStr = "FAILED (BUYERS DISAPPEARED)";
        let successFlag = "❌ MISSED EXIT";

        if (realSweep.size > 0) {
            const exitFeePerShare = realSweep.totalKalshiFees / realSweep.size;
            const realizedBidVwap = realSweep.polyVwap + realSweep.kalshiVwap - exitFeePerShare;
            const entryCostPerShare = position.totalCost / position.size;

            if (realizedBidVwap > entryCostPerShare) {
                realizedBidStr = realizedBidVwap.toFixed(3);
                successFlag = "✅ PROFIT REALIZED";

                const pGhostMap = this.ghostLiquidity[polyKey];
                for (const [price, size] of realSweep.polyConsumed.entries()) {
                    pGhostMap.set(price, (pGhostMap.get(price) || 0) + size);
                }
                const kGhostMap = this.ghostLiquidity[kalshiKey];
                for (const [price, size] of realSweep.kalshiConsumed.entries()) {
                    kGhostMap.set(price, (kGhostMap.get(price) || 0) + size);
                }

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