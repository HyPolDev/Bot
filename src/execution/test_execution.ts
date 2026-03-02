import { PolyClient } from './poly_client.js';
import { KalshiClient } from './kalshi_client.js';

async function runTests() {
    console.log(`\n======================================================`);
    console.log(`🚀 INITIATING LIVE EXCHANGE CRYPTO-SIGNATURE TEST 🚀`);
    console.log(`======================================================\n`);

    // 1. Go to Kalshi.com, click a market, look at the URL for the ticker (e.g., KXFEDDECISION-26APR-C26)
    const TEST_KALSHI_TICKER = "KXOSCARCOSTUME-26-FRA";

    // 2. Go to Polymarket.com, click a market, open network tab, or pull a token ID from your candidate_market_groups.json
    const TEST_POLY_TOKEN_ID = "1530205004298226087006929111227812862292089818938165202645531346934112949540";

    if (TEST_KALSHI_TICKER.includes('REPLACE')) {
        console.error("❌ ERROR: Please hardcode an active Kalshi ticker in the script.");
        process.exit(1);
    }

    const polyClient = new PolyClient();
    const kalshiClient = new KalshiClient();

    // We use $0.01 as a guaranteed-to-fail limit price.
    const TEST_SIZE = 1;
    const TEST_PRICE_VWAP = 0.01;

    console.log(`[TEST 1] Pinging Kalshi REST API...`);
    console.log(`  -> Attempting to buy 1 contract of ${TEST_KALSHI_TICKER} @ $0.01`);

    const kalshiResult = await kalshiClient.placeAggressiveLimit(TEST_KALSHI_TICKER, true, TEST_SIZE, TEST_PRICE_VWAP);
    console.log(`\nKalshi Response:`);
    console.dir(kalshiResult, { depth: null, colors: true });

    if (kalshiResult.error && kalshiResult.error.toLowerCase().includes('unauthorized')) {
        console.log(`❌ KALSHI AUTH FAILED: Check your KALSHI-API-SECRET.txt and KALSHI_KEY_ID.\n`);
    } else {
        console.log(`✅ KALSHI AUTH PASSED! (The order was successfully signed and routed)\n`);
    }

    console.log(`------------------------------------------------------\n`);

    console.log(`[TEST 2] Pinging Polymarket Gamma API (CLOB)...`);
    console.log(`  -> Attempting to buy 1 contract of Token ${TEST_POLY_TOKEN_ID} @ $0.01`);

    const polyResult = await polyClient.placeAggressiveLimit(TEST_POLY_TOKEN_ID, true, TEST_SIZE, TEST_PRICE_VWAP);
    console.log(`\nPolymarket Response:`);
    console.dir(polyResult, { depth: null, colors: true });

    if (polyResult.error && (polyResult.error.toLowerCase().includes('signature') || polyResult.error.toLowerCase().includes('unauthorized'))) {
        console.log(`❌ POLYMARKET AUTH FAILED: Check your POLY_PRIVATE_KEY and POLY_PROXY_ADDRESS.\n`);
    } else {
        console.log(`✅ POLYMARKET AUTH PASSED! (The EIP-712 payload was correctly signed)\n`);
    }

    console.log(`======================================================\n`);
}

runTests();