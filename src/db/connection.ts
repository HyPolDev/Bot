import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { logger } from '../utils/logger.js';

dotenv.config({ override: true });

export class DatabaseConnection {
    private static instance: DatabaseConnection;
    private isConnected: boolean = false;

    private constructor() {}

    public static getInstance(): DatabaseConnection {
        if (!DatabaseConnection.instance) {
            DatabaseConnection.instance = new DatabaseConnection();
        }
        return DatabaseConnection.instance;
    }

    public async connect(): Promise<void> {
        if (this.isConnected) {
            return;
        }

        const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/arbitrager';

        try {
            await mongoose.connect(uri);
            this.isConnected = true;
            logger.info('[DB] Successfully connected to MongoDB.');
        } catch (error) {
            logger.error('[DB] Error connecting to MongoDB:', error);
            throw error;
        }
    }

    public async disconnect(): Promise<void> {
        if (!this.isConnected) {
            return;
        }

        try {
            await mongoose.disconnect();
            this.isConnected = false;
            logger.info('[DB] Successfully disconnected from MongoDB.');
        } catch (error) {
            logger.error('[DB] Error disconnecting from MongoDB:', error);
            throw error;
        }
    }
}
