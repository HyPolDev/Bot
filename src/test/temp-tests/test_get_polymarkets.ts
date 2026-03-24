import * as fs from 'fs';
import path from 'path';

// Helper function to replicate time.sleep()
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function getMarketsResolvingIn48Hours() {
    const baseUrl = "https://gamma-api.polymarket.com/markets";
    const limit = 100;
    let offset = 0;
    const allMarkets: Record<string, any>[] = [];
    const marketIds = new Set<string>();

    const headers = {
        "Accept": "application/json",
        "Content-Type": "application/json"
    };

    // --- TIME CALCULATION ---
    const now = new Date();
    const fortyEightHoursFromNow = new Date(now.getTime() + 48 * 60 * 60 * 1000);

    console.log("Starting fetch of ALL active markets...");
    console.log(`Strategy: Filtering for markets resolving between NOW and ${fortyEightHoursFromNow.toISOString()}`);
    console.log("-".repeat(60));

    while (true) {
        const url = new URL(baseUrl);
        url.searchParams.append("limit", limit.toString());
        url.searchParams.append("offset", offset.toString());
        url.searchParams.append("active", "true");
        url.searchParams.append("closed", "false");
        url.searchParams.append("order", "id");
        url.searchParams.append("ascending", "true");

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

                    if (market.endDate) {
                        const endDate = new Date(market.endDate);
                        if (endDate > now && endDate <= fortyEightHoursFromNow) {
                            allMarkets.push(market);
                        }
                    }
                } else {
                    duplicatesInBatch++;
                }
            }

            process.stdout.write(`\rOffset: ${offset.toString().padEnd(7)} | Resolving soon: ${allMarkets.length.toString().padEnd(5)} | Duplicates skipped: ${duplicatesInBatch}`);

            offset += limit;
            await delay(100);

        } catch (error) {
            console.error(`\nError occurred at offset ${offset}:`, error);
            break;
        }
    }

    // --- POST-PROCESSING & DATA TREATMENT ---
    console.log(`\n\nTotal Markets Resolving in <48h Found: ${allMarkets.length}`);

    // Volume Buckets
    let volOver10 = 0;
    let volOver100 = 0;
    let volOver1000 = 0;
    let volOver10000 = 0;
    let volOver100000 = 0;

    for (const market of allMarkets) {
        const volume = parseFloat(market.volume || "0");
        if (volume > 100000) volOver100000++;
        if (volume > 10000) volOver10000++;
        if (volume > 1000) volOver1000++;
        if (volume > 100) volOver100++;
        if (volume > 10) volOver10++;
    }

    console.log("\n--- Volume Distribution (Resolving <48h) ---");
    console.log(`> $100,000 : ${volOver100000}`);
    console.log(`> $10,000  : ${volOver10000}`);
    console.log(`> $1,000   : ${volOver1000}`);
    console.log(`> $100     : ${volOver100}`);
    console.log(`> $10      : ${volOver10}`);
    console.log("--------------------------------------------\n");

    console.log("Sorting data by End Date (soonest first) for CSV export...");
    allMarkets.sort((a, b) => {
        const dateA = new Date(a.endDate || 0).getTime();
        const dateB = new Date(b.endDate || 0).getTime();
        return dateA - dateB;
    });

    // --- SAVE TO CSV ---
    const DATA_DIR = path.posix.join(process.cwd(), 'data');
    const csvFilename = path.posix.join(DATA_DIR, 'polymarket_resolving_48h.csv');

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

            let sortedFields = Array.from(fieldnames).sort();
            const priorityCols = ['id', 'question', 'endDate', 'liquidity', 'volume'];

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
            console.log("No markets are resolving in the next 48 hours. No CSV created.");
        }
    } catch (error) {
        console.error("\nError saving to CSV:", error);
    }
}

// Run the script
getMarketsResolvingIn48Hours();