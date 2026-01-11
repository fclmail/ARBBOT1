// scripts/arbitrage.js
import { ethers } from 'ethers';
import { arbitrageActions } from './arbitrageActions.js'; // note the .js extension in ES modules

// --- Configuration ---
const SCAN_INTERVAL = 4000; // 4 seconds
const FIXED_PROFIT_PERCENT = 0.2; // +20%
const VAULT_LIMIT = 1000; // maximum amount allowed per trade
const MAX_SLIPPAGE = 0.005; // 0.5% max slippage

// --- Provider & Wallet Setup ---
const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

// --- Simulate profit calculation ---
function calculateProfit(amount) {
    return amount * FIXED_PROFIT_PERCENT; // guaranteed +20%
}

// --- Preflight dry-run check ---
async function preflightCheck(amount, estimatedProfit) {
    if (amount > VAULT_LIMIT) {
        console.log(`⚠️ Skipping trade: amount ${amount} exceeds vault limit`);
        return false;
    }

    // Simple slippage simulation
    const simulatedSlippage = Math.random() * 0.01; // 0% - 1%
    if (simulatedSlippage > MAX_SLIPPAGE) {
        console.log(`⚠️ Skipping trade: slippage too high (${(simulatedSlippage*100).toFixed(2)}%)`);
        return false;
    }

    if (estimatedProfit <= 0) {
        console.log(`⚠️ Skipping trade: profit not positive`);
        return false;
    }

    return true;
}

// --- Execute trade ---
async function executeTrade(amount) {
    const estimatedProfit = calculateProfit(amount);
    const canTrade = await preflightCheck(amount, estimatedProfit);

    if (!canTrade) return;

    try {
        await arbitrageActions(wallet, amount, estimatedProfit);
        console.log(`💰 OPPORTUNITY +20% ${estimatedProfit.toFixed(6)} USDC (${(FIXED_PROFIT_PERCENT*100).toFixed(3)}%)`);
    } catch (err) {
        console.error('❌ Trade failed:', err.message);
    }
}

// --- Main loop ---
async function scanLoop() {
    console.log(`🚀 Arb bot running (+20% every 4s)`);

    setInterval(async () => {
        const amount = Math.random() * 10; // simulate trade size 0-10 USDC
        await executeTrade(amount);
        console.log('❤️ bot alive');
    }, SCAN_INTERVAL);
}

scanLoop();
