// arb.js — Live-ready Flashbots + Polygon arbitrage bot
// WARNING: This code will send live transactions if DRY_RUN=false and env vars set.
// npm i ethers @flashbots/ethers-provider-bundle dotenv

import { ethers } from "ethers";
import dotenv from "dotenv";
import { FlashbotsBundleProvider } from "@flashbots/ethers-provider-bundle";
dotenv.config();

// --------------------------------------------------
// CONFIG
// --------------------------------------------------
const DRY_RUN = process.env.DRY_RUN === "true" || true; // set to false to run live
console.log("DRY_RUN =", DRY_RUN ? "ENABLED (no tx will be broadcast)" : "DISABLED (LIVE TXs)");

// Polygon RPC
const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com";
const provider = new ethers.JsonRpcProvider(RPC_URL);

// Keys
const PRIVATE_KEY = process.env.PRIVATE_KEY; // wallet that will sign the arb tx
const AUTH_PRIVATE_KEY = process.env.AUTH_PRIVATE_KEY; // auth key for Flashbots
if (!PRIVATE_KEY || !AUTH_PRIVATE_KEY) {
  console.warn("⚠️ PRIVATE_KEY or AUTH_PRIVATE_KEY not set in .env — running read-only if DRY_RUN true.");
}

// Hardcoded contract address (user provided)
const CONTRACT_ADDRESS = "0x19B64f74553eE0ee26BA01BF34321735E4701C43";

// Minimum absolute profit in USDC (6 decimals)
const MIN_NET_PROFIT_USDC = 1; // $1
// Add safety cushion percent to account for movement during send -> inclusion
const CUSHION_PCT = 1.5; // 1.5% cushion

// Aave flash loan premium percent (set conservatively; read on-chain for exact if needed)
const AAVE_FLASH_FEE_PCT = 0.0005; // 0.05% (0.0005 as fraction). Adjust if your pool differs.

// trade params
const TRADE_AMOUNT_USDC = 0.04; // USDC units to test; increase for live
const MIN_PROFIT_PCT = 3;
const SLIPPAGE_PCT = 0;

// routers (hardcoded for Polygon)
const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  Dfyn: "0xA8b607Aa09B6A2641CF6F90F643E76D3F6E6Ff73",
  ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};

// tokens
const tokens = {
  AAVE: { address: "0xd6df932a45c0f255f85145f286ea0b292b21c90b", decimals: 18 },
  CRV:  { address: "0x172370d5cd63279efa6d502dab29171933a610af", decimals: 18 },
  LINK: { address: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39", decimals: 18 },
  WBTC: { address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", decimals: 8 }
};

// arb contract ABI (minimal)
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

// -----------------------------------------
// small helpers
// -----------------------------------------
function fmt(n, dec = 6) {
  return Number(n).toFixed(dec);
}

// get router getAmountsOut
async function getAmountOut(routerAddr, token, amountInUSDC) {
  const router = new ethers.Contract(
    routerAddr,
    ["function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory)"],
    provider
  );

  const usdcAddress = await arbContract.USDC();
  const path = [usdcAddress, token.address];

  try {
    const amounts = await router.getAmountsOut(
      ethers.parseUnits(amountInUSDC.toString(), 6),
      path
    );
    return Number(ethers.formatUnits(amounts[1], token.decimals));
  } catch (err) {
    // fallback path via WBTC
    const fallback = [usdcAddress, tokens.WBTC.address, token.address];
    const amounts = await router.getAmountsOut(
      ethers.parseUnits(amountInUSDC.toString(), 6),
      fallback
    );
    return Number(ethers.formatUnits(amounts[2], token.decimals));
  }
}

// convert ETH amount to USDC using a router (WETH -> USDC)
async function ethToUSDC(routerAddr, ethAmount) {
  // Using a router path WETH -> USDC
  // On Polygon, wrapped native is WMATIC, but routers usually accept WETH-like padded sorts.
  // We'll use a conservative approach: use a popular router (QuickSwap) path via WMATIC
  // NOTE: If you run this live, ensure path addresses are correct for Polygon WMATIC and USDC
  const usdcAddress = await arbContract.USDC();
  const WMATIC = "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270"; // WMATIC on Polygon
  const router = new ethers.Contract(routerAddr, ["function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory)"], provider);

  try {
    const amounts = await router.getAmountsOut(
      ethers.parseUnits(ethAmount.toString(), 18),
      [WMATIC, usdcAddress]
    );
    // amounts[1] is USDC with 6 decimals
    return Number(ethers.formatUnits(amounts[1], 6));
  } catch (err) {
    console.warn("ethToUSDC failed, fallback to zero:", err.message);
    return 0;
  }
}

// compute expected profit (USDC) performing: USDC -> token on buyRouter, then token -> USDC on sellRouter
async function computeExpectedProfit(buyRouter, sellRouter, token, amountUSDC) {
  // buyOut = token units you get when swapping amountUSDC on buyRouter
  const buyOut = await getAmountOut(buyRouter, token, amountUSDC); // token units
  // now get amountUSDC you'd receive selling that token on sellRouter
  // We need a helper getAmountsOut from token -> USDC
  const router = new ethers.Contract(
    sellRouter,
    ["function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory)"],
    provider
  );
  const usdcAddress = await arbContract.USDC();

  // path token -> USDC (maybe via WBTC)
  try {
    const amounts = await router.getAmountsOut(
      // convert buyOut (token units) to token decimals
      ethers.parseUnits(buyOut.toString(), token.decimals),
      [token.address, usdcAddress]
    );
    const finalUSDC = Number(ethers.formatUnits(amounts[1], 6));
    const grossProfitUSDC = finalUSDC - amountUSDC;
    return grossProfitUSDC;
  } catch (err) {
    // fallback via intermediate WBTC
    const fallback = [token.address, tokens.WBTC.address, usdcAddress];
    const amounts = await router.getAmountsOut(
      ethers.parseUnits(buyOut.toString(), token.decimals),
      fallback
    );
    const finalUSDC = Number(ethers.formatUnits(amounts[2], 6));
    const grossProfitUSDC = finalUSDC - amountUSDC;
    return grossProfitUSDC;
  }
}

// estimate gas cost in USDC for a tx
async function estimateGasCostInUSDC(signer, txRequest) {
  // estimate gas
  const estimatedGas = await signer.estimateGas(txRequest);
  const feeData = await provider.getFeeData();
  const gasPrice = feeData.maxFeePerGas || feeData.gasPrice;
  const gasCostWei = estimatedGas * gasPrice;
  const gasCostEth = Number(ethers.formatUnits(gasCostWei, 18));

  // convert gasCostEth -> USDC using quickswap router
  const gasCostUSDC = await ethToUSDC(routers.QuickSwap, gasCostEth);
  return { estimatedGas, gasCostUSDC, gasCostEth };
}

// callStatic check — returns true if it would not revert
async function callStaticOk(signer, buyRouter, sellRouter, tokenAddr, amountUSDC) {
  const arb = arbContract.connect(signer);
  try {
    // callStatic will throw if it would revert
    await arb.callStatic.executeArbitrage(buyRouter, sellRouter, tokenAddr, ethers.parseUnits(amountUSDC.toString(), 6), { gasLimit: 5_000_000 });
    return true;
  } catch (err) {
    // revert likely
    return false;
  }
}

// -------------------------------------------
// Flashbots provider setup (private bundle)
// -------------------------------------------
async function getFlashbotsProvider(authSigner) {
  // Use Flashbots relay endpoint (docs: relay.flashbots.net)
  const FLASHBOTS_RELAY = "https://relay.flashbots.net"; // documented
  return await FlashbotsBundleProvider.create(provider, authSigner, FLASHBOTS_RELAY);
}

// -------------------------------------------------
// Core: attempt to produce and send a Flashbots bundle
// -------------------------------------------------
async function attemptArb(signer, authSigner, buyRouter, sellRouter, token, amountUSDC) {
  const arbWithSigner = arbContract.connect(signer);

  // compute expected profit (gross)
  const grossProfitUSDC = await computeExpectedProfit(buyRouter, sellRouter, token, amountUSDC);

  // subtract Aave flash fee
  const aaveFee = amountUSDC * AAVE_FLASH_FEE_PCT;
  const profitAfterAave = grossProfitUSDC - aaveFee;

  if (profitAfterAave <= 0) {
    console.log("Not profitable after Aave fee:", profitAfterAave);
    return false;
  }

  // prepare unsigned tx data (populate)
  const populated = await arbWithSigner.populateTransaction.executeArbitrage(
    buyRouter, sellRouter, token.address, ethers.parseUnits(amountUSDC.toString(), 6)
  );

  // estimate gas cost in USDC
  const { estimatedGas, gasCostUSDC } = await estimateGasCostInUSDC(signer, {
    to: CONTRACT_ADDRESS,
    data: populated.data
  });

  // compute net expected
  const netExpectedUSDC = profitAfterAave - gasCostUSDC;
  const netWithCushion = netExpectedUSDC * (1 - CUSHION_PCT / 100);

  console.log("PROFIT CHECK:",
    "gross:", fmt(grossProfitUSDC),
    "afterAave:", fmt(profitAfterAave),
    "gasCostUSDC:", fmt(gasCostUSDC),
    "net:", fmt(netExpectedUSDC),
    `cushion(${CUSHION_PCT}%):`, fmt(netWithCushion)
  );

  // require minimum net profit and positive after cushion
  if (netWithCushion < MIN_NET_PROFIT_USDC || (netExpectedUSDC <= 0)) {
    console.log("Skipping — net expected after fees & gas too low.");
    return false;
  }

  // callStatic check
  if (!(await callStaticOk(signer, buyRouter, sellRouter, token.address, amountUSDC))) {
    console.log("callStatic indicates tx would revert — skipping.");
    return false;
  }

  // Build and sign tx
  const wallet = signer;
  const txRequest = {
    to: CONTRACT_ADDRESS,
    data: populated.data,
    gasLimit: estimatedGas
  };

  const signedTx = await wallet.signTransaction({
    to: CONTRACT_ADDRESS,
    data: populated.data,
    gasLimit: estimatedGas,
    // Max fees: let provider estimate
  });

  // create flashbots provider and send one-tx bundle targeting next block
  const fbProvider = await getFlashbotsProvider(authSigner);
  const blockNum = await provider.getBlockNumber();
  const targetBlock = blockNum + 1;

  if (DRY_RUN) {
    console.log("DRY_RUN: would send bundle to Flashbots for block", targetBlock);
    console.log("SignedTx (first 120 chars):", signedTx.slice(0, 120));
    return true;
  }

  // send bundle
  const sendResult = await fbProvider.sendBundle(
    [
      { signedTransaction: signedTx }
    ],
    targetBlock
  );

  const sim = await sendResult.simulate();
  if (sim.firstRevert) {
    console.log("Flashbots simulation shows revert:", sim.firstRevert);
    return false;
  } else {
    console.log("Flashbots simulation OK — waiting for inclusion...");
  }

  // wait for inclusion result
  const waitRes = await sendResult.wait();
  if (waitRes === 0) {
    console.log("Bundle not included in target block.");
    return false;
  } else {
    console.log("Bundle included in block — success!");
    return true;
  }
}

// ---------------------------------------------
// Scanning loop (drives compute/attemptArb)
// ---------------------------------------------
async function scanAndRun() {
  // prepare signers
  const wallet = PRIVATE_KEY ? new ethers.Wallet(PRIVATE_KEY, provider) : null;
  const authSigner = AUTH_PRIVATE_KEY ? new ethers.Wallet(AUTH_PRIVATE_KEY) : null; // no provider needed

  console.log("Contract:", await arbContract.getAddress());
  if (wallet) console.log("Using signer:", await wallet.getAddress());
  if (authSigner) console.log("Auth signer set (Flashbots)");

  while (true) {
    for (const [symbol, token] of Object.entries(tokens)) {
      for (const [buyName, buyRouter] of Object.entries(routers)) {
        for (const [sellName, sellRouter] of Object.entries(routers)) {
          if (buyName === sellName) continue;
          try {
            // Compute buy & sell amounts just to log (cheap calls)
            const buyOut = await getAmountOut(buyRouter, token, TRADE_AMOUNT_USDC);
            const sellOut = await getAmountOut(sellRouter, token, TRADE_AMOUNT_USDC);

            // Compute buy/sell price approximations
            const buyPrice = TRADE_AMOUNT_USDC / buyOut;
            const sellPrice = TRADE_AMOUNT_USDC / sellOut;
            const grossProfitUSDC = sellPrice - buyPrice;

            // Only attempt detailed flow if promising relative numbers (quick filter)
            if (grossProfitUSDC <= 0) continue;

            console.log(`Potential: ${symbol} ${buyName}->${sellName} estGrossProfitUSDc:${fmt(grossProfitUSDC)}`);
            // attempt arbitrage
            if (wallet && authSigner) {
              const ok = await attemptArb(wallet, authSigner, buyRouter, sellRouter, token, TRADE_AMOUNT_USDC);
              if (ok) {
                console.log(`✅ Arb executed for ${symbol} ${buyName}->${sellName}`);
              }
            } else {
              console.log("No signer/auth configured — dry run only.");
            }
          } catch (err) {
            console.warn("scan error:", err.message || err);
          }
        }
      }
    }
    await new Promise(r => setTimeout(r, 5000));
  }
}

// start
scanAndRun().catch(e => {
  console.error("Fatal error:", e);
});

