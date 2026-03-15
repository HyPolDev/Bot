const realLevels = [
    { price: 0.34, size: 53 },
    { price: 0.35, size: 146 }
];

const ghostMap = new Map<number, number>();

function applyGhostLiquidity(realLevels: any[] | undefined, ghostMap: Map<number, number>): any[] {
    if (!realLevels) return [];
    const adjusted = [];

    for (const level of realLevels) {
        const price = level.price;
        const realSize = level.size;
        const consumed = ghostMap.get(price) || 0;

        if (consumed > realSize) {
            ghostMap.set(price, realSize);
        }

        const remainingSize = realSize - ghostMap.get(price)!;
        console.log(`realSize: ${realSize}, ghostMapVal: ${ghostMap.get(price)}, remainingSize: ${remainingSize}`);

        if (remainingSize > 0) {
            adjusted.push({ price, size: remainingSize });
        }
    }
    return adjusted;
}

console.log("Testing applyGhostLiquidity bug:");
console.log(applyGhostLiquidity(realLevels, ghostMap));
