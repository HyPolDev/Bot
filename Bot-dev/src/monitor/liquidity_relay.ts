import { PortfolioManager } from '../portfolio/portfolio_manager.js';
import { logger } from '../utils/logger.js';
import { Settings } from '../db/models/Settings.js';
import { PairManager } from './pair_manager.js';
import { LiveEngine } from '../execution/live_engine.js';

export class LiquidityRelay {
    private portfolio: PortfolioManager;
    private liveEngine: LiveEngine;
    private isRunning: boolean = false;

    constructor(portfolio: PortfolioManager, liveEngine: LiveEngine) {
        this.portfolio = portfolio;
        this.liveEngine = liveEngine;
    }

    public start() {
        if (this.isRunning) return;
        this.isRunning = true;
        
        // Asynchronous rebalancer loop every 5 seconds
        setInterval(() => {
            this.evaluateRotations().catch((err: any) => {
                logger.error(`[LiquidityRelay] Loop Error: ${err.message}`);
            });
        }, 5000);
        
        logger.info(`[LiquidityRelay] Asynchronous relay started. Rotating worst positions when buffer depleted.`);
    }

    private async evaluateRotations() {
        // Wait until books are primed
        if (!this.liveEngine.isSystemReady) return;

        const settings = await Settings.findOne();
        if (!settings) return;

        const maxEquityPerTrade = (settings as any).maxEquityPerTrade ?? 100;

        const polyCash = this.portfolio.getPolyCash();
        const kalshiCash = this.portfolio.getKalshiCash();

        // 1. Buffer Trigger Check
        if (polyCash >= maxEquityPerTrade && kalshiCash >= maxEquityPerTrade) {
            return;
        }

        const missedOpps = (this.portfolio as any).recentMissedOpportunities;
        if (!missedOpps || missedOpps.length === 0) {
            return;
        }

        const bestMissedOpp = missedOpps.reduce((max: any, opp: any) => opp.ear > max.ear ? opp : max, missedOpps[0]);

        const openPositions = this.portfolio.getOpenPositions();
        if (openPositions.length === 0) return;

        // 2. Calculate Current Maintenance EAR
        const positionsWithMeta = openPositions.map(pos => {
            const daysToExpiration = pos.expiringDate ? 
                Math.max((new Date(pos.expiringDate).getTime() - Date.now()) / 86400000, 0.1) : 30;
            
            const costBasisPerShare = pos.totalCost / pos.size;
            const remainingProfit = 1.00 - costBasisPerShare;
            const maintenanceEAR = (remainingProfit / costBasisPerShare) * (365 / daysToExpiration);
            
            return { pos, maintenanceEAR, daysToExpiration };
        });

        // Sort ascending (worst first)
        positionsWithMeta.sort((a, b) => a.maintenanceEAR - b.maintenanceEAR);

        const registeredManagers: PairManager[] = (this.portfolio as any).getRegisteredManagers();

        // 3. Evaluate Exit Toll & Rotation Logic
        for (const { pos, maintenanceEAR, daysToExpiration } of positionsWithMeta) {
            const manager = registeredManagers.find(m => m.pairId === pos.pairId);
            if (!manager) continue;

            const sweep = this.getExitSweep(manager, pos);
            if (!sweep || sweep.size === 0) continue;

            const liquidationValue = sweep.polyVwap + sweep.kalshiVwap;
            const netExitPerShare = liquidationValue - (sweep.totalKalshiFees / sweep.size);
            
            if (netExitPerShare >= 1.00) continue; // Handled natively by TakeProfit rule

            const physicalLossPerShare = 1.00 - netExitPerShare; 
            const exitToll = physicalLossPerShare;

            // Normalize Toll into annualized percentage loss to compare against EAR
            const costBasisPerShare = pos.totalCost / pos.size;
            const annualizedToll = (exitToll / costBasisPerShare) * (365 / daysToExpiration);

            // Compare: does projected profit of new position strictly > expected holding profit + exit toll
            if (bestMissedOpp.ear > maintenanceEAR + annualizedToll) {
                logger.info(`[LiquidityRelay] ROTATING! Selling ${pos.pairId}. Missed EAR: ${(bestMissedOpp.ear*100).toFixed(1)}% > Holding EAR: ${(maintenanceEAR*100).toFixed(1)}% + Toll: ${(annualizedToll*100).toFixed(1)}%`);
                
                if (!settings.isPaperTrading) {
                    const polyAssetId = pos.type.includes('PolyYes') ? manager.polyYesTokenId : manager.polyNoTokenId;
                    const kalshiSide = pos.type.includes('KalshiYes') ? 'yes' : 'no';

                    this.liveEngine.queueOrder({
                        pairId: pos.pairId,
                        marketQuestion: pos.marketQuestion,
                        tradeType: pos.type,
                        targetSize: pos.size,
                        polyAssetId: polyAssetId,
                        kalshiTicker: manager.pairData.kalshiMarket.internal_id,
                        kalshiSide: kalshiSide as 'yes' | 'no',
                        polyMaxVwap: sweep.polyWorstPrice,
                        kalshiMaxVwap: sweep.kalshiWorstPriceCents / 100,
                        isEntry: false,
                        expectedEAR: bestMissedOpp.ear, // High priority rebalance execution
                        availableLiquidity: sweep.size,
                        expiringDate: pos.expiringDate
                    });
                } else {
                    this.portfolio.closePosition(pos.pairId, sweep.size, sweep.polyVwap, sweep.kalshiVwap, sweep.totalKalshiFees);
                    logger.info(`[LiquidityRelay] Paper traded rotation exit for ${pos.pairId}`);
                }
                
                // Clear state: wait for a new missed opportunity
                (this.portfolio as any).recentMissedOpportunities = [];
                break; // One position sold, let loop resume later
            }
        }
    }

    private getExitSweep(manager: PairManager, openPos: any): any {
        let polyBids: any[] = [];
        let kalshiBids: any[] = [];
        
        switch (openPos.type) {
            case 'PolyYes_KalshiNo':
                polyBids = manager.latestPolyBook.yes?.bids || [];
                kalshiBids = manager.latestKalshiBook?.no?.bids || [];
                break;
            case 'PolyNo_KalshiYes':
                polyBids = manager.latestPolyBook.no?.bids || [];
                kalshiBids = manager.latestKalshiBook?.yes?.bids || [];
                break;
            case 'PolyYes_KalshiYes_Flipped':
                polyBids = manager.latestPolyBook.yes?.bids || [];
                kalshiBids = manager.latestKalshiBook?.yes?.bids || [];
                break;
            case 'PolyNo_KalshiNo_Flipped':
                polyBids = manager.latestPolyBook.no?.bids || [];
                kalshiBids = manager.latestKalshiBook?.no?.bids || [];
                break;
        }

        const sweep = (manager as any).calculateBidSweep(polyBids, kalshiBids, openPos.size);
        if (sweep.size >= openPos.size * 0.99) return sweep; // Only exit if we can sell entire size to replenish properly
        return null;
    }
}
