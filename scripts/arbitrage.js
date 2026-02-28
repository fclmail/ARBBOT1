// aavePoolArbOptimizer.js
// ES module version for Node.js ("type": "module")
// Drop-in: simulate AAVE flash-loan arbitrage with liquidity display, optimization, and execution

import { ethers } from "ethers";

export class ProfitOptimizer {
  constructor(options) {
    this.fetchMarketData = options.fetchMarketData;
    this.simulateFlashLoan = options.simulateFlashLoan;
    this.executeFlashLoan = options.executeFlashLoan;
    this.displayDecimals = options.displayDecimals ?? 6;
    this.maxTrials = options.maxTrials ?? 60;
    this.healthFactorThreshold = options.healthFactorThreshold ?? 0;
    this.seedFactory = options.seedFactory ?? null;
    this.provider = options.provider ?? null;
  }

  formatUSDC(bn) {
    const factor = ethers.BigNumber.from(10).pow(this.displayDecimals);
    const whole = bn.div(factor).toString();
    const frac = bn.mod(factor).toString().padStart(this.displayDecimals, "0");
    const trimmed = frac.replace(/0+$/, "");
    return trimmed.length ? `${whole}.${trimmed}` : `${whole}`;
  }

  log(...args) {
    console.log(new Date().toISOString(), ...args);
  }

  async evaluate(seed, amount) {
    const data = await this.simulateFlashLoan(seed, amount);
    const {
      revenue = ethers.BigNumber.from(0),
      borrowCost = ethers.BigNumber.from(0),
      flashLoanFee = ethers.BigNumber.from(0),
      swapFees = ethers.BigNumber.from(0),
      slippageLoss = ethers.BigNumber.from(0),
      gasCost = ethers.BigNumber.from(0),
      otherFees = ethers.BigNumber.from(0),
      healthFactor = null
    } = data;

    const totalCosts = borrowCost
      .add(flashLoanFee)
      .add(swapFees)
      .add(slippageLoss)
      .add(gasCost)
      .add(otherFees);

    const NetProfit = revenue.sub(totalCosts);

    return {
      NetProfit,
      breakdown: { revenue, borrowCost, flashLoanFee, swapFees, slippageLoss, gasCost, otherFees, totalCosts },
      healthFactor,
      dataSnapshot: data
    };
  }

  async displayLiquidity(seed) {
    const market = await this.fetchMarketData(seed);
    const availableLiquidity = market?.availableLiquidity ?? ethers.BigNumber.from(0);
    this.log(`Available liquidity for seed '${seed}': ${this.formatUSDC(availableLiquidity)}`);
    return availableLiquidity;
  }

  async run(seed) {
    try {
      const availableLiquidity = await this.displayLiquidity(seed);
      if (availableLiquidity.isZero()) {
        this.log("No liquidity available for flash loan.");
        return { executed: false, reason: "No liquidity" };
      }

      let best = { NetProfit: ethers.BigNumber.from("-1"), amount: ethers.BigNumber.from(0), details: null };

      for (let i = 1; i <= this.maxTrials; i++) {
        const candidateAmount = availableLiquidity.mul(i).div(this.maxTrials);
        const evalResult = await this.evaluate(seed, candidateAmount);

        if (evalResult.NetProfit.gt(best.NetProfit) &&
            (evalResult.healthFactor ?? 1) >= this.healthFactorThreshold) {
          best = { NetProfit: evalResult.NetProfit, amount: candidateAmount, details: evalResult };
        }
      }

      if (best.NetProfit.lte(0)) {
        this.log("No profitable opportunity found.");
        return { executed: false, reason: "No profit" };
      }

      this.log(`Best candidate: amount ${this.formatUSDC(best.amount)} | NetProfit ${this.formatUSDC(best.NetProfit)}`);

      const execSeed = this.seedFactory ? this.seedFactory(seed, "execute", best.amount) : seed;
      this.log("Submitting executeFlashLoan with optimal amount...");
      await this.executeFlashLoan(execSeed, best.amount);

      this.log(`Execution completed for amount ${this.formatUSDC(best.amount)} with expected NetProfit ${this.formatUSDC(best.NetProfit)}`);

      return { executed: true, amount: best.amount, NetProfit: best.NetProfit, details: best.details };
    } catch (err) {
      this.log("Error in run:", err?.message ?? err);
      throw err;
    }
  }
}

// ===== Example adapters =====

export async function fetchMarketData(seed) {
  const availableLiquidity = ethers.BigNumber.from("10000000000"); // 10k USDC
  return { availableLiquidity };
}

export async function simulateFlashLoan(seed, amount) {
  const revenue = amount.mul(8).div(10000);       // 0.08%
  const borrowCost = amount.mul(1).div(1000);     // 0.1%
  const flashLoanFee = amount.mul(3).div(10000);  // 0.03%
  const swapFees = amount.mul(5).div(100000);     // 0.005%
  const slippageLoss = amount.mul(2).div(100000); // 0.002%
  const gasCost = ethers.BigNumber.from("15000");
  const otherFees = ethers.BigNumber.from(0);
  const healthFactor = 1.0;

  return { revenue, borrowCost, flashLoanFee, swapFees, slippageLoss, gasCost, otherFees, healthFactor };
}

export async function executeFlashLoan(seed, amount) {
  console.log("Executing on-chain flash loan for amount:", amount.toString(), "seed:", seed);
  // Example: await yourContract.executeFlashArbitrage(...)
}

export function seedFactory(seed, idx, amt) {
  const input = `${seed}:${idx}:${amt.toString()}`;
  return ethers.utils.keccak256(ethers.utils.toUtf8Bytes(input));
}

// ===== Example run =====
export async function runExample() {
  const optimizer = new ProfitOptimizer({
    fetchMarketData,
    simulateFlashLoan,
    executeFlashLoan,
    displayDecimals: 6,
    maxTrials: 60,
    healthFactorThreshold: 0,
    seedFactory
  });

  const seed = "demo-seed-001";

  await optimizer.displayLiquidity(seed);
  const result = await optimizer.run(seed);

  console.log("Optimization result:", {
    executed: result.executed,
    amount: result.amount?.toString(),
    NetProfit: result.NetProfit?.toString(),
    reason: result.reason
  });
}

// Run automatically if executed directly
if (process.argv[1].endsWith("aavePoolArbOptimizer.js")) {
  await runExample().catch(e => console.error("Error in runExample:", e));
}
