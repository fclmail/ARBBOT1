/**
 * arbitrage_live.js
 * Polygon mainnet arb bot — uses MEV Blocker private RPC for mempool protection
 * - Ethers v6
 * - Requires .env with PRIVATE_RPC, PRIVATE_KEY, DRY_RUN, CONTRACT_ADDRESS
 *
 * npm i ethers dotenv
 */

import dotenv from "dotenv";
import { ethers } from "ethers";
dotenv.config();

// -------- CONFIG (you provided these) ----------
const PRIVATE_RPC = process.env.PRIVATE_RPC || "https://polygon-rpc.com";
const provider = new ethers.JsonRpcProvider(PRIVATE_RPC);

const PRIVATE_KEY = process.env.PRIVATE_KEY || "";
const DRY_RUN = (process.env.DRY_RUN === "true") || true;
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS || "0x19B64f74553eE0ee26BA01BF34321735E4701C43";

// USDC on Polygon (Circle)
const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

// Aave Pool (Polygon mainnet)
const AAVE_POOL_ADDRESS = "0x794a61358D6845594F94dc1DB02A252b5b4814aD";

// Trading / safety params
const TRADE_AMOUNT_USDC = 0.04;   // per-scan trade size in USDC (adjust to meaningful live amount)
const MIN_NET_PROFIT_USDC = 1;    // absolute minimum profit in USDC to accept
const CUSHION_PCT = 1.5;          // safety cushion percent
const AAVE_FLASH_FEE_PCT = 0.0005; // 0.05% assumed premium (adjust if different)
const SLIPPAGE_PCT = 0;           // slippage offset applied to quotes (conservative)

// Routers on Polygon
const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  Dfyn: "0xA8b607Aa09B6A2641CF6F90F643E76D3F6E6Ff73",
  ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};

// Tokens considered (addresses & decimals)
const tokens = {
  AAVE: { address: "0xd6df932a45c0f255f85145f286ea0b292b21c90b", decimals: 18 },
  CRV:  { address: "0x172370d5cd63279efa6d502dab29171933a610af", decimals: 18 },
  LINK: { address: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39", decimals: 18 },
  WBTC: { address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", decimals: 8 }
};

// ABI: use the ABI you supplied (we include relevant functions only)
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
  {
    "inputs": [],
    "name": "USDC",
    "outputs": [{ "internalType": "address", "name": "", "type": "address" }],
    "stateMutability": "view",
    "type": "function"
  },
  { "inputs": [], "name": "owner", "outputs": [{ "internalType": "address", "name": "", "type": "address" }], "stateMutability": "view", "type": "function" }
];

// Create contract instance (read-only with provider; we will connect signer when sending)
const arbContract = new ethers.Contract(CONTRACT_ADDRESS, arbAbi, provider);

// small formatter
function fmt(n, dec = 6) { return Number(n).toFixed(dec); }

// getAmountsOut wrapper with fallback via WBTC
async function getAmountOut(routerAddr, token, amountInUSDC) {
  const router = new ethers.Contract(routerAddr, ["function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory)"], provider);
  try {
    const amounts = await router.getAmountsOut(ethers.parseUnits(amountInUSDC.toString(), 6), [USDC_ADDRESS, token.address]);
    // amounts[1] is token output (token decimals)
    return Number(ethers.formatUnits(amounts[1], token.decimals));
  } catch (err) {
    // fallback path via WBTC
    const fallback = [USDC_ADDRESS, tokens.WBTC.address, token.address];
    const amounts = await router.getAmountsOut(ethers.parseUnits(amountInUSDC.toString(), 6), fallback);
    return Number(ethers.formatUnits(amounts[amounts.length - 1], token.decimals));
  }
}

// compute expected gross profit in USDC from swapping amountUSDC on buyRouter -> token -> sellRouter -> USDC
async function computeExpectedProfit(buyRouter, sellRouter, token, amountUSDC) {
  try {
    const buyOutTokenUnits = await getAmountOut(buyRouter, token, amountUSDC); // token units
    // now estimate selling that token on sellRouter to USDC
    const router = new ethers.Contract(sellRouter, ["function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory)"], provider);
    try {
      const amounts = await router.getAmountsOut(ethers.parseUnits(buyOutTokenUnits.toString(), token.decimals), [token.address, USDC_ADDRESS]);
      const finalUSDC = Number(ethers.formatUnits(amounts[1], 6));
      return finalUSDC - amountUSDC;
    } catch (err) {
      // try fallback via WBTC
      const fallback = [token.address, tokens.WBTC.address, USDC_ADDRESS];
      const amounts = await router.getAmountsOut(ethers.parseUnits(buyOutTokenUnits.toString(), token.decimals), fallback);
      const finalUSDC = Number(ethers.formatUnits(amounts[amounts.length - 1], 6));
      return finalUSDC - amountUSDC;
    }
  } catch (err) {
    return -Infinity;
  }
}

// estimate gas cost (in MATIC) and then convert to USDC via QuickSwap WMATIC -> USDC
async function estimateGasCostInUSDC(signer, txRequest) {
  const estimatedGas = await signer.estimateGas(txRequest);
  const feeData = await provider.getFeeData();
  const maxFeePerGas = feeData.maxFeePerGas || feeData.gasPrice;
  const gasCostWei = estimatedGas * maxFeePerGas;
  const gasCostMatic = Number(ethers.formatUnits(gasCostWei, 18)); // MATIC amount (approx)
  // convert MATIC -> USDC using QuickSwap
  const WMATIC = "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270";
  const router = new ethers.Contract(routers.QuickSwap, ["function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory)"], provider);
  try {
    const amounts = await router.getAmountsOut(ethers.parseUnits(gasCostMatic.toString(), 18), [WMATIC, USDC_ADDRESS]);
    const gasUSDC = Number(ethers.formatUnits(amounts[1], 6));
    return { estimatedGas, gasCostUSDC: gasUSDC, gasCostMatic };
  } catch (err) {
    // fallback: if quote fails, return large gas cost to be safe
    return { estimatedGas, gasCostUSDC: 9999, gasCostMatic };
  }
}

// callStatic to simulate the exact executeArbitrage call (must connect wallet signer)
async function callStaticOk(signer, buyRouter, sellRouter, tokenAddr, amountUSDC) {
  const arb = arbContract.connect(signer);
  try {
    // callStatic will throw if tx would revert
    await arb.callStatic.executeArbitrage(buyRouter, sellRouter, tokenAddr, ethers.parseUnits(amountUSDC.toString(), 6), { gasLimit: 5_000_000 });
    return true;
  } catch (err) {
    // aborted / revert expected
    return false;
  }
}

// read contract USDC balance
async function getContractUSDCBalance() {
  const erc20 = new ethers.Contract(USDC_ADDRESS, ["function balanceOf(address) view returns (uint256)"], provider);
  const bal = await erc20.balanceOf(CONTRACT_ADDRESS);
  return Number(ethers.formatUnits(bal, 6));
}

// attempt to build & send a signed transaction to the private RPC
async function attemptArb(signer, buyRouter, sellRouter, token, amountUSDC) {
  const arbWithSigner = arbContract.connect(signer);

  // 1) compute gross profit
  const grossProfitUSDC = await computeExpectedProfit(buyRouter, sellRouter, token, amountUSDC);
  if (!(grossProfitUSDC > 0)) return false;

  // 2) subtract Aave fee (approx)
  const aaveFee = amountUSDC * AAVE_FLASH_FEE_PCT;
  const profitAfterAave = grossProfitUSDC - aaveFee;
  if (profitAfterAave <= 0) {
    console.log("Not profitable after Aave fee:", fmt(profitAfterAave));
    return false;
  }

  // 3) build tx data
  const populated = await arbWithSigner.populateTransaction.executeArbitrage(buyRouter, sellRouter, token.address, ethers.parseUnits(amountUSDC.toString(), 6));
  const txReq = { to: CONTRACT_ADDRESS, data: populated.data };

  // 4) estimate gas cost in USDC
  const { estimatedGas, gasCostUSDC, gasCostMatic } = await estimateGasCostInUSDC(signer, txReq);

  // compute net expected
  const netExpectedUSDC = profitAfterAave - gasCostUSDC;
  const netAfterCushion = netExpectedUSDC * (1 - CUSHION_PCT / 100);

  console.log("Profit check -> gross:", fmt(grossProfitUSDC), "afterAave:", fmt(profitAfterAave), "gasUSDC:", fmt(gasCostUSDC), "net:", fmt(netExpectedUSDC), "netAfterCushion:", fmt(netAfterCushion));

  // 5) require net > MIN_NET_PROFIT_USDC
  if (netAfterCushion < MIN_NET_PROFIT_USDC || netExpectedUSDC <= 0) {
    console.log("Skipping — net expected after fees & gas too low.");
    return false;
  }

  // 6) callStatic check to ensure no revert
  const okStatic = await callStaticOk(signer, buyRouter, sellRouter, token.address, amountUSDC);
  if (!okStatic) {
    console.log("callStatic indicates tx would revert — skipping.");
    return false;
  }

  // 7) finalize options & send (MEV Blocker provider will keep it private)
  const feeData = await provider.getFeeData();
  const txOptions = {
    gasLimit: estimatedGas,
    maxFeePerGas: feeData.maxFeePerGas,
    maxPriorityFeePerGas: feeData.maxPriorityFeePerGas
  };

  if (DRY_RUN) {
    console.log("DRY_RUN: would send transaction with txOptions:", {
      gasLimit: estimatedGas.toString(),
      maxFeePerGas: feeData.maxFeePerGas ? fmt(Number(ethers.formatUnits(feeData.maxFeePerGas, "gwei")), 6) + " gwei" : "n/a"
    });
    return true;
  }

  // send real tx
  try {
    const tx = await arbWithSigner.executeArbitrage(buyRouter, sellRouter, token.address, ethers.parseUnits(amountUSDC.toString(), 6), txOptions);
    console.log("TX SENT:", tx.hash);
    const receipt = await tx.wait();
    console.log("TX MINED:", receipt.blockNumber, "status:", receipt.status);

    // read contract USDC balance (profit deposited)
    const contractUSDC = await getContractUSDCBalance();
    console.log("Contract USDC balance:", fmt(contractUSDC));

    return receipt.status === 1;
  } catch (err) {
    console.warn("TX failed:", err.reason || err.message || err);
    return false;
  }
}

// main scanning loop
async function main() {
  console.log("RPC:", PRIVATE_RPC, "DRY_RUN:", DRY_RUN ? "enabled" : "disabled");
  const wallet = PRIVATE_KEY ? new ethers.Wallet(PRIVATE_KEY, provider) : null;
  if (!wallet) {
    console.warn("No PRIVATE_KEY provided; switching to read-only dry-run scan mode.");
  } else {
    console.log("Signer address:", await wallet.getAddress());
    // sanity: check signer is contract owner
    try {
      const owner = await arbContract.owner();
      if (owner.toLowerCase() !== (await wallet.getAddress()).toLowerCase()) {
        console.warn("WARNING: signer is not contract owner — executeArbitrage will revert if called.");
      } else {
        console.log("Signer is contract owner (OK).");
      }
    } catch (e) {
      console.warn("Could not fetch contract owner:", e.message || e);
    }
  }

  while (true) {
    for (const [sym, token] of Object.entries(tokens)) {
      for (const [buyName, buyRouter] of Object.entries(routers)) {
        for (const [sellName, sellRouter] of Object.entries(routers)) {
          if (buyName === sellName) continue;
          try {
            // quick check: compute expected profit for the pair
            const approxProfit = await computeExpectedProfit(buyRouter, sellRouter, token, TRADE_AMOUNT_USDC);
            if (!(approxProfit > 0)) continue;
            console.log(`Candidate ${sym} ${buyName} -> ${sellName} approxProfit USDC: ${fmt(approxProfit)}`);

            if (wallet) {
              const success = await attemptArb(wallet, buyRouter, sellRouter, token, TRADE_AMOUNT_USDC);
              if (success) {
                console.log("✅ Arbitrage executed:", sym, buyName, "->", sellName);
              }
            }
          } catch (err) {
            console.warn("scan error:", err.message || err);
          }
        }
      }
    }
    // throttle
    await new Promise(r => setTimeout(r, 5000));
  }
}

main().catch(e => {
  console.error("Fatal error:", e);
  process.exit(1);
});

