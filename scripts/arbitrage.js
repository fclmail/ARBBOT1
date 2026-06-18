import { ethers } from "ethers";
import dotenv from "dotenv";

dotenv.config();

// ==========================================
// 1. STABLE HTTP INFRASTRUCTURE & SETTINGS
// ==========================================
const RPC_URL = "https://polygon-bor-rpc.publicnode.com";
const VAULT_CONTRACT_ADDRESS = "0xB1a557c33FF23F3C0Ffa2A9251630197b037F4cc";
const USDC_ADDRESS  = "0x2791bca1f2de4661ed88a30c99a7a9449aa84174";

const ROUTERS = {
    QUICK: "0xa5e0829caced8ffdd4de3c43696c57f7d7a678ff",
    SUSHI: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506"
};

const TOKENS = {
    WMATIC: "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270",
    USDT:   "0xc2132d05d31c914a87c6611c10748aeb04b58e8f",
    WBTC:   "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6",
    DAI:    "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063",
    





AVAX:    "0x2C89bbc92BD86F8075d1DEcc58C7F4E0107f286b",
FET:     "0x7583feddbcefa813dc18259940f76a02710a8905",
INJ:     "0x4e8dc2149eac3f3def36b1c281ea466338249371",
RNDR:    "0x61299774020da444af134c82fa83e3810b309991",
UNI:     "0xb33eaad8d922b1083446dc23f610c2567fb5180f",
PYUSD0:  "0x99af3eea856556646c98c8b9b2548fe815240750",
PAXG:    "0x553d3d295e0f695b9228246232edf400ed3560b5",
SXP:     "0x6abb753c1893194de4a83c6e8b4eadfc105fd5f5",
POLY:    "0xcb059c5573646047d6d88dddb87b745c18161d3b",
CHZ:     "0xf1938ce12400f9a761084e7a80d37e732a4da056",
SHIB:    "0x6f8a06447ff6fcf75d803135a7de15ce88c1d4ec",
CRVUSD:  "0xc4Ce1D6F5D98D65eE25Cf85e9F2E9DcFEe6Cb5d6",
APE:     "0xB7b31a6BC18e48888545CE79e83E06003bE70930",
ZRO:     "0x6985884c4392d348587b19cb9eaaf157f13271cd",
CRV:     "0x172370d5cd63279efa6d502dab29171933a610af",
LDO:     "0xc3c7d422809852031b44ab29eec9f1eff2a58756",
APEPE:   "0xa3f751662e282e83ec3cbc387d225ca56dd63d3a",
STG:     "0x2f6f07cdcf3588944bf4c42ac74ff24bf56e7590",
SAND:    "0xBbba073C31bF03b8ACf7c28EF0738DeCF3695683",
TUSD:    "0x2e1ad108ff1d8c782fcbbb89aad783ac49586756",
USDQ:    "0xb291996477504506bf5f583102b5b5ea5d1e40e0",
FRXUSD:  "0x80eede496655fb9047dd39d9f418d5483ed600df",
SUSHI:   "0x0b3f868e0be5597d5db7feb59e1cadbb0fdda50a",
GRT:     "0x5fe2b58c013d7601147dcdd68c143a77499f5531",
LPT:     "0x3962f4a0a0051dcce0be73a7e09cef5756736712",
PAX:     "0x6f3b3286fd86d8b47ec737ceb3d0d354cc657b3e",









AUSD:"0x00000000efe302beaa2b3e6e1b18d08d69a9012a",
BAT:"0x3cef98bb43d732e2f285ee605a8158cde967d219",
TBTC:"0x236aa50979d5f3de3bd1eeb40e81137f22ab794b",
MANA:"0xa1c57f48f0deb89f569dfbe6e2b7f46d33606fd4",
TRB:"0xe3322702bedaaed36cddab233360b939775ae5f1",
COMP:"0x8505b9d2254a7ae468c0e9dd10ccea3a837aef5c",
INCH:"0x9c2c5fd7b07e95ee044ddeba0e97a665f142394f",
THETA:"0xb46e0ae620efd98516f49bb00263317096c114b2",
CRO:"0xada58df0f643d959c2a47c9d4d4c1a4defe3f11c",
XYO:"0xd2507e7b5794179380673870d88b22f94da6abe0",
MASK:"0x2b9e7ccdf0f4e5b24757c1e1a80e311e34cb10c7",
EURQ:"0xd571edb2ef29df10fcd6200fd6d0ed2389983db3",
APOLUSDT:"0x6ab707aca953edaefbc4fd23ba73294241490620",
ENJ:"0x7ec26842f195c852fa843bb9f6d8b583a274a157",
ZRX:"0x5559edb74751a0ede9dea4dc23aee72cca6be3d5",
GMT:"0x714db550b574b3e927af3d93e26127d15721d4c2",
SNX:"0x50b728d8d964fd00c2d0aad81718b71311fef68a",
ANKR:"0x101a023270368c0d50bffb62780f4afd4ea79c35",
GLM:"0x0b220b82f3ea3b7f6d9a1d8ab58930c064a2b5bf",
COW:"0x2f4efd3aa42e15a1ec6114547151b63ee5d39958",
BAND:"0xa8b1e0764f85f53dfe21760e8afe5446d82606ac",
AXL:"0x6e4e624106cb12e168e6533f8ec7c82263358940",
UMA:"0x3066818837c5e6ed6601bd5a91b0762877a6b731",
YFI:"0xda537104d6a5edd53c6fbba9a898708e465260b6",
ELON:"0xe0339c80ffde91f3e20494df88d4206d86024cdf",
NEXO:"0x41b3966b4ff7b427969ddf5da3627d6aeae9a48e",
EURAU:"0x4933A85b5b5466Fbaf179F72D3DE273c287EC2c2",
ORDER:"0x4e200fe2f3efb977d5fd9c430a41531fb04d97b8",
IOTX:"0xf6372cdb9c1d3674e83842e3800f2a62ac9f3c66",
AMP:"0x0621d647cecbfb64b79e44302c1933cb4f27054d",
CBK:"0x4EC203dD0699Fac6adAF483CDd2519BC05D2c573",
ACX:"0xf328b73b6c685831f238c30a23fc19140cb4d8fc",









RLC:"0xbe662058e00849c3eef2ac9664f37fefdf2cdbfe",
POND:"0x73580a2416a57f1c4b6391dba688a9e4f7dbece0",
BOBA:"0xa4b2b20b2c73c7046ed19ac6bff5e5285c58f20a",
C98:"0x77f56cf9365955486b12c4816992388ee8606f0e",
PYR:"0x430ef9263e76dae63c84292c3409d61c598e9682",
USDD:"0xffa4d863c96e743a2e1513824ea006b8d0353c57",
REQ:"0xb25e20de2f2ebb4cffd4d16a55c7b395e8a94762",
KNC:"0x1c954e8fe737f99f68fa1ccda3e51ebdb291948c",
POWR:"0x0aab8dc887d34f00d50e19aee48371a941390d14",
ZKP:"0x9a06db14d639796b25a6cec6a1bf614fd98815ec",
FRAX:"0x45c32fa6df82ead1e2ef74d17b76547eddfaff89",
SOPH:"0xeb971fd26783f32694dbb392dd7289de23109148",
HOT:"0x0c51f415cf478f8d08c246a6c6ee180c5dc3a012",
GTC:"0xdb95f9188479575f3f718a245eca1b3bf74567ec",
TELEBTC:"0x3bf668fe1ec79a84ca8481cead5dbb30d61cc685",
WOO:"0x1b815d120b3ef02039ee11dc2d33de7aa4a8c603",
AIOZ:"0xe2341718c6c0cbfa8e6686102dd8fbf4047a9e9b",
GNO:"0x5ffd62d3c3ee2e81c00a7b9079fb248e7df024a8",
FRXETH:"0x43edd7f3831b08fe70b7555ddd373c8bf65a9050",
FRXETH_CANONICAL:"0xee327f889d5947c1dc1934bb208a1e792f953e96",
UST:"0x692597b009d13c4049a947cab2239b7d6517875f",
NPT:"0x306ee01a6ba3b4a8e993fa2c1adc7ea24462000c",
ADX:"0xdda7b23d2d72746663e7939743f929a3d85fc975",
SYN:"0xf8f9efc0db77d8881500bb06ff5d6abc3070e695",
FLUID:"0xf50d05a1402d0adafa880d36050736f9f6ee7dee",
ORBS:"0x614389eaae0a6821dc49062d56bda3d9d45fa2ff",
VANRY:"0x8de5b80a0c1b02fe4976851d030b36122dbb8624",
OMG:"0x62414d03084eeb269e18c970a21f45d2967f0170",
TEL:"0xdf7837de1f2fa4631d716cf2502f8b230f1dcc32",
OXT:"0x9880e3dda13c8e7d4804691a45160102d31f6060",
    QUICK:  "0x831753dd7087cac61ab5644b308642cc1c33dc13",
    WETH:   "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619"
};

const ENFORCER_ABI = [
    "function executeArbitrage(address buyRouter, address sellRouter, uint256 amountInUSDC, address[] calldata pathToToken, address[] calldata pathToUSDC, uint256 deadline) external"
];
const ROUTER_ABI = [
    "function getAmountsOut(uint256 amountIn, address[] calldata path) view returns (uint256[] memory amounts)"
];
const ERC20_ABI = [
    "function balanceOf(address account) view returns (uint256)"
];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const fmt = (x) => ethers.formatUnits(x, 6);
const BATCH_SIZE = 4;

// ==========================================
// 2. ROUTER QUOTE MEMORY CACHING SYSTEM (JS1)
// ==========================================
const quoteCache = new Map();
const CACHE_TTL = 1000; // 1 second validity

function getCachedQuote(routerAddress, path) {
    const key = `${routerAddress}-${path.join('-')}`;
    const cached = quoteCache.get(key);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        return cached.value;
    }
    return undefined;
}

function setCachedQuote(routerAddress, path, value) {
    const key = `${routerAddress}-${path.join('-')}`;
    quoteCache.set(key, { value, timestamp: Date.now() });
    
    if (quoteCache.size > 50000) {
        const now = Date.now();
        for (const [k, entry] of quoteCache) {
            if (now - entry.timestamp > CACHE_TTL) quoteCache.delete(k);
        }
    }
}

// ==========================================
// 3. JS1 SEQUENTIAL MULTI-HOP QUOTER 
// ==========================================
async function getSequentialTriangularQuote(routerContract, amountIn, path) {
    const routerAddr = routerContract.target;

    // Hop 1: USDC -> Token A
    const path1 = [path[0], path[1]];
    let out1 = getCachedQuote(routerAddr, path1);
    if (out1 === undefined) {
        try {
            const res = await routerContract.getAmountsOut(amountIn, path1);
            out1 = res[res.length - 1];
            setCachedQuote(routerAddr, path1, out1);
        } catch { setCachedQuote(routerAddr, path1, null); return null; }
    }
    if (!out1) return null;

    // Hop 2: Token A -> Token B
    const path2 = [path[1], path[2]];
    let out2 = getCachedQuote(routerAddr, path2);
    if (out2 === undefined) {
        try {
            const res = await routerContract.getAmountsOut(out1, path2);
            out2 = res[res.length - 1];
            setCachedQuote(routerAddr, path2, out2);
        } catch { setCachedQuote(routerAddr, path2, null); return null; }
    }
    if (!out2) return null;

    // Hop 3: Token B -> USDC
    const path3 = [path[2], path[3]];
    let out3 = getCachedQuote(routerAddr, path3);
    if (out3 === undefined) {
        try {
            const res = await routerContract.getAmountsOut(out2, path3);
            out3 = res[res.length - 1];
            setCachedQuote(routerAddr, path3, out3);
        } catch { setCachedQuote(routerAddr, path3, null); return null; }
    }
    return out3; // Final finalAmountOut in USDC
}

function buildTriangularPaths() {
    const tokenAddresses = Object.values(TOKENS);
    let generatedPaths = [];
    for (const a of tokenAddresses) {
        for (const b of tokenAddresses) {
            if (a === b) continue;
            generatedPaths.push({
                fullPath: [USDC_ADDRESS, a, b, USDC_ADDRESS],
                pathToToken: [USDC_ADDRESS, a, b],
                pathToUSDC: [b, USDC_ADDRESS]
            });
        }
    }
    return generatedPaths;
}

// ==========================================
// 4. MAIN RUNNER (Parallel Scanner & Control Loop)
// ==========================================
async function main() {
    console.log("🚀 BOT STARTED - ENHANCED ENGINE LOADED\n");
    
    if (!process.env.PRIVATE_KEY) {
        console.error("❌ CRITICAL ERROR: PRIVATE_KEY missing.");
        process.exit(1);
    }
    
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    const vaultContract = new ethers.Contract(VAULT_CONTRACT_ADDRESS, ENFORCER_ABI, wallet);
    const usdcContract = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, provider);

    const routerContracts = {
        QUICK: new ethers.Contract(ROUTERS.QUICK, ROUTER_ABI, provider),
        SUSHI: new ethers.Contract(ROUTERS.SUSHI, ROUTER_ABI, provider)
    };
    
    const triangularPaths = buildTriangularPaths();
    
    // Updated Trade Amounts as specified
    const capitalTiers = ["0.01", "0.10", "1", "10", "100", "1000"];

    let loopBusy = false; 
    let currentBlock = 0;

    setInterval(async () => {
        if (loopBusy) return; 
        loopBusy = true;

        try {
            const freshBlock = await provider.getBlockNumber();
            if (freshBlock > currentBlock) {
                currentBlock = freshBlock;
                console.log(`\n📦 BLOCK: #${currentBlock} | Auditing Chains via Cached Sequential Pipelines...`);

                for (let i = 0; i < triangularPaths.length; i += BATCH_SIZE) {
                    const pathChunk = triangularPaths.slice(i, i + BATCH_SIZE);
                    const scanPromises = [];

                    for (let pathObj of pathChunk) {
                        for (let routerKey of Object.keys(routerContracts)) {
                            for (let tier of capitalTiers) {
                                const testAmountIn = ethers.parseUnits(tier, 6);
                                const activeRouterContract = routerContracts[routerKey];
                                
                                scanPromises.push(
                                    getSequentialTriangularQuote(activeRouterContract, testAmountIn, pathObj.fullPath)
                                        .then(finalAmountOut => {
                                            if (!finalAmountOut) return { success: false };
                                            
                                            const isProfitable = finalAmountOut > testAmountIn;
                                            const profitDelta = isProfitable ? finalAmountOut - testAmountIn : 0n;
                                            const lossDelta = !isProfitable ? testAmountIn - finalAmountOut : 0n;
                                            
                                            return {
                                                success: true,
                                                routerKey,
                                                tier,
                                                isProfitable,
                                                displayDelta: isProfitable 
                                                    ? `+${ethers.formatUnits(profitDelta, 6)}` 
                                                    : `-${ethers.formatUnits(lossDelta, 6)}`,
                                                profitHuman: parseFloat(ethers.formatUnits(profitDelta, 6)),
                                                testAmountIn,
                                                pathObj
                                            };
                                        })
                                        .catch(() => ({ success: false }))
                                );
                            }
                        }
                    }

                    const results = await Promise.all(scanPromises);
                    let executionTriggered = false;

                    for (const res of results) {
                        if (!res.success) continue;

                        // Filter out empty outputs or near-zero data noise
                        if (res.displayDelta === "-0.000000" || res.displayDelta === "+0.000000") continue;

                        console.log(`   📡 [AUDIT] Size: $${res.tier.padEnd(6)} USDC | Router: ${res.routerKey.padEnd(5)} | Delta: ${res.displayDelta} USDC`);

                        // Updated to exactly 0.00001 floor threshold as requested
                        const minProfitFloor = 0.00001; 

                        if (res.isProfitable && res.profitHuman >= minProfitFloor && !executionTriggered) { 
                            const balanceBefore = await usdcContract.balanceOf(VAULT_CONTRACT_ADDRESS);
                            if (balanceBefore < res.testAmountIn) continue;

                            executionTriggered = true; 
                            console.log(`\n🎯 [MATCH FOUND] Profitable Sequence Confirmed: ${res.displayDelta} USDC`);
                            
                            const targetRouterAddress = ROUTERS[res.routerKey];
                            const txDeadline = Math.floor(Date.now() / 1000) + 30; 
                            
                            const tx = await vaultContract.executeArbitrage(
                                targetRouterAddress, 
                                targetRouterAddress, 
                                res.testAmountIn, 
                                res.pathObj.pathToToken, 
                                res.pathObj.pathToUSDC, 
                                txDeadline,
                                { 
                                    gasLimit: 550000,
                                    maxFeePerGas: ethers.parseUnits("250", "gwei"),       
                                    maxPriorityFeePerGas: ethers.parseUnits("40", "gwei")  
                                }
                            );
                            
                            console.log(`🚨 TX DISPATCHED: ${tx.hash}`);
                            await tx.wait(1);
                            console.log(`✅ BATCH BLOCK CONFIRMED`);
                            break; 
                        }
                    }
                    if (executionTriggered) break;
                }
            }
        } catch (globalError) {
            console.log("⚠️ RPC Pipeline drop handled cleanly. Advancing...");
        } finally {
            loopBusy = false; 
        }
    }, 500);
}

main().catch((error) => {
    console.error("Fatal Execution Fault:", error);
    process.exit(1);
});
