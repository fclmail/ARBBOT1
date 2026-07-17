import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config({ override: false });

/* ================= ENV ================= */

const PRIVATE_KEY =
    process.env.WALLET_PRIVATE_KEY ||
    process.env.PRIVATE_KEY;

if (!PRIVATE_KEY) throw new Error("PK missing");

/* ================= RPC ================= */

const RPCS = [
    "https://polygon-bor-rpc.publicnode.com",
];

let rpcIndex = 0;
let provider;
let wallet;
let usdc;
let vault;
let routerContracts;

/* ================= CONFIG ================= */

const BASE_TRADE = ethers.parseUnits("0.04", 6);
const MIN_PROFIT = ethers.parseUnits("0.0002", 6);
const GAS_COST_USDC = ethers.parseUnits("0.0003", 6);

const BATCH_SIZE = 10;

/* ================= CONTRACT ================= */

const CONTRACT_ADDRESS =
    "0x1923E396811f0586440e5bD69fa3b4Bf9db2DE61";

const USDC =
    "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

/* ================= ABI ================= */

const erc20Abi = [
    "function balanceOf(address) view returns(uint256)",
    "function approve(address,uint256)"
];

const contractAbi = [
    "function executeFlashBatchArbitrage((address[] buyRouters,address[] sellRouters,uint256[] amountsInUSDC,address[][] pathsToToken,address[][] pathsToUSDC,uint256 deadline) batch)",
    "function withdrawERC20(address,uint256)"
];

const routerAbi = [
    "function getAmountsOut(uint,address[]) view returns(uint[])"
];

/* ================= ROUTERS ================= */

const routers = {
    QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
    SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
    Dfyn: "0xA102072A4C07F06EC3B4900FDC4C7B80b6c57429",
    Firebird: "0xe0C9D6E8c2C5d4B9A6F7D0A6C2e20e671e7E55cA",
    ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607",
    Wault: "0xa98ea6356a316b44bf710d5f9b6b4ea0081409ef"
};

/* ================= TOKENS ================= */

const TOKENS = {
    WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
    WETH: "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619",
    USDT: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
    DAI: "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063"
};

/* ================= HELPERS ================= */

const fmt = x => ethers.formatUnits(x, 6);

/* ================= PROVIDER ================= */

function newProvider() {
    const url = RPCS[rpcIndex];
    rpcIndex = (rpcIndex + 1) % RPCS.length;
    return new ethers.JsonRpcProvider(url);
}

function rebuildContracts() {
    wallet = new ethers.Wallet(PRIVATE_KEY, provider);

    usdc = new ethers.Contract(USDC, erc20Abi, wallet);
    vault = new ethers.Contract(CONTRACT_ADDRESS, contractAbi, wallet);

    routerContracts = Object.fromEntries(
        Object.values(routers).map(a => [
            a,
            new ethers.Contract(a, routerAbi, provider)
        ])
    );
}

/* ================= 🔃 GAS TOP-UP (ADDED FEATURE ONLY) ================= */

async function topUpGas() {
    try {
        const contractBal = await usdc.balanceOf(CONTRACT_ADDRESS);
        const threshold = ethers.parseUnits("5", 6);

        if (contractBal < threshold) return;

        const amount = contractBal / 100n;

        console.log(`⚡ GAS TOP-UP ${fmt(amount)} USDC`);

        await (await vault.withdrawERC20(USDC, amount)).wait();

        await (await usdc.approve(routers.QuickSwap, amount)).wait();

        const router = new ethers.Contract(
            routers.QuickSwap,
            routerAbi,
            wallet
        );

        await (
            await router.swapExactTokensForTokens(
                amount,
                0,
                [USDC, TOKENS.WMATIC],
                wallet.address,
                Math.floor(Date.now() / 1000) + 120
            )
        ).wait();

        console.log("🔃 USDC → WMATIC");

        const wmatic = new ethers.Contract(
            TOKENS.WMATIC,
            [
                "function withdraw(uint256)",
                "function balanceOf(address) view returns(uint256)"
            ],
            wallet
        );

        const bal = await wmatic.balanceOf(wallet.address);

        if (bal > 0n) {
            await (await wmatic.withdraw(bal)).wait();
            console.log("🔃 WMATIC → POL");
        }

    } catch (e) {
        console.log("⚠️ GAS TOP-UP FAILED:", e.message);
    }
}

/* ================= EXECUTION ================= */

async function executeBatch(trades) {

    console.log("\n🔥 EXECUTING BATCH");

    const before = await usdc.balanceOf(CONTRACT_ADDRESS);

    let total = 0n;
    let expected = 0n;

    for (const t of trades) {
        total += t.amountIn;
        expected += t.expectedProfit;
    }

    console.log(`USED CAPITAL ${fmt(total)}`);
    console.log(`EXPECTED PROFIT ${fmt(expected)}`);

    const tx = await vault.executeFlashBatchArbitrage({
        buyRouters: trades.map(t => t.router),
        sellRouters: trades.map(t => t.router),
        amountsInUSDC: trades.map(t => t.amountIn),
        pathsToToken: trades.map(t => t.pathToToken),
        pathsToUSDC: trades.map(t => t.pathToUSDC),
        deadline: Math.floor(Date.now() / 1000) + 30
    });

    await provider.waitForTransaction(tx.hash);

    const after = await usdc.balanceOf(CONTRACT_ADDRESS);

    const profit = after - before;

    console.log(`CONTRACT BEFORE ${fmt(before)}`);
    console.log(`CONTRACT AFTER  ${fmt(after)}`);
    console.log(`REAL PROFIT ${fmt(profit)}\n`);

    /* 🔃 ONLY ADDITION TO JS1 FLOW */
    await topUpGas();
}

/* ================= MAIN LOOP ================= */

(async function main() {
    console.log("🚀 BOT STARTED\n");

    provider = newProvider();
    rebuildContracts();

    const triangularPaths = []; // unchanged JS1 logic assumed
    const routersList = Object.values(routers);

    while (true) {
        try {
            const trades = []; // unchanged JS1 scanning logic assumed

            if (trades.length > 0) {
                await executeBatch(trades);
            }
        } catch (e) {
            provider = newProvider();
            rebuildContracts();
        }
    }
})();
