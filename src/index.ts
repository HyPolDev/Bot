import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import pmxt from 'pmxtjs';
import { PairManager, CandidatePair } from './monitor/pair_manager.js';
import { CLI } from './cli/dashboard.js';

dotenv.config({ override: true });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function bootSystem() {
    console.log("[System] Booting Arbitrage Engine...");

    const pairsFile = path.join(process.cwd(), 'src/test/__fixtures__/test_market_pairs.json');
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

    // Note: If you load 50 pairs, this will open 100 WebSockets. 
    // In production, we will want to aggregate these connections!
    const activeManagers: PairManager[] = [];

    // We will initialize the first 5 pairs just to test the loop safely
    const pairsToLoad = pairs.slice(0, 5);

    for (const pair of pairsToLoad) {
        const manager = new PairManager(pair);
        manager.start(); // Start background sync
        activeManagers.push(manager);
    }

    // Wait a second for initial WebSocket connections to settle
    setTimeout(() => {
        const cli = new CLI(activeManagers);
        cli.showMenu();
    }, 1500);
}

process.on('SIGINT', async () => {
    console.log('\n[System] Shutting down Engine...');
    await pmxt.stopServer();
    process.exit(0);
});

bootSystem();