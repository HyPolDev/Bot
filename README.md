# Cross Exchange Prediction Market Arbitrage Engine
<img src="./resources/mosaic.png" alt="A mushroom-head robot drinking bubble tea" width="150" height="150" align="left" style="margin-right: 15px;">

A fully automated, market-neutral trading system designed to identify and execute statistical arbitrage opportunities across decentralized and traditional prediction markets (Polymarket & Kalshi). 

This project was built to apply university-level financial theory to real-world market microstructure, focusing heavily on rigorous risk management, capital efficiency, and automated portfolio rebalancing.

## 📌 Executive Summary
<img src="./resources/btc15screenshot.png" alt="A mushroom-head robot drinking bubble tea" width="320" height="320" align="right" style="margin-right: 55px;">
The core objective of this engine is **Capital Preservation and Risk-Free Yield Generation**. By simultaneously purchasing opposing contracts on disparate exchanges, the system locks in a guaranteed $1.00 payout at maturity for a combined cost of less than $1.00 and manages new opportunities to maximize capital velocity and annualized returns. Here is a brief summary of the full pipeline, from the market pairs discovery to the portfolio manager system:

At any given moment, there are over 20 billion possible market pairs between the two sites. The engine retrieves all markets from Kalshi and Polymarket, filtering them for desired properties (volume, liquidity, expiration date, etc.). It embeds these markets using a neural network to convert them into normalized semantic vectors and performs a vector search. Out of the 25 million possible pairs remaining after filtration, this search identifies the ones with the highest semantic similarity. This yields a sample small enough to use a Large Language Model (LLM) to judge whether the pairs are genuinely aligned—or inversely aligned. (Evaluated pairs are stored in a database to accelerate future iterations; running this discovery pipeline daily reduces the workload by ~90% and compute by ~70%).

LLMs are not infallible, and relying on AI decision-making to determine if two contracts represent the same market creates a bottleneck. Because our edge is typically a daily 2% of the invested capital (based on our tested sample) and we only find opportunities in 10-15% of the market pairs, we cannot afford an LLM error rate higher than 0.2%. Exceeding this threshold risks capital loss due to incorrect market selection. Currently, the LLM produces a false positive roughly 1 out of 750 times. This issue is further mitigated by a trigger warning that activates upon detecting "too much disparity" between markets, acting as a ban/kill switch.

Once the sample of market pairs is established, the engine opens WebSockets for all markets and creates pair manager instances. These instances identify opportunities and route them to the portfolio manager, which checks the size and price depth of the opportunity, associated fees, and market expiration. It also verifies minimum and maximum approved sizes, ensuring positions do not exceed portfolio risk limits. The system confirms available cash and fires the orders—first to Kalshi (its centralized order book allows for faster fill verification), and then to Polymarket. Following this, the anti-legging system intervenes to prevent one-legged positions caused by partial fills. If cash is insufficient, the system relies on a designated cash buffer, which holds the maximum amount permitted for a single trade. It evaluates whether the new opportunity yields a better return than existing positions (accounting for exit fees); if so, it uses the buffer to execute the order and subsequently liquidates the lowest-performing replaced positions upon confirmation.

## 🏦 Core Financial Mechanics

While the system handles complex asynchronous order routing, the underlying logic is built strictly on institutional portfolio management principles:

* **Dynamic Risk Scaling (Logarithmic Sizing):** Position sizing is dynamically calculated using a logarithmic curve based on total available equity. As the portfolio grows, the percentage of capital risked per trade mathematically scales down, preventing ruin and ensuring strict exposure limits.
* **Capital Velocity & Opportunity Cost:** The portfolio manager actively monitors open positions against new market opportunities. It calculates the exact "Switching Premium" (the absolute dollar cost of crossing the bid-ask spread to liquidate an active trade early) and only authorizes capital rotation if the new absolute yield mathematically clears the spread friction and a hardcoded alpha hurdle.
* **Market-Neutral Delta Hedging:** The execution engine utilizes anchored sequential legging. It fills the most illiquid exchange first, executing the secondary hedge immediately after. If an execution "orphans" (one side fills, the other fails), the system automatically triggers an emergency market-dump to flatten the directional delta and protect the portfolio.
* **Algorithmic Anomaly Quarantine:** To protect against "too-good-to-be-true" structural spreads or oracle halts, the system implements a volatility circuit breaker and quarantines massive statistical outliers for manual portfolio manager review.

## ⚙️ Technical Architecture Overview

This project is built in **TypeScript/Node.js** with a **MongoDB** persistence layer. It features a complete pipeline from machine-learning-driven market discovery (using transformer neural networks and LLMs for semantic matching) to real-time WebSocket order book monitoring and custom API execution clients.

For a deep dive into the system's asynchronous loops, database schema, and LLM verification logic, please refer to the [System Architecture Documentation](architecture.md).

## 🚀 Getting Started

1. Clone the repository and run `npm install`.
2. Configure your `.env` file with the required API keys and wallet addresses (see `architecture.md` for exact specifications).
3. Ensure a local or cloud instance of MongoDB is running.
4. Launch the live dashboard and execution engine via `ts-node src/index.ts`.

*(Note: The system includes a high-fidelity Paper Trading mode to simulate execution latency and order book sweeps without risking live capital, also the current 15 minute btc markets since those are by far the most atractive for demos).*
