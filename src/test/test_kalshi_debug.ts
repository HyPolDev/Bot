/**
 * test_kalshi_debug.ts
 * Comprehensive Kalshi API diagnostic.
 * Tests: (1) Auth & balance, (2) Markets REST, (3) Positions, (4) Orderbook WS
 *
 * Run: npx tsx src/test/test_kalshi_debug.ts
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import dotenv from 'dotenv';
import WebSocket from 'ws';

dotenv.config();

// ─── Auth helpers ─────────────────────────────────────────────────────────────
const BASE_URL = 'https://api.elections.kalshi.com/trade-api/v2';
const WS_PATH  = '/trade-api/ws/v2';
const WS_URL   = 'wss://api.elections.kalshi.com' + WS_PATH;

const KEY_ID = process.env.KALSHI_API_KEY || '';
const PRIVATE_KEY = (() => {
    if (process.env.KALSHI_PRIVATE_KEY) return process.env.KALSHI_PRIVATE_KEY;
    if (process.env.KALSHI_KEY_PATH) {
        try { return fs.readFileSync(process.env.KALSHI_KEY_PATH, 'utf-8'); } catch {}
    }
    return '';
})();

function sign(timestamp: number, method: string, path: string): string {
    const msg = timestamp.toString() + method + path;
    return crypto.sign('sha256', Buffer.from(msg), {
        key: PRIVATE_KEY,
        padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
        saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
    }).toString('base64');
}

function authHeaders(method: string, endpoint: string) {
    const ts = Date.now();
    const fullPath = `/trade-api/v2${endpoint}`;
    return {
        'Content-Type': 'application/json',
        'KALSHI-ACCESS-KEY': KEY_ID,
        'KALSHI-ACCESS-SIGNATURE': sign(ts, method, fullPath),
        'KALSHI-ACCESS-TIMESTAMP': ts.toString(),
    };
}

async function rawGet(endpoint: string, params?: Record<string, string>) {
    const url = new URL(`${BASE_URL}${endpoint}`);
    if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    const res = await fetch(url.toString(), { method: 'GET', headers: authHeaders('GET', endpoint) });
    const text = await res.text();
    return { status: res.status, body: text };
}

function sep(title: string) {
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`  ${title}`);
    console.log('─'.repeat(60));
}

// ─── Test 1: Auth & Balance ───────────────────────────────────────────────────
async function testBalance() {
    sep('TEST 1: Auth & Balance');
    const { status, body } = await rawGet('/portfolio/balance');
    console.log(`HTTP ${status}`);
    if (status === 200) {
        const data = JSON.parse(body);
        console.log(`✅ Balance (cents): ${data.balance}  →  $${((data.balance || 0) / 100).toFixed(2)}`);
    } else {
        console.log(`❌ Error body: ${body}`);
    }
    return status === 200;
}

// ─── Test 2: Markets (unauthenticated) ───────────────────────────────────────
async function testMarkets() {
    sep('TEST 2: Public Markets Endpoint (no auth)');
    const url = `${BASE_URL}/markets?limit=5&status=open`;
    const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
    const text = await res.text();
    console.log(`HTTP ${res.status}`);
    if (res.status === 200) {
        const data = JSON.parse(text);
        const markets = data.markets || [];
        console.log(`✅ First page returned ${markets.length} markets`);
        if (markets.length > 0) {
            console.log(`   Sample ticker: ${markets[0].ticker}`);
            console.log(`   Sample title:  ${markets[0].title}`);
            console.log(`   Sample volume: ${markets[0].volume}`);
        }
        console.log(`   Next cursor: ${data.cursor || '(none — end of results)'}`);
    } else {
        console.log(`❌ Error body: ${text}`);
    }
}

// ─── Test 3: Positions (authenticated, dump raw) ─────────────────────────────
async function testPositions() {
    sep('TEST 3: Positions (raw response dump)');
    // Kalshi positions endpoint also accepts count_filter param
    // Default filter may hide small positions — try both
    for (const params of [
        {},
        { count_filter: 'all' as any },
        { settlement_status: 'all' as any }
    ]) {
        const query = new URLSearchParams(params as any).toString();
        const suffix = query ? `?${query}` : '';
        const endpoint = `/portfolio/positions${suffix}`;
        const res = await fetch(`${BASE_URL}${endpoint}`, {
            method: 'GET',
            headers: authHeaders('GET', '/portfolio/positions'),
        });
        const text = await res.text();
        console.log(`\nGET /portfolio/positions${suffix}`);
        console.log(`HTTP ${res.status}`);
        if (res.status === 200) {
            const data = JSON.parse(text);
            const raw = data.market_positions || data.positions || data.event_positions || data;
            const keys = Object.keys(data);
            console.log(`   Response top-level keys: [${keys.join(', ')}]`);
            if (Array.isArray(raw)) {
                console.log(`   Array length: ${raw.length}`);
                if (raw.length > 0) console.log(`   First item: ${JSON.stringify(raw[0], null, 2)}`);
            } else {
                console.log(`   Raw (not array): ${JSON.stringify(data).substring(0, 500)}`);
            }
        } else {
            console.log(`   ❌ Error: ${text.substring(0, 300)}`);
        }
    }
}

// ─── Test 4: WebSocket Orderbook ─────────────────────────────────────────────
async function testWsOrderbook(ticker: string) {
    sep(`TEST 4: WS Orderbook Snapshot for ${ticker}`);

    return new Promise<void>((resolve) => {
        const timestamp = Date.now().toString();
        const msgString = timestamp + 'GET' + WS_PATH;
        let sig = '';
        try {
            const s = crypto.createSign('SHA256');
            s.update(msgString);
            s.end();
            sig = s.sign({
                key: PRIVATE_KEY,
                padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
                saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
            }, 'base64');
        } catch (e: any) {
            console.log(`❌ Signature generation failed: ${e.message}`);
            resolve();
            return;
        }

        const ws = new WebSocket(WS_URL, {
            headers: {
                'KALSHI-ACCESS-KEY': KEY_ID,
                'KALSHI-ACCESS-SIGNATURE': sig,
                'KALSHI-ACCESS-TIMESTAMP': timestamp,
            }
        });

        const timeout = setTimeout(() => {
            console.log('❌ WS timeout — no snapshot received within 8s');
            ws.close();
            resolve();
        }, 8000);

        ws.on('open', () => {
            console.log('✅ WS connected');
            ws.send(JSON.stringify({
                id: 1,
                cmd: 'subscribe',
                params: { channels: ['orderbook_delta'], market_tickers: [ticker] }
            }));
        });

        ws.on('message', (data: WebSocket.RawData) => {
            const raw = data.toString();
            try {
                const payload = JSON.parse(raw);
                console.log(`   MSG type: ${payload.type}`);

                if (payload.type === 'subscribed') {
                    console.log('   Subscription confirmed, waiting for snapshot...');
                }

                if (payload.type === 'orderbook_snapshot') {
                    clearTimeout(timeout);
                    const msg = payload.msg;
                    console.log(`\n✅ Snapshot received!`);
                    console.log(`   YES bids (raw): ${JSON.stringify((msg.yes || []).slice(0, 3))}`);
                    console.log(`   NO  bids (raw): ${JSON.stringify((msg.no  || []).slice(0, 3))}`);
                    // Check format: are prices in cents (int) or decimal?
                    const firstYes = (msg.yes || [[]])[0];
                    if (firstYes) {
                        const priceRaw = firstYes[0];
                        console.log(`\n   → Raw price value: ${priceRaw} (type: ${typeof priceRaw})`);
                        console.log(`   → Interpreted as cents: $${(priceRaw / 100).toFixed(2)}`);
                        console.log(`   → Interpreted as decimal: $${priceRaw.toFixed ? priceRaw.toFixed(4) : priceRaw}`);
                        if (priceRaw > 1) {
                            console.log(`   ✅ FORMAT CONFIRMED: Prices are in CENTS (integer). Dividing by 100 is CORRECT.`);
                        } else {
                            console.log(`   ⚠️  WARNING: Price is already a decimal < 1. Dividing by 100 would PRODUCE NaN-like values!`);
                        }
                    }
                    ws.close();
                    resolve();
                }

                if (payload.type === 'error') {
                    clearTimeout(timeout);
                    console.log(`❌ WS Error: ${JSON.stringify(payload)}`);
                    ws.close();
                    resolve();
                }
            } catch {
                console.log(`   (non-JSON message: ${raw.substring(0, 100)})`);
            }
        });

        ws.on('error', (err) => {
            clearTimeout(timeout);
            console.log(`❌ WS Error: ${err.message}`);
            resolve();
        });

        ws.on('close', () => {
            clearTimeout(timeout);
        });
    });
}

// ─── Test 5: Single market REST orderbook ────────────────────────────────────
async function testRestOrderbook(ticker: string) {
    sep(`TEST 5: REST Orderbook for ${ticker}`);
    // Kalshi REST orderbook endpoint
    const endpoint = `/markets/${ticker}/orderbook`;
    const { status, body } = await rawGet(endpoint);
    console.log(`HTTP ${status}`);
    if (status === 200) {
        const data = JSON.parse(body);
        const ob = data.orderbook || data;
        console.log(`✅ Orderbook keys: [${Object.keys(ob).join(', ')}]`);
        const yesAsks = ob.yes || [];
        const noAsks = ob.no || [];
        console.log(`   YES side (first 3): ${JSON.stringify(yesAsks.slice(0, 3))}`);
        console.log(`   NO  side (first 3): ${JSON.stringify(noAsks.slice(0, 3))}`);
        if (yesAsks.length > 0) {
            const p = yesAsks[0][0];
            console.log(`\n   → Raw price: ${p}  (${p > 1 ? 'CENTS — /100 correct' : 'DECIMAL — /100 will cause NaN/underflow!'})`);
        }
    } else {
        console.log(`❌ Error: ${body.substring(0, 300)}`);
    }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
    console.log('\n══════════════════════════════════════════════════════');
    console.log('               KALSHI FULL DIAGNOSTIC                ');
    console.log('══════════════════════════════════════════════════════');
    console.log(`BASE_URL:  ${BASE_URL}`);
    console.log(`KEY_ID:    ${KEY_ID ? KEY_ID.substring(0, 8) + '...' : '(MISSING!)'}`);
    console.log(`PRIV_KEY:  ${PRIVATE_KEY ? 'Loaded (' + PRIVATE_KEY.length + ' chars)' : '(MISSING!)'}`);

    const authOk = await testBalance();
    await testMarkets();
    await testPositions();

    // Use the first open market ticker we can find for WS/orderbook tests
    const mktRes = await fetch(`${BASE_URL}/markets?limit=1&status=open`, { headers: { 'Accept': 'application/json' } });
    let testTicker = 'KXBTCD-25DEC3100'; // fallback
    if (mktRes.ok) {
        const mktData = await mktRes.json() as any;
        const m = (mktData.markets || [])[0];
        if (m?.ticker) testTicker = m.ticker;
    }
    console.log(`\n[Using ticker "${testTicker}" for orderbook tests]`);

    await testRestOrderbook(testTicker);
    if (authOk) await testWsOrderbook(testTicker);

    console.log('\n══════════════════════════════════════════════════════');
    console.log('                  DIAGNOSTIC COMPLETE                 ');
    console.log('══════════════════════════════════════════════════════\n');
    process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
