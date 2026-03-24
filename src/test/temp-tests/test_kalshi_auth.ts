import { KalshiClient } from '../../execution/kalshi_client.js';

async function main() {
    const client = new KalshiClient();

    console.log("Testing getBalance() ...");
    const bal = await client.getBalance();
    console.log("Balance:", bal);

    console.log("\nTesting getOpenPositions() ...");
    const pos = await client.getOpenPositions();
    console.log("Positions:", pos);
}

main().catch(console.error);
