#!/usr/bin/env node
/**
 * Bidirectional Arbitrage Scanner + Executor
 * Ethers v6 compatible, with safe decimal normalization and live profit detection.
 *
 * Fixes implemented:
 *  - Robust decimal normalization to USDC/TOKEN base units
 *  - Profits computed in USDC smallest units (no floating point)
 *  - MIN_PROFIT_USDC clamped to USDC decimals
 *  - Safe logging that avoids invalid FixedNumber formatting
 *  - Execute only when profit >= MIN_PROFIT_USDC
 *  - Improved error handling and logging
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
    // 1️⃣ Load env vars
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
      : "0.000001"; // at most 6 decimals for USDC

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

    // 4️⃣ Provider + wallet
    const provider = new JsonRpcProvider(rpcUrl);
    const wallet = new Wallet(PRIVATE_KEY.trim(), provider);

    // 5️⃣ ABIs
    const UNIV2_ROUTER_ABI = [
      "function getAmountsOut(uint256 amountIn, address[] calldata path) view returns (uint256[] memory)"
    ];
    const ARB_ABI = [
      "function executeArbitrage(address buyRouter, address sellRouter, address token, uint256 amountIn) external"
    ];

    // 6️⃣ Contract instances
    const buyRouter = new Contract(buyRouterAddr, UNIV2_ROUTER_ABI, provider);
    const sellRouter = new Contract(sellRouterAddr, UNIV2_ROUTER_ABI, provider);
    const arbContract = new Contract(CONTRACT_ADDRESS, ARB_ABI, wallet);

    // 7️⃣ State vars
    let USDC_DECIMALS = 6;
    let TOKEN_DECIMALS = 18;
    let amountInUSDC = null;     // BigInt: amountIn in USDC base units
    let MIN_PROFIT_UNITS = null; // BigInt: minimum profit in USDC base units

    // Helper: keep numbers as strings where possible, but convert when needed
    const decimalString = (input, decimalsGuess = 18) => {
      if (typeof input === "string") {
        if (input.includes("e") || input.includes("E")) {
          const n = Number(input);
          if (Number.isNaN(n)) throw new Error(`invalid numeric input: ${input}`);
          return n.toFixed(decimalsGuess).replace(/(?:\.0+|(\.\d+?)0+)$/, "$1");
        }
        return input;
      }
      if (typeof input === "number") {
        if (!Number.isFinite(input)) throw new Error(`invalid numeric input: ${input}`);
        return input.toFixed(decimalsGuess).replace(/(?:\.0+|(\.\d+?)0+)$/, "$1");
      }
      throw new Error("unsupported input type for decimalString");
    };

    const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

    // 🔟 Init decimals (robust base-unit normalization)
    async function initDecimals() {
      try {
        const decABI = ["function decimals() view returns (uint8)"];
        const usdcDecC = new Contract(usdcAddr, decABI, provider);
        const tokenDecC = new Contract(tokenAddr, decABI, provider);

        const [usdcD, tokenD] = await Promise.all([
          usdcDecC.decimals(),
          tokenDecC.decimals()
        ]);

        USDC_DECIMALS = Number(usdcD);
        TOKEN_DECIMALS = Number(tokenD);

        // Clamp MIN_PROFIT_USDC to USDC decimals
        const safeMinProfitStr = (() => {
          const parts = MIN_PROFIT_USDC_STR.split(".");
          if (parts.length === 2 && parts[1].length > USDC_DECIMALS) {
            const trimmed = `${parts[0]}.${parts[1].slice(0, USDC_DECIMALS)}`;
            console.warn(`⚠️ MIN_PROFIT_USDC precision trimmed to ${USDC_DECIMALS} decimals (${trimmed})`);
            return trimmed;
          }
          return MIN_PROFIT_USDC_STR;
        })();

        // Normalize human amount to USDC base units
        const cleanAmt = decimalString(amountHumanStr, USDC_DECIMALS);
        amountInUSDC = parseUnits(cleanAmt, USDC_DECIMALS);

        // MIN_PROFIT_UNITS is in USDC base units
        MIN_PROFIT_UNITS = parseUnits(safeMinProfitStr, USDC_DECIMALS);

        console.log(`🔧 Decimals initialized: USDC=${USDC_DECIMALS}, TOKEN=${TOKEN_DECIMALS}`);
        console.log(`🔧 amountInUSDC=${amountInUSDC.toString()}`);
        console.log(`🔧 MIN_PROFIT_USDC=${safeMinProfitStr} (base units: ${MIN_PROFIT_UNITS.toString()})`);
      } catch (err) {
        console.error("❌ Failed to initialize decimals:", err);
        throw err;
      }
    }

    // 9️⃣ Arbitrage check
    async function checkArbDirection(buyR, sellR, label) {
      try {
        const pathBuy = [usdcAddr, tokenAddr];
        const pathSell = [tokenAddr, usdcAddr];
        const amountInBase = amountInUSDC;

        const buyOut = await buyR.getAmountsOut(amountInBase, pathBuy);
        const buyTokenOut = buyOut[1];

        const sellOut = await sellR.getAmountsOut(buyTokenOut, pathSell);
        const sellUSDCOut = sellOut[1];

        // Profit in USDC base units (BigInt)
        const profitBase = BigInt(sellUSDCOut.toString()) - BigInt(amountInBase.toString());

        // Human readable values for logging
        const buyTokenHuman = formatUnits(buyTokenOut, TOKEN_DECIMALS);
        const sellUSDCHuman = formatUnits(sellUSDCOut, USDC_DECIMALS);
        const profitHuman = formatUnits(profitBase, USDC_DECIMALS);

        console.log(`${new Date().toISOString()} [${label}] 💱 Buy → ${buyTokenHuman} TOKEN`);
        console.log(`${new Date().toISOString()} [${label}] 💲 Sell → ${sellUSDCHuman} USDC`);
        console.log(`${new Date().toISOString()} [${label}] 🧮 Profit = ${profitHuman} USDC`);

        // Execute only if profitBase >= MIN_PROFIT_UNITS
        if (profitBase >= MIN_PROFIT_UNITS) {
          console.log(`${new Date().toISOString()} [${label}] ✅ Executing arbitrage (profit >= min threshold)...`);
          try {
            const gasEst = await arbContract.estimateGas.executeArbitrage(
              buyR.address, sellR.address, tokenAddr, amountInBase
            );
            const gasLimit = gasEst * 120n / 100n;
            const tx = await arbContract.executeArbitrage(
              buyR.address, sellR.address, tokenAddr, amountInBase, { gasLimit }
            );
            console.log(`${new Date().toISOString()} [${label}] 🧾 TX sent: ${tx.hash}`);
            const rcpt = await tx.wait();
            console.log(`${new Date().toISOString()} [${label}] 🎉 TX confirmed: ${rcpt.transactionHash}`);
          } catch (execErr) {
            console.error(`${new Date().toISOString()} [${label}] ❌ Execution failed: ${execErr.message}`);
          }
        } else {
          console.log(`${new Date().toISOString()} [${label}] 🚫 Not profitable (below threshold).`);
        }
      } catch (err) {
        console.error(`${new Date().toISOString()} [${label}] ⚠️ Arb check error: ${err.message}`);
      }
    }

    // 🔟 Main loop
    async function runLoop() {
      await initDecimals();
      console.log(`${new Date().toISOString()} ▸ 🚀 Starting bidirectional live arbitrage scanner`);
      let iteration = 0;

      while (true) {
        try {
          const block = await provider.getBlockNumber();
          iteration++;
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
