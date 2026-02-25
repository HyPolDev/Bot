# AGENT_ALIGNMENT.md
## Core Directives & Architectural Philosophy

**Target Audience:** Autonomous AI Agents, LLM Code Assistants, and Human Contributors.
**Project Lead:** Pol

### 1. The Prime Directive: "The Professor's Way of Proceeding"
All development on this repository must strictly adhere to a rigorous, academic, and highly methodical standard of engineering. 
* **Atomic Changes:** Never rewrite multiple systems at once. Isolate the variable, test the hypothesis, implement the fix, and verify.
* **Mathematical Precision:** We are building financial infrastructure. Floating-point errors, unhandled NaN values, or sloppy type coercions are critical failures. 
* **First Principles:** Do not blindly trust third-party wrappers. If an SDK (like `pmxtjs`) fails or obfuscates data, we bypass it and build native, mathematically sound integrations directly against the exchange's REST/WebSocket APIs.
* **Fail Loudly in Dev, Heal Silently in Prod:** Catch errors explicitly. Log exactly *why* a connection dropped, but ensure the system contains self-healing loops (e.g., WebSocket auto-reconnects) so the overall orchestrator never crashes.

---

### 2. Architectural Pillars: Strict Separation of Concerns
This system is designed for high-frequency arbitrage. Speed and scalability are paramount. The architecture is strictly decoupled into three layers:

#### A. The Headless Data Engines (`src/utils/exchanges/`)
* **Role:** Pure data ingestion. 
* **Rules:** These modules (e.g., `polymarket_ws.ts`, `kalshi_ws.ts`) must **never** contain UI logic, arbitrage math, or execution logic. 
* **Mechanism:** They maintain resilient WebSocket connections, parse exchange-specific formats (like Kalshi's deltas vs. Polymarket's absolute sizes), standardize the data into unified dual-sided orderbooks (Yes/No), and emit updates to the Orchestrator via callbacks.

#### B. The Orchestrator (`src/monitor/pair_manager.ts`)
* **Role:** The Brain. 
* **Rules:** It initializes the Data Engines for a specific market pair and holds the "Master State" (`latestPolyBook` and `latestKalshiBook`). 
* **Future State:** This is where the `EvaluateArbitrage()` engine will live. It will monitor the Master State, calculate cross-exchange spreads in real-time, and trigger execution modules when thresholds are met.

#### C. The UI / Viewers (`src/cli/dashboard.ts`)
* **Role:** Human observation.
* **Rules:** The UI is completely decoupled from the data pipeline. It simply attaches to a `PairManager` instance, reads the current state, and renders it. The UI can be killed or restarted without affecting the underlying WebSocket connections or trading logic.

---

### 3. Data Flow & Execution Philosophy
* **Data Retrieval:** We strictly use native WebSockets (`ws`) for live orderbook updates to minimize latency. REST polling is only used as a fallback or for initial token discovery.
* **Execution (Future):** While we bypass libraries like `pmxtjs` for data ingestion due to performance/reliability issues, we *will* utilize them (or similar heavily-audited libraries) strictly for their cryptographic execution capabilities (e.g., signing L1/L2 transactions, handling RSA-PSS padding). Data and Execution are separate pipelines.
* **Synchronization:** Polymarket and Kalshi handle data differently. Kalshi provides `orderbook_delta` events that must be mathematically merged (+/-). Polymarket provides absolute sizes. The Data Engines must abstract this complexity so the Orchestrator always receives a clean, standardized `Map<price, size>` for both platforms.

---

### 4. Development Rules for AI Agents
1. **Never break the abstraction layers.** Do not put `console.log` UI renders inside a WebSocket data handler.
2. **Preserve strict typing.** Use TypeScript interfaces for all exchange payloads. Do not default to `any` unless explicitly instructed during a rapid prototyping phase.
3. **Handle Geo-blocking & Auth gracefully.** Assume the host machine may face geo-restrictions or strict auth requirements (e.g., Kalshi's V2 RSA headers). Always ensure environment variables (`.env`) are correctly mapped and parsed before initiating connections.
4. **Optimize for O(1) Operations.** Orderbook updates happen hundreds of times per second. Use JavaScript `Map` objects for orderbooks (Price -> Size) to ensure O(1) updates and deletes, converting to sorted Arrays only when necessary for UI rendering or spread calculation.
