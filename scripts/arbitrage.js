#!/usr/bin/env node
/**
 * Arbitrage scanner & executor (getAmountsOut-based profit)
 * Scans all token-router combinations and executes arbitrage if profitable
 */

import { JsonRpcProvider, Wallet, Contract, parseUnits, formatUnits } from "ethers";

// ==== CONFIGURATION ====

// ✅ Lowercase router addresses (fixes checksum)
const ROUTERS = {
  Dfyn: "0xa8b607aa09b6a2641cf6f90f643e76d3f6e6ff73",
  ApeSwap: "0xc0788a3ad43d79aa53b09c2eacc313a787d1d607"
};

// ✅ Factory addresses for pair existence check
const FACTORIES = {
  Dfyn: "0x9ad32efcb1c6c92f9f9701d7a1f4c964f59e7fbd",
  ApeSwap: "0xCf083Be4164828f00cAE704EC15a36D711491284"
};

// ✅ Tokens (USDC + popular ones)
const TOKENS = {
  AAVE: { address: "0xd6df932a45c0f255f85145f286ea0b292b21c90b", decimals: 18 },
  APE: { address: "0x4d224452801aced8b2f0aebe155379bb5d594381", decimals: 18 },
  DAI: { address: "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063", decimals: 18 },
  LINK: { address: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39", decimals: 18 },
  QUICK: { address: "0x831753dd7087cac61ab5644b308642cc1c33dc13", decimals: 18 },
  UNI: { address: "0x1f9840a85d5af5bf1d1762f925bdaddc4201f984", decimals: 18 },
  WBTC: { address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", decimals: 8 },
  WETH: { address: "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619", decimals: 18 },
  USDC: { address: "0x2791bca1f2de4661ed88a30c99a7a9449aa84174", decimals: 6 },
  USDT: { address: "0xc2132d05d31c914a87c6611c10748aeb04b58e8f", decimals: 6 }
};

// ✅ Your deployed contract
const CONTRACT_ADDRESS = "0x19B64f74553eE0ee26BA01BF34321735E4701C43";

// === Trade config ===
const TRADE_AMOUNT_USDC = "100";      // $100 per trade
const MIN_PROFIT_USDC = "0.01";       // $0.01 min profit to execute
const SCAN_DELAY = 5000;              // 5 seconds between scans

// === RPC + wallet ===
const RPC_URL = process.env.RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;

(async () => {
  if (!RPC_URL || !PRIVATE_KEY) {
    console.error("❌ Missing RPC_URL or PRIVATE_KEY");
    process.exit(1);
  }

  const provider = new JsonRpcProvider(RPC_URL);
  const wallet = new Wallet(PRIVATE_KEY, provider);

  // === ABIs ===
  const UNIV2_ROUTER_ABI = [
    "function getAmountsOut(uint256 amountIn, address[] calldata path) view returns (uint256[] memory)"
  ];
  const UNIV2_FACTORY_ABI = [
    "function getPair(address tokenA, address tokenB) external view returns (address)"
  ];
  const ARB_ABI = [
    "function executeArbitrage(address buyRouter, address sellRouter, address token, uint256 amountIn) external"
  ];

  const arbContract = new Contract(CONTRACT_ADDRESS, ARB_ABI, wallet);
  const amountInUSDC = parseUnits(TRADE_AMOUNT_USDC, TOKENS.USDC.decimals);
  const minProfitUnits = parseUnits(MIN_PROFIT_USDC, TOKENS.USDC.decimals);

  console.log(`🔗 Contract: ${CONTRACT_ADDRESS}`);
  console.log(`💰 Trade Amount: $${TRADE_AMOUNT_USDC}`);
  console.log(`📈 Min Profit: $${MIN_PROFIT_USDC}`);
  console.log(`🔧 Using Routers: ${Object.keys(ROUTERS).join(", ")}`);

  // === Load router + factory contracts ===
  const routerContracts = {};
  const factoryContracts = {};
  for (const [name, addr] of Object.entries(ROUTERS)) {
    routerContracts[name] = new Contract(addr, UNIV2_ROUTER_ABI, provider);
    factoryContracts[name] = new Contract(FACTORIES[name], UNIV2_FACTORY_ABI, provider);
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  while (true) {
    console.log(`\n🕒 ${new Date().toISOString()} ▸ Scanning tokens...`);

    for (const [symbol, token] of Object.entries(TOKENS)) {
      if (symbol === "USDC") continue; // skip base token

      for (const [buyName, buyRouter] of Object.entries(routerContracts)) {
        for (const [sellName, sellRouter] of Object.entries(routerContracts)) {
          if (buyName === sellName) continue;

          try {
            // ✅ Pre-check if liquidity pair exists
            const pairAddr = await factoryContracts[buyName].getPair(TOKENS.USDC.address, token.address);
            if (pairAddr === "0x0000000000000000000000000000000000000000") {
              console.log(`[${symbol}] ⚠️ No pair on ${buyName}, skipping`);
              continue;
            }

            // === Get buy/sell outputs ===
            const pathBuy = [TOKENS.USDC.address, token.address];
            const pathSell = [token.address, TOKENS.USDC.address];
            const buyOut = await buyRouter.getAmountsOut(amountInUSDC, pathBuy);
            const sellOut = await sellRouter.getAmountsOut(buyOut[1], pathSell);

            const profit = BigInt(sellOut[1].toString()) - BigInt(amountInUSDC.toString());

            if (profit > BigInt(minProfitUnits)) {
              console.log(
                `[${symbol}] 💎 ${buyName}→${sellName} | Buy=$${formatUnits(amountInUSDC, TOKENS.USDC.decimals)} | Sell=$${formatUnits(sellOut[1], TOKENS.USDC.decimals)} | Profit=$${formatUnits(profit, TOKENS.USDC.decimals)}`
              );

              // ✅ Execute arbitrage
              await arbContract.executeArbitrage(buyRouter.target, sellRouter.target, token.address, amountInUSDC);
              console.log(`✅ Executed arbitrage for ${symbol}`);
            }

          } catch (err) {
            if (err.code === "CALL_EXCEPTION") {
              console.log(`[${symbol}] ⚠️ No liquidity ${buyName}→${sellName}`);
            } else if (err.code === "INVALID_ARGUMENT") {
              console.log(`[${symbol}] ❌ Invalid address in ${buyName}→${sellName}`);
            } else {
              console.log(`[${symbol}] ⚠️ Error ${buyName}→${sellName}: ${err.message}`);
            }
          }
        }
      }
    }

    await sleep(SCAN_DELAY);
  }
})();


