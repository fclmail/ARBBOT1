#!/usr/bin/env node
/**
 * Arbitrage scanner & executor (getAmountsOut-based profit)
 * Scans all token-router combinations and executes arbitrage if profitable
 */

import { JsonRpcProvider, Wallet, Contract, parseUnits, formatUnits, isAddress } from "ethers";

// ==== CONFIGURATION ====

// Hardcoded routers
const ROUTERS = {
  Dfyn: "0xA8b607Aa09B6A2641cF6F90f643E76d3f6e6Ff73",
  ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};

// Hardcoded tokens (no duplicates)
const TOKENS = {
  AAVE: { address: "0xd6df932a45c0f255f85145f286ea0b292b21c90b", decimals: 18 },
  APE: { address: "0x4d224452801aced8b2f0aebe155379bb5d594381", decimals: 18 },
  AXLUSDC: { address: "0x2a2b6055a5c6945f4fe0e814f5d4a13b5a681159", decimals: 6 },
  BETA: { address: "0x0afaabcad8815b32bf2b64e0dc5e1df2f1454cde", decimals: 18 },
  BONE: { address: "0xad37e3433ebde20e5fbf531e6c7da1655c60bb8e", decimals: 18 },
  CRV: { address: "0x172370d5cd63279efa6d502dab29171933a610af", decimals: 18 },
  DAI: { address: "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063", decimals: 18 },
  DPI: { address: "0x1494ca1f11d487c2bbe4543e90080aeba4ba3c2b", decimals: 18 },
  FND: { address: "0x292c4eefdda27062049d44d4730d5fe774b5f4c7", decimals: 18 },
  FREE: { address: "0xe1ae4d4a3a2200ae5ac06e50bca0dd7e52a19238", decimals: 18 },
  KLIMA: { address: "0x4e78011ce80ee02d2c3e649fb657e45898257815", decimals: 9 },
  LDO: { address: "0xbb0bb78beeea5cf201b8f2651f48830e64ce45a4", decimals: 18 },
  LINK: { address: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39", decimals: 18 },
  MATICX: { address: "0xa3fa99a148fa48d14ed51d610c367c61876997f1", decimals: 18 },
  OS: { address: "0xd3a691c852cdb01e281545a27064741f0b7f6825", decimals: 18 },
  QUICK: { address: "0x831753dd7087cac61ab5644b308642cc1c33dc13", decimals: 18 },
  RNDR: { address: "0x6c3c7886b43d005db8c28a09e8038b87e36cf26c", decimals: 18 },
  SHIB: { address: "0x6f8a06447ff6fcf75a5fcdb3f8c4bab2da4fc0d0", decimals: 18 },
  SHIKIGON: { address: "0x3f0fb6e42d160a8def49fe68b8ef4d8a5b7ab119", decimals: 18 },
  SURE: { address: "0xf638a9594c0c780d6c8bc40fa33efb0ceabf5d57", decimals: 18 },
  THE7: { address: "0x045f7ffdcc8334e78316a2c1164efb2e5f3815d5", decimals: 18 },
  TRADE: { address: "0x82362ec182db3cf7829014bc61e9be8a2e82868a", decimals: 18 },
  UNI: { address: "0x1f9840a85d5af5bf1d1762f925bdaddc4201f984", decimals: 18 },
  UNI2: { address: "0xb33eaad8d922b1083446dc23f610c2567fb5180f", decimals: 18 },
  USDC: { address: "0x2791bca1f2de4661ed88a30c99a7a9449aa84174", decimals: 6 },
  USDT: { address: "0xc2132d05d31c914a87c6611c10748aeb04b58e8f", decimals: 6 },
  WBTC: { address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", decimals: 8 },
  WETH: { address: "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619", decimals: 18 },
  XSGD: { address: "0x70e8de73ce022f373d5a9f00b0ec0cf5835b0fc0", decimals: 6 }
};

// Hardcoded arbitrage contract
const CONTRACT_ADDRESS = "0x19B64f74553eE0ee26BA01BF34321735E4701C43";

// Trade and threshold
const TRADE_AMOUNT_USDC = "100"; // $100 per trade
const MIN_PROFIT_USDC = "0.000001"; // minimum raw profit

// RPC and wallet
const RPC_URL = process.env.RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;

// ==== MAIN SCRIPT ====

(async () => {
  if (!RPC_URL || !PRIVATE_KEY) {
    console.error("❌ Missing RPC_URL or PRIVATE_KEY");
    process.exit(1);
  }

  const provider = new JsonRpcProvider(RPC_URL);
  const wallet = new Wallet(PRIVATE_KEY, provider);

  const UNIV2_ROUTER_ABI = ["function getAmountsOut(uint256 amountIn, address[] calldata path) view returns (uint256[] memory)"];
  const ARB_ABI = ["function executeArbitrage(address buyRouter, address sellRouter, address token, uint256 amountIn) external"];

  const arbContract = new Contract(CONTRACT_ADDRESS, ARB_ABI, wallet);

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  const amountInUSDC = parseUnits(TRADE_AMOUNT_USDC, TOKENS.USDC.decimals);
  const minProfitUnits = parseUnits(MIN_PROFIT_USDC, TOKENS.USDC.decimals);

  console.log(`🔗 Using contract: ${CONTRACT_ADDRESS}`);
  console.log(`🔧 Provider: Polygon RPC`);
  console.log(`🔧 Trade Amount: $${TRADE_AMOUNT_USDC}`);
  console.log(`🔧 MIN_PROFIT_USDC: $${MIN_PROFIT_USDC}`);

  // Initialize routers as contract objects
  const routerContracts = {};
  for (const [name, addr] of Object.entries(ROUTERS)) {
    routerContracts[name] = new Contract(addr, UNIV2_ROUTER_ABI, provider);
  }

  while (true) {
    try {
      console.log(`\n${new Date().toISOString()} ▸ Scanning all tokens and routers...`);

      for (const [tokenSymbol, token] of Object.entries(TOKENS)) {
        if (tokenSymbol === "USDC") continue;

        for (const [buyName, buyRouter] of Object.entries(routerContracts)) {
          for (const [sellName, sellRouter] of Object.entries(routerContracts)) {
            if (buyName === sellName) continue;

            try {
              const pathBuy = [TOKENS.USDC.address, token.address];
              const pathSell = [token.address, TOKENS.USDC.address];

              // Get expected buy and sell amounts
              const buyOut = await buyRouter.getAmountsOut(amountInUSDC, pathBuy);
              const sellOut = await sellRouter.getAmountsOut(buyOut[1], pathSell);

              const profit = BigInt(sellOut[1].toString()) - BigInt(amountInUSDC.toString());

              if (profit >= BigInt(minProfitUnits.toString())) {
                console.log(`[${tokenSymbol} ${buyName}→${sellName}] 💲 Buy: $${formatUnits(amountInUSDC, TOKENS.USDC.decimals)} Sell: $${formatUnits(sellOut[1], TOKENS.USDC.decimals)} Profit: $${formatUnits(profit, TOKENS.USDC.decimals)}`);

                // Execute arbitrage
                await arbContract.executeArbitrage(buyRouter.address, sellRouter.address, token.address, amountInUSDC);
                console.log(`✅ Arbitrage executed for ${tokenSymbol}`);
              }

            } catch (err) {
              console.log(`[${tokenSymbol} ${buyName}→${sellName}] ❌ Error: ${err.message}`);
            }
          }
        }
      }

      await sleep(5000); // 5s between scans

    } catch (err) {
      console.error("❌ Unexpected error:", err);
      await sleep(5000);
    }
  }

})();


