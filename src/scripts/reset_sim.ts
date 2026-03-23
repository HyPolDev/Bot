import { DatabaseConnection } from '../db/connection.js';
import { SimulatedPosition } from '../db/models/SimulatedPosition.js';
import { SimulatedTrade } from '../db/models/SimulatedTrade.js';
import { Settings } from '../db/models/Settings.js';
import mongoose from 'mongoose';

async function resetSimulation() {
    console.log("=================================================");
    console.log("          SIMULATION DATABASE RESET TOOL         ");
    console.log("=================================================");

    try {
        await DatabaseConnection.getInstance().connect();

        console.log("\n[1/3] Dropping Simulated Positions collection...");
        await SimulatedPosition.deleteMany({});
        console.log("      ✅ All simulated positions wiped.");

        console.log("\n[2/3] Dropping Simulated Trades ledger...");
        await SimulatedTrade.deleteMany({});
        console.log("      ✅ All simulated trades wiped.");


        console.log("\n=================================================");
        console.log("  🛑 RESET COMPLETE. YOU MAY NOW START THE BOT 🛑");
        console.log("=================================================\n");

    } catch (error) {
        console.error("❌ Reset script failed:", error);
    } finally {
        await DatabaseConnection.getInstance().disconnect();
        process.exit(0);
    }
}

resetSimulation();
