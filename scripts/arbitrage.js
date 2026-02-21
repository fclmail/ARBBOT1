import dotenv from "dotenv";
import { ethers } from "ethers";

/* ================= ENV ================= */

dotenv.config({ override: false });

const RPC_POLYGON = "https://polygon-rpc.com";

const WALLET_PRIVATE_KEY =
  (process.env.OWNER_PRIVATE_KEY || process.env.PRIVATE_KEY || "").trim();

const HAS_PRIVATE_KEY = WALLET_PRIVATE_KEY.length > 0;

if (!HAS_PRIVATE_KEY) {
  console.log("⚠️ OWNER_PRIVATE_KEY missing — running in SCAN-ONLY mode");
}

/* ================= COLORS ================= */

const GREEN = "\x1b[92m";
const RESET = "\x1b[0m";
const CYAN = "\x1b[96m";
const YELLOW = "\x1b[93m";
const RED = "\x1b[91m";

/* ================= SETTINGS ================= */

const FIXED_TOTAL_USDC = 10000;
const MIN_EXPECTED_PROFIT = 5;
const DEADLINE_SECONDS = 45;
const SCAN_INTERVAL_MS = 8000;

/* ================= PROVIDER ================= */

const provider = new ethers.JsonRpcProvider(RPC_POLYGON);
let wallet = null;
if (HAS_PRIVATE_KEY) wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);

/* ================= CONTRACT ================= */

const VAULT_ADDRESS = "0x11887399855F0657cCd6018ca3A9aDa6Ac87664E";

const vaultAbi = [
  "function executeFlashArbitrage(address,address,uint256,address[],address[],uint256) external",
  "function usdc() view returns(address)",
  "function withdrawERC20(address,uint256)",
  "function approveRouters(address[],uint256)"
];

const vault = new ethers.Contract(
  VAULT_ADDRESS,
  vaultAbi,
  HAS_PRIVATE_KEY ? wallet : provider
);

/* ================= ROUTERS ================= */

const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607",
  Wault: "0xa98ea6356a316b44bf710d5f9b6b4ea0081409ef"
};

const routerAbi = [
  "function getAmountsOut(uint amountIn, address[] calldata path) view returns (uint[] memory)",
  "function swapExactTokensForTokens(uint,uint,address[],address,uint)"
];

/* ================= TOKENS ================= */

const TOKENS = {
  WETH: "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619",
  WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
  USDT: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F"
};

/* ================= HELPERS ================= */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function quote(routerAddr, amountIn, path) {
  try {
    const router = new ethers.Contract(routerAddr, routerAbi, provider);
    const amounts = await router.getAmountsOut(amountIn, path);
    return amounts.at(-1);
  } catch {
    return null;
  }
}

async function getVaultBalance(usdcAddr) {
  const usdc = new ethers.Contract(
    usdcAddr,
    ["function balanceOf(address) view returns(uint256)"],
    provider
  );
  return usdc.balanceOf(VAULT_ADDRESS);
}

async function showBalances() {
  try {
    const usdcAddr = await vault.usdc();

    const usdc = new ethers.Contract(
      usdcAddr,
      ["function balanceOf(address) view returns(uint256)"],
      provider
    );

    const walletMatic = wallet ? await provider.getBalance(wallet.address) : 0n;
    const contractUSDC = await usdc.balanceOf(VAULT_ADDRESS);

    console.log(`\n${CYAN}================ BALANCES ================${RESET}`);
    console.log(`${CYAN}Wallet:${RESET} ${wallet ? wallet.address : "SCAN ONLY"}`);
    console.log(`${CYAN}Wallet MATIC:${RESET} ${wallet ? ethers.formatEther(walletMatic) : 0}`);
    console.log(`${CYAN}Contract USDC:${RESET} ${ethers.formatUnits(contractUSDC, 6)}`);
    console.log(`${CYAN}==========================================\n${RESET}`);
  } catch (err) {
    console.log(`${RED}Balance display failed:${RESET}`, err.message);
  }
}

async function autoPayInMatic(usdcAddr) {
  if (!HAS_PRIVATE_KEY) return;

  const usdc = new ethers.Contract(
    usdcAddr,
    [
      "function balanceOf(address) view returns(uint256)",
      "function approve(address,uint256)"
    ],
    wallet
  );

  const bal = await usdc.balanceOf(VAULT_ADDRESS);
  if (Number(ethers.formatUnits(bal, 6)) < 1) return;

  const amount = bal;
  console.log(`${YELLOW}Threshold reached. Converting USDC → MATIC...${RESET}`);

  await (await vault.withdrawERC20(usdcAddr, amount)).wait();
  await (await usdc.approve(routers.QuickSwap, amount)).wait();

  const router = new ethers.Contract(routers.QuickSwap, routerAbi, wallet);
  await (
    await router.swapExactTokensForTokens(
      amount,
      0,
      [usdcAddr, TOKENS.WMATIC],
      wallet.address,
      Math.floor(Date.now() / 1000) + 120
    )
  ).wait();

  console.log(`${GREEN}PROFITS PAID IN MATIC${RESET}`);
}

/* ================= HYBRID ARBITRAGE ================= */

async function tryHybridArb(buyRouter, sellRouter, tokenAddr) {
  const usdcAddr = await vault.usdc();
  const vaultBalanceRaw = await getVaultBalance(usdcAddr);
  const vaultBalance = Number(ethers.formatUnits(vaultBalanceRaw, 6));

  const tradeAmount = ethers.parseUnits(FIXED_TOTAL_USDC.toString(), 6);

  const pathToToken = [usdcAddr, tokenAddr];
  const pathToUSDC = [tokenAddr, usdcAddr];

  const expectedBuy = await quote(buyRouter, tradeAmount, pathToToken);
  if (!expectedBuy) return;

  const expectedSell = await quote(sellRouter, expectedBuy, pathToUSDC);
  if (!expectedSell) return;

  const finalOut = Number(ethers.formatUnits(expectedSell, 6));
  const estimatedProfit = finalOut - FIXED_TOTAL_USDC;

  if (estimatedProfit < MIN_EXPECTED_PROFIT) return;

  console.log(`${GREEN}🔥 HYBRID PROFIT FOUND:${RESET} ${estimatedProfit.toFixed(2)} USDC`);

  if (!HAS_PRIVATE_KEY) {
    console.log("🛑 Skipping execution (no private key)");
    return;
  }

  const deadline = Math.floor(Date.now() / 1000) + DEADLINE_SECONDS;

  const tx = await vault.executeFlashArbitrage(
    buyRouter,
    sellRouter,
    tradeAmount,
    pathToToken,
    pathToUSDC,
    deadline
  );

  console.log(`⛓ TX SENT: ${tx.hash}`);
  await tx.wait();
  console.log(`${GREEN}✅ HYBRID FLASH EXECUTED${RESET}`);
}

/* ================= SCAN LOOP ================= */

async function scan() {
  console.log(`\n🔍 Scan @ ${new Date().toISOString()}`);

  const usdcAddr = await vault.usdc();
  await autoPayInMatic(usdcAddr);
  await showBalances();

  for (const token of Object.values(TOKENS)) {
    for (const buy of Object.values(routers)) {
      for (const sell of Object.values(routers)) {
        if (buy !== sell) {
          await tryHybridArb(buy, sell, token);
        }
      }
    }
  }
}

console.log("🚀 Hybrid Arbitrage Bot Started");

setInterval(() => {
  scan().catch(console.error);
}, SCAN_INTERVAL_MS);
