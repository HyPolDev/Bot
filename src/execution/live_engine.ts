import { ExecutionPayload, ExecutionReceipt } from './types.js';
import { PolyClient } from './poly_client.js';
import { KalshiClient } from './kalshi_client.js';

// Assume PortfolioManager can be injected or imported. Using basic logging for now.
// import { PortfolioManager } from '../portfolio/portfolio_manager.js';

export class LiveEngine {
    private polyClient: PolyClient;
    private kalshiClient: KalshiClient;
    private portfolioManager: any; // Injected instance
    private maxPositionSize: number;

    constructor(portfolioManager: any) {
        this.polyClient = new PolyClient();
        this.kalshiClient = new KalshiClient();
        this.portfolioManager = portfolioManager;
        this.maxPositionSize = parseInt(process.env.MAX_POSITION_SIZE || '50', 10);
    }

    public async executeOrder(payload: ExecutionPayload): Promise<void> {
        if (payload.targetSize > this.maxPositionSize) {
            console.warn(`[LIVE ENGINE] ⚠️ SAFETY LIMIT: Reducing target size from ${payload.targetSize} to ${this.maxPositionSize}`);
            payload.targetSize = this.maxPositionSize;
        }

        const nominalPolyUsd = payload.targetSize * payload.polyMaxVwap;
        if (nominalPolyUsd < 1.00) {
            console.log(`[LIVE ENGINE] Aborting Poly Order. Nominal size $${nominalPolyUsd.toFixed(2)} is less than Polymarket $1.00 constraint.`);
            return;
        }

        console.log(`[LIVE ENGINE] Firing concurrent FOK/IOC orders for pair ${payload.pairId}`);

        try {
            const [polyReceipt, kalshiReceipt] = await Promise.all([
                this.polyClient.placeAggressiveLimit(payload.polyAssetId, payload.isEntry, payload.targetSize, payload.polyMaxVwap),
                this.kalshiClient.placeAggressiveLimit(payload.kalshiTicker, payload.kalshiSide, payload.isEntry, payload.targetSize, payload.kalshiMaxVwap)
            ]);

            await this.reconcile(payload, polyReceipt, kalshiReceipt);
        } catch (error) {
            console.error(`[LIVE ENGINE] Unhandled exception during concurrent execution:`, error);
        }
    }

    private async reconcile(payload: ExecutionPayload, polyReceipt: ExecutionReceipt, kalshiReceipt: ExecutionReceipt): Promise<void> {
        console.log(`[LIVE ENGINE] Reconciliation Phase. Poly: ${polyReceipt.status}, Kalshi: ${kalshiReceipt.status}`);

        const polyFilled: boolean = polyReceipt.status === 'filled';
        const kalshiFilled: boolean = kalshiReceipt.status === 'filled';

        if (polyFilled && kalshiFilled) {
            // Success
            console.log(`[LIVE ENGINE] Success! Both legs filled.`);

            const polySize = polyReceipt.executedSize || payload.targetSize;
            const polyPrice = polyReceipt.executedPrice || payload.polyMaxVwap;

            const kalshiSize = kalshiReceipt.executedSize || payload.targetSize;
            const kalshiPrice = kalshiReceipt.executedPrice || payload.kalshiMaxVwap;

            // Apply Kalshi Taker fee formula
            const kalshiFeeAmount = this.calculateKalshiTakerFee(kalshiPrice, kalshiSize);
            const totalKalshiCost = (kalshiSize * kalshiPrice) + kalshiFeeAmount;

            console.log(`[LIVE ENGINE] Poly Executed: ${polySize} shares @ $${polyPrice}`);
            console.log(`[LIVE ENGINE] Kalshi Executed: ${kalshiSize} shares @ $${kalshiPrice} (Fee: $${kalshiFeeAmount})`);

            if (this.portfolioManager) {
                // The final executed size is the bottleneck of the two exchanges
                const finalSize = Math.min(polySize, kalshiSize);

                if (payload.isEntry) {
                    // It's a BUY order, so we OPEN or ADD to the position
                    this.portfolioManager.openPosition(
                        payload.pairId,
                        `${payload.polyAssetId} / ${payload.kalshiTicker}`, // Fallback market name
                        payload.tradeType,
                        finalSize,
                        polyPrice,
                        kalshiPrice,
                        kalshiFeeAmount
                    );
                } else {
                    // It's a SELL order, so we CLOSE the position to realize profits
                    this.portfolioManager.closePosition(
                        payload.pairId,
                        finalSize,
                        polyPrice,
                        kalshiPrice,
                        kalshiFeeAmount
                    );
                }
            }
        } else if (!polyFilled && !kalshiFilled) {
            // Total Miss
            console.warn(`[LIVE ENGINE] Missed Spread. Both orders canceled or failed.`);
            if (polyReceipt.error) console.debug(`Poly Error:`, polyReceipt.error);
            if (kalshiReceipt.error) console.debug(`Kalshi Error:`, kalshiReceipt.error);
        } else {
            // The Orphaned Leg
            console.error(`[LIVE ENGINE] [CRITICAL] ORPHAN_HEDGE_EVENT DETECTED! One leg filled, the other failed!`);

            if (polyFilled) {
                console.error(`[LIVE ENGINE] Polymarket filled, Kalshi failed. Triggering Poly Emergency Hedge...`);
                // Asynchronously sell the filled leg back to the market at best bid
                // Using 0.01 as a dummy "best bid" or market order equivalent for IOC
                this.triggerEmergencyHedge('Polymarket', payload.polyAssetId, payload.isEntry, polyReceipt.executedSize || payload.targetSize);
            }

            if (kalshiFilled) {
                console.error(`[LIVE ENGINE] Kalshi filled, Polymarket failed. Triggering Kalshi Emergency Hedge...`);
                this.triggerEmergencyHedge('Kalshi', payload.kalshiTicker, payload.isEntry, kalshiReceipt.executedSize || payload.targetSize, payload.kalshiSide);
            }
        }
    }

    private calculateKalshiTakerFee(executedPrice: number, size: number): number {
        // Kalshi Dynamic Taker Fee Calculation (Post-execution)
        // Let's assume price is in dollars (e.g. 0.52). Convert to cents for calculation.
        const priceCents = Math.round(executedPrice * 100);

        let feePerContractCents = 0;
        // Typically, Kalshi taker limit fees are around ~7% of the smaller probability (price or 100-price)
        // or a flat minimal fee. This varies slightly with new tiers. 
        // Using a standard placeholder calculation:
        const minProb = Math.min(priceCents, 100 - priceCents);
        feePerContractCents = Math.floor(minProb * 0.07); // ~7% of the implied probability 

        // Cap or specifics can be added here

        const totalFeeCents = feePerContractCents * size;
        return totalFeeCents / 100; // Return in dollars
    }

    private triggerEmergencyHedge(exchange: 'Polymarket' | 'Kalshi', assetIdentifier: string, originalEntry: boolean, size: number, kalshiSide: 'yes' | 'no' = 'yes') {
        // We trigger asynchronously without awaiting so the main engine doesn't block
        setImmediate(async () => {
            try {
                const hedgeDirection = !originalEntry; // if we bought, we now sell

                if (exchange === 'Polymarket') {
                    console.log(`[EMERGENCY ROUTINE] Waiting 5 seconds for Polymarket Blockchain settlement before dumping...`);
                    await new Promise(resolve => setTimeout(resolve, 5500));

                    console.log(`[EMERGENCY ROUTINE] Reverse action (${hedgeDirection ? 'BUY' : 'SELL'}) ${size} shares on Polymarket for ${assetIdentifier}`);
                    await this.polyClient.placeMarketOrder(assetIdentifier, hedgeDirection, size);
                } else if (exchange === 'Kalshi') {
                    console.log(`[EMERGENCY ROUTINE] Reverse action (${hedgeDirection ? 'BUY' : 'SELL'}) ${size} shares on Kalshi for ${assetIdentifier} (${kalshiSide})`);
                    await this.kalshiClient.placeMarketOrder(assetIdentifier, kalshiSide, hedgeDirection, size);
                }
                console.log(`[EMERGENCY ROUTINE] Hedge execution request sent for ${exchange}.`);
            } catch (err) {
                console.error(`[EMERGENCY ROUTINE] FAILED to flat Delta on ${exchange}! Position is unhedged!`, err);
            }
        });
    }
}
