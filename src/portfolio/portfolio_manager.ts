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
        if (this.openPositions.has(pairId)) return;

        const polyCost = size * polyPrice;
        const kalshiCost = size * kalshiPrice;
        const totalCost = polyCost + kalshiCost;

        // Strict dual-wallet sanity check
        if (polyCost > this.polyCash || kalshiCost > this.kalshiCash) {
            console.error(`[Portfolio] FATAL: Insufficient funds on one of the exchanges! PolyCost: ${polyCost}, KalshiCost: ${kalshiCost}`);
            return;
        }

        const newPosition: Position = {
            pairId, marketQuestion, type, size,
            polyEntryPrice: polyPrice, kalshiEntryPrice: kalshiPrice,
            polyCost, kalshiCost, totalCost,
            timestamp: Date.now()
        };

        this.openPositions.set(pairId, newPosition);
        this.polyCash -= polyCost;
        this.kalshiCash -= kalshiCost;

        this.logLedgerEvent(`OPEN`, newPosition);
    }

    public closePosition(pairId: string, polyExitPrice: number, kalshiExitPrice: number) {
        const position = this.openPositions.get(pairId);
        if (!position) return;

        const polyRevenue = position.size * polyExitPrice;
        const kalshiRevenue = position.size * kalshiExitPrice;
        const totalRevenue = polyRevenue + kalshiRevenue;
        const pnl = totalRevenue - position.totalCost;

        this.polyCash += polyRevenue;
        this.kalshiCash += kalshiRevenue;
        this.totalRealizedPnL += pnl;

        this.openPositions.delete(pairId);
        this.logLedgerEvent(`CLOSE`, position, pnl, totalRevenue);
    }

    private logLedgerEvent(action: string, position: Position, pnl: number = 0, revenue: number = 0) {
        const time = new Date().toISOString();
        let msg = `[${time}] LEDGER ${action}: ${position.marketQuestion.substring(0, 50)}...\n`;
        msg += `  Size: ${position.size} | Type: ${position.type}\n`;

        if (action === 'OPEN') {
            msg += `  Cost: Poly $${position.polyCost.toFixed(2)} | Kalshi $${position.kalshiCost.toFixed(2)}\n`;
            msg += `  New Balances: Poly $${this.polyCash.toFixed(2)} | Kalshi $${this.kalshiCash.toFixed(2)}\n`;
        } else {
            msg += `  Exit Revenue: $${revenue.toFixed(2)} | PnL: $${pnl.toFixed(2)}\n`;
            msg += `  Total Equity: $${this.getTotalEquity().toFixed(2)}\n`;
        }
        msg += `--------------------------------------------------\n`;

        fs.appendFileSync('portfolio_ledger.txt', msg, 'utf8');
    }
}