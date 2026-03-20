import fs from 'fs';
import cliProgress from 'cli-progress';
import path from 'path';
import OpenAI from 'openai';
import dotenv from 'dotenv';
import axios from 'axios';
import { DatabaseConnection } from '../db/connection.js';
import { MarketPair } from '../db/models/MarketPair.js';

dotenv.config({ override: true });

// --- Rate-limit & Concurrency config ---
const INTER_REQUEST_DELAY_MS = 200;
const MAX_RETRIES = 3;
const MAX_CONCURRENT_REQUESTS = 5;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// --- Types ---
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

interface ValidatedPair extends CandidatePair {
    outcomeAlignment: 1;
}

interface LLMResponseLog {
    polyMarketId: string;
    kalshiMarketId: string;
    alignment: 1 | 0;
}

// --- API Checkers for Live Status ---
async function checkPolymarketActive(marketId: string): Promise<boolean> {
    try {
        const response = await axios.get(`https://gamma-api.polymarket.com/markets/${marketId}`);
        return response.data.active === true && response.data.closed === false;
    } catch (error) {
        // Fail-safe: if the API fails, keep the market in DB to avoid accidental deletion
        return true;
    }
}

async function checkKalshiActive(ticker: string): Promise<boolean> {
    try {
        const response = await axios.get(`https://api.elections.kalshi.com/trade-api/v2/markets/${ticker}`);
        const status = response.data.market.status;
        return status === 'active' || status === 'open';
    } catch (error) {
        return true;
    }
}

// --- Database Cleanup Routine ---
async function cleanupResolvedPairs() {
    console.log(`\nStarting pre-flight cleanup of resolved market pairs...`);
    const pairs = await MarketPair.find({});

    if (pairs.length === 0) {
        console.log(`Database is empty, no cleanup needed.`);
        return;
    }

    const cleanupBar = new cliProgress.SingleBar({
        format: 'DB Cleanup |{bar}| {percentage}% || {value}/{total} pairs || Removed: {removed}',
        hideCursor: true,
    }, cliProgress.Presets.shades_classic);

    cleanupBar.start(pairs.length, 0, { removed: 0 });

    let removedCount = 0;
    let processedCount = 0;

    // Process in sequential batches to avoid API rate limits on startup
    for (const pair of pairs) {
        // Assume internal_id stores the correct identifier for the respective API
        const polyId = pair.polyMarket?.internal_id;
        const kalshiId = pair.kalshiMarket?.internal_id;

        if (polyId && kalshiId) {
            const [isPolyActive, isKalActive] = await Promise.all([
                checkPolymarketActive(polyId),
                checkKalshiActive(kalshiId)
            ]);

            if (!isPolyActive || !isKalActive) {
                await MarketPair.deleteOne({ _id: pair._id });
                removedCount++;
            }
        }

        processedCount++;
        cleanupBar.update(processedCount, { removed: removedCount });
        await sleep(50); // slight delay to respect platform rate limits during bulk checks
    }

    cleanupBar.stop();
    console.log(`Cleanup complete. Removed ${removedCount} stale pairs from the database.\n`);
}

// --- OpenAI Client ---
function buildOpenAI(): OpenAI {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
        console.error('\nERROR: OPENAI_API_KEY is not set correctly in .env');
        process.exit(1);
    }
    return new OpenAI({ apiKey });
}

async function askLLM(
    ai: OpenAI,
    polyMarket: UnifiedMarket,
    kalshiMarket: UnifiedMarket
): Promise<{ alignment: 1 | 0 }> {

    const prompt = `
You are an expert quantitative arbitrage analyst. 
Determine if two prediction markets resolve on the EXACT SAME real-world event and outcome.

MARKET A (Polymarket)
  Question : "${polyMarket.market_question}"
  Rules    : "${polyMarket.market_rules}"
  Outcomes : [0] = "${polyMarket.outcomes[0]}", [1] = "${polyMarket.outcomes[1]}"

MARKET B (Kalshi)
  Question : "${kalshiMarket.market_question}"
  Rules    : "${kalshiMarket.market_rules}"
  Outcomes : [0] = "${kalshiMarket.outcomes[0]}", [1] = "${kalshiMarket.outcomes[1]}"

CRITICAL REJECTION RULES (If any are true, you MUST output 0):
1. THE DERIVATIVE TRAP: If one market asks if the *odds/price/chance* of an event will reach a certain level, and the other asks if the *event itself* will happen, they are completely different instruments. Output 0.
2. STRICT MATH DIFFERENCES: You must extract and compare the exact numerical boundaries. "50+ bps" is NOT the same as ">25bps". "More than 35.5" is NOT the same as "At least 35". If the math or numbers differ in any way, output 0.
3. SCOPE/SUBJECT DIFFERENCES: "Win Game 2" is NOT "Win Match". "The Weeknd" is NOT "Bad Bunny". Output 0.

TOLERANCE RULE (Do not overthink):
Ignore metadata expiration dates. Ignore minor pedantic wording differences regarding tie-breakers, or platform-specific terminology for "voiding" or "canceling" a market. Do not fail a pair for administrative jargon. 

ALIGNMENT MAPPING:
- If the core real-world event, numerical boundaries, and subjects are mathematically identical AND Market A Outcome [0] means the exact same real-world result as Market B Outcome [0] -> output 1.
- Otherwise -> output 0.
`;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const response = await ai.chat.completions.create({
                model: "gpt-5-nano",
                messages: [
                    { role: "system", content: "You are a precise prediction market analyst. You only output valid JSON." },
                    { role: "user", content: prompt }
                ],
                temperature: 1,
                response_format: {
                    type: "json_schema",
                    json_schema: {
                        name: "alignment_schema",
                        strict: true,
                        schema: {
                            type: "object",
                            properties: {
                                alignment: {
                                    type: "integer",
                                    description: "Must be exactly 1 or 0."
                                }
                            },
                            required: ["alignment"],
                            additionalProperties: false
                        }
                    }
                }
            });

            const content = response.choices[0].message.content;
            if (!content) return { alignment: 0 };

            const jsonResult = JSON.parse(content);

            if (jsonResult.alignment === 1) return { alignment: 1 };
            return { alignment: 0 };

        } catch (error: any) {
            const isRateLimit = error.status === 429;
            if (isRateLimit && attempt < MAX_RETRIES) {
                const backoff = 5000 * attempt;
                await sleep(backoff);
            } else {
                console.error(`\n  [OpenAI Error]:`, error.message || error);
                return { alignment: 0 };
            }
        }
    }

    return { alignment: 0 };
}

// --- Main Execution ---
async function run() {
    const DATA_DIR = path.join(process.cwd(), 'data');
    const inputFile = path.join(DATA_DIR, 'candidate_market_groups.json');
    const logsFile = path.join(DATA_DIR, 'llm_responses.json');
    const rejectedCacheFile = path.join(DATA_DIR, 'rejected_pairs_cache.json');

    if (!fs.existsSync(inputFile)) {
        console.error(`Error: ${inputFile} not found.`);
        return;
    }

    const rawData = fs.readFileSync(inputFile, 'utf-8');
    const candidates: CandidatePair[] = JSON.parse(rawData);

    if (candidates.length === 0) return;

    let rejectedCache = new Set<string>();
    if (fs.existsSync(rejectedCacheFile)) {
        try {
            const parsed = JSON.parse(fs.readFileSync(rejectedCacheFile, 'utf-8'));
            rejectedCache = new Set(parsed);
            console.log(`Loaded ${rejectedCache.size} previously rejected pairs from cache.`);
        } catch (e) {
            console.warn(`Warning: Could not parse ${rejectedCacheFile}. Starting fresh.`);
        }
    }

    const ai = buildOpenAI();

    // 1. Connect to DB first
    await DatabaseConnection.getInstance().connect();

    // 2. Run Database Cleanup to remove expired/resolved markets
    await cleanupResolvedPairs();

    console.log(`Starting OpenAI verification for ${candidates.length} candidate pairs...`);
    console.log(`Model: gpt-5-nano | Concurrency: ${MAX_CONCURRENT_REQUESTS} floating workers`);
    console.log(`Mode: STRICT EXACT MATCH (1) or REJECT (0)\n`);

    const validatedPairs: ValidatedPair[] = [];
    const llmLogs: LLMResponseLog[] = [];

    const bar = new cliProgress.SingleBar({
        format: 'LLM Check |{bar}| {percentage}% || {value}/{total} pairs || Confirmed: {confirmed}',
        hideCursor: true,
    }, cliProgress.Presets.shades_classic);

    bar.start(candidates.length, 0, { confirmed: 0 });

    let processedCount = 0;
    const activePromises = new Set<Promise<void>>();

    for (const pair of candidates) {
        const worker = (async () => {
            const pairId = `${pair.kalshiMarket.internal_id}+${pair.polyMarket.internal_id}`;

            if (rejectedCache.has(pairId)) {
                processedCount++;
                bar.update(processedCount, { confirmed: validatedPairs.length });
                return;
            }

            const alreadyInDb = await MarketPair.exists({ pairId });
            if (alreadyInDb) {
                processedCount++;
                validatedPairs.push({ ...pair, outcomeAlignment: 1 });
                bar.update(processedCount, { confirmed: validatedPairs.length });
                return;
            }

            const res = await askLLM(ai, pair.polyMarket, pair.kalshiMarket);

            processedCount++;

            llmLogs.push({
                polyMarketId: pair.polyMarket.internal_id,
                kalshiMarketId: pair.kalshiMarket.internal_id,
                alignment: res.alignment
            });

            if (res.alignment === 1) {
                validatedPairs.push({ ...pair, outcomeAlignment: 1 });
                await MarketPair.findOneAndUpdate(
                    { pairId },
                    {
                        $set: {
                            kalshiMarket: pair.kalshiMarket,
                            polyMarket: pair.polyMarket,
                            score: pair.score,
                            outcomeAlignment: 1,
                            metrics: {
                                last_updated: new Date(),
                                s_history: { PolyYes_kalshiNo: [], PolyNoKalshiYes: [] },
                                expected_annualized_return: null
                            }
                        }
                    },
                    { upsert: true }
                );
            } else {
                rejectedCache.add(pairId);
                fs.writeFileSync(rejectedCacheFile, JSON.stringify(Array.from(rejectedCache), null, 2));
            }

            bar.update(processedCount, { confirmed: validatedPairs.length });
            fs.writeFileSync(logsFile, JSON.stringify(llmLogs, null, 2));
        })();

        activePromises.add(worker);

        worker.finally(() => {
            activePromises.delete(worker);
        });

        if (activePromises.size >= MAX_CONCURRENT_REQUESTS) {
            await Promise.race(activePromises);
            await sleep(INTER_REQUEST_DELAY_MS);
        }
    }

    await Promise.all(activePromises);

    bar.stop();

    console.log(`\n✓ Validation complete.`);
    console.log(`  Total strict matches (1): ${validatedPairs.length}`);
    await DatabaseConnection.getInstance().disconnect();
}

run();