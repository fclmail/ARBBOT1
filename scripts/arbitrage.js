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





_________











// drop-in arb bot with 
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








________
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







_______





this is the last section you wrote continue from here// drop-in arb bot with enhanced safety, diagnostic logging, and profit deposit hook
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
};

/* ================= UTILITIES & STATE ================= */
// Helper to log with timestamp
function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

// Helper: sleep
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Safe path builder: ensures there are no IDENTICAL_ADDRESSES in a row
function buildPath(...addresses) {
  const path = [];
  for (const addr of addresses) {
    const c = addr.toLowerCase();
    if (path.length === 0) {
      path.push(c);
    } else {
      if (path[path.length - 1] !== c) {
        path.push(c);
      } else {
        // skip identical consecutive address
        log('Skipped identical consecutive address in path:', addr);
      }
    }
  }
  // Ensure there are at least two hops
  if (path.length < 2) throw new Error('Invalid path: must contain at least two distinct addresses');
  return path;
}

// Quote amountsOut for a given amountIn and path using a router
async function getAmountsOut(routerAddress, amountIn, path) {
  // Instantiate a reader contract for the router
  const router = new ethers.Contract(routerAddress, routerAbi, provider);
  try {
    const [out] = await router.getAmountsOut(amountIn, path);
    return out;
  } catch (e) {
    log('getAmountsOut failed for path', path.map((p) => p), 'on router', routerAddress, e);
    return null;
  }
}

// Convert human USDC amount to token units (assuming 6 decimals for USDC)
function toUSDCUnits(amount) {
  // USDC typically has 6 decimals
  return ethers.parseUnits(amount.toFixed(6), 6);
}

/* ================= MAIN LOGIC ================= */
async function mainLoop() {
  // Example placeholders for amountInUSDC and paths
  // You should tailor these to your strategy and environment
  const amountInUSDC = toUSDCUnits(1); // 1 USDC as example

  // Example path candidates: USDC -> DAI -> WETH -> USDC
  // You must ensure all addresses are valid ERC20s present on Polygon
  const usdc = TOKENS.USDC;
  const dai = TOKENS.DAI;
  const weth = TOKENS.WETH;

  // Build a couple of path options
  // Ensure we don't have IDENTICAL_ADDRESSES in a row
  const path1 = buildPath(usdc, dai, weth, usdc);
  // Alternative path
  const path2 = buildPath(usdc, weth, dai, usdc);

  // Quote via different routers
  const routersToProbe = Object.values(routers);

  // Collect quotes
  const quotes = [];

  for (const r of routersToProbe) {
    const pa1 = await getAmountsOut(r, amountInUSDC, path1);
    if (pa1 != null) quotes.push({ router: r, path: path1, amountOut: pa1 });

    const pa2 = await getAmountsOut(r, amountInUSDC, path2);
    if (pa2 != null) quotes.push({ router: r, path: path2, amountOut: pa2 });
  }

  // Simple decision: pick best quote that yields profit above threshold
  let best = null;
  for (const q of quotes) {
    if (q.amountOut == null) continue;

    // We expect to end back in USDC. If path ends in USDC, amountOut is the USDC amount.
    // Convert to a comparable numeric value (BigNumber -> number via toString if needed)
    const amountOutUSDC = ethers.formatUnits(q.amountOut, 6); // USDC decimals = 6

    // Profit heuristic: we require final USDC to exceed input by at least MIN_TRADE_USDC or profit margin
    // Here we compare relative profit: (amountOut - input)
    const inputUSDC = 1; // since amountInUSDC was 1 USDC in our example
    const profit = parseFloat(amountOutUSDC) - inputUSDC;

    if (profit >= MIN_TRADE_USDC && (best == null || profit > parseFloat(ethers.formatUnits(best.amountOut, 6)) - inputUSDC)) {
      best = { router: q.router, path: q.path, amountOut: q.amountOut, profit, inputUSDC };
    }
  }

  if (!best) {
    log('No profitable arb opportunity found in this cycle.');
    return;
  }

  log('Best quote:', {
    router: best.router,
    path: best.path,
    amountOutUSDC: best.amountOut.toString(),
    profit: best.profit,
  });

  // If DRY_RUN, just log what would be executed
  if (DRY_RUN) {
    log('DRY_RUN enabled: would execute arbitrage with', {
      router: best.router,
      path: best.path,
      amountInUSDC: best.inputUSDC,
    });
    return;
  }

  // Execution: convert amountInUSDC to USDC unit amount and call vault.executeArbitrage
  // Build parameters according to vault ABI
  const buyRouter = best.router;
  const sellRouter = best.router; // adjust as per strategy; using same router for simplicity in this scaffold
  const amountInUSDC = toUSDCUnits(best.inputUSDC);

  // Deadline as timestamp + seconds
  const deadline = Math.floor(Date.now() / 1000) + DEADLINE_SECONDS;

  // Call the contract method
  try {
    const tx = await vault.executeArbitrage(
      buyRouter,
      sellRouter,
      amountInUSDC,
      best.path,
      best.path, // for simplicity, using same path as pathToUSDC; replace with actual path if needed
      deadline
    );

    log('arb tx submitted:', tx.hash);
    const receipt = await tx.wait();
    log('arb tx confirmed in block', receipt.blockNumber, 'status', receipt.status);
  } catch (err) {
    log('arb execution failed:', err);
  }
}

/* ================= RUN ================= */
async function run() {
  try {
    log('Arb bot started');
    while (true) {
      await mainLoop();
      await sleep(SCAN_DELAY_MS);
    }
  } catch (e) {
    log('Fatal error in arb bot:', e);
  }
}

run();
