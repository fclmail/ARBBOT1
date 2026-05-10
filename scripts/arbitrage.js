import { ethers } from "ethers";

/* ================= CONFIG ================= */

const RPC = process.env.RPC_URL;

const PRIVATE_KEY = process.env.PRIVATE_KEY;

// Replace with your deployed contract
const VAULT_CONTRACT = process.env.VAULT_CONTRACT;

/* ================= PROVIDER ================= */

const provider = new ethers.JsonRpcProvider(RPC);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

/* ================= MINIMAL ABI (FIXED SAFE) ================= */

const ABI = [
  "function executeArbitrage(address,address,uint256,address[],address[],uint256) external",
  "function simulateArbitrageProfit(address,address,uint256,address[],address[]) view returns (uint256,uint256)",
  "function vault() view returns (address)"
];

const contract = new ethers.Contract(
  VAULT_CONTRACT,
  ABI,
  wallet
);

/* ================= TOKENS ================= */

const TOKENS = [
  { name: "WETH", address: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619" },
  { name: "WMATIC", address: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270" },
  { name: "USDT", address: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F" },
  { name: "DAI", address: "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063" },
];

/* ================= ROUTERS ================= */

const QUICKSWAP = "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff";

/* ================= UTIL ================= */

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function formatTx(hash) {
  return `${hash.slice(0, 6)}...${hash.slice(-4)}`;
}

/* ================= MICRO SCALING ENGINE ================= */

function dynamicScale(profit, vault) {
  // smooth scaling curve (no fixed size)
  const base = 0.01;
  const ratio = profit / (vault + 1e-6);

  const scale = Math.min(0.5, base + ratio * 0.2);

  return scale;
}

/* ================= CORE SCAN ================= */

async function scanToken(token, vaultBalance) {
  try {
    const baseSize = vaultBalance * 0.05;

    const simulated = await contract.simulateArbitrageProfit(
      QUICKSWAP,
      QUICKSWAP,
      ethers.parseUnits(baseSize.toFixed(6), 6),
      [token.address],
      [token.address]
    );

    const profit = Number(ethers.formatUnits(simulated[1], 6));

    const scale = dynamicScale(profit, vaultBalance);

    const size = vaultBalance * scale;

    console.log(`🔎 SCANNING ${token.name}`);
    console.log(`💰 Vault: ${vaultBalance.toFixed(6)} USDC`);
    console.log(`📊 Profit: ${profit.toFixed(6)}`);
    console.log(`⚡ Efficiency: ${Math.floor(profit / (size + 1e-6))}`);
    console.log(`📐 SCALE: ${scale.toFixed(2)}x`);
    console.log(`🚀 SIZE: ${size.toFixed(6)} USDC\n`);

    return {
      token,
      profit,
      size
    };

  } catch (e) {
    console.log(`❌ ${token.name} scan failed`);
    return null;
  }
}

/* ================= EXECUTE TRADE ================= */

async function executeTrade(best, vaultBefore) {
  console.log("🔥 EXECUTING TRADE");

  const tx = await contract.executeArbitrage(
    QUICKSWAP,
    QUICKSWAP,
    ethers.parseUnits(best.size.toFixed(6), 6),
    [best.token.address],
    [best.token.address],
    Math.floor(Date.now() / 1000) + 60
  );

  console.log(`TX: ${formatTx(tx.hash)}`);

  const receipt = await tx.wait();

  const vaultAfter = vaultBefore + best.profit;

  console.log(`💰 BEFORE: ${vaultBefore.toFixed(6)}`);
  console.log(`💰 AFTER : ${vaultAfter.toFixed(6)}`);
  console.log(`📈 PROFIT: ${(vaultAfter - vaultBefore).toFixed(6)}\n`);
}

/* ================= MAIN LOOP ================= */

async function main() {
  console.log("🚀 MICRO→MACRO CONTINUOUS ENGINE STARTED\n");

  while (true) {

    let vaultBalance = 0.047508; // replace with real call if needed

    let best = null;

    for (const token of TOKENS) {
      const result = await scanToken(token, vaultBalance);

      if (!result) continue;

      if (!best || result.profit > best.profit) {
        best = result;
      }
    }

    if (best && best.profit > 0.001) {
      console.log("🏆 BEST SIGNAL");
      console.log(`TOKEN: ${best.token.name}`);
      console.log(`PROFIT: ${best.profit.toFixed(6)}`);
      console.log(`SIZE: ${best.size.toFixed(6)}\n`);

      await executeTrade(best, vaultBalance);
    } else {
      console.log("⏳ No valid opportunity\n");
    }

    await sleep(5000);
  }
}

main().catch(console.error);
