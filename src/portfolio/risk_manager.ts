import { PortfolioManager } from './portfolio_manager.js';

export class RiskManager {
    private portfolio: PortfolioManager;

    // Rule 2: Risk Caps
    private readonly MAX_EQUITY_PER_TRADE = 0.05; // 5% max per single order
    private readonly MAX_EQUITY_PER_PAIR = 0.10;  // 10% max total exposure per market pair

    constructor(portfolio: PortfolioManager) {
        this.portfolio = portfolio;
    }

    /**
     * Calculates the maximum number of contracts we are allowed to buy.
     * Returns 0 if the trade is too risky, violates caps, or if we are broke.
     */
    public calculateApprovedSize(
        pairId: string,
        polyPrice: number,
        kalshiPrice: number,
        polySize: number,
        kalshiSize: number
    ): number {
        const totalEquity = this.portfolio.getTotalEquity();
        const costPerContract = polyPrice + kalshiPrice;

        // RULE 1: Base Size (Half of the smallest ask size between the two platforms)
        const baseSize = Math.floor(Math.min(polySize, kalshiSize) / 2);

        // RULE 2a: 5% of Total Equity per trade
        const maxTradeBudget = totalEquity * this.MAX_EQUITY_PER_TRADE;

        // RULE 2b: 10% of Total Equity per pair
        const currentExposure = this.portfolio.getPairExposure(pairId);
        const availablePairBudget = (totalEquity * this.MAX_EQUITY_PER_PAIR) - currentExposure;

        // Our allowed dollar budget is the tightest constraint of the two rules
        const allowedBudget = Math.min(maxTradeBudget, availablePairBudget);

        // Convert the dollar budget into a number of contracts
        const maxSizeByBudget = Math.floor(allowedBudget / costPerContract);

        // Final size is the minimum between market liquidity (Rule 1) and our Risk Budget (Rule 2)
        const finalSize = Math.min(baseSize, maxSizeByBudget);

        // Ultimate Sanity Check: Do we actually have the raw cash on hand?
        const availableCash = this.portfolio.getAvailableCash();
        const maxSizeByCash = Math.floor(availableCash / costPerContract);

        // Return the final constrained size (cannot be negative)
        return Math.max(0, Math.min(finalSize, maxSizeByCash));
    }
}