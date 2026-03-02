// drop-in arb bot with enhanced safety, diagnostic logging, and profit deposit hook
// Requires: Node.js v20+ with ESModule support and ethers v7

/* ================= IMPORTS ================= */
import 'dotenv/config';
import { ethers } from 'ethers';

/* ================= CONFIG ================= */
const RPC_POLYGON = (process.env.RPC_POLYGON || process.env.POLYGON_RPC || process.env.RPC_URL || '').trim();
const WALLET_PRIVATE_KEY = (process.env.WALLET_PRIVATE_KEY || process.env.PRIVATE_KEY || '').trim();

if (!RPC_POLYGON) throw new Error('RPC_POLYGON is missing');
if (!WALLET_PRIVATE_KEY) throw new Error('WALLET_PRIVATE_KEY is missing');

/* ================= CONSTANTS ================= */
const MIN_TRADE_USDC = Number(process.env.MIN_TRADE_USDC || 0.002);
const SCAN_DELAY_MS = Number(process.env.SCAN_DELAY_MS || 4000);
const DEADLINE_SECONDS = Number(process.env.DEADLINE_SECONDS || 60);
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

const routerAbi = [
  'function getAmountsOut(uint amountIn, address[] calldata path) view returns (uint[] memory)'
];

/* ================= TOKENS ================= */
const TOKENS = {
  USDT: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F',
  USDC: '0x2791bca1f2de4661ed88a30c99a7a9449aa84174',
  DAI:  '0x8f3cf7ad23cd3cadbd9735aff958023239c6a063',
  WETH: '0x7ceb23fd6bc0add59e62ac25578270cff1b9f619',
};

/* ================= UTILITIES ================= */
function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function buildPath(...addresses) {
  const path = [];
  for (const addr of addresses) {
    const lower = addr.toLowerCase();
    if (path.length === 0 || path[path.length - 1] !== lower) {
      path.push(lower);
    }
  }
  if (path.length < 2) throw new Error('Invalid path: must contain at least 2 tokens');
  return path;
}

async function getAmountsOut(routerAddress, amountIn, path) {
  try {
    const router = new ethers.Contract(routerAddress, routerAbi, provider);
    const amounts = await router.getAmountsOut(amountIn, path);
    return amounts[amounts.length - 1];
  } catch (err) {
    log('Quote failed:', routerAddress, err.message);
    return null;
  }
}

function toUSDCUnits(amount) {
  return ethers.parseUnits(amount.toFixed(6), 6);
}

/* ================= MAIN LOOP ================= */
async function mainLoop() {
  const inputUSDC = 1;
  const amountInUSDC = toUSDCUnits(inputUSDC);

  const path = buildPath(
    TOKENS.USDC,
    TOKENS.DAI,
    TOKENS.WETH,
    TOKENS.USDC
  );

  let best = null;

  for (const routerAddress of Object.values(routers)) {
    const out = await getAmountsOut(routerAddress, amountInUSDC, path);
    if (!out) continue;

    const outUSDC = parseFloat(ethers.formatUnits(out, 6));
    const profit = outUSDC - inputUSDC;

    if (profit > MIN_TRADE_USDC) {
      best = { routerAddress, profit, out };
      break;
    }
  }

  if (!best) {
    log('No profitable opportunity.');
    return;
  }

  log('Profitable opportunity found:', best);

  if (DRY_RUN) {
    log('DRY_RUN enabled. Skipping execution.');
    return;
  }

  const deadline = Math.floor(Date.now() / 1000) + DEADLINE_SECONDS;

  try {
    const tx = await vault.executeArbitrage(
      best.routerAddress,
      best.routerAddress,
      amountInUSDC,
      path,
      path,
      deadline
    );

    log('Transaction submitted:', tx.hash);
    const receipt = await tx.wait();
    log('Transaction confirmed. Block:', receipt.blockNumber);
  } catch (err) {
    log('Execution failed:', err.message);
  }
}

/* ================= RUN ================= */
async function run() {
  log('Arbitrage bot started...');
  while (true) {
    await mainLoop();
    await sleep(SCAN_DELAY_MS);
  }
}

run();
