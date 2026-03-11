import mongoose, { Document, Schema } from 'mongoose';

export interface ISimulatedPosition extends Document {
    pairId: string;
    state: 'open' | 'closed';
    type: 'YesPoly_NoKalshi' | 'NoPoly_YesKalshi';
    averagePolyPrice: number;
    polymarketQuantity: number;
    averageKalshiPrice: number;
    kalshiQuantity: number;
    exitFees: number;
    expiringDate: Date;
    expectedAnnualizedReturn?: number;
}

const SimulatedPositionSchema: Schema = new Schema({
    pairId: { type: String, required: true },
    state: {
        type: String,
        enum: ['open', 'closed'],
        required: true
    },
    type: {
        type: String,
        enum: ['YesPoly_NoKalshi', 'NoPoly_YesKalshi'],
        required: true
    },
    averagePolyPrice: { type: Number, required: true },
    polymarketQuantity: { type: Number, required: true },
    averageKalshiPrice: { type: Number, required: true },
    kalshiQuantity: { type: Number, required: true },
    exitFees: { type: Number, required: true, default: 0 },
    expiringDate: { type: Date, required: true },
    expectedAnnualizedReturn: { type: Number, required: false }
}, {
    timestamps: true
});

export const SimulatedPosition = mongoose.model<ISimulatedPosition>('SimulatedPosition', SimulatedPositionSchema);
