import fs from 'fs';

export interface Position {
    pairId: string;
    marketQuestion: string;
    type: string;
    size: number;
    polyEntryPrice: number;
    kalshiEntryPrice: number;
    polyCost: number;           // NEW: Track exchange-specific cost
    kalshiCost: number;         // NEW: Track exchange-specific cost
    totalCost: number;
    timestamp: number;
}

export class PortfolioManager {
    private polyCash: number;
    private kalshiCash: number;
    private totalRealizedPnL: number = 0;

    private openPositions: Map<string, Position> = new Map();

    constructor(initialPoly: number, initialKalshi: number) {
        this.polyCash = initialPoly;
        this.kalshiCash = initialKalshi;
        console.log(`[Portfolio] Initialized. Poly: $${initialPoly} | Kalshi: $${initialKalshi}`);
    }

    // --- Core Ledger State ---

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

    // --- Risk Management Lookups ---

    public hasOpenPosition(pairId: string): boolean { return this.openPositions.has(pairId); }
    public getPosition(pairId: string): Position | undefined { return this.openPositions.get(pairId); }
    public getPairExposure(pairId: string): number {
        const position = this.openPositions.get(pairId);
        return position ? position.totalCost : 0;
    }

    // --- Execution Handlers ---

    public openPosition(
        pairId: string,
        marketQuestion: string,
        type: string,
        size: number,
        polyPrice: number,
        kalshiPrice: number
    ) {
        const polyCost = size * polyPrice;
        const kalshiCost = size * kalshiPrice;
        const totalCost = polyCost + kalshiCost;

        // Strict dual-wallet sanity check
        if (polyCost > this.polyCash || kalshiCost > this.kalshiCash) {
            console.error(`[Portfolio] FATAL: Insufficient funds! PolyCost: ${polyCost}, KalshiCost: ${kalshiCost}`);
            return;
        }

        // --- THE FIX: AVERAGE INTO EXISTING POSITIONS ---
        if (this.openPositions.has(pairId)) {
            const pos = this.openPositions.get(pairId)!;

            // Calculate new weighted average prices
            const newSize = pos.size + size;
            pos.polyEntryPrice = ((pos.size * pos.polyEntryPrice) + polyCost) / newSize;
            pos.kalshiEntryPrice = ((pos.size * pos.kalshiEntryPrice) + kalshiCost) / newSize;

            // Update totals
            pos.size = newSize;
            pos.polyCost += polyCost;
            pos.kalshiCost += kalshiCost;
            pos.totalCost += totalCost;

            this.polyCash -= polyCost;
            this.kalshiCash -= kalshiCost;

            // Log it as an ADD to the ledger
            this.logLedgerEvent(`ADD`, pos, 0, 0, size, totalCost);
            return;
        }

        // --- CREATE NEW POSITION ---
        const newPosition: Position = {
            pairId, marketQuestion, type, size,
            polyEntryPrice: polyPrice, kalshiEntryPrice: kalshiPrice,
            polyCost, kalshiCost, totalCost,
            timestamp: Date.now()
        };

        this.openPositions.set(pairId, newPosition);
        this.polyCash -= polyCost;
        this.kalshiCash -= kalshiCost;

        this.logLedgerEvent(`OPEN`, newPosition, 0, 0, size, totalCost);
    }

    public closePosition(pairId: string, exitSize: number, polyExitPrice: number, kalshiExitPrice: number) {
        const position = this.openPositions.get(pairId);
        if (!position) return;

        // We cannot exit more shares than we actually own
        const actualExitSize = Math.min(exitSize, position.size);

        const polyRevenue = actualExitSize * polyExitPrice;
        const kalshiRevenue = actualExitSize * kalshiExitPrice;
        const totalRevenue = polyRevenue + kalshiRevenue;

        // Calculate the exact cost basis of the shares we are selling
        const costBasis = actualExitSize * (position.polyEntryPrice + position.kalshiEntryPrice);
        const pnl = totalRevenue - costBasis;

        this.polyCash += polyRevenue;
        this.kalshiCash += kalshiRevenue;
        this.totalRealizedPnL += pnl;

        // If we sold everything, delete the position. Otherwise, update the remaining balances.
        if (actualExitSize === position.size) {
            this.openPositions.delete(pairId);
        } else {
            position.size -= actualExitSize;
            position.polyCost -= (actualExitSize * position.polyEntryPrice);
            position.kalshiCost -= (actualExitSize * position.kalshiEntryPrice);
            position.totalCost -= costBasis;
        }

        // Pass a cloned object to the logger so it records the exit size, not the remaining size
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