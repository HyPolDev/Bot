import fs from 'fs';

export interface Position {
    pairId: string;             // A unique ID combining Poly and Kalshi IDs
    marketQuestion: string;     // For human-readable logging
    type: string;               // e.g., 'PolyYes_KalshiNo'
    size: number;               // Number of contracts bought on BOTH exchanges
    polyEntryPrice: number;
    kalshiEntryPrice: number;
    totalCost: number;          // size * (polyEntryPrice + kalshiEntryPrice)
    timestamp: number;          // Epoch time of entry
}

export class PortfolioManager {
    private availableCash: number;
    private totalRealizedPnL: number = 0;

    // Key: pairId -> Value: Position
    private openPositions: Map<string, Position> = new Map();

    constructor(initialCapital: number) {
        this.availableCash = initialCapital;
        console.log(`[Portfolio] Initialized with $${initialCapital.toFixed(2)} cash.`);
    }

    // --- Core Ledger State ---

    public getAvailableCash(): number {
        return this.availableCash;
    }

    public getTotalEquity(): number {
        let equity = this.availableCash;
        for (const position of this.openPositions.values()) {
            equity += position.totalCost;
        }
        return equity;
    }

    public getRealizedPnL(): number {
        return this.totalRealizedPnL;
    }

    public getOpenPositions(): Position[] {
        return Array.from(this.openPositions.values());
    }

    public getInvestedCapital(): number {
        let invested = 0;
        for (const position of this.openPositions.values()) {
            invested += position.totalCost;
        }
        return invested;
    }

    // --- Risk Management Lookups ---

    public hasOpenPosition(pairId: string): boolean {
        return this.openPositions.has(pairId);
    }

    public getPosition(pairId: string): Position | undefined {
        return this.openPositions.get(pairId);
    }

    public getPairExposure(pairId: string): number {
        const position = this.openPositions.get(pairId);
        return position ? position.totalCost : 0;
    }

    // --- Execution Handlers ---

    /**
     * Called by the Execution Engine AFTER a successful entry fill.
     */
    public openPosition(
        pairId: string,
        marketQuestion: string,
        type: string,
        size: number,
        polyPrice: number,
        kalshiPrice: number
    ) {
        if (this.openPositions.has(pairId)) {
            console.warn(`[Portfolio] Warning: Attempted to open position for ${pairId}, but one already exists. Ignoring.`);
            return;
        }

        const totalCost = size * (polyPrice + kalshiPrice);

        // Sanity Check: Ensure we don't go negative
        if (totalCost > this.availableCash) {
            console.error(`[Portfolio] FATAL: Execution engine bypassed risk checks! Insufficient cash to open position.`);
            return;
        }

        const newPosition: Position = {
            pairId,
            marketQuestion,
            type,
            size,
            polyEntryPrice: polyPrice,
            kalshiEntryPrice: kalshiPrice,
            totalCost,
            timestamp: Date.now()
        };

        this.openPositions.set(pairId, newPosition);
        this.availableCash -= totalCost;

        this.logLedgerEvent(`OPEN`, newPosition);
    }

    /**
     * Called by the Execution Engine AFTER a successful exit fill.
     */
    public closePosition(
        pairId: string,
        polyExitPrice: number,
        kalshiExitPrice: number
    ) {
        const position = this.openPositions.get(pairId);
        if (!position) {
            console.warn(`[Portfolio] Warning: Attempted to close a non-existent position for ${pairId}.`);
            return;
        }

        const exitRevenue = position.size * (polyExitPrice + kalshiExitPrice);
        const pnl = exitRevenue - position.totalCost;

        this.availableCash += exitRevenue;
        this.totalRealizedPnL += pnl;

        this.openPositions.delete(pairId);

        this.logLedgerEvent(`CLOSE`, position, pnl, exitRevenue);
    }

    // --- Auditing & Diagnostics ---

    private logLedgerEvent(action: string, position: Position, pnl: number = 0, revenue: number = 0) {
        const time = new Date().toISOString();
        let msg = `[${time}] LEDGER ${action}: ${position.marketQuestion.substring(0, 50)}...\n`;
        msg += `  Size: ${position.size} | Type: ${position.type}\n`;

        if (action === 'OPEN') {
            msg += `  Cost: $${position.totalCost.toFixed(2)} -> Remaining Cash: $${this.availableCash.toFixed(2)}\n`;
        } else {
            const prefix = pnl >= 0 ? '+' : '';
            msg += `  Exit Revenue: $${revenue.toFixed(2)} | PnL: ${prefix}$${pnl.toFixed(2)}\n`;
            msg += `  Total Equity: $${this.getTotalEquity().toFixed(2)} | Total PnL: $${this.totalRealizedPnL.toFixed(2)}\n`;
        }
        msg += `--------------------------------------------------\n`;

        fs.appendFileSync('portfolio_ledger.txt', msg, 'utf8');
    }

    public printSummary() {
        console.log(`\n=== PORTFOLIO SUMMARY ===`);
        console.log(`Total Equity  : $${this.getTotalEquity().toFixed(2)}`);
        console.log(`Available Cash: $${this.availableCash.toFixed(2)}`);
        console.log(`Realized PnL  : $${this.totalRealizedPnL.toFixed(2)}`);
        console.log(`Open Positions: ${this.openPositions.size}`);
        console.log(`=========================\n`);
    }
}