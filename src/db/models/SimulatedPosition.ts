import mongoose, { Document, Schema } from 'mongoose';

export interface ISimulatedPosition extends Document {
    pairId: string;
    marketQuestion: string;
    state: 'open' | 'closed';
    type: string;
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
    marketQuestion: { type: String, required: true, default: "Simulated Market" },
    state: {
        type: String,
        enum: ['open', 'closed'],
        required: true
    },
    type: {
        type: String,
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

// Guarantee that only one "open" position can exist per pairId in the database, preventing race-condition duplicates
SimulatedPositionSchema.index(
    { pairId: 1, state: 1 }, 
    { unique: true, partialFilterExpression: { state: 'open' } }
);

export const SimulatedPosition = mongoose.model<ISimulatedPosition>('SimulatedPosition', SimulatedPositionSchema);
