import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

dotenv.config();

/* =====================================================
   🟢 CORE CONFIG
===================================================== */

const RPC_URL = "https://polygon-bor.publicnode.com";
const provider = new ethers.JsonRpcProvider(RPC_URL);

const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

// 🔐 REAL DEPLOYED ARB / VAULT CONTRACT
const ARB_CONTRACT = "0x2dD5820519aBbC74DB5658744e9EbAf9ED88320e";

// Tokens (examples)
const TOKENS = {
  LINK: "0x53E0bca35eC356BD5ddDFebbD1Fc0fD03FaBad39",
  AAVE: "0xD6DF932A45C0f255f85145f286eA0b292B21C90B",
  CRV:  "0x172370d5Cd63279eFa6d502DAB29171933a610AF"
};

const arbAbi = [
  "function executeArbitrage(address token,uint256 amount,uint256 minProfit,uint256 deadline) external",
  "function vaultBalance() view returns (uint256)"
];

const arb = new ethers.Contract(ARB_CONTRACT, arbAbi, wallet);

/* =====================================================
   🟢 SAFETY SETTINGS (CRITICAL)
===================================================== */

const JS_MIN_PROFIT = 0.00002;        // JS-side noise filter
const DEADLINE_BUFFER = 120;          // ⛔ prevents EXPIRED
const SCAN_DELAY_MS = 4000;           // continuous scan delay

const GAS = {
  gasLimit: 1_200_000,
  maxFeePerGas: ethers.parseUnits("80", "gwei"),
  maxPriorityFeePerGas: ethers.parseUnits("40", "gwei")
};

/* =====================================================
   🟢 UTILS
===================================================== */

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function shortHash(hash) {
  return `${hash.slice(0, 6)}...${hash.slice(-4)}`;
}

/* =====================================================
   🟢 MOCK PRICE DISCOVERY (REPLACE WITH REAL ROUTER LOGIC)
===================================================== */

async function simulateOnce() {
  // This simulates rotating opportunities
  const samples = [
    { token: "LINK", buy: "SushiSwap", sell: "QuickSwap", profit: 0.000240, trade: 50 },
    { token: "AAVE", buy: "QuickSwap", sell: "SushiSwap", profit: 0.000031, trade: 50 },
    { token: "CRV",  buy: "SushiSwap", sell: "QuickSwap", profit: 0.000182, trade: 50 }
  ];

  return samples;
}

/* =====================================================
   🟢 SCAN + EXECUTE
===================================================== */

async function scanAndExecute() {
  const routes = await simulateOnce();

  for (const r of routes) {
    console.log(
      `\n[SIM] ${r.token} ${r.buy}→${r.sell} profit:${r.profit.toFixed(6)}`
    );

    if (r.profit < JS_MIN_PROFIT) {
      console.log("⛔ SKIPPED (below JS min)");
      continue;
    }

    console.log(
      `✔ SIM PASSED → ${r.token} PROFIT ${r.profit.toFixed(6)}`
    );

    console.log(
      `🟢 EXECUTING ${r.token} PROFIT ${r.profit.toFixed(6)}`
    );

    try {
      const vaultBefore = await arb.vaultBalance();

      const deadline =
        Math.floor(Date.now() / 1000) + DEADLINE_BUFFER;

      const tx = await arb.executeArbitrage(
        TOKENS[r.token],
        ethers.parseUnits(r.trade.toString(), 6),
        ethers.parseUnits(r.profit.toString(), 6),
        deadline,
        GAS
      );

      console.log(`📤 TX SENT ${shortHash(tx.hash)}`);
      console.log("⏳ CONFIRMING...");

      const receipt = await tx.wait();

      if (receipt.status !== 1) {
        console.log("❌ TX FAILED");
        continue;
      }

      const vaultAfter = await arb.vaultBalance();
      const delta = vaultAfter - vaultBefore;

      console.log("✅ CONFIRMED");
      console.log(
        `🏦 VAULT BALANCE ${(Number(vaultAfter) / 1e6).toFixed(6)} USDC (+${(
          Number(delta) / 1e6
        ).toFixed(6)})`
      );

    } catch (e) {
      const msg = e.reason || e.message || "";

      if (msg.includes("EXPIRED")) {
        console.log("⏰ EXEC FAIL: DEADLINE EXPIRED");
      } else if (msg.includes("revert")) {
        console.log("🔁 EXEC FAIL: CONTRACT REVERT");
      } else {
        console.log("❌ EXEC FAIL:", msg);
      }
    }

    await sleep(1000); // spacing between executions
  }
}

/* =====================================================
   🟢 MAIN LOOP (CONTINUOUS SCANNING)
===================================================== */

async function main() {
  console.log("🚀 Arb bot started");

  while (true) {
    try {
      await scanAndExecute();
    } catch (e) {
      console.log("⚠️ LOOP ERROR:", e.reason || e.message);
    }

    console.log("\n⏱ waiting 4s...");
    await sleep(SCAN_DELAY_MS);
  }
}

main();
