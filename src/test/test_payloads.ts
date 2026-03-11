import fs from 'fs';
import { KalshiClient } from '../execution/kalshi_client.js';
import { PolyClient } from '../execution/poly_client.js';
import { DatabaseConnection } from '../db/connection.js';
import { MarketPair } from '../db/models/MarketPair.js';

async function testMatch() {
    const kClient = new KalshiClient();
    const pClient = new PolyClient();

    const polyPositions = await pClient.getOpenPositions();
    const kalshiPositions = await kClient.getOpenPositions();

    await DatabaseConnection.getInstance().connect();
    const pairs = await MarketPair.find({});

    console.log(`Found ${polyPositions.length} poly pos, ${kalshiPositions.length} kalshi pos. Pairs: ${pairs.length}`);

    for (const pair of pairs) {
        const pAsset = pair.polyMarket.asset_id;
        const kTicker = pair.kalshiMarket.internal_id;
        const matchPolyStr = pair.polyMarket.condition_id;

        console.log(`\nChecking pair: ${pair.id}`);
        console.log(`pAsset expected: ${pAsset}`);
        console.log(`kTicker expected: ${kTicker}`);

        const pMatch = polyPositions.find((p: any) => p.asset === pAsset && p.size > 0);
        const kMatch = kalshiPositions.find((k: any) => k.ticker === kTicker && Math.abs(k.position) > 0);

        console.log(`pMatch found:`, pMatch ? 'YES' : 'NO');
        if (!pMatch) {
            const exist = polyPositions.find((p: any) => p.asset === pAsset);
            if (exist) console.log(`Poly fallback -> exists but size is ${exist.size}`);
        }

        console.log(`kMatch found:`, kMatch ? 'YES' : 'NO');
        if (!kMatch) {
            const exist = kalshiPositions.find((k: any) => k.ticker === kTicker);
            if (exist) console.log(`Kalshi fallback -> exists but position is ${exist.position}`);
        }
    }
    await DatabaseConnection.getInstance().disconnect();
}
testMatch();
