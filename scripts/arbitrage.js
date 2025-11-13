// scripts/arb.js
// ────────────────────────────────────────────
// Aave flash arbitrage bot — robust version (works with your deployed contract)
// ─────────────────────────────────────────────
import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

// ─────────────── CONFIG ───────────────
const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) throw new Error("Missing PRIVATE_KEY in env");

const CONTRACT_ADDRESS = "0x19B64f74553eE0ee26BA01BF34321735E4701C43"; // deployed contract
const MATIC_USD = Number(process.env.MATIC_USD || 0.75); // used to convert gas->USDC estimate (editable)
const SCAN_INTERVAL_MS = 40_000; // 40 seconds

// Trading & safety settings
const TRADE_AMOUNT_USDC = 1.00;        // user-specified trade amount (change as desired)
const MIN_PROFIT_PCT = 3.0;            // require this % profit (on gross) to consider
const MIN_NET_PROFIT_USDC = 0.01;      // require at least this net profit after gas (USDC)
const MIN_CONTRACT_USDC_BUFFER = 0.02; // contract USDC buffer required before executing (to cover tiny slippage/premium)
const GAS_USAGE_GUESS = 1_000_000;     // conservative gas usage guess for estimation

// ─────────────── ETHERS SETUP ───────────────
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

// ─────────────── ABIs ───────────────
const erc20Abi = [
  "function balanceOf(address owner) view returns (uint256)"
];

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
  { "inputs": [], "name": "USDC", "outputs": [{ "internalType": "address", "name": "", "type": "address" }], "stateMutability": "view", "type": "function" }
];

// ─────────────── CONTRACT CONNECTION ───────────────
const arbContract = new ethers.Contract(CONTRACT_ADDRESS, arbAbi, wallet);

// sanity check
async function sanity() {
  try {
    console.log("✅ Connected to contract:", await arbContract.getAddress());
    console.log("👤 Contract owner:", await arbContract.owner());
    console.log("🧾 Wallet address:", await wallet.getAddress());
  } catch (e) {
    console.error("❌ Contract connection / ABI mismatch:", e.message);
    process.exit(1);
  }
}

// ─────────────── ROUTERS & TOKENS (normalized) ───────────────
const routerRaw = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  Dfyn: "0xA8b607Aa09B6A2641CF6F90F643E76D3F6E6Ff73", // ensure checksummed
  ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};

const tokenRaw = {
  AAVE: { address: "0xd6df932a45c0f255f85145f286ea0b292b21c90b", decimals: 18 },
  CRV: { address: "0x172370d5cd63279efa6d502dab29171933a610af", decimals: 18 },
  DAI: { address: "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063", decimals: 18 },
  LINK: { address: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39", decimals: 18 },
  WBTC: { address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", decimals: 8 },
  WETH: { address: "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619", decimals: 18 }
};

const routers = {};
for (const [k, v] of Object.entries(routerRaw)) {
  try { routers[k] = ethers.getAddress(v); }
  catch (e) { console.warn(`⚠️ Skipping invalid router address for ${k}: ${v}`); }
}
const tokens = {};
for (const [k, v] of Object.entries(tokenRaw)) {
  try { tokens[k] = { address: ethers.getAddress(v.address), decimals: v.decimals }; }
  catch (e) { console.warn(`⚠️ Skipping invalid token address for ${k}: ${v.address}`); }
}

// helper formatting
function fmt(n, d = 6) { return Number(n).toFixed(d); }

// getAmountsOut helper (tries direct path, then via WETH)
async function getAmountOut(routerAddr, token, amountInUSDC) {
  const router = new ethers.Contract(routerAddr, ["function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory)"], provider);
  const usdcAddr = await arbContract.USDC(); // read USDC token used by contract
  const path1 = [usdcAddr, token.address];
  try {
    const amounts = await router.getAmountsOut(ethers.parseUnits(amountInUSDC.toString(), 6), path1);
    const last = amounts[amounts.length - 1];
    return Number(ethers.formatUnits(last, token.decimals));
  } catch {
    const path2 = [usdcAddr, tokens.WETH.address, token.address];
    const amounts = await router.getAmountsOut(ethers.parseUnits(amountInUSDC.toString(), 6), path2);
    const last = amounts[amounts.length - 1];
    return Number(ethers.formatUnits(last, token.decimals));
  }
}

// compute gas cost in MATIC and USDC
async function estimateGasCostUSDC(txData, gasUsageGuess = GAS_USAGE_GUESS) {
  // estimate gas (try a real estimate, fallback to guess)
  let gasEstimate;
  try {
    gasEstimate = await wallet.estimateGas(txData);
  } catch {
    gasEstimate = ethers.BigInt(gasUsageGuess);
  }
  const gasPrice = await provider.getGasPrice(); // wei
  const gasWei = gasEstimate * gasPrice;
  const gasMatic = Number(ethers.formatUnits(gasWei, 18)); // MATIC
  const gasUSDC = gasMatic * MATIC_USD;
  return { gasEstimate, gasPrice, gasMatic, gasUSDC };
}

// check wallet MATIC balance
async function getWalletMaticBalance() {
  const bal = await provider.getBalance(await wallet.getAddress());
  return Number(ethers.formatUnits(bal, 18));
}

// core executeTrade (with callStatic, gas estimates, pre/post balances)
async function executeTrade(buyRouter, sellRouter, tokenObj, amountUSDC) {
  const usdcAddr = await arbContract.USDC();
  const usdcContract = new ethers.Contract(usdcAddr, erc20Abi, provider);

  // pre balances
  const preContractBalBN = await usdcContract.balanceOf(CONTRACT_ADDRESS);
  const preContractBal = Number(ethers.formatUnits(preContractBalBN, 6));

  // populate tx
  const parsedAmount = ethers.parseUnits(amountUSDC.toString(), 6);
  const txData = await arbContract.populateTransaction.executeArbitrage(
    buyRouter, sellRouter, tokenObj.address, parsedAmount
  );

  // estimate gas cost in USDC
  const { gasEstimate, gasPrice, gasMatic, gasUSDC } = await estimateGasCostUSDC(txData);

  // compute buy/sell prices & estimated profit (use getAmountOut)
  const buyOut = await getAmountOut(buyRouter, tokenObj, amountUSDC);
  const sellOut = await getAmountOut(sellRouter, tokenObj, amountUSDC);
  const buyPrice = amountUSDC / buyOut;
  const sellPrice = amountUSDC / sellOut;
  const estimatedProfitGross = sellPrice - buyPrice; // USDC
  const estimatedProfitAfterSlippage = estimatedProfitGross * (1 - (0.0)); // slippage 0% here; adjust if needed
  const netProfitBeforeBuffer = estimatedProfitAfterSlippage - gasUSDC;

  // wallet MATIC check
  const walletMatic = await getWalletMaticBalance();

  console.log("------------------------------------------------------------");
  console.log(`🔹 Opportunity: Buy on ${buyRouter} / Sell on ${sellRouter}`);
  console.log(`🔸 Token: ${tokenObj.address}`);
  console.log(`🔸 Buy price: $${fmt(buyPrice,6)} | Sell price: $${fmt(sellPrice,6)}`);
  console.log(`🔸 Estimated gross profit: ${fmt(estimatedProfitAfterSlippage,6)} USDC`);
  console.log(`💸 Estimated gas: ${fmt(gasMatic,6)} MATIC ≈ ${fmt(gasUSDC,6)} USDC (gasPrice ${ethers.formatUnits(gasPrice, "gwei")} gwei, gasEstimate ${gasEstimate})`);
  console.log(`🧮 Net profit after gas: ${fmt(netProfitBeforeBuffer,6)} USDC`);
  console.log(`🏦 Contract USDC balance (before): ${fmt(preContractBal,6)} USDC`);
  console.log(`⏳ Wallet MATIC balance: ${fmt(walletMatic,6)} MATIC`);

  // safety checks before sending transaction:
  if (preContractBal < MIN_CONTRACT_USDC_BUFFER) {
    console.warn(`⚠️ Skipping: contract USDC buffer too low (< ${MIN_CONTRACT_USDC_BUFFER} USDC).`);
    return { sent: false, reason: "low_contract_buffer", preContractBal, estimatedProfitAfterSlippage, gasUSDC };
  }

  if (netProfitBeforeBuffer < MIN_NET_PROFIT_USDC) {
    console.warn(`⚠️ Skipping: net profit (${fmt(netProfitBeforeBuffer,6)} USDC) < MIN_NET_PROFIT_USDC (${MIN_NET_PROFIT_USDC}).`);
    return { sent: false, reason: "low_net_profit", netProfitBeforeBuffer, gasUSDC };
  }

  const estimatedMaticNeeded = gasMatic * 1.1; // small buffer
  if (walletMatic < estimatedMaticNeeded) {
    console.warn(`⚠️ Skipping: wallet MATIC (${fmt(walletMatic,6)}) < estimated needed (${fmt(estimatedMaticNeeded,6)}).`);
    return { sent: false, reason: "low_wallet_matic", walletMatic, estimatedMaticNeeded };
  }

  // callStatic simulation to avoid sending txs that will revert on-chain
  try {
    await arbContract.callStatic.executeArbitrage(buyRouter, sellRouter, tokenObj.address, parsedAmount, { gasLimit: gasEstimate.mul(2) });
  } catch (simErr) {
    console.warn(`⚠️ callStatic simulation reverted — skipping execution. reason: ${simErr.reason || simErr.message}`);
    return { sent: false, reason: "callStatic_revert", simErr };
  }

  // send tx
  try {
    const tx = await arbContract.executeArbitrage(buyRouter, sellRouter, tokenObj.address, parsedAmount, { gasLimit: gasEstimate.mul(2) });
    console.log(`⏳ Trade tx sent: ${tx.hash} — waiting for confirmation...`);
    const receipt = await tx.wait();
    console.log(`✅ Tx mined in block ${receipt.blockNumber} | gasUsed: ${receipt.gasUsed.toString()}`);

    // post balances
    const postContractBalBN = await usdcContract.balanceOf(CONTRACT_ADDRESS);
    const postContractBal = Number(ethers.formatUnits(postContractBalBN, 6));
    const profitToContract = postContractBal - preContractBal;

    console.log(`🏦 Contract USDC balance (after): ${fmt(postContractBal,6)} USDC`);
    console.log(`💹 Net USDC change for contract this tx: ${fmt(profitToContract,6)} USDC`);
    return { sent: true, receipt, profitToContract, gasUSDC };
  } catch (txErr) {
    console.error(`⚠️ Transaction failed (sent or reverted): ${txErr.reason || txErr.message}`);
    return { sent: false, reason: "tx_failed", txErr };
  }
}

// ─────────────── SCAN LOOP ───────────────
async function scan() {
  console.log("🔍 Starting arbitrage scan...");
  for (const [symbol, tokenObj] of Object.entries(tokens)) {
    for (const [buyName, buyRouterRaw] of Object.entries(routers)) {
      for (const [sellName, sellRouterRaw] of Object.entries(routers)) {
        if (buyName === sellName) continue;

        // ensure routers exist
        if (!buyRouterRaw || !sellRouterRaw) continue;

        try {
          // compute buy/sell amounts (token units)
          const buyOut = await getAmountOut(buyRouterRaw, tokenObj, TRADE_AMOUNT_USDC);
          const sellOut = await getAmountOut(sellRouterRaw, tokenObj, TRADE_AMOUNT_USDC);

          // prices in USDC per token (approx)
          const buyPrice = TRADE_AMOUNT_USDC / buyOut;
          const sellPrice = TRADE_AMOUNT_USDC / sellOut;

          let estimatedProfit = sellPrice - buyPrice;
          estimatedProfit *= (1 - SLIPPAGE_PCT / 100); // apply global slippage factor

          const profitPct = (estimatedProfit / buyPrice) * 100;

          if (profitPct >= MIN_PROFIT_PCT) {
            console.log(`\n🚨 ${symbol} | Buy:${buyName} @ $${fmt(buyPrice,6)} → Sell:${sellName} @ $${fmt(sellPrice,6)} | Estimated profit: ${fmt(estimatedProfit,6)} USDC (${fmt(profitPct,2)}%)`);
            await executeTrade(buyRouterRaw, sellRouterRaw, tokenObj, TRADE_AMOUNT_USDC);
          }
        } catch (e) {
          console.warn(`⚠️ Error scanning ${symbol} ${buyName}->${sellName}: ${e.message}`);
        }
      }
    }
  }
  console.log("🔍 Scan pass finished.\n");
}

// ─────────────── MAIN ───────────────
(async () => {
  await sanity();
  console.log("🚀 Starting main loop (scan every 40s)...");
  while (true) {
    try { await scan(); }
    catch (e) { console.error("Critical scan error:", e); }
    await new Promise(res => setTimeout(res, SCAN_INTERVAL_MS));
  }
})();

