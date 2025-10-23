#!/usr/bin/env node
/**
 * Bidirectional Arbitrage Scanner + Executor
 * Ethers v6 compatible
 */

import {
  JsonRpcProvider,
  Wallet,
  Contract,
  parseUnits,
  formatUnits,
  isAddress
} from "ethers";

const TOKENS = {
  USDC: { address:"0x2791bca1f2de4661ed88a30c99a7a9449aa84174", decimals:6 },
  USDT: { address:"0xc2132d05d31c914a87c6611c10748aeb04b58e8f", decimals:6 },
  WBTC: { address:"0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", decimals:8 },
  WETH: { address:"0x7ceb23fd6bc0add59e62ac25578270cff1b9f619", decimals:18 },
  // Add other tokens here as needed
};

(async () => {
  try {
    // 1️⃣ Load environment variables
    const {
      RPC_URL,
      PRIVATE_KEY,
      BUY_ROUTER,
      SELL_ROUTER,
      TOKEN,
      USDC_ADDRESS,
      AMOUNT_IN_HUMAN,
      CONTRACT_ADDRESS: ENV_CONTRACT_ADDRESS,
      MIN_PROFIT_USDC,
      SCAN_INTERVAL_MS
    } = process.env;

    const required = { RPC_URL, PRIVATE_KEY, BUY_ROUTER, SELL_ROUTER, TOKEN, USDC_ADDRESS, AMOUNT_IN_HUMAN, CONTRACT_ADDRESS: ENV_CONTRACT_ADDRESS };
    const missing = Object.entries(required)
      .filter(([_, v]) => !v || v.trim() === "")
      .map(([k]) => k);

    if (missing.length > 0) {
      console.error(`❌ Missing required environment variables: ${missing.join(", ")}`);
      process.exit(1);
    }

    // 2️⃣ Validate and parse addresses
    function parseAddress(name, value) {
      const addr = value.trim();
      if (!isAddress(addr)) {
        console.error(`❌ Invalid Ethereum address for ${name}: '${value}'`);
        process.exit(1);
      }
      return addr;
    }

    const rpcUrl = RPC_URL.trim();
    const buyRouterAddr = parseAddress("BUY_ROUTER", BUY_ROUTER);
    const sellRouterAddr = parseAddress("SELL_ROUTER", SELL_ROUTER);
    const tokenAddr = parseAddress("TOKEN", TOKEN);
    const usdcAddr = parseAddress("USDC_ADDRESS", USDC_ADDRESS);
    const CONTRACT_ADDRESS = parseAddress("CONTRACT_ADDRESS", ENV_CONTRACT_ADDRESS);
    const amountHumanStr = AMOUNT_IN_HUMAN.trim();
    const SCAN_MS = SCAN_INTERVAL_MS ? Number(SCAN_INTERVAL_MS) : 5000;
    const MIN_PROFIT_USDC_STR = (MIN_PROFIT_USDC && MIN_PROFIT_USDC.trim() !== "") ? MIN_PROFIT_USDC.trim() : "0.000001";

    // 3️⃣ Get token decimals from TOKENS list
    if (!Object.values(TOKENS).some(t => t.address.toLowerCase() === tokenAddr.toLowerCase())) {
      console.error(`❌ Token ${tokenAddr} not found in TOKENS list`);
      process.exit(1);
    }
    const TOKEN_DECIMALS = Object.values(TOKENS).find(t => t.address.toLowerCase() === tokenAddr.toLowerCase()).decimals;
    const USDC_DECIMALS = TOKENS.USDC.decimals;

    console.log(`🔧 Decimals: USDC=${USDC_DECIMALS}, TOKEN=${TOKEN_DECIMALS}`);
    console.log(`🔧 Trade Amount: $${amountHumanStr}`);
    console.log(`🔧 MIN_PROFIT_USDC: $${MIN_PROFIT_USDC_STR}`);

    // 4️⃣ Provider & wallet
    const provider = new JsonRpcProvider(rpcUrl);
    const wallet = new Wallet(PRIVATE_KEY.trim(), provider);

    // 5️⃣ ABIs
    const UNIV2_ROUTER_ABI = ["function getAmountsOut(uint256 amountIn, address[] calldata path) view returns (uint256[] memory)"];
    const ARB_ABI = ["function executeArbitrage(address buyRouter, address sellRouter, address token, uint256 amountIn) external"];

    // 6️⃣ Contracts
    const buyRouter = new Contract(buyRouterAddr, UNIV2_ROUTER_ABI, provider);
    const sellRouter = new Contract(sellRouterAddr, UNIV2_ROUTER_ABI, provider);
    const arbContract = new Contract(CONTRACT_ADDRESS, ARB_ABI, wallet);

    // 7️⃣ Trade amounts
    const amountInUSDC = parseUnits(amountHumanStr, USDC_DECIMALS);
    const MIN_PROFIT_UNITS = parseUnits(MIN_PROFIT_USDC_STR, USDC_DECIMALS);

    const sleep = ms => new Promise(res => setTimeout(res, ms));

    // 8️⃣ Arbitrage check function
    async function checkArbDirection(buyR, sellR, label) {
      try {
        const pathBuy = [usdcAddr, tokenAddr];
        const pathSell = [tokenAddr, usdcAddr];

        // Safe getAmountsOut wrapper
        const safeGetAmountsOut = async (router, amountIn, path) => {
          try {
            const amounts = await router.getAmountsOut(amountIn, path);
            if (!amounts || amounts.length < 2 || BigInt(amounts[1].toString()) === 0n) return null;
            return amounts;
          } catch {
            return null;
          }
        };

        const buyOut = await safeGetAmountsOut(buyR, amountInUSDC, pathBuy);
        if (!buyOut) return console.warn(`${label} ⚠️ Buy router failed or returned 0`);
        const buyTokenOut = BigInt(buyOut[1].toString());

        const sellOut = await safeGetAmountsOut(sellR, buyTokenOut, pathSell);
        if (!sellOut) return console.warn(`${label} ⚠️ Sell router failed or returned 0`);
        const sellUSDCOut = BigInt(sellOut[1].toString());

        // Profit
        const profitBase = sellUSDCOut - amountInUSDC;
        const profitPercent = Number(formatUnits(profitBase, USDC_DECIMALS)) / Number(formatUnits(amountInUSDC, USDC_DECIMALS)) * 100;

        // USDC per token
        const tokenPer1USDC = buyTokenOut * 10n ** BigInt(USDC_DECIMALS) / amountInUSDC;

        console.log(`${new Date().toISOString()} [${label}] 💱 Buy → $${formatUnits(buyTokenOut, TOKEN_DECIMALS)} TOKEN (~$${formatUnits(tokenPer1USDC, TOKEN_DECIMALS)} per $1)`);
        console.log(`${new Date().toISOString()} [${label}] 💲 Sell → $${formatUnits(sellUSDCOut, USDC_DECIMALS)} USDC`);
        console.log(`${new Date().toISOString()} [${label}] 🧮 Profit → $${formatUnits(profitBase, USDC_DECIMALS)} (${profitPercent.toFixed(2)}%)`);

        // Optional: simulate via callStatic
        try {
          await arbContract.callStatic.executeArbitrage(buyR.address, sellR.address, tokenAddr, amountInUSDC);
        } catch (simErr) {
          console.warn(`${label} ⚠️ Simulation failed: ${simErr.message}`);
        }

        if (profitBase >= MIN_PROFIT_UNITS) {
          console.log(`${new Date().toISOString()} [${label}] ✅ Profitable, ready to execute.`);
        } else {
          console.log(`${new Date().toISOString()} [${label}] 🚫 Not profitable (below threshold).`);
        }
      } catch (err) {
        console.error(`${new Date().toISOString()} [${label}] ⚠️ Arbitrage check error: ${err.message}`);
      }
    }

    // 9️⃣ Main loop
    let iteration = 0;
    while (true) {
      iteration++;
      try {
        const block = await provider.getBlockNumber();
        console.log(`\n${new Date().toISOString()} [#${iteration}] 🔍 Block ${block}: scanning both directions...`);
        await checkArbDirection(buyRouter, sellRouter, "A→B");
        await checkArbDirection(sellRouter, buyRouter, "B→A");
      } catch (err) {
        console.error(`${new Date().toISOString()} ❌ Loop error: ${err.message}`);
      }
      await sleep(SCAN_MS);
    }

  } catch (fatal) {
    console.error("❌ Fatal startup error:", fatal);
    process.exit(1);
  }
})();


