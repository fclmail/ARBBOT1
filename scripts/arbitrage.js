
import dotenv from "dotenv";
import { ethers } from "ethers";

/* ================= ENV ================= */

dotenv.config({ override: false });

const RPC_POLYGON =
  (process.env.RPC_POLYGON ||
    process.env.POLYGON_RPC ||
    process.env.RPC_URL ||
    "").trim();

const WALLET_PRIVATE_KEY =
  (process.env.WALLET_PRIVATE_KEY ||
    process.env.PRIVATE_KEY ||
    "").trim();

if (!RPC_POLYGON) throw new Error("RPC_POLYGON missing");
if (!WALLET_PRIVATE_KEY) throw new Error("PRIVATE_KEY missing");

/* ================= COLORS ================= */

const GREEN = "\x1b[92m";
const RESET = "\x1b[0m";
const CYAN = "\x1b[96m";
const YELLOW = "\x1b[93m";
const RED = "\x1b[91m";

/* ================= CONSTANTS ================= */

const MIN_TRADE_USDC = .05;                // FIXED (was 0.02)
const MIN_PROFIT_USDC = 0.00001;         // NEW
const SCAN_INTERVAL_MS = 10000;
const DEADLINE_SECONDS = 60;
const MAX_BATCH_SIZE = 10;

/* ================= PROVIDER ================= */

const provider = new ethers.JsonRpcProvider(RPC_POLYGON);
const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);

/* ================= CONTRACT ================= */

const VAULT_ADDRESS = "0xf7e8A1580Dd9b3757Fb6a1f86AD5ed0e0F3EfC31";

const vaultAbi = [
{
name: "executeFlashBatchArbitrage",
type: "function",
inputs: [
{ name: "buyRouters", type: "address[]" },
{ name: "sellRouters", type: "address[]" },
{ name: "amountsInUSDC", type: "uint256[]" },
{ name: "pathsToToken", type: "address[][]" },
{ name: "pathsToUSDC", type: "address[][]" },
{ name: "deadline", type: "uint256" }
],
outputs: [],
stateMutability: "nonpayable"
}
];

const vault = new ethers.Contract(VAULT_ADDRESS, vaultAbi, wallet);

/* ================= USDC ================= */

const usdcAbi = [
"function balanceOf(address owner) view returns (uint256)"
];

const usdc = new ethers.Contract(
"0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
usdcAbi,
provider
);

/* ================= ROUTERS ================= */

const routers = {

QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
Dfyn: "0xA102072A4C07F06EC3B4900FDC4C7B80b6c57429",
Firebird: "0xe0C9D6E8c2C5d4B9A6F7D0A6C2e20e671e7E55cA",
ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607",
Wault: "0xa98ea6356a316b44bf710d5f9b6b4ea0081409ef"

};

const routerAbi = [
"function getAmountsOut(uint amountIn, address[] calldata path) view returns (uint[] memory)"
];

const routerContracts = Object.fromEntries(
Object.values(routers).map(
(addr) => [addr, new ethers.Contract(addr, routerAbi, provider)]
)
);

/* ================= TOKENS ================= */

const TOKENS = {

USDC: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
USDT: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
WBTC: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6",
APE: "0x4d224452801aced8b2f0aebe155379bb5d594381",
CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
DAI: "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063",
WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
WETH: "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619",
LINK: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39",
FRAX: "0x45c32fA6DF82ead1e2EF74d17b76547EDdFaFF89",
MAI: "0xa3Fa99A148fA48D14Ed51d610c367C61876997F1",
BUSD: "0xdAb529f40e671A1D4BF91361c21bf9F0C9712Ab7",
TUSD: "0x2e1AD108fF1D8C782fcBbB89AAd783aC49586756",
UNI: "0xb33EaAd8d922B1083446DC23f610c2567fB5180f",
SUSHI: "0x0b3F868E0BE5597D5DB7fEB59E1CADBb0fdDa50a",
QUICK: "0x831753DD7087CaC61aB5644b308642cc1c33Dc13",
BAL: "0x9a71012B13CA4d3D0Cdc72A177DF3Ef03b0E76A3",
stMATIC: "0x3A58a54C066FdC0F2D55FC9C89F0415C92eBf3C4",
wstETH: "0x03b54A6e9a984069379FAe1a4Fc4dBaE93b3bccd",
AAVE: "0xd6df932a45c0f255f85145f286ea0b292b21c90b"

};

/* ================= HELPERS ================= */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function logBalances() {

const vaultUSDC = await usdc.balanceOf(VAULT_ADDRESS);
const formattedVaultUSDC = ethers.formatUnits(vaultUSDC, 6);

const maticBalance = await provider.getBalance(wallet.address);
const formattedMatic = ethers.formatEther(maticBalance);

console.log(`${CYAN}Vault USDC Balance:${RESET} ${formattedVaultUSDC}`);
console.log(`${CYAN}Wallet MATIC Balance:${RESET} ${formattedMatic}`);

}

/* ================= QUOTE ================= */

async function quote(routerAddr, amountIn, path) {

try {

const router = routerContracts[routerAddr];
const amounts = await router.getAmountsOut(amountIn, path);

const out = amounts.at(-1);

if (!out || out === 0n) return null;

return out;

} catch {

return null;

}

}

/* ================= FIND ARBITRAGE ================= */

async function findProfitableTrade(buyRouter, sellRouter, tokenAddr) {

const usdcAddr = TOKENS.USDC;

if (tokenAddr === usdcAddr) return null;

const amountIn = ethers.parseUnits(MIN_TRADE_USDC.toString(), 6);

let bestBuyOut;
let bestBuyPath;

for (const p of [

[usdcAddr, tokenAddr],
[usdcAddr, TOKENS.WMATIC, tokenAddr],
[usdcAddr, TOKENS.WETH, tokenAddr],
[usdcAddr, TOKENS.USDT, tokenAddr],
[usdcAddr, TOKENS.DAI, tokenAddr]

]) {

const out = await quote(buyRouter, amountIn, p);

if (out && (!bestBuyOut || out > bestBuyOut)) {

bestBuyOut = out;
bestBuyPath = p;

}

}

if (!bestBuyOut) return null;

let bestSellOut;
let bestSellPath;

for (const p of [

[tokenAddr, usdcAddr],
[tokenAddr, TOKENS.WMATIC, usdcAddr],
[tokenAddr, TOKENS.WETH, usdcAddr],
[tokenAddr, TOKENS.USDT, usdcAddr],
[tokenAddr, TOKENS.DAI, usdcAddr]

]) {

const out = await quote(sellRouter, bestBuyOut, p);

if (out && (!bestSellOut || out > bestSellOut)) {

bestSellOut = out;
bestSellPath = p;

}

}

if (!bestSellOut) return null;

const profit =
Number(ethers.formatUnits(bestSellOut, 6)) - MIN_TRADE_USDC;

/* PROFIT FILTER */

if (profit <= MIN_PROFIT_USDC) return null;

console.log(
`${GREEN}PROFIT FOUND ${profit.toFixed(6)}${RESET} | TOKEN ${tokenAddr}`
);

return {

buyRouter,
sellRouter,
amountIn,
bestBuyPath,
bestSellPath

};

}

/* ================= BATCH EXECUTION ================= */

async function batchArb() {

await logBalances();

const profitableTrades = [];
const seen = new Set();

while (profitableTrades.length < MAX_BATCH_SIZE) {

const scanTasks = [];

for (const buy of Object.values(routers)) {

for (const sell of Object.values(routers)) {

if (buy === sell) continue;

for (const token of Object.values(TOKENS)) {

scanTasks.push(
findProfitableTrade(buy, sell, token)
);

}

}

}

const results = await Promise.all(scanTasks);

for (const trade of results) {

if (!trade) continue;

const id =
trade.buyRouter +
trade.sellRouter +
trade.bestBuyPath.join("") +
trade.bestSellPath.join("");

if (seen.has(id)) continue;

seen.add(id);

profitableTrades.push(trade);

if (profitableTrades.length >= MAX_BATCH_SIZE)
break;

}

console.log(
`${YELLOW}Collected ${profitableTrades.length} profitable trades so far${RESET}`
);

}

console.log(`${CYAN}Executing batch arbitrage${RESET}`);

const deadline =
Math.floor(Date.now() / 1000) + DEADLINE_SECONDS;

const buyRouters = profitableTrades.map((t) => t.buyRouter);
const sellRouters = profitableTrades.map((t) => t.sellRouter);
const amountsInUSDC = profitableTrades.map((t) => t.amountIn);
const pathsToToken = profitableTrades.map((t) => t.bestBuyPath);
const pathsToUSDC = profitableTrades.map((t) => t.bestSellPath);

try {

const estimatedGas =
await vault.executeFlashBatchArbitrage.estimateGas(
buyRouters,
sellRouters,
amountsInUSDC,
pathsToToken,
pathsToUSDC,
deadline
);

const gasLimit = (estimatedGas * 130n) / 100n;

const feeData = await provider.getFeeData();

const tx = await vault.executeFlashBatchArbitrage(
buyRouters,
sellRouters,
amountsInUSDC,
pathsToToken,
pathsToUSDC,
deadline,
{
gasLimit,
maxFeePerGas: feeData.maxFeePerGas,
maxPriorityFeePerGas: feeData.maxPriorityFeePerGas
}
);

console.log(`${GREEN}BATCH SENT:${RESET}`, tx.hash);

await tx.wait();

console.log(
`${GREEN}Batch confirmed — profits deposited to vault${RESET}`
);

await logBalances();

} catch (err) {

console.log(`${RED}Batch failed${RESET}`, err.message);

}

}

/* ================= MAIN LOOP ================= */

async function main() {

console.log(`${CYAN}Launching arbitrage scanners...${RESET}`);

while (true) {

await batchArb();

await sleep(SCAN_INTERVAL_MS);

}

}

main().catch(console.error);
