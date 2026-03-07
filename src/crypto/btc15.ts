import fs from 'fs';
import path from 'path';

export interface UnifiedMarket {
    internal_id: string;
    platform: string;
    original_url_slug: string;
    market_question: string;
    market_rules: string;
    volume_usd?: number;
    outcomes?: string[];
    expiration?: string;
    embedding_text?: string;
}

export interface CandidatePair {
    polyMarket: UnifiedMarket;
    kalshiMarket: UnifiedMarket;
    score: number;
    finalRankScore?: number;
    outcomeAlignment: 1 | -1;
}

export class Get15mMarketTickers {
    // Calculates the target strings
    private getTargetSlugs() {
        const now = new Date();
        const minuteFloor = Math.floor(now.getUTCMinutes() / 15) * 15;

        const currentWindowStart = new Date(Date.UTC(
            now.getUTCFullYear(),
            now.getUTCMonth(),
            now.getUTCDate(),
            now.getUTCHours(),
            minuteFloor,
            0, 0
        ));

        const currentWindowEnd = new Date(currentWindowStart.getTime() + 15 * 60000);

        // Poly Slug Logic (Uses Start Time)
        const polyCurrentTs = Math.floor(currentWindowStart.getTime() / 1000);
        const polySlug = `btc-updown-15m-${polyCurrentTs}`;

        // Kalshi Ticker Logic (Uses End Time)
        const formatKalshi = (date: Date): string => {
            const formatter = new Intl.DateTimeFormat('en-US', {
                timeZone: 'America/New_York',
                year: '2-digit', month: 'short', day: '2-digit',
                hour: '2-digit', minute: '2-digit', hour12: false,
            });
            const parts = formatter.formatToParts(date);
            const getPart = (type: string) => parts.find(p => p.type === type)?.value || '';

            const yy = getPart('year');
            const mmm = getPart('month').toUpperCase();
            const dd = getPart('day');
            let hh = getPart('hour');
            if (hh === '24') hh = '00';
            const mm = getPart('minute');

            return `KXBTC15M-${yy}${mmm}${dd}${hh}${mm}-${mm}`;
        };

        return {
            polySlug,
            kalshiTicker: formatKalshi(currentWindowEnd)
        };
    }

    // New Async method to fetch IDs and write the file
    public async generateAndSave(outputPath: string): Promise<boolean> {
        const slugs = this.getTargetSlugs();
        console.log(`[BTC-15] Target Poly Slug: ${slugs.polySlug}`);
        console.log(`[BTC-15] Target Kalshi Ticker: ${slugs.kalshiTicker}`);

        let polyInternalId = slugs.polySlug; // Fallback
        let polyVolume = 0;
        let polyQuestion = `15m BTC Up/Down (Poly: ${slugs.polySlug})`;

        // 1. Fetch live metadata from Polymarket Gamma API
        try {
            // FIX 1: Change 'market_slug' to 'slug'
            const res = await fetch(`https://gamma-api.polymarket.com/markets?slug=${slugs.polySlug}`);
            if (res.ok) {
                const data = await res.json();
                if (data && data.length > 0) {
                    const market = data[0];

                    // FIX 2: Extract ERC1155 Token IDs (Gamma API sometimes returns them as a JSON string)
                    const tokens = typeof market.clobTokenIds === 'string'
                        ? JSON.parse(market.clobTokenIds)
                        : market.clobTokenIds;

                    // Join them so you can pass both to your PolyWS later
                    polyInternalId = `${tokens[0]},${tokens[1]}`;

                    polyVolume = market.volume || 0;
                    polyQuestion = market.question || polyQuestion;
                    console.log(`[BTC-15] Normalization Success: Extracted Token IDs -> ${polyInternalId}`);
                } else {
                    console.log(`[BTC-15] Warning: Market not yet minted on Polymarket API. Using slug as fallback.`);
                }
            }
        } catch (err: any) {
            console.error(`[BTC-15] Failed to fetch Polymarket API:`, err.message);
        }

        // 2. Construct the normalized CandidatePair object
        const btcPair: CandidatePair = {
            polyMarket: {
                internal_id: polyInternalId,
                platform: "polymarket",
                original_url_slug: slugs.polySlug,
                market_question: polyQuestion,
                market_rules: "Auto-generated 15m testing timeframe",
                volume_usd: polyVolume,
                outcomes: ["Yes", "No"]
            },
            kalshiMarket: {
                internal_id: slugs.kalshiTicker, // Kalshi WebSocket natively accepts this string
                platform: "kalshi",
                original_url_slug: slugs.kalshiTicker,
                market_question: `15m BTC Up/Down (Kalshi: ${slugs.kalshiTicker})`,
                market_rules: "Auto-generated 15m testing timeframe",
                outcomes: ["Yes", "No"]
            },
            score: 0.995, // High arbitrary score to ensure it clears filters
            finalRankScore: 0.995,
            outcomeAlignment: 1
        };

        // 3. Write exactly to the requested path
        try {
            fs.writeFileSync(outputPath, JSON.stringify([btcPair], null, 2));
            return true;
        } catch (e: any) {
            console.error(`[BTC-15] Failed to write crypto pairs file:`, e.message);
            return false;
        }
    }
}