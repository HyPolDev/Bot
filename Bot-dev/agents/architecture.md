# Arbitrager Architecture Documentation

This document explains the architecture and data flow of the `arbitrager` repository. This file serves as a reference for understanding how the core systems work together to identify and monitor prediction market arbitrage opportunities between Polymarket and Kalshi.

## System Overview

The project is divided into two distinct sub-systems:
1. **Discovery Pipeline (`src/discovery/`)**: An offline, sequential data pipeline that scrapes, normalizes, mathematically matches, and LLM-verifies candidate market pairs.
2. **Monitor Engine (`src/monitor/` & `src/index.ts`)**: A real-time, WebSocket-based engine that tracks live order books for validated market pairs and displays them in a terminal dashboard.

---

## 1. Discovery Pipeline

The discovery phase identifies arbitrage candidates by processing thousands of markets through a funnel of increasing strictness.

### Stage 1: Data Collection
**Scripts:** `get_kalshimarkets.ts`, `get_polymarkets.ts`
- Fetches active markets from Kalshi and Polymarket APIs.
- Applies initial filters: Only markets with significant volume (e.g., > $10,000 USD) are kept.
- **Output:** Raw platform-specific data saved to `data/kalshi_markets.csv` and `data/polymarket_markets.csv`.

### Stage 2: ETL (Extract, Transform, Load)
**Script:** `etl_markets.ts`
- Transforms the raw datasets into a standard shape: the `UnifiedMarket` interface.
- Normalizes internal IDs, URL slugs, outcomes, volume, and rules.
- Prepares a unified `embedding_text` property which concatenates the market question and rules in preparation for semantic search.
- **Output:** `data/unified_markets.json`.

### Stage 3: Semantic Matching
**Script:** `market_matcher.ts`
- Uses `@huggingface/transformers` to run local AI models. 
- **Bi-Encoder (`Xenova/bge-small-en-v1.5`)**: Maps the `embedding_text` of every market into a normalized high-dimensional vector space.
- Calculates mathematical similarity (dot product of normalized vectors, equivalent to Cosine Similarity) between Kalshi and Polymarket markets.
- For each Polymarket, the algorithm selects the Top-K most similar Kalshi markets meeting a strict baseline similarity threshold (e.g., > 0.82).
- Candidates are then ranked by a combination of similarity score and expiration date proximity via `src/utils/ranker.ts`.
- **Output:** `data/candidate_market_groups.json`.

### Stage 4: LLM Verification
**Script:** `llm_checker.ts`
- Runs a strict logical evaluation of the candidate pairs using a local LLM via Ollama (`qwen2.5:7b`, typically set up via `setup/llm_setup.sh`).
- Evaluates if the resolution criteria, dates, and market questions are truly equivalent and represent a genuine arbitrage opportunity.
- Drops structurally similar but contextually opposite/different markets. 
- **Output:** `data/market_pairs.json`, the conclusive list of verified, tradeable market pairs.

---

## 2. Monitor Engine

Once pairs are discovered and verified, they must be tracked in real-time to detect fleeting price dislocations.

### Bootstrapping (`src/index.ts`)
- The main entry point for the live application (`npm run test`).
- Loads the verified candidate pairs from the disk.
- Initializes a `PairManager` for each pair to be monitored.
- Instantiates the `CLI` to render the interactive terminal UI.

### The Pair Manager (`src/monitor/pair_manager.ts`)
- Responsible for the lifecycle and state of a single matched pair.
- Initializes two persistent WebSocket connections:
  - `PolymarketWS` (`src/utils/exchanges/polymarket_ws.ts`)
  - `KalshiWS` (`src/utils/exchanges/kalshi_ws.ts`)
- Maintains the latest `yes` and `no` order books (bids and asks) for both platforms.
- Emits UI update callbacks whenever the order book changes, allowing the CLI to rerender instantaneously. 
- *Note: In the future, the mathematical evaluation of the arbitrage spread (checking if Polymarket Bid > Kalshi Ask minus fees) will be triggered from within the `PairManager` upon book updates.*

### Terminal Engine (`src/cli/dashboard.ts`)
- Replaces standard browser/React frontends with a fast, text-based terminal dashboard.
- Hooks into the `PairManager`'s state. When an order book updates over WebSockets, the CLI redraws the specific market lines.
- Allows the user to navigate and inspect active markets in real-time.

---

## Data Structures at a Glance

### UnifiedMarket
```typescript
interface UnifiedMarket {
    internal_id: string;          // API ID for the market
    platform: string;             // 'polymarket' | 'kalshi'
    original_url_slug: string;    // Human readable slug
    volume_usd: number;
    market_question: string;
    market_rules: string;         // Used for LLM prompt and embedding
    outcomes: string[];
    expiration: string;
    embedding_text: string;       // Pre-computed string for Bi-Encoder
    embedding?: number[];         // Vector representation
}
```

### CandidatePair
```typescript
interface CandidatePair {
    polyMarket: UnifiedMarket;
    kalshiMarket: UnifiedMarket;
    score: number;                // Similarity from Market Matcher
    finalRankScore?: number;      // Metric combining similarity + exp. date
}
```

## Running the Complete System
If you need to restart from scratch, you run the stages sequentially:
1. `npm run setup` (Downloads Qwen2.5)
2. `npm run test-discovery` (Runs the 4 discovery stages)
3. `npm run test` (Hooks into WebSockets and starts the CLI)
