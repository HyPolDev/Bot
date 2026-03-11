import mongoose, { Document, Schema } from 'mongoose';

export interface ISimulatedTrade extends Document {
    pairId: string;
    marketQuestion: string;
    type: 'buy' | 'sell';
    polyQuantity: number;
    kalshiQuantity: number;
    averagePolyPrice: number;
    averageKalshiPrice: number; // For simulated scenarios, this represents the average filled VWAP inclusive of fee slip
    timestamp: Date;
}

const SimulatedTradeSchema: Schema = new Schema({
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

export const SimulatedTrade = mongoose.model<ISimulatedTrade>('SimulatedTrade', SimulatedTradeSchema);
