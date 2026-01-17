// scripts/arbi-fixed.js ---------------------------------------------------------
import dotenv from "dotenv";
import { ethers, Wallet } from "ethers";
dotenv.config();

// ------------------- CONFIG -------------------
const PRIVATE_KEY = process.env.PRIVATE_KEY || process.env.WALLET_PRIVATE_KEY;
if (!PRIVATE_KEY) throw new Error("Missing PRIVATE_KEY");

const VAULT_ADDRESS = "0x621F7ccEb67136f7922E36aF56137e7A1dbA22f1";
const USDC_ADDRESS = "0x2791bca1f2de4661ed88a30c99a7a9449aa84174";

const DRY_RUN = false;
const MIN_TRADE_USDC = 0.05; // Minimum USDC per trade
const SLIPPAGE_PCT = 0.05;

// ------------------- COLORS -------------------
const colors = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
};
const fmt = (n, d = 6) => Number(n).toFixed(d);

// ------------------- RPC ROTATION -------------------
const RPCS = [
  process.env.RPC_POLYGON || "",
  "https://polygon-bor-rpc.publicnode.com",
  "https://rpc.ankr.com/polygon",
  "https://polygon.llamarpc.com",
].filter(Boolean);

let rpcIndex = 0;
function newProvider() {
  const url = RPCS[rpcIndex];
  rpcIndex = (rpcIndex + 1) % RPCS.length;
  console.log(`${colors.yellow}🔄 Using RPC: ${url}${colors.reset}`);
  return new ethers.JsonRpcProvider(url, { name: "matic", chainId: 137 });
}

let provider = newProvider();
let wallet = new Wallet(PRIVATE_KEY, provider);

async function rpc(fn) {
  try {
    return await fn(provider);
  } catch (e) {
    console.log(`${colors.red}⚠️ RPC error: ${e.message}, rotating...${colors.reset}`);
    provider = newProvider();
    wallet = new Wallet(PRIVATE_KEY, provider);
    return fn(provider);
  }
}

// ------------------- VAULT CONTRACT -------------------
const vaultAbi = [
  "function executeArbitrage(address buyRouter,address sellRouter,uint256 amountInUSDC,address[] pathToToken,address[] pathToUSDC,uint256 deadline)",
  "function setMinimumProfitUSDC(uint256 _min)",
  "function setVault(address _vault)",
  "function withdrawERC20(address tokenAddr,uint256 amount)",
  "function minimumProfitUSDC() view returns (uint256)",
  "function approveRouters(address[] routers,uint256 amount)"
];

const vault = new ethers.Contract(VAULT_ADDRESS, vaultAbi, wallet);

// ------------------- ERC20 -------------------
const erc20Abi = [
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender,uint256 amount) external returns (bool)",
  "function transfer(address to,uint256 amount) external returns (bool)",
];

const usdc = new ethers.Contract(USDC_ADDRESS, erc20Abi, wallet);

// ------------------- ROUTERS & TOKENS -------------------
const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607",
};

const tokens = {
  AAVE: { address: "0xd6df932a45c0f255f85145f286ea0b292b21c90b", decimals: 18 },
  CRV: { address: "0x172370d5cd63279efa6d502dab29171933a610af", decimals: 18 },
  LINK: { address: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39", decimals: 18 },
  WBTC: { address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", decimals: 8 },
};

// ------------------- HELPERS -------------------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function vaultBalance() {
  const bal = await rpc(() => usdc.balanceOf(VAULT_ADDRESS));
  return Number(ethers.formatUnits(bal, 6));
}

async function minimumProfit() {
  return Number(await rpc(() => vault.minimumProfitUSDC()));
}

async function quote(routerAddr, token, amountUSDC) {
  const router = new ethers.Contract(routerAddr, ["function getAmountsOut(uint amountIn,address[] path) view returns(uint[] memory)"], provider);
  const amt = ethers.parseUnits(amountUSDC.toString(), 6);
  try {
    const a = await rpc(() => router.getAmountsOut(amt, [USDC_ADDRESS, token.address]));
    return Number(ethers.formatUnits(a[a.length - 1], token.decimals));
  } catch {
    return null;
  }
}

// ------------------- INITIAL SETUP -------------------
async function setupVault() {
  // 1. Set minimum profit = 0.000001 USDC
  const minProfit = ethers.parseUnits("0.000001", 6);
  await rpc(() => vault.setMinimumProfitUSDC(minProfit));
  console.log(`${colors.green}✅ Minimum profit set to 0.000001 USDC${colors.reset}`);

  // 2. Approve all routers for USDC
  const maxApprove = ethers.parseUnits("1000000", 6); // 1,000,000 USDC
  await rpc(() => vault.approveRouters(Object.values(routers), maxApprove));
  console.log(`${colors.green}✅ Approved USDC on all routers${colors.reset}`);
}

// ------------------- EXECUTION -------------------
async function executeTrade(buyRouter, sellRouter, token, tradeUSDC) {
  const before = await vaultBalance();
  if (before < tradeUSDC) return;
  const usdcAmt = ethers.parseUnits(tradeUSDC.toString(), 6);
  const deadline = Math.floor(Date.now() / 1000) + 120;

  console.log(`${colors.cyan}🏦 Vault Before: ${fmt(before)} USDC${colors.reset}`);

  try {
    const tx = await rpc(() => vault.executeArbitrage(
      buyRouter,
      sellRouter,
      usdcAmt,
      [USDC_ADDRESS, token.address],
      [token.address, USDC_ADDRESS],
      deadline
    ));

    console.log(`${colors.green}🔁 TX SENT: ${tx.hash}${colors.reset}`);
    const receipt = await tx.wait();

    if (receipt.status === 1) {
      const after = await vaultBalance();
      console.log(`${colors.green}✅ Vault After: ${fmt(after)} USDC`);
      console.log(`${colors.green}💰 Real Profit: ${fmt(after - before)} USDC${colors.reset}`);
    } else {
      console.log(`${colors.red}⚠️ TX failed${colors.reset}`);
    }
  } catch (err) {
    if (err.reason) {
      console.log(`${colors.red}⚠️ Trade error: ${err.reason}${colors.reset}`);
    } else {
      console.log(`${colors.red}⚠️ Trade error: ${err.message}${colors.reset}`);
    }
  }
}

// ------------------- SCANNER -------------------
async function scan() {
  console.log("\n🔍 Scanning...");
  for (const token of Object.values(tokens)) {
    for (const buy of Object.values(routers)) {
      for (const sell of Object.values(routers)) {
        if (buy === sell) continue;
        await executeTrade(buy, sell, token, MIN_TRADE_USDC);
        await sleep(800);
      }
    }
  }
}

// ------------------- MAIN LOOP -------------------
(async () => {
  console.log(`${colors.cyan}🚀 Arb bot running${colors.reset}`);
  await setupVault(); // set min profit + approve routers
  while (true) {
    await scan();
    await sleep(8000);
  }
})();
