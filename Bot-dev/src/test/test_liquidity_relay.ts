import { PortfolioManager } from '../portfolio/portfolio_manager.js';
import { LiquidityRelay } from '../monitor/liquidity_relay.js';
import { LiveEngine } from '../execution/live_engine.js';
import { PairManager } from '../monitor/pair_manager.js';
import { Settings } from '../db/models/Settings.js';
import * as poly_client from '../execution/poly_client.js';
import * as kalshi_client from '../execution/kalshi_client.js';

async function runTest() {
    console.log("--- Starting Liquidity Relay Rotation Test ---");

    // Inject dummy keys for testing so Exchange Clients don't crash
    process.env.POLY_PRIVATE_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
    process.env.POLY_PROXY_ADDRESS = "0x0000000000000000000000000000000000000000";
    process.env.KALSHI_API_KEY = "fake";

    // Stub out DB so Mongoose doesn't crash us without connect
    Settings.findOne = async () => ({ maxEquityPerTrade: 100, isPaperTrading: true }) as any;

    const port = new PortfolioManager(10, 10); // 10 cash each (Buffer Depleted since max is 100)
    
    // Stub persist methods so they don't hit DB
    (port as any).persistPositionClose = async () => {};

    const engine = new LiveEngine(port);
    engine.isSystemReady = true;

    // Add a dummy open position with poor expected profit
    const dummyPosition = {
        pairId: 'TEST_PAIR',
        marketQuestion: 'Will X happen?',
        type: 'PolyYes_KalshiNo',
        size: 100,
        polyEntryPrice: 0.50,
        kalshiEntryPrice: 0.40,
        polyCost: 50,
        kalshiCost: 40,
        totalCost: 90, // Cost basis = 0.90 per share (holding gives 1.00, profit is $10)
        timestamp: Date.now(),
        expiringDate: new Date(Date.now() + 30 * 86400000) // 30 days
    };
    (port as any).openPositions.set('TEST_PAIR', dummyPosition);
    console.log(`[Setup] Injected weak open position: Cost Basis 0.90`);

    // Pre-load a missed high-yield opportunity that clears the exit toll logic
    port.logMissedOpportunity(5.00); // 500% EAR missed
    console.log(`[Setup] Injected missed massive EAR opportunity (500%)`);

    // Setup Mock PairManager with realistic live BIDS representing the exit spread
    const mockPairData = {
        polyMarket: { internal_id: '1', market_question: '?', platform: 'poly', original_url_slug: '', market_rules: '' },
        kalshiMarket: { internal_id: '2', market_question: '?', platform: 'kalshi', original_url_slug: '', market_rules: '' },
        score: 0,
        outcomeAlignment: 1
    };
    const manager = new PairManager(mockPairData as any, port, {} as any, engine);
    (manager as any).pairId = 'TEST_PAIR';
    
    // Poly Bid = 0.49, Kalshi Bid = 0.40. Exit Value = 0.89 vs 0.90 Cost Basis. We will take a tiny loss to rotate.
    manager.latestPolyBook = { yes: { bids: [{ price: 0.49, size: 200 }], asks: [] }, no: { bids: [], asks: [] } };
    manager.latestKalshiBook = { yes: { bids: [], asks: [] }, no: { bids: [{ price: 0.40, size: 200 }], asks: [] } }; 
    port.setManagers([manager]);

    // Instantiate and run relay manually instead of looping
    const relay = new LiquidityRelay(port, engine);
    console.log("[Test] Evaluating Rotations...");
    await (relay as any).evaluateRotations();

    // Verify
    const pos = port.getPosition('TEST_PAIR');
    if (!pos) {
        console.log("✅ SUCCESS: Position was liquidated by LiquidityRelay!");
    } else {
        console.log("❌ FAILED: Position is still open.");
    }
    process.exit(0);
}

runTest();
