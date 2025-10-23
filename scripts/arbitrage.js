#!/usr/bin/env node
/**
 * Bidirectional Arbitrage Scanner + Executor with callStatic simulation
 * Logs all amounts in USDC
 */

import { JsonRpcProvider, Wallet, Contract, parseUnits, formatUnits, isAddress } from "ethers";

(async () => {
  try {
    // 1️⃣ Load environment variables
    const {
      RPC_URL,
      PRIVATE_KEY,
      BUY_ROUTER,
      SELL_ROUTER,
      TOKEN, // token address
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

    const rpcUrl = RPC_URL.trim();
    const buyRouterAddr = BUY_ROUTER.trim();
    const sellRouterAddr = SELL_ROUTER.trim();
    const tokenAddr = TOKEN.trim();
    const usdcAddr = USDC_ADDRESS.trim();
    const amountHumanStr = AMOUNT_IN_HUMAN.trim();
    const CONTRACT_ADDRESS = (ENV_CONTRACT_ADDRESS || "").trim();
    const SCAN_MS = SCAN_INTERVAL_MS ? Number(SCAN_INTERVAL_MS) : 5000;
    const MIN_PROFIT_USDC_STR = MIN_PROFIT_USDC?.trim() || "0.000001";

    // 2️⃣ Validate addresses
    for (const [name, addr] of [
      ["BUY_ROUTER", buyRouterAddr],
      ["SELL_ROUTER", sellRouterAddr],
      ["TOKEN", tokenAddr],
      ["USDC_ADDRESS", usdcAddr]
    ]) {
      if (!isAddress(addr)) {
        console.error(`❌ Invalid Ethereum address for ${name}: ${addr}`);
        process.exit(1);
      }
    }

    // 3️⃣ Provider and wallet
    const provider = new JsonRpcProvider(rpcUrl);
    const wallet = new Wallet(PRIVATE_KEY.trim(), provider);

    // 4️⃣ ABIs
    const UNIV2_ROUTER_ABI = ["function getAmountsOut(uint256 amountIn, address[] calldata path) view returns (uint256[] memory)"];
    const ARB_ABI = ["function executeArbitrage(address buyRouter, address sellRouter, address token, uint256 amountIn) external"];

    const buyRouter = new Contract(buyRouterAddr, UNIV2_ROUTER_ABI, provider);
    const sellRouter = new Contract(sellRouterAddr, UNIV2_ROUTER_ABI, provider);
    const arbContract = new Contract(CONTRACT_ADDRESS, ARB_ABI, wallet);

    // 5️⃣ Token list with decimals
    const TOKENS = {
      AAVE:{address:"0xd6df932a45c0f255f85145f286ea0b292b21c90b",decimals:18},
      APE:{address:"0x4d224452801aced8b2f0aebe155379bb5d594381",decimals:18},
      AXLUSDC:{address:"0x2a2b6055a5c6945f4fe0e814f5d4a13b5a681159",decimals:6},
      USDC:{address:"0x2791bca1f2de4661ed88a30c99a7a9449aa84174",decimals:6},
      USDT:{address:"0xc2132d05d31c914a87c6611c10748aeb04b58e8f",decimals:6},
      WBTC:{address:"0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6",decimals:8},
      WETH:{address:"0x7ceb23fd6bc0add59e62ac25578270cff1b9f619",decimals:18},
      // ... include all other tokens here
    };

    const tokenEntry = Object.values(TOKENS).find(t => t.address.toLowerCase() === tokenAddr.toLowerCase());
    if (!tokenEntry) {
      console.error(`❌ Token ${tokenAddr} not found in TOKENS list`);
      process.exit(1);
    }

    const TOKEN_DECIMALS = tokenEntry.decimals;
    const USDC_DECIMALS = TOKENS.USDC.decimals;

    // 6️⃣ Amounts
    const amountInUSDC = parseUnits(amountHumanStr, USDC_DECIMALS);
    const MIN_PROFIT_UNITS = parseUnits(MIN_PROFIT_USDC_STR, USDC_DECIMALS);

    console.log(`🔧 Decimals: USDC=${USDC_DECIMALS}, TOKEN=${TOKEN_DECIMALS}`);
    console.log(`🔧 Trade Amount: $${amountHumanStr}`);
    console.log(`🔧 MIN_PROFIT_USDC: $${MIN_PROFIT_USDC_STR} (base units: ${MIN_PROFIT_UNITS.toString()})`);

    const sleep = (ms) => new Promise(res => setTimeout(res, ms));

    // 7️⃣ Arbitrage checker
    async function checkArbDirection(buyR, sellR, label) {
      const pathBuy = [usdcAddr, tokenAddr];
      const pathSell = [tokenAddr, usdcAddr];

      try {
        // Safe getAmountsOut
        const buyOut = await buyR.getAmountsOut(amountInUSDC, pathBuy);
        const buyTokenOut = BigInt(buyOut[1].toString());

        const sellOut = await sellR.getAmountsOut(buyTokenOut, pathSell);
        const sellUSDCOut = BigInt(sellOut[1].toString());

        const profitBase = sellUSDCOut - amountInUSDC;

        const tokenPer1USDC = Number(buyTokenOut) / Number(amountInUSDC); // approximate

        console.log(`${new Date().toISOString()} [${label}] 💱 Buy → $${formatUnits(amountInUSDC, USDC_DECIMALS)} → ${formatUnits(buyTokenOut, TOKEN_DECIMALS)} TOKEN (~$${(1/tokenPer1USDC).toFixed(6)} per TOKEN)`);
        console.log(`${new Date().toISOString()} [${label}] 💲 Sell → $${formatUnits(sellUSDCOut, USDC_DECIMALS)} USDC`);
        console.log(`${new Date().toISOString()} [${label}] 🧮 Profit → $${formatUnits(profitBase, USDC_DECIMALS)} (${(Number(formatUnits(profitBase, USDC_DECIMALS))/Number(formatUnits(amountInUSDC, USDC_DECIMALS))*100).toFixed(2)}%)`);

        // ✅ CallStatic simulation
        let canExecute = false;
        try {
          await arbContract.callStatic.executeArbitrage(buyR.address, sellR.address, tokenAddr, amountInUSDC);
          console.log(`${new Date().toISOString()} [${label}] ✅ Simulation success: arbitrage would succeed`);
          canExecute = true;
        } catch (simErr) {
          console.warn(`${new Date().toISOString()} [${label}] ⚠️ Simulation failed: ${simErr.message}`);
        }

        if (profitBase >= MIN_PROFIT_UNITS && canExecute) {
          console.log(`${new Date().toISOString()} [${label}] ✅ Ready to execute on-chain`);
          // optionally send tx here
        } else {
          console.log(`${new Date().toISOString()} [${label}] 🚫 Not profitable or simulation failed`);
        }

      } catch (err) {
        console.error(`${new Date().toISOString()} [${label}] ⚠️ Arbitrage check error: ${err.message}`);
      }
    }

    // 8️⃣ Main scanning loop
    async function runLoop() {
      console.log(`${new Date().toISOString()} ▸ 🚀 Starting bidirectional live arbitrage scanner`);

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
    }

    await runLoop();

  } catch (fatal) {
    console.error("❌ Fatal startup error:", fatal);
    process.exit(1);
  }
})();

