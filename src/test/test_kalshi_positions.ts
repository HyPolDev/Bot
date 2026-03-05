import { KalshiClient } from '../execution/kalshi_client.js';
import dotenv from 'dotenv';
dotenv.config();

async function testKalshi() {
    console.log("Testing Kalshi Positions...");
    const client = new KalshiClient();
    try {
        const positions = await client.getOpenPositions();
        console.log("Kalshi Positions:");
        if (positions.length > 0) {
            console.log(JSON.stringify(positions.slice(0, 5), null, 2));
            console.log(`Total Kalshi positions loaded: ${positions.length}`);
        } else {
            console.log("No positions returned or empty array.");
        }
    } catch (e: any) {
        console.error("Kalshi error:", e.message);
    }
}

testKalshi();
