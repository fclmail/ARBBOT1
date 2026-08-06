import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config({ override: false });

/* ================= ENV ================= */
const PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY || process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) throw new Error("PK missing");

/* ================= STABLE RPCS ================= */
const RPCS = [
    "https://polygon-bor-rpc.publicnode.com",
    "https://rpc-mainnet.maticvigil.com",
    "https://polygon.gateway.tenderly.co"
];

let rpcIndex = 0;
let provider;
let wallet;
let usdc;
let contract;

/* ================= CONFIG ================= */
const BASE_TRADE = ethers.parseUnits("5.0", 6); 
const MIN_PROFIT = ethers.parseUnits("0.0002", 6);

/* ================= CONTRACTS & TOKENS (Valid Checksummed Addresses) ================= */
const CONTRACT_ADDRESS = ethers.getAddress("0x7EAf60672B8c0A2399187bCa1BB916F14Ac7a958");
const USDC = ethers.getAddress("0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174");

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
    QuickSwap: ethers.getAddress("0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff"),
    SushiSwap: ethers.getAddress("0x1b02da8cb0d097eb8d57a175b88c7d8b47997506"),
    Dfyn: ethers.getAddress("0xA102072A4C07F06EC3B4900FDC4C7B80b6c57429")
};

const TOKENS = {
    AAVE: ethers.getAddress("0xd6df932a45c0f255f85145f286ea0b292b21c90".toLowerCase()), // Safe checksum parsing
    WETH: ethers.getAddress("0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619")
};

async function initProvider() {
    try {
        provider = new ethers.JsonRpcProvider(RPCS[rpcIndex], {
            chainId: 137,
            name: "polygon"
        });
        wallet = new ethers.Wallet(PRIVATE_KEY, provider);
        usdc = new ethers.Contract(USDC, erc20Abi, wallet);
        contract = new ethers.Contract(CONTRACT_ADDRESS, contractAbi, wallet);
        
        await provider.getBlockNumber();
        console.log(`🔗 Connected to RPC: ${RPCS[rpcIndex]} | Wallet: ${wallet.address}`);
    } catch (err) {
        console.log(`⚠️ RPC Connection failed for ${RPCS[rpcIndex]}, rotating...`);
        rpcIndex = (rpcIndex + 1) % RPCS.length;
        await new Promise(r => setTimeout(r, 2000));
        await initProvider();
    }
}

async function scanAndExecute() {
    try {
        const balance = await usdc.balanceOf(CONTRACT_ADDRESS);
        console.log(`💼 Contract USDC Balance: ${ethers.formatUnits(balance, 6)} USDC`);

        if (balance < BASE_TRADE) {
            console.log(`💤 Contract balance too low for trade size. Accumulating...`);
            return;
        }

        const buyRouter = routers.QuickSwap;
        const sellRouter = routers.Dfyn;
        const pathToToken = [USDC, TOKENS.WETH, TOKENS.AAVE];
        const pathToUSDC = [TOKENS.AAVE, TOKENS.WETH, USDC];

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

            const tx = await contract.executeFlashBatchArbitrage(batchParam, {
                gasLimit: 800000
            });

            console.log(`⏳ Tx Sent: ${tx.hash}. Waiting for confirmation...`);
            const receipt = await tx.wait();
            console.log(`✅ Transaction confirmed in block ${receipt.blockNumber}!`);
        } else {
            console.log(`💤 No profitable opportunities matching threshold.`);
        }
    } catch (error) {
        console.error(`⚠️ Execution Error:`, error.reason || error.message || error);
    }
}

async function main() {
    await initProvider();
    setInterval(scanAndExecute, 15000);
}

main();
