import { ethers } from "ethers";
import dotenv from "dotenv";
import WebSocket from "ws";

dotenv.config();

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

// ==========================================
// 1. HIGH-AVAILABILITY WSS ENDPOINTS TIER
// ==========================================
const WSS_ENDPOINTS = [
    "wss://polygon.drpc.org",
    "wss://polygon-bor-rpc.publicnode.com",
    "wss://polygon.api.onfinality.io/public-ws",
    "wss://rpc-mainnet.matic.quiknode.pro"
];
let currentEndpointIndex = 0;

const VAULT_CONTRACT_ADDRESS = "0xB1a557c33FF23F3C0Ffa2A9251630197b037F4cc";
const USDC_ADDRESS  = "0x2791bca1f2de4661ed88a30c99a7a9449aa84174";

const ROUTERS = {
    QUICK: "0xa5e0829caced8ffdd4de3c43696c57f7d7a678ff",
    SUSHI: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506"
};

// Target matrix tokens requested for expanded hop coverage
const TOKENS = {
    USDT:   "0xc2132d05d31c914a87c6611c10748aeb04b58e8f",
    WETH:   "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619",
    WMATIC: "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270",
    DAI:    "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063",
    WBTC:   "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6"
