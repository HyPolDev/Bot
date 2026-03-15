import { PolyClient } from '../execution/poly_client.js';
import { KalshiClient } from '../execution/kalshi_client.js';
import dotenv from 'dotenv';

dotenv.config();

async function testFetch() {
    console.log("=== Testing getOpenPositions() ===\n");

    console.log("--- Polymarket ---");
    const polyClient = new PolyClient();
    try {
        const polyPositions = await polyClient.getOpenPositions();
        console.log(`Returned ${polyPositions.length} positions:`);
        console.log(JSON.stringify(polyPositions, null, 2));
    } catch (e: any) {
        console.error("Poly error:", e.message);
    }

    console.log("\n--- Kalshi ---");
    const kalshiClient = new KalshiClient();
    try {
        const kalshiPositions = await kalshiClient.getOpenPositions();
        console.log(`Returned ${kalshiPositions.length} positions:`);
        console.log(JSON.stringify(kalshiPositions, null, 2));
    } catch (e: any) {
        console.error("Kalshi error:", e.message);
    }

    console.log("\n=== DONE ===");
}

testFetch();
