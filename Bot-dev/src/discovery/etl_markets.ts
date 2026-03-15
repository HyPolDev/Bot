import fs from 'fs';
import csv from 'csv-parser';
import path from 'path';

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
    expiration: string;
    embedding_text: string;
}

const unifiedMarkets: UnifiedMarket[] = [];

// --- DYNAMIC BANNED WORDS FILTER ---
let BANNED_WORDS: string[] = [];
const blacklistPath = path.join(process.cwd(), 'data', 'blacklist.json');

try {
    if (fs.existsSync(blacklistPath)) {
        const rawData = fs.readFileSync(blacklistPath, 'utf-8');
        BANNED_WORDS = JSON.parse(rawData);
        console.log(`[System] Loaded ${BANNED_WORDS.length} banned words from blacklist.json`);
    } else {
        // Failsafe: Create a default file if it doesn't exist
        const defaultBlacklist = ["test", "dummy", "murder", "assassination", "o/u"];
        fs.mkdirSync(path.dirname(blacklistPath), { recursive: true });
        fs.writeFileSync(blacklistPath, JSON.stringify(defaultBlacklist, null, 2));
        BANNED_WORDS = defaultBlacklist;
        console.log(`[System] Created default blacklist.json at ${blacklistPath}`);
    }
} catch (error) {
    console.error(`[Error] Failed to read or parse blacklist.json. Defaulting to empty filter.`, error);
}

// Helper to sanitize strings so symbols don't break the Regex engine
const escapeRegExp = (string: string) => {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
};

// Helper to check for isolated whole words and symbols
const containsBannedWords = (text: string): boolean => {
    if (!text || BANNED_WORDS.length === 0) return false;

    return BANNED_WORDS.some(word => {
        const safeWord = escapeRegExp(word);
        const regex = new RegExp(`(?<!\\w)${safeWord}(?!\\w)`, 'i');
        return regex.test(text);
    });
};

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
    const rules = `${row.rules_primary || ""} ${row.rules_secondary || ""}`.trim();

    // FILTER: Drop market if it contains banned words
    if (containsBannedWords(question) || containsBannedWords(rules)) return null;

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
        expiration: `${date}`,
        embedding_text: `${question} | Expires: ${date}`
    };
};

const mapPolymarket = (row: any): UnifiedMarket | null => {
    const question = row.question || "";
    const rules = row.description || "";

    // FILTER: Drop market if it contains banned words
    if (containsBannedWords(question) || containsBannedWords(rules)) return null;

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
        expiration: `${date}`,
        embedding_text: `${question} | Expires: ${date}`
    };
};

// --- Execution ---

async function runETL() {
    console.log("Starting Extract & Transform pipeline...");
    try {
        const DATA_DIR = path.posix.join(process.cwd(), 'data');

        if (!fs.existsSync(DATA_DIR)) {
            fs.mkdirSync(DATA_DIR, { recursive: true });
        }

        const kalshiCsvPath = path.posix.join(DATA_DIR, 'kalshi_markets.csv');
        const polyCsvPath = path.posix.join(DATA_DIR, 'polymarket_markets.csv');
        const unifiedJsonPath = path.posix.join(DATA_DIR, 'unified_markets.json');

        await parseCSV(kalshiCsvPath, mapKalshi);
        await parseCSV(polyCsvPath, mapPolymarket);

        console.log(`Successfully mapped ${unifiedMarkets.length} total valid markets.`);

        // 5. Save the output
        fs.writeFileSync(unifiedJsonPath, JSON.stringify(unifiedMarkets, null, 2));

        console.log(`Checkpoint saved successfully to ${unifiedJsonPath}`);
    } catch (error) {
        console.error("ETL Pipeline failed:", error);
    }
}

runETL();