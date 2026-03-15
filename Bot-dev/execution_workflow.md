# Arbitrage Bot Execution Pseudocode



This document outlines the current step-by-step execution flow of the arbitrage bot, detailing how market data transforms into an executed trade (both simulated and live).



## 1. Data Ingestion & Spread Evaluation (`PairManager.ts`)



`PairManager` is the brain of each individual pair. It subscribes to WebSockets for both Kalshi and Polymarket using `KalshiWS` and `PolyWS`.



```typescript

function onOrderbookUpdate() {

// 1. WebSockets push new orderbook data to PairManager

// 2. Call evaluateSpreads()

}



function evaluateSpreads() {

// 1. Prevent execution if pair is currently cooling down (recent trade) or banned (recent error).

if (isCoolingDown || isBanned) return;



// 2. Check "Buy Yes Poly / Sell Yes Kalshi" spread

const spreadA = calculateSpread(poly.yes.asks, kalshi.yes.bids);

if (spreadA > ENTRY_THRESHOLD) {

triggerExecution(type: "PolyYes_KalshiNo", isEntry: true);

}



// 3. Check "Sell Yes Poly / Buy Yes Kalshi" (Exit condition if we hold the position)

if (holdsPosition("PolyYes_KalshiNo")) {

const exitSpreadA = calculateSpread(poly.yes.bids, kalshi.yes.asks);

if (exitSpreadA > EXIT_THRESHOLD) {

triggerExecution(type: "PolyYes_KalshiNo", isEntry: false);

}

}



// (Repeats logic for the inverted No Poly / Yes Kalshi state)

}



function triggerExecution(payload) {

if (Settings.isPaperTrading) {

if (payload.isEntry) executePaperEntry(payload);

else executePaperExit(payload);

} else {

LiveEngine.executeOrder(payload);

}

}

```



## 2. Simulated Execution (`PairManager.ts`)



When Paper Trading is ON, the `PairManager` bypasses `LiveEngine` entirely and simulates the delay and fill internally.



```typescript

async function executePaperEntry(payload) {

// 1. Lock execution to prevent spam

lockPair();



// 2. Simulate network latency (e.g. sleep 100ms)

await sleep(Settings.simulatedLatency);



// 3. Check Orderbooks AGAIN to see if the liquidity is still there after the delay

const currentLiquidity = recalculateLiquidity(payload.route);



if (currentLiquidity.isValid) {

// 4. Update Portfolio Memory and Save to Database (SimulatedPosition)

PortfolioManager.openPosition(

payload.pairId, size, polyPrice, kalshiPrice, fees

);



// 5. Append to the Database ledger

SimulatedTrade.create({

type: "buy", size, prices...

});

}



// 6. Apply cooldown before unlocking

unlockPairAfterCooldown();

}



// executePaperExit() does the exact same thing, but calls PortfolioManager.closePosition() and logs a 'sell' SimulatedTrade.

```



## 3. Live Physical Execution (`LiveEngine.ts`)



When Live Trading is ON, `LiveEngine` handles the physical API requests to the exchanges.



```typescript

async function executeOrder(payload) {

// 1. Lock execution using a semaphore/queue to prevent concurrent overlapping trades on same pair

acquireLock(payload.pairId);



try {

// 2. Fire simultaneous asynchronous requests to both exchanges

const [polyReceipt, kalshiReceipt] = await Promise.all([

PolyClient.placeAggressiveLimit(payload.polySide, payload.size, payload.maxPrice),

KalshiClient.placeOrder(payload.kalshiSide, payload.size, payload.maxPrice)

]);



// 3. Evaluate Results

const polyFilled = polyReceipt.status === 'filled';

const kalshiFilled = kalshiReceipt.status === 'filled';



if (polyFilled && kalshiFilled) {

// SUCCESSFUL HEDGE

const finalSize = Math.min(polyReceipt.size, kalshiReceipt.size);


// A. Update Physical Portfolio Tracker

if (payload.isEntry) {

PortfolioManager.openPosition(pairId, finalSize...);

} else {

PortfolioManager.closePosition(pairId, finalSize...);

}



// B. Write to the permanent Database Ledger

Trade.create({ type: 'buy|sell', size, prices... });



// C. Trigger a background network sync to fix any precision/fee drift

PortfolioManager.syncPositions();



} else if (!polyFilled && !kalshiFilled) {

// TOTAL MISS (Both failed or canceled due to slippage)

log("Missed Spread. Both canceled.");



} else {

// CRITICAL: ORPHANED LEG (One filled, one failed)

log("ORPHAN HEDGE EVENT!");


// A. Ban the pair from trading temporarily

PortfolioManager.banPair(payload.pairId, 10_MINUTES);



// B. Trigger Emergency Market Sell of the leg that successfully filled to limit exposure

if (polyFilled) triggerEmergencyHedge("Polymarket", ...);

if (kalshiFilled) triggerEmergencyHedge("Kalshi", ...);

}

} finally {

releaseLock(payload.pairId);

}

}



async function triggerEmergencyHedge(exchange, asset, size) {

// Spams market sell orders or FAK orders at terrible prices (e.g. $0.01)

// to guarantee the orphaned asset evaluates and dumps its bags immediately.

}

```



## 4. Physical Exchange API Clients (`poly_client.ts` & `kalshi_client.ts`)



These files serve as raw wrappers around the REST APIs to standardize inputs.



```typescript

// poly_client.ts

async function placeAggressiveLimit(side, size, maxVwap) {

// 1. Create Order payload

const order = ClobClient.createOrder({ side, size, price: maxVwap });

// 2. Sign cryptographically

const signed = signOrder(order);

// 3. Submit as Fill-And-Kill (FAK)

const res = await ClobClient.postOrder(signed, 'FAK');

// 4. Return unified ExecutionReceipt

return { status: res.success ? 'filled' : 'failed', ... }

}



// kalshi_client.ts

async function placeOrder(side, size, maxVwap) {

// 1. Calculate max affordable price taking into account Kalshi's fees

const priceWithFee = calculateFeeSlippage(maxVwap);

// 2. Submit REST API POST /portfolio/orders

const res = await HTTP.post('/orders', { side, count: size, max_price: priceWithFee });

// 3. Return unified ExecutionReceipt

return { status: res.success ? 'filled' : 'failed', ... }

}

```



## 5. Portfolio & Balance Tracking (`portfolio_manager.ts`)



PortfolioManager handles the state management block for the entire UI and simulation environment.



```typescript

function openPosition(pairId, size, polyPrice, kalshiPrice, kalshiFees) {

// 1. Check if we already hold this position

if (this.openPositions.has(pairId)) {

// 2a. Average down the cost basis and add the new size

pos.size += size;

pos.totalCost += newCost;


// Save to Database (if simulating)

persistSimulationOpen(pos);

return;

}



// 2b. Create new tracking object in memory

this.openPositions.set(pairId, { size, ... });


// 3. Deduct imaginary/real cash

this.polyCash -= polyCost;

this.kalshiCash -= kalshiCost;



// Save to Database (if simulating)

persistSimulationOpen(pos);

}



// Database Persistance Sub-Functions

async function persistSimulationOpen(pos) {

// Uses Mongoose `findOneAndUpdate` with `upsert: true` and Unique Indexes

// to safely push the memory state to MongoDB without creating race-condition duplicates.

SimulatedPosition.findOneAndUpdate({ pairId: pos.pairId }, pos, { upsert: true });

}

```