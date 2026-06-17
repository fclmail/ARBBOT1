import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

// ==========================================
// 1. HARDCODED NETWORK & SMART CONTRACT CONFIG
// ==========================================
const RPC_URL = "https://polygon.drpc.org";
const VAULT_CONTRACT_ADDRESS = "0xB1a557c33FF23F3C0Ffa2A9251630197b037F4cc";

const USDC_ADDRESS  = "0x2791bca1f2de4661ed88a30c99a7a9449aa84174";
// ==========================================
// ERC TOP 100 TOKENS (POLYGON POOL IMPORTS)
// ==========================================
const AVAX              = "0x2c89bbc92bd86f8075d1decc58c7f4e0107f286b";
const FET               = "0x7583feddbcefa813dc18259940f76a02710a8905";
const INJ               = "0x4e8dc2149eac3f3def36b1c281ea466338249371";
const RNDR              = "0x61299774020da444af134c82fa83e3810b309991";
const UNI               = "0xb33eaad8d922b1083446dc23f610c2567fb5180f";
const PYUSD0            = "0x99af3eea856556646c98c8b9b2548fe815240750";
const PAXG              = "0x553d3d295e0f695b9228246232edf400ed3560b5";
const SXP               = "0x6abb753c1893194de4a83c6e8b4eadfc105fd5f5";
const POLY              = "0xcb059c5573646047d6d88dddb87b745c18161d3b";
const CHZ               = "0xf1938ce12400f9a761084e7a80d37e732a4da056";
const SHIB              = "0x6f8a06447ff6fcf75d803135a7de15ce88c1d4ec";
const CRVUSD            = "0xc4ce1d6f5d98d65ee25cf85e9f2e9dcfee6cb5d6";
const APE               = "0xb7b31a6bc18e48888545ce79e83e06003be70930";
const ZRO               = "0x6985884c4392d348587b19cb9eaaf157f13271cd";
const CRV               = "0x172370d5cd63279efa6d502dab29171933a610af";
const LDO               = "0xc3c7d422809852031b44ab29eec9f1eff2a58756";
const APEPE             = "0xa3f751662e282e83ec3cbc387d225ca56dd63d3a";
const STG               = "0x2f6f07cdcf3588944bf4c42ac74ff24bf56e7590";
const SAND              = "0xbbba073c31bf03b8acf7c28ef0738decf3695683";
const TUSD              = "0x2e1ad108ff1d8c782fcbbb89aad783ac49586756";
const USDQ              = "0xb291996477504506bf5f583102b5b5ea5d1e40e0";
const FRXUSD            = "0x80eede496655fb9047dd39d9f418d5483ed600df";
const SUSHI             = "0x0b3f868e0be5597d5db7feb59e1cadbb0fdda50a";
const GRT               = "0x5fe2b58c013d7601147dcdd68c143a77499f5531";
const LPT               = "0x3962f4a0a0051dcce0be73a7e09cef5756736712";
const PAX               = "0x6f3b3286fd86d8b47ec737ceb3d0d354cc657b3e";
const AUSD              = "0x00000000efe302beaa2b3e6e1b18d08d69a9012a";
const BAT               = "0x3cef98bb43d732e2f285ee605a8158cde967d219";
const TBTC              = "0x236aa50979d5f3de3bd1eeb40e81137f22ab794b";
const MANA              = "0xa1c57f48f0deb89f569dfbe6e2b7f46d33606fd4";
const TRB               = "0xe3322702bedaaed36cddab233360b939775ae5f1";
const COMP              = "0x8505b9d2254a7ae468c0e9dd10ccea3a837aef5c";
const ONEINCH           = "0x9c2c5fd7b07e95ee044ddeba0e97a665f142394f"; // Renamed 1INCH to safe identifier
const THETA             = "0xb46e0ae620efd98516f49bb00263317096c114b2";
const CRO               = "0xada58df0f643d959c2a47c9d4d4c1a4defe3f11c";
const XYO               = "0xd2507e7b5794179380673870d88b22f94da6abe0";
const MASK              = "0x2b9e7ccdf0f4e5b24757c1e1a80e311e34cb10c7";
const EURQ              = "0xd571edb2ef29df10fcd6200fd6d0ed2389983db3";
const APOLUSDT          = "0x6ab707aca953edaefbc4fd23ba73294241490620";
const ENJ               = "0x7ec26842f195c852fa843bb9f6d8b583a274a157";
const ZRX               = "0x5559edb74751a0ede9dea4dc23aee72cca6be3d5";
const GMT               = "0x714db550b574b3e927af3d93e26127d15721d4c2";
const SNX               = "0x50b728d8d964fd00c2d0aad81718b71311fef68a";
const ANKR              = "0x101a023270368c0d50bffb62780f4afd4ea79c35";
const GLM               = "0x0b220b82f3ea3b7f6d9a1d8ab58930c064a2b5bf";
const COW               = "0x2f4efd3aa42e15a1ec6114547151b63ee5d39958";
const BAND              = "0xa8b1e0764f85f53dfe21760e8afe5446d82606ac";
const AXL               = "0x6e4e624106cb12e168e6533f8ec7c82263358940";
const UMA               = "0x3066818837c5e6ed6601bd5a91b0762877a6b731";
const YFI               = "0xda537104d6a5edd53c6fbba9a898708e465260b6";
const ELON              = "0xe0339c80ffde91f3e20494df88d4206d86024cdf";
const NEXO              = "0x41b3966b4ff7b427969ddf5da3627d6aeae9a48e";
const EURAU             = "0x4933a85b5b5466fbaf179f72d3de273c287ec2c2";
const ORDER             = "0x4e200fe2f3efb977d5fd9c430a41531fb04d97b8";
const IOTX              = "0xf6372cdb9c1d3674e83842e3800f2a62ac9f3c66";
const AMP               = "0x0621d647cecbfb64b79e44302c1933cb4f27054d";
const CBK               = "0x4ec203dd0699fac6adaf483cdd2519bc05d2c573";
const ACX               = "0xf328b73b6c685831f238c30a23fc19140cb4d8fc";
const RLC               = "0xbe662058e00849c3eef2ac9664f37fefdf2cdbfe";
const POND              = "0x73580a2416a57f1c4b6391dba688a9e4f7dbece0";
const BOBA              = "0xa4b2b20b2c73c7046ed19ac6bff5e5285c58f20a";
const C98               = "0x77f56cf9365955486b12c4816992388ee8606f0e";
const PYR               = "0x430ef9263e76dae63c84292c3409d61c598e9682";
const USDD              = "0xffa4d863c96e743a2e1513824ea006b8d0353c57";
const REQ               = "0xb25e20de2f2ebb4cffd4d16a55c7b395e8a94762";
const KNC               = "0x1c954e8fe737f99f68fa1ccda3e51ebdb291948c";
const POWR              = "0x0aab8dc887d34f00d50e19aee48371a941390d14";
const ZKP               = "0x9a06db14d639796b25a6cec6a1bf614fd98815ec";
const FRAX              = "0x45c32fa6df82ead1e2ef74d17b76547eddfaff89";
const SOPH              = "0xeb971fd26783f32694dbb392dd7289de23109148";
const HOT               = "0x0c51f415cf478f8d08c246a6c6ee180c5dc3a012";
const GTC               = "0xdb95f9188479575f3f718a245eca1b3bf74567ec";
const TELEBTC           = "0x3bf668fe1ec79a84ca8481cead5dbb30d61cc685";
const WOO               = "0x1b815d120b3ef02039ee11dc2d33de7aa4a8c603";
const AIOZ              = "0xe2341718c6c0cbfa8e6686102dd8fbf4047a9e9b";
const GNO               = "0x5ffd62d3c3ee2e81c00a7b9079fb248e7df024a8";
const FRXETH            = "0x43edd7f3831b08fe70b7555ddd373c8bf65a9050";
const FRXETH_CANONICAL  = "0xee327f889d5947c1dc1934bb208a1e792f953e96";
const UST               = "0x692597b009d13c4049a947cab2239b7d6517875f";
const NPT               = "0x306ee01a6ba3b4a8e993fa2c1adc7ea24462000c";
const ADX               = "0xdda7b23d2d72746663e7939743f929a3d85fc975";
const SYN               = "0xf8f9efc0db77d8881500bb06ff5d6abc3070e695";
const FLUID             = "0xf50d05a1402d0adafa880d36050736f9f6ee7dee";
const ORBS              = "0x614389eaae0a6821dc49062d56bda3d9d45fa2ff";
const VANRY             = "0x8de5b80a0c1b02fe4976851d030b36122dbb8624";
const OMG               = "0x62414d03084eeb269e18c970a21f45d2967f0170";
const TEL               = "0xdf7837de1f2fa4631d716cf2502f8b230f1dcc32";
const OXT               = "0x9880e3dda13c8e7d4804691a45160102d31f6060";
const WMATIC_ADDRESS = "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270";
const USDT_ADDRESS   = "0xc2132d05d31c914a87c6611c10748aeb04b58e8f";
const WBTC_ADDRESS   = "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6";

const ROUTERS = {
    QUICK: "0xa5e0829caced8ffdd4de3c43696c57f7d7a678ff",
    SUSHI: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
    DFYN:  "0xf17b5936699a3232363837bc45cd031553456574",
    APE:   "0xc0788a3d33aa7a816f74d957ce64415f33333333" 
};

const ENFORCER_ABI = [
    "function simulateArbitrageProfit(address buyRouter, address sellRouter, uint256 amountInUSDC, address[] calldata pathToToken, address[] calldata pathToUSDC) public view returns (uint256 estimatedFinalUSDC, uint256 estimatedProfit)",
    "function executeArbitrage(address buyRouter, address sellRouter, uint256 amountInUSDC, address[] calldata pathToToken, address[] calldata pathToUSDC, uint256 deadline) external"
];
const ERC20_ABI = [
    "function balanceOf(address account) view returns (uint256)"
];

// ==========================================
// 2. ROUTE GENERATION
// ==========================================
function getTokenLabel(address) {
    switch(address.toLowerCase()) {
        case USDC_ADDRESS.toLowerCase(): return "USDC";
        case WMATIC_ADDRESS.toLowerCase(): return "WMATIC";
        case USDT_ADDRESS.toLowerCase(): return "USDT";
        case WBTC_ADDRESS.toLowerCase(): return "WBTC";
        default: return "UNKNOWN";
    }
}

function generateScanningRoutes() {
    const intermediates = [WMATIC_ADDRESS, USDT_ADDRESS, WBTC_ADDRESS];
    let routeMatrix = [];
    for (let intermediate of intermediates) {
        routeMatrix.push({
            pathToToken: [USDC_ADDRESS, intermediate],
            pathToUSDC: [intermediate, USDC_ADDRESS],
            label: `USDC ➡️ ${getTokenLabel(intermediate)} ➡️ USDC`
        });
        for (let secondIntermediate of intermediates) {
            if (intermediate.toLowerCase() !== secondIntermediate.toLowerCase()) {
                routeMatrix.push({
                    pathToToken: [USDC_ADDRESS, intermediate, secondIntermediate],
                    pathToUSDC: [secondIntermediate, USDC_ADDRESS],
                    label: `USDC ➡️ ${getTokenLabel(intermediate)} ➡️ ${getTokenLabel(secondIntermediate)} ➡️ USDC`
                });
            }
        }
    }
    return routeMatrix;
}

// ==========================================
// 3. MAIN RUNNER LOOP (Production Configuration)
// ==========================================
async function main() {
    console.log("⏳ Initializing Locked Production Engine...");
    
    if (!process.env.PRIVATE_KEY) {
        console.error("❌ CRITICAL ERROR: PRIVATE_KEY is missing from your .env configuration file.");
        process.exit(1);
    }
    const PRIVATE_KEY = process.env.PRIVATE_KEY;

    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
    
    const vaultContract = new ethers.Contract(VAULT_CONTRACT_ADDRESS, ENFORCER_ABI, wallet);
    const usdcContract = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, provider);

    const startBlock = await provider.getBlockNumber();
    console.log(`\n🟢 CONNECTED | Active on Polygon Block: #${startBlock}`);

    const tokenRoutes = generateScanningRoutes();
    const routerPairs = [
        { buy: ROUTERS.QUICK, sell: ROUTERS.SUSHI, buyName: "QUICK", sellName: "SUSHI" },
        { buy: ROUTERS.SUSHI, sell: ROUTERS.QUICK, buyName: "SUSHI", sellName: "QUICK" },
        { buy: ROUTERS.DFYN,  sell: ROUTERS.QUICK, buyName: "DFYN",  sellName: "QUICK" },
        { buy: ROUTERS.DFYN,  sell: ROUTERS.APE,   buyName: "DFYN",  sellName: "APE" }
    ];

    // ADJUSTABLE: Standard production capital tier size
    const amountInUnits = ethers.parseUnits("0.5", 6); 
    
    let isExecuting = false;

    provider.on("block", async (blockNumber) => {
        console.log(`📦 BLOCK: #${blockNumber} | Scanning Matrix Routes...`);

        if (isExecuting) {
            console.log("⏳ Execution lock active. Skipping this block scan to prevent collisions.");
            return;
        }

        for (let route of tokenRoutes) {
            for (let pair of routerPairs) {
                try {
                    // Query the on-chain simulation engine
                    const simulation = await vaultContract.simulateArbitrageProfit(
                        pair.buy,
                        pair.sell,
                        amountInUnits,
                        route.pathToToken,
                        route.pathToUSDC
                    );

                    const estimatedProfit = simulation.estimatedProfit;
                    const estimatedProfitHuman = parseFloat(ethers.formatUnits(estimatedProfit, 6));

                    // =================================================================
                    // PRODUCTION FILTER: Only fires transaction if true profit is verified
                    // =================================================================
                    if (estimatedProfitHuman > 0) { 
                        const contractBalanceBefore = await usdcContract.balanceOf(VAULT_CONTRACT_ADDRESS);
                        
                        if (contractBalanceBefore < amountInUnits) {
                            console.error(`❌ Opportunity found, but contract lacks required capital size.`);
                            continue;
                        }

                        // Activate concurrency lock
                        isExecuting = true;
                        console.log(`💰 [PROFIT MATCH DETECTED]. Delta Calculation: +${estimatedProfitHuman.toFixed(6)} USDC`);
                        console.log(`[DEX PATH]: ${pair.buyName} (${route.label}) ➡️ ${pair.sellName}`);
                        console.log(`⚡ LOCK ACQUIRED. Dispatching production transaction...`);
                        
                        const txDeadline = Math.floor(Date.now() / 1000) + 30; // 30s expiration limit
                        
                        const tx = await vaultContract.executeArbitrage(
                            pair.buy,
                            pair.sell,
                            amountInUnits,
                            route.pathToToken,
                            route.pathToUSDC,
                            txDeadline,
                            { gasLimit: 400000 }
                        );
                        
                        console.log(`🚨 TRANSACTION HASH DISPATCHED: ${tx.hash}`);
                        const receipt = await tx.wait(1);
                        console.log(`✅ CONFIRMED IN BLOCK: #${receipt.blockNumber}`);
                        
                        const contractBalanceAfter = await usdcContract.balanceOf(VAULT_CONTRACT_ADDRESS);
                        const netProfitRealized = contractBalanceAfter - contractBalanceBefore;
                        console.log(`💰 Realized Net Profit: +${ethers.formatUnits(netProfitRealized, 6)} USDC`);
                        
                        // Release lock for subsequent block evaluations
                        isExecuting = false;
                    }
                } catch (error) {
                    // Suppress expected simulation reverts to keep runtime clean
                    if (error.message && !error.message.includes("execution reverted")) {
                        console.log(`⚠️ Simulation Exception: ${error.message}`);
                    }
                }
            }
        }
    });
}

main().catch((error) => {
    console.error("Fatal Runtime Loop Error:", error);
    process.exit(1);
});
