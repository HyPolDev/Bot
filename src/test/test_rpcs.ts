import { ethers } from 'ethers';

async function testRPCs() {
    const rpcs = [
        "https://polygon-rpc.com/",
        "https://rpc-mainnet.maticvigil.com/",
        "https://rpc.ankr.com/polygon",
        "https://polygon-mainnet.infura.io",
        "https://poly-rpc.gateway.pokt.network",
        "https://1rpc.io/matic"
    ];

    for (const rpc of rpcs) {
        try {
            console.log(`Testing ${rpc}...`);
            const provider = new ethers.providers.JsonRpcProvider(rpc);
            const block = await provider.getBlockNumber();
            console.log(`✅ ${rpc} - Block: ${block}`);
        } catch (e: any) {
            console.log(`❌ ${rpc} - Error: ${e.message}`);
        }
    }
}

testRPCs();
