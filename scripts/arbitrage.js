import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

/* =====================================================
   🟢 CONFIG
===================================================== */

const RPC_URL = "https://polygon-bor.publicnode.com";
const provider = new ethers.JsonRpcProvider(RPC_URL);

const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

// --- Contracts ---
const ARB_CONTRACT = "0xYOUR_ARB_CONTRACT";
const USDC = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

const arbAbi = [
  "function executeArbitrage(address token,uint256 amount,uint256 minProfit,uint256 deadline) external",
  "function vaultBalance() view returns (uint256)"
];

const arb = new ethers.Contract(ARB_CONTRACT, arbAbi, wallet);

/* =====================================================
   🟢 EXECUTION SAFETY SETTINGS
===================================================== */

const JS_MIN_PROFIT = 0.00002;          // $0.00002 JS guard
const DEADLINE_BUFFER = 120;            // ⛔ REQUIRED (seconds)

const GAS = {
  gasLimit: 1_200_000,
  maxFeePerGas: ethers.parseUnits("80", "gwei"),
  maxPriorityFeePerGas: ethers.parseUnits("40", "gwei")
};

/* =====================================================
   🟢 MOCK PRICE DISCOVERY (replace with real router calls)
===================================================== */

async function simulateArb() {
  // Example: LINK SushiSwap → QuickSwap
  return {
    token: "LINK",
    tokenAddress: "0x53E0bca35eC356BD5ddDFebbD1Fc0fD03FaBad39",
    buyDex: "SushiSwap",
    sellDex: "QuickSwap",
    tradeAmount: 50, // USDC
    profit: 0.000240
  };
}

/* =====================================================
   🟢 MAIN ARB LOOP
===================================================== */

async function run() {
  console.log("🚀 Arb bot started\n");

  const sim = await simulateArb();

  console.log(
    `[SIM] ${sim.token} ${sim.buyDex}→${sim.sellDex} profit:${sim.profit.toFixed(6)}`
  );

  if (sim.profit < JS_MIN_PROFIT) {
    console.log("⛔ SKIPPED (below JS min profit)");
    return;
  }

  console.log(
    `✔ SIM PASSED → ${sim.token} PROFIT ${sim.profit.toFixed(6)}`
  );

  /* =====================================================
     🟢 EXECUTION
  ===================================================== */

  console.log(
    `🟢 EXECUTING ${sim.token} PROFIT ${sim.profit.toFixed(6)}`
  );

  const vaultBefore = await arb.vaultBalance();

  const deadline =
    Math.floor(Date.now() / 1000) + DEADLINE_BUFFER;

  const tx = await arb.executeArbitrage(
    sim.tokenAddress,
    ethers.parseUnits(sim.tradeAmount.toString(), 6),
    ethers.parseUnits(sim.profit.toString(), 6),
    deadline,
    GAS
  );

  console.log(`📤 TX SENT ${tx.hash.slice(0, 6)}...${tx.hash.slice(-4)}`);
  console.log("⏳ CONFIRMING...");

  const receipt = await tx.wait();

  if (receipt.status !== 1) {
    console.log("❌ TX FAILED");
    return;
  }

  const vaultAfter = await arb.vaultBalance();
  const delta = vaultAfter - vaultBefore;

  console.log("✅ CONFIRMED");
  console.log(
    `🏦 VAULT BALANCE ${(Number(vaultAfter) / 1e6).toFixed(6)} USDC (+${(
      Number(delta) / 1e6
    ).toFixed(6)})`
  );
}

/* =====================================================
   🟢 START
===================================================== */

run().catch((e) => {
  console.error("❌ EXEC FAIL:", e.reason || e.message);
});
