import { PolyClient } from '../execution/poly_client.js';
import { KalshiClient } from '../execution/kalshi_client.js';

async function testBalances() {
    console.log(`\n======================================================`);
    console.log(`💰 INITIATING LIVE BALANCE SECURE DEMO 💰`);
    console.log(`======================================================\n`);

    const polyClient = new PolyClient();
    const kalshiClient = new KalshiClient();

    console.log(`[TEST 1] Fetching Polymarket (Polygon USDC) Balance...`);
    try {
        const polyBalance = await polyClient.getCollateralBalance();
        console.log(`✅ Polymarket Available USDC: $${polyBalance.toFixed(2)}\n`);
    } catch (e: any) {
        console.log(`❌ Polymarket Balance Fetch Failed: ${e.message}\n`);
    }

    console.log(`[TEST 2] Fetching Kalshi (USD) Portfolio Balance...`);
    try {
        const kalshiBalance = await kalshiClient.getBalance();
        console.log(`✅ Kalshi Available USD: $${kalshiBalance.toFixed(2)}\n`);
    } catch (e: any) {
        console.log(`❌ Kalshi Balance Fetch Failed: ${e.message}\n`);
    }

    console.log(`======================================================\n`);
}

testBalances();
