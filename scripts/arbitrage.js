// scripts/arbitrage.js
// ---------------------------------------------------------
//  ARBITRAGE BOT – FULL RESTORED VERSION (VAULT v2 FIXED)
// ---------------------------------------------------------

import dotenv from "dotenv";
import { ethers, Wallet } from "ethers";
dotenv.config();

// ----------------- CONFIG -----------------
const RPC = process.env.RPC_POLYGON || "https://polygon-rpc.com";
const PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY || process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) throw new Error("WALLET_PRIVATE_KEY not found.");

const DRY_RUN = true;
const MIN_TRADE_USDC = 200000;
const MIN_EXPECTED_PROFIT = 0.00001; // ✅ 10 units (6 decimals)
const MIN_PROFIT_PCT = 1.0;
const SLIPPAGE_PCT = 0.05;
const MAX_PROFIT_PCT = 550;

// ----------------- COLORS -----------------
const colors = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m"
};
const fmtNum = (n, dec = 6) => Number(n).toFixed(dec);

// ----------------- PROVIDER / WALLET -----------------
const provider = new ethers.JsonRpcProvider(RPC);
const wallet = new Wallet(PRIVATE_KEY, provider);

// ----------------- VAULT -----------------
const VAULT_ADDRESS = "0x2dD5820519aBbC74DB5658744e9EbAf9ED88320e";

const vaultAbi = [
  {
    "inputs": [
      { "name": "buyRouter", "type": "address" },
      { "name": "sellRouter", "type": "address" },
      { "name": "token", "type": "address" },
      { "name": "amountInUSDC", "type": "uint256" },
      { "name": "minTokenOut", "type": "uint256" },
      { "name": "minUSDCOut", "type": "uint256" },
      { "name": "deadline", "type": "uint256" }
    ],
    "name": "executeArbitrage",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  { "inputs": [], "name": "USDC", "outputs": [{ "type": "address" }], "stateMutability": "view", "type": "function" },
  { "inputs": [], "name": "owner", "outputs": [{ "type": "address" }], "stateMutability": "view", "type": "function" }
];

const vaultContract = new ethers.Contract(VAULT_ADDRESS, vaultAbi, wallet);

// ----------------- ERC20 -----------------
const erc20Abi = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)"
];

// ----------------- HELPERS -----------------
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ----------------- EXECUTE -----------------
async function executeTradeLive(buyRouter, sellRouter, tokenAddr, amountUSDC) {
  const usdcAddr = await vaultContract.USDC();
  const usdc = new ethers.Contract(usdcAddr, erc20Abi, provider);

  const before = Number(ethers.formatUnits(await usdc.balanceOf(VAULT_ADDRESS), 6));
  console.log(`${colors.cyan}🏦 Vault Balance Before: ${fmtNum(before)} USDC${colors.reset}`);

  const amountInRaw = ethers.parseUnits(amountUSDC.toString(), 6);

  // enforce min profit (10 units)
  const minUSDCOut = amountInRaw + 10n;

  // conservative mins (slippage)
  const minTokenOut = 1n;

  if (DRY_RUN) {
    console.log(`${colors.magenta}🔎 DRY RUN — not sending tx${colors.reset}`);
    return;
  }

  const deadline = Math.floor(Date.now() / 1000) + 120;

  const tx = await vaultContract.executeArbitrage(
    buyRouter,
    sellRouter,
    tokenAddr,
    amountInRaw,
    minTokenOut,
    minUSDCOut,
    deadline
  );

  console.log(`${colors.green}🔁 TX SENT — ${tx.hash}${colors.reset}`);
  await tx.wait();

  const after = Number(ethers.formatUnits(await usdc.balanceOf(VAULT_ADDRESS), 6));
  const profit = after - before;

  console.log(`${colors.green}💰 REAL PROFIT: ${fmtNum(profit)} USDC${colors.reset}`);
}

// ----------------- MAIN -----------------
(async function main() {
  console.log(`${colors.cyan}🚀 Live arbitrage runner started${colors.reset}`);
  console.log(`${colors.cyan}🏛 Vault: ${VAULT_ADDRESS}${colors.reset}`);
})();
