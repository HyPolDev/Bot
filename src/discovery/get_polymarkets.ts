import * as fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger';

// Helper function to replicate time.sleep()
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function getAllActivePolymarketMarkets() {
    const baseUrl = "https://gamma-api.polymarket.com/markets";
    const limit = 100;
    let offset = 0;
    const allMarkets: Record<string, any>[] = [];
    const marketIds = new Set<string>();

    const headers = {
        "Accept": "application/json",
        "Content-Type": "application/json"
    };

    console.log("Starting fetch of ALL active markets...");
    console.log("Strategy: Sorting by ID to prevent pagination drift. Filtering for liquidity > 10000.");
    console.log("-".repeat(60));

    while (true) {
        // Build URL parameters
        const url = new URL(baseUrl);
        url.searchParams.append("limit", limit.toString());
        url.searchParams.append("offset", offset.toString());
        url.searchParams.append("active", "true");
        url.searchParams.append("closed", "false");
        url.searchParams.append("order", "id");
        url.searchParams.append("ascending", "true");

        try {
            // fetch is natively supported in Node.js 18+
            const response = await fetch(url.toString(), { headers });

            if (response.status === 429) {
                console.log("\nRate limited. Sleeping for 2 seconds...");
                await delay(2000);
                continue;
            }

            if (!response.ok) {
                logger.error(`HTTP Error! Status: ${response.status}`);
                throw new Error(`HTTP Error! Status: ${response.status}`);
            }

            const data = await response.json() as Record<string, any>[];

            if (!data || data.length === 0) {
                console.log("\nNo more markets found. Fetch complete.");
                break;
            }

            let duplicatesInBatch = 0;
            for (const market of data) {
                const mId = market.id;

                if (!marketIds.has(mId)) {
                    marketIds.add(mId);

                    // --- THE DIFFERENCE ---
                    // Parse liquidity safely and check if it's over 10,000
                    const volume = parseFloat(market.volume || "0");
                    if (volume > 10000) {
                        allMarkets.push(market);
                    }
                } else {
                    duplicatesInBatch++;
                }
            }

            // Progress Indicator (Node.js equivalent of sys.stdout.write)
            process.stdout.write(`\rOffset: ${offset.toString().padEnd(7)} | High Vol Markets: ${allMarkets.length.toString().padEnd(5)} | Duplicates skipped: ${duplicatesInBatch}`);

            offset += limit;

            // Polite 0.1s delay
            await delay(100);

        } catch (error) {
            console.error(`\nError occurred at offset ${offset}:`, error);
            break;
        }
    }

    // --- POST-PROCESSING ---
    console.log(`\n\nTotal High Liquidity (>10k) Active Markets Found: ${allMarkets.length}`);

    console.log("Sorting data by Volume for CSV export...");
    allMarkets.sort((a, b) => {
        const volA = parseFloat(a.volume || "0");
        const volB = parseFloat(b.volume || "0");
        return volB - volA; // Sort descending
    });

    // --- SAVE TO CSV ---
    const DATA_DIR = path.posix.join(process.cwd(), 'data');
    const csvFilename = path.posix.join(DATA_DIR, 'polymarket_markets.csv');
    console.log(`Saving to ${csvFilename}...`);

    try {
        if (allMarkets.length > 0) {
            // 1. Collect all possible column names
            const fieldnames = new Set<string>();
            for (const market of allMarkets) {
                Object.keys(market).forEach(key => fieldnames.add(key));
            }

            // 2. Sort fields and prioritize key columns
            let sortedFields = Array.from(fieldnames).sort();
            const priorityCols = ['id', 'question', 'liquidity', 'volume', 'endDate'];

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
                // If the string has commas, quotes, or newlines, wrap it in quotes and escape inner quotes
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
            console.log("No markets met the 10,000 liquidity threshold. No CSV created.");
        }
    } catch (error) {
        console.error("\nError saving to CSV:", error);
    }
}

// Run the script
getAllActivePolymarketMarkets();