// arb-vault-40pct.js
// Ethers v6
// Hardcoded vault + owner wallet
// Primary gate: callStatic
// Reject opportunities where expected profit > 40% (filter false quotes)
// Try to ensure vault balance increases by requiring expectedProfit > gasUSDC + MIN_EXPECTED_PROFIT
// WARNING: cannot guarantee vault balance will always increase in the real world.

import { ethers, Wallet } from "ethers";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config();

// ---------- CONFIG ----------
const DRY_RUN = false; // set true to skip send
console.log(DRY_RUN ? "🔬 DRY RUN — NO ON-CHAIN TRANSACTIONS" : "🚀 LIVE MODE ENABLED — REAL TRADES WILL EXECUTE");

// Hardcoded: set your real RPC and PRIVATE_KEY in env or here (not recommended)
const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY || "";
if (!PRIVATE_KEY) throw new Error("PRIVATE_KEY required (set env PRIVATE_KEY)");

/** ---------- HARDCODED VAULT & OWNER ---------- **
 * Replace with the vault contract address you control and want to orchestrate.
 * The script assumes that the owner of the vault is the supplied PRIVATE_KEY wallet.
 */
const VAULT_CONTRACT = "0x19B64f74553eE0ee26BA01BF34321735E4701C43"; // hardcoded vault
// ---------- POLICY / GUARDS ----------
const MIN_TRADE_USDC = Number(process.env.MIN_TRADE_USDC || 0.01); // min trade size in USDC (increase from tiny)
const MIN_EXPECTED_PROFIT = Number(process.env.MIN_EXPECTED_PROFIT || 0.00005); // absolute minimum profit in USDC
const SCAN_INTERVAL_MS = Number(process.env.SCAN_INTERVAL_MS || 30000);
const MAX_PROFIT_PCT = 40; // cap: reject opportunities where expected profit > 40% of amount
const SLIPPAGE_PCT = Number(process.env.SLIPPAGE_PCT || 0.5); // 0.5% slippage assumption
const MAX_CONCURRENCY = 6; // how many concurrent callStatic checks
const TRADE_AMOUNT_USDC = Number(process.env.TRADE_AMOUNT_USDC || 0.02); // default trade size (use meaningful amount)
const CSV_PATH = process.env.CSV_PATH || "./arb_log.csv";

// ---------- ROUTERS & TOKENS ----------
const routers = {
    QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
    SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
    ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607",
};

const tokens = {
    AAVE: { symbol: "AAVE", address: "0xd6df932a45c0f255f85145f286ea0b292b21c90b", decimals: 18 },
    CRV: { symbol: "CRV", address: "0x172370d5cd63279efa6d502dab29171933a610af", decimals: 18 },
    LINK: { symbol: "LINK", address: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39", decimals: 18 },
    WBTC: { symbol: "WBTC", address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", decimals: 8 },
};

// constants
const WMATIC = "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270";

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new Wallet(PRIVATE_KEY, provider);

// ABIs: minimal
const arbAbi = [
    {
        inputs: [
            { internalType: "address", name: "buyRouter", type: "address" },
            { internalType: "address", name: "sellRouter", type: "address" },
            { internalType: "address", name: "token", type: "address" },
            { internalType: "uint256", name: "amountIn", type: "uint256" },
        ],
        name: "executeArbitrage",
        outputs: [],
        stateMutability: "nonpayable",
        type: "function",
    },
    { inputs: [], name: "USDC", outputs: [{ internalType: "address", name: "", type: "address" }], stateMutability: "view", type: "function" },
    { inputs: [], name: "owner", outputs: [{ internalType: "address", name: "", type: "address" }], stateMutability: "view", type: "function" },
    { inputs: [], name: "minProfit", outputs: [{ internalType: "uint256", name: "", type: "uint256" }], stateMutability: "view", type: "function" },
];

const erc20Abi = [
    "function balanceOf(address owner) view returns (uint256)",
    "function decimals() view returns (uint8)",
    "function symbol() view returns (string)",
];

const arbContract = new ethers.Contract(VAULT_CONTRACT, arbAbi, wallet);
let usdcContract;

// CSV logging helpers
function appendCsvRow(row) {
    const line = row.join(",") + "\n";
    fs.appendFileSync(CSV_PATH, line);
}

// formatting
function fmt(n, dec = 6) {
    if (!isFinite(n)) return String(n);
    return Number(n).toFixed(dec);
}

// ---------- HELPERS ----------
async function init() {
    const usdcAddr = await arbContract.USDC();
    usdcContract = new ethers.Contract(usdcAddr, erc20Abi, provider);
    const owner = await arbContract.owner();
    console.log(`🏛 Vault: ${VAULT_CONTRACT}`);
    console.log(`👤 Vault owner (on-chain): ${owner}`);
    console.log(`🔑 Local signer: ${wallet.address}`);
    if (owner.toLowerCase() !== wallet.address.toLowerCase()) {
        console.warn("⚠️ WARNING: your local signer is not the vault owner. Transactions will likely revert.");
    }
    // Create CSV header if not existing
    if (!fs.existsSync(CSV_PATH)) {
        appendCsvRow(["ts", "token", "buyRouter", "sellRouter", "amountUSDC", "expectedProfitUSDC", "estGasUSDC", "profitPct", "txHash", "status"]);
    }
}

// get router quote: amount of token for amount USDC
async function getAmountOut(routerAddr, token, amountUSDC) {
    try {
        const router = new ethers.Contract(
            routerAddr,
            ["function getAmountsOut(uint256 amountIn, address[] memory path) view returns (uint256[] memory)"],
            provider
        );
        const usdcAddr = await arbContract.USDC();
        const path = [usdcAddr, token.address];
        const amounts = await router.getAmountsOut(ethers.parseUnits(amountUSDC.toString(), 6), path);
        const out = Number(ethers.formatUnits(amounts[1], token.decimals));
        if (!out || !isFinite(out) || out <= Number.EPSILON) return 0;
        return out;
    } catch (e) {
        return 0;
    }
}

// get reverse quote: amount of USDC if selling tokenAmount to USDC
async function getAmountOutReverse(routerAddr, token, tokenAmount) {
    try {
        const router = new ethers.Contract(
            routerAddr,
            ["function getAmountsOut(uint256 amountIn, address[] memory path) view returns (uint256[] memory)"],
            provider
        );
        const usdcAddr = await arbContract.USDC();
        const path = [token.address, usdcAddr];
        const parsed = ethers.parseUnits(tokenAmount.toString(), token.decimals);
        const amounts = await router.getAmountsOut(parsed, path);
        const out = Number(ethers.formatUnits(amounts[1], 6));
        if (!out || !isFinite(out) || out <= Number.EPSILON) return 0;
        return out;
    } catch (e) {
        return 0;
    }
}

// Estimate gas in USDC (uses QuickSwap to get USDC per MATIC price)
async function estimateGasCostUSDC(buyRouter, sellRouter, tokenAddr, amountUSDC) {
    try {
        const parsed = ethers.parseUnits(amountUSDC.toString(), 6);
        const gasEstimate = await arbContract.estimateGas.executeArbitrage(buyRouter, sellRouter, tokenAddr, parsed);
        const gasPrice = await provider.getGasPrice();
        const gasUsed = BigInt(gasEstimate.toString());
        const gasPriceBN = BigInt(gasPrice.toString());
        const gasCostNative = gasUsed * gasPriceBN; // in wei

        // quick: get one MATIC -> USDC via QuickSwap
        const quick = new ethers.Contract(
            routers.QuickSwap,
            ["function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory)"],
            provider
        );
        const oneMatic = ethers.parseUnits("1", 18);
        const usdcAddr = await arbContract.USDC();
        const amounts = await quick.getAmountsOut(oneMatic, [WMATIC, usdcAddr]);
        const usdcPerMatic = Number(ethers.formatUnits(amounts[1], 6));
        if (!usdcPerMatic || !isFinite(usdcPerMatic) || usdcPerMatic <= 0) return Infinity;
        return Number((Number(gasCostNative.toString()) / 1e18) * usdcPerMatic);
    } catch (e) {
        return Infinity;
    }
}

// compute expectedProfit using buy router and sell router. We calculate:
// tokenAmount = amountUSDC -> token via buyRouter (getAmountOut)
// sellUSDC = tokenAmount -> USDC via sellRouter (getAmountOutReverse)
// expectedProfit = (sellUSDC - amountUSDC) * (1 - slippage%)
async function computeExpectedProfit(buyRouter, sellRouter, token, amountUSDC) {
    const buyTokenAmount = await getAmountOut(buyRouter, token, amountUSDC);
    if (!buyTokenAmount) return { expectedProfitUSDC: 0, buyTokenAmount: 0, sellUSDC: 0 };

    const sellUSDC = await getAmountOutReverse(sellRouter, token, buyTokenAmount);
    if (!sellUSDC) return { expectedProfitUSDC: 0, buyTokenAmount, sellUSDC: 0 };

    const profitRaw = sellUSDC - amountUSDC;
    const expectedProfitUSDC = profitRaw * (1 - SLIPPAGE_PCT / 100);
    return { expectedProfitUSDC, buyTokenAmount, sellUSDC };
}

// small concurrency helper
function pLimit(concurrency) {
    let active = 0;
    const queue = [];
    const next = () => {
        if (active >= concurrency || queue.length === 0) return;
        active++;
        const { fn, resolve } = queue.shift();
        fn().then((res) => {
            active--;
            resolve(res);
            next();
        });
    };
    return (fn) =>
        new Promise((resolve) => {
            queue.push({ fn, resolve });
            next();
        });
}

const limit = pLimit(MAX_CONCURRENCY);

// Main execute function: conservative but enforces your 40% max profit cap
async function executeTradeCandidate(buyRouter, sellRouter, token, amountUSDC) {
    const ts = new Date().toISOString();
    const tokenSymbol = token.symbol || token.address;
    console.log(`\n🔍 [${ts}] Candidate: ${tokenSymbol} buy@${buyRouter} sell@${sellRouter} amount=${amountUSDC} USDC`);

    if (amountUSDC < MIN_TRADE_USDC) {
        console.log(`⛔ amount ${amountUSDC} < MIN_TRADE_USDC ${MIN_TRADE_USDC}`);
        appendCsvRow([ts, tokenSymbol, buyRouter, sellRouter, amountUSDC, 0, 0, 0, "", "skipped-small"]);
        return;
    }

    // READ: vault balance before
    let beforeBal = 0;
    try {
        const b = await usdcContract.balanceOf(VAULT_CONTRACT);
        beforeBal = Number(ethers.formatUnits(b, 6));
        console.log(`🏦 Vault balance before: ${fmt(beforeBal)} USDC`);
    } catch (e) {
        console.warn("⚠️ could not read vault balance:", e?.message || e);
    }

    // Compute expected profit from on-chain router quotes
    const { expectedProfitUSDC, buyTokenAmount, sellUSDC } = await computeExpectedProfit(buyRouter, sellRouter, token, amountUSDC);

    if (!expectedProfitUSDC || expectedProfitUSDC <= 0) {
        console.log("❌ no positive expected profit from quotes");
        appendCsvRow([ts, tokenSymbol, buyRouter, sellRouter, amountUSDC, expectedProfitUSDC, 0, 0, "", "no-profit"]);
        return;
    }

    const profitPct = (expectedProfitUSDC / amountUSDC) * 100;

    // Filter out crazy quotes: max profit pct cap
    if (profitPct > MAX_PROFIT_PCT) {
        console.log(`❌ Rejected — expected profit pct ${fmt(profitPct, 2)}% > MAX_PROFIT_PCT ${MAX_PROFIT_PCT}% (likely false quote)`);
        appendCsvRow([ts, tokenSymbol, buyRouter, sellRouter, amountUSDC, expectedProfitUSDC, 0, profitPct, "", "false-quote-rejected"]);
        return;
    }

    // Estimate gas
    const estGasUSDC = await estimateGasCostUSDC(buyRouter, sellRouter, token.address, amountUSDC);
    if (!isFinite(estGasUSDC)) {
        console.log("❌ cannot estimate gas cost reliably — skipping (safety)");
        appendCsvRow([ts, tokenSymbol, buyRouter, sellRouter, amountUSDC, expectedProfitUSDC, estGasUSDC, profitPct, "", "no-gas-est"]);
        return;
    }

    // Require expectedProfit > gas + min profit
    if (expectedProfitUSDC <= estGasUSDC + MIN_EXPECTED_PROFIT) {
        console.log(`❌ PREVENTED — expectedProfit ${fmt(expectedProfitUSDC)} <= gas ${fmt(estGasUSDC)} + MIN_EXPECTED_PROFIT ${MIN_EXPECTED_PROFIT}`);
        appendCsvRow([ts, tokenSymbol, buyRouter, sellRouter, amountUSDC, expectedProfitUSDC, estGasUSDC, profitPct, "", "not-enough-profit"]);
        return;
    }

    // Primary on-chain simulation
    try {
        await arbContract.callStatic.executeArbitrage(
            buyRouter,
            sellRouter,
            token.address,
            ethers.parseUnits(amountUSDC.toString(), 6)
        );
    } catch (err) {
        console.log("❌ callStatic revert — skip:", err?.reason || err?.message || err);
        appendCsvRow([ts, tokenSymbol, buyRouter, sellRouter, amountUSDC, expectedProfitUSDC, estGasUSDC, profitPct, "", "callStatic-fail"]);
        return;
    }

    console.log(`✅ Passed callStatic; estimatedProfit=${fmt(expectedProfitUSDC)} USDC (profitPct ${fmt(profitPct,2)}%) estGas=${fmt(estGasUSDC)} USDC`);

    // Prepare tx overrides (EIP-1559 preference)
    const feeData = await provider.getFeeData();
    const overrides = {};
    if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
        // bump slightly to improve chance of inclusion
        overrides.maxFeePerGas = feeData.maxFeePerGas.mul(110n).div(100n);
        overrides.maxPriorityFeePerGas = feeData.maxPriorityFeePerGas.mul(140n).div(100n);
    } else if (feeData.gasPrice) {
        overrides.gasPrice = feeData.gasPrice.mul(120n).div(100n);
    }
    overrides.gasLimit = 1000000; // safe upper bound: tune lower if able

    // If DRY_RUN: skip send
    if (DRY_RUN) {
        console.log("DRY_RUN true — not sending tx");
        appendCsvRow([ts, tokenSymbol, buyRouter, sellRouter, amountUSDC, expectedProfitUSDC, estGasUSDC, profitPct, "", "dry-run"]);
        return;
    }

    // Execute transaction
    let txHash = "";
    try {
        const tx = await arbContract.executeArbitrage(
            buyRouter,
            sellRouter,
            token.address,
            ethers.parseUnits(amountUSDC.toString(), 6),
            overrides
        );
        txHash = tx.hash;
        console.log(`🔁 TX SENT: ${txHash} — awaiting receipt...`);
        const receipt = await tx.wait();
        if (!receipt || receipt.status === 0) {
            console.log("❌ Transaction reverted / failed");
            appendCsvRow([ts, tokenSymbol, buyRouter, sellRouter, amountUSDC, expectedProfitUSDC, estGasUSDC, profitPct, txHash, "tx-reverted"]);
            return;
        }
        console.log("✅ Transaction mined ok:", txHash);

        // Read balance after
        const afterRaw = await usdcContract.balanceOf(VAULT_CONTRACT);
        const afterBal = Number(ethers.formatUnits(afterRaw, 6));
        console.log(`🏦 Vault balance after: ${fmt(afterBal)} USDC; before=${fmt(beforeBal)} => net ${fmt(afterBal - beforeBal)} USDC`);
        const net = afterBal - beforeBal;

        // If net <= 0 then trade didn't increase vault — log severe
        if (net <= 0) {
            console.error("⚠️ POSTCHECK FAIL — vault balance did not increase. This is severe. net:", fmt(net));
            appendCsvRow([ts, tokenSymbol, buyRouter, sellRouter, amountUSDC, expectedProfitUSDC, estGasUSDC, profitPct, txHash, "post-check-fail"]);
            // You may want to stop the scanner, or raise an alert here.
            return;
        }

        appendCsvRow([ts, tokenSymbol, buyRouter, sellRouter, amountUSDC, expectedProfitUSDC, estGasUSDC, profitPct, txHash, "success"]);
        return;
    } catch (e) {
        console.error("❌ send/receipt error:", e?.message || e);
        appendCsvRow([ts, tokenSymbol, buyRouter, sellRouter, amountUSDC, expectedProfitUSDC, estGasUSDC, profitPct, txHash || "", "send-error"]);
        return;
    }
}

// scanning loop (sequential candidate generation; callStatic concurrency limited)
async function scanOnce(tradeAmountUSDC = TRADE_AMOUNT_USDC) {
    const candidates = [];
    for (const token of Object.values(tokens)) {
        for (const buyRouter of Object.values(routers)) {
            for (const sellRouter of Object.values(routers)) {
                if (buyRouter === sellRouter) continue;
                candidates.push({ token, buyRouter, sellRouter, amount: tradeAmountUSDC });
            }
        }
    }

    // Run candidates with concurrency cap
    const promises = candidates.map((c) =>
        limit(async () => {
            try {
                await executeTradeCandidate(c.buyRouter, c.sellRouter, c.token, c.amount);
            } catch (e) {
                console.error("candidate error:", e?.message || e);
            }
        })
    );

    await Promise.all(promises);
}

// Main
(async function main() {
    await init();
    console.log(`🚀 AUTO-SCAN ENABLED — scanning every ${SCAN_INTERVAL_MS / 1000} sec`);
    // initial run
    await scanOnce(TRADE_AMOUNT_USDC);

    setInterval(async () => {
        try {
            await scanOnce(TRADE_AMOUNT_USDC);
        } catch (e) {
            console.error("loop error:", e?.message || e);
        }
    }, SCAN_INTERVAL_MS);
})();
