import { PolyClient } from '../execution/poly_client.js';
import dotenv from 'dotenv';

dotenv.config();

async function testFetch() {
    console.log("Testing Poly Positions via data-api...");
    const address = process.env.POLY_PROXY_ADDRESS;
    try {
        const res = await fetch(`https://data-api.polymarket.com/positions?user=${address}`);
        const data = await res.json();
        if (Array.isArray(data)) {
            console.log("Poly Positions:", JSON.stringify(data.slice(0, 2), null, 2));
        } else {
            console.log("Poly returned object. Keys:", Object.keys(data));
            console.log(JSON.stringify(data).substring(0, 500));
        }
    } catch (e: any) {
        console.error("Poly error:", e.message);
    }
}

testFetch();
