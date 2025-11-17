
// arbitrage.js — Polygon MEV-Blocker private RPC ready
// npm i ethers dotenv
import dotenv from "dotenv";
import { ethers } from "ethers";
dotenv.config();

const PRIVATE_RPC = process.env.PRIVATE_RPC || "https://rpc.mevblocker.io";
const provider = new ethers.JsonRpcProvider(PRIVATE_RPC);

const PRIVATE_KEY = process.env.PRIVATE_KEY || null;
const DRY_RUN = (process.env.DRY_RUN === "true") || true;
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS || "0x19B64f74553eE0ee26BA01BF34321735E4701C43";

console.log("RPC:", PRIVATE_RPC);
console.log("DRY_RUN:", DRY_RUN ? "ENABLED (no tx broadcast)" : "DISABLED (LIVE TXs)");

// ---------- Settings ----------
const TRADE_AMOUNT_USDC = 0.04;      // USDC units per attempt (increase for live)
const MIN_NET_PROFIT_USDC = 1;       // absolute min profit to accept
const CUSHION_PCT = 1.5;             // extra safety buffer
const AAVE_FLASH_FEE_PCT = 0.0005;   // 0.05% as conservative default
const SLIPPAGE_PCT = 0;              // slippage applied to DEX quotes

// ---------- Routers & tokens ----------
const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  Dfyn: "0xA8b607Aa09B6A2641CF6F90F643E76D3F6E6Ff73",
  ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};

const tokens = {
  AAVE: { address: "0xd6df932a45c0f255f85145f286ea0b292b21c90b", decimals: 18 },
  CRV:  { address: "0x172370d5cd63279efa6d502dab29171933a610af", decimals: 18 },
  LINK: { address: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39", decimals: 18 },
  WBTC: { address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", decimals: 8 }
};

// Arb contract minimal ABI (read USDC & owner, and executeArbitrage)
const arbAbi = [
  {
    "inputs": [
      { "internalType": "address", "name": "buyRouter", "type": "address" },
      { "internalType": "address", "name": "sellRouter", "type": "address" },
      { "internalType": "address", "name": "token", "type": "address" },
      { "internalType": "uint256", "name": "amountIn", "type": "uint256" }
    ],
    "name": "executeArbitrage",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  { "inputs": [], "name": "USDC", "outputs": [{ "internalType": "address", "name": "", "type": "address" }], "stateMutability": "view", "type": "function" },
  { "inputs": [], "name": "owner", "outputs": [{ "internalType": "address", "name": "", "type": "address" }], "stateMutability": "view", "type": "function" }
];

const arbContract = new ethers.Contract(CONTRACT_ADDRESS, arbAbi, provider);

// helper formatting:
function fmt(n, dec = 6) { return Number(n).toFixed(dec); }

// READ USDC address once
let USDC_ADDRESS;
async function getUSDCAddress() {
  if (!USDC_ADDRESS) USDC_ADDRESS = await arbContract.USDC();
  return USDC_ADDRESS;
}

// getAmountsOut with fallback path
async function getAmountOut(routerAddr, token, amountInUSDC) {
  const router = new ethers.Contract(routerAddr, ["function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory)"], provider);
  const usdc = await getUSDCAddress();
  try {
    const amounts = await router.getAmountsOut(ethers.parseUnits(amountInUSDC.toString(), 6), [usdc, token.address]);
    return Number(ethers.formatUnits(amounts[1], token.decimals));
  } catch (err) {
    // fallback via WBTC
    const fallback = [usdc, tokens.WBTC.address, token.address];
    const amounts = await router.getAmountsOut(ethers.parseUnits(amountInUSDC.toString(), 6), fallback);
    // returns token units
    return Number(ethers.formatUnits(amounts[amounts.length - 1], token.decimals));
  }
}

// compute profit: USDC -> token on buyRouter, token -> USDC on sellRouter
async function computeExpectedProfit(buyRouter, sellRouter, token, amountUSDC) {
  try {
    const buyOutTokenUnits = await getAmountOut(buyRouter, token, amountUSDC); // token units
    // get amounts for token -> USDC
    const sellRouterContract = new ethers.Contract(sellRouter, ["function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory)"], provider);
    const usdc = await getUSDCAddress();

    // attempt direct path token -> USDC
    try {
      const amounts = await sellRouterContract.getAmountsOut(ethers.parseUnits(buyOutTokenUnits.toString(), token.decimals), [token.address, usdc]);
      const finalUSDC = Number(ethers.formatUnits(amounts[1], 6));
      const profit = finalUSDC - amountUSDC;
      return profit;
    } catch (err) {
      // fallback via WBTC
      const fallback = [token.address, tokens.WBTC.address, usdc];
      const amounts = await sellRouterContract.getAmountsOut(ethers.parseUnits(buyOutTokenUnits.toString(), token.decimals), fallback);
      const finalUSDC = Number(ethers.formatUnits(amounts[amounts.length - 1], 6));
      return finalUSDC - amountUSDC;
    }
  } catch (err) {
    // if any call fails, treat as no profit
    return Number(-9999);
  }
}

// Convert estimated gas (ETH) to USDC price using QuickSwap router via WMATIC -> USDC quote
async function ethToUSDC(routerAddr, ethAmount) {
  // On Polygon native token is MATIC (wrapped: WMATIC)
  const WMATIC = "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270";
  const usdc = await getUSDCAddress();
  const router = new ethers.Contract(routerAddr, ["function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory)"], provider);
  try {
    const amounts = await router.getAmountsOut(ethers.parseUnits(ethAmount.toString(), 18), [WMATIC, usdc]);
    return Number(ethers.formatUnits(amounts[1], 6));
  } catch (err) {
    console.warn("ethToUSDC quote failed:", err.message);
    return 0;
  }
}

// estimate gas cost in USDC for a transaction payload signed by wallet
async function estimateGasCostInUSDC(signer, txRequest) {
  const estimatedGas = await signer.estimateGas(txRequest);
  const feeData = await provider.getFeeData();
  // use maxFeePerGas if available (EIP-1559), else gasPrice
  const maxFee = feeData.maxFeePerGas || feeData.gasPrice;
  const gasCostWei = estimatedGas * maxFee;
  const gasCostEth = Number(ethers.formatUnits(gasCostWei, 18));
  // estimate eth->usdc via quickswap
  const gasCostUSDC = await ethToUSDC(routers.QuickSwap, gasCostEth);
  return { estimatedGas, gasCostUSDC, gasCostEth };
}

// callStatic check
async function callStaticOk(signer, buyRouter, sellRouter, tokenAddr, amountUSDC) {
  const arbWithSigner = arbContract.connect(signer);
  try {
    // assume large gas limit for simulation
    await arbWithSigner.callStatic.executeArbitrage(buyRouter, sellRouter, tokenAddr, ethers.parseUnits(amountUSDC.toString(), 6), { gasLimit: 5_000_000 });
    return true;
  } catch (err) {
    return false;
  }
}

// read USDC balance of contract
async function getContractUSDCBalance() {
  const usdc = await getUSDCAddress();
  const erc20 = new ethers.Contract(usdc, ["function balanceOf(address) view returns (uint256)"], provider);
  const bal = await erc20.balanceOf(CONTRACT_ADDRESS);
  return Number(ethers.formatUnits(bal, 6));
}

// attempt one arbitrage path (signer is a Wallet connected to provider)
async function attemptArb(signer, buyRouter, sellRouter, token, amountUSDC) {
  const arbWithSigner = arbContract.connect(signer);

  // compute gross profit in USDC
  const grossProfit = await computeExpectedProfit(buyRouter, sellRouter, token, amountUSDC);
  if (grossProfit <= 0) return false;

  // deduct Aave fee
  const aaveFee = amountUSDC * AAVE_FLASH_FEE_PCT;
  const profitAfterAave = grossProfit - aaveFee;
  if (profitAfterAave <= 0) {
    console.log("Not profitable after Aave fee:", fmt(profitAfterAave));
    return false;
  }

  // prepare tx
  const populated = await arbWithSigner.populateTransaction.executeArbitrage(buyRouter, sellRouter, token.address, ethers.parseUnits(amountUSDC.toString(), 6));
  const txReq = { to: CONTRACT_ADDRESS, data: populated.data };

  // estimate gas cost in USDC
  const { estimatedGas, gasCostUSDC } = await estimateGasCostInUSDC(signer, txReq);

  const netExpected = profitAfterAave - gasCostUSDC;
  const netAfterCushion = netExpected * (1 - CUSHION_PCT / 100);

  console.log("Profit check -> gross:", fmt(grossProfit), "afterAave:", fmt(profitAfterAave), "gasUSDC:", fmt(gasCostUSDC), "net:", fmt(netExpected), `netAfterCushion(${CUSHION_PCT}%):`, fmt(netAfterCushion));

  if (netAfterCushion < MIN_NET_PROFIT_USDC || netExpected <= 0) {
    console.log("Skipping — net expected after fees is too low.");
    return false;
  }

  // callStatic check (ensures tx won't revert on-chain)
  const okStatic = await callStaticOk(signer, buyRouter, sellRouter, token.address, amountUSDC);
  if (!okStatic) {
    console.log("callStatic indicates tx would revert — skipping.");
    return false;
  }

  // finalize tx options: gasLimit + feeData
  const feeData = await provider.getFeeData();
  const txOptions = {
    gasLimit: estimatedGas,
    maxFeePerGas: feeData.maxFeePerGas,
    maxPriorityFeePerGas: feeData.maxPriorityFeePerGas
  };

  // If DRY_RUN => do not send, only simulate signing
  if (DRY_RUN) {
    console.log("DRY_RUN -> would send tx with options:", { gasLimit: estimatedGas, maxFeePerGas: feeData.maxFeePerGas ? fmt(Number(ethers.formatUnits(feeData.maxFeePerGas, 'gwei')),6) + " gwei" : "n/a" });
    return true;
  }

  // Send tx (provider is MEV Blocker -> private mempool)
  try {
    const tx = await arbWithSigner.executeArbitrage(buyRouter, sellRouter, token.address, ethers.parseUnits(amountUSDC.toString(), 6), txOptions);
    console.log("TX SENT:", tx.hash);
    const receipt = await tx.wait();
    console.log("TX MINED:", receipt.blockNumber, "status:", receipt.status);

    // after success, log contract USDC balance (profit deposited)
    const contractUSDC = await getContractUSDCBalance();
    console.log("Contract USDC balance:", fmt(contractUSDC));
    return receipt.status === 1;
  } catch (err) {
    console.warn("TX failed or reverted:", err.message || err);
    return false;
  }
}

// main scanning loop
async function mainLoop() {
  const wallet = PRIVATE_KEY ? new ethers.Wallet(PRIVATE_KEY, provider) : null;
  if (!wallet) {
    console.warn("No PRIVATE_KEY configured — only dry-run scanning.");
  } else {
    console.log("Using wallet:", await wallet.getAddress());
  }

  console.log("Arb contract:", CONTRACT_ADDRESS, "USDC address (will be fetched on demand).");

  while (true) {
    for (const [sym, token] of Object.entries(tokens)) {
      for (const [buyName, buyRouter] of Object.entries(routers)) {
        for (const [sellName, sellRouter] of Object.entries(routers)) {
          if (buyName === sellName) continue;
          try {
            // quick filter: compute small approximate profit quickly
            const buyOut = await getAmountOut(buyRouter, token, TRADE_AMOUNT_USDC);
            const sellOut = await getAmountOut(sellRouter, token, TRADE_AMOUNT_USDC);
            // approximate price: how much USDC you'd get back versus amount in
            // Note: buyOut and sellOut are token units — we approximate buy/sell price loosely:
            // prefer to call computeExpectedProfit directly for accurate profit
            const approxProfit = await computeExpectedProfit(buyRouter, sellRouter, token, TRADE_AMOUNT_USDC);
            if (approxProfit <= 0) continue;
            console.log(`Candidate ${sym} ${buyName} -> ${sellName} approxProfit USDC: ${fmt(approxProfit)}`);

            // attempt arb if wallet exists
            if (wallet) {
              const ok = await attemptArb(wallet, buyRouter, sellRouter, token, TRADE_AMOUNT_USDC);
              if (ok) {
                console.log("✅ Arb completed for", sym, buyName, "->", sellName);
              }
            }
          } catch (err) {
            console.warn("scan error:", err.message || err);
          }
        }
      }
    }
    // throttle loop
    await new Promise(r => setTimeout(r, 5000));
  }
}

mainLoop().catch(e => console.error("Fatal:", e));

