#!/usr/bin/env node
/**
 * Patched arbitrage scanner (safe mode)
 * - RPC rotation (multiple RPCs from env)
 * - throttling wrapper to avoid spamming RPCs
 * - short TTL caching for getAmountsOut calls
 * - rate-limit detection + provider rotation
 * - SIMULATE_EXECUTION mode (no on-chain txs)
 *
 * Usage: set RPCs and PRIVATE_KEY in .env or environment, then:
 *   node arbitrage.js
 *
 * THIS SCRIPT DOES NOT SEND TRANSACTIONS BY DEFAULT.
 */

import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

// -------------------- CONFIG --------------------
const SIMULATE_EXECUTION = (process.env.SIMULATE_EXECUTION ?? "true").toLowerCase() !== "false";

// Load RPCs: allow either RPCS_CSV or RPC_1..RPC_10 form
function loadRpcsFromEnv(){
  const list = [];
  if (process.env.RPCS_CSV){
    for (const s of process.env.RPCS_CSV.split(",").map(t=>t.trim())) if (s) list.push(s);
  }
  // also check RPC_1..RPC_10 in case user stores individually
  for (let i=1;i<=10;i++){
    const k = process.env[`RPC_${i}`];
    if (k && k.trim()) list.push(k.trim());
  }
  // fallback to a safe public RPC if nothing supplied (read-only)
  if (list.length === 0){
    console.warn("⚠ No RPCs provided in env; defaulting to https://polygon-rpc.com (may be rate-limited).");
    list.push("https://polygon-rpc.com");
  }
  // dedupe
  return Array.from(new Set(list));
}

const RPC_URLS = loadRpcsFromEnv();
const PRIVATE_KEY = process.env.PRIVATE_KEY || ""; // not required for simulation

if (!PRIVATE_KEY && !SIMULATE_EXECUTION){
  console.error("❌ PRIVATE_KEY missing and SIMULATE_EXECUTION=false. Please set PRIVATE_KEY in env or enable simulations.");
  process.exit(1);
}

// Create provider objects
const providers = RPC_URLS.map(url => new ethers.JsonRpcProvider(url));
let providerIndex = 0;
function currentProvider(){ return providers[providerIndex]; }
function rotateProvider(reason){
  providerIndex = (providerIndex + 1) % providers.length;
  console.warn(`🔁 Rotating RPC provider (${reason || "rotate"}). New provider: ${RPC_URLS[providerIndex]}`);
  return currentProvider();
}

// Wallet — used only for read & optional simulation logging
const wallet = PRIVATE_KEY ? new ethers.Wallet(PRIVATE_KEY, currentProvider()) : null;

// -------------------- ORIGINAL CONFIG (kept) --------------------
const ARB_CONTRACT = "0x19B64f74553eE0ee26BA01BF34321735E4701C43";

const ROUTERS = {
  Dfyn: "0xa8b607aa09b6a2641cf6f90f643e76d3f6e6ff73",
  ApeSwap: "0xc0788a3ad43d79aa53b09c2eacc313a787d1d607",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  QuickSwap: "0xa5e0829caced8ffdd4de3c43696c57f7d7a678ff",
  JetSwap: "0x6b3d817814eabc984d51896b1015c0b89e9737ca"
};

const FACTORIES = {
  Dfyn: "0x9ad32efcb1c6c92f9f9701d7a1f4c964f59e7fbd",
  ApeSwap: "0xcf083be4164828f00cae704ec15a36d711491284",
  SushiSwap: "0xc35dadb65012ec5796536bd9864ed8773abc74c4",
  QuickSwap: "0x5757371414417b8c6caad45baef941abc7d3ab32",
  JetSwap: undefined
};

const TOKENS = {
  AAVE:{address:"0xd6df932a45c0f255f85145f286ea0b292b21c90b",decimals:18},
  APE:{address:"0x4d224452801aced8b2f0aebe155379bb5d594381",decimals:18},
  AXLUSDC:{address:"0x2a2b6055a5c6945f4fe0e814f5d4a13b5a681159",decimals:6},
  BETA:{address:"0x0afaabcad8815b32bf2b64e0dc5e1df2f1454cde",decimals:18},
  BONE:{address:"0xad37e3433ebde20e5fbf531e6c7da1655c60bb8e",decimals:18},
  CRV:{address:"0x172370d5cd63279efa6d502dab29171933a610af",decimals:18},
  DAI:{address:"0x8f3cf7ad23cd3cadbd9735aff958023239c6a063",decimals:18},
  DPI:{address:"0x1494ca1f11d487c2bbe4543e90080aeba4ba3c2b",decimals:18},
  FND:{address:"0x292c4eefdda27062049d44d4730d5fe774b5f4c7",decimals:18},
  FREE:{address:"0xe1ae4d4a3a2200ae5ac06e50bca0dd7e52a19238",decimals:18},
  KLIMA:{address:"0x4e78011ce80ee02d2c3e649fb657e45898257815",decimals:9},
  LDO:{address:"0xbb0bb78beeea5cf201b8f2651f48830e64ce45a4",decimals:18},
  LINK:{address:"0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39",decimals:18},
  MATICX:{address:"0xa3fa99a148fa48d14ed51d610c367c61876997f1",decimals:18},
  OS:{address:"0xd3a691c852cdb01e281545a27064741f0b7f6825",decimals:18},
  QUICK:{address:"0x831753dd7087cac61ab5644b308642cc1c33dc13",decimals:18},
  RNDR:{address:"0x6c3c7886b43d005db8c28a09e8038b87e36cf26c",decimals:18},
  SHIB:{address:"0x6f8a06447ff6fcf75a5fcdb3f8c4bab2da4fc0d0",decimals:18},
  SHIKIGON:{address:"0x3f0fb6e42d160a8def49fe68b8ef4d8a5b7ab119",decimals:18},
  SURE:{address:"0xf638a9594c0c780d6c8bc40fa33efb0ceabf5d57",decimals:18},
  THE7:{address:"0x045f7ffdcc8334e78316a2c1164efb2e5f3815d5",decimals:18},
  TRADE:{address:"0x82362ec182db3cf7829014bc61e9be8a2e82868a",decimals:18},
  UNI:{address:"0x1f9840a85d5af5bf1d1762f925bdaddc4201f984",decimals:18},
  UNI2:{address:"0xb33eaad8d922b1083446dc23f610c2567fb5180f",decimals:18},
  USDC:{address:"0x2791bca1f2de4661ed88a30c99a7a9449aa84174",decimals:6},
  USDT:{address:"0xc2132d05d31c914a87c6611c10748aeb04b58e8f",decimals:6},
  WBTC:{address:"0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6",decimals:8},
  WETH:{address:"0x7ceb23fd6bc0add59e62ac25578270cff1b9f619",decimals:18},
  XSGD:{address:"0x70e8de73ce022f373d5a9f00b0ec0cf5835b0fc0",decimals:6},
};

const BASES = [
  TOKENS.USDC.address,
  TOKENS.USDT.address,
  TOKENS.WETH.address,
  "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270"
];

const TRADE_USD_STR = process.env.TRADE_USD_STR || "100";
const TRADE_AMOUNT_USDC = ethers.parseUnits(TRADE_USD_STR, TOKENS.USDC.decimals);
const MIN_PROFIT_USDC = ethers.parseUnits(process.env.MIN_PROFIT_USDC || "0.01", TOKENS.USDC.decimals);

// ABIs
const ROUTER_ABI = ["function getAmountsOut(uint256 amountIn, address[] memory path) view returns (uint256[] memory)"];
const FACTORY_ABI = ["function getPair(address tokenA, address tokenB) external view returns (address)"];
const ARB_ABI = ["function executeArbitrage(address buyRouter, address sellRouter, address token, uint256 amountIn) external"];

// small color helpers
const C = {
  cyan: (t)=>`\x1b[36m${t}\x1b[0m`,
  green:(t)=>`\x1b[32m${t}\x1b[0m`,
  yellow:(t)=>`\x1b[33m${t}\x1b[0m`,
  gray:(t)=>`\x1b[90m${t}\x1b[0m`,
  magenta:(t)=>`\x1b[35m${t}\x1b[0m`
};

// -------------------- THROTTLING & CACHING --------------------
const MIN_INTERVAL_MS = Number(process.env.MIN_INTERVAL_MS || 200); // min interval between RPC calls
let lastRpcCall = 0;

const delay = ms => new Promise(r => setTimeout(r, ms));

async function throttle(){
  const now = Date.now();
  const wait = Math.max(0, MIN_INTERVAL_MS - (now - lastRpcCall));
  if (wait) await delay(wait);
  lastRpcCall = Date.now();
}

// Simple in-memory cache for getAmountsOut results
const cache = new Map();
const CACHE_TTL = Number(process.env.CACHE_TTL_MS || 4000); // default 4s

function makeCacheKey(routerAddr, amountIn, path){
  return `${routerAddr}|${amountIn.toString()}|${path.join(",")}`;
}

// helper to detect rate-limit-like errors
function isRateLimitError(err){
  if (!err) return false;
  const msg = (err.message || "").toLowerCase();
  return msg.includes("rate limit") || msg.includes("429") || msg.includes("too many requests") || msg.includes("request was rejected");
}

// -------------------- CONTRACT HELPERS --------------------
function routerContractFor(routerAddr, provider){
  return new ethers.Contract(routerAddr, ROUTER_ABI, provider);
}
function factoryContractFor(factoryAddr, provider){
  return new ethers.Contract(factoryAddr, FACTORY_ABI, provider);
}

async function getAmountsOutWithCache(routerAddr, amountIn, path){
  // throttle globally
  await throttle();

  const key = makeCacheKey(routerAddr, amountIn, path);
  const now = Date.now();
  if (cache.has(key)){
    const { value, time } = cache.get(key);
    if (now - time < CACHE_TTL) {
      return value;
    } else {
      cache.delete(key);
    }
  }

  // Use current provider; if error suggests rate-limiting, rotate and retry once
  let provider = currentProvider();
  let router = routerContractFor(routerAddr, provider);
  try {
    const out = await router.getAmountsOut(amountIn, path);
    cache.set(key, { value: out, time: now });
    return out;
  } catch (err){
    if (isRateLimitError(err) && providers.length > 1){
      // rotate and retry once
      rotateProvider("rate-limit detected on getAmountsOut");
      provider = currentProvider();
      router = routerContractFor(routerAddr, provider);
      try {
        const out2 = await router.getAmountsOut(amountIn, path);
        cache.set(key, { value: out2, time: now });
        return out2;
      } catch (err2){
        throw err2;
      }
    }
    throw err;
  }
}

async function pairExists(factoryAddr, a, b){
  if (!factoryAddr) return true;
  // throttle and check
  await throttle();
  let provider = currentProvider();
  const factory = factoryContractFor(factoryAddr, provider);
  try {
    const pair = await factory.getPair(a, b);
    return pair && pair !== ethers.ZeroAddress;
  } catch (err){
    if (isRateLimitError(err) && providers.length > 1){
      rotateProvider("rate-limit on factory.getPair");
      const factory2 = factoryContractFor(factoryAddr, currentProvider());
      try {
        const pair2 = await factory2.getPair(a, b);
        return pair2 && pair2 !== ethers.ZeroAddress;
      } catch {
        return true; // fallback true
      }
    }
    return true; // fallback to allow getAmountsOut attempts
  }
}

// -------------------- PATH GENERATION & HELPERS --------------------
const MAX_PATHS_PER_TOKEN = Number(process.env.MAX_PATHS_PER_TOKEN || 12);
function generatePaths(tokenAddress){
  const paths = [];
  for (const b of BASES){
    paths.push([b, tokenAddress]);
  }
  for (const b1 of BASES){
    for (const b2 of BASES){
      if (b1 === b2) continue;
      paths.push([b1, b2, tokenAddress]);
    }
  }
  return paths.slice(0, MAX_PATHS_PER_TOKEN);
}

function fmtUSDC(big){
  return Number(ethers.formatUnits(big, TOKENS.USDC.decimals)).toFixed(6);
}

function fmtNumber(value, decimals = 6){
  try {
    return Number(ethers.formatUnits(value, decimals)).toFixed(6);
  } catch {
    // maybe a BigInt string
    return (Number(value) / Math.pow(10, decimals)).toFixed(6);
  }
}

// -------------------- MAIN SCANNING --------------------
async function scanToken(tokenSymbol, tokenObj){
  const buyPaths = generatePaths(tokenObj.address);
  const sellPaths = generatePaths(tokenObj.address).map(p => p.slice().reverse());

  for (const [buyName, buyAddr] of Object.entries(ROUTERS)){
    for (const [sellName, sellAddr] of Object.entries(ROUTERS)){
      if (buyName === sellName) continue;

      // small throttle
      await delay(10);

      const buyFactory = FACTORIES[buyName];
      const sellFactory = FACTORIES[sellName];

      let buyTokenAmount = null;
      for (const path of buyPaths){
        try {
          if (buyFactory){
            const ok = await pairExists(buyFactory, path[0], path[1]);
            if (!ok) { continue; }
          }
          const out = await getAmountsOutWithCache(buyAddr, TRADE_AMOUNT_USDC, path);
          buyTokenAmount = out[out.length - 1];
          break;
        } catch (err){
          // ignore and try next path; rotate provider on rate-limit detection is handled in helper
        }
      }
      if (!buyTokenAmount){
        console.log(`${C.gray(`[${tokenSymbol}]`)} ${buyName}→${sellName}: ${C.yellow("No buy route")}`);
        continue;
      }

      let sellUSDCOut = null;
      for (const path of sellPaths){
        try {
          if (sellFactory){
            const ok = await pairExists(sellFactory, path[0], path[1]);
            if (!ok) { continue; }
          }
          const out = await getAmountsOutWithCache(sellAddr, buyTokenAmount, path);
          sellUSDCOut = out[out.length - 1];
          break;
        } catch (err){
          // ignore and try next
        }
      }
      if (!sellUSDCOut){
        console.log(`${C.gray(`[${tokenSymbol}]`)} ${buyName}→${sellName}: ${C.yellow("No sell route")}`);
        continue;
      }

      const profitBN = BigInt(sellUSDCOut.toString()) - BigInt(TRADE_AMOUNT_USDC.toString());
      const profitHuman = Number(ethers.formatUnits(profitBN >= 0n ? profitBN : -profitBN, TOKENS.USDC.decimals)).toFixed(6);
      const buyUSD = fmtNumber(TRADE_AMOUNT_USDC, TOKENS.USDC.decimals);
      const sellUSD = fmtNumber(sellUSDCOut, TOKENS.USDC.decimals);

      const profitSignText = (profitBN >= 0n) ? C.green(`+$${profitHuman}`) : C.gray(`-$${profitHuman}`);
      console.log(`${C.cyan(`[${tokenSymbol}]`)} ${buyName}→${sellName} | Buy: $${buyUSD} | Sell: $${sellUSD} | Profit: ${profitSignText}`);

      // SIMULATION of execution
      if (profitBN >= BigInt(MIN_PROFIT_USDC.toString())){
        console.log(C.yellow(`${new Date().toISOString()} ⚡ SIMULATED: would execute arbitrage ${tokenSymbol} (${buyName}→${sellName}) — profit $${profitHuman}`));
        if (!SIMULATE_EXECUTION){
          // If you switch to real execution (NOT recommended here), replace the below with actual tx submission.
          try {
            console.log(C.magenta("Attempting to send transaction... (SIMULATION disabled)"));
            // Placeholder: real execution code would go here.
            // Example (DO NOT UNCOMMENT without careful review and ensuring PRIVATE_KEY is protected):
            // const arbContract = new ethers.Contract(ARB_CONTRACT, ARB_ABI, wallet);
            // const tx = await arbContract.executeArbitrage(buyAddr, sellAddr, tokenObj.address, TRADE_AMOUNT_USDC, { gasLimit: 1_500_000 });
            // console.log(C.magenta(`⛓️ TX submitted: ${tx.hash}`));
            // await tx.wait();
            // console.log(C.green(`✅ TX confirmed. Profit should be in contract ${ARB_CONTRACT}`));
          } catch (err){
            console.warn(C.gray(`Execution failed (simulated path): ${err?.message ?? err}`));
          }
        }
      }

    } // sell routers
  } // buy routers
}

// -------------------- BOOTSTRAP & LOOP --------------------
(async function main(){
  console.log(`🔗 Contract: ${ARB_CONTRACT}`);
  console.log(`💰 Trade Amount: $${TRADE_USD_STR}`);
  console.log(`📈 Min Profit: $${Number(ethers.formatUnits(MIN_PROFIT_USDC, TOKENS.USDC.decimals)).toFixed(6)}`);
  console.log(`🔧 Using Routers: ${Object.keys(ROUTERS).join(", ")}`);
  console.log(`🔧 Bases tried: ${BASES.join(", ")}`);
  console.log(`🔁 RPCs: ${RPC_URLS.join(", ")}`);
  console.log(`🔒 SIMULATE_EXECUTION: ${SIMULATE_EXECUTION}`);
  console.log();

  // quick provider readiness check; rotate on failure
  let checked = false;
  for (let i=0;i<providers.length;i++){
    try {
      await providers[i].getBlockNumber();
      providerIndex = i;
      checked = true;
      break;
    } catch (err){
      // try next
    }
  }
  if (!checked) {
    console.error("Fatal: none of the configured RPCs responded to getBlockNumber()");
    process.exit(1);
  }

  while (true){
    console.log(`\n${new Date().toISOString()} ▸ Scanning tokens...`);
    for (const [symbol, token] of Object.entries(TOKENS)){
      if (symbol === "USDC") continue;
      try {
        await scanToken(symbol, token);
      } catch (err){
        console.error(`${C.gray(`[${symbol}]`)} ERROR scanning token: ${err?.message ?? err}`);
        // small pause on unexpected error
        await delay(500);
      }
    }
    console.log(C.magenta(`Cycle complete — sleeping ${process.env.LOOP_SLEEP_MS || 3000}ms before next run`));
    await delay(Number(process.env.LOOP_SLEEP_MS || 3000));
  }

})().catch(err=>{
  console.error("Fatal:", err);
  process.exit(1);
});
