import fs from 'fs';
import cliProgress from 'cli-progress';
import path from 'path';
import OpenAI from 'openai';
import dotenv from 'dotenv';

dotenv.config({ override: true });

// --- Rate-limit config ---
const INTER_REQUEST_DELAY_MS = 200;
const MAX_RETRIES = 3;

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
    outcomeAlignment: 1 | -1;
    reason: string;
}

// NEW: Interface for logging every single LLM check
interface LLMResponseLog {
    polyMarketId: string;
    kalshiMarketId: string;
    alignment: 1 | 0 | -1;
    reason: string;
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
): Promise<{ alignment: 1 | 0 | -1; reason: string }> {

    const prompt = `
You are a highly rigorous quantitative financial analyst. 
Determine if two prediction markets are EXACTLY identical and safe for cross-exchange arbitrage.

MARKET A (Polymarket)
  Question : "${polyMarket.market_question}"
  Rules    : "${polyMarket.market_rules}"
  Outcomes : [0] = "${polyMarket.outcomes[0]}", [1] = "${polyMarket.outcomes[1]}"

MARKET B (Kalshi)
  Question : "${kalshiMarket.market_question}"
  Rules    : "${kalshiMarket.market_rules}"
  Outcomes : [0] = "${kalshiMarket.outcomes[0]}", [1] = "${kalshiMarket.outcomes[1]}"

EVALUATION RULES (If ANY failure condition is true -> alignment is 0):
1. Math & Thresholds: Strict mathematical boundaries must match. "> 25" is NOT the same as ">= 25" or "25+". "More than 35.5" (meaning 36) is NOT the same as "At least 35" (meaning 35).
2. Scope & Action: "Game 1" is NOT the same as "Match". "Holding an election" is NOT the same as "Scheduling an election".
3. Timeframes: Look AT THE TEXT in the questions/rules, NOT the metadata. "By March 31" is NOT the same as "By July 1". However, "End of Feb" is the same as "Feb 28".
4. Binary Exhaustion: If Market A asks about "The Weeknd" and B asks about "Bad Bunny", they are NOT the same. If a 3rd party wins, both resolve to No, meaning they aren't arbitrageable.
5. Edge Cases: If Market A says "If canceled, resolves to Other/Void", but B says "Resolves to No", they are a mismatch. 
*TOLERANCE:* Minor differences in tie-breaker rules or resolution source wording (e.g., both use an AI leaderboard but phrase it differently) ARE ACCEPTABLE as long as the core event is the same.

ALIGNMENT MAPPING:
If the event is perfectly identical, map Outcome 0 of Market A to Market B:
- If A[0] (e.g., "MOUZ") corresponds exactly to the real-world outcome of B[0] (e.g., "Yes" to MOUZ winning) -> output 1.
- If A[0] corresponds exactly to the real-world outcome of B[1] -> output -1.
`;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const response = await ai.chat.completions.create({
                model: "gpt-4o-mini", //gpt-5-nano
                messages: [
                    { role: "system", content: "You are a precise prediction market analyst evaluating arbitrage pairs." },
                    { role: "user", content: prompt }
                ],
                temperature: 0.0, // 0.0 is crucial for strict analytical logic
                response_format: {
                    type: "json_schema",
                    json_schema: {
                        name: "strict_alignment_schema",
                        strict: true,
                        schema: {
                            type: "object",
                            properties: {
                                math_and_threshold_match: {
                                    type: "boolean",
                                    description: "True if both markets use the exact same mathematical boundaries and numbers. False if they differ (e.g. > vs >=)."
                                },
                                scope_and_action_match: {
                                    type: "boolean",
                                    description: "True if the scope (e.g. Game 1 vs Match) and action (e.g. Scheduled vs Held) are exactly the same."
                                },
                                timeframe_match: {
                                    type: "boolean",
                                    description: "True if the event resolution deadlines stated in the text are the same."
                                },
                                edge_case_match: {
                                    type: "boolean",
                                    description: "True if there are no contradictory edge cases (like one resolving to 'Other' while the other resolves to 'No')."
                                },
                                alignment_analysis: {
                                    type: "string",
                                    description: "Briefly map Market A Outcome 0 to Market B outcomes. Does it match B[0], B[1], or neither?"
                                },
                                final_decision_reason: {
                                    type: "string",
                                    description: "A 1 sentence explanation of the final alignment."
                                },
                                alignment: {
                                    type: "integer",
                                    description: "Must be 1, -1, or 0."
                                }
                            },
                            required: [
                                "math_and_threshold_match",
                                "scope_and_action_match",
                                "timeframe_match",
                                "edge_case_match",
                                "alignment_analysis",
                                "final_decision_reason",
                                "alignment"
                            ],
                            additionalProperties: false
                        }
                    }
                }
            });

            const content = response.choices[0].message.content;
            if (!content) return { alignment: 0, reason: "API returned empty content." };

            const jsonResult = JSON.parse(content);

            // HARD OVERRIDE: If the LLM flagged any logical failure but still output 1 or -1, we force it to 0.
            const hasFailure = !jsonResult.math_and_threshold_match ||
                !jsonResult.scope_and_action_match ||
                !jsonResult.timeframe_match ||
                !jsonResult.edge_case_match;

            let safeAlignment: 1 | 0 | -1 = 0;
            if (!hasFailure) {
                if (jsonResult.alignment === 1) safeAlignment = 1;
                if (jsonResult.alignment === -1) safeAlignment = -1;
            }

            return { alignment: safeAlignment, reason: jsonResult.final_decision_reason };

        } catch (error: any) {
            const isRateLimit = error.status === 429;
            if (isRateLimit && attempt < MAX_RETRIES) {
                const backoff = 5000 * attempt;
                console.error(`\n  [Rate limit] 429. Waiting ${backoff / 1000}s...`);
                await sleep(backoff);
            } else {
                console.error(`\n  [OpenAI Error]:`, error.message || error);
                return { alignment: 0, reason: `Error: ${error.message}` };
            }
        }
    }

    return { alignment: 0, reason: "Failed after max retries." };
}

// --- Main Execution ---
async function run() {
    const DATA_DIR = path.join(process.cwd(), 'data');
    const inputFile = path.join(DATA_DIR, 'candidate_market_groups.json');
    const outputFile = path.join(DATA_DIR, 'market_pairs.json');
    const logsFile = path.join(DATA_DIR, 'llm_responses.json'); // NEW: Audit log file

    if (!fs.existsSync(inputFile)) {
        console.error(`Error: ${inputFile} not found. Run the vector matcher script first.`);
        return;
    }

    const rawData = fs.readFileSync(inputFile, 'utf-8');
    const candidates: CandidatePair[] = JSON.parse(rawData);

    if (candidates.length === 0) return;

    const ai = buildOpenAI();

    console.log(`\nStarting OpenAI verification for ${candidates.length} candidate pairs...`);
    console.log('Model: gpt-4o-mini | Range: 1 (aligned), -1 (flipped), 0 (no match)');
    console.log(`Rate limit delay: ${INTER_REQUEST_DELAY_MS}ms\n`);

    const validatedPairs: ValidatedPair[] = [];
    const llmLogs: LLMResponseLog[] = []; // Array to hold the full audit trail

    const bar = new cliProgress.SingleBar({
        format: 'LLM Check |{bar}| {percentage}% || {value}/{total} pairs || Confirmed: {confirmed}',
        hideCursor: true,
    }, cliProgress.Presets.shades_classic);

    bar.start(candidates.length, 0, { confirmed: 0 });

    for (let i = 0; i < candidates.length; i++) {
        const pair = candidates[i];

        // Destructure the new object return type
        const { alignment, reason } = await askLLM(ai, pair.polyMarket, pair.kalshiMarket);

        // 1. Log every single response to the audit trail
        llmLogs.push({
            polyMarketId: pair.polyMarket.internal_id,
            kalshiMarketId: pair.kalshiMarket.internal_id,
            alignment,
            reason
        });

        // 2. Add valid pairs to the execution list (including the reason)
        if (alignment === 1 || alignment === -1) {
            validatedPairs.push({ ...pair, outcomeAlignment: alignment, reason });
        }

        bar.update(i + 1, { confirmed: validatedPairs.length });

        if (i < candidates.length - 1) {
            await sleep(INTER_REQUEST_DELAY_MS);
        }
    }

    bar.stop();

    // Save the final filtered pairs for the Arbitrage Engine
    fs.writeFileSync(outputFile, JSON.stringify(validatedPairs, null, 2));

    // Save the comprehensive audit trail
    fs.writeFileSync(logsFile, JSON.stringify(llmLogs, null, 2));

    const aligned = validatedPairs.filter(p => p.outcomeAlignment === 1).length;
    const flipped = validatedPairs.filter(p => p.outcomeAlignment === -1).length;

    console.log(`\n✓ Validation complete.`);
    console.log(`  Total confirmed pairs : ${validatedPairs.length}`);
    console.log(`  Outcomes aligned (1)  : ${aligned}`);
    console.log(`  Outcomes flipped (-1) : ${flipped}`);
    console.log(`\n  Execution pairs saved to: ${outputFile}`);
    console.log(`  Full audit log saved to : ${logsFile}`);
}

run();