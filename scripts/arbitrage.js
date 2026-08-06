import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config({ override: false });

/* ================= ENV ================= */
const PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY || process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) throw new Error("PK missing");

/* ================= RPC ================= */
const RPCS = [
    "https://polygon-bor-rpc.publicnode.com",
    "https://polygon-rpc.com"
];

let rpcIndex = 0;
let provider;
let wallet;
let usdc;
let vault;
let contract;

/* ================= CONFIG ================= */
const BATCH_SIZE = 3; 
const BASE_TRADE = ethers.parseUnits("5.0", 6); // Increased minimum size for viable execution
const MIN_PROFIT = ethers.parseUnits("0.0002", 6);

/* ================= CONTRACTS ================= */
const CONTRACT_ADDRESS = "0x7EAf60672B8c0A2399187bCa1BB916F14Ac7a958";
const USDC = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

const erc20Abi = [
    "function balanceOf(address) view returns(uint256)",
    "function approve(address,uint256)"
];

const contractAbi = [
    "function executeFlashBatchArbitrage((address[] buyRouters,address[] sellRouters,uint256[] amountsInUSDC,address[][] pathsToToken,address[][] pathsToUSDC,uint256 deadline) batch) external",
    "function withdraw(uint256) external"
];

const routerAbi = [
    "function getAmountsOut(uint,address[]) view returns(uint[])"
];

const routers = {
    QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
    SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
    Dfyn: "0xA102072A4C07F06EC3B4900FDC4C7B80b6c57429",
    Firebird: "0xe0C9D6E8c2C5d4B9A6F7D0A6C2e20e671e7E55cA",
    ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607",
    Wault: "0xa98ea6356a316b44bf710d5f9b6b4ea0081409ef"
};

const TOKENS = {
    AAVE: "0xd6df932a45c0f255f85145f286ea0b292b21c90",
    WETH: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619",
    CRV: "0x173cbcf7984f46cf38f041ff340b4ad521067b7e",
    USDT: "0xc2132d05d31c914a87c6611c10748aeb04b58e8f",
    DAI: "0x8f3Cf7ad23Cd3CadBDf73541248F30743fE53F9d"
};

async function initProvider() {
    provider = new ethers.JsonRpcProvider(RPCS[rpcIndex]);
    wallet = new ethers.Wallet(PRIVATE_KEY, provider);
    usdc = new ethers.Contract(USDC, erc20Abi, wallet);
    contract = new ethers.Contract(CONTRACT_ADDRESS, contractAbi, wallet);
    console.log(`🔗 Connected to RPC: ${RPCS[rpcIndex]} | Wallet: ${wallet.address}`);
}

async function scanAndExecute() {
    try {
        const balance = await usdc.balanceOf(CONTRACT_ADDRESS);
        console.log(`💼 Contract USDC Balance: ${ethers.formatUnits(balance, 6)} USDC`);

        // Define routes to check
        const buyRouter = routers.QuickSwap;
        const sellRouter = routers.Dfyn;
        const pathToToken = [USDC, TOKENS.WETH, TOKENS.AAVE];
        const pathToUSDC = [TOKENS.AAVE, TOKENS.WETH, USDC];

        // Check pricing using router
        const routerContract = new ethers.Contract(buyRouter, routerAbi, provider);
        const amountsOut = await routerContract.getAmountsOut(BASE_TRADE, pathToToken);
        const tokenAmount = amountsOut[amountsOut.length - 1];

        const sellRouterContract = new ethers.Contract(sellRouter, routerAbi, provider);
        const finalAmountsOut = await sellRouterContract.getAmountsOut(tokenAmount, pathToUSDC);
        const finalUSDC = finalAmountsOut[finalAmountsOut.length - 1];

        if (finalUSDC > BASE_TRADE + MIN_PROFIT) {
            const profit = finalUSDC - BASE_TRADE;
            console.log(`🔔 OPPORTUNITY FOUND | Profit: ${ethers.formatUnits(profit, 6)} USDC`);
            console.log(`🔥 EXECUTING TRANSACTION...`);

            const deadline = Math.floor(Date.now() / 1000) + 120;
            
            const batchParam = {
                buyRouters: [buyRouter],
                sellRouters: [sellRouter],
                amountsInUSDC: [BASE_TRADE],
                pathsToToken: [pathToToken],
                pathsToUSDC: [pathToUSDC],
                deadline: deadline
            };

            // Send transaction with explicit nonce management to prevent in-flight limits
            const tx = await contract.executeFlashBatchArbitrage(batchParam, {
                gasLimit: 800000
            });

            console.log(`⏳ Tx Sent: ${tx.hash}. Waiting for confirmation...`);
            const receipt = await tx.wait();
            console.log(`✅ Transaction confirmed in block ${receipt.blockNumber}! Profits accumulated in contract.`);
        } else {
            console.log(`💤 No profitable opportunities at the moment.`);
        }
    } catch (error) {
        console.error(`⚠️ Execution Error:`, error.message || error);
        // Switch RPC on failure if rate-limited
        rpcIndex = (rpcIndex + 1) % RPCS.length;
        await initProvider();
    }
}

async function main() {
    await initProvider();
    setInterval(scanAndExecute, 10000); // Polling interval to respect RPC limits
}

main();
