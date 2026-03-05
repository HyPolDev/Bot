import * as fs from 'fs';
import { logger } from '../utils/logger.js';

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

    public attachExchangeClients(polyClient: any, kalshiClient: any) {
        this.polyClient = polyClient;
        this.kalshiClient = kalshiClient;

        // Reconstruct State BEFORE starting the interval sync
        this.recoverPositionsFromLedger();

        // Immediately sync and then sync every 60 seconds
        this.syncBalances();
        setInterval(() => this.syncBalances(), 60000);
    }

    public recoverPositionsFromLedger() {
        try {
            if (!fs.existsSync('portfolio_ledger.txt')) return;

            const ledgerData = fs.readFileSync('portfolio_ledger.txt', 'utf8');
            const lines = ledgerData.split('\n');

            let currentAction: string | null = null;
            let currentMarket: string | null = null;
            let currentSize: number = 0;
            let currentCost: number = 0;
            let currentType: string = '';

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                if (line.includes('LEDGER OPEN:') || line.includes('LEDGER ADD:') || line.includes('LEDGER CLOSE:')) {
                    const match = line.match(/LEDGER (OPEN|ADD|CLOSE):\s+(.*?)(\.\.\.)?$/);
                    if (match) {
                        currentAction = match[1];
                        currentMarket = match[2].trim();
                    }
                } else if (line.includes('Action Size:') || line.includes('Size:')) {
                    if (currentAction === 'OPEN' || currentAction === 'ADD') {
                        const match = line.match(/Action Size:\s+\+(\d+)\s+\|\s+Action Cost:\s+\$([\d.]+)\s+\|\s+Type:\s+(\w+)/);
                        if (match) {
                            currentSize = parseInt(match[1], 10);
                            currentCost = parseFloat(match[2]);
                            currentType = match[3];

                            const pairId = Buffer.from(currentMarket!).toString('base64');

                            let avgEntry = 0;
                            const nextLine = lines[i + 1] || '';
                            const avgMatch = nextLine.match(/Avg Entry:\s+([\d.]+)/);
                            if (avgMatch) {
                                avgEntry = parseFloat(avgMatch[1]);
                            }

                            const oldPos = this.openPositions.get(pairId);
                            const oldSize = oldPos ? oldPos.size : 0;
                            const oldAvgEntry = oldPos ? (oldPos.polyEntryPrice + oldPos.kalshiEntryPrice) : 0;

                            const newTotalSize = oldSize + currentSize;
                            let actionEntryPrice = 0;
                            if (avgEntry > 0) {
                                actionEntryPrice = (avgEntry * newTotalSize - oldAvgEntry * oldSize) / currentSize;
                            } else {
                                actionEntryPrice = currentCost / currentSize;
                            }

                            const rawExecutionCost = actionEntryPrice * currentSize;
                            let actionFees = currentCost - rawExecutionCost;
                            if (actionFees < 0) actionFees = 0;

                            this.openPosition(
                                pairId,
                                currentMarket!,
                                currentType,
                                currentSize,
                                actionEntryPrice / 2, // Poly allocation
                                actionEntryPrice / 2, // kalshi allocation 
                                actionFees // properly extracted Kalshi taker fees!
                            );
                        }
                    } else if (currentAction === 'CLOSE') {
                        const match = line.match(/Size:\s+(\d+)\s+\|\s+Type:\s+(\w+)/);
                        if (match) {
                            currentSize = parseInt(match[1], 10);
                            const pairId = Buffer.from(currentMarket!).toString('base64');

                            const pos = this.openPositions.get(pairId);
                            if (pos) {
                                if (currentSize >= pos.size) {
                                    this.openPositions.delete(pairId);
                                } else {
                                    const oldSize = pos.size;
                                    pos.size -= currentSize;
                                    pos.polyCost -= (currentSize * (pos.polyCost / oldSize));
                                    pos.kalshiCost -= (currentSize * (pos.kalshiCost / oldSize));
                                    pos.totalCost -= (currentSize * (pos.totalCost / oldSize));
                                }
                            }
                        }
                    }
                }
            }

            const restoredCount = this.openPositions.size;
            if (restoredCount > 0) {
                logger.info(`[Portfolio] 🔄 LEDGER RECOVERY COMPLETE: Restored ${restoredCount} active positions into memory.`);
            }

        } catch (error) {
            logger.error(`[Portfolio] ⚠️ Failed to recover state from ledger! System booting fresh.`, error);
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
                            const typeStr = polyPosYes ? "PolyYes_Recovered" : "PolyNo_Recovered";
                            this.openPositions.set(pairId, {
                                pairId,
                                marketQuestion: manager.pairData.polyMarket.market_question,
                                type: typeStr,
                                size: realSize,
                                polyEntryPrice: polyPosYes ? polyPosYes.avg_cost : 0.5,
                                kalshiEntryPrice: 0.5,
                                polyCost: (polyPosYes ? polyPosYes.avg_cost : 0.5) * realSize,
                                kalshiCost: 0.5 * realSize,
                                totalCost: realSize * 1.0,
                                timestamp: Date.now()
                            });
                            logger.info(`[Portfolio] 🔄 Auto-restored physical position ${pairId} with size ${realSize}`);
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
        polyPrice: number, kalshiPrice: number, kalshiFees: number
    ) {
        const polyCost = size * polyPrice;
        const kalshiCost = size * kalshiPrice;
        const totalCost = polyCost + kalshiCost + kalshiFees;

        if (polyCost > this.polyCash || (kalshiCost + kalshiFees) > this.kalshiCash) {
            logger.error(`[Portfolio] FATAL: Insufficient funds! PolyCost: ${polyCost}, KalshiReq: ${kalshiCost + kalshiFees}`);
            return;
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

            this.logLedgerEvent(`ADD`, pos, 0, 0, size, totalCost);
            return;
        }

        const newPosition: Position = {
            pairId, marketQuestion, type, size,
            polyEntryPrice: polyPrice, kalshiEntryPrice: kalshiPrice,
            polyCost,
            kalshiCost: kalshiCost + kalshiFees, // Include fees in the tracker
            totalCost,
            timestamp: Date.now()
        };

        this.openPositions.set(pairId, newPosition);
        this.polyCash -= polyCost;
        this.kalshiCash -= (kalshiCost + kalshiFees);

        this.logLedgerEvent(`OPEN`, newPosition, 0, 0, size, totalCost);
    }

    public closePosition(
        pairId: string, exitSize: number, polyExitPrice: number, kalshiExitPrice: number, kalshiExitFees: number
    ) {
        const position = this.openPositions.get(pairId);
        if (!position) return;

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

            // Proportionally reduce the internal trackers
            position.polyCost -= (actualExitSize * (position.polyCost / oldSize));
            position.kalshiCost -= (actualExitSize * (position.kalshiCost / oldSize));
            position.totalCost -= costBasis;
        }

        const logPosition = { ...position, size: actualExitSize };
        this.logLedgerEvent(`CLOSE`, logPosition, pnl, totalRevenue);
    }

    private logLedgerEvent(action: string, position: Position, pnl: number = 0, revenue: number = 0, addedSize: number = 0, addedCost: number = 0) {
        const time = new Date().toISOString();
        let msg = `[${time}] LEDGER ${action}: ${position.marketQuestion.substring(0, 50)}...\n`;

        if (action === 'OPEN' || action === 'ADD') {
            msg += `  Action Size: +${addedSize} | Action Cost: $${addedCost.toFixed(2)} | Type: ${position.type}\n`;
            msg += `  Total Position Size: ${position.size} | Avg Entry: ${(position.polyEntryPrice + position.kalshiEntryPrice).toFixed(3)}\n`;
            msg += `  New Balances: Poly $${this.polyCash.toFixed(2)} | Kalshi $${this.kalshiCash.toFixed(2)}\n`;
        } else {
            msg += `  Size: ${position.size} | Type: ${position.type}\n`;
            msg += `  Exit Revenue: $${revenue.toFixed(2)} | PnL: $${pnl.toFixed(2)}\n`;
            msg += `  Total Equity: $${this.getTotalEquity().toFixed(2)}\n`;
        }
        msg += `--------------------------------------------------\n`;

        fs.appendFileSync('portfolio_ledger.txt', msg, 'utf8');
    }
}