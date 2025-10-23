#!/usr/bin/env node
/**
 * Bidirectional Arbitrage Scanner + Executor
 * Ethers v6 compatible, robust decimal handling, safe execution, callStatic simulation.
 *
 * Features:
 *  - Decimal normalization (USDC/TOKEN)
 *  - Profits in USDC base units (BigInt)
 *  - MIN_PROFIT_USDC clamped to USDC decimals
 *  - Safe logging: USD amounts with $ sign
 *  - Shows token per $1
 *  - callStatic simulation to detect profitable trades
 *  - Executes only when profit >= threshold
 */

import {
  JsonRpcProvider,
  Wallet,
  Contract,
  parseUnits,
  formatUnits,
  isAddress
} from "ethers";

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

    const required = { RPC_URL, PRIVATE_KEY, BUY_ROUTER, SELL_ROUTER, TOKEN, USDC_ADDRESS, AMOUNT_IN_HUMAN };
    const missing = Object.entries(required).filter(([_, v]) => !v).map(([k]) => k);
    if (missing.length > 0) {
      console.error(`❌ Missing required environment variables: ${missing.join(", ")}`);
      process.exit(1);
    }

    // 2️⃣ Normalize env values
    const rpcUrl = RPC_URL.trim();
    const buyRouterAddr = BUY_ROUTER.trim();
    const sellRouterAddr = SELL_ROUTER.trim();
    const tokenAddr = TOKEN.trim();
    const usdcAddr = USDC_ADDRESS.trim();
    const amountHumanStr = AMOUNT_IN_HUMAN.trim();
    const CONTRACT_ADDRESS = (ENV_CONTRACT_ADDRESS || "0x19B64f74553eE0ee26BA01BF34321735E4701C43").trim();
    const SCAN_MS = SCAN_INTERVAL_MS ? Number(SCAN_INTERVAL_MS) : 5000;
    const MIN_PROFIT_USDC_STR = (typeof MIN_PROFIT_USDC === "string" && MIN_PROFIT_USDC.trim() !== "")
      ? MIN_PROFIT_USDC.trim()
      : "0.000001";

    // 3️⃣ Validate Ethereum addresses
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

    // 4️⃣ Provider + wallet
    const provider = new JsonRpcProvider(rpcUrl);
    const wallet = new Wallet(PRIVATE_KEY.trim(), provider);

    // 5️⃣ ABIs
    const UNIV2_ROUTER_ABI = ["function getAmountsOut(uint256 amountIn, address[] calldata path) view returns (uint256[] memory)"];
    const ARB_ABI = ["function executeArbitrage(address buyRouter, address sellRouter, address token, uint256 amountIn) external"];

    // 6️⃣ Contracts
    const buyRouter = new Contract(buyRouterAddr, UNIV2_ROUTER_ABI, provider);
    const sellRouter = new Contract(sellRouterAddr, UNIV2_ROUTER_ABI, provider);
    const arbContract = new Contract(CONTRACT_ADDRESS, ARB_ABI, wallet);

    // 7️⃣ State variables
    let USDC_DECIMALS = 6;
    let TOKEN_DECIMALS = 18;
    let amountInUSDC = null;      // BigInt
    let MIN_PROFIT_UNITS = null;  // BigInt

    const sleep = (ms) => new Promise(res => setTimeout(res, ms));

    // 8️⃣ Helper: clamp decimal string
    const clampDecimalString = (inputStr, decimals) => {
      const parts = inputStr.split(".");
      if (parts.length === 2 && parts[1].length > decimals) {
        return `${parts[0]}.${parts[1].slice(0, decimals)}`;
      }
      return inputStr;
    };

    // 9️⃣ Initialize decimals
    async function initDecimals() {
      try {
        const decABI = ["function decimals() view returns (uint8)"];
        const usdcDecC = new Contract(usdcAddr, decABI, provider);
        const tokenDecC = new Contract(tokenAddr, decABI, provider);

        const [usdcD, tokenD] = await Promise.all([usdcDecC.decimals(), tokenDecC.decimals()]);
        USDC_DECIMALS = Number(usdcD);
        TOKEN_DECIMALS = Number(tokenD);

        const safeMinProfitStr = clampDecimalString(MIN_PROFIT_USDC_STR, USDC_DECIMALS);
        amountInUSDC = parseUnits(clampDecimalString(amountHumanStr, USDC_DECIMALS), USDC_DECIMALS);
        MIN_PROFIT_UNITS = parseUnits(safeMinProfitStr, USDC_DECIMALS);

        console.log(`🔧 Decimals initialized: USDC=${USDC_DECIMALS}, TOKEN=${TOKEN_DECIMALS}`);
        console.log(`🔧 Trade Amount: $${formatUnits(amountInUSDC, USDC_DECIMALS)}`);
        console.log(`🔧 MIN_PROFIT_USDC: $${safeMinProfitStr} (base units: ${MIN_PROFIT_UNITS.toString()})`);
      } catch (err) {
        console.error("❌ Failed to initialize decimals:", err);
        throw err;
      }
    }

    // 🔟 Arbitrage check
    async function checkArbDirection(buyR, sellR, label) {
      try {
        const pathBuy = [usdcAddr, tokenAddr];
        const pathSell = [tokenAddr, usdcAddr];

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
        if (!buyOut) {
          console.warn(`${label} ⚠️ Buy router call failed or returned 0`);
          return;
        }
        const buyTokenOut = BigInt(buyOut[1].toString());

        const sellOut = await safeGetAmountsOut(sellR, buyTokenOut, pathSell);
        if (!sellOut) {
          console.warn(`${label} ⚠️ Sell router call failed or returned 0`);
          return;
        }
        const sellUSDCOut = BigInt(sellOut[1].toString());

        // Profit in USDC base units
        const profitBase = sellUSDCOut - amountInUSDC;
        const profitPercent = Number(formatUnits(profitBase, USDC_DECIMALS)) / Number(formatUnits(amountInUSDC, USDC_DECIMALS)) * 100;

        // USD equivalents
        const buyTokenHuman = formatUnits(buyTokenOut, TOKEN_DECIMALS);
        const sellUSDCHuman = formatUnits(sellUSDCOut, USDC_DECIMALS);
        const profitHuman = formatUnits(profitBase, USDC_DECIMALS);
        const per1USDToken = Number(formatUnits(buyTokenOut, TOKEN_DECIMALS)) / Number(formatUnits(amountInUSDC, USDC_DECIMALS));

        console.log(`${new Date().toISOString()} [${label}] 💱 Buy → $${formatUnits(amountInUSDC, USDC_DECIMALS)} → ${buyTokenHuman} TOKEN (~$${per1USDToken.toFixed(6)} per $1)`);
        console.log(`${new Date().toISOString()} [${label}] 💲 Sell → $${sellUSDCHuman} USDC`);
        console.log(`${new Date().toISOString()} [${label}] 🧮 Profit → $${profitHuman} USDC (${profitPercent.toFixed(2)}%)`);

        // callStatic simulation
        try {
          const staticRes = await arbContract.callStatic.executeArbitrage(buyR.address, sellR.address, tokenAddr, amountInUSDC);
          console.log(`${new Date().toISOString()} [${label}] ⚡ callStatic simulation result: $${formatUnits(staticRes, USDC_DECIMALS)} USDC`);
        } catch (simErr) {
          console.warn(`${new Date().toISOString()} [${label}] ⚠️ Simulation failed: ${simErr.message}`);
        }

        // Execute only if profit meets threshold
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

    // 11️⃣ Main scanning loop
    async function runLoop() {
      await initDecimals();
      console.log(`${new Date().toISOString()} ▸ 🚀 Starting bidirectional live arbitrage scanner`);

      let iteration = 0;
      while (true) {
        try {
          iteration++;
          const block = await provider.getBlockNumber();
          console.log(`\n${new Date().toISOString()} [#${iteration}] 🔍 Block ${block}: scanning both directions...`);
          await checkArbDirection(buyRouter, sellRouter, "A→B");
          await checkArbDirection(sellRouter, buyRouter, "B→A");
        } catch (err) {
          console.error(`${new Date().toISOString()} ❌ Loop error: ${err.message}`);
        }
        await sleep(SCAN_MS);
      }
    }

    await runLoop();

  } catch (fatal) {
    console.error("❌ Fatal startup error:", fatal);
    process.exit(1);
  }
})();



