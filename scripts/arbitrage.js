import { ethers } from "ethers";

// ---------------- CONFIG ----------------
const RPC_URL = process.env.RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;

const VAULT_ADDRESS = "0x7DadE334120e659eDE4999c8813c183648b1bd19";
const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

const DRY_RUN = false;          // true = simulate only
const TRADE_USDC = 1;            // Amount per trade in USDC (1 USDC)
const MIN_PROFIT_PCT = 0.0002;    // Minimum profit % to consider (0.02%)
const USDC_DECIMALS = 6;

// Simple gas/fee placeholder (in USDC units). Adjust as needed per your environment.
const ESTIMATED_GAS_COST_USDC = 0.001; // 0.001 USDC per arb as a rough estimate

// ---------------- PROVIDER & WALLET ----------------
if (!RPC_URL) throw new Error("Please set RPC_URL in env");
if (!PRIVATE_KEY && !DRY_RUN) throw new Error("PRIVATE_KEY required for live mode");

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = DRY_RUN ? null : new ethers.Wallet(PRIVATE_KEY, provider);

// ---------------- VAULT CONTRACT ----------------
const vaultABI = [
  "function executeArbitrage(address buyRouter,address sellRouter,address token,uint256 amountIn,uint256 minReturnUSDC) external",
  "function USDC() view returns(address)",
  "function owner() view returns(address)"
];
const vaultContract = DRY_RUN
  ? new ethers.Contract(VAULT_ADDRESS, vaultABI, provider)
  : new ethers.Contract(VAULT_ADDRESS, vaultABI, wallet);

const erc20Abi = ["function balanceOf(address) view returns (uint256)"];
const routerABI = [
  "function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory)"
];

// Routers (example placeholders; replace with real addresses in your network)
const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506"
};

// Tokens (ensure addresses/decimals are correct)
const tokens = {
  WETH: { address: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", decimals: 18 },
  WBTC: { address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", decimals: 8 },
  CRV:  { address: "0x172370d5Cd63279eFa6d502Dab29171933a610Af", decimals: 18 }
};

// Vault ABIs (for USDC)
async function getVaultUSDCBalanceBN() {
  const usdcAddr = await vaultContract.USDC();
  const usdc = new ethers.Contract(usdcAddr, ["function balanceOf(address) view returns(uint256)"], provider);
  return await usdc.balanceOf(VAULT_ADDRESS);
}
