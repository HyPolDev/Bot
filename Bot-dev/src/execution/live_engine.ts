import { ExecutionPayload, ExecutionReceipt } from './types.js';
import { PolyClient } from './poly_client.js';
import { KalshiClient } from './kalshi_client.js';
import { logger } from '../utils/logger.js';
import { Trade } from '../db/models/Trade.js';

// Assume PortfolioManager can be injected or imported. Using basic logging for now.
// import { PortfolioManager } from '../portfolio/portfolio_manager.js';

export class LiveEngine {
    private polyClient: PolyClient;
    private kalshiClient: KalshiClient;
    private portfolioManager: any; // Injected instance
    private maxPositionSize: number;

    // Execution Queue State
    private tradeQueue: ExecutionPayload[] = [];
    private isExecuting: boolean = false;

    // Safety State
    private consecutiveOrphans: number = 0;
    private isShuttingDown: boolean = false;
    private lastExecutionTime: number = 0;
    public isSystemReady: boolean = false;

    constructor(portfolioManager: any) {
        this.polyClient = new PolyClient();
        this.kalshiClient = new KalshiClient();
        this.portfolioManager = portfolioManager;

        this.initExchangeClients();

        this.maxPositionSize = parseInt(process.env.MAX_POSITION_SIZE || '50', 10);

        // Start the background execution queue processor
        setInterval(() => this.processQueue(), 100);
    }

    private async initExchangeClients() {
        try {
            if (this.portfolioManager && typeof this.portfolioManager.attachExchangeClients === 'function') {
                await this.portfolioManager.attachExchangeClients(this.polyClient, this.kalshiClient);
            }
        } catch (error) {
            logger.error(`[LiveEngine] Failed to attach exchange clients:`, error);
        }
    }

    public queueOrder(payload: ExecutionPayload): void {
        this.tradeQueue.push(payload);
    }

    private async processQueue(): Promise<void> {
        if (this.isShuttingDown || this.isExecuting || this.tradeQueue.length === 0) return;

        const now = Date.now();
        // Enforce a minimum 2500ms cooldown between ANY transaction to prevent double spending
        if (now - this.lastExecutionTime < 2500) return;

        this.isExecuting = true;
        this.lastExecutionTime = now;

        try {
            // Priority Sort: (1) Expected Annualized Return [Higher is better] (2) Available Liquidity [Higher is better]
            this.tradeQueue.sort((a, b) => {
                const earA = a.expectedEAR || 0;
                const earB = b.expectedEAR || 0;
                if (earB !== earA) return earB - earA;

                const liqA = a.availableLiquidity || 0;
                const liqB = b.availableLiquidity || 0;
                return liqB - liqA;
            });

            // Pop the absolute best opportunity currently available
            const topOpportunity = this.tradeQueue.shift();

            // Clear the rest of the queue to prevent stale data execution (it immediately refills via WebSockets next frame)
            this.tradeQueue = [];

            if (topOpportunity) {
                await this.executeOrder(topOpportunity);
            }
        } finally {
            this.isExecuting = false;
        }
    }

    private async executeOrder(payload: ExecutionPayload): Promise<void> {
        if (payload.targetSize > this.maxPositionSize) {
            logger.warn(`[LIVE ENGINE] ⚠️ SAFETY LIMIT: Reducing target size from ${payload.targetSize} to ${this.maxPositionSize}`);
            payload.targetSize = this.maxPositionSize;
        }

        const nominalPolyUsd = payload.targetSize * payload.polyMaxVwap;
        if (nominalPolyUsd < 1.00) {
            logger.info(`[LIVE ENGINE] Aborting Poly Order. Nominal size $${nominalPolyUsd.toFixed(2)} is less than Polymarket $1.00 constraint.`);
            return;
        }

        logger.info(`[LIVE ENGINE] SEQUENTIAL LEGGING: Firing strict Kalshi limits for pair ${payload.pairId}...`);

        try {
            // Leg 1: The Bottleneck Exchange (Kalshi has tighter constraints and lower liquidity)
            const kalshiReceipt = await this.kalshiClient.placeAggressiveLimit(payload.kalshiTicker, payload.kalshiSide, payload.isEntry, payload.targetSize, payload.kalshiMaxVwap);

            if (kalshiReceipt.status !== 'filled') {
                logger.warn(`[LIVE ENGINE] Kalshi leg rejected/canceled. Aborting Polymarket execution. Zero orphans created!`);
                if (kalshiReceipt.error) logger.info(`Kalshi Error Context: ${kalshiReceipt.error}`);
                return; // Safely abort with zero exposure
            }

            // Leg 2: Catch-up on highly liquid Polymarket
            const guaranteedSize = kalshiReceipt.executedSize || payload.targetSize;
            logger.info(`[LIVE ENGINE] Kalshi anchored ${guaranteedSize} contracts. Sending FAK market-take to Polymarket...`);

            // To guarantee we don't orphan if Poly moved by 1-2 cents, we increase slip tolerance on the 2nd leg by 2 cents.
            // (We are sacrificing a few cents of potential profit to guarantee we don't get stuck holding directional delta)
            const polySlipBuff = payload.isEntry ? 0.02 : -0.02;
            let slipTargetPolyPrice = payload.polyMaxVwap + polySlipBuff;

            // Constrain limits to 0.01 and 0.99
            if (slipTargetPolyPrice > 0.99) slipTargetPolyPrice = 0.99;
            if (slipTargetPolyPrice < 0.01) slipTargetPolyPrice = 0.01;

            const polyReceipt = await this.polyClient.placeAggressiveLimit(payload.polyAssetId, payload.isEntry, guaranteedSize, slipTargetPolyPrice);

            await this.reconcile(payload, polyReceipt, kalshiReceipt);
        } catch (error) {
            logger.error(`[LIVE ENGINE] Unhandled exception during sequential execution:`, error instanceof Error ? error.stack : error);
        }
    }

    private async reconcile(payload: ExecutionPayload, polyReceipt: ExecutionReceipt, kalshiReceipt: ExecutionReceipt): Promise<void> {
        logger.info(`[LIVE ENGINE] Reconciliation Phase. Poly: ${polyReceipt.status}, Kalshi: ${kalshiReceipt.status}`);

        const polyFilled: boolean = polyReceipt.status === 'filled';
        const kalshiFilled: boolean = kalshiReceipt.status === 'filled';

        if (polyFilled && kalshiFilled) {
            const polySize = polyReceipt.executedSize || payload.targetSize;
            const kalshiSize = kalshiReceipt.executedSize || payload.targetSize;

            if (polySize === kalshiSize) {
                // Success - Perfect Hedge
                logger.info(`[LIVE ENGINE] Success! Both legs perfectly filled ${polySize} contracts.`);
                this.consecutiveOrphans = 0; // Reset safety counter on success
            } else {
                // Partial Fill Orphan - Mismatched Execution
                this.consecutiveOrphans++;
                logger.error(`[LIVE ENGINE] [CRITICAL] PARTIAL FILL ORPHAN DETECTED! Poly: ${polySize}, Kalshi: ${kalshiSize} (Count: ${this.consecutiveOrphans}/2)`);

                // Ban the pair
                if (this.portfolioManager && typeof this.portfolioManager.banPair === 'function') {
                    this.portfolioManager.banPair(payload.pairId, 600000); // 10 minutes
                }

                const deltaShareCount = Math.abs(polySize - kalshiSize);

                if (polySize > kalshiSize) {
                    logger.error(`[LIVE ENGINE] Polymarket overfilled by ${deltaShareCount}. Triggering Poly Emergency Dump...`);
                    this.triggerEmergencyHedge('Polymarket', payload.polyAssetId, payload.isEntry, deltaShareCount);
                } else {
                    logger.error(`[LIVE ENGINE] Kalshi overfilled by ${deltaShareCount}. Triggering Kalshi Emergency Dump...`);
                    this.triggerEmergencyHedge('Kalshi', payload.kalshiTicker, payload.isEntry, deltaShareCount, payload.kalshiSide);
                }

                if (this.consecutiveOrphans >= 2 && !this.isShuttingDown) {
                    this.isShuttingDown = true;
                    logger.error(`\n=============================================================`);
                    logger.error(`[FATAL SAFETY LOCK] TWO CONSECUTIVE ORPHAN EVENTS DETECTED.`);
                    logger.error(`[FATAL SAFETY LOCK] SUSPECTING MAJOR API DRIFT OR BALANCE FAILURE.`);
                    logger.error(`[FATAL SAFETY LOCK] PERFORMING EMERGENCY SHUTDOWN TO PROTECT CAPITAL.`);
                    logger.error(`=============================================================\n`);
                    setTimeout(() => process.exit(1), 500); // Leave a tiny event loop margin so Winston can flush the log file to disk
                }
            }

            const polyPrice = polyReceipt.executedPrice || payload.polyMaxVwap;
            const kalshiPrice = kalshiReceipt.executedPrice || payload.kalshiMaxVwap;

            // Apply Kalshi Taker fee formula
            const kalshiFeeAmount = this.calculateKalshiTakerFee(kalshiPrice, Math.min(polySize, kalshiSize));

            logger.info(`[LIVE ENGINE] Poly Executed: ${polySize} shares @ $${polyPrice}`);
            logger.info(`[LIVE ENGINE] Kalshi Executed: ${kalshiSize} shares @ $${kalshiPrice}`);

            if (this.portfolioManager) {
                // The final executed size is the bottleneck of the two exchanges.
                // We always book the successfully matched portion onto the ledger regardless of if the overflow orphaned
                const finalSize = Math.min(polySize, kalshiSize);

                if (finalSize > 0) {
                    if (payload.isEntry) {
                        // It's a BUY order, so we OPEN or ADD to the position
                        this.portfolioManager.openPosition(
                            payload.pairId,
                            payload.marketQuestion,
                            payload.tradeType,
                            finalSize,
                            polyPrice,
                            kalshiPrice,
                            kalshiFeeAmount,
                            payload.expectedEAR,
                            payload.expiringDate
                        );
                    } else {
                        this.portfolioManager.closePosition(
                            payload.pairId,
                            finalSize,
                            polyPrice,
                            kalshiPrice,
                            kalshiFeeAmount
                        );
                    }

                    // Asynchronously Push to the Physical DB Trade Ledger
                    Trade.create({
                        pairId: payload.pairId,
                        marketQuestion: payload.marketQuestion,
                        type: payload.isEntry ? 'buy' : 'sell',
                        polyQuantity: finalSize,
                        kalshiQuantity: finalSize,
                        averagePolyPrice: polyPrice,
                        averageKalshiPrice: kalshiPrice + (kalshiFeeAmount / finalSize) // Bake the fee slippage into the true Kalshi fill price
                    }).catch(e => logger.error(`[LIVE ENGINE] Error persisting Trade to DB: ${e.message}`));
                }

                // Fetch the true physical state directly from the exchanges to correct any precision or fee slippage
                if (typeof this.portfolioManager.syncPositions === 'function') {
                    // Start an async background sync, no need to await it
                    this.portfolioManager.syncPositions().catch((e: Error) => logger.error(`Background sync error: ${e.message}`));
                }
            }
        } else if (!polyFilled && !kalshiFilled) {
            // Total Miss
            logger.warn(`[LIVE ENGINE] Missed Spread. Both orders canceled or failed.`);
            if (polyReceipt.error) logger.info(`Poly Error: ${polyReceipt.error}`);
            if (kalshiReceipt.error) logger.info(`Kalshi Error: ${kalshiReceipt.error}`);
        } else {
            // The Orphaned Leg
            this.consecutiveOrphans++;
            logger.error(`[LIVE ENGINE] [CRITICAL] ORPHAN_HEDGE_EVENT DETECTED! One leg filled, the other failed! (Count: ${this.consecutiveOrphans}/2)`);
            if (kalshiReceipt.error) logger.error(`[LIVE ENGINE] Kalshi API Error Context: ${kalshiReceipt.error}`);
            if (polyReceipt.error) logger.error(`[LIVE ENGINE] Poly API Error Context: ${polyReceipt.error}`);

            // Immediately ban the pair to prevent revenge trading loops
            if (this.portfolioManager && typeof this.portfolioManager.banPair === 'function') {
                this.portfolioManager.banPair(payload.pairId, 600000); // 10 minutes
            }

            if (polyFilled) {
                logger.error(`[LIVE ENGINE] Polymarket filled, Kalshi failed. Triggering Poly Emergency Hedge...`);
                // Asynchronously sell the filled leg back to the market at best bid
                // Using 0.01 as a dummy "best bid" or market order equivalent for IOC
                this.triggerEmergencyHedge('Polymarket', payload.polyAssetId, payload.isEntry, polyReceipt.executedSize || payload.targetSize);
            }

            if (kalshiFilled) {
                logger.error(`[LIVE ENGINE] Kalshi filled, Polymarket failed. Triggering Kalshi Emergency Hedge...`);
                this.triggerEmergencyHedge('Kalshi', payload.kalshiTicker, payload.isEntry, kalshiReceipt.executedSize || payload.targetSize, payload.kalshiSide);
            }

            if (this.consecutiveOrphans >= 2 && !this.isShuttingDown) {
                this.isShuttingDown = true;
                logger.error(`\n=============================================================`);
                logger.error(`[FATAL SAFETY LOCK] TWO CONSECUTIVE ORPHAN EVENTS DETECTED.`);
                logger.error(`[FATAL SAFETY LOCK] SUSPECTING MAJOR API DRIFT OR BALANCE FAILURE.`);
                logger.error(`[FATAL SAFETY LOCK] PERFORMING EMERGENCY SHUTDOWN TO PROTECT CAPITAL.`);
                logger.error(`=============================================================\n`);
                setTimeout(() => process.exit(1), 500); // Flush logs before crash
            }
        }
    }

    private calculateKalshiTakerFee(executedPrice: number, size: number): number {
        // Canonical Kalshi taker fee: ceil(0.07 * totalContracts * P * (1-P))
        // Applied once to the full block — consistent with entry-side fee calculation in PairManager.
        return Math.ceil(0.07 * size * executedPrice * (1 - executedPrice) * 100) / 100;
    }

    private triggerEmergencyHedge(exchange: 'Polymarket' | 'Kalshi', assetIdentifier: string, originalEntry: boolean, size: number, kalshiSide: 'yes' | 'no' = 'yes') {
        // We trigger asynchronously without awaiting so the main engine doesn't block
        setImmediate(async () => {
            try {
                const hedgeDirection = !originalEntry; // if we bought, we now sell

                if (exchange === 'Polymarket') {
                    logger.info(`[EMERGENCY ROUTINE] Waiting 5 seconds for Polymarket Blockchain settlement before dumping...`);
                    await new Promise(resolve => setTimeout(resolve, 5500));

                    logger.info(`[EMERGENCY ROUTINE] Reverse action (${hedgeDirection ? 'BUY' : 'SELL'}) ${size} shares on Polymarket for ${assetIdentifier}`);
                    await this.polyClient.placeMarketOrder(assetIdentifier, hedgeDirection, size);
                } else if (exchange === 'Kalshi') {
                    logger.info(`[EMERGENCY ROUTINE] Reverse action (${hedgeDirection ? 'BUY' : 'SELL'}) ${size} shares on Kalshi for ${assetIdentifier} (${kalshiSide})`);
                    await this.kalshiClient.placeMarketOrder(assetIdentifier, kalshiSide, hedgeDirection, size);
                }
                logger.info(`[EMERGENCY ROUTINE] Hedge execution request sent for ${exchange}.`);
            } catch (err) {
                logger.error(`[EMERGENCY ROUTINE] FAILED to flat Delta on ${exchange}! Position is unhedged!`, err);
            }
        });
    }
}



