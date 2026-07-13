import fs from 'node:fs';
import path from 'node:path';

function readDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return {};
  return Object.fromEntries(
    fs.readFileSync(filePath, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#') && line.includes('='))
      .map((line) => {
        const index = line.indexOf('=');
        return [line.slice(0, index), line.slice(index + 1)];
      })
  );
}

const backendEnv = readDotEnv(path.resolve('.env'));
const fiberEnv = readDotEnv(path.resolve('infra/fiber-node/.env'));

function env(name, fallback = '') {
  return process.env[name] ?? backendEnv[name] ?? fiberEnv[name] ?? fallback;
}

const rpcUrl = env('FIBER_RPC_URL', 'http://127.0.0.1:8227');
const apiKey = env('FIBER_API_KEY') || env('FIBER_RPC_PROXY_TOKEN');

const response = await fetch(rpcUrl, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    ...(apiKey ? { Authorization: 'Bearer ' + apiKey } : {})
  },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'node_info', params: [] })
});

const payload = await response.json().catch(() => null);
if (!response.ok || payload?.error) {
  console.error(JSON.stringify({ ok: false, rpcUrl, status: response.status, error: payload?.error ?? payload }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({ ok: true, rpcUrl, result: payload?.result ?? payload }, null, 2));
