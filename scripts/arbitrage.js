// ----------------------------------------------------
// AAVE FLASH ARB BOT - POLYGON (ES Module) - FIXED & ENHANCED
// ----------------------------------------------------
import { ethers } from "ethers";
import "dotenv/config";

// ---------------- CONFIG ----------------
const RPC_URL = process.env.RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;

// Hardcoded arbitrage contract address (governance may update)
const ARB_CONTRACT = "0x19B64f74553eE0ee26BA01BF34321735E4701C43";

// Trade parameters
const TRADE_AMOUNT = "0.02"; // Token amount in human-readable units (adjust per token decimals)
const SCAN_DELAY_MS = 5000; // 5s between scans

// Optional profit guard (you can adjust or compute from a separate on-chain estimator)
const MIN_PROFIT_USDC = 0.5; // minimum expected profit in USDC (example, adjust to your setup)
const USDC_DECIMALS_TARGET = 6;

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
if (!RPC_URL) throw new Error("Missing RPC_URL in environment");
if (!PRIVATE_KEY) throw new Error("Missing PRIVATE_KEY in environment");

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

// ---------------- Helper: get token decimals ----------------
async function getTokenDecimals(tokenAddress) {
  try {
    const tok = norm(tokenAddress);
    if (!tok) return 6;
    const tokContract = new ethers.Contract(tok, [
      "function decimals() view returns (uint8)"
    ], provider);
    const d = await tokContract.decimals();
    return Number(d);
  } catch (e) {
    console.warn("Decimals lookup failed for", tokenAddress, e?.message);
    return 6;
  }
}

// ---------------- HELPER: fetch USDC decimals assumption ----------------
async function getUSDCDecimalsIfKnown(usdcAddress) {
  try {
    const c = new ethers.Contract(usdcAddress, [
      "function decimals() view returns (uint8)"
    ], provider);
    const d = await c.decimals();
    return Number(d);
  } catch {
    return 6;
  }
}

// ---------------- EXECUTE TRADE ----------------
async function executeTrade(buyRouter, sellRouter, token, amountUnits) {
  const buy = norm(buyRouter);
  const sell = norm(sellRouter);
  const tok = norm(token);
  if (!buy || !sell || !tok) return { executed: false, reason: "Invalid address" };

  // Fetch decimals dynamically
  const tokDecimals = await getTokenDecimals(tok);
  const amount = ethers.parseUnits(amountUnits, tokDecimals);

  // 1️⃣ CallStatic simulation
  try {
    const staticResult = await arbContract.callStatic.executeArbitrage(buy, sell, tok, amount);
    // Optionally inspect staticResult if the contract returns a value. If not, just ensure no throw.
  } catch (err) {
    return { executed: false, reason: "callStatic fail: " + (err.reason || err.message) };
  }

  // Optional: estimate potential profit (if your contract exposes it) or simulate price impact externally.
  // We proceed with the transaction, but we can guard against obvious low-profit trades.
  // 2️⃣ Gas estimation
  let gasEst;
  try {
    gasEst = await arbContract.estimateGas.executeArbitrage(buy, sell, tok, amount, { gasLimit: undefined });
  } catch (e) {
    // Fall back to a safe default if estimation fails
    gasEst = ethers.BigNumber.from("2500000"); // 2.5M
    console.warn("Gas estimation failed, using default 2.5M");
  }

  // Optional: simple profit guard using a rough check if your contract can expose expected output.
  // If not available from contract, skip this guard or rely on on-chain result.

  // 3️⃣ Send transaction
  try {
    // Add a modest safety margin
    const safeGas = gasEst.mul( ethers.BigNumber.from(110)).div(100);
    const tx = await arbContract.executeArbitrage(buy, sell, tok, amount, { gasLimit: safeGas });
    const receipt = await tx.wait();
    // Very small additional check: ensure status is 1
    if (receipt && receipt.status !== 1) {
      return { executed: false, reason: "Transaction failed (non-zero status)" };
    }
    return { executed: true, hash: receipt.hash };
  } catch (err) {
    return { executed: false, reason: err?.reason || err?.message || "Unknown error" };
  }
}

// ---------------- FETCH CONTRACT + WALLET BALANCE ----------------
async function getBalances() {
  try {
    const usdcAddress = await arbContract.USDC();
    // Read contract USDC balance
    const contractUSDCContract = new ethers.Contract(usdcAddress, [
      "function balanceOf(address owner) view returns (uint256)"
    ], provider);
    const contractUSDC = await contractUSDCContract.balanceOf(ARB_CONTRACT);
    // Wallet MATIC balance
    const walletMATIC = await provider.getBalance(wallet.address);

    // Normalize
    const decimals = await getUSDCDecimalsIfKnown(usdcAddress);
    const contractUSDCHuman = ethers.formatUnits(contractUSDC, decimals);
    const walletMATICHuman = ethers.formatEther(walletMATIC);

    return {
      contractUSDC: contractUSDCHuman,
      walletMATIC: walletMATICHuman
    };
  } catch (e) {
    console.error("Error fetching balances:", e?.message);
    return {
      contractUSDC: "0",
      walletMATIC: "0"
    };
  }
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
          console.log(`✖ Trade attempt failed at callStatic/execution: ${result.reason}`);
        }

        // Optional small delay to avoid hammering RPC during nested loops
        // await new Promise(r => setTimeout(r, 50));
      }
    }
  }

  const balances = await getBalances();
  console.log(`🔹 Contract USDC balance: ${balances.contractUSDC}`);
  console.log(`🔹 Wallet MATIC balance: ${balances.walletMATIC}`);
}

// ---------------- MAIN LOOP ----------------
async function main() {
  console.log("🚀 Aave Flash Arbitrage Bot - Enhanced on Polygon (ESM)");
  while (true) {
    try {
      await scan();
      await new Promise(r => setTimeout(r, SCAN_DELAY_MS));
    } catch (err) {
      console.error("Error in main loop:", err);
      // brief backoff on unexpected error
      await new Promise(r => setTimeout(r, SCAN_DELAY_MS * 2));
    }
  }
}

main().catch(console.error);

