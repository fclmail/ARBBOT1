import { ethers } from "ethers";

// -------------------------
// CONFIG / ENV
// -------------------------
const RPC_URL = process.env.RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;
const BUY_ROUTER = process.env.BUY_ROUTER;
const SELL_ROUTER = process.env.SELL_ROUTER;
const AMOUNT_IN_USDC = process.env.AMOUNT_IN || "0.1"; // default 0.1 USDC
const MIN_PROFIT_USDC = process.env.MIN_PROFIT_USDC || "0.00001";

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

// Contract ABI (minimal)
const contractAbi = [
  "function executeArbitrage(address buyRouter,address sellRouter,address token,uint256 amountIn) external",
  "function withdrawProfit(address token) external"
];

const contract = new ethers.Contract(CONTRACT_ADDRESS, contractAbi, wallet);

// -------------------------
// TOKEN LIST SAFEGUARD
// -------------------------
const TOKEN_LIST = process.env.TOKEN_LIST
  ? JSON.parse(process.env.TOKEN_LIST)
  : {
      USDC: { address: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", decimals: 6 },
      WETH: { address: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", decimals: 18 },
      WBTC: { address: "0x1BFD67037B42Cf73acF2047067Bd4F2C47D9BfD6", decimals: 8 },
      KLIMA: { address: "0x4e78011Ce80ee02d2c3e649Fb657e45898257815", decimals: 9 },
      DAI: { address: "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063", decimals: 18 },
      CRV: { address: "0x172370d5Cd63279eFa6d502DAB29171933a610AF", decimals: 18 }
    };

// -------------------------
// ROUTER ABI
// -------------------------
const routerAbi = [
  "function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory amounts)"
];

// -------------------------
// STOP FLAG
// -------------------------
let stopBot = false;
process.on("SIGINT", () => {
  console.log("Stopping bot...");
  stopBot = true;
});

// -------------------------
// HELPERS
// -------------------------
async function getTokenDecimals(tokenAddress) {
  if (!tokenAddress) throw new Error("Token address is undefined");
  const token = new ethers.Contract(
    tokenAddress,
    ["function decimals() view returns (uint8)"],
    provider
  );
  return await token.decimals();
}

async function getAmountOut(routerAddress, amountIn, path) {
  const router = new ethers.Contract(routerAddress, routerAbi, provider);
  try {
    const amounts = await router.getAmountsOut(amountIn, path);
    return amounts[amounts.length - 1];
  } catch (e) {
    return BigInt(0);
  }
}

function normalizeAmount(amount, decimals) {
  return Number(ethers.formatUnits(amount, decimals));
}

// -------------------------
// ARBITRAGE LOOP
// -------------------------
async function arbitrageLoop() {
  const amountInUSDC = ethers.parseUnits(AMOUNT_IN_USDC, 6);

  while (!stopBot) {
    console.log("🚀 Starting arbitrage scan...");

    for (const [symbol, meta] of Object.entries(TOKEN_LIST)) {
      try {
        const tokenAddress = meta.address;
        const tokenDecimals = meta.decimals;

        // Path for buy/sell
        const pathBuy = [TOKEN_LIST.USDC.address, tokenAddress];
        const pathSell = [tokenAddress, TOKEN_LIST.USDC.address];

        // RAW getAmountOut
        const buyAmountOutRaw = await getAmountOut(BUY_ROUTER, amountInUSDC, pathBuy);
        const sellAmountOutRaw = await getAmountOut(SELL_ROUTER, buyAmountOutRaw, pathSell);

        const buyAmountNorm = normalizeAmount(buyAmountOutRaw, tokenDecimals);
        const sellAmountNorm = normalizeAmount(sellAmountOutRaw, 6); // USDC

        const profitUSDC = sellAmountNorm - Number(AMOUNT_IN_USDC);

        console.log(`🔎 Token: ${symbol} | Estimated profit: $${profitUSDC.toFixed(6)} USDC`);

        if (profitUSDC >= Number(MIN_PROFIT_USDC)) {
          console.log(`💰 Profit threshold met for ${symbol}, executing arbitrage...`);
          const tx = await contract.executeArbitrage(BUY_ROUTER, SELL_ROUTER, tokenAddress, amountInUSDC, {
            gasLimit: 1000000
          });
          console.log(`✅ Transaction sent: ${tx.hash}`);
          await tx.wait();
          console.log(`✅ Transaction confirmed for ${symbol}`);
        } else {
          console.log(`⚠️ Profit below threshold for ${symbol}, skipping.`);
        }
      } catch (err) {
        console.log(`⚠️ Error for ${symbol}: ${err.message}`);
      }
    }

    await new Promise(resolve => setTimeout(resolve, 2000)); // 2s pause between loops
  }

  console.log("🛑 Bot stopped.");
}

// -------------------------
// START BOT
// -------------------------
(async () => {
  try {
    await arbitrageLoop();
  } catch (err) {
    console.error("Fatal error:", err);
  }
})();
