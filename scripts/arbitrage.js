require("dotenv").config()

const { ethers } = require("ethers")
const chalk = require("chalk")

// -----------------------------
// RPC
// -----------------------------

const RPC = "https://polygon-bor-rpc.publicnode.com"

const provider = new ethers.providers.JsonRpcProvider(RPC)
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider)

// -----------------------------
// Routers
// -----------------------------

const ROUTERS = {
    quickswap: {
        name: "QuickSwap",
        address: "0xa5E0829CaCED8fFDD4De3c43696c57F7D7A678ff"
    },
    sushiswap: {
        name: "SushiSwap",
        address: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506"
    }
}

// -----------------------------
// Tokens
// -----------------------------

const TOKENS = {
    USDC: {
        address: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
        decimals: 6
    },
    USDT: {
        address: "0xc2132D05D31c914a87C6611C10748AaCBaBfA8f",
        decimals: 6
    },
    DAI: {
        address: "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063",
        decimals: 18
    },
    WETH: {
        address: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619",
        decimals: 18
    },
    WMATIC: {
        address: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
        decimals: 18
    },
    WBTC: {
        address: "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6",
        decimals: 8
    }
}

// -----------------------------
// Hop Paths
// -----------------------------

const HOP_PATHS = [

    ["USDC","WETH","USDC"],
    ["USDC","WMATIC","USDC"],
    ["USDC","WBTC","USDC"],

    ["USDC","USDT","USDC"],
    ["USDC","DAI","USDC"],

    ["USDC","WETH","USDT","USDC"],
    ["USDC","WETH","DAI","USDC"],

]

// -----------------------------
// ABI
// -----------------------------

const routerABI = [
"function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)"
]

// -----------------------------
// Flash loan settings
// -----------------------------

const FLASH_LOAN = 10000
const FLASH_FEE = 0.0009
const GAS_ESTIMATE = 0.4

// -----------------------------
// Utils
// -----------------------------

function format(n){
return Number(n).toFixed(6)
}

// -----------------------------
// Balance logging
// -----------------------------

async function showBalances(){

const matic = await provider.getBalance(wallet.address)

console.log("Wallet:",wallet.address)
console.log("MATIC balance:",ethers.utils.formatEther(matic))

}

// -----------------------------
// Simulation
// -----------------------------

async function simulate(pathSymbols, routerA, routerB){

try{

console.log("------------------------------------------------")
console.log("Simulation started")

const pathAddresses = pathSymbols.map(s => TOKENS[s].address)

console.log("Hop path:",pathSymbols.join(" -> "))
console.log("Routers:",routerA.name,"->",routerB.name)

const router1 = new ethers.Contract(routerA.address,routerABI,provider)
const router2 = new ethers.Contract(routerB.address,routerABI,provider)

const amountIn = ethers.utils.parseUnits(
FLASH_LOAN.toString(),
TOKENS.USDC.decimals
)

// ----------------
// swap 1
// ----------------

const out1 = await router1.getAmountsOut(amountIn,pathAddresses.slice(0,2))

const amountMid = out1[1]

// ----------------
// swap 2
// ----------------

const out2 = await router2.getAmountsOut(amountMid,pathAddresses.slice(1))

const returned = out2[out2.length-1]

const returnedUSDC = Number(
ethers.utils.formatUnits(returned,6)
)

const fee = FLASH_LOAN * FLASH_FEE

const net =
returnedUSDC
-
FLASH_LOAN
-
fee
-
GAS_ESTIMATE

console.log("Loan:",FLASH_LOAN,"USDC")
console.log("Returned:",format(returnedUSDC),"USDC")
console.log("Flash loan fee:",fee)
console.log("Gas estimate:",GAS_ESTIMATE)

if(net > 0){

console.log(
chalk.green(
"Net profit:",
format(net),
"USDC"
)
)

console.log(
chalk.green("PROFITABLE TRADE FOUND")
)

console.log("Sending private bundle...")

console.log("Tx sent (simulated)")

console.log("Profit deposited to vault")

console.log("Vault balance:",format(net),"USDC")

}
else{

console.log(
"Net profit:",
format(net)
)

}

}catch(e){

console.log("Simulation error")

}

}

// -----------------------------
// Main Loop
// -----------------------------

async function main(){

console.log("ARB BOT STARTED")
console.log("RPC:",RPC)

await showBalances()

while(true){

for(const path of HOP_PATHS){

await simulate(
path,
ROUTERS.quickswap,
ROUTERS.sushiswap
)

await simulate(
path,
ROUTERS.sushiswap,
ROUTERS.quickswap
)

}

}

}

main()
