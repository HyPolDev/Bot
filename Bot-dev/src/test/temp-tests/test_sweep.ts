import { PairManager } from '../src/monitor/pair_manager';
import { PortfolioManager } from '../src/portfolio/portfolio_manager';
import { RiskManager } from '../src/portfolio/risk_manager';
import { LiveEngine } from '../src/execution/live_engine';

// Dummy pair data
const dummyPair = {
    polyMarket: { internal_id: 'poly1', platform: 'polymarket', original_url_slug: '', market_question: '' },
    kalshiMarket: { internal_id: 'kalshi1', platform: 'kalshi', original_url_slug: '', market_question: '' },
    score: 0.99,
    outcomeAlignment: 1 as 1 | -1
};

const port = new PortfolioManager(5000, 5000);
const risk = new RiskManager(port);
const engine = new LiveEngine(port);
const pm = new PairManager(dummyPair, port, risk, engine);

// Data from image
const polyYesAsks = [
    { price: 0.34, size: 53 },
    { price: 0.35, size: 146 },
    { price: 0.36, size: 620 }
];

const kalshiNoAsks = [
    { price: 0.61, size: 818 },
    { price: 0.62, size: 703 },
    { price: 0.63, size: 1000 }
];

// simulate sweep
console.log("Testing calculateSweep");
const res = (pm as any).calculateSweep(polyYesAsks, kalshiNoAsks, true, Infinity);
console.log(res);

console.log("Testing approved Size");
const approvedSize = risk.calculateApprovedSize(
    pm.pairId, res.polyVwap, res.kalshiVwap, res.size * 2, res.size * 2
);
console.log("Approved size:", approvedSize);
