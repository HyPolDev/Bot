import { PortfolioManager } from './portfolio_manager.js';

export class RiskManager {
    private portfolio: PortfolioManager;

    private readonly MAX_EQUITY_PER_TRADE = 0.05; // 5% max per single order
    private readonly MAX_EQUITY_PER_PAIR = 0.10;  // 10% max total exposure per pair

    constructor(portfolio: PortfolioManager) {
        this.portfolio = portfolio;
    }

    public calculateApprovedSize(
        pairId: string, polyPrice: number, kalshiPrice: number, polySize: number, kalshiSize: number
    ): number {
        const totalEquity = this.portfolio.getTotalEquity();
        const costPerContract = polyPrice + kalshiPrice;

        // RULE 1: Base Size
        const baseSize = Math.floor(Math.min(polySize, kalshiSize) / 2);

        // RULE 2: Equity Caps
        const maxTradeBudget = totalEquity * this.MAX_EQUITY_PER_TRADE;
        const currentExposure = this.portfolio.getPairExposure(pairId);
        const availablePairBudget = (totalEquity * this.MAX_EQUITY_PER_PAIR) - currentExposure;

        const allowedBudget = Math.min(maxTradeBudget, availablePairBudget);
        const maxSizeByBudget = Math.floor(allowedBudget / costPerContract);

        const finalSizeByRisk = Math.min(baseSize, maxSizeByBudget);

        // NEW RULE 3: Exchange-Specific Cash Bottlenecks
        const polyCash = this.portfolio.getPolyCash();
        const kalshiCash = this.portfolio.getKalshiCash();

        // How many contracts can each wallet afford individually?
        const maxContractsPoly = Math.floor(polyCash / polyPrice);
        const maxContractsKalshi = Math.floor(kalshiCash / kalshiPrice);

        // The true max size is bottlenecked by the poorest exchange
        const maxSizeByCash = Math.min(maxContractsPoly, maxContractsKalshi);

        return Math.max(0, Math.min(finalSizeByRisk, maxSizeByCash));
    }
}