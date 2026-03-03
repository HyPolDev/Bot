# Arbitrager: HFT Prediction Market Arbitrage Bot

A high-frequency trading (HFT) pipeline and execution engine that identifies, monitors, and automatically executes arbitrage opportunities between two major prediction markets: **Polymarket** and **Kalshi**. 

This system handles the entire lifecycle of an arbitrage trade: from discovering analogous markets using AI (Semantic Embeddings + LLM verification), to tracking their live order books via WebSockets, dynamically calculating execution risk and sizing, and concurrently firing Immediate-Or-Cancel (IOC) orders through custom API clients to lock in risk-free profit.

## 📋 Prerequisites

- Node.js 18+
- Ollama (running locally with the `Qwen 2.5` model for LLM verification)
- A funded Polymarket Wallet (Polygon USDC) controlled by a Gnosis Safe Proxy
- A funded Kalshi Wallet (USD)
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

# Engine Config
MAX_POSITION_SIZE=50
PAPER_TRADE=true # Set to false to enable live trading
OPENAI_API_KEY=your_openai_key # If using OpenAI API instead of local Ollama
```

### 3. Generate Trading Pairs (Discovery Pipeline)
To find markets to trade, you must run the discovery pipeline sequentially:
```bash
# 1. Fetch active markets from APIs
ts-node src/discovery/get_kalshimarkets.ts
ts-node src/discovery/get_polymarkets.ts

# 2. Normalize JSON schemas
ts-node src/discovery/etl_markets.ts

# 3. Use Bi-Encoder and Cross-Encoder to find semantic matches
ts-node src/discovery/market_matcher.ts

# 4. Use strict LLM logic to verify the pairs resolve identically
ts-node src/discovery/llm_checker.ts
# (Optional) Use src/discovery/manual_checker.ts to approve visually
```

### 4. Boot the Live Trading System
Once `data/market_pairs.json` is generated, you can launch the live monitor and trading engine:
```bash
ts-node src/index.ts
```
You will be prompted to select either **(1) Paper Simulation** or **(2) Live Deployment**.

---

## 🏛️ System Architecture & Overarching Workflow

The system is divided into **four main modules**:
1. **Discovery (`src/discovery/`)**: Batch scripts that pull tens of thousands of markets, cross-reference them using machine learning algorithms (Transformers.js), verify logic via LLMs, and output a strict list of `market_pairs.json`.
2. **Monitor (`src/monitor/`)**: Given the validated pairs, the system opens asynchronous WebSocket streams to both exchanges, maintaining a live local, latency-optimized Order Book. It scans every price delta for a Net Spread `> 0` after fees.
3. **Execution (`src/execution/`)**: A highly concurrent trading engine that fires simultaneous EIP-712 signed transactions to Polymarket and RSA-PSS signed requests to Kalshi, handling partial fills and emergency delta hedging.
4. **Portfolio (`src/portfolio/`)**: A global state manager that tracks live balances, tracks realized PnL, logs a transaction ledger, and dynamically adjusts sizing using logarithmic risk management algorithms.

---

## 📂 Exhaustive Codebase Documentation

Below is the absolute, granular detail of every file, class, and function in the `src/` directory, detailing exactly how they operate and interact.

### `src/index.ts`
The main bootloader and dependency injection container.
- **`sleep(ms)`**: Utility to pause execution, primarily used to stagger API requests to prevent Cloudflare blocks.
- **`bootSystem()`**: 
    1. Prompts the user for Paper or Live mode via the CLI (`process.stdin`).
    2. Modifies `process.env.PAPER_TRADE`.
    3. If Live, queries `PolyClient` and `KalshiClient` to fetch real wallet balances.
    4. Loads `data/market_pairs.json`.
    5. Initializes the singletons: `PortfolioManager`, `RiskManager`, and `LiveEngine`.
    6. Iterates over the market pairs, instantiating a `PairManager` for each. Staggers the WebSocket handshakes by 200ms.
    7. Starts the interactive CLI Dashboard (`CLI.showMenu()`).
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
- **`run()`**: Loads candidate groups, spins up concurrent asynchronous workers governed by `MAX_CONCURRENT_REQUESTS`. Renders a massive CLI progress bar. Writes verified pairs (having alignment = 1) to `data/market_pairs.json`.

#### `src/discovery/manual_checker.ts`
A backup utility script to do visual CLI checks of the paired markets before sending them to the execution queue. Renders Market A and Market B. Accepts `y`, `n`, or `q` prompts from the keyboard via `readline`.

---

### 📂 `src/monitor/` (Market Arbitrage Detection Loop)

#### `src/monitor/pair_manager.ts`
The core asynchronous nervous system. One instance exists per Trading Pair.
- **`constructor(pair, portfolio, risk, liveEngine)`**: Initializes instance globals, tracks Token IDs, and builds memory structures for `latestPolyBook`, `latestKalshiBook`, and an internal accounting mechanism called `ghostLiquidity`.
- **`start()`**: Fetches `clobTokenIds` from Polymarket REST using the internal ID. Instantiates a `PolymarketWS` and `KalshiWS`. Triggers their `.start()` connections. Provides callbacks to these WebSockets that intercept orderbook updates and instantly trigger `evaluateEntry()` and `evaluateExit()`.
- **`attachViewer(callback) / detachViewer()`**: Allows the UI Dashboard to hook into the local state arrays to draw the order books in real-time on the terminal.
- **`applyGhostLiquidity(realLevels, ghostMap)`**: Mitigates "Double Spending" of paper trades locally. In paper mode, if the system "takes" liquidity, `ghostLiquidity` tracks it. This function receives the real API orderbook and strips out the size the bot pretends it already bought, creating a localized pseudo-book.
- **`getKalshiTakerFee(price, size)`**: Accurately calculates Kalshi's limit-taker fee formula (`0.07 * price * (1-price)`).
- **`calculateSweep(polyLevels, kalshiLevels, isEntry, absoluteMax)`**: The core Arbitrage Math algorithm.
   1. Clones the L2 books. Iterates step-by-step, matching the overlapping depth between Polymarket Asks and Kalshi Asks (or Bids).
   2. Entry Logic: Calculates net cost `poly + kal + kalshiFee`. If the combined cost to acquire both Yes shares is `< $0.985`, it sweeps that size, tracking capital expenditure, VWAP, and consumed liquidity depths.
   3. Exit Logic: Calculates net revenue `polyBid + kalBid - kalshiFee`. If combined revenue is `> $0.97` (and higher than entry cost), it sweeps.
   4. Enforces an `absoluteMax` size ceiling to respect the Risk Manager's bounds.
- **`evaluateEntry()`**: Checks if `ARBITRAGE_COOLDOWN_MS` has passed. Reads the pair's `alignment` (-1 or 1). Determines which Book Sides to cross (e.g., PolyYes vs KalshiNo, or PolyYes vs KalshiYes for Flipped alignment). Feeds these into `checkAndTriggerEntry()`.
- **`checkAndTriggerEntry(type, polyAsks, kalshiAsks)`**: Calls `calculateSweep`. If spread is profitable, it calls `risk.calculateApprovedSize()`. If approved, it delegates Execution:
   - If `PAPER_TRADE_MODE`, triggers `executePaperTrade()`.
   - If Live, routes a highly typed JSON payload containing targets, maxVwaps, specific token paths, to `liveEngine.executeOrder()`.
- **`executePaperTrade(type, approvedSize, detectedSpread)`**: Simulates latency by awaiting `SIMULATED_LATENCY_MS`. Re-evaluates the sweep. If liquidity is gone, marks "MISSED". If still present, marks "CAPTURED", applies Ghost Liquidity, registers the position with `PortfolioManager`, and logs to `arbitrage_opportunities.txt`.
- **`evaluateExit()`**: Polled alongside evaluations. Consults the `PortfolioManager` to see if this `pairId` has an open Position. If so, retrieves target Bids, runs `calculateSweep(..., false)`, and triggers `liveEngine` or `executePaperExit()` if limit revenue exceeds entry cost per contract.
- **`executePaperExit()`**: Mirrors paper entry, validating revenue against the `totalCost / position.size` basis. Unloads ghost liquidity, closes portfolio position.

---

### 📂 `src/execution/` (Live Order Routing)

#### `src/execution/types.ts`
Defines critical system interfaces:
- **`ExecutionPayload`**: Contains routing directions (`polyAssetId`, `kalshiSide`), limits (`kalshiMaxVwap`), and sizes.
- **`ExecutionReceipt`**: Standardized object returned by exchange clients indicating `status`, `orderId`, and executed specs.

#### `src/execution/live_engine.ts`
Handles concurrent network racing and crisis management.
- **`executeOrder(payload)`**: Clamps size safety bounds. Initiates `Promise.all` allowing `PolyClient` and `KalshiClient` to fire network execution requests exactly simultaneously. Awaits receipt of both, then pushes them to `reconcile()`.
- **`reconcile(payload, polyReceipt, kalshiReceipt)`**: Parses receipt statuses.
    - **Success (Both filled)**: Extracts actual executed prices. Applies `calculateKalshiTakerFee`. Routes to `PortfolioManager.openPosition` or `.closePosition` logging the actual capital outlay.
    - **Missed (Both failed/canceled)**: Logs warnings, takes no action.
    - **ORPHANED LEG EVENT (One filled, one failed)**: Triggers severe alarms. Calls `triggerEmergencyHedge()` on the exchange that *did* fill.
- **`calculateKalshiTakerFee(price, size)`**: Accurate sub-routine calculating implied probability fee tiers on Kalshi.
- **`triggerEmergencyHedge(exchange, asset, originalEntry, size)`**: Uses `setImmediate` to keep the event loop unblocked. Reverses the trade polarity (if was buying, now selling), computes an extremely aggressive dump limit price ($0.01 / $0.99) and fires an IOC order to dump the unhedged delta instantly.

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
- **`constructor(initialPoly, initialKalshi)`**: Takes integer snapshots of starting balances.
- **`getTotalEquity()`**: Returns Cash + Total Value of Open Positions at Cost.
- **`openPosition(pairId, marketQuestion, type, size, polyPrice, kalshiPrice, kalshiFees)`**: Checks if the required costs exceed `polyCash` and `kalshiCash`. If `pairId` already exists natively, runs weighted average math to recalculate entries. Mutates internal balances instantly. Creates a tracking `Position` object including timestamp. Writes to the local ledger.
- **`closePosition(pairId, exitSize, polyExitPrice, kalshiExitPrice, kalshiExitFees)`**: Accepts exit sizes. Safely scales the exit size down if it exceeds the tracked `Position.size`. Computes Realized PnL exactly. Restores Cash accurately. Mutates internal positions tracking to account for partial exits. Emits a `CLOSE` event to `logLedgerEvent()`.
- **`logLedgerEvent()`**: Formats beautiful console/logfile strings outlining the transaction cost, wallet balances post-trade, size, and PnL, appending to `portfolio_ledger.txt`.

#### `src/portfolio/risk_manager.ts`
Calculates logarithmic sizing thresholds to prevent capital ruin.
- **`calculateDynamicRisk(capital, rStart, rEnd)`**: A mathematical curve. If capital is `$50`, you risk `30%` per trade. If capital is `$5,000`, you risk `5%`. Computes the natural logarithm `Math.log()` to draw an interpolation line scaling risk down as capital increases.
- **`calculateApprovedSize()`**:
    1. Base Size constraint: Divides the available liquidity spread by 2.
    2. Equity constraint calculates Maximum Dollar Budget allowed per trade and per pair, dividing budget by `costPerContract`.
    3. Wallet bottleneck check prevents issuing size mathematically larger than the poorest exchange can handle.
    4. Returns `Math.max(0, Math.min(finalSizeByRisk, maxSizeByCash))` as a rigid integer contract size limit.

---

### 📂 `src/cli/` (Interface layer)

#### `src/cli/dashboard.ts`
A terminal-based UI replacing console.log chaos.
- **`constructor()`**: Takes system managers. Configures `readline.emitKeypressEvents(process.stdin)` mapping for `RAW` mode keystroke listening. Binds a 1-second interval to `startRenderLoop()`.
- **`showMenu()`**: Transitions view state to HOME.
- **`setupKeyboardListeners()`**: Navigational router handling Up/Down increments, Enter keys, and 'B' for Back. Restores input state since the main loader paused it.
- **`renderHome()`**: Prints Global Equity, Wallet Breakdown, active positions.
- **`renderOrderbookList()`**: Uses array pagination logic (`PAGE_SIZE: 15`) with a cursor tracker to navigate available market engines. Renders Cyan terminal highlights via ANSI esc codes (`\x1b[36m`).
- **`viewManager(PairManager)`**: Re-routes instantly fired updates from a specific engine into `renderDashboard()`.
- **`renderDashboard()`**: Receives complete formatted orderbook maps. Generates string alignment columns, maps internal depths up to Ask 3 / Bid 3, properly formatting `$0.01` variants and large "k" representations for volume. Renders it dynamically over the same terminal rows using `\x1B[A` ANSI cursor clears.

---

### 📂 `src/utils/`

#### `src/utils/ranker.ts`
Mathematical formula script applying heuristic weights to discovered pairs.
- **`extractDate(market)`**: Helper trying to pull Expiration dates initially, failing back to Regex lookbehind matches on `embedding_text`.
- **`getClosestExpiry()`**: Logic pulling the nearest resolution timeframe between 2 markets.
- **`rankMarketsByScoreAndTime()`**: Loops arrays mapping expiration differences against `NOW()`. Normalizes Similarity max vectors (`0.0 to 1.0`). Applies predefined parameter coefficients (e.g. `scoreWeight = 0.8`, `timeWeight = 0.2`) and sorts the final list outputting a `finalRankScore`.

#### `src/utils/exchanges/polymarket_ws.ts`
Highly customized WebSocket Client for Polymarket's Gamma CLOB.
- **`connect()`**: Subscribes to `assets_ids`.
- **`on('message')`**: Bypasses array/object inconsistencies in Polymarket's data structure (`msg.event_type === 'book'` vs `price_change`). Correctly handles full-depth replacements vs dynamic insertion/deletion (`change.size === 0`). Packages internal `bids`/`asks` into sorted payload maps and triggers the Orchestrator's callback. 
- Implements `PING` interval handling to prevent silent timeouts.

#### `src/utils/exchanges/kalshi_ws.ts`
RSA-Signed Auth WebSocket for Kalshi V2 APIs.
- **`connect()`**: Generates `RSA_PKCS1_PSS` buffers natively, constructing `KALSHI-ACCESS-SIGNATURE` headers dynamically to bypass firewall drops. Subscribes to `"orderbook_delta"` on specific `outcomeId`.
- **`on('message')`**: Processes native `orderbook_snapshot`. Evaluates `orderbook_delta` replacing map depths (`currentSize + delta`). 
- **`emitUpdate()`**: Kalshi explicitly only broadcasts local Bids. This script contains mathematical inversion algorithms calculating implied Asks on the inverse token (`1.00 - price`) to correctly generate an array representing the true Level 2 Orderbook available to Takers. Emits final object to Orchestrator.

---

### 📂 `src/test/` (Testing Matrix)

- **`test_execution.ts`**: The most critical sanity check. Directly injects manual `Tokens` and `Tickers`, constructing a $0.01 limit price IOC execution simulating actual load testing on both REST APIs simultaneously. Validates Signature cryptography passes both API Firewalls explicitly.
- **`test_balances.ts`**: Verifies cross-chain reads in real-time pulling Polygon USDC using `ethers` alongside REST USD checks on Kalshi, validating system ledger integration capability.
- **`test_risk_math.ts`**: Iteratively iterates CLI logs mapping string interpolations of `$Capital -> %Risk` using the identical formulas in `RiskManager` to provide human validation of exponential curve functions.
- **`test_rpcs.ts`**: Performs heartbeat pinging to array-lists of different Polygon Node RPCs to dynamically locate the fastest Block response capable of surpassing the Cloudflare block threshold without hanging the main Thread. 
- **`test_discovery.sh`**: Bash abstraction automating sequential typescript module executions forming the initial pipeline stack.

---
*Generated by the Arbitrager HFT Suite*
