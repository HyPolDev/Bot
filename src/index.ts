import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { PairManager, CandidatePair } from './monitor/pair_manager.js';
import { CLI } from './cli/dashboard.js';
import { PortfolioManager } from './portfolio/portfolio_manager.js';
import { RiskManager } from './portfolio/risk_manager.js';
import { LiveEngine } from './execution/live_engine.js';
import { PolyClient } from './execution/poly_client.js';
import { KalshiClient } from './execution/kalshi_client.js';
import { Get15mMarketTickers } from './crypto/btc15.js';
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
        rl.question('\n[?] Select mode: (1) Paper Simulation, (2) Live Deployment, (3) BTC 15m Simulation: ', answer => {
            const choice = answer.trim();
            if (choice === '2') resolve('LIVE');
            else if (choice === '3') resolve('BTC_SIM');
            else resolve('PAPER');
        });
    });

    rl.close();

    let INITIAL_POLY_CASH = 5000;
    let INITIAL_KALSHI_CASH = 5000;
    let pairsFile = path.join(process.cwd(), 'data/market_pairs.json');

    if (mode === 'LIVE') {
        process.env.PAPER_TRADE = "false";
        console.log(`\n[System] ⚠️ LIVE DEPLOYMENT AUTHORIZED ⚠️`);
        console.log(`[System] Fetching live wallets from exchanges...`);

        const polyClient = new PolyClient();
        const kalshiClient = new KalshiClient();

        INITIAL_POLY_CASH = await polyClient.getCollateralBalance();
        INITIAL_KALSHI_CASH = await kalshiClient.getBalance();
    } else if (mode === 'BTC_SIM') {
        process.env.PAPER_TRADE = "true";
        console.log(`\n[System] ⚡ HIGH-FREQ BTC SIMULATION ACTIVE ⚡`);

        pairsFile = path.join(process.cwd(), 'data/crypto_pairs.json');

        // Let btc15.ts handle the data fetching, normalization, and file writing
        const tickerGenerator = new Get15mMarketTickers();
        const success = await tickerGenerator.generateAndSave(pairsFile);

        if (!success) {
            console.error(`[System] CRITICAL: Failed to generate 15m BTC pairs.`);
            process.exit(1);
        }

        console.log(`[System] Generated and locked current 15m window to ${pairsFile}`);

    } else {
        process.env.PAPER_TRADE = "true";
        console.log(`\n[System] 🛡️ PAPER SIMULATION ACTIVE 🛡️`);
    }

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

    console.log(`[System] Initializing ${pairs.length} market pairs. Staggering network requests...`);

    for (let i = 0; i < pairs.length; i++) {
        const pair = pairs[i];
        const manager = new PairManager(pair, portfolio, riskManager, liveEngine);

        manager.start();
        activeManagers.push(manager);

        process.stdout.write(`\r[System] Connected ${i + 1}/${pairs.length} Data Engines...`);
        await sleep(200);
    }

    console.log(`\n[System] All data engines online.`);

    portfolio.setManagers(activeManagers);
    console.log(`[System] Synchronizing physical exchange positions...`);
    await portfolio.syncBalances();

    liveEngine.isSystemReady = true;

    console.log(`[System] Launching UI...`);
    const cli = new CLI(activeManagers, portfolio);
    cli.showMenu();
}

process.on('SIGINT', async () => {
    console.log('\n[System] Shutting down Engine...');
    process.exit(0);
});

bootSystem();