import fs from 'fs';
import cliProgress from 'cli-progress';
import path from 'path';
import OpenAI from 'openai';
import dotenv from 'dotenv';

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
    outcomeAlignment: 1; // Strictly 1 now
}

interface LLMResponseLog {
    polyMarketId: string;
    kalshiMarketId: string;
    alignment: 1 | 0;
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

            // Force strict 1 or 0
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
    const outputFile = path.join(DATA_DIR, 'market_pairs.json');
    const logsFile = path.join(DATA_DIR, 'llm_responses.json');

    if (!fs.existsSync(inputFile)) {
        console.error(`Error: ${inputFile} not found.`);
        return;
    }

    const rawData = fs.readFileSync(inputFile, 'utf-8');
    const candidates: CandidatePair[] = JSON.parse(rawData);

    if (candidates.length === 0) return;

    const ai = buildOpenAI();

    console.log(`\nStarting OpenAI verification for ${candidates.length} candidate pairs...`);
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
        const worker = askLLM(ai, pair.polyMarket, pair.kalshiMarket).then((res) => {
            processedCount++;

            llmLogs.push({
                polyMarketId: pair.polyMarket.internal_id,
                kalshiMarketId: pair.kalshiMarket.internal_id,
                alignment: res.alignment
            });

            if (res.alignment === 1) {
                validatedPairs.push({ ...pair, outcomeAlignment: 1 });
            }

            bar.update(processedCount, { confirmed: validatedPairs.length });

            fs.writeFileSync(outputFile, JSON.stringify(validatedPairs, null, 2));
            fs.writeFileSync(logsFile, JSON.stringify(llmLogs, null, 2));
        });

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
}

run();