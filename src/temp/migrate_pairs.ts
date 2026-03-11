import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { DatabaseConnection } from '../db/connection.js';
import { MarketPair } from '../db/models/MarketPair.js';

dotenv.config({ override: true });

async function migrate() {
    console.log('[Migration] Starting migration...');

    // Connect to DB
    const db = DatabaseConnection.getInstance();
    await db.connect();

    const pairsFile = path.join(process.cwd(), 'data/market_pairs.json');
    if (!fs.existsSync(pairsFile)) {
        console.error(`[Error] ${pairsFile} not found.`);
        await db.disconnect();
        return;
    }

    const rawData = fs.readFileSync(pairsFile, 'utf-8');
    const pairs = JSON.parse(rawData);

    if (pairs.length === 0) {
        console.log("[System] No pairs found to migrate.");
        await db.disconnect();
        return;
    }

    console.log(`[Migration] Found ${pairs.length} pairs. Upserting into MongoDB...`);

    let successCount = 0;
    for (const pair of pairs) {
        try {
            const pairId = `${pair.kalshiMarket.internal_id}+${pair.polyMarket.internal_id}`;
            const alignment = pair.outcomeAlignment || pair.alignment || 0; // fallback just in case

            await MarketPair.findOneAndUpdate(
                { pairId: pairId },
                {
                    $set: {
                        kalshiMarket: pair.kalshiMarket,
                        polyMarket: pair.polyMarket,
                        score: pair.score,
                        outcomeAlignment: alignment,
                        metrics: {
                            last_updated: new Date(),
                            s_history: {
                                PolyYes_kalshiNo: [],
                                PolyNoKalshiYes: []
                            },
                            expected_annualized_return: null
                        }
                    }
                },
                { upsert: true, new: true }
            );
            successCount++;
            process.stdout.write(`\r[Migration] Progress: ${successCount}/${pairs.length}`);
        } catch (error) {
            console.error(`\n[Error] Failed to migrate pair:`, error);
        }
    }

    console.log(`\n[Migration] Successfully bulk-migrated ${successCount} pairs to MongoDB.`);
    await db.disconnect();
}

migrate().catch(console.error);
