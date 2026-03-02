// drop-in arb bot with enhanced safety, diagnostic logging, and profit deposit hook
// Requires: Node.js with ESModule/runtime support compatible with ethers v7

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
/* Vault ABI includes:
   - executeArbitrage(address buyRouter, address sellRouter, uint256 amountInUSDC, address[] pathToToken, pathToUSDC, uint256 deadline)
   - usdc() -> address
*/
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
  // Optional: if your vault supports depositing profits back into itself, add an ABI here
  // {
  //   inputs: [{ internalType: 'uint256', name: 'amount', type: 'uint256' }],
  //   name: 'deposit',
