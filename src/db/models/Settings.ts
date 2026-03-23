import mongoose, { Document, Schema } from 'mongoose';

export interface ISettings extends Document {
    isPaperTrading: boolean;
    expirationWindow: number; // in months
    vectorSearchThreshold: number; // between 0 and 1
    arbitrageCooldown: number; // in milliseconds
    simulatedLatency: number; // in milliseconds
    minEarThreshold: number;  // minimum Expected Annualized Return to trigger entry (e.g. 0.15 = 15%)
    simulatedPolyCash: number;
    simulatedKalshiCash: number;
    totalRealizedPnL: number;
}

const SettingsSchema = new Schema({
    isPaperTrading: { type: Boolean, required: true, default: true },
    expirationWindow: { type: Number, required: true, default: 6 },
    vectorSearchThreshold: { type: Number, required: true, default: 0.9 },
    arbitrageCooldown: { type: Number, required: true, default: 10000 },
    simulatedLatency: { type: Number, required: true, default: 1000 },
    minEarThreshold: { type: Number, required: true, default: 0.20 },
    simulatedPolyCash: { type: Number, required: true, default: 1000 },
    simulatedKalshiCash: { type: Number, required: true, default: 1000 },
    totalRealizedPnL: { type: Number, required: true, default: 0 },
}, {
    timestamps: true
});

export const Settings = mongoose.model<ISettings>('Settings', SettingsSchema);
