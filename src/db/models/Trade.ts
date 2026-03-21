import mongoose, { Document, Schema } from 'mongoose';

export interface ITrade extends Document {
    pairId: string;
    marketQuestion: string;
    type: 'buy' | 'sell';
    polyQuantity: number;
    kalshiQuantity: number;
    averagePolyPrice: number;
    averageKalshiPrice: number; // Note: For real Kalshi trades, this includes fees in the application logic
    timestamp: Date;
}

const TradeSchema: Schema = new Schema({
    pairId: { type: String, required: true, index: true },
    marketQuestion: { type: String, required: true },
    type: {
        type: String,
        enum: ['buy', 'sell'],
        required: true
    },
    polyQuantity: { type: Number, required: true },
    kalshiQuantity: { type: Number, required: true },
    averagePolyPrice: { type: Number, required: true },
    averageKalshiPrice: { type: Number, required: true },
    timestamp: { type: Date, required: true, default: Date.now }
}, {
    timestamps: true
});

export const Trade = mongoose.model<ITrade>('Trade', TradeSchema);
