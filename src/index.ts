import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import pmxt from 'pmxtjs';
import { PairManager, CandidatePair } from './monitor/pair_manager.js';
import { CLI } from './cli/dashboard.js';
import { PortfolioManager } from './portfolio/portfolio_manager.js';
import { RiskManager } from './portfolio/risk_manager.js';
import { LiveEngine } from './execution/live_engine.js';
import { PolyClient } from './execution/poly_client.js';
import { KalshiClient } from './execution/kalshi_client.js';
import readline from 'readline';

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
        rl.question('\n[?] Select mode: (1) Paper Simulation, (2) Live Deployment: ', answer => {
            resolve(answer.trim() === '2' ? 'LIVE' : 'PAPER');
        });
    });

    rl.close();

    let INITIAL_POLY_CASH = 5000;
    let INITIAL_KALSHI_CASH = 5000;

    if (mode === 'LIVE') {
        process.env.PAPER_TRADE = "false";
        console.log(`\n[System] ⚠️ LIVE DEPLOYMENT AUTHORIZED ⚠️`);
        console.log(`[System] Fetching live wallets from exchanges...`);

        const polyClient = new PolyClient();
        const kalshiClient = new KalshiClient();

        INITIAL_POLY_CASH = await polyClient.getCollateralBalance();
        INITIAL_KALSHI_CASH = await kalshiClient.getBalance();
    } else {
        process.env.PAPER_TRADE = "true";
        console.log(`\n[System] 🛡️ PAPER SIMULATION ACTIVE 🛡️`);
    }

    const pairsFile = path.join(process.cwd(), 'data/market_pairs.json');
    if (!fs.existsSync(pairsFile)) {
        console.error(`[Error] ${pairsFile} not found.`);
        return;
    }

    const rawData = fs.readFileSync(pairsFile, 'utf-8');
    const pairs: CandidatePair[] = JSON.parse(rawData);

    if (pairs.length === 0) {
        console.log("[System] No pairs found to monitor.");
        return;
    }

    // --- Initialize Global State Singletons ---
    const portfolio = new PortfolioManager(INITIAL_POLY_CASH, INITIAL_KALSHI_CASH);
    const liveEngine = new LiveEngine(portfolio);
    const riskManager = new RiskManager(portfolio);


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

    console.log(`\n[System] All data engines online. Launching UI...`);

    // Launch the interactive dashboard
    const cli = new CLI(activeManagers, portfolio);
    cli.showMenu();
}

process.on('SIGINT', async () => {
    console.log('\n[System] Shutting down Engine...');
    await pmxt.stopServer();
    process.exit(0);
});

bootSystem();