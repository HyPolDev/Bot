import { ClobClient } from "@polymarket/clob-client";
import { Wallet } from "ethers";
import dotenv from 'dotenv';

dotenv.config();

async function generateKeys() {
    console.log("Authenticating with Polymarket...");

    // Grab the private key from your .env
    let privateKey = process.env.POLY_PRIVATE_KEY || "";
    if (!privateKey.startsWith('0x')) {
        privateKey = '0x' + privateKey;
    }

    // Initialize the signer
    const signer = new Wallet(privateKey);

    // Initialize the client WITHOUT credentials (because we are about to create them)
    const client = new ClobClient("https://clob.polymarket.com", 137, signer);

    try {
        console.log("Deriving L2 Trading Credentials...");

        // This asks the Polymarket server to generate your official trading keys
        const creds = await client.deriveApiKey();

        console.log(`\n✅ SUCCESS! Copy these EXACTLY into your .env file:\n`);
        console.log(`POLY_API_KEY="${(creds as any).key || (creds as any).apiKey}"`);
        console.log(`POLY_API_SECRET="${creds.secret}"`);
        console.log(`POLY_PASSPHRASE="${creds.passphrase}"\n`);

    } catch (error) {
        console.error("Failed to generate keys:", error);
    }
}

generateKeys();