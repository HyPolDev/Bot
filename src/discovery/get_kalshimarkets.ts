import * as fs from 'fs';
import path from 'path';

// Helper function to replicate time.sleep()
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function getAllActiveKalshiMarkets() {
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

    console.log("Starting fetch of ALL active Kalshi markets...");
    console.log("Strategy: Using cursor-based pagination. Filtering for volume > 10000.");
    console.log("-".repeat(60));

    while (true) {
        // Build URL parameters
        const url = new URL(baseUrl);
        url.searchParams.append("limit", limit.toString());
        url.searchParams.append("status", "open"); // Only fetch currently active/tradeable markets

        if (cursor) {
            url.searchParams.append("cursor", cursor);
        }

        try {
            // fetch is natively supported in Node.js 18+
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
                const mId = market.ticker; // Kalshi uses 'ticker' as the unique ID

                if (!marketIds.has(mId)) {
                    marketIds.add(mId);

                    // --- THE DIFFERENCE ---
                    // Parse volume safely and check if it's over 10,000
                    const volume = parseFloat(market.volume || "0");
                    if (volume > 10000) {
                        allMarkets.push(market);
                    }
                } else {
                    duplicatesInBatch++;
                }
            }

            // Update the cursor for the next loop
            cursor = data.cursor || null;

            // Progress Indicator
            process.stdout.write(`\rHigh Vol Markets: ${allMarkets.length.toString().padEnd(5)} | Duplicates skipped: ${duplicatesInBatch}`);

            if (!cursor) {
                console.log("\nReached the final page of results.");
                break;
            }

            // Polite scraping delay
            await delay(100);

        } catch (error) {
            console.error(`\nError occurred:`, error);
            break;
        }
    }

    // --- POST-PROCESSING ---
    console.log(`\n\nTotal High Volume (>10k) Active Markets Found: ${allMarkets.length}`);

    console.log("Sorting data by Volume for CSV export...");
    allMarkets.sort((a, b) => {
        const volA = parseFloat(a.volume || "0");
        const volB = parseFloat(b.volume || "0");
        return volB - volA; // Sort descending
    });

    // --- SAVE TO CSV ---
    const DATA_DIR = path.posix.join(process.cwd(), 'data');
    const csvFilename = path.posix.join(DATA_DIR, 'kalshi_markets.csv');
    console.log(`Saving to ${csvFilename}...`);

    try {
        if (allMarkets.length > 0) {
            // 1. Collect all possible column names
            const fieldnames = new Set<string>();
            for (const market of allMarkets) {
                Object.keys(market).forEach(key => fieldnames.add(key));
            }

            // 2. Sort fields and prioritize key columns for Kalshi
            const sortedFields = Array.from(fieldnames).sort();
            const priorityCols = ['ticker', 'event_ticker', 'title', 'subtitle', 'volume', 'close_time'];

            for (const col of priorityCols.reverse()) {
                const index = sortedFields.indexOf(col);
                if (index > -1) {
                    sortedFields.splice(index, 1);
                    sortedFields.unshift(col);
                }
            }

            // 3. Helper to properly escape CSV fields
            const escapeCsv = (val: any) => {
                if (val === null || val === undefined) return "";
                const str = String(val);
                // Wrap in quotes if there are commas, quotes, or newlines
                if (str.includes(',') || str.includes('"') || str.includes('\n')) {
                    return `"${str.replace(/"/g, '""')}"`;
                }
                return str;
            };

            // 4. Build CSV content
            const csvRows = [];
            csvRows.push(sortedFields.map(escapeCsv).join(',')); // Add Header

            for (const market of allMarkets) {
                const row = sortedFields.map(field => escapeCsv(market[field]));
                csvRows.push(row.join(','));
            }

            // 5. Write to file
            fs.writeFileSync(csvFilename, csvRows.join('\n'), 'utf-8');
            console.log(`Success! Saved ${allMarkets.length} markets to '${csvFilename}'`);
        } else {
            console.log("No markets met the 10,000 volume threshold. No CSV created.");
        }
    } catch (error) {
        console.error("\nError saving to CSV:", error);
    }
}

// Run the script
getAllActiveKalshiMarkets();