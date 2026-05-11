
import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config();

/* =========================================================
   ENV
========================================================= */

const PRIVATE_KEY =
    process.env.WALLET_PRIVATE_KEY ||
    process.env.PRIVATE_KEY;

if (!PRIVATE_KEY) {
    throw new Error("Missing PRIVATE_KEY");
}

/* =========================================================
   RPC
========================================================= */

const RPC =
    "https://polygon-bor-rpc.publicnode.com";

const provider =
    new ethers.JsonRpcProvider(RPC);

const wallet =
    new ethers.Wallet(
        PRIVATE_KEY,
        provider
    );

/* =========================================================
   CONTRACT
========================================================= */

const CONTRACT_ADDRESS =
    "0xB1a557c33FF23F3C0Ffa2A9251630197b037F4cc";

/* =========================================================
   ABI
========================================================= */

const abi = [

    "function owner() view returns(address)",

    "function simulateArbitrageProfit(address,address,uint256,address[],address[]) view returns(uint256,uint256)",

    "function executeArbitrage(address,address,uint256,address[],address[],uint256) external"

];

const arb =
    new ethers.Contract(
        CONTRACT_ADDRESS,
        abi,
        wallet
    );

/* =========================================================
   TOKENS
========================================================= */

const TOKENS = {

    WETH:
        "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619",

    WMATIC:
        "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",

    DAI:
        "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063",

    USDT:
        "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",

    WBTC:
        "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6",

    USDC:
        "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"
};

const USDC = TOKENS.USDC;

/* =========================================================
   ROUTERS
========================================================= */

const QUICK =
    "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff";

const SUSHI =
    "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506";

/* =========================================================
   ERC20
========================================================= */

const ERC20_ABI = [
    "function balanceOf(address) view returns(uint256)"
];

/* =========================================================
   SETTINGS
========================================================= */

/*
    EXECUTE ALL SPREADS
    ABOVE 0.00001 USDC
*/

const EXECUTION_THRESHOLD =
    ethers.parseUnits("0.00001", 6);

/*
    FAST LOOP
*/

const LOOP_DELAY = 1000;

/* =========================================================
   HELPERS
========================================================= */

const sleep =
    (ms) =>
        new Promise(r => setTimeout(r, ms));

const fmt =
    (x) =>
        Number(
            ethers.formatUnits(x, 6)
        ).toFixed(6);

function stage(name) {

    console.log(`\n📡 ${name}`);
}

/* =========================================================
   FULL HOP PATHS
========================================================= */

function makeRoute(token) {

    switch (token) {

        case TOKENS.WETH:

            return {

                buyRouter: QUICK,

                sellRouter: SUSHI,

                pathToToken: [
                    USDC,
                    TOKENS.WMATIC,
                    TOKENS.WETH
                ],

                pathToUSDC: [
                    TOKENS.WETH,
                    TOKENS.WMATIC,
                    USDC
                ]
            };

        case TOKENS.WBTC:

            return {

                buyRouter: QUICK,

                sellRouter: SUSHI,

                pathToToken: [
                    USDC,
                    TOKENS.WETH,
                    TOKENS.WBTC
                ],

                pathToUSDC: [
                    TOKENS.WBTC,
                    TOKENS.WETH,
                    USDC
                ]
            };

        case TOKENS.DAI:

            return {

                buyRouter: QUICK,

                sellRouter: SUSHI,

                pathToToken: [
                    USDC,
                    TOKENS.USDT,
                    TOKENS.DAI
                ],

                pathToUSDC: [
                    TOKENS.DAI,
                    TOKENS.USDT,
                    USDC
                ]
            };

        case TOKENS.USDT:

            return {

                buyRouter: QUICK,

                sellRouter: SUSHI,

                pathToToken: [
                    USDC,
                    TOKENS.WMATIC,
                    TOKENS.USDT
                ],

                pathToUSDC: [
                    TOKENS.USDT,
                    TOKENS.WMATIC,
                    USDC
                ]
            };

        default:

            return {

                buyRouter: QUICK,

                sellRouter: SUSHI,

                pathToToken: [
                    USDC,
                    token
                ],

                pathToUSDC: [
                    token,
                    USDC
                ]
            };
    }
}

/* =========================================================
   VAULT BALANCE
========================================================= */

async function getVaultBalance() {

    const usdc =
        new ethers.Contract(
            USDC,
            ERC20_ABI,
            provider
        );

    return await usdc.balanceOf(
        CONTRACT_ADDRESS
    );
}

/* =========================================================
   SCAN TOKEN
========================================================= */

async function scanToken(
    name,
    token
) {

    try {

        console.log(
            `\n🔎 SCANNING ${name}`
        );

        const vaultBal =
            await getVaultBalance();

        console.log(
            `\n💰 VAULT:\n${fmt(vaultBal)} USDC`
        );

        /*
            USE 100% OF VAULT
            NO FLASH LOANS
        */

        const amount =
            vaultBal;

        if (amount <= 0n) {
            return null;
        }

        stage(
            "PIPELINE STAGE 1: LIQUIDITY DEPTH SCAN"
        );

        const route =
            makeRoute(token);

        /*
            SMART CONTRACT LIQUIDITY DEPTH
            REAL ON-CHAIN ROUTER SIMULATION
        */

        const sim =
            await arb.simulateArbitrageProfit.staticCall(

                route.buyRouter,

                route.sellRouter,

                amount,

                route.pathToToken,

                route.pathToUSDC
            );

        const estimatedFinal =
            sim[0];

        const rawProfit =
            estimatedFinal - amount;

        console.log(
            `\n📊 INPUT:\n${fmt(amount)} USDC`
        );

        console.log(
            `\n📊 OUTPUT:\n${fmt(estimatedFinal)} USDC`
        );

        console.log(
            `\n🧮 RAW PROFIT:\n${fmt(rawProfit)} USDC`
        );

        const spreadPct =
            (Number(fmt(rawProfit)) /
             Number(fmt(amount))) * 100;

        console.log(
            `\n📈 SPREAD %:\n${spreadPct.toFixed(6)}%`
        );

        if (
            rawProfit <
            EXECUTION_THRESHOLD
        ) {

            console.log(
                "\n💤 BELOW THRESHOLD"
            );

            return null;
        }

        console.log(
            "\n✅ EXECUTABLE SPREAD FOUND"
        );

        stage(
            "PIPELINE STAGE 2: STATIC VALIDATION"
        );

        const deadline =
            Math.floor(Date.now() / 1000) + 120;

        /*
            STATIC EXECUTION TEST
        */

        await arb.executeArbitrage.staticCall(

            route.buyRouter,

            route.sellRouter,

            amount,

            route.pathToToken,

            route.pathToUSDC,

            deadline
        );

        console.log(
            "\n✅ STATIC EXECUTION PASSED"
        );

        return {

            token,

            route,

            amount,

            rawProfit
        };

    } catch (err) {

        console.log(
            "\n❌ VALIDATION FAILED"
        );

        console.log(
            err.shortMessage || err.message
        );

        return null;
    }
}

/* =========================================================
   EXECUTE
========================================================= */

async function execute(signal) {

    try {

        stage(
            "PIPELINE STAGE 3: LIVE EXECUTION"
        );

        const before =
            await getVaultBalance();

        console.log(
            `\n💰 BEFORE:\n${fmt(before)} USDC`
        );

        const deadline =
            Math.floor(Date.now() / 1000) + 120;

        console.log(
            "\n📡 SENDING TRANSACTION..."
        );

        /*
            VAULT ONLY
            NO FLASH LOANS
        */

        const tx =
            await arb.executeArbitrage(

                signal.route.buyRouter,

                signal.route.sellRouter,

                signal.amount,

                signal.route.pathToToken,

                signal.route.pathToUSDC,

                deadline,

                {
                    gasLimit: 1500000
                }
            );

        console.log(
            `\n🚀 TX HASH:\n${tx.hash}`
        );

        console.log(
            "\n⛓ WAITING CONFIRMATION..."
        );

        const receipt =
            await tx.wait();

        stage(
            "PIPELINE STAGE 4: CONFIRMED"
        );

        console.log(
            `\n✅ BLOCK:\n${receipt.blockNumber}`
        );

        const after =
            await getVaultBalance();

        const profit =
            after > before
                ? after - before
                : 0n;

        console.log(
            `\n💰 AFTER:\n${fmt(after)} USDC`
        );

        console.log(
            `\n🧮 VAULT PROFIT:\n${fmt(profit)} USDC`
        );

        const growth =
            before > 0n
                ? (Number(profit) /
                   Number(before)) * 100
                : 0;

        console.log(
            `\n📈 VAULT GROWTH:\n+${growth.toFixed(6)}%`
        );

    } catch (err) {

        console.log(
            "\n❌ EXECUTION FAILED"
        );

        console.log(
            err.shortMessage || err.message
        );
    }
}

/* =========================================================
   MAIN LOOP
========================================================= */

async function main() {

    console.log(
        "\n🚀 FULL VAULT ARBITRAGE ENGINE STARTED"
    );

    const owner =
        await arb.owner();

    console.log(
        `\n👤 OWNER:\n${owner}`
    );

    console.log(
        `\n👤 WALLET:\n${wallet.address}`
    );

    /*
        OWNER VALIDATION
    */

    if (
        owner.toLowerCase() !==
        wallet.address.toLowerCase()
    ) {

        throw new Error(
            "Wallet is not contract owner"
        );
    }

    while (true) {

        try {

            const scans =
                await Promise.all(

                    Object.entries(TOKENS)

                        .filter(
                            ([k]) => k !== "USDC"
                        )

                        .map(
                            ([name, token]) =>
                                scanToken(
                                    name,
                                    token
                                )
                        )
                );

            const valid =
                scans.filter(Boolean);

            if (valid.length === 0) {

                console.log(
                    "\n💤 NO OPPORTUNITIES"
                );

                await sleep(LOOP_DELAY);

                continue;
            }

            /*
                BEST SPREAD
            */

            const best =
                valid.reduce(

                    (a, b) =>

                        b.rawProfit > a.rawProfit
                            ? b
                            : a
                );

            console.log(
                "\n🏆 BEST SIGNAL"
            );

            console.log(
                `\n💵 SIZE:\n${fmt(best.amount)} USDC`
            );

            console.log(
                `\n🧮 PROFIT:\n${fmt(best.rawProfit)} USDC`
            );

            /*
                EXECUTE IMMEDIATELY
            */

            await execute(best);

        } catch (err) {

            console.log(
                "\n❌ LOOP ERROR"
            );

            console.log(
                err.shortMessage || err.message
            );
        }

        await sleep(LOOP_DELAY);
    }
}

/* =========================================================
   START
========================================================= */

main().catch(console.error);
