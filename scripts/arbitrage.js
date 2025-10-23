#!/usr/bin/env node
/**
 * Bidirectional Arbitrage Scanner + Executor
 * Ethers v6 compatible, robust decimal handling, safe execution.
 *
 * Features:
 *  - Predefined token list with addresses + decimals
 *  - Robust decimal normalization (USDC/TOKEN)
 *  - Profits in USDC base units (BigInt)
 *  - MIN_PROFIT_USDC clamped to USDC decimals
 *  - Safe logging with $ display and per-1-USDC calculations
 *  - Execute arbitrage only if profit >= MIN_PROFIT threshold
 *  - Handles router call failures gracefully
 *  - Optional callStatic simulation
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
  USDC: { address: "0x2791bca1f2de4661ed88a30c99a7a9449aa84174", decimals: 6 },
  USDT: { address: "0xc2132d05d31c914a87c6611c10748aeb04b58e8f", decimals: 6 },
  WETH: { address: "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619", decimals: 18 },
  WBTC: { address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", decimals: 8 },
  AAVE: { address: "0xd6df932a45c0f255f85145f286ea0b292b21c90b", decimals: 18 },
  APE: { address: "0x4d224452801aced8b2f0aebe155379bb5d594381", decimals: 18 },
  AXLUSDC: { address: "0x2a2b6055a5c6945f4fe0e814f5d4a13b5a681159", decimals: 6 },
  // ... add rest of your tokens here
};

(async () => {
  try {
    // 1️⃣ Load env vars
    const {
      RPC_URL,
      PRIVATE_KEY,
      BUY_ROUTER,
      SELL_ROUTER,
      TOKEN: TOKEN_ADDRESS,
      USDC_ADDRESS,
      AMOUNT_IN_HUMAN,
      CONTRACT_ADDRESS: ENV_CONTRACT_ADDRESS,
      MIN_PROFIT_USDC,
      SCAN_INTERVAL_MS
    } = process.env;

    const required = { RPC_URL, PRIVATE_KEY, BUY_ROUTER, SELL_ROUTER, TOKEN: TOKEN_ADDRESS, USDC_ADDRESS, AMOUNT_IN_HUMAN };
    const missing = Object.entries(required).filter(([_, v]) => !v).map(([k]) => k);
    if (missing.length > 0) {
      console.error(`❌ Missing required environment variables: ${missing.join(", ")}`);
      process.exit(1);
    }

    // 2️⃣ Normalize env values
    const rpcUrl = RPC_URL.trim();
    const buyRouterAddr = BUY_ROUTER.trim();
    const sellRouterAddr = SELL_ROUTER.trim();
    const tokenAddr = TOKEN_ADDRESS.trim();
    const usdcAddr = USDC_ADDRESS.trim();
    const amountHumanStr = AMOUNT_IN_HUMAN.trim();
    const CONTRACT_ADDRESS = (ENV_CONTRACT_ADDRESS || "0x19B64f74553eE0ee26BA01BF34321735E4701C43").trim();
    const SCAN_MS = SCAN_INTERVAL_MS ? Number(SCAN_INTERVAL_MS) : 5000;
    const MIN_PROFIT_USDC_STR = (typeof MIN_PROFIT_USDC === "string" && MIN_PROFIT_USDC.trim() !== "")
      ? MIN_PROFIT_USDC.trim()
      : "0.000001";

    // 3️⃣ Validate addresses
    for (const [name, addr] of [
      ["BUY_ROUTER", buyRouterAddr],
      ["SELL_ROUTER", sellRouterAddr],
      ["TOKEN", tokenAddr],
      ["USDC_ADDRESS", usdcAddr],
      ["CONTRACT_ADDRESS", CONTRACT_ADDRESS]
    ]) {
      if (!isAddress(addr)) {
        console.error(`❌ Invalid Ethereum address for ${name}:`, addr);
        process.exit(1);
      }
    }

    // 4️⃣ Check token exists in list
    const TOKEN_INFO = Object.values(TOKENS).find(t => t.address.toLowerCase() === tokenAddr.toLowerCase());
    if (!TOKEN_INFO) {
      console.error(`❌ Token ${tokenAddr} not found in TOKENS list`);
      process.exit(1);
    }

    const USDC_INFO = Object.values(TOKENS).find(t => t.address.toLowerCase() === usdcAddr.toLowerCase());
    if (!USDC_INFO) {
      console.error(`❌ USDC token ${usdcAddr} not found in TOKENS list`);
      process.exit(1);
    }

    const USDC_DECIMALS = USDC_INFO.decimals;
    const TOKEN_DECIMALS = TOKEN_INFO.decimals;

    // 5️⃣ Provider + wallet
    const provider = new JsonRpcProvider(rpcUrl);
    const wallet = new Wallet(PRIVATE_KEY.trim(), provider);

    // 6️⃣ ABIs
    const UNIV2_ROUTER_ABI = ["function getAmountsOut(uint256 amountIn, address[] calldata path) view returns (uint256[] memory)"];
    const ARB_ABI = ["function executeArbitrage(address buyRouter, address sellRouter, address token, uint256 amountIn) external"];

    const buyRouter = new Contract(buyRouterAddr, UNIV2_ROUTER_ABI, provider);
    const sellRouter = new Contract(sellRouterAddr, UNIV2_ROUTER_ABI, provider);
    const arbContract = new Contract(CONTRACT_ADDRESS, ARB_ABI, wallet);

    // 7️⃣ BigInt amounts
    const amountInUSDC = parseUnits(amountHumanStr, USDC_DECIMALS);
    const MIN_PROFIT_UNITS = parseUnits(MIN_PROFIT_USDC_STR, USDC_DECIMALS);

    console.log(`🔧 Decimals: USDC=${USDC_DECIMALS}, TOKEN=${TOKEN_DECIMALS}`);
    console.log(`🔧 Trade Amount: $${amountHumanStr}`);
    console.log(`🔧 MIN_PROFIT_USDC: $${MIN_PROFIT_USDC_STR} (base units: ${MIN_PROFIT_UNITS})`);

    const sleep = (ms) => new Promise(res => setTimeout(res, ms));

    // 8️⃣ Arbitrage check
    async function checkArbDirection(buyR, sellR, label) {
      try {
        const pathBuy = [usdcAddr, tokenAddr];
        const pathSell = [tokenAddr, usdcAddr];

        const safeGetAmountsOut = async (router, amountIn, path) => {
          try {
            const amounts = await router.getAmountsOut(amountIn, path);
            return amounts && amounts.length >= 2 ? amounts : null;
          } catch {
            return null;
          }
        };

        const buyOut = await safeGetAmountsOut(buyR, amountInUSDC, pathBuy);
        if (!buyOut) return console.warn(`${label} ⚠️ Buy router call failed`);

        const buyTokenOut = BigInt(buyOut[1].toString());

        const sellOut = await safeGetAmountsOut(sellR, buyTokenOut, pathSell);
        if (!sellOut) return console.warn(`${label} ⚠️ Sell router call failed`);

        const sellUSDCOut = BigInt(sellOut[1].toString());

        // Profit in USDC base units
        const profitBase = sellUSDCOut - amountInUSDC;
        const profitPercent = Number(formatUnits(profitBase, USDC_DECIMALS)) / Number(formatUnits(amountInUSDC, USDC_DECIMALS)) * 100;

        // How much token per $1 USDC
        const tokenPer1USDC = buyTokenOut * 1000000n / amountInUSDC;
        const tokenPer1Human = formatUnits(tokenPer1USDC, TOKEN_DECIMALS);

        console.log(`${new Date().toISOString()} [${label}] 💱 Buy → $${formatUnits(amountInUSDC, USDC_DECIMALS)} → ${formatUnits(buyTokenOut, TOKEN_DECIMALS)} TOKEN (~$${tokenPer1Human} per $1)`);
        console.log(`${new Date().toISOString()} [${label}] 💲 Sell → $${formatUnits(sellUSDCOut, USDC_DECIMALS)} USDC`);
        console.log(`${new Date().toISOString()} [${label}] 🧮 Profit → $${formatUnits(profitBase, USDC_DECIMALS)} (${profitPercent.toFixed(2)}%)`);

        // CallStatic simulation
        try {
          await arbContract.callStatic.executeArbitrage(buyR.address, sellR.address, tokenAddr, amountInUSDC);
        } catch (simErr) {
          console.warn(`${new Date().toISOString()} [${label}] ⚠️ Simulation failed: ${simErr.message}`);
        }

        if (profitBase >= MIN_PROFIT_UNITS) {
          console.log(`${new Date().toISOString()} [${label}] ✅ Executing arbitrage...`);
          try {
            const gasEst = await arbContract.estimateGas.executeArbitrage(buyR.address, sellR.address, tokenAddr, amountInUSDC);
            const gasLimit = gasEst * 120n / 100n;
            const tx = await arbContract.executeArbitrage(buyR.address, sellR.address, tokenAddr, amountInUSDC, { gasLimit });
            console.log(`${new Date().toISOString()} [${label}] 🧾 TX sent: ${tx.hash}`);
            const receipt = await tx.wait();
            console.log(`${new Date().toISOString()} [${label}] 🎉 TX confirmed: ${receipt.transactionHash}`);
          } catch (execErr) {
            console.error(`${new Date().toISOString()} [${label}] ❌ Execution failed: ${execErr.message}`);
          }
        } else {
          console.log(`${new Date().toISOString()} [${label}] 🚫 Not profitable (below threshold).`);
        }

      } catch (err) {
        console.error(`${new Date().toISOString()} [${label}] ⚠️ Arbitrage check error: ${err.message}`);
      }
    }

    // 9️⃣ Main loop
    async function runLoop() {
      console.log(`${new Date().toISOString()} ▸ 🚀 Starting bidirectional live arbitrage scanner`);
      let iteration = 0;
      while (true) {
        iteration++;
        const block = await provider.getBlockNumber();
        console.log(`\n${new Date().toISOString()} [#${iteration}] 🔍 Block ${block}: scanning both directions...`);
        await checkArbDirection(buyRouter, sellRouter, "A→B");
        await checkArbDirection(sellRouter, buyRouter, "B→A");
        await sleep(SCAN_MS);
      }
    }

    await runLoop();

  } catch (fatal) {
    console.error("❌ Fatal startup error:", fatal);
    process.exit(1);
  }
})();


