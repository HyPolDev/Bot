import fs from 'fs';
import csv from 'csv-parser';

// 1. Define the Unified Interface
type Platform = 'polymarket' | 'kalshi';

interface UnifiedMarket {
    internal_id: string;
    platform: Platform;
    original_url_slug: string;
    volume_usd: number;
    market_question: string;
    market_rules: string;
    outcomes: string[];
    embedding_text: string;
}

const unifiedMarkets: UnifiedMarket[] = [];

// 2. The Streaming CSV Parser
function parseCSV(
    filePath: string,
    mapper: (row: any) => UnifiedMarket | null
): Promise<void> {
    return new Promise((resolve, reject) => {
        fs.createReadStream(filePath)
            .pipe(csv())
            .on('data', (row) => {
                const mappedData = mapper(row);
                // Only push valid rows that passed our mapping logic
                if (mappedData) {
                    unifiedMarkets.push(mappedData);
                }
            })
            .on('end', () => {
                console.log(`Finished parsing ${filePath}`);
                resolve();
            })
            .on('error', reject);
    });
}

// 3. Platform-Specific Transformation Logic
const mapKalshi = (row: any): UnifiedMarket | null => {
    const question = row.title || "";
    const rules = `${row.rules_primary || ""} ${row.rules_secondary || ""}`.trim();

    // Discard rows missing critical identifiers
    if (!row.ticker || !question) return null;

    return {
        internal_id: row.ticker,
        platform: 'kalshi',
        original_url_slug: row.ticker, // Kalshi uses the ticker as the slug
        volume_usd: parseFloat(row.volume) || 0,
        market_question: question,
        market_rules: rules,
        outcomes: ['Yes', 'No'], // Kalshi is natively binary
        embedding_text: `Question: ${question}. Rules: ${rules}. Outcomes: Yes, No.`
    };
};

const mapPolymarket = (row: any): UnifiedMarket | null => {
    const question = row.question || "";
    const rules = row.description || "";

    if (!row.id || !question) return null;

    // Safely parse the Polymarket outcomes array
    let parsedOutcomes: string[] = [];
    try {
        parsedOutcomes = row.outcomes ? JSON.parse(row.outcomes) : [];
    } catch {
        parsedOutcomes = [row.outcomes];
    }

    return {
        internal_id: row.id || row.questionID,
        platform: 'polymarket',
        original_url_slug: row.slug || "",
        volume_usd: parseFloat(row.volume) || 0,
        market_question: question,
        market_rules: rules,
        outcomes: parsedOutcomes,
        embedding_text: `Question: ${question}. Rules: ${rules}. Outcomes: ${parsedOutcomes.join(', ')}.`
    };
};

// 4. Main Execution Function
async function runETL() {
    console.log("Starting Extract & Transform pipeline...");

    try {
        await parseCSV('kalshi_markets.csv', mapKalshi);
        await parseCSV('polymarket_markets.csv', mapPolymarket);

        console.log(`Successfully mapped ${unifiedMarkets.length} total markets.`);

        // 5. Load (Checkpoint Creation)
        const outputPath = 'unified_markets.json';
        fs.writeFileSync(outputPath, JSON.stringify(unifiedMarkets, null, 2));
        console.log(`Checkpoint saved successfully to ${outputPath}`);

    } catch (error) {
        console.error("ETL Pipeline failed:", error);
    }
}

runETL();