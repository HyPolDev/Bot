import { logger } from '../utils/logger.js';
import { PortfolioManager } from './portfolio_manager.js';
import { Position } from '../db/models/Position.js';
import { SimulatedPosition } from '../db/models/SimulatedPosition.js';
import { Settings } from '../db/models/Settings.js';

export class SettlementManager {
    private portfolio: PortfolioManager;
    private polyClient: any;
    private kalshiClient: any;
    private registeredManagers: any[] = [];

    constructor(portfolio: PortfolioManager, polyClient: any, kalshiClient: any) {
        this.portfolio = portfolio;
        this.polyClient = polyClient;
        this.kalshiClient = kalshiClient;
    }

    public setManagers(managers: any[]) {
        this.registeredManagers = managers;
    }

    public startMonitors() {
        // Run every 5 minutes (300,000 ms)
        setInterval(() => this.checkOpenPositions(), 5 * 60 * 1000);
        // Run every 30 minutes (1,800,000 ms)
        setInterval(() => this.finalizeSettlements(), 30 * 60 * 1000);
        logger.info(`[SettlementManager] Initialization complete. Monitor loops active.`);
    }

    public async checkOpenPositions() {
        const settings = await Settings.findOne();
        if (settings?.isPaperTrading) return; // Sim engine uses CLI triggers instead

        const openPositions = this.portfolio.getOpenPositions().filter((p: any) => !p.state || p.state === 'open');

        for (const pos of openPositions) {
            const manager = this.registeredManagers.find(m => m.pairId === pos.pairId);
            if (!manager) continue;

            const polyConditionId = manager.pairData?.polyMarket?.condition_id || pos.pairId.split('+')[0];
            const kalshiTicker = manager.pairData?.kalshiMarket?.internal_id || pos.pairId.split('+')[1];

            try {
                const [isPolyResolved, isKalshiResolved] = await Promise.all([
                    this.polyClient.isMarketResolved(polyConditionId),
                    this.kalshiClient.isMarketSettled(kalshiTicker)
                ]);

                if (isPolyResolved || isKalshiResolved) {
                    pos.state = 'settling';
                    await Position.updateOne({ pairId: pos.pairId, state: 'open' }, { $set: { state: 'settling' } });
                    logger.info(`[Settlement] 🔒 Quarantined ${pos.pairId}. Market resolved, awaiting payout.`);
                }
            } catch (err: any) {
                logger.error(`[Settlement] Error checking resolution for ${pos.pairId}: ${err.message}`);
            }
        }
    }

    public async finalizeSettlements() {
        const settings = await Settings.findOne();
        const isPaperTrading = settings?.isPaperTrading ?? true;

        // Find positions quarantined in RAM
        const allPositions = (this.portfolio as any).openPositions as Map<string, any>;
        const settlingPositions = Array.from(allPositions.values()).filter((p: any) => p.state === 'settling');

        for (const pos of settlingPositions) {
            logger.info(`[Settlement] 🔎 Checking finalization for SETTLING position: ${pos.pairId}`);

            if (isPaperTrading) {
                // In paper trading, sim:resolve injects simulatedWinner into the DB.
                const dbPos = await SimulatedPosition.findOne({ pairId: pos.pairId, state: 'settling' });
                if (dbPos && dbPos.simulatedWinner) {
                    // Bypass APIs. Inject $1 payout x size
                    const payout = pos.size * 1.00;
                    if (dbPos.simulatedWinner === 'polymarket') {
                        (this.portfolio as any).polyCash += payout;
                    } else {
                        (this.portfolio as any).kalshiCash += payout;
                    }
                    
                    (this.portfolio as any).totalRealizedPnL += (payout - pos.totalCost);

                    pos.state = 'closed';
                    await SimulatedPosition.updateOne({ pairId: pos.pairId, state: 'settling' }, { $set: { state: 'closed' } });
                    allPositions.delete(pos.pairId);
                    logger.info(`[Settlement] ✅ Fully Closed Simulated Position ${pos.pairId}. Funds $${payout.toFixed(2)} returned to active ledger.`);
                }
                continue;
            }

            // Real physical checking
            const manager = this.registeredManagers.find(m => m.pairId === pos.pairId);
            if (!manager) continue;

            const polyConditionId = manager.pairData?.polyMarket?.condition_id || pos.pairId.split('+')[0];
            const kalshiTicker = manager.pairData?.kalshiMarket?.internal_id || pos.pairId.split('+')[1];

            try {
                // 1. Verify Kalshi has auto-settled
                const kalshiSettled = await this.kalshiClient.isMarketSettled(kalshiTicker);

                // 2. Execute Polymarket On-Chain Redemption if resolved
                let polyRedeemed = false;
                const isPolyResolved = await this.polyClient.isMarketResolved(polyConditionId);
                
                if (isPolyResolved) {
                    polyRedeemed = await this.polyClient.claimWinnings(polyConditionId);
                }

                // 3. Close the Position only if BOTH legs are finalized
                // We add kalshiSettled manually bypassing API validation if Kalshi has dropped sizes to 0 and Poly is redeemed perfectly.
                if (kalshiSettled && polyRedeemed) {
                    pos.state = 'closed';
                    await Position.updateOne({ pairId: pos.pairId, state: 'settling' }, { $set: { state: 'closed' } });
                    allPositions.delete(pos.pairId);
                    logger.info(`[Settlement] ✅ Fully Closed ${pos.pairId}. Funds returned to active ledger.`);

                    // Trigger a hard sync to update internal balances with the newly claimed cash
                    await this.portfolio.syncBalances();
                }
            } catch (err: any) {
                logger.error(`[Settlement] Error finalizing ${pos.pairId}: ${err.message}`);
            }
        }
    }
}
