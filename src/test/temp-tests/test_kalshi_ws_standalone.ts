import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import WebSocket from 'ws';
import crypto from 'crypto';
import { Get15mMarketTickers } from '../../crypto/btc15.js';

dotenv.config({ path: path.resolve(process.cwd(), '.env'), override: true });

async function testKalshiWS() {
    const generator = new Get15mMarketTickers();
    const slugs = (generator as any).getTargetSlugs();
    const targetTicker = slugs.kalshiTicker;

    console.log("Target Kalshi Ticker:", targetTicker);

    const timestamp = Date.now().toString();
    const method = "GET";
    const wsPath = "/trade-api/ws/v2";
    const msgString = timestamp + method + wsPath;

    let signature = "";
    try {
        const keyPath = process.env.KALSHI_KEY_PATH;
        if (!keyPath) {
            console.error("KALSHI_KEY_PATH not set in .env");
            return;
        }
        console.log("Using key from:", keyPath);
        const privateKey = fs.readFileSync(path.resolve(process.cwd(), keyPath), 'utf-8');
        const sign = crypto.createSign('SHA256');
        sign.update(msgString);
        sign.end();

        signature = sign.sign({
            key: privateKey,
            padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
            saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST
        }, 'base64');
    } catch (e: any) {
        console.error("Failed to sign:", e.message);
        return;
    }

    const wsUrl = `wss://api.elections.kalshi.com${wsPath}`;
    console.log("Connecting to:", wsUrl);

    const ws = new WebSocket(wsUrl, {
        headers: {
            'KALSHI-ACCESS-KEY': process.env.KALSHI_API_KEY || '',
            'KALSHI-ACCESS-SIGNATURE': signature,
            'KALSHI-ACCESS-TIMESTAMP': timestamp
        }
    });

    ws.on('open', () => {
        console.log("WS Connected. Subscribing to", targetTicker);
        const subscribeMsg = {
            id: 1,
            cmd: "subscribe",
            params: { channels: ["orderbook_delta"], market_tickers: [targetTicker] }
        };
        ws.send(JSON.stringify(subscribeMsg));
    });

    ws.on('message', (data) => {
        const payloadStr = data.toString();
        // Skip pings or print them
        if (payloadStr === 'ping') return;
        console.log("Received:", payloadStr.length > 500 ? payloadStr.slice(0, 500) + '...' : payloadStr);
    });

    ws.on('error', (err) => {
        console.error("WS Error:", err);
    });

    ws.on('close', (code, reason) => {
        console.log(`WS Closed: ${code} ${reason}`);
    });

    setTimeout(() => {
        console.log("Test complete, closing...");
        ws.close();
        process.exit(0);
    }, 5000);
}

testKalshiWS();
