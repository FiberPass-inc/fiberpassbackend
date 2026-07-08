import { env } from '../config/env.js';
import { RpcFiberProvider } from '../services/fiberProvider.js';

export async function runFiberNetworkRpcSpike(): Promise<void> {
  if (!env.FIBER_RPC_URL) {
    throw new Error('Set FIBER_RPC_URL before running the Fiber Network RPC spike.');
  }

  const provider = new RpcFiberProvider({ rpcUrl: env.FIBER_RPC_URL, network: env.FIBER_NETWORK });
  const status = await provider.getStatus('spike-local-session');
  console.log(JSON.stringify({ ok: true, status }, null, 2));
}

if (process.argv[1]?.endsWith('fiberNetworkRpcSpike.ts')) {
  runFiberNetworkRpcSpike().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
