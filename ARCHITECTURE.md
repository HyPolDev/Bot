# Arbitrager: Prediction Market Cross-Exchange Arbitrage Bot

A pipeline and execution engine that identifies, monitors, and automatically executes arbitrage opportunities between two major prediction markets: **Polymarket** and **Kalshi**. 

This system handles the entire lifecycle of an arbitrage trade: from discovering analogous markets using AI (Semantic Embeddings + Vector Search + LLM verification), to tracking their live order books via WebSockets, dynamically calculating execution risk and sizing, and concurrently firing Immediate-Or-Cancel (IOC) orders through custom API clients to lock in risk-free profit.

## 📋 Prerequisites

- Node.js 18+
- **MongoDB (Local or Atlas)**: Required for persistent pair storage and settings.
- OpenAI API Key of a funded account, 5$ should be enough.
- Funded Polymarket Wallet (Polygon USDC) via Gnosis Safe Proxy.
- Funded Kalshi Wallet (USD)
- API Keys for both platforms

## 🔧 Setup & Installation

### 1. Install Dependencies
```bash
npm install
```

### 2. Environment Variables (.env)
Create a `.env` file in the root directory and populate it with your API keys and wallet information:
```env
# Polymarket 
POLY_PRIVATE_KEY=your_private_key
POLY_PROXY_ADDRESS=your_gnosis_safe_proxy_address
POLY_API_KEY=your_gamma_api_key
POLY_API_SECRET=your_gamma_api_secret
POLY_PASSPHRASE=your_gamma_api_passphrase

# Kalshi
KALSHI_API_KEY=your_kalshi_key_id
KALSHI_PRIVATE_KEY=your_kalshi_private_key_string
# Alternatively, KALSHI_KEY_PATH=./path/to/key.txt

# Database
MONGODB_URI=mongodb://localhost:27017/arbitrager

# Engine Config
MAX_POSITION_SIZE=50
OPENAI_API_KEY=your_openai_key
```

### 3. Generate Trading Pairs (Discovery Pipeline)
You can run the entire discovery sequence manually or use the **Unified Discovery Script**:
```bash
# Recommended: Automatic sequential pipeline with selection prompt (LLM vs Manual)
bash src/test/test_discovery.sh
```

#### Manual Pipeline Steps:
1. **Fetch active markets**: `ts-node src/discovery/get_kalshimarkets.ts`, `ts-node src/discovery/get_polymarkets.ts`
2. **Normalize JSON schemas**: `ts-node src/discovery/etl_markets.ts`
3. **Semantic Matching**: `ts-node src/discovery/market_matcher.ts`
4. **Verification & DB Population**: `ts-node src/discovery/llm_checker.ts` (Auto) or `manual_checker.ts` (Human Verification)

### 4. Boot the Live Trading System
Once the database is populated, you can launch the live monitor and trading engine:
```bash
ts-node src/index.ts
```
The bot will connect to MongoDB, load any existing settings (e.g., `isPaperTrading`), and initialize the managers.

---

## 🏛️ System Architecture & Overarching Workflow

The system is divided into **four main modules**:
1. **Discovery (`src/discovery/`)**: Batch scripts that pull tens of thousands of markets, cross-reference them using machine learning algorithms, verify logic via LLMs, and output a strict list of `market_pairs.json`.
2. **Monitor (`src/monitor/`)**: Given the validated pairs, the system opens asynchronous WebSocket streams to both exchanges, maintaining a live local, latency-optimized Order Book. It scans every price delta for a Net Spread `> 0` after fees.
3. **Execution (`src/execution/`)**: A complex asynchronous trading engine that implements **Priority-Based Order Queueing**, **Anchored Sequential Legging** (Kalshi first), and automated **Emergency Delta Hedging** for orphaned fills.
4. **Portfolio (`src/portfolio/`)**: Manages the "Safety Floor" (Dynamic Buffer) and performs **Physical Auto-Restoration** to reconcile orphans.
5. **Persistence (`src/db/`)**: A robust MongoDB layer that ensures all trades, positions, and global settings survive system restarts and power failures.

---

## 📂 Codebase Documentation

Below is the absolute, granular detail of every file, class, and function in the `src/` directory, detailing exactly how they operate and interact.

### `src/index.ts`
The main bootloader and dependency injection container.
- **`sleep(ms)`**: Utility to pause execution, primarily used to stagger API requests to prevent Cloudflare blocks.
- **`bootSystem()`**: 
    1. Prompts for mode selection (updates the `Settings` model in DB).
    2. Initializes `DatabaseConnection.getInstance().connect()`.
    3. Fetches live balances if `LIVE`.
    4. Loads all verified pairs from the `MarketPair` MongoDB collection.
    5. Initializes the singletons: `PortfolioManager`, `RiskManager`, and `LiveEngine`.
    6. Iterates over market pairs, instantiating a `PairManager` for each. Staggers WebSocket handshakes by 200ms to respect rate limits.
    7. Starts the interactive `CLI` Dashboard.
- **`process.on('SIGINT')`**: Gracefully shuts down the `pmxt` server and exits when the user hits CTRL+C.

---

### 📂 `src/discovery/` (Market Sourcing Pipeline)

#### `src/discovery/get_kalshimarkets.ts`
Scrapes all Kalshi markets.
- **`getAllActiveKalshiMarkets()`**: Queries Kalshi's V2 REST API `/markets` endpoint using cursor-based pagination. Filters for `status="open"`. Safely checks the volume string and filters for `volume > 10000`. Drops duplicates by tracking `ticker` in a Set. Sorts the array descending by volume and saves to `data/kalshi_markets.csv` prioritizing key columns (ticker, title, volume).
- **`escapeCsv(val)`**: Inner function handling commas, quotes, and newlines in CSV cells.

#### `src/discovery/get_polymarkets.ts`
Scrapes all Polymarket markets.
- **`getAllActivePolymarketMarkets()`**: Queries Polymarket Gamma API (`/markets`) with offset-based pagination. Sorts by `id` to prevent pagination drift. Filters for `active=true` and `closed=false`. Filters out markets where `volume <= 100000`. Ensures unique IDs using a Set. Exports the resulting array to `data/polymarket_markets.csv`.

#### `src/discovery/etl_markets.ts`
Extracts, Transforms, and Loads the raw CSVs into a Unified Schema.
- **`containsBannedWords(text)`**: Uses Regex to look for banned words (e.g., "test", "dummy") provided in `blacklist.json`. If a rule or title triggers this, the market is dropped.
- **`escapeRegExp(string)`**: Inner utility to sanitize regex input.
- **`formatDate(isoString)`**: Converts assorted date formats into a strict `YYYY-MM-DD` string.
- **`parseCSV(filePath, mapper)`**: Initiates a piping stream using `csv-parser` and applies a mapper callback to each row.
- **`mapKalshi(row)`**: Implements the ETL schema conversion for Kalshi. Creates the `UnifiedMarket` object, generating a unified `embedding_text` string combining the question and expiration date.
- **`mapPolymarket(row)`**: Implements the ETL schema conversion for Polymarket. Carefully attempts a `JSON.parse` on the outcomes array, falling back to a raw string if it fails.
- **`runETL()`**: Executes `parseCSV` for both, outputs to `data/unified_markets.json`.

#### `src/discovery/market_matcher.ts`
Uses transformer neural networks to find matching pairs mathematically.
- **`MarketEntityMatcher.init()`**: Loads `Xenova/bge-small-en-v1.5` as a feature extraction Bi-Encoder and `Xenova/bge-reranker-base` as a Cross-Encoder natively via `@huggingface/transformers` using 8-bit quantization (`q8`).
- **`MarketEntityMatcher.dotProduct(vecA, vecB)`**: Calculates the cosine similarity between two normalized 1D vector arrays.
- **`MarketEntityMatcher.processAllMarkets()`**: 
    1. Feeds all string embeddings into the Bi-Encoder, appending a normalized embedding vector to the `UnifiedMarket` object.
    2. Splits arrays by platform. Iterates through Polymarkets, checking against every Kalshi market via dot product.
    3. Trims the shortlist to the `topK` matches above `initialThreshold`.
    4. Slices the embedding data out to save disk space and returns `CandidatePair`s.
- **`filterByExpirationWindow(pairs, maxMonthsAhead)`**: Drops pairs where the earliest expiration date is further out than `maxMonthsAhead` to keep capital velocity high.
- **`run()`**: Reads the unified JSON, instantiates the matcher, filters time horizons, and uses the `rankMarketsByScoreAndTime()` utility to output `candidate_market_groups.json`.

#### `src/discovery/llm_checker.ts`
Pings OpenAI format LLMs to deeply verify complex resolution logic.
- **`buildOpenAI()`**: Bootstraps the SDK, hard-failing if env variables are missing.
- **`askLLM()`**: Sends a structured, aggressively prompted system message to the LLM containing the exact text of both rulesets. Enforces strict JSON Schema extraction requiring the LLM to output an `alignment` integer of strictly `1` (identically resolved real-world event) or `0` (Derivative trap, subject mismatch, numerical threshold variance). Implements backoff retries for 429s.
- **`run()`**: Connects to the database. Executes `cleanupResolvedPairs()`, which pings the Gamma and Kalshi APIs to ensure cached pairs in the DB are still active. Then, it iterates through candidates, using the LLM to verify alignment. Verified matches are upserted into the `MarketPair` collection.

#### `src/discovery/manual_checker.ts`
A visual CLI tool to human-verify ML-matched pairs. Accepting a pair upscales it to the **`MarketPair`** MongoDB collection, making it available to the trading engine immediately.

---

### 📂 `src/monitor/` (Market Arbitrage Detection Loop)

#### `src/monitor/pair_manager.ts`
The core asynchronous nervous system. One instance exists per Trading Pair.
- **`isEvaluatingEntry` / `isEvaluatingTakeProfit`**: Atomic boolean locks that prevent concurrency loops. This ensures that while a trade is in its 1-second simulated latency window, the scanner cannot redundantly trigger the same entry/exit.
- **`constructor(pair, portfolio, risk, liveEngine)`**: Initializes instance globals, tracks Token IDs, and builds memory structures for `latestPolyBook`, `latestKalshiBook`, and an internal accounting mechanism called `ghostLiquidity`.
- **`start()`**: Fetches `clobTokenIds` from Polymarket REST using the internal ID. Instantiates a `PolymarketWS` and `KalshiWS`. Triggers their `.start()` connections. Provides callbacks to these WebSockets that intercept orderbook updates and instantly trigger `evaluateEntry()` and `evaluateAbsoluteTakeProfit()`.
- **`stop()`**: Gracefully terminates the associated WebSocket clients and detaches UI listeners to conserve system resources.
- **`attachViewer(callback) / detachViewer()`**: Allows the UI Dashboard to hook into the local state arrays to draw the order books in real-time on the terminal.
- **`applyGhostLiquidity(realLevels, ghostMap)`**: Mitigates "Double Spending" of paper trades locally. In paper mode, if the system "takes" liquidity, `ghostLiquidity` tracks it. This function receives the real API orderbook and strips out the size the bot pretends it already bought.
- **`getKalshiTakerFee(price, size)`**: Accurately calculates Kalshi's limit-taker fee formula (`0.07 * price * (1-price)`).
- **`calculateSweep(polyLevels, kalshiLevels, daysToExpiration, ...)`**: The core Arbitrage Math algorithm.
   1. Clones the L2 books. Iterates step-by-step, matching the overlapping depth between Polymarket and Kalshi.
   2. Entry Logic: Calculates net cost `poly + kal + kalshiFee`. If the combined cost to acquire both shares is `< $1.00`, it evaluates EAR against thresholds.
   3. **Per-Level EAR Gate**: Correctively re-models Kalshi's fees as the block grows, stopping the sweep if marginal liquidity degrades the EAR below the threshold.
   4. Enforces an `absoluteMax` size ceiling to respect the Risk Manager's bounds.
- **`evaluateEntry()`**: Checks the `isEvaluatingEntry` lock. Reads pair alignment (-1 or 1). Determines which Book Sides to cross.
- **`checkAndTriggerEntry(...)`**: Calls `calculateSweep`. If spread is profitable and meets minimum standards, it evaluates the **Dynamic Buffer**. If the trade is blocked by low operational cash, it invokes **Atomic Buffer Rebalancing**, requesting the `PortfolioManager` to nominate a liquidation target and queueing that "Sell" order immediately before the "Buy" to clear capital.
- **`executePaperEntry(...)`**: High-fidelity simulation. Re-evaluates sweeps after 1s latency using real orderbook data. To maintain simulation integrity between evaluation frames, it applies **Ghost Liquidity** (subtracting theoretical fills from the book) so that the next scan doesn't redundantly claim the same liquidity.
- **`evaluateAbsoluteTakeProfit()`**: Liquidates positions reaching the $1.00 net value target.
- **`forceKillPosition()`**: The executive override (Kill Switch). Skips all profit checks to dump the position at market price, bans the pair permanently, stops all WebSocket tracking, and **purges the document from MongoDB**.

---

### 📂 `src/execution/` (Live Order Routing)

#### `src/execution/types.ts`
Defines critical system interfaces:
- **`ExecutionPayload`**: Contains routing directions (`polyAssetId`, `kalshiSide`), limits (`kalshiMaxVwap`), and sizes.
- **`ExecutionReceipt`**: Standardized object returned by exchange clients indicating `status`, `orderId`, and executed specs.

#### `src/execution/live_engine.ts`
The core execution state machine. It manages trade entry/exit through an asynchronous lifecycle:
- **`queueOrder(payload)`**: Accepts trade targets from `PairManager` instances and adds them to an internal priority buffer.
- **`processQueue()` (Background Loop)**: Runs every 100ms. If the engine is idle and the 2.5s global cooldown has passed, it sorts the queue by **EAR (Expected Annualized Return)** and picks the absolute best opportunity.
- **Priority Sorting**: Ties in EAR are broken by **Available Liquidity**. To ensure freshness, the queue is **Auto-Flushed** after each execution — clearing all other stale opportunities before they can be redundantly traded.
- **`executeOrder(payload)`**: Implements **Anchored Sequential Legging**.
    1. **The Anchor leg**: Fires a trade on Kalshi first (the bottleneck exchange).
    2. **The Catch-up leg**: If Kalshi fills, it fires an aggressive market-take on Polymarket with a **trailing +2¢ slip buffer** to guarantee the hedge fills and prevent exposure.
- **`reconcile(...)`**: Identifies orphaned fills (one side full, one side failed) or partial fill mismatches.
- **`triggerEmergencyHedge()`**: If an orphan occurs, this asynchronous routine triggers a "Dump-at-Market" order to flat the directional delta and protect remaining capital.
- **Safety Locks**: If the engine detects **two consecutive orphans**, it triggers a **Fatal Safety Shutdown**, logging the error and crashing the process to prevent catastrophic capital failure.
- **`calculateKalshiTakerFee(price, size)`**: Accurate sub-routine calculating implied probability fee tiers on Kalshi.

#### `src/execution/poly_client.ts`
Communicates with the Polymarket Gamma API and Polygon Blockchain.
- **`constructor()`**: Loads `POLY_PRIVATE_KEY` and constructs an `ethers.Wallet`. Requires `POLY_PROXY_ADDRESS`. Initializes the `@polymarket/clob-client` SDK, specifically forcing `SignatureType.POLY_PROXY` required for Gnosis Safe proxy routing.
- **`getCollateralBalance()`**: Bypasses the CLOB SDK logic. Uses a hardcoded Polygon RPC (`1rpc.io`) to query the native `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174` (USDC) ERC20 smart contract `balanceOf(proxy)` directly via raw `ethers` reads.
- **`placeAggressiveLimit(tokenId, isEntry, size, maxVwap)`**: Prepares a signed EIP-712 payload via `createOrder()`. Specifies an aggressive limit price. Submits to `/order` API with `OrderType.FOK` (Fill-Or-Kill). Returns an `ExecutionReceipt`.

#### `src/execution/kalshi_client.ts`
Signs and fires strictly formatted requests to Kalshi's V2 REST endpoints.
- **`constructor()`**: Reads `KALSHI_API_KEY` and the raw text `KALSHI_PRIVATE_KEY`.
- **`sign(timestamp, method, path)`**: Replicates Kalshi's obscure validation rules. Performs a SHA-256 string combination, then creates a Base64 signature buffer using strictly `RSA_PKCS1_PSS_PADDING` and `RSA_PSS_SALTLEN_DIGEST` specifications.
- **`getBalance()`**: Issues an authenticated `GET` to `/portfolio/balance`. Divides the returned cents by 100 to cast as dollars.
- **`placeAggressiveLimit(ticker, side, isEntry, size, maxVwap)`**: Constructs the `POST` payload. Requires a manually generated UUID `client_order_id`. Specifies `time_in_force: immediate_or_cancel`. Translates the Float VWAP into strictly floored cents for Kalshi's matching engine. Parses the response for 'executed', 'canceled', catching partial IOC fills. Returns an `ExecutionReceipt`.

---

### 📂 `src/portfolio/` (State & Risk Management)

#### `src/portfolio/portfolio_manager.ts`
Centralized Global ledger and wallet repository.
- **`constructor(initialPoly, initialKalshi)`**: Takes snapshots of starting balances.
- **`getTotalEquity()`**: Returns Cash + Total Value of Open Positions at Cost.
- **`relinkRecoveredPositions(managers)`**: A recovery sub-routine that scans the Polymarket Proxy and Kalshi API for active positions *after* a system crash. It dynamically re-attaches them to the memory state, calculating entry costs from on-chain data.
- **`evaluateRelayRotation(newProfit, capitalNeeded)`**: Capital Efficiency Engine. If the bot finds a new opportunity but is out of cash, it evaluates if selling the "Worst" existing position is worth the friction. It calculates the `totalSwitchingCost` (Lost Profit + Spread Toll) and requires the new trade to beat a static `ALPHA_HURDLE` ($1.00) to prevent excessive churn.
- **`triggerBufferReplenishment(amountNeeded, risk)`**: The "Safety Floor" maintainer. If cash on either exchange drops below the `maxTradeBudget` (~$43 at $200 equity), this function identifies the least profitable positions and returns an **Atomic Liquidation Payload** to the manager, which is then prioritized in the execution queue to restore liquidity.
- **`openPosition(...)`**: Checks if the required costs exceed `polyCash` and `kalshiCash`. If `pairId` already exists, runs weighted average math to recalculate entry basis.
- **`closePosition(...)`**: Computes Realized PnL exactly. Restores Cash accurately. Mutates internal positions tracking to account for partial exits.
- **`logLedgerEvent()`**: Formats transaction costs, wallet balances, and PnL, appending to `portfolio_ledger.txt`.

#### `src/portfolio/risk_manager.ts`
Calculates logarithmic sizing thresholds to prevent capital ruin.
- **`calculateDynamicRisk(capital, rStart, rEnd)`**: A mathematical curve. If capital is `$50`, you risk `30%` per trade. If capital is `$5,000`, you risk `5%`. Computes the natural logarithm `Math.log()` to scale risk down as capital increases.
- **`calculateApprovedSize()`**:
    1. Base Size constraint: Divides the available liquidity spread by 2.
    2. Equity constraint: Calculates Maximum Dollar Budget allowed per trade and per pair, dividing budget by `costPerContract`.
    3. Wallet bottleneck check prevents issuing size mathematically larger than the poorest exchange can handle (respecting the **Safety Buffer**).
    4. Returns `Math.max(0, Math.min(finalSizeByRisk, maxSizeByCash))` as a rigid integer contract size limit.
- **`getMaxTradeBudget()`**: Returns the raw dollar amount required as a cash cushion per exchange.

---

### 📂 `src/cli/` (Interface layer)

#### `src/cli/dashboard.ts`
A terminal-based UI replacing console.log chaos.
- **`constructor()`**: Takes system managers. Configures `readline.emitKeypressEvents(process.stdin)` mapping for `RAW` mode keystroke listening. Binds a 1-second interval to `startRenderLoop()`.
- **`showMenu()`**: Transitions view state to HOME.
- **`setupKeyboardListeners()`**: Navigational router handling Up/Down increments, Enter keys, and 'B' for Back.
- **`renderHome()`**: Prints Global Equity, Wallet Breakdown, active positions.
- **`renderOrderbookList()`**: Uses array pagination logic (`PAGE_SIZE: 15`) with a cursor tracker to navigate market engines.
- **`viewManager(PairManager) / viewPositionLive()`**: Attach instant update listeners to specific engines.
- **`renderDashboard() / renderPositionLive()`**: Renders real-time L2 orderbooks and position entry details.
- **`renderKillConfirm()`**: The **Interactive Kill Switch** prompt. Draws a high-contrast danger overlay when `k` is pressed on a position, allowing the user to confirm a permanent liquidation and ban.

---

### 📂 `src/db/` (Persistence Layer)
All runtime state is stored in MongoDB to prevent data loss.
- **`MarketPair`**: Stores validated Polymarket/Kalshi pairs, their `outcomeAlignment`, and performance metrics.
- **`Settings`**: Global singleton (flags) storing `isPaperTrading`. Modifying this collection mid-run (via Atlas or MongoShell) can toggle engine safety flags.
- **`Position` / `SimulatedPosition`**: Tracks open arbitrage legs. `Position` maps to real on-chain assets; `SimulatedPosition` is used for paper trading.
- **`Trade` / `SimulatedTrade`**: Exhaustive audit logs of every buy/sell execution, including executed prices and exact exchange-timestamped receipts.
- **`connection.ts`**: Handles the Mongoose connection lifecycle and singleton pooling.

---

### 📂 `src/utils/`
- **`logger.ts`**: Provides `UnifiedLogger`, which performs synchronous writes to **`arbitrage.log`**.
- **`ranker.ts`**: Heuristic ranking for semantic candidates.

#### `src/utils/exchanges/polymarket_ws.ts`
Highly customized WebSocket Client for Polymarket's Gamma CLOB.
- **`connect()`**: Subscribes to `assets_ids`.
- **`stop()`**: Forcefully closes the connection and blocks the auto-reconnect logic.
- **`on('message')`**: Bypasses array/object inconsistencies in the Gamma API. Handles full-depth replacements vs dynamic delta changes.
- Implements `PING` interval handling to prevent silent timeouts.

#### `src/utils/exchanges/kalshi_ws.ts`
RSA-Signed Auth WebSocket for Kalshi V2 APIs.
- **`connect()`**: Generates `RSA_PKCS1_PSS` signatures natively to bypass firewalls.
- **`stop()`**: Forcefully closes the connection and blocks the auto-reconnect logic.
- **`emitUpdate()`**: Inverts Kalshi's "Bids-only" broadcast into a synthetic Level 2 orderbook (Asks = `1.00 - Opposing Bids`).

---

### 📂 `src/test/` (Testing Matrix)

- **`test_execution.ts`**: The most critical sanity check. Directly injects manual `Tokens` and `Tickers`, constructing a $0.01 limit price IOC execution simulating actual load testing on both REST APIs simultaneously. Validates Signature cryptography passes both API Firewalls explicitly.
- **`test_balances.ts`**: Verifies cross-chain reads in real-time pulling Polygon USDC using `ethers` alongside REST USD checks on Kalshi, validating system ledger integration capability.
- **`test_risk_math.ts`**: Iteratively iterates CLI logs mapping string interpolations of `$Capital -> %Risk` using the identical formulas in `RiskManager` to provide human validation of exponential curve functions.
- **`test_rpcs.ts`**: Performs heartbeat pinging to array-lists of different Polygon Node RPCs to dynamically locate the fastest Block response capable of surpassing the Cloudflare block threshold without hanging the main Thread. 
- **`test_discovery.sh`**: Bash abstraction automating sequential typescript module executions forming the initial pipeline stack.  Used to execute the discovery pipeline for mvp before being substituted for a live cicle

---
*Generated by the Arbitrager HFT Suite*
