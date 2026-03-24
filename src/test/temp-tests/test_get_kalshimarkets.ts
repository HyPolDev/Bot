import * as fs from 'fs';
import path from 'path';

// Helper function to replicate time.sleep()
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const toNum = (v: any): number => {
    if (v === null || v === undefined) return NaN;
    const n = typeof v === 'string' ? Number(v) : Number(v);
    return Number.isFinite(n) ? n : NaN;
};

const firstFinite = (...vals: any[]): number => {
    for (const v of vals) {
        const n = toNum(v);
        if (Number.isFinite(n)) return n;
    }
    return NaN;
};

async function getKalshiMarketsResolvingIn48Hours() {
    // Kalshi V2 public API endpoint for markets
    const baseUrl = "https://api.elections.kalshi.com/trade-api/v2/markets";
    const limit = 1000;
    let cursor: string | null = null;

    const allMarkets: Record<string, any>[] = [];
    const marketIds = new Set<string>(); // For deduplication

    const headers = {
        "Accept": "application/json",
        "Content-Type": "application/json"
    };

    // --- TIME CALCULATION ---
    const now = new Date();
    const fortyEightHoursFromNow = new Date(now.getTime() + 48 * 60 * 60 * 1000);

    console.log("Starting fetch of ALL active Kalshi markets...");
    console.log(`Strategy: Using cursor pagination. Filtering for close_time between NOW and ${fortyEightHoursFromNow.toISOString()}`);
    console.log("-".repeat(60));

    while (true) {
        const url = new URL(baseUrl);
        url.searchParams.append("limit", limit.toString());
        url.searchParams.append("status", "open");

        if (cursor) {
            url.searchParams.append("cursor", cursor);
        }

        try {
            const response = await fetch(url.toString(), { headers });

            if (response.status === 429) {
                console.log("\nRate limited. Sleeping for 2 seconds...");
                await delay(2000);
                continue;
            }

            if (!response.ok) {
                throw new Error(`HTTP Error! Status: ${response.status}`);
            }

            const data = await response.json() as Record<string, any>;
            const marketsBatch = data.markets || [];

            if (marketsBatch.length === 0) {
                console.log("\nNo more markets found. Fetch complete.");
                break;
            }

            let duplicatesInBatch = 0;
            for (const market of marketsBatch) {
                const mId = market.ticker;

                if (!marketIds.has(mId)) {
                    marketIds.add(mId);

                    const liquidityMetric = firstFinite(
                        market.liquidity,
                        market.open_interest,
                        market.volume_24h,
                        market.volume_fp,
                        market.volume_usd,
                        market.total_volume
                    );

                    // Add normalized field for downstream debugging/CSV
                    market.liquidity_metric = Number.isFinite(liquidityMetric) ? liquidityMetric : 0;

                    // --- THE DIFFERENCE ---
                    // Kalshi uses 'close_time' for market resolution expectations
                    if (market.close_time) {
                        const closeTime = new Date(market.close_time);
                        if (closeTime > now && closeTime <= fortyEightHoursFromNow) {
                            allMarkets.push(market);
                        }
                    }

                } else {
                    duplicatesInBatch++;
                }
            }

            cursor = data.cursor || null;

            process.stdout.write(`\rResolving soon: ${allMarkets.length.toString().padEnd(5)} | Duplicates skipped: ${duplicatesInBatch}`);

            if (!cursor) {
                console.log("\nReached the final page of results.");
                break;
            }

            await delay(100);

        } catch (error) {
            console.error(`\nError occurred:`, error);
            break;
        }
    }

    // --- POST-PROCESSING & DATA TREATMENT ---
    console.log(`\n\nTotal Kalshi Markets Resolving in <48h Found: ${allMarkets.length}`);

    // Volume Buckets
    let volOver10 = 0;
    let volOver100 = 0;
    let volOver1000 = 0;
    let volOver10000 = 0;
    let volOver100000 = 0;

    for (const market of allMarkets) {
        // Kalshi typically returns volume/liquidity in cents. Divide by 100 to get USD.
        const volumeInDollars = (market.liquidity_metric || 0) / 100;

        if (volumeInDollars > 100000) volOver100000++;
        if (volumeInDollars > 10000) volOver10000++;
        if (volumeInDollars > 1000) volOver1000++;
        if (volumeInDollars > 100) volOver100++;
        if (volumeInDollars > 10) volOver10++;
    }

    console.log("\n--- Volume Distribution (Resolving <48h) ---");
    console.log(`> $100,000 : ${volOver100000}`);
    console.log(`> $10,000  : ${volOver10000}`);
    console.log(`> $1,000   : ${volOver1000}`);
    console.log(`> $100     : ${volOver100}`);
    console.log(`> $10      : ${volOver10}`);
    console.log("--------------------------------------------\n");

    console.log("Sorting data by Close Time (soonest first) for CSV export...");
    allMarkets.sort((a, b) => {
        const dateA = new Date(a.close_time || 0).getTime();
        const dateB = new Date(b.close_time || 0).getTime();
        return dateA - dateB; // Sort ascending (soonest first)
    });

    // --- SAVE TO CSV ---
    const DATA_DIR = path.posix.join(process.cwd(), 'data');
    const csvFilename = path.posix.join(DATA_DIR, 'kalshi_resolving_48h.csv');

    // Ensure the data directory exists before writing
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    console.log(`Saving to ${csvFilename}...`);

    try {
        if (allMarkets.length > 0) {
            const fieldnames = new Set<string>();
            for (const market of allMarkets) {
                Object.keys(market).forEach(key => fieldnames.add(key));
            }

            const sortedFields = Array.from(fieldnames).sort();
            const priorityCols = ['ticker', 'event_ticker', 'title', 'subtitle', 'close_time', 'liquidity_metric', 'liquidity', 'open_interest', 'volume_24h'];

            for (const col of priorityCols.reverse()) {
                const index = sortedFields.indexOf(col);
                if (index > -1) {
                    sortedFields.splice(index, 1);
                    sortedFields.unshift(col);
                }
            }

            const escapeCsv = (val: any) => {
                if (val === null || val === undefined) return "";
                const str = String(val);
                if (str.includes(',') || str.includes('"') || str.includes('\n')) {
                    return `"${str.replace(/"/g, '""')}"`;
                }
                return str;
            };

            const csvRows = [];
            csvRows.push(sortedFields.map(escapeCsv).join(','));

            for (const market of allMarkets) {
                const row = sortedFields.map(field => escapeCsv(market[field]));
                csvRows.push(row.join(','));
            }

            fs.writeFileSync(csvFilename, csvRows.join('\n'), 'utf-8');
            console.log(`Success! Saved ${allMarkets.length} markets to '${csvFilename}'`);
        } else {
            console.log("No markets met the 48-hour threshold. No CSV created.");
        }
    } catch (error) {
        console.error("\nError saving to CSV:", error);
    }
}

// Run the script
getKalshiMarketsResolvingIn48Hours();