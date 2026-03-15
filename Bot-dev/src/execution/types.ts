export interface ExecutionPayload {
    pairId: string;
    marketQuestion: string;
    tradeType: string; // e.g. 'PolyYes_KalshiNo' | 'PolyNo_KalshiYes'
    targetSize: number;
    polyAssetId: string;       // The specific token ID to buy/sell
    kalshiTicker: string;      // The specific market ticker
    kalshiSide: 'yes' | 'no';  // Added mapping for Kalshi trade direction
    polyMaxVwap: number;       // e.g., 0.45
    kalshiMaxVwap: number;     // e.g., 0.52
    isEntry: boolean;          // true = BUY, false = SELL
    expectedEAR?: number;      // Expected Annualized Return for queue priority ranking
    availableLiquidity?: number; // Orderbook depth for ranking
    expiringDate?: any;
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
