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
    embedding_text: string;
    embedding?: number[];
}

// 2. Union-Find for Graph Grouping
class UnionFind {
    private parent: Map<string, string> = new Map();

    find(i: string): string {
        if (!this.parent.has(i)) {
            this.parent.set(i, i);
        }
        if (this.parent.get(i) !== i) {
            this.parent.set(i, this.find(this.parent.get(i)!));
        }
        return this.parent.get(i)!;
    }

    union(i: string, j: string): void {
        const rootI = this.find(i);
        const rootJ = this.find(j);
        if (rootI !== rootJ) {
            this.parent.set(rootI, rootJ);
        }
    }

    getGroups(): Map<string, string[]> {
        const groups = new Map<string, string[]>();
        for (const [node] of this.parent) {
            const root = this.find(node);
            if (!groups.has(root)) {
                groups.set(root, []);
            }
            groups.get(root)!.push(node);
        }
        return groups;
    }
}

// 3. The Matcher Class
class MarketEntityMatcher {
    private biEncoder!: FeatureExtractionPipeline;
    private crossTokenizer!: PreTrainedTokenizer;
    private crossEncoder!: PreTrainedModel;

    async init(biModelName = 'Xenova/bge-small-en-v1.5', crossModelName = 'Xenova/bge-reranker-base') {
        console.log(`Loading Bi-Encoder (${biModelName})...`);

        this.biEncoder = (await pipeline('feature-extraction', biModelName) as any) as FeatureExtractionPipeline;

        console.log(`Loading Cross-Encoder (${crossModelName})...`);
        this.crossTokenizer = await AutoTokenizer.from_pretrained(crossModelName);
        this.crossEncoder = await AutoModelForSequenceClassification.from_pretrained(crossModelName);
    }

    // Mathematical Dot Product for Normalized Vectors
    dotProduct(vecA: number[], vecB: number[]): number {
        let dot = 0;
        for (let i = 0; i < vecA.length; i++) {
            dot += vecA[i] * vecB[i];
        }
        return dot;
    }

    async processAllMarkets(markets: UnifiedMarket[], initialThreshold: number = 0.3) {
        // --- STAGE 1: Bi-Encoder Embedding ---
        console.log(`\nGenerating embeddings for ${markets.length} markets...`);
        for (let i = 0; i < markets.length; i++) {
            // pooling: 'mean' and normalize: true compress and normalize the vector space natively
            const output = await this.biEncoder(markets[i].embedding_text, { pooling: 'mean', normalize: true });
            markets[i].embedding = Array.from(output.data);

            if (i > 0 && i % 1000 === 0) console.log(`Embedded ${i} / ${markets.length} markets...`);
        }

        // --- STAGE 2: Brute-Force Dot Product (Candidate Generation) ---
        console.log("\nRunning N^2 Brute-Force candidate generation...");
        const crossInputs: { textA: string, textB: string }[] = [];
        const hitMapping: [number, number][] = [];

        for (let i = 0; i < markets.length; i++) {
            for (let j = i + 1; j < markets.length; j++) {
                const sim = this.dotProduct(markets[i].embedding!, markets[j].embedding!);

                if (sim >= initialThreshold) {
                    crossInputs.push({
                        textA: markets[i].embedding_text,
                        textB: markets[j].embedding_text
                    });
                    hitMapping.push([i, j]);
                }
            }
        }

        console.log(`Found ${crossInputs.length} candidate pairs above ${initialThreshold} similarity.`);
        if (crossInputs.length === 0) return [];

        // --- STAGE 3: Cross-Encoder Re-Ranking ---
        console.log(`\nRe-ranking ${crossInputs.length} pairs using Cross-Encoder...`);

        const uf = new UnionFind();
        let confirmedMatches = 0;

        // Process in batches to manage memory allocation for tensor creation
        const batchSize = 16;
        for (let i = 0; i < crossInputs.length; i += batchSize) {
            const batch = crossInputs.slice(i, i + batchSize);
            const batchMappings = hitMapping.slice(i, i + batchSize);

            // Tokenize sentence pairs
            const inputs = this.crossTokenizer(
                batch.map(b => b.textA),
                { text_pair: batch.map(b => b.textB), padding: true, truncation: true }
            );

            // Run Cross-Encoder inference
            const { logits } = await this.crossEncoder(inputs);
            const scores = logits.data;

            for (let k = 0; k < batch.length; k++) {
                // Reranker logit > 0 implies strong relevance
                if (scores[k] > 0) {
                    const [idxA, idxB] = batchMappings[k];
                    uf.union(markets[idxA].internal_id, markets[idxB].internal_id);
                    confirmedMatches++;
                }
            }

            if (i > 0 && i % 160 === 0) console.log(`Re-ranked ${i} pairs...`);
        }

        console.log(`\nFinal Cross-Encoder confirmed ${confirmedMatches} highly linked pairs.`);

        // --- STAGE 4: Final Compilation ---
        const validGroups = Array.from(uf.getGroups().values()).filter(group => group.length > 1);

        const finalGroups = validGroups.map(groupIds => {
            return groupIds.map(id => markets.find(m => m.internal_id === id)!);
        });

        return finalGroups;
    }
}

// 4. Main Execution
async function run() {
    console.log("Loading unified_markets.json...");
    const rawData = fs.readFileSync('unified_markets.json', 'utf-8');
    const markets: UnifiedMarket[] = JSON.parse(rawData);

    const matcher = new MarketEntityMatcher();
    // Using BGE-Small as a lighter equivalent to Base to guarantee Node doesn't OOM.
    await matcher.init('Xenova/bge-small-en-v1.5', 'Xenova/bge-reranker-base');

    const groupedMarkets = await matcher.processAllMarkets(markets, 0.3);

    fs.writeFileSync('candidate_market_groups.json', JSON.stringify(groupedMarkets, null, 2));
    console.log(`\nSuccess! Saved ${groupedMarkets.length} isolated groups to candidate_market_groups.json`);
}

run();