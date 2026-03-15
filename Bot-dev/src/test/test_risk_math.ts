// Test script to verify the logarithmic risk decay curves

export function calculateDynamicRisk(capital: number, rStart: number, rEnd: number): number {
    const C_min = 50;
    const C_max = 5000;

    if (capital <= C_min) return rStart;
    if (capital >= C_max) return rEnd;

    const lnC = Math.log(capital);
    const lnCmin = Math.log(C_min);
    const lnCmax = Math.log(C_max);

    return rStart + (rEnd - rStart) * ((lnC - lnCmin) / (lnCmax - lnCmin));
}

function runTests() {
    console.log("=========================================");
    console.log("      DYNAMIC RISK CURVE VALIDATION      ");
    console.log("=========================================");
    console.log("Capital    Trade Max %      Pair Max %   ");
    console.log("-----------------------------------------");

    const testCaps = [25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

    for (const c of testCaps) {
        const tradeRisk = calculateDynamicRisk(c, 0.30, 0.05) * 100;
        const pairRisk = calculateDynamicRisk(c, 0.30, 0.10) * 100;

        console.log(`$${c.toString().padEnd(8)} | ${tradeRisk.toFixed(2).padEnd(14)} | ${pairRisk.toFixed(2).padEnd(12)}`);
    }
    console.log("=========================================\n");
}

runTests();
