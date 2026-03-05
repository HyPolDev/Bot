function calculateSweep(
    polyLevels: any[], kalshiLevels: any[], isEntry: boolean, absoluteMax: number = Infinity
): { size: number, polyVwap: number, kalshiVwap: number, totalKalshiFees: number, polyConsumed: Map<number, number>, kalshiConsumed: Map<number, number> } {

    const polyConsumed = new Map<number, number>();
    const kalshiConsumed = new Map<number, number>();

    if (!polyLevels || !kalshiLevels || polyLevels.length === 0 || kalshiLevels.length === 0) {
        return { size: 0, polyVwap: 0, kalshiVwap: 0, totalKalshiFees: 0, polyConsumed, kalshiConsumed };
    }

    let pIdx = 0; let kIdx = 0;
    const pBook = polyLevels.map(l => ({ ...l }));
    const kBook = kalshiLevels.map(l => ({ ...l }));

    let totalShares = 0;
    let polyCost = 0;
    let kalshiCost = 0;
    let totalKalshiFees = 0;

    console.log("Starting while loop...");
    while (pIdx < pBook.length && kIdx < kBook.length && totalShares < absoluteMax) {
        const p = pBook[pIdx];
        const k = kBook[kIdx];

        console.log(`Checking match: Poly [${p.price} | size: ${p.size}] with Kalshi [${k.price} | size: ${k.size}]`);

        const kFeePerShare = 0.07 * k.price * (1 - k.price);

        if (isEntry) {
            const netCostPerShare = p.price + k.price + kFeePerShare;
            console.log(`Entry netCostPerShare: ${netCostPerShare} (Limit: 0.99)`);
            if (netCostPerShare >= 0.99) {
                console.log("Cost too high, breaking.");
                break;
            }
        } else {
            const netRevenuePerShare = p.price + k.price - kFeePerShare;
            console.log(`Exit netRevenuePerShare: ${netRevenuePerShare} (Limit: 0.99)`);
            if (netRevenuePerShare <= 0.99) {
                console.log("Revenue too low, breaking.");
                break;
            }
        }

        const overlap = Math.min(p.size, k.size);
        console.log(`Overlap size: ${overlap}`);
        if (overlap <= 0) break;

        let safeTake = Math.floor(overlap / 2);
        console.log(`Original safeTake: ${safeTake}`);
        safeTake = Math.min(safeTake, absoluteMax - totalShares);
        console.log(`Bounded safeTake: ${safeTake}`);

        if (safeTake <= 0) {
            console.log("safeTake <= 0, breaking loop. THIS MIGHT BE THE BUG!");
            break;
        }

        totalShares += safeTake;
        polyCost += safeTake * p.price;
        kalshiCost += safeTake * k.price;
        totalKalshiFees += kFeePerShare * safeTake;

        polyConsumed.set(p.price, (polyConsumed.get(p.price) || 0) + safeTake);
        kalshiConsumed.set(k.price, (kalshiConsumed.get(k.price) || 0) + safeTake);

        p.size -= overlap;
        k.size -= overlap;
        if (p.size <= 0) pIdx++;
        if (k.size <= 0) kIdx++;
    }

    console.log("While loop ended.");

    return {
        size: totalShares,
        polyVwap: totalShares > 0 ? polyCost / totalShares : 0,
        kalshiVwap: totalShares > 0 ? kalshiCost / totalShares : 0,
        totalKalshiFees,
        polyConsumed,
        kalshiConsumed
    };
}


const polyYesAsks = [
    { price: 0.34, size: 53 },
    { price: 0.35, size: 146 },
    { price: 0.36, size: 620 }
];

const kalshiNoAsks = [
    { price: 0.61, size: 818 },
    { price: 0.62, size: 703 },
    { price: 0.63, size: 1000 }
];

console.log("\n--- TEST ENTRY ---");
const res = calculateSweep(polyYesAsks, kalshiNoAsks, true, Infinity);
console.log(res);

