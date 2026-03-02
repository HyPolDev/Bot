import { ethers } from 'ethers';
import { ExecutionReceipt } from './types.js';

export class PolyClient {
    private readonly baseUrl: string = 'https://gamma-api.polymarket.com';
    private wallet: ethers.Wallet;
    private proxyWalletAddress: string;
    private chainId: number = 137; // Polygon Mainnet
    private exchangeContract: string = '0x4bFb41d5B3570DeFd03C39a9A4D8fE6bD8FCBce3'; // Standard CTF Exchange

    constructor() {
        const privateKey = process.env.POLY_PRIVATE_KEY || '0x0000000000000000000000000000000000000000000000000000000000000000';
        this.wallet = new ethers.Wallet(privateKey);
        this.proxyWalletAddress = process.env.POLY_PROXY_ADDRESS || this.wallet.address;
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
        // Standard Polymarket CLOB Order Types
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

    public async placeAggressiveLimit(tokenId: string, isEntry: boolean, size: number, maxVwap: number): Promise<ExecutionReceipt> {
        try {
            // Usually Polymarket represents shares and collateral in 6 decimals (USDC)
            // But if size is standard integer shares, we scale it.
            // Example: size = 10 (10 shares).
            // This implementation assumes Polymarket's Gamma API wrapper accepts these simplified fields,
            // while requiring an EIP-712 signature over a standard order or specific payload.
            // To ensure it works out of the box with the user's explicit payload:

            const payload = {
                token_id: tokenId,
                side: isEntry ? 'BUY' : 'SELL',
                size: size,
                price: maxVwap,
                order_type: 'FOK'
            };

            // Generating a standard EIP-712 signature over the Polymarket CLOB Order 
            // We map the simplified fields to the exact CLOB Order struct to be signed.
            const sideInt = isEntry ? 0 : 1; // 0 = BUY, 1 = SELL
            const salt = Math.floor(Math.random() * 1e12).toString();

            // Scaled values (assuming 6 decimals USDC)
            const sizeScaled = BigInt(size * 1e6);
            const collateralScaled = BigInt(Math.floor(size * maxVwap * 1e6));

            const makerAmount = isEntry ? collateralScaled : sizeScaled;
            const takerAmount = isEntry ? sizeScaled : collateralScaled;

            const orderStruct = {
                salt: salt,
                maker: this.proxyWalletAddress,
                signer: this.wallet.address,
                taker: '0x0000000000000000000000000000000000000000',
                tokenId: tokenId,
                makerAmount: makerAmount,
                takerAmount: takerAmount,
                expiration: 0, // FOK orders execute immediately
                nonce: 0,
                feeRateBps: 0,
                side: sideInt,
                signatureType: 0 // EOA signature
            };

            const signature = await this.wallet.signTypedData(this.getDomain(), this.getTypes(), orderStruct);

            // Send to Gamma API (assuming standard /orders endpoint for the proxy)
            const url = `${this.baseUrl}/orders`;
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    // Send the simplified payload requested by the spec
                    ...payload,
                    // Send the structured data & signature just in case it's required in body
                    order: orderStruct,
                    owner: this.proxyWalletAddress,
                    signature: signature
                })
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
                    error: `Unhandled status: ${data.status}`
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
