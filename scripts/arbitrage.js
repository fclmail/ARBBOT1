// ----------------------------------------------------
// AAVE FLASH ARB BOT - POLYGON
// Full arbitrage.js with ONLY the required fixes
// ----------------------------------------------------

const { ethers } = require("ethers");
require("dotenv").config();

// ----------------------------------------------------
// Provider + Wallet
// ----------------------------------------------------
const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

// ----------------------------------------------------
// Contract ABI
// MUST include executeArbitrage() or callStatic breaks
// ----------------------------------------------------
const arbAbi = [
    "function executeArbitrage(address buyDex, address sellDex, address token, uint256 amount) external",
    "function owner() external view returns(address)"
];

// ----------------------------------------------------
// Unified Contract Instance
// ----------------------------------------------------
const arbContract = new ethers.Contract(
    process.env.ARB_CONTRACT,
    arbAbi,
    wallet
);

// ----------------------------------------------------
// Utility: normalize addresses
// Prevents "bad address checksum" spam
// ----------------------------------------------------
const norm = (addr) => {
    try { return ethers.getAddress(addr); }
    catch { return null; }
};

// ----------------------------------------------------
// Execute Arbitrage
// Only changes: callStatic fix + checksum fix
// Nothing else touched
// ----------------------------------------------------
async function executeTrade(buyRouter, sellRouter, token, amountUnits) {
    try {
        // Normalize
        const buy = norm(buyRouter);
        const sell = norm(sellRouter);
        const tok = norm(token);

        if (!buy || !sell || !tok) {
            return {
                executed: false,
                reason: "Invalid checksum address"
            };
        }

        // ------------------------------------------------
        // 1️⃣ callStatic Simulation — No gas, no failure
        // ------------------------------------------------
        try {
            await arbContract.callStatic.executeArbitrage(
                buy,
                sell,
                tok,
                amountUnits
            );
        } catch (err) {
            return {
                executed: false,
                reason:
                    "callStatic fail: " +
                    (err.reason || err.message || "Simulation error")
            };
        }

        // ------------------------------------------------
        // 2️⃣ LIVE SEND
        // ------------------------------------------------
        const tx = await arbContract.executeArbitrage(
            buy,
            sell,
            tok,
            amountUnits,
            { gasLimit: 2500000 }
        );

        const receipt = await tx.wait();

        return {
            executed: true,
            hash: receipt.hash
        };
    } catch (err) {
        return {
            executed: false,
            reason: err.message
        };
    }
}

// ----------------------------------------------------
// EXPORTS (unchanged)
// ----------------------------------------------------
module.exports = {
    executeTrade,
    arbContract
};

