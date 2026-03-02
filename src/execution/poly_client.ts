import { ethers } from 'ethers';
import * as crypto from 'crypto';
import { ExecutionReceipt } from './types.js';
import dotenv from 'dotenv';

dotenv.config();

export class PolyClient {
    private readonly baseUrl: string = 'https://clob.polymarket.com';
    private wallet: ethers.Wallet;
    private proxyWalletAddress: string;
    private chainId: number = 137;
    private exchangeContract: string = '0x4bfb41d5b3570defd03c39a9a4d8fe6bd8fcbce3';

    // API Keys for Server Auth
    private apiKey: string;
    private apiSecret: string;
    private apiPassphrase: string;

    constructor() {
        let privateKey = process.env.POLY_PRIVATE_KEY || '0x00';
        if (!privateKey.startsWith('0x')) {
            privateKey = '0x' + privateKey;
        }
        this.wallet = new ethers.Wallet(privateKey);
        this.proxyWalletAddress = process.env.POLY_PROXY_ADDRESS || this.wallet.address;

        this.apiKey = process.env.POLY_API_KEY || '';
        this.apiSecret = process.env.POLY_API_SECRET || '';
        this.apiPassphrase = process.env.POLY_PASSPHRASE || '';
    }

    private getDomain() {
        return {
            name: "Polymarket CTF Exchange",
            version: "1",
            chainId: this.chainId,
            verifyingContract: this.exchangeContract
        };
    }

    private getTypes() {
        return {
            Order: [
                { name: "salt", type: "uint256" },
                { name: "maker", type: "address" },
                { name: "signer", type: "address" },
                { name: "taker", type: "address" },
                { name: "tokenId", type: "uint256" },
                { name: "makerAmount", type: "uint256" },
                { name: "takerAmount", type: "uint256" },
                { name: "expiration", type: "uint256" },
                { name: "nonce", type: "uint256" },
                { name: "feeRateBps", type: "uint256" },
                { name: "side", type: "uint8" },
                { name: "signatureType", type: "uint8" }
            ]
        };
    }

    // Generates the HMAC signature required by the CLOB firewall
    private buildAuthHeaders(method: string, requestPath: string, body: string): Record<string, string> {
        const timestamp = Math.floor(Date.now() / 1000).toString();
        const message = timestamp + method + requestPath + body;

        // 1. Decode the secret into a buffer (standard base64)
        const secretBuffer = Buffer.from(this.apiSecret, 'base64');

        // 2. Generate the HMAC SHA256 signature (standard base64)
        const signature = crypto.createHmac('sha256', secretBuffer).update(message).digest('base64');

        // 3. EXACT HEADERS REQUIRED BY POLYMARKET (Notice the underscores!)
        return {
            'POLY_ADDRESS': this.proxyWalletAddress, // Must be the Proxy Wallet bound to the API Key
            'POLY_API_KEY': this.apiKey,
            'POLY_SIGNATURE': signature,
            'POLY_TIMESTAMP': timestamp,
            'POLY_PASSPHRASE': this.apiPassphrase,
            'Content-Type': 'application/json'
        };
    }

    public async placeAggressiveLimit(tokenId: string, isEntry: boolean, size: number, maxVwap: number): Promise<ExecutionReceipt> {
        try {
            const sideInt = isEntry ? 0 : 1; // 0 = BUY, 1 = SELL
            const salt = Math.floor(Math.random() * 1e12).toString();

            const sizeScaled = BigInt(size * 1e6);
            const collateralScaled = BigInt(Math.floor(size * maxVwap * 1e6));

            const makerAmount = isEntry ? collateralScaled.toString() : sizeScaled.toString();
            const takerAmount = isEntry ? sizeScaled.toString() : collateralScaled.toString();

            const orderStruct = {
                salt: salt,
                maker: this.proxyWalletAddress,
                signer: this.wallet.address,
                taker: '0x0000000000000000000000000000000000000000',
                tokenId: tokenId,
                makerAmount: makerAmount,
                takerAmount: takerAmount,
                expiration: 0,
                nonce: 0,
                feeRateBps: 0,
                side: sideInt,
                signatureType: 0
            };

            // 1. Sign the Smart Contract Payload
            let eip712Signature: string;
            // ethers v6 uses signTypedData
            if (typeof this.wallet.signTypedData === 'function') {
                eip712Signature = await this.wallet.signTypedData(this.getDomain(), this.getTypes(), orderStruct);
            } else {
                // ethers v5 shim if somehow imported
                eip712Signature = await (this.wallet as any)._signTypedData(this.getDomain(), this.getTypes(), orderStruct);
            }

            const payloadBody = JSON.stringify({
                order: orderStruct,
                owner: this.proxyWalletAddress,
                signature: eip712Signature,
                orderType: 'FOK'
            });

            // 2. Sign the Server API Headers
            const endpoint = '/order';
            const headers = this.buildAuthHeaders('POST', endpoint, payloadBody);

            const response = await fetch(`${this.baseUrl}${endpoint}`, {
                method: 'POST',
                headers: headers,
                body: payloadBody
            });

            if (!response.ok) {
                const errorStr = await response.text();
                return {
                    exchange: 'Polymarket',
                    status: 'failed',
                    error: `HTTP Error ${response.status}: ${errorStr}`
                };
            }

            const data = await response.json();
            const orderId = data.order_id || data.id || "poly-unknown-id";

            if (data.status === 'filled' || data.status === 'executed' || data.success) {
                return {
                    exchange: 'Polymarket',
                    status: 'filled',
                    orderId: orderId,
                    executedPrice: data.price || maxVwap,
                    executedSize: data.size || size
                };
            } else if (data.status === 'canceled' || data.error?.includes('canceled') || data.status === 'expired') {
                return {
                    exchange: 'Polymarket',
                    status: 'canceled',
                    orderId: orderId,
                    error: 'Order was canceled or not filled immediately (FOK)'
                };
            } else {
                return {
                    exchange: 'Polymarket',
                    status: 'failed',
                    orderId: orderId,
                    error: `Unhandled status: ${JSON.stringify(data)}`
                };
            }
        } catch (error: any) {
            return {
                exchange: 'Polymarket',
                status: 'failed',
                error: error.message || 'Unknown network error'
            };
        }
    }
}