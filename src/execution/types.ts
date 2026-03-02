export interface ExecutionPayload {
    pairId: string;
    tradeType: string; // e.g. 'PolyYes_KalshiNo' | 'PolyNo_KalshiYes'
    targetSize: number;
    polyAssetId: string;       // The specific token ID to buy/sell
    kalshiTicker: string;      // The specific market ticker
    polyMaxVwap: number;       // e.g., 0.45
    kalshiMaxVwap: number;     // e.g., 0.52
    isEntry: boolean;          // true = BUY, false = SELL
}

export type ExecutionStatus = 'filled' | 'canceled' | 'failed';

export interface ExecutionReceipt {
    exchange: 'Polymarket' | 'Kalshi';
    status: ExecutionStatus;
    executedPrice?: number;
    executedSize?: number;
    orderId?: string;
    error?: string;
}
