import * as crypto from 'crypto';
import * as fs from 'fs';
import { ExecutionReceipt } from './types.js';
import dotenv from 'dotenv';

dotenv.config();

export class KalshiClient {
    private readonly baseUrl: string = 'https://api.elections.kalshi.com/trade-api/v2';
    private keyId: string = '';
    private privateKey: string = '';

    constructor() {
        this.keyId = process.env.KALSHI_API_KEY || '';

        if (process.env.KALSHI_PRIVATE_KEY) {
            this.privateKey = process.env.KALSHI_PRIVATE_KEY;
        } else if (process.env.KALSHI_KEY_PATH) {
            try {
                this.privateKey = fs.readFileSync(process.env.KALSHI_KEY_PATH, 'utf-8');
            } catch (e) {
                console.warn("Could not read Kalshi Private Key from path:", process.env.KALSHI_KEY_PATH);
            }
        }
    }

    private sign(timestamp: number, method: string, path: string): string {
        const msgString = timestamp.toString() + method + path;
        return crypto.sign(
            "sha256",
            Buffer.from(msgString),
            {
                key: this.privateKey,
                padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
                saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST
            }
        ).toString('base64');
    }

    public async getBalance(): Promise<number> {
        const timestamp = Date.now();
        const endpoint = '/portfolio/balance';
        const signaturePath = `/trade-api/v2${endpoint}`;

        try {
            const signature = this.sign(timestamp, 'GET', signaturePath);
            const response = await fetch(`${this.baseUrl}${endpoint}`, {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json',
                    'KALSHI-ACCESS-KEY': this.keyId,
                    'KALSHI-ACCESS-SIGNATURE': signature,
                    'KALSHI-ACCESS-TIMESTAMP': timestamp.toString(),
                }
            });

            if (!response.ok) {
                const errorStr = await response.text();
                throw new Error(`HTTP Error ${response.status}: ${errorStr}`);
            }

            const data = await response.json();
            // Assuming data contains balance in cents under 'balance'
            const balanceCents = data.balance || 0;
            return balanceCents / 100; // Returns in dollars
        } catch (error: any) {
            console.error(`[KalshiClient] getBalance error:`, error.message);
            return 0; // Return safe default
        }
    }

    public async placeAggressiveLimit(ticker: string, side: 'yes' | 'no', isEntry: boolean, size: number, maxVwap: number): Promise<ExecutionReceipt> {
        const timestamp = Date.now();
        const action = isEntry ? 'buy' : 'sell';
        const yesPriceCents = Math.floor(maxVwap * 100);
        const clientOrderId = crypto.randomUUID();

        const endpoint = '/portfolio/orders';
        const signaturePath = `/trade-api/v2${endpoint}`;

        try {
            const signature = this.sign(timestamp, 'POST', signaturePath);

            const response = await fetch(`${this.baseUrl}${endpoint}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'KALSHI-ACCESS-KEY': this.keyId,
                    'KALSHI-ACCESS-SIGNATURE': signature,
                    'KALSHI-ACCESS-TIMESTAMP': timestamp.toString(),
                },
                body: JSON.stringify({
                    action: action,
                    side: side,
                    ticker: ticker,
                    count: size,
                    client_order_id: clientOrderId,
                    type: 'limit',
                    ...(side === 'yes' ? { yes_price: yesPriceCents } : { no_price: yesPriceCents }),
                    time_in_force: 'fill_or_kill'
                })
            });

            if (!response.ok) {
                const errorStr = await response.text();
                return {
                    exchange: 'Kalshi',
                    status: 'failed',
                    error: `HTTP Error ${response.status}: ${errorStr}`
                };
            }

            const data = await response.json();
            const orderInfo = data.order || {};
            const orderId = orderInfo.order_id || clientOrderId;
            const status = orderInfo.status; // e.g. 'executed', 'canceled', 'resting'

            if (status === 'executed') {
                return {
                    exchange: 'Kalshi',
                    status: 'filled',
                    orderId: orderId,
                    executedPrice: (orderInfo.yes_price || yesPriceCents) / 100,
                    executedSize: orderInfo.actual_count || size
                };
            } else if (status === 'canceled') {
                return {
                    exchange: 'Kalshi',
                    status: 'canceled',
                    orderId: orderId,
                    error: 'Order was canceled'
                };
            } else {
                return {
                    exchange: 'Kalshi',
                    status: 'failed',
                    orderId: orderId,
                    error: `Order returned unhandled status for IOC: ${status}`
                };
            }
        } catch (error: any) {
            return {
                exchange: 'Kalshi',
                status: 'failed',
                error: error.message || 'Unknown network error'
            };
        }
    }

    public async placeMarketOrder(ticker: string, side: 'yes' | 'no', isEntry: boolean, size: number): Promise<ExecutionReceipt> {
        const timestamp = Date.now();
        const action = isEntry ? 'buy' : 'sell';
        const clientOrderId = crypto.randomUUID();

        const endpoint = '/portfolio/orders';
        const signaturePath = `/trade-api/v2${endpoint}`;

        try {
            const signature = this.sign(timestamp, 'POST', signaturePath);

            const response = await fetch(`${this.baseUrl}${endpoint}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'KALSHI-ACCESS-KEY': this.keyId,
                    'KALSHI-ACCESS-SIGNATURE': signature,
                    'KALSHI-ACCESS-TIMESTAMP': timestamp.toString(),
                },
                body: JSON.stringify({
                    action: action,
                    side: side,
                    ticker: ticker,
                    count: size,
                    client_order_id: clientOrderId,
                    type: 'market' // Native market order type
                })
            });

            if (!response.ok) {
                const errorStr = await response.text();
                return {
                    exchange: 'Kalshi',
                    status: 'failed',
                    error: `HTTP Error ${response.status}: ${errorStr}`
                };
            }

            const data = await response.json();
            const orderInfo = data.order || {};
            const orderId = orderInfo.order_id || clientOrderId;
            const status = orderInfo.status;

            if (status === 'executed') {
                return {
                    exchange: 'Kalshi',
                    status: 'filled',
                    orderId: orderId,
                    executedPrice: 0, // Unfilled info natively until queried, but executed
                    executedSize: orderInfo.actual_count || size
                };
            } else if (status === 'canceled') {
                return {
                    exchange: 'Kalshi',
                    status: 'canceled',
                    orderId: orderId,
                    error: 'Market Order was canceled'
                };
            } else {
                return {
                    exchange: 'Kalshi',
                    status: 'failed',
                    orderId: orderId,
                    error: `Order returned unhandled status for Market Order: ${status}`
                };
            }
        } catch (error: any) {
            return {
                exchange: 'Kalshi',
                status: 'failed',
                error: error.message || 'Unknown network error'
            };
        }
    }

    public async getOpenPositions(): Promise<{ ticker: string, position: number, market_exposure: number, fees_paid: number, total_traded: number }[]> {
        const timestamp = Date.now();
        const endpoint = '/portfolio/positions';
        const signaturePath = `/trade-api/v2${endpoint}`;

        try {
            const signature = this.sign(timestamp, 'GET', signaturePath);
            const response = await fetch(`${this.baseUrl}${endpoint}`, {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json',
                    'KALSHI-ACCESS-KEY': this.keyId,
                    'KALSHI-ACCESS-SIGNATURE': signature,
                    'KALSHI-ACCESS-TIMESTAMP': timestamp.toString(),
                }
            });

            if (!response.ok) {
                const errorStr = await response.text();
                console.error(`[KalshiClient] getOpenPositions HTTP Error ${response.status}: ${errorStr}`);
                return [];
            }

            const data = await response.json();
            const positions = data.market_positions || data.positions || [];

            return positions
                .filter((p: any) => p.position !== 0)
                .map((p: any) => ({
                    ticker: p.ticker,
                    position: p.position,
                    market_exposure: p.market_exposure || 0,       // cents
                    fees_paid: p.fees_paid || 0,                   // cents
                    total_traded: p.total_traded || 0              // cents
                }));
        } catch (error: any) {
            console.error(`[KalshiClient] getOpenPositions error:`, error.message);
            return [];
        }
    }
}
