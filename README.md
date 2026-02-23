
# Arbitrage Market Finder

A TypeScript pipeline that identifies arbitrage opportunities between betting markets by matching markets from Polymarket and Kalshi using semantic embeddings and LLM verification.

## 🚀 Pipeline Overview

```
1. Data Collection
    ├─ get_kalshimarkets.ts → kalshi_markets.csv
    └─ get_polymarkets.ts → polymarket_markets.csv

2. ETL (Extract, Transform, Load)
    └─ etl_markets.ts → unified_markets.json

3. Market Matching (Semantic + Ranking)
    └─ market_matcher.ts → candidate_market_groups.json

4. LLM Verification
    └─ llm_checker.ts → market_pairs.json (final validated pairs)
```

## 📋 Prerequisites

- Node.js 18+
- Ollama (with Qwen 2.5 model)
- curl (for API calls)

## 🔧 Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Set Up Ollama & LLM

Run the provided setup script:

```bash
chmod +x setup/llm_setup.sh
./setup/llm_setup.sh
```

This automatically:
- Installs Ollama
- Downloads the `qwen2.5:7b` model
- Starts the Ollama server on `http://localhost:11434`

## 📊 Pipeline Stages

### Stage 1: Data Collection

**Files:** `get_kalshimarkets.ts`, `get_polymarkets.ts`

Fetches active markets from both platforms, filtering by volume > $10,000 USD:
- Uses cursor-based pagination (Kalshi) and offset-based pagination (Polymarket)
- Handles rate limiting and deduplication
- Outputs: `kalshi_markets.csv`, `polymarket_markets.csv`

### Stage 2: ETL Transformation

**File:** `etl_markets.ts`

Normalizes market data into a unified schema:
- Maps platform-specific fields to `UnifiedMarket` interface
- Combines rules and generates embedding text
- Outputs: `unified_markets.json`

### Stage 3: Semantic Matching

**File:** `market_matcher.ts`

Matches similar markets across platforms:
1. **Bi-Encoder (BGE-Small):** Generates embeddings for all markets
2. **Top-K Generation:** Finds top 3 candidates per market using cosine similarity
3. **Cross-Encoder Reranking:** Validates candidates with `bge-reranker-base`
4. **Ranking:** Scores by similarity and expiration date proximity

Outputs: `candidate_market_groups.json`

### Stage 4: LLM Verification

**File:** `llm_checker.ts`

Validates candidate pairs using Ollama (Qwen 2.5):
- Sends both market questions, rules, and dates to LLM
- Enforces strict logic (temperature: 0.0)
- Verifies semantic equivalence and resolution criteria match
- Outputs: `market_pairs.json` (final validated arbitrage pairs)

## 🏃 Running the Pipeline

Execute stages in order:

```bash
# 1. Fetch markets
ts-node get_kalshimarkets.ts
ts-node get_polymarkets.ts

# 2. Transform to unified schema
ts-node etl_markets.ts

# 3. Find similar markets
ts-node market_matcher.ts

# 4. Verify with LLM
ts-node llm_checker.ts
```

## 📁 Key Data Structures

### UnifiedMarket

```typescript
interface UnifiedMarket {
  internal_id: string;
  platform: 'polymarket' | 'kalshi';
  original_url_slug: string;
  volume_usd: number;
  market_question: string;
  market_rules: string;
  outcomes: string[];
  expiration: string;
  embedding_text: string;
  embedding?: number[];
}
```

### CandidatePair

```typescript
interface CandidatePair {
  polyMarket: UnifiedMarket;
  kalshiMarket: UnifiedMarket;
  score: number;
}
```

## 📌 Output Files

| File | Stage | Purpose |
|------|-------|---------|
| `kalshi_markets.csv` | Collection | Raw Kalshi market data |
| `polymarket_markets.csv` | Collection | Raw Polymarket data |
| `unified_markets.json` | ETL | Normalized market schema |
| `candidate_market_groups.json` | Matching | Ranked similar market pairs |
| `market_pairs.json` | LLM | Final validated arbitrage pairs |
