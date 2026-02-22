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
    embedding_text: string; // Used for Vector Search (Short & Unique)
}

const unifiedMarkets: UnifiedMarket[] = [];

// Helper to extract a readable date
const formatDate = (isoString: string) => {
    if (!isoString) return '';
    try {
        return new Date(isoString).toISOString().split('T')[0]; // YYYY-MM-DD
    } catch {
        return '';
    }
}

function parseCSV(filePath: string, mapper: (row: any) => UnifiedMarket | null): Promise<void> {
    return new Promise((resolve, reject) => {
        fs.createReadStream(filePath)
            .pipe(csv())
            .on('data', (row) => {
                const mappedData = mapper(row);
                if (mappedData) unifiedMarkets.push(mappedData);
            })
            .on('end', () => {
                console.log(`Finished parsing ${filePath}`);
                resolve();
            })
            .on('error', reject);
    });
}

// --- Platform Logic ---

const mapKalshi = (row: any): UnifiedMarket | null => {
    const question = row.title || "";
    // Kalshi rules are split; combine them
    const rules = `${row.rules_primary || ""} ${row.rules_secondary || ""}`.trim();
    const date = formatDate(row.expiration_time);

    if (!row.ticker || !question) return null;

    return {
        internal_id: row.ticker,
        platform: 'kalshi',
        original_url_slug: row.ticker,
        volume_usd: parseFloat(row.volume) || 0,
        market_question: question,
        market_rules: rules,
        outcomes: ['Yes', 'No'],
        embedding_text: `${question} | Expires: ${date}`
    };
};

const mapPolymarket = (row: any): UnifiedMarket | null => {
    const question = row.question || "";
    const rules = row.description || "";
    const date = formatDate(row.endDateIso || row.endDate);

    if (!row.id || !question) return null;

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
        // DENSE EMBEDDING: Question + Date only.
        embedding_text: `${question} | Expires: ${date}`
    };
};

// --- Execution ---

async function runETL() {
    console.log("Starting Extract & Transform pipeline...");
    try {
        await parseCSV('kalshi_markets.csv', mapKalshi);
        await parseCSV('polymarket_markets.csv', mapPolymarket);
        console.log(`Successfully mapped ${unifiedMarkets.length} total markets.`);
        fs.writeFileSync('unified_markets.json', JSON.stringify(unifiedMarkets, null, 2));
        console.log(`Checkpoint saved successfully to unified_markets.json`);
    } catch (error) {
        console.error("ETL Pipeline failed:", error);
    }
}

runETL();