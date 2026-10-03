// A real stdio MCP server using newline-framed JSON-RPC. All data are synthetic.
import { createInterface } from 'node:readline';
import { catalog, executeTool, makeOrders } from './fixtures.mjs';
const count = Number(process.argv[2] || 12);
const size = Number(process.argv[3] || 18);
const delay = Number(process.argv[4] || 25);
const tools = catalog(size);
const orders = makeOrders(count);
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const input = createInterface({ input: process.stdin });
input.on('close', () => process.exit(0));
input.on('line', async line => {
  let request;
  try {
    request = JSON.parse(line);
    if (request.id === undefined) return;
    let result;
    if (request.method === 'initialize') result = { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'order-demo', version: '1.0.0' }, instructions: 'Synthetic order service. All tools are read-only. Payment and shipment data can be checked by order ID.' };
    else if (request.method === 'ping') result = {};
    else if (request.method === 'tools/list') result = { tools };
    else if (request.method === 'tools/call') {
      const { name, arguments: args = {} } = request.params;
      if (!tools.some(t => t.name === name)) throw new Error('Unknown tool');
      await new Promise(resolve => setTimeout(resolve, delay));
      const value = executeTool(name, args, orders);
      result = { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: false };
    } else { send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } }); return; }
    send({ jsonrpc: '2.0', id: request.id, result });
  } catch (error) {
    if (request?.method === 'tools/call') send({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: error.message }], isError: true } });
    else if (request?.id !== undefined) send({ jsonrpc: '2.0', id: request.id, error: { code: -32602, message: error.message } });
  }
});
