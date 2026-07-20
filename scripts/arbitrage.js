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

const MIN_TRADE_USDC = 0.02;
const SCAN_INTERVAL_MS = 10000;
const DEADLINE_SECONDS = 60;

/* FIXED */
const MAX_BATCH_SIZE = 10;

/* ✅ ADDED: minimum profit filter */
const MIN_PROFIT_USDC = 0.0002;

/* ================= PROVIDER ================= */

const provider = new ethers.JsonRpcProvider(RPC_POLYGON);
const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);

/* ================= CONTRACT ================= */

const VAULT_ADDRESS = "0xAB046582A36D00f4921C447db9b77644b5e43c95";

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

  TOKENA: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
TOKENB: "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619",
TOKENC: "0x3BA4c387f786bFEE076A58914F5Bd38d668B42c3",
TOKEND: "0x2791bca1f2de4661ed88a30c99a7a9449aa84174",
TOKENE: "0xd93f7e271cb87c23aaa73edc008a79646d1f9912",
TOKENF: "0x06d02e9d62a13fc76bb229373fb3bbbd1101d2fc",
TOKENG: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6",
TOKENH: "0xf854225caaef5a722884a68a23215dfa5386751e",
TOKENI: "0xb0897686c545045afc77cf20ec7a532e3120e0f1",
TOKENJ: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39",
TOKENK: "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063",
TOKENL: "0xe50fa9b3c56ffb159cb0fca61f5c9d750e8128c8",
TOKENM: "0xc2132d05d31c914a87c6611c10748aeb04b58e8f",
TOKENN: "0x99af3eea856556646c98c8b9b2548fe815240750",
TOKENO: "0x2C89bbc92BD86F8075d1DEcc58C7F4E0107f286b",
TOKENP: "0xada58df0f643d959c2a47c9d4d4c1a4defe3f11c",
TOKENQ: "0x2893Ef551B6dD69F661Ac00F11D93E5Dc5Dc0e99",
TOKENR: "0x6f8a06447ff6fcf75d803135a7de15ce88c1d4ec",
TOKENS: "0xb33eaad8d922b1083446dc23f610c2567fb5180f",
TOKENT: "0x553d3d295e0f695b9228246232edf400ed3560b5",
TOKENU: "0xffa4d863c96e743a2e1513824ea006b8d0353c57",
TOKENV: "0xd6df932a45c0f255f85145f286ea0b292b21c90b",
TOKENW: "0xa0769f7a8fc65e47de93797b4e21c073c117fc80",
TOKENX: "0x61299774020da444af134c82fa83e3810b309991",
TOKENY: "0x41b3966b4ff7b427969ddf5da3627d6aeae9a48e",
TOKENZ: "0x0266F4F08D82372CF0FcbCCc0Ff74309089c74d1",

TOKENAA: "0xc011a7e12a19f7b1f670d46f03b03f3342e82dfb",
TOKENAB: "0x2e1ad108ff1d8c782fcbbb89aad783ac49586756",
TOKENAC: "0x4e8dc2149eac3f3def36b1c281ea466338249371",
TOKENAD: "0x7583feddbcefa813dc18259940f76a02710a8905",
TOKENAE: "0x172370d5cd63279efa6d502dab29171933a610af",
TOKENAF: "0xc3c7d422809852031b44ab29eec9f1eff2a58756",
TOKENAG: "0x236aa50979d5f3de3bd1eeb40e81137f22ab794b",
TOKENAH: "0x5ffd62d3c3ee2e81c00a7b9079fb248e7df024a8",
TOKENAI: "0x6985884c4392d348587b19cb9eaaf157f13271cd",
TOKENAJ: "0xcb059c5573646047d6d88dddb87b745c18161d3b",
TOKENAK: "0x6abb753c1893194de4a83c6e8b4eadfc105fd5f5",
TOKENAL: "0x45c32fa6df82ead1e2ef74d17b76547eddfaff89",
TOKENAM: "0xc4Ce1D6F5D98D65eE25Cf85e9F2E9DcFEe6Cb5d6",
TOKENAN: "0xa3f751662e282e83ec3cbc387d225ca56dd63d3a",
TOKENAO: "0x00000000efe302beaa2b3e6e1b18d08d69a9012a",
TOKENAP: "0xdf7837de1f2fa4631d716cf2502f8b230f1dcc32",
TOKENAQ: "0x5fe2b58c013d7601147dcdd68c143a77499f5531",
TOKENAR: "0xf1938ce12400f9a761084e7a80d37e732a4da056",
TOKENAS: "0x8505b9d2254a7ae468c0e9dd10ccea3a837aef5c",
TOKENAT: "0xe4880249745eac5f1ed9d8f7df844792d560e750",
TOKENAU: "0x67ce67ec4fcd4aca0fcb738dd080b2a21ff69d75",
TOKENAV: "0xB7b31a6BC18e48888545CE79e83E06003bE70930",
TOKENAW: "0xb46e0ae620efd98516f49bb00263317096c114b2",
TOKENAX: "0xa1c57f48f0deb89f569dfbe6e2b7f46d33606fd4",
TOKENAY: "0x50b728d8d964fd00c2d0aad81718b71311fef68a",
TOKENAZ: "0xBbba073C31bF03b8ACf7c28EF0738DeCF3695683",

TOKENBA: "0x3cef98bb43d732e2f285ee605a8158cde967d219",
TOKENBB: "0x43eDD7f3831b08FE70B7555ddD373C8bF65a9050",
TOKENBC: "0xee327f889d5947c1dc1934bb208a1e792f953e96",
TOKENBD: "0xFCe60bBc52a5705CeC5B445501FBAf3274Dc43D0",
TOKENBE: "0xf1815bd50389c46847f0bda824ec8da914045d14",
TOKENBF: "0x80eede496655fb9047dd39d9f418d5483ed600df",
TOKENBG: "0x9c2c5fd7b07e95ee044ddeba0e97a665f142394f",
TOKENBH: "0x0b220b82f3ea3b7f6d9a1d8ab58930c064a2b5bf",
TOKENBI: "0x2f4efd3aa42e15a1ec6114547151b63ee5d39958",
TOKENBJ: "0xf50d05a1402d0adafa880d36050736f9f6ee7dee",
TOKENBK: "0x3Ec3849C33291a9eF4c5dB86De593EB4A37fDe45",
TOKENBL: "0x6d1fdbb266fcc09a16a22016369210a15bb95761",
TOKENBM: "0xda537104d6a5edd53c6fbba9a898708e465260b6",
TOKENBN: "0x3962f4a0a0051dcce0be73a7e09cef5756736712",
TOKENBO: "0x8a16d4bf8a0a716017e8d2262c4ac32927797a2f",
TOKENBP: "0x5559edb74751a0ede9dea4dc23aee72cca6be3d5",
TOKENBQ: "0x07cc1cc3628cc1615120df781ef9fc8ec2feae09",
TOKENBR: "0xA7E22972a19dd924aFeEDf3Db28033B146801081",
TOKENBS: "0x0c51f415cf478f8d08c246a6c6ee180c5dc3a012",
TOKENBT: "0xe2341718c6c0cbfa8e6686102dd8fbf4047a9e9b",
TOKENBU: "0x2c72d25530191ebd244eb6325e1892480b0e6e28",
TOKENBV: "0x7ec26842f195c852fa843bb9f6d8b583a274a157",
TOKENBW: "0xe7c3d8c9a439fede00d2600032d5db0be71c3c29",
TOKENBX: "0x4ed141110f6eeeaba9a1df36d8c26f684d2475dc",
TOKENBY: "0x6e4e624106cb12e168e6533f8ec7c82263358940",
TOKENBZ: "0xf8f9efc0db77d8881500bb06ff5d6abc3070e695",

TOKENCA: "0x236eec6359fb44cce8f97e99387aa7f8cd5cde1f",
TOKENCB: "0x4e36d8006416ea1d939a0eeae73afdaca86bd376",
TOKENCC: "0x0b3f868e0be5597d5db7feb59e1cadbb0fdda50a",
TOKENCD: "0x98965474ecbec2f532f1f780ee37b0b05f77ca55",
TOKENCE: "0xd4dd9e2f021bb459d5a5f6c24c12fe09c5d45553",
TOKENCF: "0xd2507e7b5794179380673870d88b22f94da6abe0",
TOKENCG: "0xC53fA49ba78bC02D3eB2858b456C95CB6DcB52Cf",
TOKENCH: "0x8Cf745561791A43d70F75e85FbC6e3752395C5f0",
TOKENCI: "0xe3322702bedaaed36cddab233360b939775ae5f1",
TOKENCJ: "0x7205705771547cf79201111b4bd8aaf29467b9ec",
TOKENCK: "0xb25e20de2f2ebb4cffd4d16a55c7b395e8a94762",
TOKENCL: "0x2b9e7ccdf0f4e5b24757c1e1a80e311e34cb10c7",
TOKENCM: "0xc8a94a3d3d2dabc3c1caffffdca6a7543c3e3e65",
TOKENCN: "0x0621d647cecbfb64b79e44302c1933cb4f27054d",
TOKENCO: "0xe78649874bcdb7a9d1666e665f340723a0187482",
TOKENCP: "0x101a023270368c0d50bffb62780f4afd4ea79c35",
TOKENCQ: "0xff7f8f301f7a706e3cfd3d2275f5dc0b9ee8009b",
TOKENCR: "0x3066818837c5e6ed6601bd5a91b0762877a6b731",
TOKENCS: "0x6f3b3286fd86d8b47ec737ceb3d0d354cc657b3e",
TOKENCT: "0x779b299ea455d35a44fe9bac48648be22c08dea2",
TOKENCU: "0xe0339c80ffde91f3e20494df88d4206d86024cdf",
TOKENCV: "0x692597b009d13c4049a947cab2239b7d6517875f",
TOKENCW: "0x71c7656ec7ab88b098defb751b7401b5f6d8976f",
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

    return amounts.at(-1);

  } catch {

    return null;

  }

}

/* ================= FIND ARBITRAGE ================= */

async function findProfitableTrade(buyRouter, sellRouter, tokenAddr) {

  const usdc = TOKENS.USDC;
  const amountIn = ethers.parseUnits(MIN_TRADE_USDC.toString(), 6);

  let bestBuyOut;
  let bestBuyPath;

  for (const p of [
    [usdc, tokenAddr],
    [usdc, TOKENS.WMATIC, tokenAddr],
    [usdc, TOKENS.WETH, tokenAddr],
    [usdc, TOKENS.USDT, tokenAddr],
    [usdc, TOKENS.DAI, tokenAddr]
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
    [tokenAddr, usdc],
    [tokenAddr, TOKENS.WMATIC, usdc],
    [tokenAddr, TOKENS.WETH, usdc],
    [tokenAddr, TOKENS.USDT, usdc],
    [tokenAddr, TOKENS.DAI, usdc]
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

  /* ✅ ADDED: filter by min profit */
  if (profit < MIN_PROFIT_USDC) return null;

  console.log(
    `${GREEN}PROFIT FOUND ${profit.toFixed(6)}${RESET} | TOKEN ${tokenAddr}`
  );

  return {
    buyRouter,
    sellRouter,
    amountIn,
    bestBuyPath,
    bestSellPath,
    profit // ✅ ADDED
  };

}

/* ================= BATCH EXECUTION ================= */

async function batchArb() {

  await logBalances();

  const profitableTrades = [];

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

      if (trade) {

        profitableTrades.push(trade);

        if (profitableTrades.length >= MAX_BATCH_SIZE)
          break;

      }

    }

    /* ✅ ADDED: total profit calculation */
    const totalProfit = profitableTrades.reduce(
      (sum, t) => sum + (t.profit || 0),
      0
    );

    console.log(
      `${CYAN}Total expected profit:${RESET} ${totalProfit.toFixed(6)} USDC`
    );

    console.log(
      `${YELLOW}Collected ${profitableTrades.length} profitable trades so far${RESET}`
    );

  }

  console.log(
    `${CYAN}Executing batch arbitrage${RESET}`
  );

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

  while (true) {

    await batchArb();

    await sleep(SCAN_INTERVAL_MS);

  }

}

main().catch(console.error);
