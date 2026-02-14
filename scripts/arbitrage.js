// scripts/arbitrage-persistent.js

import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config({ override: false });

/* ================= ENV ================= */
const RPC_POLYGON_WS = process.env.RPC_URL?.trim();
const WALLET_PRIVATE_KEY = process.env.PRIVATE_KEY?.trim();

if (!RPC_POLYGON_WS || !WALLET_PRIVATE_KEY) process.exit(1);

console.log("✅ RPC_URL active");
console.log("✅ PRIVATE_KEY active");

/* ================= SETTINGS ================= */
const GREEN = "\x1b[92m";
const CYAN = "\x1b[96m";
const YELLOW = "\x1b[93m";
const RESET = "\x1b[0m";

const MIN_TRADE_USDC = 10;           // Minimum trade size
const MIN_EXPECTED_PROFIT = 0.000001; // Minimum expected profit in USDC
const PROFIT_SAFETY_MULTIPLIER = 0.9; 
const DEADLINE_SECONDS = 20;

const WORKERS = 25;
const LOOP_DELAY = 50; // ms delay between scan cycles
const ARB_TIMEOUT = 5000; // ms per tryArb to prevent hangs

/* ================= PROVIDER & WALLET ================= */
const provider = new ethers.WebSocketProvider(RPC_POLYGON_WS);
const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);

/* ================= VAULT ================= */
const VAULT_ADDRESS = "0x11887399855F0657cCd6018ca3A9aDa6Ac87664E";
const vaultAbi = [
  "function executeFlashArbitrage(address,address,uint256,address[],address[],uint256)",
  "function usdc() view returns(address)"
];
const vault = new ethers.Contract(VAULT_ADDRESS, vaultAbi, wallet);

const USDC_ADDR = await vault.usdc();

/* ================= ERC20 ================= */
const erc20Abi = [
  "function balanceOf(address) view returns(uint256)",
  "function decimals() view returns(uint8)"
];
const usdc = new ethers.Contract(USDC_ADDR, erc20Abi, provider);

/* ================= ROUTERS ================= */
const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  ApeSwap:   "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607",
  Wault:     "0xa98ea6356a316b44bf710d5f9b6b4ea0081409ef"
};

const routerAbi = [
  "function getAmountsOut(uint amountIn, address[] calldata path) view returns (uint[])"
];
const routerContracts = Object.fromEntries(
  Object.entries(routers).map(([k, v]) => [k, new ethers.Contract(v, routerAbi, provider)])
);

/* ================= TOKENS ================= */
const TOKENS = [
  "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", // USDT
  "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", // WBTC
  "0x4d224452801aced8b2f0aebe155379bb5d594381"  // APE
];

/* ================= HELPERS ================= */
async function quote(router, amountIn, path) {
  try {
    const amounts = await router.getAmountsOut(amountIn, path);
    return amounts.at(-1);
  } catch {
    return null;
  }
}

async function logBalances(label) {
  const matic = await provider.getBalance(wallet.address);
  const vaultUsdc = await usdc.balanceOf(VAULT_ADDRESS);
  console.log(
    `${CYAN}💰 ${label} | Wallet MATIC: ${ethers.formatEther(matic)} | Vault USDC: ${ethers.formatUnits(vaultUsdc, 6)}${RESET}`
  );
}

/* ================= ARBITRAGE EXECUTION ================= */
async function tryArb(buyName, sellName, token) {
  try {
    const amountIn = ethers.parseUnits(MIN_TRADE_USDC.toString(), 6);

    const buyOut = await quote(routerContracts[buyName], amountIn, [USDC_ADDR, token]);
    if (!buyOut) return;

    const sellOut = await quote(routerContracts[sellName], buyOut, [token, USDC_ADDR]);
    if (!sellOut) return;

    const profit =
      (Number(ethers.formatUnits(sellOut, 6)) - MIN_TRADE_USDC) * PROFIT_SAFETY_MULTIPLIER;

    if (profit < MIN_EXPECTED_PROFIT) return;

    console.log(
      `${GREEN}🔥 PROFIT ${profit.toFixed(6)} USDC | ${buyName} → ${sellName}${RESET}`
    );

    await logBalances("BEFORE");

    const deadline = Math.floor(Date.now() / 1000) + DEADLINE_SECONDS;

    const tx = await vault.executeFlashArbitrage(
      routers[buyName],
      routers[sellName],
      amountIn,
      [USDC_ADDR, token],
      [token, USDC_ADDR],
      deadline,
      { gasLimit: 2_000_000 }
    );

    console.log(`${YELLOW}⏳ TX SENT: ${tx.hash}${RESET}`);
    const receipt = await tx.wait();
    console.log(`${GREEN}✅ TX CONFIRMED | status=${receipt.status} | block=${receipt.blockNumber}${RESET}`);

    await logBalances("AFTER");
  } catch (err) {
    console.error(`${YELLOW}⚠️ tryArb error: ${err?.message || err}${RESET}`);
  }
}

/* ================= SAFE PERSISTENT LOOP ================= */
async function scanLoop() {
  const jobs = [];
  for (const token of TOKENS)
    for (const buy of Object.keys(routers))
      for (const sell of Object.keys(routers))
        if (buy !== sell)
          jobs.push({ buy, sell, token });

  console.log(`${CYAN}🚀 Continuous arbitrage scanning | Pairs loaded: ${jobs.length}${RESET}`);

  while (true) {
    for (let i = 0; i < jobs.length; i += WORKERS) {
      const batch = jobs.slice(i, i + WORKERS);

      console.log(`${YELLOW}🔎 Scanning pairs ${i + 1} → ${i + batch.length}${RESET}`);

      // Wrap each tryArb in a timeout to prevent any single hang from stopping the loop
      await Promise.allSettled(batch.map(j =>
        Promise.race([
          tryArb(j.buy, j.sell, j.token),
          new Promise(r => setTimeout(r, ARB_TIMEOUT))
        ])
      ));
    }
    await new Promise(r => setTimeout(r, LOOP_DELAY));
  }
}

/* ================= MEMPOOL LISTENER ================= */
console.log("🎧 Starting mempool listener...");

provider.on("pending", async (txHash) => {
  try {
    const tx = await provider.getTransaction(txHash);
    if (!tx || !tx.to) return;

    const to = tx.to.toLowerCase();

    if (Object.values(routers).map(r => r.toLowerCase()).includes(to)) {
      console.log(`${YELLOW}⚡ Pending DEX tx detected: ${txHash}${RESET}`);

      for (const token of TOKENS) {
        for (const buy of Object.keys(routers)) {
          for (const sell of Object.keys(routers)) {
            if (buy !== sell) {
              // fire and forget, wrapped in timeout
              Promise.race([tryArb(buy, sell, token), new Promise(r => setTimeout(r, ARB_TIMEOUT))]);
            }
          }
        }
      }
    }
  } catch {}
});

/* ================= START ================= */
scanLoop(); // main persistent scanning loop
