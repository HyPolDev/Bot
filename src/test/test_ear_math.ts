/**
 * test_ear_math.ts
 * Unit validation for the EAR (Expected Annualized Return) calculation pipeline.
 *
 * Run with: npx ts-node --esm src/test/test_ear_math.ts
 */

// ─── Pure helper functions mirroring pair_manager.ts logic ───────────────────

/**
 * Block-level Kalshi taker fee.
 * ceil() is applied ONCE to the full block, not per-contract.
 */
function kalshiBlockFee(price: number, size: number): number {
    return Math.ceil(0.07 * size * price * (1 - price) * 100) / 100;
}

/**
 * EAR = ((1 - totalCostBasis) / totalCostBasis) * (365 / safeDays)
 * where totalCostBasis = rawSpread + (blockFee / size)
 */
function calculateEAR(polyAsk: number, kalshiAsk: number, size: number, daysToExp: number): number {
    const rawSpread = polyAsk + kalshiAsk;
    if (rawSpread >= 1.00) return -Infinity; // pre-filter: can never profit

    const blockFee = kalshiBlockFee(kalshiAsk, size);
    const feePerShare = blockFee / size;
    const totalCostBasis = rawSpread + feePerShare;
    const netProfit = 1.00 - totalCostBasis;
    const safeDays = Math.max(daysToExp, 0.1);
    return (netProfit / totalCostBasis) * (365 / safeDays);
}

// ─── Test runner ──────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(label: string, condition: boolean, detail?: string) {
    if (condition) {
        console.log(`  ✅ PASS | ${label}`);
        passed++;
    } else {
        console.error(`  ❌ FAIL | ${label}${detail ? ` — ${detail}` : ''}`);
        failed++;
    }
}

function assertApprox(label: string, actual: number, expected: number, tolerance = 0.001) {
    const ok = Math.abs(actual - expected) <= tolerance;
    assert(label, ok, `expected ≈${expected.toFixed(4)}, got ${actual.toFixed(4)}`);
}

console.log('\n══════════════════════════════════════════════════════');
console.log('         EAR PIPELINE MATHEMATICAL VALIDATION         ');
console.log('══════════════════════════════════════════════════════\n');

// ─── Suite 1: Fee Formula Correctness ────────────────────────────────────────
console.log('Suite 1: Kalshi Block Fee (ceil on full block, not per-contract)\n');

// P=0.50 gives max variance P*(1-P) = 0.25; fee = ceil(0.07 * 100 * 0.25 * 100) / 100
const feeAt50 = kalshiBlockFee(0.50, 100);
assertApprox('Fee @P=0.50, size=100', feeAt50, Math.ceil(0.07 * 100 * 0.50 * 0.50 * 100) / 100);

// Block-level ceil vs per-contract accumulation must differ for fractional fees
const feeBlockLevel = kalshiBlockFee(0.30, 10);
const feePerContractAccumulated = Math.ceil(0.07 * 1 * 0.30 * 0.70 * 100) / 100 * 10;
assert(
    'Block-level ceil ≤ per-contract accumulated (no overestimation)',
    feeBlockLevel <= feePerContractAccumulated,
    `block=${feeBlockLevel.toFixed(4)}, per-contract×10=${feePerContractAccumulated.toFixed(4)}`
);

// Safety floor: P=0 → fee=0
assertApprox('Fee @P=0.00, size=50 → 0', kalshiBlockFee(0.00, 50), 0);

// ─── Suite 2: EAR Calculation ─────────────────────────────────────────────────
console.log('\nSuite 2: EAR Calculation Against Known Values\n');

// Case A: SHOULD TRIGGER  (polyAsk=0.45, kalshiAsk=0.48, size=1, days=30)
// rawSpread = 0.93, fee = ceil(0.07*1*0.48*0.52*100)/100 = ceil(1.7472)/100 = 0.02
// costBasis = 0.93 + 0.02 = 0.95, netProfit = 0.05, EAR = (0.05/0.95)*(365/30) ≈ 0.6404
const earA = calculateEAR(0.45, 0.48, 1, 30);
assertApprox('EAR (poly=0.45, kalshi=0.48, days=30)', earA, (0.05 / 0.95) * (365 / 30), 0.005);
assert('Should trigger (EAR > 0.15)', earA > 0.15, `EAR=${earA.toFixed(4)}`);

// Case B: SHOULD NOT TRIGGER (polyAsk=0.48, kalshiAsk=0.50, size=1, days=365)
// rawSpread = 0.98, fee = ceil(0.07*1*0.50*0.50*100)/100 = ceil(1.75)/100 = 0.02
// costBasis = 0.98 + 0.02 = 1.00, netProfit = 0.00 → EAR = 0
const earB = calculateEAR(0.48, 0.50, 1, 365);
assert('Should NOT trigger when rawSpread=0.98 + fee >= 1.00', earB <= 0.15, `EAR=${earB.toFixed(4)}`);

// Case C: Safety floor (daysToExp = 0 → clamp to 0.1)
const earC = calculateEAR(0.45, 0.48, 1, 0);
assert('Safety floor: daysToExp=0 does not throw or return Infinity', isFinite(earC), `EAR=${earC}`);
assert('Safety floor: EAR is large but finite', earC > 0 && earC < 1e6, `EAR=${earC.toFixed(0)}`);

// Case D: Pre-filter — combined ask >= 1.00
const earD = calculateEAR(0.55, 0.50, 1, 30);
assert('Pre-filter: combined ask >= 1.00 → -Infinity', earD === -Infinity);

// ─── Suite 3: Per-level EAR degradation as block size grows ──────────────────
console.log('\nSuite 3: Marginal EAR Degradation With Block Size\n');

// As size grows, blended fee grows sublinearly due to single ceil, so EAR should be stable or improve.
// But at extremes (far OTM), check that larger blocks correctly compute lower fees than per-contract sum.
const earSmall = calculateEAR(0.45, 0.48, 1, 30);
const earLarge = calculateEAR(0.45, 0.48, 500, 30);
// Both should trigger; large block should have slightly better EAR (lower fee per share via single ceil)
assert('Large block EAR ≥ single-contract EAR (ceil dilution benefit)', earLarge >= earSmall - 0.01,
    `small=${earSmall.toFixed(4)}, large=${earLarge.toFixed(4)}`);

// ─── Summary ──────────────────────────────────────────────────────────────────
console.log('\n══════════════════════════════════════════════════════');
console.log(`RESULTS: ${passed} passed, ${failed} failed`);
console.log('══════════════════════════════════════════════════════\n');

if (failed > 0) process.exit(1);
