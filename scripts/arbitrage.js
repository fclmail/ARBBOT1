import { ethers } from "ethers";
import axios from "axios";

// ---------------- CONFIG ----------------
const RPC_URL = "https://your_rpc_url"; // Polygon / Ethereum RPC
const WALLET_PRIVATE_KEY = "your_private_key";
const CONTRACT_ADDRESS = "0x7DadE334120e659eDE4999c8813c183648b1bd19";
const USDC_ADDRESS = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"; // change if needed

const SLIPPAGE_PERCENT = 0.2; // 0.2%
const TRADE_AMOUNT_USDC = 0.01; // per trade
const ROUTERS = {
  quickSwap: "0xYourQuickSwapRouter",
  sushiSwap: "0xYourSushiSwapRouter",
  apeSwap: "0xYourApeSwapRouter"
};

// Load ABI from Contract 2
import arbAbi from "./Contract2ABI.json";

// ---------------- SETUP PROVIDER ----------------
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);
const contract = new ethers.Contract(CONTRACT_ADDRESS, arbAbi, wallet);

// ---------------- HELPER FUNCTIONS ----------------
function parseUSDC(amount) {
  // USDC has 6 decimals
  return ethers.parseUnits(amount.toFixed(6), 6);
}

function formatUSDC(amountBN) {
  return Number(ethers.formatUnits(amountBN, 6));
}

// Mock function to get prices from pools
async function getTokenPrice(tokenAddress, router) {
  // Replace with real price fetching logic
  const response = await axios.get("https://api.yourdex.com/price", {
    params: { token: tokenAddress, router: router }
  });
  return parseFloat(response.data.price);
}

// ---------------- ARBITRAGE LOGIC ----------------
async function scanAndExecuteArbitrage() {
  try {
    const vaultBalanceBN = await contract.USDC().then(async (usdc) => {
      const usdcContract = new ethers.Contract(usdc, [
        "function balanceOf(address owner) view returns (uint256)"
      ], provider);
      return await usdcContract.balanceOf(CONTRACT_ADDRESS);
    });

    const vaultBalance = formatUSDC(vaultBalanceBN);
    console.log("🏦 Vault Balance Before:", vaultBalance, "USDC");

    // List of tokens to scan (example)
    const tokens = [
      { symbol: "LINK", address: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39" },
      { symbol: "WBTC", address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6" }
    ];

    for (const token of tokens) {
      const prices = {};
      for (const routerName in ROUTERS) {
        prices[routerName] = await getTokenPrice(token.address, ROUTERS[routerName]);
      }

      // Find arbitrage opportunities
      for (const buyRouter in prices) {
        for (const sellRouter in prices) {
          if (buyRouter === sellRouter) continue;
          const buyPrice = prices[buyRouter];
          const sellPrice = prices[sellRouter];
          const expectedProfit = TRADE_AMOUNT_USDC * (sellPrice / buyPrice - 1);

          if (expectedProfit <= 0) continue; // skip losing trades

          const minReturnUSDC = parseUSDC(expectedProfit * (1 - SLIPPAGE_PERCENT / 100));
          const amountInUSDC = parseUSDC(TRADE_AMOUNT_USDC);

          console.log(`🚨 PROFITABLE: ${token.symbol} | ${buyRouter} → ${sellRouter} | est profit: ${expectedProfit.toFixed(6)} USDC`);

          // Execute arbitrage
          try {
            const tx = await contract.executeArbitrage(
              ROUTERS[buyRouter],
              ROUTERS[sellRouter],
              token.address,
              amountInUSDC,
              minReturnUSDC
            );
            console.log("🔹 Transaction sent:", tx.hash);
            await tx.wait();
            console.log("✅ Trade executed successfully!");
          } catch (err) {
            console.error("❌ Trade failed:", err.reason || err.message);
          }
        }
      }
    }
  } catch (err) {
    console.error("⚠️ Scan failed:", err.message);
  }
}

// ---------------- LOOP ----------------
(async () => {
  while (true) {
    await scanAndExecuteArbitrage();
    await new Promise(r => setTimeout(r, 5000)); // scan every 5 seconds
  }
})();
