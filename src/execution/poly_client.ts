import { ethers } from 'ethers';
import { ClobClient, Side, OrderType, SignatureType } from '@polymarket/clob-client';
import { ExecutionReceipt } from './types.js';
import dotenv from 'dotenv';
import { logger } from '../utils/logger.js';

dotenv.config();

export class PolyClient {
    private client: ClobClient;

    constructor() {
        let privateKey = process.env.POLY_PRIVATE_KEY || '0x00';
        if (!privateKey.startsWith('0x')) {
            privateKey = '0x' + privateKey;
        }

        const signer = new ethers.Wallet(privateKey);
        const proxyAddress = process.env.POLY_PROXY_ADDRESS;

        if (!proxyAddress) {
            logger.error("POLY_PROXY_ADDRESS is not defined in the .env file");
            throw new Error("POLY_PROXY_ADDRESS is not defined in the .env file");
        }

        const apiCreds = {
            key: process.env.POLY_API_KEY || '',
            secret: process.env.POLY_API_SECRET || '',
            passphrase: process.env.POLY_PASSPHRASE || ''
        };

        // You created the account via MetaMask, so it is strictly a GNOSIS_SAFE proxy
        this.client = new ClobClient(
            'https://clob.polymarket.com',
            137,
            signer,
            apiCreds,
            SignatureType.POLY_PROXY,
            proxyAddress
        );
    }

    public async getCollateralBalance(): Promise<number> {
        try {
            // ClobClient v5+ typically has getAllowance or similar. However, the exact API might differ. 
            // We can fetch the raw USDC Polygon ERC20 balance using ethers or if clob provides it directly.
            // Using 1rpc.io which successfully bypasses the ethers v5 network detection blocks
            const rpcUrl = "https://1rpc.io/matic";
            const provider = new ethers.providers.JsonRpcProvider(rpcUrl);

            let privateKey = process.env.POLY_PRIVATE_KEY || '0x00';
            if (!privateKey.startsWith('0x')) {
                privateKey = '0x' + privateKey;
            }
            const signer = new ethers.Wallet(privateKey);
            const proxyAddress = process.env.POLY_PROXY_ADDRESS;
            if (!proxyAddress) {
                logger.error("[PolyClient] POLY_PROXY_ADDRESS missing, returning 0 balance.");
                return 0;
            }

            // USDC on Polygon native contract
            const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
            const usdcAbi = ["function balanceOf(address owner) view returns (uint256)"];
            const usdcContract = new ethers.Contract(USDC_ADDRESS, usdcAbi, provider);

            const rawBalance = await usdcContract.balanceOf(proxyAddress);
            // USDC has 6 decimals
            const balanceUsd = parseFloat(ethers.utils.formatUnits(rawBalance, 6));

            return balanceUsd;
        } catch (error: any) {
            logger.error(`[PolyClient] getCollateralBalance error`, error.message);
            return 0; // Return safe default
        }
    }

    public async placeAggressiveLimit(tokenId: string, isEntry: boolean, size: number, maxVwap: number): Promise<ExecutionReceipt> {
        try {
            const signedOrder = await this.client.createOrder({
                tokenID: tokenId,
                price: maxVwap,
                side: (isEntry ? Side.BUY : Side.SELL) as Side,
                size: size,
                feeRateBps: 0
            });

            const response = await this.client.postOrder(signedOrder, OrderType.FAK);

            if (response.success) {
                return {
                    exchange: 'Polymarket',
                    status: 'filled',
                    orderId: response.orderID,
                    executedPrice: maxVwap,
                    executedSize: size
                };
            } else {
                const errorStr = response.errorMsg || JSON.stringify(response);
                if (errorStr.toLowerCase().includes('cancel') || errorStr.toLowerCase().includes('match') || errorStr.toLowerCase().includes('balance') || errorStr.toLowerCase().includes('fok') || errorStr.toLowerCase().includes('fill')) {
                    return {
                        exchange: 'Polymarket',
                        status: 'canceled',
                        orderId: response.orderID || 'unknown',
                        error: errorStr
                    };
                } else {
                    return {
                        exchange: 'Polymarket',
                        status: 'failed',
                        orderId: response.orderID || 'unknown',
                        error: errorStr
                    };
                }
            }

        } catch (error: any) {
            return {
                exchange: 'Polymarket',
                status: 'failed',
                error: error.message || 'Unknown network error'
            };
        }
    }

    public async placeMarketOrder(tokenId: string, isEntry: boolean, size: number): Promise<ExecutionReceipt> {
        try {
            // A market order generally uses OrderType.MARKET in clob-client.
            // The clob-client handles Market logic via FAK (Fill And Kill) or FOK 
            // combined with aggressive limit pricing.
            const signedOrder = await this.client.createOrder({
                tokenID: tokenId,
                price: isEntry ? 0.99 : 0.01,
                side: (isEntry ? Side.BUY : Side.SELL) as Side,
                size: size,
                feeRateBps: 0
            });

            const response = await this.client.postOrder(signedOrder, OrderType.FAK);

            if (response.success) {
                return {
                    exchange: 'Polymarket',
                    status: 'filled',
                    orderId: response.orderID,
                    executedPrice: 0, // Unknown precisely until we fetch fills, but market order executed
                    executedSize: size
                };
            } else {
                const errorStr = response.errorMsg || JSON.stringify(response);
                return {
                    exchange: 'Polymarket',
                    status: 'failed',
                    orderId: response.orderID || 'unknown',
                    error: errorStr
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

    public async getOpenPositions(): Promise<{ asset_id: string, size: number, avg_cost: number }[]> {
        try {
            const proxyAddress = process.env.POLY_PROXY_ADDRESS;
            if (!proxyAddress) {
                logger.error("[PolyClient] POLY_PROXY_ADDRESS missing, returning empty positions.");
                return [];
            }

            const res = await fetch(`https://data-api.polymarket.com/positions?user=${proxyAddress}`);
            if (!res.ok) {
                const errorStr = await res.text();
                logger.error(`[PolyClient] getOpenPositions HTTP Error ${res.status}: ${errorStr}`);
                return [];
            }

            const data = await res.json();
            if (Array.isArray(data)) {
                return data.map((p: any) => ({
                    asset_id: p.asset,
                    size: parseFloat(p.size),
                    avg_cost: parseFloat(p.avgPrice)
                }));
            }
            return [];
        } catch (error: any) {
            logger.error(`[PolyClient] getOpenPositions error`, error.message);
            return [];
        }
    }

    public async isMarketResolved(tokenId: string): Promise<boolean> {
        try {
            const res = await fetch(`https://gamma-api.polymarket.com/markets/${tokenId}`);
            if (!res.ok) return false;
            const data = await res.json();
            // In polymarket gamma API, 'closed' or 'active'==false often indicates resolution/stop trading
            return data.closed === true || data.active === false;
        } catch (error: any) {
            logger.error(`[PolyClient] isMarketResolved error`, error.message);
            return false;
        }
    }

    public async claimWinnings(conditionId: string): Promise<boolean> {
        try {
            logger.info(`[Polymarket] 💰 Redeeming on-chain CTF for condition: ${conditionId}...`);
            // as per user instructions:
            const tx = await (this.client as any).redeem(conditionId);

            if (tx && typeof tx.wait === 'function') {
                const receipt = await tx.wait();
                logger.info(`[Polymarket] ✅ Redeem confirmed in block: ${receipt.blockNumber}`);
            } else if (typeof tx === 'string' && tx.startsWith('0x')) {
                const rpcUrl = "https://1rpc.io/matic";
                const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
                const receipt = await provider.waitForTransaction(tx, 1);
                logger.info(`[Polymarket] ✅ Redeem confirmed in block ${receipt.blockNumber}`);
            } else {
                logger.info(`[Polymarket] ✅ Redeem response received:`, tx);
            }
            return true;
        } catch (error: any) {
            logger.error(`[Polymarket] ⚠️ Failed to redeem condition ${conditionId}`, error.message || error);
            return false;
        }
    }
}