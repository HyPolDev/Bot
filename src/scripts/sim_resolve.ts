import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
import { SimulatedPosition } from '../db/models/SimulatedPosition.js';
import { logger } from '../utils/logger.js';

dotenv.config();

async function run() {
    const pairId = process.argv[2];
    const winningPlatform = process.argv[3];

    if (!pairId || !winningPlatform || !['polymarket', 'kalshi'].includes(winningPlatform.toLowerCase())) {
        console.error("Usage: npm run sim:resolve <pairId> <polymarket|kalshi>");
        process.exit(1);
    }

    try {
        await mongoose.connect(process.env.MONGODB_URI as string);
        logger.info(`[SimResolve] Connected to MongoDB`);

        const pos = await SimulatedPosition.findOne({ pairId, state: 'open' });
        if (!pos) {
            logger.error(`[SimResolve] Open position with pairId ${pairId} not found.`);
            process.exit(1);
        }

        pos.state = 'settling';
        pos.simulatedWinner = winningPlatform.toLowerCase() as any;
        await pos.save();

        logger.info(`[SimResolve] ✅ Position ${pairId} marked as SETTLING.`);
        logger.info(`[SimResolve] 🏆 Simulated Winner: ${winningPlatform}`);
        logger.info(`[SimResolve] The SettlementManager will pick this up on its next Finalization Loop tick.`);
        
        process.exit(0);
    } catch (e) {
        console.error("Error connecting to DB or updating:", e);
        process.exit(1);
    }
}

run();
