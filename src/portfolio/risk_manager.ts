import { PortfolioManager } from './portfolio_manager.js';

export class RiskManager {
    private portfolio: PortfolioManager;

    // Removed static constants in favor of dynamic log decay formulation

    constructor(portfolio: PortfolioManager) {
        this.portfolio = portfolio;
    }

    private calculateDynamicRisk(capital: number, rStart: number, rEnd: number): number {
        const C_min = 50;
        const C_max = 5000;

        if (capital <= C_min) return rStart;
        if (capital >= C_max) return rEnd;

        const lnC = Math.log(capital);
        const lnCmin = Math.log(C_min);
        const lnCmax = Math.log(C_max);

        return rStart + (rEnd - rStart) * ((lnC - lnCmin) / (lnCmax - lnCmin));
    }

    public calculateApprovedSize(
        pairId: string, polyPrice: number, kalshiPrice: number, polySize: number, kalshiSize: number
    ): number {
        const polyCash = this.portfolio.getPolyCash();
        const kalshiCash = this.portfolio.getKalshiCash();
        const bottleneckCapital = Math.min(polyCash, kalshiCash);

        // Dynamic logarithmic risk scaling
        const maxEquityPerTrade = this.calculateDynamicRisk(bottleneckCapital, 0.30, 0.02);
        const maxEquityPerPair = this.calculateDynamicRisk(bottleneckCapital, 0.30, 0.05);

        const totalEquity = this.portfolio.getTotalEquity();
        const costPerContract = polyPrice + kalshiPrice;

        // RULE 1: Base Size
        const baseSize = Math.floor(Math.min(polySize, kalshiSize) / 2);

        // RULE 2: Equity Caps
        const maxTradeBudget = totalEquity * maxEquityPerTrade;
        const currentExposure = this.portfolio.getPairExposure(pairId);
        const availablePairBudget = (totalEquity * maxEquityPerPair) - currentExposure;

        const allowedBudget = Math.min(maxTradeBudget, availablePairBudget);
        const maxSizeByBudget = Math.floor(allowedBudget / costPerContract);

        const finalSizeByRisk = Math.min(baseSize, maxSizeByBudget);

        // NEW RULE 3: Exchange-Specific Cash Bottlenecks

        // How many contracts can each wallet afford individually?
        const maxContractsPoly = Math.floor(polyCash / polyPrice);
        const maxContractsKalshi = Math.floor(kalshiCash / kalshiPrice);

        // The true max size is bottlenecked by the poorest exchange
        let maxSizeByCash = Math.min(maxContractsPoly, maxContractsKalshi);

        // SAFETY FLOOR: If cash is below $5 in either exchange, we abort the trade
        // UNLESS we are already planning to trigger a relay (handled in PairManager).
        // For now, simple floor to prevent fee-driven attrition.
        if (polyCash < 5 || kalshiCash < 5) {
            maxSizeByCash = 0;
        }

        return Math.max(0, Math.min(finalSizeByRisk, maxSizeByCash));
    }

    public getMaxTradeBudget(): number {
        const polyEquity = this.portfolio.getPolyCash() + this.portfolio.getInvestedPolyCapital();
        const kalshiEquity = this.portfolio.getKalshiCash() + this.portfolio.getInvestedKalshiCapital();
        const bottleneckCapital = Math.min(polyEquity, kalshiEquity);
        const maxEquityPerTrade = this.calculateDynamicRisk(bottleneckCapital, 0.30, 0.02);
        return bottleneckCapital * maxEquityPerTrade;
    }
}