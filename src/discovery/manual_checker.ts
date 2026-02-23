import fs from 'fs';
import * as readline from 'readline/promises';
import { stdin as input, stdout as output } from 'process';
import path from 'path';

// 1. Define Structures matching your Vector Search output
interface UnifiedMarket {
    internal_id: string;
    platform: string;
    original_url_slug: string;
    volume_usd: number;
    market_question: string;
    market_rules: string;
    outcomes: string[];
    expiration: string;
    embedding_text: string;
}

interface CandidatePair {
    polyMarket: UnifiedMarket;
    kalshiMarket: UnifiedMarket;
    score: number;
}

// 2. Main Execution
async function run() {
    const DATA_DIR = path.posix.join(process.cwd(), 'data');

    const inputFile = path.posix.join(DATA_DIR, 'candidate_market_groups.json');
    const outputFile = path.posix.join(DATA_DIR, 'market_pairs.json');

    if (!fs.existsSync(inputFile)) {
        console.error(`Error: ${inputFile} not found. Run your vector matcher script first.`);
        return;
    }

    const rawData = fs.readFileSync(inputFile, 'utf-8');
    const candidates: CandidatePair[] = JSON.parse(rawData);

    if (candidates.length === 0) {
        console.log("No candidates found in the input file.");
        return;
    }

    // Set up readline interface for terminal input
    const rl = readline.createInterface({ input, output });
    const validatedPairs: CandidatePair[] = [];

    console.log(`\n======================================================`);
    console.log(`Starting Manual Verification for ${candidates.length} candidate pairs...`);
    console.log(`Commands: 'y' (Yes), 'n' (No), 'q' (Quit and Save)`);
    console.log(`======================================================\n`);

    for (let i = 0; i < candidates.length; i++) {
        const pair = candidates[i];
        const poly = pair.polyMarket;
        const kalshi = pair.kalshiMarket;

        console.log(`\n--- Pair ${i + 1} of ${candidates.length} (Similarity Score: ${pair.score.toFixed(4)}) ---`);

        // Display Market A (PolyMarket)
        console.log(`\n🔵 MARKET A: PolyMarket (${poly.internal_id})`);
        console.log(`Question: ${poly.market_question}`);
        console.log(`Embed:    ${poly.embedding_text}`);

        // Display Market B (Kalshi)
        console.log(`\n🟢 MARKET B: Kalshi (${kalshi.internal_id})`);
        console.log(`Question: ${kalshi.market_question}`);
        console.log(`Embed:    ${kalshi.embedding_text}`);

        // Prompt loop to catch invalid inputs
        let answer = '';
        while (!['y', 'n', 'q'].includes(answer)) {
            answer = (await rl.question(`\nAre these the exact same event? (y/n/q): `)).toLowerCase().trim();
        }

        if (answer === 'q') {
            console.log(`\nExiting early. Saving your progress...`);
            break; // Breaks the loop and goes to the save function
        } else if (answer === 'y') {
            validatedPairs.push(pair);
        }

        console.log(`------------------------------------------------------`);
    }

    // Close the input stream
    rl.close();

    // 3. Save the final verified list
    // We only write to the file if we actually have data, or if the user explicitly wants to overwrite.
    if (validatedPairs.length > 0) {
        fs.writeFileSync(outputFile, JSON.stringify(validatedPairs, null, 2));
        console.log(`\nSuccess! Validated ${validatedPairs.length} true arbitrage pairs.`);
        console.log(`Data saved to ${outputFile}\n`);
    } else {
        console.log(`\nFinished. No valid pairs were selected. Nothing was saved.\n`);
    }
}

run();