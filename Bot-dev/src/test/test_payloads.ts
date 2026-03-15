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
        let polyYesTokenId = '';
        let polyNoTokenId = '';
        try {
            const polyResponse = await fetch(`https://gamma-api.polymarket.com/markets/${pair.polyMarket.internal_id}`);
            if (polyResponse.ok) {
                const polyMarketData = await polyResponse.json();
                const clobTokenIds = JSON.parse(polyMarketData.clobTokenIds);
                polyYesTokenId = clobTokenIds[0];
                polyNoTokenId = clobTokenIds[1];
            }
        } catch (e) {
            console.error(`Error fetching token IDs:`, e);
        }

        const kTicker = pair.kalshiMarket.internal_id;

        console.log(`\nChecking pair: ${pair.pairId}`);
        console.log(`Poly expected tokens: [${polyYesTokenId}, ${polyNoTokenId}]`);
        console.log(`kTicker expected: ${kTicker}`);

        const pMatch = polyPositions.find((p: any) => (p.asset_id === polyYesTokenId || p.asset_id === polyNoTokenId) && p.size > 0);
        const kMatch = kalshiPositions.find((k: any) => k.ticker === kTicker && Math.abs(k.position) > 0);

        console.log(`pMatch found:`, pMatch ? 'YES' : 'NO');
        if (!pMatch) {
            const exist = polyPositions.find((p: any) => (p.asset_id === polyYesTokenId || p.asset_id === polyNoTokenId));
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
