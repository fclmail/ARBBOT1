#!/usr/bin/env node
/**
 * Bidirectional Arbitrage Scanner + Executor
 * Supports token lookup by address (env var TOKEN).
 * Ethers v6 compatible, safe decimals, live USDC profit calculation.
 */

import { JsonRpcProvider, Wallet, Contract, parseUnits, formatUnits, isAddress } from "ethers";

(async () => {
  try {
    // 1️⃣ Environment variables
    const {
      RPC_URL,
      PRIVATE_KEY,
      BUY_ROUTER,
      SELL_ROUTER,
      TOKEN: TOKEN_ADDR,
      USDC_ADDRESS,
      AMOUNT_IN_HUMAN,
      CONTRACT_ADDRESS: ENV_CONTRACT_ADDRESS,
      MIN_PROFIT_USDC,
      SCAN_INTERVAL_MS
    } = process.env;

    const required = { RPC_URL, PRIVATE_KEY, BUY_ROUTER, SELL_ROUTER, TOKEN: TOKEN_ADDR, USDC_ADDRESS, AMOUNT_IN_HUMAN };
    const missing = Object.entries(required).filter(([_, v]) => !v).map(([k]) => k);
    if (missing.length > 0) {
      console.error(`❌ Missing required environment variables: ${missing.join(", ")}`);
      process.exit(1);
    }

    // 2️⃣ Normalize env values
    const rpcUrl = RPC_URL.trim();
    const buyRouterAddr = BUY_ROUTER.trim();
    const sellRouterAddr = SELL_ROUTER.trim();
    const usdcAddr = USDC_ADDRESS.trim();
    const amountHumanStr = AMOUNT_IN_HUMAN.trim();
    const tokenAddressInput = TOKEN_ADDR.trim().toLowerCase();
    const CONTRACT_ADDRESS = (ENV_CONTRACT_ADDRESS || "0x19B64f74553eE0ee26BA01BF34321735E4701C43").trim();
    const SCAN_MS = SCAN_INTERVAL_MS ? Number(SCAN_INTERVAL_MS) : 5000;
    const MIN_PROFIT_USDC_STR = (typeof MIN_PROFIT_USDC === "string" && MIN_PROFIT_USDC.trim() !== "")
      ? MIN_PROFIT_USDC.trim()
      : "0.000001";

    // 3️⃣ Token list (address + decimals)
    const TOKENS = {
      AAVE:{address:"0xd6df932a45c0f255f85145f286ea0b292b21c90b",decimals:18},
      APE:{address:"0x4d224452801aced8b2f0aebe155379bb5d594381",decimals:18},
      AXLUSDC:{address:"0x2a2b6055a5c6945f4fe0e814f5d4a13b5a681159",decimals:6},
      BETA:{address:"0x0afaabcad8815b32bf2b64e0dc5e1df2f1454cde",decimals:18},
      // ... (other tokens omitted for brevity)
      USDT:{address:"0xc2132d05d31c914a87c6611c10748aeb04b58e8f",decimals:6},
      USDC:{address:"0x2791bca1f2de4661ed88a30c99a7a9449aa84174",decimals:6}
    };

    // 4️⃣ Find token by address
    const tokenInfo = Object.values(TOKENS).find(t => t.address.toLowerCase() === tokenAddressInput);
    if (!tokenInfo) {
      console.error(`❌ Token ${tokenAddressInput} not found in TOKENS list`);
      process.exit(1);
    }
    const tokenAddr = tokenInfo.address;
    const TOKEN_DECIMALS = tokenInfo.decimals;

    // 5️⃣ Validate addresses
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

    // 6️⃣ Provider + wallet
    const provider = new JsonRpcProvider(rpcUrl);
    const wallet = new Wallet(PRIVATE_KEY.trim(), provider);

    // 7️⃣ ABIs
    const UNIV2_ROUTER_ABI = ["function getAmountsOut(uint256 amountIn, address[] calldata path) view returns (uint256[] memory)"];
    const ARB_ABI = ["function executeArbitrage(address buyRouter, address sellRouter, address token, uint256 amountIn) external"];

    // 8️⃣ Contracts
    const buyRouter = new Contract(buyRouterAddr, UNIV2_ROUTER_ABI, provider);
    const sellRouter = new Contract(sellRouterAddr, UNIV2_ROUTER_ABI, provider);
    const arbContract = new Contract(CONTRACT_ADDRESS, ARB_ABI, wallet);

    // 9️⃣ State variables
    let USDC_DECIMALS = 6;
    let amountInUSDC = parseUnits(amountHumanStr, USDC_DECIMALS);
    let MIN_PROFIT_UNITS = parseUnits(MIN_PROFIT_USDC_STR, USDC_DECIMALS);

    const sleep = ms => new Promise(res => setTimeout(res, ms));

    // 1️⃣0️⃣ Arbitrage check
    async function checkArbDirection(buyR, sellR, label) {
      try {
        const pathBuy = [usdcAddr, tokenAddr];
        const pathSell = [tokenAddr, usdcAddr];

        const buyOut = await buyR.getAmountsOut(amountInUSDC, pathBuy);
        const buyTokenOut = BigInt(buyOut[1].toString());

        const sellOut = await sellR.getAmountsOut(buyTokenOut, pathSell);
        const sellUSDCOut = BigInt(sellOut[1].toString());

        const profitBase = sellUSDCOut - amountInUSDC;
        const profitHuman = formatUnits(profitBase, USDC_DECIMALS);

        const buyTokenHuman = formatUnits(buyTokenOut, TOKEN_DECIMALS);
        const sellUSDCHuman = formatUnits(sellUSDCOut, USDC_DECIMALS);

        // USDC amount per 1 USD
        const tokenPer1USDC = buyTokenOut * 1n_000_000n / amountInUSDC;
        const tokenPer1Human = formatUnits(tokenPer1USDC, TOKEN_DECIMALS);

        console.log(`${new Date().toISOString()} [${label}] 💱 Buy → $${formatUnits(amountInUSDC, USDC_DECIMALS)} → ${buyTokenHuman} TOKEN (~$${tokenPer1Human} per $1)`);
        console.log(`${new Date().toISOString()} [${label}] 💲 Sell → $${sellUSDCHuman} USDC`);
        console.log(`${new Date().toISOString()} [${label}] 🧮 Profit → $${profitHuman} USDC`);

        // Optional: callStatic simulation
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

    // 1️⃣1️⃣ Main loop
    async function runLoop() {
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




