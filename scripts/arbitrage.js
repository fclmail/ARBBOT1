#!/usr/bin/env node
/**
 * Bidirectional arbitrage scanner + executor
 * Ethers v6 compatible, with explicit decimal normalization and improved logging.
 *
 * Usage: configure env vars and run with Node (ESM).
 *
 * Required env:
 *  - RPC_URL
 *  - PRIVATE_KEY
 *  - BUY_ROUTER
 *  - SELL_ROUTER
 *  - TOKEN
 *  - USDC_ADDRESS
 *  - AMOUNT_IN_HUMAN
 *
 * Optional:
 *  - CONTRACT_ADDRESS (defaults provided)
 *  - MIN_PROFIT_USDC (defaults to "0.0000001" if omitted)
 *  - SCAN_INTERVAL_MS (defaults to 5000)
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
    // ----- 1. Load & validate environment variables -----
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

    // Trim and set local variables
    const rpcUrl = RPC_URL.trim();
    const buyRouterAddr = BUY_ROUTER.trim();
    const sellRouterAddr = SELL_ROUTER.trim();
    const tokenAddr = TOKEN.trim();
    const usdcAddr = USDC_ADDRESS.trim();
    const AMOUNT_HUMAN_STR = AMOUNT_IN_HUMAN.trim();
    const CONTRACT_ADDRESS = (ENV_CONTRACT_ADDRESS || "0x19B64f74553eE0ee26BA01BF34321735E4701C43").trim();
    const SCAN_MS = SCAN_INTERVAL_MS ? Number(SCAN_INTERVAL_MS) : 5000;

    // Keep MIN_PROFIT as a raw string to avoid JS converting to exponential form
    const MIN_PROFIT_USDC_STR = (typeof MIN_PROFIT_USDC === "string" && MIN_PROFIT_USDC.trim() !== "")
      ? MIN_PROFIT_USDC.trim()
      : "0.0000001";

    // ----- 2. Validate addresses -----
    for (const [name, a] of [
      ["BUY_ROUTER", buyRouterAddr],
      ["SELL_ROUTER", sellRouterAddr],
      ["TOKEN", tokenAddr],
      ["USDC_ADDRESS", usdcAddr],
      ["CONTRACT_ADDRESS", CONTRACT_ADDRESS]
    ]) {
      if (!isAddress(a)) {
        console.error(`❌ Invalid Ethereum address for ${name}:`, a);
        process.exit(1);
      }
    }

    // ----- 3. Provider / Wallet -----
    const provider = new JsonRpcProvider(rpcUrl);
    const wallet = new Wallet(PRIVATE_KEY.trim(), provider);

    // ----- 4. ABIs -----
    const UNIV2_ROUTER_ABI = ["function getAmountsOut(uint256 amountIn, address[] calldata path) view returns (uint256[] memory)"];
    const ARB_ABI = ["function executeArbitrage(address buyRouter, address sellRouter, address token, uint256 amountIn) external"];

    // ----- 5. Contracts -----
    const buyRouter = new Contract(buyRouterAddr, UNIV2_ROUTER_ABI, provider);
    const sellRouter = new Contract(sellRouterAddr, UNIV2_ROUTER_ABI, provider);
    const arbContract = new Contract(CONTRACT_ADDRESS, ARB_ABI, wallet); // connected to signer

    // ----- 6. Decimal placeholders & helpers -----
    let USDC_DECIMALS = 6;   // sensible default fallback
    let TOKEN_DECIMALS = 18; // sensible default fallback

    let amountInUSDC = null;   // bigint (base units)
    let MIN_PROFIT_UNITS = null; // bigint (USDC base units)

    // conversion helpers (will be defined after decimals are fetched)
    let toUnitsAny = null;
    let fromUnitsAny = null;

    // Safe decimal to string helper: ensures numeric strings are plain decimals (not exponential)
    // Accepts string or number; returns a plain decimal string.
    function decimalString(input, decimalsGuess = 18) {
      if (typeof input === "string") {
        // assume user provided a decimal representation string
        if (input.includes("e") || input.includes("E")) {
          // If user provided exponential, convert by Number and toFixed (fallback).
          // This is rare because we prefer to keep MIN_PROFIT as string in env.
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
    }

    // ----- 7. Initialize decimals from on-chain -----
    async function initDecimals() {
      try {
        const usdcDecContract = new Contract(usdcAddr, ["function decimals() view returns (uint8)"], provider);
        const tokenDecContract = new Contract(tokenAddr, ["function decimals() view returns (uint8)"], provider);

        const [usdcD, tokenD] = await Promise.all([
          usdcDecContract.decimals(),
          tokenDecContract.decimals()
        ]);

        USDC_DECIMALS = Number(usdcD);
        TOKEN_DECIMALS = Number(tokenD);

        // Define conversion helpers using ethers.parseUnits / formatUnits
        toUnitsAny = (humanStr, decimals) => {
          // Ensure we pass a plain decimal string (no exponential)
          const clean = decimalString(humanStr, Math.max(decimals, 18));
          return parseUnits(clean, decimals);
        };

        fromUnitsAny = (big, decimals) => {
          return formatUnits(big, decimals);
        };

        // amountInUSDC is the amount we input (human AMOUNT_HUMAN_STR interpreted as USDC)
        // Use AMOUNT_HUMAN_STR directly (string) to avoid exponential formatting.
        amountInUSDC = toUnitsAny(AMOUNT_HUMAN_STR, USDC_DECIMALS);

        // Convert MIN_PROFIT to units using string representation to avoid scientific notation
        MIN_PROFIT_UNITS = toUnitsAny(MIN_PROFIT_USDC_STR, USDC_DECIMALS);

        console.log(`🔧 Decimals initialized: USDC=${USDC_DECIMALS}, TOKEN=${TOKEN_DECIMALS}`);
        console.log(`🔧 Amount in (human): ${AMOUNT_HUMAN_STR} -> base units: ${amountInUSDC.toString()}`);
        console.log(`🔧 Min profit (human): ${MIN_PROFIT_USDC_STR} -> base units: ${MIN_PROFIT_UNITS.toString()}`);
      } catch (err) {
        console.error("❌ Failed to initialize decimals:", err);
        throw err;
      }
    }

    // ----- 8. Utility: sleep -----
    const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

    // ----- 9. Single-direction check & execution -----
    /**
     * checkArbDirection(buyRouterContract, sellRouterContract, label)
     * buyRouterContract: router used to buy token with USDC (USDC -> TOKEN)
     * sellRouterContract: router used to sell token back to USDC (TOKEN -> USDC)
     */
    async function checkArbDirection(buyR, sellR, directionLabel) {
      try {
        if (!toUnitsAny) {
          console.warn(`${new Date().toISOString()} [${directionLabel}] ⚠️ Conversions not ready. Skipping.`);
          return;
        }

        // Paths: USDC -> TOKEN -> USDC
        const pathBuy = [usdcAddr, tokenAddr];
        const pathSell = [tokenAddr, usdcAddr];

        // amountInBase is in USDC base units (bigint)
        const amountInBase = amountInUSDC;

        // Query buy router: how many TOKEN do we get for amountInUSDC
        const buyAmounts = await buyR.getAmountsOut(amountInBase, pathBuy);
        // buyAmounts is an array-like: [amountInBase, buyOutToken]
        const buyOutToken = buyAmounts[1];

        // Query sell router: how many USDC do we get selling buyOutToken
        const sellAmounts = await sellR.getAmountsOut(buyOutToken, pathSell);
        const sellOutUSDC = sellAmounts[1];

        // Compute profit in USDC base units (bigint)
        const profitUSDC = BigInt(sellOutUSDC.toString()) - BigInt(amountInBase.toString());

        // Convert for logging to human-readable
        const buyOutHumanToken = fromUnitsAny(buyOutToken, TOKEN_DECIMALS);
        const sellOutHumanUSDC = fromUnitsAny(sellOutUSDC, USDC_DECIMALS);
        const profitHumanUSDC = profitUSDC >= 0n ? fromUnitsAny(profitUSDC.toString(), USDC_DECIMALS) : "-" + fromUnitsAny(((-profitUSDC)).toString(), USDC_DECIMALS);

        console.log(`${new Date().toISOString()} [${directionLabel}] 🔎 In: ${fromUnitsAny(amountInBase, USDC_DECIMALS)} USDC`);
        console.log(`${new Date().toISOString()} [${directionLabel}] 💱 Buy router gives: ${buyOutHumanToken} TOKEN`);
        console.log(`${new Date().toISOString()} [${directionLabel}] 💲 Sell router returns: ${sellOutHumanUSDC} USDC`);
        console.log(`${new Date().toISOString()} [${directionLabel}] 🧮 Profit: ${profitHumanUSDC} USDC (base units: ${profitUSDC.toString()})`);

        // Decide whether to execute
        if (profitUSDC > BigInt(MIN_PROFIT_UNITS.toString())) {
          console.log(`${new Date().toISOString()} [${directionLabel}] ✅ Profit above threshold — executing arbitrage.`);

          try {
            // estimateGas (contract is connected to wallet)
            const gasEst = await arbContract.estimateGas.executeArbitrage(buyR.address, sellR.address, tokenAddr, amountInBase);
            const gasLimit = gasEst * 120n / 100n; // 20% buffer

            const tx = await arbContract.executeArbitrage(buyR.address, sellR.address, tokenAddr, amountInBase, {
              gasLimit
            });

            console.log(`${new Date().toISOString()} [${directionLabel}] 🧾 TX sent: ${tx.hash}`);
            const receipt = await tx.wait();
            console.log(`${new Date().toISOString()} [${directionLabel}] 🎉 TX confirmed: ${receipt.transactionHash}`);
          } catch (execErr) {
            console.error(`${new Date().toISOString()} [${directionLabel}] ❌ Execution failed:`, execErr?.message ?? execErr);
          }
        } else {
          console.log(`${new Date().toISOString()} [${directionLabel}] 🚫 Opportunity not profitable (threshold not met).`);
        }
      } catch (err) {
        console.warn(`${new Date().toISOString()} [${directionLabel}] ⚠️ Router or call failed:`, err?.message ?? err);
      }
    }

    // ----- 10. Main loop -----
    async function runLoop() {
      await initDecimals();

      console.log(`${new Date().toISOString()} ▸ 🚀 Starting bidirectional live arbitrage scanner`);
      let iteration = 0;

      while (true) {
        try {
          const block = await provider.getBlockNumber();
          iteration++;
          console.log(`\n${new Date().toISOString()} [#${iteration}] 🔍 Block ${block} — scanning both directions...`);

          // Direction A→B: buy on buyRouter (USDC->TOKEN), sell on sellRouter (TOKEN->USDC)
          await checkArbDirection(buyRouter, sellRouter, "A→B");

          // Direction B→A: buy on sellRouter, sell on buyRouter
          await checkArbDirection(sellRouter, buyRouter, "B→A");
        } catch (loopErr) {
          console.error(`${new Date().toISOString()} ❌ Error in main loop iteration:`, loopErr?.message ?? loopErr);
        }

        await sleep(SCAN_MS);
      }
    }

    // Start
    runLoop().catch((err) => {
      console.error("❌ Fatal error in main loop:", err);
      process.exit(1);
    });

  } catch (startupErr) {
    console.error("❌ Startup error:", startupErr);
    process.exit(1);
  }
})();
