#!/usr/bin/env node
/**
 * Bidirectional Arbitrage Scanner + Executor
 * Ethers v6 compatible, with explicit token list, USD logging, safe decimals, and callStatic simulation
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
    // 1️⃣ Token list
    const TOKENS = {
      AAVE: { address: "0xd6df932a45c0f255f85145f286ea0b292b21c90b", decimals: 18 },
      APE: { address: "0x4d224452801aced8b2f0aebe155379bb5d594381", decimals: 18 },
      AXLUSDC: { address: "0x2a2b6055a5c6945f4fe0e814f5d4a13b5a681159", decimals: 6 },
      DAI: { address: "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063", decimals: 18 },
      USDC: { address: "0x2791bca1f2de4661ed88a30c99a7a9449aa84174", decimals: 6 },
      USDT: { address: "0xc2132d05d31c914a87c6611c10748aeb04b58e8f", decimals: 6 },
      WBTC: { address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", decimals: 8 },
      WETH: { address: "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619", decimals: 18 },
      // ... add the rest as needed
    };

    // 2️⃣ Load env vars
    const {
      RPC_URL,
      PRIVATE_KEY,
      BUY_ROUTER,
      SELL_ROUTER,
      TOKEN: TOKEN_SYMBOL,
      AMOUNT_IN_HUMAN,
      CONTRACT_ADDRESS: ENV_CONTRACT_ADDRESS,
      MIN_PROFIT_USDC,
      SCAN_INTERVAL_MS
    } = process.env;

    const required = { RPC_URL, PRIVATE_KEY, BUY_ROUTER, SELL_ROUTER, TOKEN: TOKEN_SYMBOL, AMOUNT_IN_HUMAN };
    const missing = Object.entries(required).filter(([_, v]) => !v).map(([k]) => k);
    if (missing.length > 0) {
      console.error(`❌ Missing required environment variables: ${missing.join(", ")}`);
      process.exit(1);
    }

    if (!TOKENS[TOKEN_SYMBOL]) {
      console.error(`❌ Token ${TOKEN_SYMBOL} not found in TOKENS list`);
      process.exit(1);
    }

    const tokenInfo = TOKENS[TOKEN_SYMBOL];
    const TOKEN_DECIMALS = tokenInfo.decimals;
    const tokenAddr = tokenInfo.address;

    const USDC_DECIMALS = TOKENS.USDC.decimals;
    const usdcAddr = TOKENS.USDC.address;

    const rpcUrl = RPC_URL.trim();
    const buyRouterAddr = BUY_ROUTER.trim();
    const sellRouterAddr = SELL_ROUTER.trim();
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

    // 6️⃣ Contracts
    const buyRouter = new Contract(buyRouterAddr, UNIV2_ROUTER_ABI, provider);
    const sellRouter = new Contract(sellRouterAddr, UNIV2_ROUTER_ABI, provider);
    const arbContract = new Contract(CONTRACT_ADDRESS, ARB_ABI, wallet);

    // 7️⃣ State
    const amountInUSDC = parseUnits(AMOUNT_IN_HUMAN, USDC_DECIMALS);
    const MIN_PROFIT_UNITS = parseUnits(MIN_PROFIT_USDC_STR, USDC_DECIMALS);

    console.log(`🔧 Token: ${TOKEN_SYMBOL} (${tokenAddr})`);
    console.log(`🔧 Trade Amount: $${AMOUNT_IN_HUMAN}`);
    console.log(`🔧 MIN_PROFIT_USDC: $${MIN_PROFIT_USDC_STR} (base units: ${MIN_PROFIT_UNITS.toString()})`);
    console.log(`🔧 Decimals: TOKEN=${TOKEN_DECIMALS}, USDC=${USDC_DECIMALS}`);

    const sleep = ms => new Promise(res => setTimeout(res, ms));

    // 8️⃣ Safe getAmountsOut
    const safeGetAmountsOut = async (router, amount, path) => {
      try {
        const out = await router.getAmountsOut(amount, path);
        if (!out || out.length < 2) return null;
        return out.map(x => BigInt(x.toString()));
      } catch {
        return null;
      }
    };

    // 9️⃣ Arbitrage check
    const checkArbDirection = async (buyR, sellR, label) => {
      const pathBuy = [usdcAddr, tokenAddr];
      const pathSell = [tokenAddr, usdcAddr];

      const buyOut = await safeGetAmountsOut(buyR, amountInUSDC, pathBuy);
      if (!buyOut) { console.warn(`${label} ⚠️ Buy router failed`); return; }
      const buyTokenOut = buyOut[1];

      const sellOut = await safeGetAmountsOut(sellR, buyTokenOut, pathSell);
      if (!sellOut) { console.warn(`${label} ⚠️ Sell router failed`); return; }
      const sellUSDCOut = sellOut[1];

      const profitBase = sellUSDCOut - amountInUSDC;
      const profitPercent = Number(formatUnits(profitBase, USDC_DECIMALS)) / Number(formatUnits(amountInUSDC, USDC_DECIMALS)) * 100;

      // How much token $1 buys
      const oneUSDCTokenOut = await safeGetAmountsOut(buyR, parseUnits("1", USDC_DECIMALS), pathBuy);
      const tokenPer1USDC = oneUSDCTokenOut ? Number(formatUnits(oneUSDCTokenOut[1], TOKEN_DECIMALS)) : 0;

      console.log(`${new Date().toISOString()} [${label}] 💱 Buy → $${formatUnits(amountInUSDC, USDC_DECIMALS)} → ${formatUnits(buyTokenOut, TOKEN_DECIMALS)} TOKEN`);
      console.log(`${new Date().toISOString()} [${label}]    ($1 buys ~${tokenPer1USDC} TOKEN)`);
      console.log(`${new Date().toISOString()} [${label}] 💲 Sell → $${formatUnits(sellUSDCOut, USDC_DECIMALS)} USDC`);
      console.log(`${new Date().toISOString()} [${label}] 🧮 Profit → $${formatUnits(profitBase, USDC_DECIMALS)} (${profitPercent.toFixed(2)}%)`);

      // Call static simulation
      try {
        await arbContract.callStatic.executeArbitrage(buyR.address, sellR.address, tokenAddr, amountInUSDC);
        if (profitBase >= MIN_PROFIT_UNITS) {
          console.log(`${new Date().toISOString()} [${label}] ✅ Simulation OK, executing arbitrage...`);
          const gasEst = await arbContract.estimateGas.executeArbitrage(buyR.address, sellR.address, tokenAddr, amountInUSDC);
          const gasLimit = gasEst * 120n / 100n;
          const tx = await arbContract.executeArbitrage(buyR.address, sellR.address, tokenAddr, amountInUSDC, { gasLimit });
          console.log(`${new Date().toISOString()} [${label}] 🧾 TX sent: ${tx.hash}`);
          const rcpt = await tx.wait();
          console.log(`${new Date().toISOString()} [${label}] 🎉 TX confirmed: ${rcpt.transactionHash}`);
        } else {
          console.log(`${new Date().toISOString()} [${label}] 🚫 Not profitable (below threshold).`);
        }
      } catch (simErr) {
        console.warn(`${new Date().toISOString()} [${label}] ⚠️ Simulation failed: ${simErr.message}`);
      }
    };

    // 🔟 Main loop
    const runLoop = async () => {
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
    };

    await runLoop();

  } catch (fatal) {
    console.error("❌ Fatal startup error:", fatal);
    process.exit(1);
  }
})();



