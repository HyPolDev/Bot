import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { Get15mMarketTickers, CandidatePair } from '../crypto/btc15.js';
import { PolymarketWS } from '../utils/exchanges/polymarket_ws.js';
import { KalshiWS } from '../utils/exchanges/kalshi_ws.js';

dotenv.config({ override: true });

async function runTest() {
    console.log("Starting BTC 15m WebSocket Test...");

    const tickerGen = new Get15mMarketTickers();
    const tempPath = path.resolve(process.cwd(), 'data/temp_test_btc15.json');

    const success = await tickerGen.generateAndSave(tempPath);
    if (!success) {
        console.error("Failed to generate and save BTC-15 pairs.");
        return;
    }

    const pairsRaw = fs.readFileSync(tempPath, 'utf8');
    const pairs: CandidatePair[] = JSON.parse(pairsRaw);
    if (pairs.length === 0) {
        console.error("No pairs generated.");
        return;
    }

    const pair = pairs[0];

    // Extraction of token IDs for Polymarket
    const tokens = pair.polyMarket.internal_id.split(',');
    if (tokens.length !== 2) {
        // As defined in Get15mMarketTickers, if internal_id doesn't have a comma, it failed to fetch token IDs.
        console.error("Polymarket market not fully minted yet or token IDs missing.");
        console.error("internal_id:", pair.polyMarket.internal_id);
        return;
    }
    const polyYesTokenId = tokens[0];
    const polyNoTokenId = tokens[1];

    console.log(`Connecting to Kalshi (${pair.kalshiMarket.internal_id}) and Polymarket (${polyYesTokenId}, ${polyNoTokenId})...`);

    // State for the orderbooks
    const latestPolyBook: { yes: any, no: any } = { yes: { bids: [], asks: [] }, no: { bids: [], asks: [] } };
    let latestKalshiBook: { yes: any, no: any } | null = null;
    let renderedLines = 0;

    const renderDashboard = () => {
        // Clear previous lines
        if (renderedLines > 0) {
            process.stdout.write(`\x1B[${renderedLines}A\x1B[J`);
        } else {
            console.clear();
        }

        const formatLevel = (lvl: any) => {
            if (!lvl) return "     ---    ".padEnd(17);
            const price = (lvl.price * 100).toFixed(1) + "¢";
            const size = lvl.size >= 1000 ? (lvl.size / 1000).toFixed(1) + "k" : Math.floor(lvl.size).toString();
            return `${price.padStart(5)} [${size.padStart(6)}]`.padEnd(17);
        };

        const renderBook = (title: string, pBook: any, kBook: any) => {
            let str = `  === ${title} ===\n`;
            str += `  EXCHANGE     |  POLYMARKET        |  KALSHI\n`;
            for (let i = 2; i >= 0; i--) {
                str += `  Ask ${i + 1}        |  ${formatLevel(pBook?.asks?.[i])} |  ${formatLevel(kBook?.asks?.[i])}\n`;
            }
            str += `  -------------+--------------------+---------------------\n`;
            for (let i = 0; i < 3; i++) {
                str += `  Bid ${i + 1}        |  ${formatLevel(pBook?.bids?.[i])} |  ${formatLevel(kBook?.bids?.[i])}\n`;
            }
            return str;
        };

        let output = `\n=============================================================\n`;
        output += ` MARKET: ${pair.polyMarket.market_question}\n`;
        output += ` ALIGNMENT: ${pair.outcomeAlignment === 1 ? 'ALIGNED (+1)' : 'FLIPPED (-1)'}\n`;
        output += `=============================================================\n`;

        if (!latestKalshiBook) {
            output += `\n  Waiting for Kalshi initialization...\n\n`;
        } else {
            output += renderBook('YES OUTCOME', latestPolyBook.yes, latestKalshiBook.yes) + `\n`;
            output += renderBook('NO OUTCOME', latestPolyBook.no, latestKalshiBook.no);
        }

        output += `=============================================================\n`;
        output += ` Press Ctrl+C to exit\n`;

        renderedLines = output.split('\n').length - 1;
        process.stdout.write(output);
    };

    const polyWsClient = new PolymarketWS(polyYesTokenId, polyNoTokenId, (source, updatedSide) => {
        if (updatedSide.isYes) {
            latestPolyBook.yes = { bids: updatedSide.bids, asks: updatedSide.asks };
        } else {
            latestPolyBook.no = { bids: updatedSide.bids, asks: updatedSide.asks };
        }
        renderDashboard();
    });

    const kalshiWsClient = new KalshiWS(pair.kalshiMarket.internal_id, (source, fullBook) => {
        latestKalshiBook = fullBook;
        renderDashboard();
    });

    polyWsClient.start();
    kalshiWsClient.start();
}

runTest();
