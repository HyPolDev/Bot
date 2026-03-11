import mongoose, { Document, Schema } from 'mongoose';

export interface ISettings extends Document {
    isPaperTrading: boolean;
    expirationWindow: number; // in months
    vectorSearchThreshold: number; // between 0 and 1
    arbitrageCooldown: number; // in milliseconds
    simulatedLatency: number; // in milliseconds
    entryThreshold: number;
    exitThreshold: number;
}

const SettingsSchema = new Schema({
    isPaperTrading: { type: Boolean, required: true, default: true },
    expirationWindow: { type: Number, required: true, default: 6 },
    vectorSearchThreshold: { 
        type: Number, 
        required: true, 
        default: 0.9,
        min: 0,
        max: 1
    },
    arbitrageCooldown: { type: Number, required: true, default: 10000 },
    simulatedLatency: { type: Number, required: true, default: 1000 },
    entryThreshold: { type: Number, required: true, default: 0.98 },
    exitThreshold: { type: Number, required: true, default: 0.98 }
}, { 
    timestamps: true 
});

export const Settings = mongoose.model<ISettings>('Settings', SettingsSchema);
