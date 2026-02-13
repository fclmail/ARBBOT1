// scripts/arbitrage.js

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
const CYAN  = "\x1b[96m";
const YELLOW = "\x1b[93m";
const RESET = "\x1b[0m";

const MIN_TRADE_USDC = 10;
const MIN_EXPECTED_PROFIT = 0.000001;
const PROFIT_SAFETY_MULTIPLIER = 0.9;
const DEADLINE_SECONDS = 20;

const WORKERS = 25;      // safe concurrency
const LOOP_DELAY = 50;

/* ================= PROVIDER ================= */

const provider = new ethers.WebSocketProvider(RPC_POLYGON_WS);
const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);

/* ================= VAULT ================= */

const VAULT_ADDRESS = "0x11887399855F0657cCd6018ca3A9aDa6Ac87664E";

const vault = new ethers.Contract(
  VAULT_ADDRESS,
  [
    "function executeFlashArbitrage(address,address,uint256,address[],address[],uint256)",
    "function usdc() view returns(address)",
    "function balanceOf(address) view returns(uint256)"
  ],
  wallet
);

const USDC_ADDR = await vault.usdc();

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
  Object.entries(routers).map(([k, v]) => [
    k,
    new ethers.Contract(v, routerAbi, provider)
  ])
);

/* ================= TOKENS ================= */

const TOKENS = [
  "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
  "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6",
  "0x4d224452801aced8b2f0aebe155379bb5d594381"
];

/* ================= ERC20 ================= */

const erc20Abi = ["function balanceOf(address) view returns(uint256)"];
const usdc = new ethers.Contract(USDC_ADDR, erc20Abi, provider);

/* ================= HEARTBEAT (balances + memory) ================= */

setInterval(async () => {
  try {
    const matic = await provider.getBalance(wallet.address);
    const vaultBal = await usdc.balanceOf(VAULT_ADDRESS);

    console.log(
      `💓 alive | MATIC: ${ethers.formatEther(matic)} | Vault USDC: ${ethers.formatUnits(vaultBal,6)} | mem: ${(process.memoryUsage().rss/1024/1024).toFixed(0)}MB`
    );
  } catch {}
}, 10000);

/* ================= HELPERS ================= */

async function quote(router, amountIn, path) {
  try {
    const r = await router.getAmountsOut(amountIn, path);
    return r.at(-1);
  } catch {
    return null;
  }
}

/* ================= ARB ================= */

async function tryArb(buyName, sellName, token) {

  console.log(`${CYAN}🔎 scanning ${buyName} → ${sellName} | token ${token}${RESET}`);

  const amountIn = ethers.parseUnits(MIN_TRADE_USDC.toString(), 6);

  const buyOut = await quote(routerContracts[buyName], amountIn, [USDC_ADDR, token]);
  if (!buyOut) return;

  const sellOut = await quote(routerContracts[sellName], buyOut, [token, USDC_ADDR]);
  if (!sellOut) return;

  const profit =
    (Number(ethers.formatUnits(sellOut, 6)) - MIN_TRADE_USDC)
    * PROFIT_SAFETY_MULTIPLIER;

  if (profit < MIN_EXPECTED_PROFIT) return;

  console.log(`${GREEN}🔥 profit ${profit.toFixed(4)} USDC${RESET}`);

  const deadline = Math.floor(Date.now()/1000)+DEADLINE_SECONDS;

  const tx = await vault.executeFlashArbitrage(
    routers[buyName],
    routers[sellName],
    amountIn,
    [USDC_ADDR, token],
    [token, USDC_ADDR],
    deadline,
    { gasLimit: 2_000_000 }
  );

  console.log(`${YELLOW}📤 TX SENT: ${tx.hash}${RESET}`);

  await tx.wait();

  console.log(`${GREEN}⚡ CONFIRMED: ${tx.hash}${RESET}`);
}

/* ================= SAFE CONTINUOUS LOOP ================= */

async function scanLoop() {

  const jobs = [];

  for (const token of TOKENS)
    for (const buy of Object.keys(routers))
      for (const sell of Object.keys(routers))
        if (buy !== sell)
          jobs.push(() => tryArb(buy, sell, token));

  console.log("🚀 Continuous arbitrage scanning...");

  while (true) {

    for (let i = 0; i < jobs.length; i += WORKERS) {
      const batch = jobs.slice(i, i + WORKERS).map(fn => fn());
      await Promise.allSettled(batch);
    }

    await new Promise(r => setTimeout(r, LOOP_DELAY));
  }
}

/* ================= START ================= */

scanLoop();
