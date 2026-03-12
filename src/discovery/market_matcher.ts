import { rankMarketsByScoreAndTime } from '../utils/ranker.ts';
import path from 'path';
import fs from 'fs';
import {
    pipeline,
    AutoTokenizer,
    AutoModelForSequenceClassification,
    FeatureExtractionPipeline,
    PreTrainedModel,
    PreTrainedTokenizer
} from '@huggingface/transformers';

// 1. Define Structures
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
    embedding?: number[];
}


// 2. The Matcher Class
class MarketEntityMatcher {
    private biEncoder!: FeatureExtractionPipeline;
    private crossTokenizer!: PreTrainedTokenizer;
    private crossEncoder!: PreTrainedModel;

    async init(biModelName = 'Xenova/bge-small-en-v1.5', crossModelName = 'Xenova/bge-reranker-base') {
        console.log(`Loading Bi-Encoder (${biModelName}) in 8-bit quantization...`);
        this.biEncoder = (await pipeline('feature-extraction', biModelName, { dtype: 'q8' }) as any) as FeatureExtractionPipeline;

        console.log(`Loading Cross-Encoder (${crossModelName}) in 8-bit quantization...`);
        this.crossTokenizer = await AutoTokenizer.from_pretrained(crossModelName);
        this.crossEncoder = await AutoModelForSequenceClassification.from_pretrained(crossModelName, { dtype: 'q8' });
    }

    // Mathematical Dot Product for Normalized Vectors
    dotProduct(vecA: number[], vecB: number[]): number {
        let dot = 0;
        for (let i = 0; i < vecA.length; i++) {
            dot += vecA[i] * vecB[i];
        }
        return dot;
    }

    async processAllMarkets(markets: UnifiedMarket[], initialThreshold: number = 0.82, topK: number = 3) {
        // --- STAGE 1: Bi-Encoder Embedding ---
        console.log(`\nGenerating embeddings for ${markets.length} markets...`);
        for (let i = 0; i < markets.length; i++) {
            const output = await this.biEncoder(markets[i].embedding_text, { pooling: 'mean', normalize: true });
            markets[i].embedding = Array.from(output.data);

            process.stdout.write(`\rEmbedded ${i} / ${markets.length} markets...`);

        }

        // --- STAGE 2: Top-K Bipartite Candidate Generation ---
        console.log(`\n\nRunning cross-platform Top-${topK} candidate generation...`);

        const polymarkets = markets.filter(m => m.platform === 'polymarket');
        const kalshis = markets.filter(m => m.platform === 'kalshi');

        const candidatePairs: { polyMarket: Omit<UnifiedMarket, 'embedding'>, kalshiMarket: Omit<UnifiedMarket, 'embedding'>, score: number }[] = [];

        // Helper to immutably remove the embedding array before saving
        const stripEmbedding = (market: UnifiedMarket) => {
            const { embedding, ...cleanMarket } = market;
            return cleanMarket;
        };

        let processed = 0;

        // Iterate through each Polymarket
        for (let i = 0; i < polymarkets.length; i++) {
            let currentMatches: { kalshiMarket: UnifiedMarket, score: number }[] = [];

            for (let j = 0; j < kalshis.length; j++) {
                const sim = this.dotProduct(polymarkets[i].embedding!, kalshis[j].embedding!);

                if (sim >= initialThreshold) {
                    currentMatches.push({ kalshiMarket: kalshis[j], score: sim });
                }
            }

            // Sort this Polymarket's matches by highest score first
            currentMatches.sort((a, b) => b.score - a.score);

            // Slice only the top K matches and push the CLEANED versions to our final list
            const bestTopK = currentMatches.slice(0, topK);
            for (const match of bestTopK) {
                candidatePairs.push({
                    polyMarket: stripEmbedding(polymarkets[i]),
                    kalshiMarket: stripEmbedding(match.kalshiMarket),
                    score: match.score
                });
            }

            processed++;

            process.stdout.write(`\rEvaluated ${processed} / ${polymarkets.length} Polymarkets... Accumulated ${candidatePairs.length} candidates.`);

        }

        console.log(`\n\nFiltering complete. Found ${candidatePairs.length} highly correlated Top-${topK} pairs above ${initialThreshold} similarity.`);

        // Sort final list by highest confidence
        return candidatePairs.sort((a, b) => b.score - a.score);
    }
}

function filterByExpirationWindow(pairs: any[], maxMonthsAhead: number) {
    const thresholdDate = new Date();
    thresholdDate.setMonth(thresholdDate.getMonth() + maxMonthsAhead);

    let droppedCount = 0;

    const filtered = pairs.filter(pair => {
        const polyDate = new Date(pair.polyMarket.expiration);
        const kalshiDate = new Date(pair.kalshiMarket.expiration);

        // Defensive check: If either date is missing/invalid, drop the pair to be safe
        if (isNaN(polyDate.getTime()) || isNaN(kalshiDate.getTime())) {
            droppedCount++;
            return false;
        }

        // Find the earliest date between the two markets
        const earliestDate = polyDate < kalshiDate ? polyDate : kalshiDate;

        // If the earliest expiration is beyond our threshold, drop it
        if (earliestDate > thresholdDate) {
            droppedCount++;
            return false;
        }

        return true;
    });

    console.log(`\n[Time Filter] Dropped ${droppedCount} pairs resolving after ${thresholdDate.toISOString().split('T')[0]}.`);
    return filtered;
}

// 3. Main Execution
async function run() {
    const DATA_DIR = path.posix.join(process.cwd(), 'data');

    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    const inputPath = path.posix.join(DATA_DIR, 'unified_markets.json');
    const outputPath = path.posix.join(DATA_DIR, 'candidate_market_groups.json');

    console.log(`Loading ${inputPath}...`);
    const rawData = fs.readFileSync(inputPath, 'utf-8');
    const markets: UnifiedMarket[] = JSON.parse(rawData);

    const matcher = new MarketEntityMatcher();
    await matcher.init('Xenova/bge-small-en-v1.5', 'Xenova/bge-reranker-base');

    const groupedMarkets = await matcher.processAllMarkets(markets, 0.90);

    // Apply the Time Filter
    const timeFilteredMarkets = filterByExpirationWindow(groupedMarkets, 2);

    console.log(`\nRanking ${timeFilteredMarkets.length} candidates by similarity and expiration date...`);

    const rankedMarkets = rankMarketsByScoreAndTime(timeFilteredMarkets, 0.80, 0.2);

    fs.writeFileSync(outputPath, JSON.stringify(rankedMarkets, null, 2));

    console.log(`\nSuccess! Saved ${rankedMarkets.length} ranked isolated groups to ${outputPath}`);
}

run();