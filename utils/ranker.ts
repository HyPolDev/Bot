export interface RankedPair {
    polyMarket: any;
    kalshiMarket: any;
    score: number;
    finalRankScore?: number;
}

function extractDate(market: any): number {
    if (market?.expiration) {
        const time = new Date(market.expiration).getTime();
        if (!isNaN(time)) return time;
    }

    if (market?.embedding_text) {
        const match = market.embedding_text.match(/Expires:\s*(\d{4}-\d{2}-\d{2})/);
        if (match && match[1]) {
            const time = new Date(match[1]).getTime();
            if (!isNaN(time)) return time;
        }
    }

    return NaN;
}

function getClosestExpiry(pair: RankedPair, cutoff: number): number | null {
    const polyExp = extractDate(pair.polyMarket);
    const kalshiExp = extractDate(pair.kalshiMarket);

    const validExpiries: number[] = [];

    if (!isNaN(polyExp) && polyExp >= cutoff) validExpiries.push(polyExp);
    if (!isNaN(kalshiExp) && kalshiExp >= cutoff) validExpiries.push(kalshiExp);

    if (validExpiries.length === 0) return null;
    return Math.min(...validExpiries);
}

export function rankMarketsByScoreAndTime(
    pairs: RankedPair[],
    scoreWeight: number = 0.10,
    timeWeight: number = 0.90
): RankedPair[] {
    const NOW = Date.now();
    const todayCutoff = new Date().setHours(0, 0, 0, 0);

    let maxExpiration = 0;

    pairs.forEach(p => {
        const closestExpiry = getClosestExpiry(p, todayCutoff);
        if (closestExpiry !== null && closestExpiry > maxExpiration) {
            maxExpiration = closestExpiry;
        }
    });

    const rankedPairs = pairs.map(pair => {
        let normalizedTimeScore = 0;
        const closestExpiry = getClosestExpiry(pair, todayCutoff);

        if (closestExpiry !== null) {
            const timeToExpiry = Math.max(0, closestExpiry - NOW);
            const maxTimeToExpiry = Math.max(0, maxExpiration - NOW);

            if (maxTimeToExpiry > 0) {
                normalizedTimeScore = Math.max(0, 1 - (timeToExpiry / maxTimeToExpiry));
            } else if (maxTimeToExpiry === 0) {
                normalizedTimeScore = 1;
            }
        }

        const normalizedSimScore = pair.score || 0;
        const finalRankScore = (normalizedSimScore * scoreWeight) + (normalizedTimeScore * timeWeight);

        return {
            ...pair,
            finalRankScore
        };
    });

    return rankedPairs.sort((a, b) => b.finalRankScore! - a.finalRankScore!);
}