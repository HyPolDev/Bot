import { ethers } from 'ethers';
import { ClobClient, Side, OrderType, SignatureType } from '@polymarket/clob-client';
import { ExecutionReceipt } from './types.js';
import dotenv from 'dotenv';

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

    public async placeAggressiveLimit(tokenId: string, isEntry: boolean, size: number, maxVwap: number): Promise<ExecutionReceipt> {
        try {
            const signedOrder = await this.client.createOrder({
                tokenID: tokenId,
                price: maxVwap,
                side: (isEntry ? Side.BUY : Side.SELL) as Side,
                size: size,
                feeRateBps: 0
            });

            const response = await this.client.postOrder(signedOrder, OrderType.FOK);

            if (response.success) {
                return {
                    exchange: 'Polymarket',
                    status: 'filled',
                    orderId: response.orderID,
                    executedPrice: maxVwap,
                    executedSize: size
                };
            } else if (response.errorMsg?.toLowerCase().includes('cancel') || response.errorMsg?.toLowerCase().includes('match') || response.errorMsg?.toLowerCase().includes('balance') || response.errorMsg?.toLowerCase().includes('fok')) {
                return {
                    exchange: 'Polymarket',
                    status: 'canceled',
                    orderId: response.orderID || 'unknown',
                    error: response
                };
            } else {
                return {
                    exchange: 'Polymarket',
                    status: 'failed',
                    orderId: response.orderID || 'unknown',
                    error: response.errorMsg || 'Order failed to post'
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