const { ethers } = require("ethers")

/* ================= CONFIG ================= */

const RPC = "https://polygon-rpc.com"

const provider = new ethers.providers.JsonRpcProvider(RPC)

/* ================= CONTRACT ================= */

const ARB_CONTRACT = "YOUR_CONTRACT_ADDRESS"

/* ================= TOKENS ================= */

const USDC = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"

const TOKENS = [

"0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", // WETH
"0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270", // WMATIC
"0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6", // WBTC
"0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063", // DAI
"0xc2132D05D31c914a87C6611C10748AEb04B58e8F", // USDT
"0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39", // LINK
"0xd6df932a45c0f255f85145f286ea0b292b21c90b"  // AAVE

]

/* ================= ROUTERS ================= */

const QUICKSWAP = "0xa5E0829CaCED8fFDD4De3c43696c57F7D7A678ff"
const SUSHISWAP = "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506"

const ROUTERS = [QUICKSWAP, SUSHISWAP]

/* ================= SETTINGS ================= */

const MIN_PROFIT = 0.000001
const SIGNAL_THRESHOLD = 0.0001

const TRADE_SIZE = ethers.utils.parseUnits("10", 6)

/* ================= ROUTER ABI ================= */

const ROUTER_ABI = [
"function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory)"
]

/* ================= SAFE PRICE CALL ================= */

async function safeGetAmountsOut(router, amount, path) {

    try {

        const routerContract = new ethers.Contract(router, ROUTER_ABI, provider)

        const amounts = await routerContract.getAmountsOut(amount, path)

        return amounts

    } catch (err) {

        return null

    }

}

/* ================= PROFIT CHECK ================= */

function calculateProfit(finalAmount, startAmount) {

    const diff = finalAmount.sub(startAmount)

    return Number(ethers.utils.formatUnits(diff, 6))

}

/* ================= SCANNER ================= */

async function scanPairs() {

    console.log("🔎 Multi-hop scanning...")

    for (const token of TOKENS) {

        for (const buyRouter of ROUTERS) {

            for (const sellRouter of ROUTERS) {

                if (buyRouter === sellRouter) continue

                /* BUY TOKEN */

                const buyQuote = await safeGetAmountsOut(
                    buyRouter,
                    TRADE_SIZE,
                    [USDC, token]
                )

                if (!buyQuote) continue

                const tokenAmount = buyQuote[1]

                /* SELL TOKEN */

                const sellQuote = await safeGetAmountsOut(
                    sellRouter,
                    tokenAmount,
                    [token, USDC]
                )

                if (!sellQuote) continue

                const finalUSDC = sellQuote[1]

                const profit = calculateProfit(finalUSDC, TRADE_SIZE)

                if (profit > SIGNAL_THRESHOLD) {

                    console.log("")
                    console.log("🚀 PROFITABLE ROUTE FOUND")
                    console.log("Token:", token)
                    console.log("Buy Router:", buyRouter)
                    console.log("Sell Router:", sellRouter)
                    console.log("Trade Size:", ethers.utils.formatUnits(TRADE_SIZE,6))
                    console.log("Profit:", profit)
                    console.log("")

                    return {
                        token,
                        buyRouter,
                        sellRouter,
                        profit
                    }

                }

            }

        }

    }

    console.log("⚠️ No profitable route")

    return null

}

/* ================= EXECUTION SIGNAL ================= */

async function executeIfProfitable(route) {

    if (!route) {

        console.log("💤 No trade")
        return

    }

    if (route.profit < MIN_PROFIT) {

        console.log("Profit below execution threshold")
        return

    }

    console.log("⚡ EXECUTION SIGNAL")

    console.log("Calling executeBestFlashLoanArbitrage()")

}

/* ================= MAIN LOOP ================= */

async function startBot() {

    console.log("==================================")
    console.log("POLYGON ARBITRAGE BOT STARTED")
    console.log("==================================")

    console.log("Min Execute Profit:", MIN_PROFIT)
    console.log("Signal Threshold:", SIGNAL_THRESHOLD)

    let cycle = 1

    while (true) {

        console.log(`--- Cycle ${cycle} ---`)

        const route = await scanPairs()

        await executeIfProfitable(route)

        cycle++

        await new Promise(r => setTimeout(r, 3000))

    }

}

startBot()
