// drop-in arb bot with enhanced safety, diagnostic logging, and profit deposit hook
// Requires: Node.js with ESModule/runtime support compatible with ethers v7

/* ================= IMPORTS ================= */
import 'dotenv/config';
import { ethers } from 'ethers';

/* ================= CONFIG ================= */
const RPC_POLYGON = (process.env.RPC_POLYGON || process.env.POLYGON_RPC || process.env.RPC_URL || '')
  .toString()
  .trim();
const WALLET_PRIVATE_KEY = (process.env.WALLET_PRIVATE_KEY || process.env.PRIVATE_KEY || '')
  .toString()
  .trim();

if (!RPC_POLYGON) throw new Error('RPC_POLYGON is missing');
if (!WALLET_PRIVATE_KEY) throw new Error('WALLET_PRIVATE_KEY is missing');

/* ================= CONSTANTS ================= */
const MIN_TRADE_USDC = Number(process.env.MIN_TRADE_USDC || 0.002);
const MIN_EXPECTED_PROFIT = Number(process.env.MIN_EXPECTED_PROFIT || 0.00001);
const SCAN_DELAY_MS = Number(process.env.SCAN_DELAY_MS || 4000);
const DEADLINE_SECONDS = Number(process.env.DEADLINE_SECONDS || 60);
const TX_RETRY_ATTEMPTS = Number(process.env.TX_RETRY_ATTEMPTS || 1);
const DRY_RUN = (process.env.DRY_RUN || 'false').toLowerCase() === 'true';

/* ================= PROVIDER & WALLET ================= */
const provider = new ethers.JsonRpcProvider(RPC_POLYGON);
const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);

/* ================= VAULT CONTRACT ================= */
const VAULT_ADDRESS = '0x621F7ccEb67136f7922E36aF56137e7A1dbA22f1';
const vaultAbi = [
  {
    inputs: [
      { internalType: 'address', name: 'buyRouter', type: 'address' },
      { internalType: 'address', name: 'sellRouter', type: 'address' },
      { internalType: 'uint256', name: 'amountInUSDC', type: 'uint256' },
      { internalType: 'address[]', name: 'pathToToken', type: 'address[]' },
      { internalType: 'address[]', name: 'pathToUSDC', type: 'address[]' },
      { internalType: 'uint256', name: 'deadline', type: 'uint256' },
    ],
    name: 'executeArbitrage',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [],
    name: 'usdc',
    outputs: [{ type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
];
const vault = new ethers.Contract(VAULT_ADDRESS, vaultAbi, wallet);

/* ================= ROUTERS ================= */
const routers = {
  QuickSwap: '0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff',
  SushiSwap: '0x1b02da8cb0d097eb8d57a175b88c7d8b47997506',
  ApeSwap: '0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607',
};
const routerAbi = ['function getAmountsOut(uint amountIn, address[] calldata path) view returns (uint[] memory)'];

/* ================= TOKENS ================= */
const TOKENS = {
  USDT: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F',
  USDC: '0x2791bca1f2de4661ed88a30c99a7a9449aa84174',
  DAI: '0x8f3cf7ad23cd3cadbd9735aff958023239c6a063',
  WETH: '0x7ceb23fd6bc0add59e62ac25578270cff1b9f619',
  UNI: '0xb33eaad8d922b1083446dc23f610c2567fb5180f',
  FRAX: '0x45c32fa6df82ead1e2ef74d17b76547eddfaff89',
  BUSD: '0x9c9e5fd8bbc25984b178fdce6117defa39d2db39',
  APE: '0xb7b31a6bc18e48888545ce79e83e06003be70930',
  CRV: '0x172370d5cd63279efa6d502dab29171933a610af',
  SRM: '0x6bf2eb299e51fc5df30dec81d9445dde70e3f185',
  SAND: '0xbbba073c31bf03b8acf7c28ef0738decf3695683',
  TUSD: '0x2e1ad108ff1d8c782fcbbb89aad783ac49586756',
  WOO: '0x1b815d120b3ef02039ee11dc2d33de7aa4a8c603',
  XSGD: '0xdc3326e71d45186f113a2f448984ca0e8d201995',
  MV: '0xA3c322Ad15218fBFAEd26bA7f616249f7705D945',
  VCNT: '0x8a16d4bf8a0a716017e8d2262c4ac32927797a2f',
};
const WMATIC = '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270';

/* ================= COLORS ================= */
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

/* ================= HELPERS ================= */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const formatUSDC = (n) => Number(ethers.formatUnits(n.toString(), 6)).toFixed(6);

/* ================= QUOTE FIXED FOR BIGINT ================= */
async function quote(routerAddr, amountIn, path) {
  try {
    const router = new ethers.Contract(routerAddr, routerAbi, provider);
    const amounts = await router.getAmountsOut(amountIn, path);

    const amountOut = BigInt(amounts[amounts.length - 1]);
    if (!amountOut || amountOut <= 0n) {
      console.log(`${RED}⚠️ Quote returned non-positive amount| Router: ${routerAddr} | Path: ${path?.map((p) => p).join('->')}${RESET}`);
      return { amountOut: null, ok: false, path, router: routerAddr };
    }

    return { amountOut, ok: true, path, router: routerAddr };
  } catch (e) {
    console.log(`${RED}⚠️ Quote failed| Router: ${routerAddr} | Path: ${path?.map((p) => p).join('->') || 'unknown'} | Error: ${e?.message || e}${RESET}`);
    return { amountOut: null, ok: false, path, router: routerAddr };
  }
}

/* ================= PATH GENERATION ================= */
const FALLBACK_HOPS = [WMATIC, TOKENS.WETH, TOKENS.DAI, TOKENS.USDT];

function generatePaths(base, token) {
  const paths = [];
  paths.push([base, token]);
  for (const hop of FALLBACK_HOPS) {
    if (hop === token) continue;
    paths.push([base, hop, token]);
  }
  return paths;
}

/* ================= BINARY SEARCH ================= */
async function findOptimalTradeSize(buyRouter, sellRouter, tokenAddr, buyPath, sellPath) {
  let low = MIN_TRADE_USDC;
  let high = 50;
  let bestSize = low;
  let bestProfit = -Infinity;
  const maxIterations = 20;
  let it = 0;

  while (high - low > 0.001 && it < maxIterations) {
    it++;
    const mid = (low + high) / 2;
    const amountIn = ethers.parseUnits(mid.toString(), 6);

    const buyRes = await quote(buyRouter, amountIn, buyPath);
    if (!buyRes.ok || buyRes.amountOut == null) continue;

    const sellRes = await quote(sellRouter, buyRes.amountOut, sellPath);
    if (!sellRes.ok || sellRes.amountOut == null) continue;

    const buyAmountUsdc = mid;
    const sellAmountUsdc = Number(ethers.formatUnits(sellRes.amountOut.toString(), 6));
    const profit = sellAmountUsdc - buyAmountUsdc;

    if (profit > bestProfit) {
      bestProfit = profit;
      bestSize = mid;
    }

    if (profit > 0) low = mid;
    else high = mid;
  }

  if (!Number.isFinite(bestSize) || Number.isNaN(bestSize)) bestSize = MIN_TRADE_USDC;
  return { optimalSize: bestSize, expectedProfit: bestProfit };
}

/* ================= ARBITRAGE EXECUTION ================= */
async function tryArb(buyRouter, sellRouter, tokenAddr, buyPath, sellPath) {
  const usdcAddress = await vault.usdc();
  const { optimalSize, expectedProfit } = await findOptimalTradeSize(buyRouter, sellRouter, tokenAddr, buyPath, sellPath);

  console.log(`${YELLOW}🔹 ARB SCAN | Token: ${tokenAddr}${RESET}`);
  console.log(`  Buy on: ${buyRouter}`);
  console.log(`  Sell on: ${sellRouter}`);
  console.log(`  Trade size: ${Number(optimalSize).toFixed(6)} USDC`);
  console.log(`  Expected Profit: ${expectedProfit >= 0 ? GREEN : RED}${expectedProfit.toFixed(6)} USDC${RESET}`);

  if (!Number.isFinite(optimalSize) || Number.isNaN(optimalSize)) return;
  if (expectedProfit < MIN_EXPECTED_PROFIT) return;
  if (DRY_RUN) {
    console.log('🔎 DRY RUN: would execute trade in vault');
    return;
  }

  const amountIn = ethers.parseUnits(optimalSize.toString(), 6);
  const deadline = Math.floor(Date.now() / 1000) + DEADLINE_SECONDS;

  for (let attempt = 0; attempt < TX_RETRY_ATTEMPTS; attempt++) {
    try {
      const tx = await vault.executeArbitrage(buyRouter, sellRouter, amountIn, buyPath, sellPath, deadline);
      console.log(`⛓ TX SENT: ${tx.hash}`);
      await tx.wait();
      console.log(`${GREEN}✅ ARB TRADE EXECUTED: profits now in vault${RESET}`);
      break;
    } catch (err) {
      console.log(`⚠️ Arb attempt ${attempt + 1} failed: ${err?.message || err}`);
      await sleep(1000);
    }
  }
}

/* ================= PATH CHECK ================= */
function isPathValid(path) {
  if (!path || !Array.isArray(path) || path.length < 2) return false;
  for (const addr of path) {
    if (typeof addr !== 'string' || addr.length < 42) return false;
  }
  return true;
}

/* ================= MAIN SCAN ================= */
async function scan() {
  const usdcAddress = await vault.usdc();
  const vaultUSDCContract = new ethers.Contract(usdcAddress, ['function balanceOf(address) view returns(uint256)'], provider);
  const vaultUSDC = await vaultUSDCContract.balanceOf(VAULT_ADDRESS);
  console.log(`💰 Vault USDC balance: ${formatUSDC(vaultUSDC)} USDC`);

  const tokenList = Object.values(TOKENS);

  for (const token of tokenList) {
    const buyPaths = generatePaths(usdcAddress, token);
    const sellPaths = generatePaths(token, usdcAddress);

    const arbPromises = [];

    for (const buy of Object.values(routers)) {
      for (const sell of Object.values(routers)) {
        if (buy === sell) continue;
        for (const bPath of buyPaths) {
          for (const sPath of sellPaths) {
            if (!isPathValid(bPath) || !isPathValid(sPath)) continue;
            arbPromises.push(tryArb(buy, sell, token, bPath, sPath));
          }
        }
      }
    }

    await Promise.all(arbPromises);
    await sleep(500);
  }
}

/* ================= MAIN LOOP ================= */
(async () => {
  console.log('🚀 Arbitrage bot started');
  console.log(`DRY_RUN=${DRY_RUN} | MIN_EXPECTED_PROFIT=${MIN_EXPECTED_PROFIT} USDC | SCAN_DELAY_MS=${SCAN_DELAY_MS}`);

  while (true) {
    try {
      await scan();
    } catch (err) {
      console.log('⚠️ Scan error:', err?.message || err);
    }
    await sleep(SCAN_DELAY_MS);
  }
})();
