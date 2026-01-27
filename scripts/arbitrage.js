//🟢 Fully functional drop-in arbitrage script with normalized display

// 1️⃣ IMPORTS
import { ethers } from "ethers";

// 2️⃣ RPC + WALLET SETUP
const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

// 3️⃣ CONTRACT ADDRESSES
const VAULT_CONTRACT = "0x621F7ccEb67136f7922E36aF56137e7A1dbA22f1";
const USDC   = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"; // 6 decimals
const WMATIC = "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270"; // 18 decimals

const UNISWAP_V3_ROUTER = "0xE592427A0AEce92De3Edee1F18E0157C05861564";
const UNISWAP_V3_QUOTER = "0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6";
const SUSHI_ROUTER      = "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506";

// 4️⃣ ABIs
const vaultABI = [
  "function executeArbitrage(address,address,uint256,address[],address[],uint256) external",
  "event ArbitrageExecuted(address,address,address,uint256,uint256,uint256,uint256)"
];

const sushiABI = [
  "function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory)"
];

const quoterABI = [
  "function quoteExactInputSingle(address,address,uint24,uint256,uint160) external returns (uint256)"
];

// 5️⃣ CONTRACT INSTANCES
const vault  = new ethers.Contract(VAULT_CONTRACT, vaultABI, wallet);
const sushi  = new ethers.Contract(SUSHI_ROUTER, sushiABI, provider);
const quoter = new ethers.Contract(UNISWAP_V3_QUOTER, quoterABI, provider);

// 6️⃣ BOT CONFIGURATION
const TRADE_SIZE = ethers.parseUnits(".8", 6); // 0.8 USDC
const MIN_SPREAD = 0.0001; // 0.01%
const UNI_FEE    = 3000; // 0.3%
const SLIPPAGE   = 1; // 0.5%

let executing = false;

// 7️⃣ MAIN ARBITRAGE FUNCTION
async function checkAndExecute() {
  if (executing) return;
  executing = true;

  const ts = new Date().toISOString();

  try {
    // 7.1 SushiSwap quote
    const sushiOutRaw = await sushi.getAmountsOut(TRADE_SIZE, [USDC, WMATIC]);
    const sushiWmaticOut = sushiOutRaw[1];

    // 7.2 Uniswap V3 quote
    const uniWmaticOut = await quoter.quoteExactInputSingle.staticCall(
      USDC, WMATIC, UNI_FEE, TRADE_SIZE, 0
    );

    // 7.3 Normalize decimals for display
    const sushiPrice = Number(ethers.formatUnits(TRADE_SIZE, 6)) / Number(ethers.formatUnits(sushiWmaticOut, 18));
    const uniPrice   = Number(ethers.formatUnits(TRADE_SIZE, 6)) / Number(ethers.formatUnits(uniWmaticOut, 18));
    const spread     = ((sushiPrice - uniPrice) / uniPrice) * 100;

    console.log(`[${ts}] UNI: ${uniPrice.toFixed(6)} WMATIC`);
    console.log(`[${ts}] SUSHI: ${sushiPrice.toFixed(6)} WMATIC`);
    console.log(`[${ts}] Spread: ${spread.toFixed(4)}%`);

    // 7.4 Check if spread is profitable
    if (spread < MIN_SPREAD) {
      console.log(`[${ts}] ❌ No executable arbitrage`);
      console.log("──────────────────────────────");
      return;
    }

    console.log(`[${ts}] ✅ ARBITRAGE FOUND`);

    // 7.5 Slippage
    const amountOutMin = Math.floor(Number(uniWmaticOut) * (1 - SLIPPAGE));
    console.log(`[${ts}] Executing TRADE_SIZE: ${TRADE_SIZE.toString()}, Min Output: ${amountOutMin}`);

    // 7.6 Execute on-chain
    console.log(`[${ts}] EXECUTING ON-CHAIN...`);
    const deadline = Math.floor(Date.now() / 1000) + 120;

    const tx = await vault.executeArbitrage(
      UNISWAP_V3_ROUTER, // Buy
      SUSHI_ROUTER,      // Sell
      TRADE_SIZE,
      [USDC, WMATIC],    // Buy path
      [WMATIC, USDC],    // Sell path
      deadline,
      { gasLimit: 1_500_000 }
    );

    console.log(`[${ts}] TX SENT: ${tx.hash}`);
    const receipt = await tx.wait();
    console.log(`[${ts}] TX CONFIRMED: ${receipt.transactionHash}`);
    console.log(`[${ts}] 💰 PROFIT SENT TO VAULT`);
    console.log("──────────────────────────────");

  } catch (err) {
    console.error(`[${ts}] ERROR`, err.reason || err.message || err);
  } finally {
    executing = false;
  }
}

// 8️⃣ RUN MULTIPLE OPPORTUNITIES PER MINUTE (every 5 seconds)
setInterval(checkAndExecute, 5000);
