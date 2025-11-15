// scripts/arbitrage.js
// ----------------------------------------------------
// AAVE FLASH ARB BOT - POLYGON (ES Module)
// ----------------------------------------------------
import { ethers } from "ethers";
import "dotenv/config";

// ---------------- CONFIG ----------------
const RPC_URL = process.env.RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const ARB_CONTRACT = "0x19B64f74553eE0ee26BA01BF34321735E4701C43"; // Hardcoded
const TRADE_AMOUNT = "0.02"; // USDC amount in human-readable units
const SCAN_DELAY_MS = 5000; // 5s between scans

// ---------------- ABI ----------------
const arbAbi = [
  {
    "inputs":[
      {"internalType":"address","name":"buyRouter","type":"address"},
      {"internalType":"address","name":"sellRouter","type":"address"},
      {"internalType":"address","name":"token","type":"address"},
      {"internalType":"uint256","name":"amountIn","type":"uint256"}
    ],
    "name":"executeArbitrage",
    "outputs":[],
    "stateMutability":"nonpayable",
    "type":"function"
  },
  { "inputs": [], "name": "owner", "outputs": [{"internalType":"address","name":"","type":"address"}], "stateMutability":"view","type":"function" },
  { "inputs": [], "name": "USDC", "outputs": [{"internalType":"address","name":"","type":"address"}], "stateMutability":"view","type":"function" }
];

// ---------------- PROVIDER + WALLET ----------------
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

// ---------------- CONTRACT INSTANCE ----------------
const arbContract = new ethers.Contract(ARB_CONTRACT, arbAbi, wallet);

// ---------------- UTILITY ----------------
const norm = (addr) => {
  try { return ethers.getAddress(addr); }
  catch { return null; }
};

// ---------------- EXAMPLE ROUTERS & TOKENS ----------------
const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};

const tokens = {
  LINK: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39",
  WBTC: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6",
  AAVE: "0xd6df932a45c0f255f85145f286ea0b292b21c90b"
};

// ---------------- EXECUTE TRADE ----------------
async function executeTrade(buyRouter, sellRouter, token, amountUnits) {
  const buy = norm(buyRouter);
  const sell = norm(sellRouter);
  const tok = norm(token);
  if (!buy || !sell || !tok) return { executed: false, reason: "Invalid address" };

  // Convert to smallest unit (assume 6 decimals for USDC)
  const amount = ethers.parseUnits(amountUnits, 6);

  // 1️⃣ CallStatic simulation
  try {
    await arbContract.callStatic.executeArbitrage(buy, sell, tok, amount);
  } catch (err) {
    return { executed: false, reason: "callStatic fail: " + (err.reason || err.message) };
  }

  // 2️⃣ Send transaction
  try {
    const tx = await arbContract.executeArbitrage(buy, sell, tok, amount, { gasLimit: 2_500_000 });
    const receipt = await tx.wait();
    return { executed: true, hash: receipt.hash };
  } catch (err) {
    return { executed: false, reason: err.reason || err.message };
  }
}

// ---------------- FETCH CONTRACT + WALLET BALANCE ----------------
async function getBalances() {
  const usdcAddress = await arbContract.USDC();
  const contractUSDC = await (new ethers.Contract(usdcAddress, [{"inputs":[],"name":"balanceOf","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"}], provider)).balanceOf(ARB_CONTRACT);
  const walletMATIC = await provider.getBalance(wallet.address);
  return {
    contractUSDC: ethers.formatUnits(contractUSDC, 6),
    walletMATIC: ethers.formatEther(walletMATIC)
  };
}

// ---------------- SCAN ----------------
async function scan() {
  console.log("🔍 Scanning for arbitrage opportunities...");
  for (const tokenKey of Object.keys(tokens)) {
    const token = tokens[tokenKey];
    for (const buyKey of Object.keys(routers)) {
      for (const sellKey of Object.keys(routers)) {
        if (buyKey === sellKey) continue;
        const buyRouter = routers[buyKey];
        const sellRouter = routers[sellKey];

        console.log(`🔹 Checking trade: ${tokenKey} | Buy:${buyKey} -> Sell:${sellKey}`);
        const result = await executeTrade(buyRouter, sellRouter, token, TRADE_AMOUNT);

        if (result.executed) {
          console.log(`✅ Trade executed: ${tokenKey} | Buy:${buyKey} -> Sell:${sellKey} | TxHash: ${result.hash}`);
        } else {
          console.log(`✖ callStatic would fail: ${result.reason}`);
        }
      }
    }
  }

  const balances = await getBalances();
  console.log(`🔹 Contract USDC balance: ${balances.contractUSDC}`);
  console.log(`🔹 Wallet MATIC balance: ${balances.walletMATIC}`);
}

// ---------------- MAIN LOOP ----------------
async function main() {
  console.log("🚀 Aave Flash Arbitrage Bot running on Polygon...");
  while (true) {
    try {
      await scan();
      await new Promise(r => setTimeout(r, SCAN_DELAY_MS));
    } catch (err) {
      console.error("Error in main loop:", err);
    }
  }
}

main().catch(console.error);

