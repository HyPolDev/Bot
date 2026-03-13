import { PolymarketWS } from '../utils/exchanges/polymarket_ws.js';
import { KalshiWS } from '../utils/exchanges/kalshi_ws.js';
import { PortfolioManager } from '../portfolio/portfolio_manager.js';
import { RiskManager } from '../portfolio/risk_manager.js';
import { LiveEngine } from '../execution/live_engine.js'; // <-- 1. IMPORT ADDED
import { logger } from '../utils/logger.js';
import { Settings } from '../db/models/Settings.js';
import { SimulatedTrade } from '../db/models/SimulatedTrade.js';
import * as fs from 'fs';

export interface UnifiedMarket {
    internal_id: string;
    platform: string;
    original_url_slug: string;
    market_question: string;
    market_rules: string;
    expiration?: string; // ISO date string, e.g. "2026-04-30"
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
    public polyYesTokenId: string = '';
    public polyNoTokenId: string = '';

    public latestPolyBook: { yes: any, no: any } = { yes: { bids: [], asks: [] }, no: { bids: [], asks: [] } };
    public latestKalshiBook: { yes: any, no: any } | null = null;

    // Only ask-side ghost maps are needed — positions are held to maturity, no exit scanning.
    private ghostLiquidity: Record<string, Map<number, number>> = {
        'poly_yes_asks': new Map(),
        'poly_no_asks': new Map(),
        'kalshi_yes_asks': new Map(),
        'kalshi_no_asks': new Map(),
    };

    private onUIUpdate: (() => void) | null = null;

    private lastArbitrageTime: number = 0;
    private readonly ARBITRAGE_COOLDOWN_MS: number = 10000;

    private async getSettings() {
        try {
            const settings = await Settings.findOne();
            if (settings) return settings;
        } catch (error) {
            logger.error(`[PairManager] Error fetching settings:`, error);
        }
        // Fallback defaults
        return { isPaperTrading: true, simulatedLatency: 1000, arbitrageCooldown: 10000 };
    }

    // <-- 4. CONSTRUCTOR UPDATED TO ACCEPT LIVE ENGINE
    constructor(pair: CandidatePair, portfolio: PortfolioManager, risk: RiskManager, liveEngine: LiveEngine) {
        this.pairData = pair;
        this.pairId = `${pair.polyMarket.internal_id}_${pair.kalshiMarket.internal_id}`;
        this.portfolio = portfolio;
        this.risk = risk;
        this.liveEngine = liveEngine;
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
            logger.error(`[Error] Failed to start manager for ${this.pairData.polyMarket.internal_id}`, error);
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

    /**
     * Kalshi taker fee for an entire order block.
     * Formula: ceil(0.07 * totalContracts * P * (1-P) * 100) / 100
     * The ceil is applied ONCE to the full block — not per-contract — to avoid fee overestimation.
     */
    private getKalshiTakerFee(price: number, size: number): number {
        return Math.ceil(0.07 * size * price * (1 - price) * 100) / 100;
    }

    /**
     * Sweeps overlapping ask-side orderbook levels and accumulates profitable contracts.
     *
     * Per-level EAR gate: before accepting a marginal level, we simulate adding its
     * contracts to the running block and recompute the block-level Kalshi fee (single ceil
     * on the full block). If the resulting EAR falls below MIN_EAR_THRESHOLD, we stop.
     * This correctly models how Kalshi's nonlinear fee dilutes as block size grows.
     */
    private calculateSweep(
        polyLevels: any[], kalshiLevels: any[],
        daysToExpiration: number, minEarThreshold: number, expiringDate?: Date,
        absoluteMax: number = Infinity
    ): { size: number, polyVwap: number, kalshiVwap: number, polyWorstPrice: number, kalshiWorstPriceCents: number, totalKalshiFees: number, marginEAR: number, polyConsumed: Map<number, number>, kalshiConsumed: Map<number, number> } {

        const polyConsumed = new Map<number, number>();
        const kalshiConsumed = new Map<number, number>();
        const EMPTY = { size: 0, polyVwap: 0, kalshiVwap: 0, polyWorstPrice: 0, kalshiWorstPriceCents: 0, totalKalshiFees: 0, marginEAR: 0, polyConsumed, kalshiConsumed };

        if (!polyLevels || !kalshiLevels || polyLevels.length === 0 || kalshiLevels.length === 0) return EMPTY;

        // Safety floor prevents division by zero when expiration is today.
        const safeDays = Math.max(daysToExpiration, 0.1);

        let pIdx = 0; let kIdx = 0;
        const pBook = polyLevels.map(l => ({ ...l }));
        const kBook = kalshiLevels.map(l => ({ ...l }));

        let totalShares = 0;
        let polyCost = 0;
        let kalshiCost = 0;
        let polyWorstPrice = 0;
        let kalshiWorstPrice = 0;
        let lastAcceptedEAR = 0;

        while (pIdx < pBook.length && kIdx < kBook.length && totalShares < absoluteMax) {
            const p = pBook[pIdx];
            const k = kBook[kIdx];

            // Raw spread pre-filter: a combined ask >= 1.00 can never be profitable.
            if (p.price + k.price >= 1.00) break;

            const overlap = Math.min(p.size, k.size);
            if (overlap <= 0) break;

            let safeTake = Math.floor(overlap / 2); // /2 safety buffer avoids competing head-on with other buyers
            safeTake = Math.min(safeTake, absoluteMax - totalShares);
            if (safeTake <= 0) break;

            // --- Marginal EAR gate ---
            // Simulate adding this level's contracts to the running block and recompute
            // the block-level Kalshi fee (single ceil on the cumulative block, not per-level).
            const candidateShares = totalShares + safeTake;
            const candidateRawSpread = (polyCost + safeTake * p.price + kalshiCost + safeTake * k.price) / candidateShares;
            // Block-level fee: ceil applied once to the entire accumulated block at this level's price.
            // We approximate the blended kalshi price for the block to avoid tracking per-level inventory.
            const blendedKalshiPrice = (kalshiCost + safeTake * k.price) / candidateShares;
            const candidateBlockFee = Math.ceil(0.07 * candidateShares * blendedKalshiPrice * (1 - blendedKalshiPrice) * 100) / 100;
            const candidateCostBasis = candidateRawSpread + (candidateBlockFee / candidateShares);
            const candidateNetProfit = 1.00 - candidateCostBasis;
            const candidateEAR = (candidateNetProfit / candidateCostBasis) * (365 / safeDays);

            // If this level degrades the EAR below threshold, stop accumulating.
            if (candidateEAR < minEarThreshold) break;

            // Level accepted — commit to running totals.
            totalShares = candidateShares;
            polyCost += safeTake * p.price;
            kalshiCost += safeTake * k.price;
            lastAcceptedEAR = candidateEAR;

            polyConsumed.set(p.price, (polyConsumed.get(p.price) || 0) + safeTake);
            kalshiConsumed.set(k.price, (kalshiConsumed.get(k.price) || 0) + safeTake);

            polyWorstPrice = Math.max(polyWorstPrice, p.price);
            kalshiWorstPrice = Math.max(kalshiWorstPrice, k.price);

            p.size -= overlap;
            k.size -= overlap;
            if (p.size <= 0) pIdx++;
            if (k.size <= 0) kIdx++;
        }

        if (totalShares === 0) return EMPTY;

        // Final block-level fee on the full accepted position.
        const blendedKalshi = kalshiCost / totalShares;
        const totalKalshiFees = Math.ceil(0.07 * totalShares * blendedKalshi * (1 - blendedKalshi) * 100) / 100;

        // Buy side: round up to the next cent to guarantee sweep fill.
        const kalshiWorstPriceCents = Math.ceil(kalshiWorstPrice * 100);

        return {
            size: totalShares,
            polyVwap: polyCost / totalShares,
            kalshiVwap: kalshiCost / totalShares,
            polyWorstPrice,
            kalshiWorstPriceCents,
            totalKalshiFees,
            marginEAR: lastAcceptedEAR,
            polyConsumed,
            kalshiConsumed
        };
    }

    private async evaluateEntry() {
        if (!this.liveEngine.isSystemReady) return;
        if (!this.latestKalshiBook) return;
        // Global Safe Execution Guard
        if ((this.portfolio as any).isPairBanned && (this.portfolio as any).isPairBanned(this.pairId)) return;

        const settings = await this.getSettings();
        const now = Date.now();
        if (now - this.lastArbitrageTime < settings.arbitrageCooldown) return;

        // Expiration: use the earlier of the two market dates as the conservative T_exp.
        const polyExpMs = this.pairData.polyMarket.expiration ? new Date(this.pairData.polyMarket.expiration).getTime() : Infinity;
        const kalshiExpMs = this.pairData.kalshiMarket.expiration ? new Date(this.pairData.kalshiMarket.expiration).getTime() : Infinity;
        const expirationMs = Math.min(polyExpMs, kalshiExpMs);
        const daysToExpiration = (expirationMs - Date.now()) / 86_400_000;
        const expiringDate = Number.isFinite(expirationMs) ? new Date(expirationMs) : undefined;
        const minEarThreshold = (settings as any).minEarThreshold ?? 0.15;
        const alignment = this.pairData.outcomeAlignment;

        if (alignment === 1) {
            this.checkAndTriggerEntry('PolyYes_KalshiNo',
                this.applyGhostLiquidity(this.latestPolyBook.yes?.asks, this.ghostLiquidity['poly_yes_asks']),
                this.applyGhostLiquidity(this.latestKalshiBook.no?.asks, this.ghostLiquidity['kalshi_no_asks']),
                daysToExpiration, minEarThreshold, expiringDate
            );
            this.checkAndTriggerEntry('PolyNo_KalshiYes',
                this.applyGhostLiquidity(this.latestPolyBook.no?.asks, this.ghostLiquidity['poly_no_asks']),
                this.applyGhostLiquidity(this.latestKalshiBook.yes?.asks, this.ghostLiquidity['kalshi_yes_asks']),
                daysToExpiration, minEarThreshold, expiringDate
            );
        } else if (alignment === -1) {
            this.checkAndTriggerEntry('PolyYes_KalshiYes_Flipped',
                this.applyGhostLiquidity(this.latestPolyBook.yes?.asks, this.ghostLiquidity['poly_yes_asks']),
                this.applyGhostLiquidity(this.latestKalshiBook.yes?.asks, this.ghostLiquidity['kalshi_yes_asks']),
                daysToExpiration, minEarThreshold, expiringDate
            );
            this.checkAndTriggerEntry('PolyNo_KalshiNo_Flipped',
                this.applyGhostLiquidity(this.latestPolyBook.no?.asks, this.ghostLiquidity['poly_no_asks']),
                this.applyGhostLiquidity(this.latestKalshiBook.no?.asks, this.ghostLiquidity['kalshi_no_asks']),
                daysToExpiration, minEarThreshold, expiringDate
            );
        }
    }

    private async checkAndTriggerEntry(
        type: string, polyAsks: any[], kalshiAsks: any[],
        daysToExpiration: number, minEarThreshold: number, expiringDate?: Date
    ) {
        // Guard: never double-enter a pair we already hold.
        if (this.portfolio.getPosition(this.pairId)) return;

        const sweep = this.calculateSweep(polyAsks, kalshiAsks, daysToExpiration, minEarThreshold);

        // sweep.size > 0 only when at least one level cleared the EAR gate inside calculateSweep.
        if (sweep.size > 0) {
            const approvedSize = this.risk.calculateApprovedSize(
                this.pairId, sweep.polyVwap, sweep.kalshiVwap, sweep.size * 2, sweep.size * 2
            );

            if (approvedSize > 0) {
                const settings = await this.getSettings();
                this.lastArbitrageTime = Date.now();
                if (settings.isPaperTrading) {
                    this.executePaperEntry(type, approvedSize, sweep.polyVwap + sweep.kalshiVwap, sweep.marginEAR, daysToExpiration, settings.simulatedLatency, expiringDate);
                } else {
                    // Pre-execution budget guard: silently abort if wallets cannot cover the order.
                    const polyRequiredCost = sweep.polyVwap * approvedSize;
                    const kalshiRequiredCost = sweep.kalshiVwap * approvedSize;

                    if (this.portfolio.getPolyCash() < polyRequiredCost || this.portfolio.getKalshiCash() < kalshiRequiredCost) {
                        return;
                    }

                    // Live entry routing
                    const polyAssetId = type.includes('PolyYes') ? this.polyYesTokenId : this.polyNoTokenId;
                    const kalshiSide = type.includes('KalshiYes') ? 'yes' : 'no';

                    this.liveEngine.queueOrder({
                        pairId: this.pairId,
                        marketQuestion: this.pairData.polyMarket.market_question,
                        tradeType: type,
                        targetSize: approvedSize,
                        polyAssetId: polyAssetId,
                        kalshiTicker: this.pairData.kalshiMarket.internal_id,
                        kalshiSide: kalshiSide as 'yes' | 'no',
                        polyMaxVwap: Math.floor(sweep.polyWorstPrice * 100) / 100, // Round down to nearest cent
                        kalshiMaxVwap: sweep.kalshiWorstPriceCents / 100,
                        isEntry: true,
                        expectedEAR: sweep.marginEAR,  // Queue priority: higher EAR trades execute first
                        availableLiquidity: sweep.size,
                    });
                }
            }
        }
    }

    private async executePaperEntry(
        type: string, approvedSize: number, detectedSpread: number,
        detectedEAR: number, daysToExpiration: number, latencyMs: number, expiringDate?: Date
    ) {
        const timeDetected = new Date().toISOString();
        await new Promise(resolve => setTimeout(resolve, latencyMs));

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

        // Re-run the sweep at execution time (T+latency) to confirm the opportunity still clears the EAR gate.
        const minEarThreshold = 0.15; // Mirror of Settings default; re-fetching from DB here would be over-engineering.
        const realSweep = this.calculateSweep(execPolyAsks, execKalshiAsks, daysToExpiration, minEarThreshold, expiringDate, approvedSize);

        let realizedSpreadStr = "FAILED (MOVED/EMPTIED or EAR degraded)";
        let successFlag = "❌ MISSED";

        if (realSweep.size > 0) {
            const realizedSpread = realSweep.polyVwap + realSweep.kalshiVwap;
            // Net cost basis includes the block-level Kalshi fee distributed per share.
            const netCostBasis = realizedSpread + (realSweep.totalKalshiFees / realSweep.size);

            realizedSpreadStr = `${realizedSpread.toFixed(3)} (Net: ${netCostBasis.toFixed(3)}) | EAR: ${(realSweep.marginEAR * 100).toFixed(1)}%`;
            successFlag = "✅ CAPTURED";

            const pGhostMap = this.ghostLiquidity[polyKey];
            for (const [price, size] of realSweep.polyConsumed.entries()) {
                pGhostMap.set(price, (pGhostMap.get(price) || 0) + size);
            }
            const kGhostMap = this.ghostLiquidity[kalshiKey];
            for (const [price, size] of realSweep.kalshiConsumed.entries()) {
                kGhostMap.set(price, (kGhostMap.get(price) || 0) + size);
            }

            const opened = this.portfolio.openPosition(
                this.pairId, this.pairData.polyMarket.market_question, type,
                realSweep.size, realSweep.polyVwap, realSweep.kalshiVwap, realSweep.totalKalshiFees, realSweep.marginEAR, expiringDate
            );
            if (opened) {
                SimulatedTrade.create({
                    pairId: this.pairId,
                    marketQuestion: this.pairData.polyMarket.market_question,
                    type: 'buy',
                    polyQuantity: realSweep.size,
                    kalshiQuantity: realSweep.size,
                    averagePolyPrice: realSweep.polyVwap,
                    // Fee is charged on entry; distribute across shares for per-unit cost basis.
                    averageKalshiPrice: realSweep.kalshiVwap + (realSweep.totalKalshiFees / realSweep.size)
                }).catch(e => logger.error(`[PairManager] Error persisting SimulatedTrade to DB: ${e.message}`));
            } else {
                logger.warn(`[PairManager] Simulated position not persisted for ${this.pairId}. Skipping SimulatedTrade write.`);
            }
        }

        const msg = `
==================================================
[${timeDetected}] PAPER ENTRY: ${type} | Hold-to-Maturity
Market: ${this.pairData.polyMarket.market_question.substring(0, 80)}...
Detect VWAP: ${detectedSpread.toFixed(3)} | EAR: ${(detectedEAR * 100).toFixed(1)}% | Days to Exp: ${daysToExpiration.toFixed(1)} | Size: ${approvedSize}

--- EXECUTION (T+${latencyMs}ms) ---
-> REALIZED: ${realizedSpreadStr}  ${successFlag}
-> FILLED SIZE: ${realSweep.size}
==================================================\n`;

        fs.appendFileSync('arbitrage_opportunities.txt', msg, 'utf8');
    }

}
