import { ethers } from "ethers";

// ---------------- CONFIG ----------------
const RPC_URL = "https://polygon-rpc.com"; // or your preferred RPC
const WALLET_PRIVATE_KEY = process.env.PRIVATE_KEY; // set in env
const ARB_CONTRACT_ADDRESS = "0x19B64f74553eE0ee26BA01BF34321735E4701C43"; // deployed AaveFlashArb
const ARB_CONTRACT_ABI = [/* paste your ABI here */];

const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"; // Polygon USDC
const ROUTERS = {
    quickswap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
    sushiswap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
    apeswap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1dE7"
};
const MIN_PROFIT_USDC = ethers.parseUnits("0.01", 6); // minimum 0.01 USDC profit

// ----------------------------------------

// Initialize provider and wallet
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);

// Instantiate arbitrage contract
const arbContract = new ethers.Contract(ARB_CONTRACT_ADDRESS, ARB_CONTRACT_ABI, wallet);

// Helper: format USDC amounts
const formatUSDC = (value) => ethers.formatUnits(value, 6);

// ----------------- MAIN LOOP -----------------
async function main() {
    console.log("🚀 LIVE MODE ENABLED — FULL FAILSAFE CHECKS");

    // Vault info
    const owner = await arbContract.owner();
    const vaultBalance = await ethers.Contract(USDC_ADDRESS, [
        "function balanceOf(address) view returns (uint256)"
    ], provider).balanceOf(ARB_CONTRACT_ADDRESS);

    console.log("🏛 Contract Address:", ARB_CONTRACT_ADDRESS);
    console.log("👤 Owner:", owner);
    console.log("🏦 Vault Balance:", formatUSDC(vaultBalance), "USDC");

    while (true) {
        try {
            console.log("\n🔍 Scanning for arbitrage opportunities...");

            // Example: QuickSwap → SushiSwap
            const tokenAddress = "0x..."; // token to arbitrage
            const amountIn = ethers.parseUnits("100", 6); // borrow 100 USDC

            // Estimate trade amounts using getAmountsOut
            const buyRouter = ROUTERS.quickswap;
            const sellRouter = ROUTERS.sushiswap;

            const buyAmountOut = await getAmountOut(buyRouter, USDC_ADDRESS, tokenAddress, amountIn);
            const sellAmountOut = await getAmountOut(sellRouter, tokenAddress, USDC_ADDRESS, buyAmountOut);

            const profit = sellAmountOut - amountIn;

            if (profit < MIN_PROFIT_USDC) {
                console.log(`❌ Rejected — Profit too low: ${formatUSDC(profit)} USDC`);
                await sleep(10000);
                continue;
            }

            console.log(`📈 Potential Profit: ${formatUSDC(profit)} USDC`);

            // CallStatic check to prevent losing gas
            const callStaticSuccess = await arbContract.callStatic.executeArbitrage(
                buyRouter,
                sellRouter,
                tokenAddress,
                amountIn
            ).catch(e => false);

            if (!callStaticSuccess) {
                console.log("❌ callStatic failed — Trade blocked BEFORE sending gas");
                await sleep(10000);
                continue;
            }

            // Execute real trade
            const tx = await arbContract.executeArbitrage(
                buyRouter,
                sellRouter,
                tokenAddress,
                amountIn,
                { gasLimit: 500_000 }
            );
            console.log("📤 Broadcasting transaction...");
            console.log("🔗 txHash:", tx.hash);

            const receipt = await tx.wait();
            if (receipt.status === 1) {
                const newVaultBalance = await ethers.Contract(USDC_ADDRESS, [
                    "function balanceOf(address) view returns (uint256)"
                ], provider).balanceOf(ARB_CONTRACT_ADDRESS);

                console.log("✅ Trade Confirmed");
                console.log("🏦 Vault Before:", formatUSDC(vaultBalance), "USDC");
                console.log("🏦 Vault After:", formatUSDC(newVaultBalance), "USDC");
                console.log("📈 Net Profit:", formatUSDC(newVaultBalance - vaultBalance), "USDC");
            } else {
                console.log("❌ Trade failed on-chain, no profit");
            }

        } catch (err) {
            console.error("⚠ Error:", err.message);
        }

        await sleep(10000); // scan every 10s
    }
}

// ---------------- HELPER FUNCTIONS ----------------
async function getAmountOut(router, fromToken, toToken, amountIn) {
    const routerContract = new ethers.Contract(router, [
        "function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory amounts)"
    ], provider);

    const path = [fromToken, toToken];
    const amounts = await routerContract.getAmountsOut(amountIn, path);
    return amounts[amounts.length - 1];
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------- RUN -----------------
main();
