import { logger } from '../utils/logger.js';
import { SimulatedPosition } from '../db/models/SimulatedPosition.js';
import { Position as PositionModel } from '../db/models/Position.js';
import { SimulatedTrade } from '../db/models/SimulatedTrade.js';
import { Settings } from '../db/models/Settings.js';
import { RiskManager } from './risk_manager.js';

export interface Position {
    pairId: string;
    marketQuestion: string;
    type: string;
    size: number;
    polyEntryPrice: number;
    kalshiEntryPrice: number;
    polyCost: number;
    kalshiCost: number;
    totalCost: number;
    timestamp: number;
    expiringDate: any;
    expectedAnnualizedReturn: number | undefined;
    reservedSize?: number; // In-flight sales to prevent double-selling
}

export class PortfolioManager {
    private polyCash: number = 0;
    private kalshiCash: number = 0;

    // Physical Exchange Clients
    private polyClient: any = null;
    private kalshiClient: any = null;

    private totalRealizedPnL: number = 0;

    private openPositions: Map<string, Position> = new Map();
    private bannedPairs: Map<string, number> = new Map();
    private registeredManagers: any[] = [];

    public setManagers(managers: any[]) {
        this.registeredManagers = managers;
    }

    constructor(initialPoly: number = 0, initialKalshi: number = 0) {
        this.polyCash = initialPoly;
        this.kalshiCash = initialKalshi;
        logger.info(`[Portfolio] Initialized statically. Awaiting Live Sync...`);
    }

    public async attachExchangeClients(polyClient: any, kalshiClient: any) {
        this.polyClient = polyClient;
        this.kalshiClient = kalshiClient;

        const settings = await Settings.findOne();
        if (settings && settings.isPaperTrading) {
            logger.info(`[Portfolio] Paper Trading active. Skipping live physical balance and position sync intervals.`);
            return;
        }

        // Immediately sync and then sync every 60 seconds
        this.syncBalances();
        setInterval(() => this.syncBalances(), 60000);
    }

    public async initializePaperTrading() {
        try {
            const settings = await Settings.findOne();
            if (settings && settings.isPaperTrading) {
                logger.info(`[Portfolio] Paper Trading Enabled. Fetching simulated balances and positions...`);

                // Hardcoded initial simulated balances (or could be moved to Settings later)
                this.polyCash = 1000;
                this.kalshiCash = 1000;

                const dbPositions = await SimulatedPosition.find({ state: 'open' });
                for (const pos of dbPositions) {
                    const totalCost = (pos.averagePolyPrice * pos.polymarketQuantity) +
                        (pos.averageKalshiPrice * pos.kalshiQuantity) +
                        pos.exitFees;

                    this.polyCash -= (pos.averagePolyPrice * pos.polymarketQuantity);
                    this.kalshiCash -= (pos.averageKalshiPrice * pos.kalshiQuantity + pos.exitFees);

                    this.openPositions.set(pos.pairId, {
                        pairId: pos.pairId,
                        marketQuestion: pos.marketQuestion,
                        type: pos.type as string,
                        size: pos.polymarketQuantity, // Assuming sizes match
                        polyEntryPrice: pos.averagePolyPrice,
                        kalshiEntryPrice: pos.averageKalshiPrice,
                        polyCost: pos.averagePolyPrice * pos.polymarketQuantity,
                        kalshiCost: pos.averageKalshiPrice * pos.kalshiQuantity + pos.exitFees,
                        totalCost,
                        timestamp: Date.now(), // Could use createdAt from DB
                        expiringDate: pos.expiringDate,
                        expectedAnnualizedReturn: pos.expectedAnnualizedReturn
                    });
                }
                logger.info(`[Portfolio] Restored ${dbPositions.length} simulated positions. Simulated Balances -> Poly: $${this.polyCash.toFixed(2)} | Kalshi: $${this.kalshiCash.toFixed(2)}`);
            }
        } catch (error) {
            logger.error(`[Portfolio] Error initializing paper trading state from DB:`, error);
        }
    }

    public relinkRecoveredPositions(managers: any[]) {
        const toDelete: string[] = [];
        const toAdd: Position[] = [];

        for (const [oldId, pos] of this.openPositions.entries()) {
            const searchKey = pos.marketQuestion;

            const matchedManager = managers.find(m =>
                searchKey.includes(m.pairData.kalshiMarket.internal_id) ||
                m.pairData.polyMarket.market_question.startsWith(searchKey.replace('...', ''))
            );

            if (matchedManager && matchedManager.pairId !== oldId) {
                const realId = matchedManager.pairId;
                const realQuestion = matchedManager.pairData.polyMarket.market_question;

                const newPos = { ...pos, pairId: realId, marketQuestion: realQuestion };
                toAdd.push(newPos);
                toDelete.push(oldId);
            }
        }

        for (const id of toDelete) this.openPositions.delete(id);
        for (const pos of toAdd) this.openPositions.set(pos.pairId, pos);
    }

    public async syncPositions(): Promise<void> {
        if (!this.polyClient || !this.kalshiClient || this.registeredManagers.length === 0) return;
        try {
            const [polyPositions, kalshiPositions] = await Promise.all([
                this.polyClient.getOpenPositions(),
                this.kalshiClient.getOpenPositions()
            ]);

            const toKeep = new Set<string>();

            for (const manager of this.registeredManagers) {
                const polyAssetIdYes = manager.polyYesTokenId;
                const polyAssetIdNo = manager.polyNoTokenId;
                const kalshiTicker = manager.pairData.kalshiMarket.internal_id;

                const polyPosYes = polyPositions.find((p: any) => p.asset_id === polyAssetIdYes && p.size > 0);
                const polyPosNo = polyPositions.find((p: any) => p.asset_id === polyAssetIdNo && p.size > 0);

                const kalshiPos = kalshiPositions.filter((p: any) => p.ticker === kalshiTicker && p.position !== 0);

                if ((polyPosYes || polyPosNo) && kalshiPos.length > 0) {
                    const pairId = manager.pairId;
                    const pos = this.openPositions.get(pairId);

                    const polySize = polyPosYes ? polyPosYes.size : (polyPosNo ? polyPosNo.size : 0);
                    const kalshiSize = kalshiPos.reduce((sum: number, p: any) => sum + Math.abs(p.position), 0);
                    const realSize = Math.min(polySize, kalshiSize);

                    if (realSize > 0) {
                        toKeep.add(pairId);

                        if (!pos) {
                            const typeStr = polyPosYes ? "PolyYes_KalshiNo" : "PolyNo_KalshiYes";

                            // Derive Kalshi RAW entry price from market_exposure (cents) / position
                            const kalshiExposureCents = kalshiPos.reduce((sum: number, p: any) => sum + Math.abs(p.market_exposure || 0), 0);
                            const kalshiRawPrice = kalshiSize > 0 ? (kalshiExposureCents / kalshiSize) / 100 : 0.5;

                            // Estimate Kalshi fee for the matched 'realSize' contracts
                            // Formula: round_up(0.07 * C * P * (1-P))
                            const expectedEarningsSpread = kalshiRawPrice * (1 - kalshiRawPrice);
                            const rawFee = 0.07 * realSize * expectedEarningsSpread;
                            // Math.ceil(value * 100) / 100 perfectly handles the "round up to the next cent" rule
                            const estimatedFeeDollars = Math.ceil(rawFee * 100) / 100;

                            // Calculate final Blended UI Cost and Avg Price
                            const kalshiCost = (kalshiRawPrice * realSize) + estimatedFeeDollars;
                            const kalshiBlendedEntryPrice = realSize > 0 ? (kalshiCost / realSize) : 0;

                            const polyEntryPrice = polyPosYes ? polyPosYes.avg_cost : (polyPosNo ? polyPosNo.avg_cost : 0.5);
                            const polyCost = polyEntryPrice * realSize;

                            this.openPositions.set(pairId, {
                                pairId,
                                marketQuestion: manager.pairData.polyMarket.market_question,
                                type: typeStr,
                                size: realSize,
                                polyEntryPrice: polyEntryPrice,
                                kalshiEntryPrice: kalshiBlendedEntryPrice, // Pushing the blended price to state
                                polyCost: polyCost,
                                kalshiCost: kalshiCost, // Pushing the blended cost to state
                                totalCost: polyCost + kalshiCost,
                                timestamp: Date.now(),
                                expiringDate: undefined,
                                expectedAnnualizedReturn: undefined
                            });
                            logger.info(`[Portfolio] 🔄 Auto-restored physical position ${pairId} with size ${realSize} | Poly @ ${polyEntryPrice.toFixed(3)} | Kalshi @ ${kalshiBlendedEntryPrice.toFixed(3)} (Inc. Est. Fees)`);
                        } else {
                            if (pos.size !== realSize) {
                                logger.info(`[Portfolio] 🔄 Resyncing ${pairId} size: memory ${pos.size} -> physical ${realSize}`);
                                const sizeRatio = realSize / pos.size;
                                pos.size = realSize;
                                pos.polyCost *= sizeRatio;
                                pos.kalshiCost *= sizeRatio;
                                pos.totalCost *= sizeRatio;
                            }
                        }
                    }
                }
            }

            for (const [pairId, pos] of this.openPositions.entries()) {
                if (!toKeep.has(pairId)) {
                    const isManaged = this.registeredManagers.some((m: any) => m.pairId === pairId);
                    if (isManaged) {
                        logger.info(`[Portfolio] 🔄 Removing ${pairId} from tracker (no physical balance backing).`);
                        this.openPositions.delete(pairId);
                    }
                }
            }
        } catch (error) {
            logger.error(`[Portfolio] ⚠️ Failed to sync physical positions from exchanges.`, error);
        }
    }

    public async syncBalances(): Promise<void> {
        if (!this.polyClient || !this.kalshiClient) return;
        try {
            const [realPoly, realKalshi] = await Promise.all([
                this.polyClient.getCollateralBalance(),
                this.kalshiClient.getBalance()
            ]);

            this.polyCash = realPoly;
            this.kalshiCash = realKalshi;

            logger.info(`[Portfolio] 🔄 Live Balances Synced -> Poly: $${realPoly.toFixed(2)} | Kalshi: $${realKalshi.toFixed(2)}`);
            await this.syncPositions();
        } catch (error) {
            logger.error(`[Portfolio] ⚠️ Failed to sync physical balances from exchanges.`, error);
        }
    }

    public getPolyCash(): number { return this.polyCash; }
    public getKalshiCash(): number { return this.kalshiCash; }
    public getTotalCash(): number { return this.polyCash + this.kalshiCash; }

    public getTotalEquity(): number {
        let equity = this.getTotalCash();
        for (const position of this.openPositions.values()) {
            equity += position.totalCost;
        }
        return equity;
    }

    public getRealizedPnL(): number { return this.totalRealizedPnL; }
    public getUnrealizedPnL(): number {
        let unrealized = 0;
        for (const position of this.openPositions.values()) {
            // Guaranteed payout per contract is $1, so expected profit is size - totalCost
            unrealized += (position.size - position.totalCost);
        }
        return unrealized;
    }
    public getOpenPositions(): Position[] { return Array.from(this.openPositions.values()); }

    public getInvestedCapital(): number {
        let invested = 0;
        for (const position of this.openPositions.values()) {
            invested += position.totalCost;
        }
        return invested;
    }

    public hasOpenPosition(pairId: string): boolean { return this.openPositions.has(pairId); }
    public getPosition(pairId: string): Position | undefined { return this.openPositions.get(pairId); }
    public getPairExposure(pairId: string): number {
        const position = this.openPositions.get(pairId);
        return position ? position.totalCost : 0;
    }

    public getOperationalPolyCash(riskManager: RiskManager): number {
        const buffer = riskManager.getMaxTradeBudget();
        return Math.max(0, this.polyCash - buffer);
    }

    public getOperationalKalshiCash(riskManager: RiskManager): number {
        const buffer = riskManager.getMaxTradeBudget();
        return Math.max(0, this.kalshiCash - buffer);
    }

    // Safety Orchestration: Pair Banning
    public banPair(pairId: string, durationMs: number = 600000): void {
        const unbanTime = Date.now() + durationMs;
        this.bannedPairs.set(pairId, unbanTime);
        logger.warn(`[SAFETY] 🚫 Pair ${pairId} has been dynamically banned for ${durationMs / 60000} minutes due to an Orphan Event.`);
    }

    public isPairBanned(pairId: string): boolean {
        const unbanTime = this.bannedPairs.get(pairId);
        if (!unbanTime) return false;

        // If the ban has expired, lift it
        if (Date.now() > unbanTime) {
            this.bannedPairs.delete(pairId);
            logger.info(`[SAFETY] 🟢 Ban lifted for Pair ${pairId}.`);
            return false;
        }
        return true;
    }

    public openPosition(
        pairId: string, marketQuestion: string, type: string, size: number,
        polyPrice: number, kalshiPrice: number, kalshiFees: number, EAR: number, expiringDate: any
    ): boolean {
        const polyCost = size * polyPrice;
        const kalshiCost = size * kalshiPrice;
        const totalCost = polyCost + kalshiCost + kalshiFees;

        if (polyCost > this.polyCash || (kalshiCost + kalshiFees) > this.kalshiCash) {
            logger.error(`[Portfolio] FATAL: Insufficient funds! PolyCost: ${polyCost}, KalshiReq: ${kalshiCost + kalshiFees}`);
            return false;
        }

        if (this.openPositions.has(pairId)) {
            const pos = this.openPositions.get(pairId)!;

            const newSize = pos.size + size;
            pos.polyEntryPrice = ((pos.size * pos.polyEntryPrice) + polyCost) / newSize;
            pos.kalshiEntryPrice = ((pos.size * pos.kalshiEntryPrice) + kalshiCost) / newSize;

            pos.size = newSize;
            pos.polyCost += polyCost;
            pos.kalshiCost += (kalshiCost + kalshiFees); // FIX: Track the true Kalshi cost
            pos.totalCost += totalCost;

            this.polyCash -= polyCost;
            this.kalshiCash -= (kalshiCost + kalshiFees); // FIX: Deduct the fee from the wallet!

            this.persistPositionOpen(pos, totalCost, kalshiFees);
            return true;
        }

        const newPosition: Position = {
            pairId, marketQuestion, type, size,
            polyEntryPrice: polyPrice, kalshiEntryPrice: kalshiPrice,
            polyCost,
            kalshiCost: kalshiCost + kalshiFees, // Include fees in the tracker
            totalCost,
            timestamp: Date.now(),
            expiringDate,
            expectedAnnualizedReturn: EAR
        };

        this.openPositions.set(pairId, newPosition);
        this.polyCash -= polyCost;
        this.kalshiCash -= (kalshiCost + kalshiFees);

        this.persistPositionOpen(newPosition, totalCost, kalshiFees);
        return true;
    }

    private async persistPositionOpen(pos: Position, totalCost: number, kalshiFees: number) {
        try {
            const settings = await Settings.findOne();
            const isPaperTrading = settings?.isPaperTrading ?? true;
            const Model = isPaperTrading ? SimulatedPosition : PositionModel;

            await (Model as any).findOneAndUpdate(
                { pairId: pos.pairId, state: 'open' },
                {
                    $set: {
                        marketQuestion: pos.marketQuestion,
                        type: pos.type,
                        averagePolyPrice: pos.polyEntryPrice,
                        polymarketQuantity: pos.size,
                        averageKalshiPrice: pos.kalshiEntryPrice,
                        kalshiQuantity: pos.size
                    },
                    $inc: { exitFees: kalshiFees },
                    $setOnInsert: {
                        expiringDate: pos.expiringDate,
                        expectedAnnualizedReturn: pos.expectedAnnualizedReturn,
                        state: 'open'
                    }
                },
                { upsert: true, new: true, setDefaultsOnInsert: true }
            );
        } catch (error) {
            logger.error(`[Portfolio] Error saving Position to DB:`, error);
        }
    }

    public closePosition(
        pairId: string, exitSize: number, polyExitPrice: number, kalshiExitPrice: number, kalshiExitFees: number
    ): boolean {
        const position = this.openPositions.get(pairId);
        if (!position) return false;

        const actualExitSize = Math.min(exitSize, position.size);

        const polyRevenue = actualExitSize * polyExitPrice;
        const kalshiRevenue = (actualExitSize * kalshiExitPrice) - kalshiExitFees;
        const totalRevenue = polyRevenue + kalshiRevenue;

        // FIX: Calculate the true cost basis using the totalCost tracker (which includes entry fees)
        const costBasisPerShare = position.totalCost / position.size;
        const costBasis = actualExitSize * costBasisPerShare;

        const pnl = totalRevenue - costBasis;

        this.polyCash += polyRevenue;
        this.kalshiCash += kalshiRevenue;
        this.totalRealizedPnL += pnl;

        if (actualExitSize === position.size) {
            this.openPositions.delete(pairId);
        } else {
            const oldSize = position.size;
            position.size -= actualExitSize;

            if (position.reservedSize) {
                position.reservedSize = Math.max(0, position.reservedSize - actualExitSize);
            }

            // Proportionally reduce the internal trackers
            position.polyCost -= (actualExitSize * (position.polyCost / oldSize));
            position.kalshiCost -= (actualExitSize * (position.kalshiCost / oldSize));
            position.totalCost -= costBasis;
        }

        // --- Simulated Trade Persistence (Exits) ---
        Settings.findOne().then(settings => {
            if (settings && settings.isPaperTrading) {
                SimulatedTrade.create({
                    pairId: pairId,
                    marketQuestion: position.marketQuestion,
                    type: 'sell',
                    polyQuantity: actualExitSize,
                    kalshiQuantity: actualExitSize,
                    averagePolyPrice: polyExitPrice,
                    // Subvolve individual cost but log absolute exit data
                    averageKalshiPrice: kalshiExitPrice - (kalshiExitFees / actualExitSize)
                }).catch(e => logger.error(`[Portfolio] Error persisting Simulated SELL Trade: ${e.message}`));
            }
        });

        this.persistPositionClose(pairId, actualExitSize, actualExitSize === position.size ? 0 : position.size);
        return true;
    }

    private async persistPositionClose(pairId: string, exitSize: number, remainingSize: number) {
        try {
            const settings = await Settings.findOne();
            const isPaperTrading = settings?.isPaperTrading ?? true;
            const Model = isPaperTrading ? SimulatedPosition : PositionModel;

            const dbPos = await (Model as any).findOne({ pairId, state: 'open' });
            if (dbPos) {
                if (remainingSize <= 0) {
                    dbPos.state = 'closed';
                    await dbPos.save();
                } else {
                    // Partial close
                    dbPos.polymarketQuantity = remainingSize;
                    dbPos.kalshiQuantity = remainingSize;
                    await dbPos.save();
                }
            }
        } catch (error) {
            logger.error(`[Portfolio] Error closing Position in DB:`, error);
        }
    }

    public async evaluateRelayRotation(newCandidateAbsProfit: number, capitalNeeded: number): Promise<boolean> {
        const openPositions = this.getOpenPositions();
        if (openPositions.length === 0) return false;

        // 1. Sort by absolute expected profit dynamically
        // Expected Profit = (Guaranteed Payout of $1.00 * size) - totalCost
        openPositions.sort((a, b) => {
            const profitA = a.size - a.totalCost;
            const profitB = b.size - b.totalCost;
            return profitA - profitB;
        });

        const worstPos = openPositions[0];

        const manager = this.registeredManagers.find(m => m.pairId === worstPos.pairId);
        if (!manager) return false;

        // 2. Simulate Exit to get real-world cash back (Bid prices)
        const exitSim = manager.simulateExit(worstPos.size);
        if (exitSim.size === 0) return false;

        // 3. The Minimum Ticket Size (Stop trading dust)
        const MIN_TRADE_VALUE = 0.05;
        if (exitSim.netRevenue < MIN_TRADE_VALUE) {
            logger.info(`[RELAY CHECK] ❌ RECHAZADO. Liquidating ${worstPos.pairId} frees $${exitSim.netRevenue.toFixed(2)}. Min required: $${MIN_TRADE_VALUE}.`);
            return false;
        }

        // 4. Calculate Absolute Dollar Toll
        const expectedProfitIfHeld = worstPos.size - worstPos.totalCost;
        const realizedLossOnExit = worstPos.totalCost - exitSim.netRevenue;

        // Total cost of switching = The profit we gave up + the actual cash we lost to the spread
        const totalSwitchingCost = expectedProfitIfHeld + realizedLossOnExit;

        // 5. The Absolute Switching Friction (Hurdle Rate)
        // You can make this dynamic later (e.g., 2% of capitalNeeded), but static is safer for MVP
        const ALPHA_HURDLE = 1.00;

        // 6. The Ultimate Question
        const requiredNewProfit = totalSwitchingCost + ALPHA_HURDLE;

        if (newCandidateAbsProfit > requiredNewProfit) {
            logger.info(`[RELAY CHECK] ✅ AUTORIZADO. New Profit ($${newCandidateAbsProfit.toFixed(2)}) > Required ($${requiredNewProfit.toFixed(2)}).`);
            return true;
        }

        logger.info(`[RELAY CHECK] ❌ RECHAZADO. New Profit ($${newCandidateAbsProfit.toFixed(2)}) insufficient. Necesario: $${requiredNewProfit.toFixed(2)}`);
        return false;
    }

    public async triggerBufferReplenishment(amountNeeded: number, riskManager: RiskManager) {
        const settings = await Settings.findOne();
        const isPaper = settings?.isPaperTrading ?? true;

        // --- NEW: Calculate Buffer Shortfall ---
        // Instead of just selling enough for the trade, we sell enough to get back to safety.
        const bufferPerExchange = riskManager.getMaxTradeBudget(); // Target cash level in each wallet

        const polyShortfall = Math.max(0, bufferPerExchange - this.polyCash);
        const kalshiShortfall = Math.max(0, bufferPerExchange - this.kalshiCash);

        // Target: restore the buffer AND cover the trade cost that triggered this.
        const targetReplenishment = amountNeeded + polyShortfall + kalshiShortfall;

        logger.info(`[RELAY] 🛡️ Buffer Maintenance: Trade needs $${amountNeeded.toFixed(2)}, shortfall is $${(polyShortfall + kalshiShortfall).toFixed(2)}. Target replenishment: $${targetReplenishment.toFixed(2)}`);

        const openPositions = this.getOpenPositions();
        openPositions.sort((a, b) => (a.expectedAnnualizedReturn || 0) - (b.expectedAnnualizedReturn || 0));

        let cashRecovered = 0;

        for (const worstPosition of openPositions) {
            if (cashRecovered >= targetReplenishment) break;

            const availableSize = worstPosition.size - (worstPosition.reservedSize || 0);
            if (availableSize <= 0) continue;

            const manager = this.registeredManagers.find(m => m.pairId === worstPosition.pairId);
            if (!manager) continue;

            logger.warn(`[RELAY] 🔄 Rellenando colchón. Liquidando peor posición: ${worstPosition.pairId} (EAR: ${(worstPosition.expectedAnnualizedReturn || 0).toFixed(3)})`);

            const sizeToSell = availableSize;

            if (isPaper) {
                const exitSim = manager.simulateExit(sizeToSell);

                // Fallback to a minor 5% spread loss if the orderbook is completely empty
                const assumedPolyExitPrice = exitSim.size > 0 ? (exitSim.polyRevenue / exitSim.size) : (worstPosition.polyCost / worstPosition.size) * 0.95;
                const assumedKalshiExitPrice = exitSim.size > 0 ? (exitSim.kalshiRevenue / exitSim.size) : (worstPosition.kalshiCost / worstPosition.size) * 0.95;
                const assumedFees = exitSim.size > 0 ? exitSim.totalKalshiFees : Math.ceil(0.07 * sizeToSell * assumedKalshiExitPrice * (1 - assumedKalshiExitPrice) * 100) / 100;

                this.closePosition(
                    worstPosition.pairId, sizeToSell,
                    assumedPolyExitPrice, assumedKalshiExitPrice, assumedFees
                );

                const recovered = (sizeToSell * assumedPolyExitPrice) + (sizeToSell * assumedKalshiExitPrice) - assumedFees;
                cashRecovered += recovered;
                logger.info(`[RELAY] ✅ Paper Exit completado. Recuperados ~$${recovered.toFixed(2)}`);
            } else {
                // == EJECUCIÓN REAL (LIVE ENGINE) ==
                worstPosition.reservedSize = (worstPosition.reservedSize || 0) + sizeToSell;

                const polyAssetId = worstPosition.type.includes('PolyYes') ? manager.polyYesTokenId : manager.polyNoTokenId;
                const kalshiSide = worstPosition.type.includes('KalshiYes') ? 'yes' : 'no';

                // Asumimos que recuperaremos aproximadamente el coste para avanzar el bucle
                cashRecovered += worstPosition.totalCost * (sizeToSell / worstPosition.size);

                return {
                    pairId: worstPosition.pairId,
                    marketQuestion: worstPosition.marketQuestion,
                    tradeType: worstPosition.type,
                    targetSize: sizeToSell,
                    polyAssetId: polyAssetId,
                    kalshiTicker: manager.pairData.kalshiMarket.internal_id,
                    kalshiSide: kalshiSide as 'yes' | 'no',
                    polyMaxVwap: 0.01,
                    kalshiMaxVwap: 0.01,
                    isEntry: false,
                    expectedEAR: 999,
                    availableLiquidity: sizeToSell
                }
            }
        }
    }
}