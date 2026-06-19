import { ethers } from "ethers";
import dotenv from "dotenv";

dotenv.config();

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

// ==========================================
// 1. HIGH-AVAILABILITY WSS ENDPOINTS TIER
// ==========================================
const WSS_ENDPOINTS = [
    "wss://polygon-bor-rpc.publicnode.com", 
    "wss://polygon.drpc.org",
    "wss://polygon.gateway.tenderly.co"
];
let currentEndpointIndex = 0;

const VAULT_CONTRACT_ADDRESS = "0xB1a557c3
