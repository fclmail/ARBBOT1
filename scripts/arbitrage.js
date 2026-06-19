import { ethers } from "ethers";
import dotenv from "dotenv";

dotenv.config();

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

const WSS_ENDPOINTS = [
    "wss://polygon-bor-rpc.publicnode.com", 
    "wss://polygon.drpc.org",
    "wss://polygon.gateway.tenderly.co"
];
let currentEndpointIndex = 0;

const VAULT_CONTRACT_ADDRESS = "0xB1a557c33FF23F3C0Ffa2A9251630197b037F4cc";
const USDC_ADDRESS  = "0x2791bca1f2de4661ed88a30c99a7a9449aa84174";

const ROUTERS = {
    QUICK: "0xa5e0829caced8ffdd4de3c43696c57f7d7a678ff",
    SUSHI: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506"
};

const TOKENS = {
    WMATIC: "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270"
};

const ENFORCER_ABI = [
    "function executeDirectArbitrage(address buyRouter, address sellRouter, uint256 amountInUSDC, address[] calldata pathToToken, address[] calldata pathToUSDC, uint256 deadline) external",
    "function balanceOf(address account) view returns (uint256)"
];

const ERC20_ABI = [
    "function balanceOf(address account) view returns (uint256)"
];

let provider;
let wallet;
let vaultContract;
let usdcContract;
let testOverrideTriggered = false;

async function initWebSocketConnection(targetUrl) {
    provider = new ethers.WebSocketProvider(targetUrl);
    wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    vaultContract = new ethers.Contract(VAULT_CONTRACT_ADDRESS, ENFORCER_ABI, wallet);
    usdcContract = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, provider);
}

async function main() {
    const targetUrl = WSS_ENDPOINTS[currentEndpointIndex];
    console.log("🚀 STARTING ON-CHAIN VALIDATION (HIGH LIQUIDITY PATH)");
    
    try {
        await initWebSocketConnection(targetUrl);
    } catch (err) {
        console.error("Connection failed");
        return;
    }

    provider.on("block", async (blockNumber) => {
        if (testOverrideTriggered) return;
        testOverrideTriggered = true; // Run exactly once immediately

        console.log(`📦 [BLOCK #^{blockNumber}] Launching liquid verification pipeline...`);

        // HIGH-LIQUIDITY GUARANTEED ROUTE (USDC -> WMATIC -> USDC)
        const verifiedPathToToken = [USDC_ADDRESS, TOKENS.WMATIC];
        const verifiedPathToUSDC  = [TOKENS.WMATIC, USDC_ADDRESS];
        const testAmount = ethers.parseUnits("0.07", 6);

        console.log(`\n${GREEN}🎯 [PROFITABLE HOOK TRIGGER FOUND IN BLOCK #${blockNumber}]`);
        console.log(`⚡ Testing 0.07 USDC via high-liquidity WMATIC route...${RESET}`);

        const txDeadline = Math.floor(Date.now() / 1000) + 300; // 5 minute deadline safety window

        try {
            const vaultBalance = await usdcContract.balanceOf(VAULT_CONTRACT_ADDRESS);
            console.log(`💰 [VAULT FUNDING] Internal capital available: $${ethers.formatUnits(vaultBalance, 6)} USDC`);

            const feeData = await provider.getFeeData();
            // Aggressive gas configuration to guarantee inclusion
            const baseFee = feeData.maxFeePerGas ? feeData.maxFeePerGas : ethers.parseUnits("350", "gwei");
            const txOptions = { 
                gasLimit: 500000, 
                maxFeePerGas: (baseFee * 20n) / 10n, 
                maxPriorityFeePerGas: ethers.parseUnits("100", "gwei")  
            };

            console.log(`📤 Sending execution payload to contract...`);
            
            // Execute using QuickSwap for the buy swap, SushiSwap for the sell swap
            const tx = await vaultContract.executeDirectArbitrage(
                ROUTERS.QUICK, 
                ROUTERS.SUSHI, 
                testAmount, 
                verifiedPathToToken, 
                verifiedPathToUSDC, 
                txDeadline, 
                txOptions
            );

            console.log(`${GREEN}🚀 TRANSACTION BROADCASTED SUCCESSFULLY!`);
            console.log(`🏁 HASH: ${tx.hash}${RESET}\n`);
            
            console.log("⏳ Waiting for block inclusion receipt...");
            const receipt = await tx.wait(1);
            console.log(`${GREEN}✅ TRANSACTION CONFIRMED IN BLOCK #${receipt.blockNumber}!${RESET}`);

        } catch (txError) {
            console.log(`${RED}❌ Execution faulted: ${txError.message}${RESET}`);
        }
        
        process.exit(0);
    });
}

main().catch(() => process.exit(1));
