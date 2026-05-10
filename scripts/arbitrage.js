import { ethers } from "ethers";
import abi from "./VaultArbitrageEnforcer.json" assert { type: "json" };

const RPC = process.env.RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const CONTRACT = process.env.CONTRACT;

const provider = new ethers.JsonRpcProvider(RPC);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

const contract = new ethers.Contract(CONTRACT, abi, wallet);

// ---------------- CONFIG ----------------
const TOKENS = [
  { name: "WETH", address: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619" },
  { name: "WMATIC", address: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270" },
  { name: "DAI", address: "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063" },
  { name: "USDT", address: "0xc2132D05D31c914a87C6611C10748AaCBcFc1e8" },
  { name: "WBTC", address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6" }
];

// ---------------- UTILS ----------------

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function shortTx(tx) {
  return tx.slice(0, 6) + "..." + tx.slice(-4);
}

function safeNum(x) {
  return Number(x || 0);
}

// MICRO→MACRO scaling (continuous curve, NOT fixed steps)
function computeScale(profit, vault) {
  if (!vault || vault <= 0) return 0.01;

  const ratio = profit / vault;

  // smooth scaling curve (sigmoid-like clamp)
  let scale = Math.min(1, Math.max(0.01, ratio * 10));

  return Number(scale.toFixed(3));
}

// dynamic trade size
function computeSize(vault, scale) {
  return Number((vault * scale).toFixed(6));
}

// ---------------- SIMULATION ----------------

async function simulate(token, size) {
  try {
    const profit = Math.random() * size * 0.25; // mock profit curve
    const efficiency = profit > 0 ? (profit / size) * 1000000 : 0;

    return {
      profit,
      efficiency
    };
  } catch {
    return { profit: 0, efficiency: 0 };
  }
}

// ---------------- EXECUTION ----------------

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
    console.log("⚠️ TRADE FAILED:", e.shortMessage || e.message);
    return null;
  }
}

// ---------------- VAULT ----------------

async function getVaultBalance() {
  const bal = await contract.usdc();
  return Number(ethers.formatUnits(bal, 6));
}

// ---------------- ENGINE ----------------

async function run() {
  console.log("🚀 MICRO→MACRO CONTINUOUS ENGINE STARTED\n");

  while (true) {
    let vault = await getVaultBalance();

    let best = {
      token: null,
      profit: 0,
      size: 0,
      scale: 0
    };

    for (let t of TOKENS) {
      console.log(`🔎 SCANNING ${t.name}`);

      let baseScale = 0.05 + Math.random() * 0.2;
      let size = computeSize(vault, baseScale);

      let sim = await simulate(t, size);

      let scale = computeScale(sim.profit, vault);

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
        console.log("TX:", shortTx(txHash));

        let after = await getVaultBalance();

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
