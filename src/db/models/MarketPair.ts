import mongoose, { Document, Schema } from 'mongoose';
import { UnifiedMarket } from '../../monitor/pair_manager.js';

export interface IMarketPair extends Document {
    pairId: string;
    kalshiMarket: UnifiedMarket;
    polyMarket: UnifiedMarket;
    score: number;
    outcomeAlignment: number;
    metrics: {
        last_updated: Date | null;
        s_history: {
            PolyYes_kalshiNo: number[];
            PolyNoKalshiYes: number[];
        };
        expected_annualized_return: number | null;
    };
}

const MarketPairSchema: Schema = new Schema({
    pairId: { type: String, required: true, unique: true },
    kalshiMarket: { type: Schema.Types.Mixed, required: true },
    polyMarket: { type: Schema.Types.Mixed, required: true },
    score: { type: Number, required: true },
    outcomeAlignment: { type: Number, required: true },
    metrics: {
        last_updated: { type: Date, default: null },
        s_history: {
            PolyYes_kalshiNo: { type: [Number], default: [] },
            PolyNoKalshiYes: { type: [Number], default: [] }
        },
        expected_annualized_return: { type: Number, default: null }
    }
}, {
    timestamps: true 
});

export const MarketPair = mongoose.model<IMarketPair>('MarketPair', MarketPairSchema);
