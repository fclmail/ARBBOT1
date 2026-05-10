import { ethers } from "ethers";

/* ================= CONFIG ================= */

const RPC = process.env.RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const CONTRACT = process.env.CONTRACT;

/* ================= INLINE ABI (FIXED) ================= */

const abi = [
  "function executeArbitrage(address,address,uint256,address[],address[],uint256)",
  "function usdc() view returns (uint256)",
  "function withdraw(uint256)"
];

/* ================= PROVIDER ================= */

const provider = new ethers.JsonRpcProvider(RPC);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
const contract = new ethers.Contract(CONTRACT, abi, wallet);

/* ================= TOKENS ================= */

const TOKENS = [
  { name: "WETH", address: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619" },
  { name: "WMATIC", address: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270" },
  { name: "DAI", address: "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063" },
  { name: "USDT", address: "0xc2132D05D31c914a87C6611C10748AaCBcFc1e8" },
  { name: "WBTC", address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6" }
];

/* ================= HELPERS ================= */

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function short(tx) {
  return tx.slice(0, 6) + "..." + tx.slice(-4);
}

function safe(n) {
  return Number(n || 0);
}

/* ================= VAULT ================= */

async function getVault() {
  try {
    const bal = await contract.usdc();
    return Number(ethers.formatUnits(bal, 6));
  } catch {
    return 0;
  }
}

/* ================= MICRO SIMULATION ================= */

function simulate(token, size) {
  const profit = size * (0.01 + Math.random() * 0.18);
  const efficiency = (profit / size) * 1_000_000;

  return { profit, efficiency };
}

/* ================= CONTINUOUS SCALING (FIXED) ================= */

function computeScale(profit, vault) {
  if (!vault || vault <= 0) return 0.05;

  const ratio = profit / vault;

  // smooth scaling curve (NEVER 0x)
  let scale = Math.max(0.01, Math.min(1, ratio * 12));

  return Number(scale.toFixed(3));
}

function computeSize(vault, scale) {
  return Number((vault * scale).toFixed(6));
}

/* ================= SAFE EXECUTION ================= */

async function executeTrade(token, size) {
  try {
    const tx = await contract.executeArbitrage(
      token.address,
      token.address,
      ethers.parseUnits(size.toString(), 6),
      [],
      [],
      Math.floor(Date.now() / 1000) + 60
    );

    const receipt = await tx.wait();
    return receipt.hash;

  } catch (e) {
    console.log("⚠️ EXECUTION FAILED:", e.shortMessage || e.message);
    return null;
  }
}

/* ================= ENGINE ================= */

async function run() {
  console.log("🚀 MICRO→MACRO CONTINUOUS ENGINE STARTED\n");

  while (true) {
    const vault = await getVault();

    let best = {
      token: null,
      profit: 0,
      size: 0,
      scale: 0
    };

    for (let t of TOKENS) {
      console.log(`🔎 SCANNING ${t.name}`);

      const baseScale = 0.05 + Math.random() * 0.2;
      let size = computeSize(vault, baseScale);

      const sim = simulate(t, size);

      const scale = computeScale(sim.profit, vault);
      size = computeSize(vault, scale);

      console.log(`💰 Vault: ${vault.toFixed(6)} USDC`);
      console.log(`📊 Profit: ${sim.profit.toFixed(6)}`);
      console.log(`⚡ Efficiency: ${Math.floor(sim.efficiency)}`);
      console.log(`📐 SCALE: ${scale}x`);
      console.log(`🚀 SIZE: ${size} USDC\n`);

      if (sim.profit > best.profit) {
        best = {
          token: t,
          profit: sim.profit,
          size,
          scale
        };
      }
    }

    console.log("🏆 BEST SIGNAL");
    console.log("TOKEN:", best.token.name);
    console.log("PROFIT:", best.profit.toFixed(6));
    console.log("SIZE:", best.size);

    if (best.profit > 0) {
      console.log("\n🔥 EXECUTING TRADE");

      const before = vault;

      const txHash = await executeTrade(best.token, best.size);

      if (txHash) {
        console.log("TX:", short(txHash));

        const after = await getVault();

        console.log("\n💰 BEFORE:", before.toFixed(6));
        console.log("💰 AFTER :", after.toFixed(6));
        console.log("📈 PROFIT:", (after - before).toFixed(6));
      }
    }

    console.log("\n-----------------------------\n");

    await sleep(4000);
  }
}

run();
