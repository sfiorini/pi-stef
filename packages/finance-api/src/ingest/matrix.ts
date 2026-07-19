import type { AdapterRegistry } from "./registry";
import { createFileAdapter } from "./file";
import { createCoinbaseAdapter } from "./direct/coinbase";
import { createSnaptradeAdapter } from "./aggregator/snaptrade";
import { createSimplefinAdapter } from "./aggregator/simplefin";
import { createTellerAdapter } from "./aggregator/teller";

export function buildDefaultRegistry(): AdapterRegistry {
  return new Map([
    ["fidelity", createFileAdapter("fidelity", "brokerage")],
    ["boa", createFileAdapter("boa", "banking")],
    ["coinbase", createCoinbaseAdapter()],
    ["snaptrade", createSnaptradeAdapter()],
    ["simplefin", createSimplefinAdapter()],
    ["boa-teller", createTellerAdapter()],
  ]);
}
