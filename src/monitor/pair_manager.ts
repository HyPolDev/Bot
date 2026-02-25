import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import pmxt from 'pmxtjs';
import { PolymarketWS } from '../utils/exchanges/polymarket_ws.ts';
import { KalshiWS } from '../utils/exchanges/kalshi_ws.ts';

dotenv.config({ override: true });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface UnifiedMarket {
    internal_id: string;
    platform: string;
    original_url_slug: string;
    market_question: string;
}

interface CandidatePair {
    polyMarket: UnifiedMarket;
    kalshiMarket: UnifiedMarket;
    score: number;
    finalRankScore: number;
}

class PairManager {
    private polyInternalId: string;
    private kalshiInternalId: string;

    private polyWsClient: PolymarketWS | null = null;
    private kalshiWsClient: KalshiWS | null = null;

    private latestPolyBook: { yes: any, no: any } = { yes: { bids: [], asks: [] }, no: { bids: [], asks: [] } };
    private latestKalshiBook: { yes: any, no: any } | null = null;

    private renderedLines: number = 0;

    constructor(polyId: string, kalshiId: string) {
        this.polyInternalId = polyId;
        this.kalshiInternalId = kalshiId;
    }

    public async start() {
        console.log(`[System] Initializing Pair Manager...`);
        try {
            console.log(`[System] Fetching Polymarket Token IDs...`);
            const polyResponse = await fetch(`https://gamma-api.polymarket.com/markets/${this.polyInternalId}`);
            if (!polyResponse.ok) throw new Error(`Gamma API HTTP ${polyResponse.status}`);

            const polyMarketData = await polyResponse.json();
            const clobTokenIds = JSON.parse(polyMarketData.clobTokenIds);

            console.log(`[System] Beginning Dual-Orderbook Streams... \n`);

            // 1. Initialize Polymarket Data Engine
            this.polyWsClient = new PolymarketWS(clobTokenIds[0], clobTokenIds[1], (source, updatedSide) => {
                if (updatedSide.isYes) this.latestPolyBook.yes = { bids: updatedSide.bids, asks: updatedSide.asks };
                else this.latestPolyBook.no = { bids: updatedSide.bids, asks: updatedSide.asks };
                this.printState(source);
            });

            // 2. Initialize Kalshi Data Engine
            this.kalshiWsClient = new KalshiWS(this.kalshiInternalId, (source, fullBook) => {
                this.latestKalshiBook = fullBook;
                this.printState(source);
            });

            // Start both engines
            this.polyWsClient.start();
            this.kalshiWsClient.start();

        } catch (error) {
            console.error(`[Error] Initialization failed:`, error);
        }
    }

    private printState(source: string) {
        if (!this.latestKalshiBook) {
            process.stdout.write(`\r[Tick: ${source.padEnd(10)}] Poly connected. Waiting on Kalshi...      `);
            return;
        }

        if (this.renderedLines > 0) {
            process.stdout.write(`\x1B[${this.renderedLines}A\x1B[J`);
        }

        const formatLevel = (lvl: any) => {
            if (!lvl) return "     ---    ".padEnd(17);
            const price = (lvl.price * 100).toFixed(1) + "¢";
            const size = lvl.size >= 1000 ? (lvl.size / 1000).toFixed(1) + "k" : Math.floor(lvl.size).toString();
            return `${price.padStart(5)} [${size.padStart(6)}]`.padEnd(17);
        };

        const renderBook = (title: string, poly: any, kalshi: any) => {
            let str = `  === ${title} ===\n`;
            str += `  EXCHANGE     |  POLYMARKET        |  KALSHI\n`;

            for (let i = 2; i >= 0; i--) {
                str += `  Ask ${i + 1}        |  ${formatLevel(poly?.asks[i])} |  ${formatLevel(kalshi?.asks[i])}\n`;
            }
            str += `  -------------+--------------------+---------------------\n`;

            for (let i = 0; i < 3; i++) {
                str += `  Bid ${i + 1}        |  ${formatLevel(poly?.bids[i])} |  ${formatLevel(kalshi?.bids[i])}\n`;
            }
            return str;
        };

        let output = `\n=============================================================\n`;
        output += ` TICK: ${source.padEnd(10)} | ARBITRAGER LIVE DASHBOARD\n`;
        output += `=============================================================\n`;
        output += renderBook('YES OUTCOME', this.latestPolyBook.yes, this.latestKalshiBook.yes);
        output += `\n`;
        output += renderBook('NO OUTCOME', this.latestPolyBook.no, this.latestKalshiBook.no);
        output += `=============================================================\n`;

        this.renderedLines = output.split('\n').length - 1;
        process.stdout.write(output);
    }
}

async function run() {
    const pairsFile = path.join(process.cwd(), 'src/test/__fixtures__/test_market_pairs.json');

    if (!fs.existsSync(pairsFile)) {
        console.error(`[Error] ${pairsFile} not found.`);
        return;
    }

    const rawData = fs.readFileSync(pairsFile, 'utf-8');
    const pairs: CandidatePair[] = JSON.parse(rawData);

    if (pairs.length === 0) return;

    const manager = new PairManager(pairs[0].polyMarket.internal_id, pairs[0].kalshiMarket.internal_id);
    await manager.start();
}

process.on('SIGINT', async () => {
    console.log('\n[System] Shutting down PMXT server...');
    await pmxt.stopServer();
    process.exit(0);
});

run();