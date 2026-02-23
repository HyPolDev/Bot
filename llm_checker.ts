import fs from 'fs';
import cliProgress from 'cli-progress';
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

// 2. The Ollama Interface
async function checkLLMConnection() {
    console.log(`Checking connection to Ollama (Qwen 2.5)...`);
    try {
        const response = await fetch('http://localhost:11434/api/tags');
        if (!response.ok) throw new Error("Ollama not responding");
        console.log("Ollama connection successful.\n");
    } catch (e) {
        console.error("\nERROR: Could not connect to Ollama or the server is not running.");
        console.error("Please run the provided setup script to install Ollama and download the model.");
        console.error("Run the following commands in your terminal:\n");
        console.error("  chmod +x setup/llm_setup.sh");
        console.error("  ./setup/llm_setup.sh\n");
        process.exit(1);
    }
}

async function askLLM(marketA: UnifiedMarket, marketB: UnifiedMarket): Promise<boolean> {
    const prompt = `
    You are a precise betting market resolver.
    Task: Determine if the following two markets resolve to the EXACT SAME event.
    Rules:
    1. The embedding texts (question + date) for the two markets are below, along with their full market rules. Use these to determine if they are the same event.
    2. The market_rules have to be essentially the same, and have to have the same resolution criteria.
    6. If phrasing differs but meaning is identical, answer YES.
    3. If names differ (e.g. "Stephen" vs "Oprah"), answer NO.
    4. If dates differ slightly (e.g. 2026/12/31 vs 2027/01/01) but the event context implies they are the same cycle/event, answer YES.
    5. If specific numbers differ significantly (e.g. "$100k" vs "$90k"), answer NO. But if they are extremely close or rounding differences, use context.
    7. Reply ONLY with binary opion "YES" or "NO", nothing else.

    The embedding texts are:
    Market A: "${marketA.embedding_text}"
    Market B: "${marketB.embedding_text}"

    And its corresponding market rules are:
    Market A Rules: "${marketA.market_rules}"
    Market B Rules: "${marketB.market_rules}"

    Are they the exact same event?
    `;

    try {
        const response = await fetch('http://localhost:11434/api/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: "qwen2.5:7b",
                prompt: prompt,
                stream: false,
                options: {
                    temperature: 0.0, // Strict logic
                    num_predict: 5    // Only need "YES" or "NO"
                }
            })
        });

        const data = await response.json();
        console.log(data)
        const answer = data.response.trim().toUpperCase().replace(/[^A-Z]/g, '');

        return answer === 'YES';

    } catch (error) {
        // If an individual API call fails, log it but don't crash the loop
        console.error(`\nOllama API Error on pair ${marketA.internal_id} / ${marketB.internal_id}`);
        return false;
    }
}

// 3. Main Execution
async function run() {
    const DATA_DIR = path.posix.join(process.cwd(), 'data');

    const inputFile = './test/__fixtures__/test_candidate_market_groups.json';
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

    await checkLLMConnection();

    console.log(`Starting LLM Verification for ${candidates.length} candidate pairs...`);

    const validatedPairs: CandidatePair[] = [];

    // Set up the progress bar
    const llmBar = new cliProgress.SingleBar({
        format: `LLM Check |{bar}| {percentage}% || {value}/{total} Pairs || Matches Confirmed: {confirmed}`,
        hideCursor: true
    }, cliProgress.Presets.shades_classic);

    llmBar.start(candidates.length, 0, { confirmed: 0 });

    for (let i = 0; i < candidates.length; i++) {
        const pair = candidates[i];

        const isMatch = await askLLM(pair.polyMarket, pair.kalshiMarket);

        if (isMatch) {
            validatedPairs.push(pair);
        }

        llmBar.update(i + 1, { confirmed: validatedPairs.length });
    }

    llmBar.stop();

    // Save the final, LLM-verified list
    fs.writeFileSync(outputFile, JSON.stringify(validatedPairs, null, 2));

    console.log(`\nSuccess! Validated ${validatedPairs.length} true arbitrage pairs.`);
    console.log(`Data saved to ${outputFile}`);
}

run();