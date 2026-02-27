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

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function bootSystem() {
    console.log("[System] Booting Arbitrage Engine...");

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

    const activeManagers: PairManager[] = [];

    console.log(`[System] Initializing ${pairs.length} market pairs. Staggering network requests to avoid IP bans...`);

    // Load ALL pairs, but stagger the WebSocket connections by 200ms
    for (let i = 0; i < pairs.length; i++) {
        const pair = pairs[i];
        const manager = new PairManager(pair);

        manager.start(); // Start background sync
        activeManagers.push(manager);

        // Print progress so you know it hasn't frozen
        process.stdout.write(`\r[System] Connected ${i + 1}/${pairs.length} Data Engines...`);

        // 200ms delay to respect Cloudflare WS handshake rate limits
        await sleep(200);
    }

    console.log(`\n[System] All data engines online. Launching UI...`);

    // Launch the interactive dashboard
    const cli = new CLI(activeManagers);
    cli.showMenu();
}

process.on('SIGINT', async () => {
    console.log('\n[System] Shutting down Engine...');
    await pmxt.stopServer();
    process.exit(0);
});

bootSystem();