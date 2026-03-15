import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { PairManager, CandidatePair } from './monitor/pair_manager.js';
import { CLI } from './cli/dashboard.js';
import { PortfolioManager } from './portfolio/portfolio_manager.js';
import { RiskManager } from './portfolio/risk_manager.js';
import { LiveEngine } from './execution/live_engine.js';
import { LiquidityRelay } from './monitor/liquidity_relay.js';
import { PolyClient } from './execution/poly_client.js';
import { KalshiClient } from './execution/kalshi_client.js';
import readline from 'readline';
import { DatabaseConnection } from './db/connection.js';
import { MarketPair } from './db/models/MarketPair.js';
import { Settings } from './db/models/Settings.js';

dotenv.config({ override: true });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function bootSystem() {
    console.log("=====================================================");
    console.log("             HFT ARBITRAGE BOOT SEQUENCE             ");
    console.log("=====================================================");

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    const mode: string = await new Promise(resolve => {
        rl.question('\n[?] Select mode: (1) Paper Simulation, (2) Live Deployment: ', (answer: string) => {
            resolve(answer.trim() === '2' ? 'LIVE' : 'PAPER');
        });
    });

    rl.close();

    let INITIAL_POLY_CASH = 0;
    let INITIAL_KALSHI_CASH = 0;

    // Connect to DB as early as possible because mode switching now requires it
    await DatabaseConnection.getInstance().connect();

    let settings = await Settings.findOne();
    if (!settings) {
        settings = await Settings.create({}); // Creates with schema defaults
        console.log(`[System] Initialized new Settings record in database.`);
    }

    if (mode === 'LIVE') {
        settings.isPaperTrading = false;
        await settings.save();
        console.log(`\n[System] ⚠️ LIVE DEPLOYMENT AUTHORIZED ⚠️`);
        console.log(`[System] Fetching live wallets from exchanges...`);

        const polyClient = new PolyClient();
        const kalshiClient = new KalshiClient();

        INITIAL_POLY_CASH = await polyClient.getCollateralBalance();
        INITIAL_KALSHI_CASH = await kalshiClient.getBalance();
    } else {
        settings.isPaperTrading = true;
        await settings.save();
        console.log(`\n[System] 🛡️ PAPER SIMULATION ACTIVE 🛡️`);
    }

    const dbPairs = await MarketPair.find({});
    
    if (dbPairs.length === 0) {
        console.log("[System] No pairs found in database to monitor.");
        return;
    }

    const pairs: CandidatePair[] = dbPairs.map((doc: any) => ({
        polyMarket: doc.polyMarket,
        kalshiMarket: doc.kalshiMarket,
        score: doc.score,
        outcomeAlignment: doc.outcomeAlignment as 1 | -1
    }));

    // --- Initialize Global State Singletons ---
    const portfolio = new PortfolioManager(INITIAL_POLY_CASH, INITIAL_KALSHI_CASH);
    await portfolio.initializePaperTrading(); // Load simulated positions/balances if paper trading
    
    const liveEngine = new LiveEngine(portfolio);
    const riskManager = new RiskManager(portfolio);
    
    // Instantiate Async Rebalancer (LiquidityRelay)
    const liquidityRelay = new LiquidityRelay(portfolio, liveEngine);
    liquidityRelay.start();

    const activeManagers: PairManager[] = [];

    console.log(`[System] Initializing ${pairs.length} market pairs. Staggering network requests to avoid IP bans...`);

    // Load ALL pairs, but stagger the WebSocket connections by 200ms
    for (let i = 0; i < pairs.length; i++) {
        const pair = pairs[i];

        // Pass the global singletons into each PairManager
        const manager = new PairManager(pair, portfolio, riskManager, liveEngine);

        manager.start(); // Start background sync
        activeManagers.push(manager);

        // Print progress so you know it hasn't frozen
        process.stdout.write(`\r[System] Connected ${i + 1}/${pairs.length} Data Engines...`);

        // 200ms delay to respect Cloudflare WS handshake rate limits
        await sleep(200);
    }

    console.log(`\n[System] All data engines online.`);

    // Wire up the physical position tracker to know which managers map to which tokens/tickers
    portfolio.setManagers(activeManagers);
    if (!settings.isPaperTrading) {
        console.log(`[System] Synchronizing physical exchange positions...`);
        await portfolio.syncBalances();
    } else {
        console.log(`[System] Simulation ready. Skipped physical sync.`);
    }

    // Enable the engine to trade now that books are loaded
    liveEngine.isSystemReady = true;

    // Launch the interactive dashboard
    console.log(`[System] Launching UI...`);
    const cli = new CLI(activeManagers, portfolio);
    cli.showMenu();
}

process.on('SIGINT', async () => {
    console.log('\n[System] Shutting down Engine...');
    process.exit(0);
});

bootSystem();