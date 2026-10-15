import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const object = properties => ({ type: 'object', properties });
const tabId = { type: 'integer', description: 'Chrome tab ID from tabs_list' };
const string = description => ({ type: 'string', description });
const definitions = [
  ['browsers.list', 'List connected browsers', object({})],
  ['recording.start', 'Start recording a browser tab to a local video file', object({ tabId, path: string('Output path on the bridge machine'), fps: { type: 'number', minimum: 1, maximum: 60 } })],
  ['recording.stop', 'Stop a recording and finalize its video file', object({ id: string('Recording ID') })],
  ['recording.list', 'List recordings', object({})],
  ['browser.info', 'Show the connected browser identity and nickname', object({})],
  ['browser.rename', 'Persist a nickname for the connected browser', object({ name: string('Browser nickname') })],
  ['tabs.list', 'List open browser tabs', object({})],
  ['tabs.create', 'Create a browser tab', object({ url: string('URL to open'), active: { type: 'boolean' } })],
  ['tabs.close', 'Close a browser tab', object({ tabId })],
  ['tabs.navigate', 'Navigate an existing tab', object({ tabId, url: string('Destination URL') })],
  ['page.snapshot', 'Read page text and interactive elements', object({ tabId, maxLength: { type: 'integer' } })],
  ['page.click', 'Click an element by CSS selector or viewport coordinates', object({ tabId, selector: string('CSS selector'), x: { type: 'number' }, y: { type: 'number' } })],
  ['page.type', 'Enter text into an element or current focus', object({ tabId, selector: string('CSS selector'), text: string('Text to enter'), clear: { type: 'boolean', default: true } })],
  ['page.key', 'Press a keyboard key', object({ tabId, key: string('Key name, e.g. Enter'), code: string('Physical key code'), modifiers: { type: 'integer', description: 'CDP modifier bits: Alt=1, Control=2, Meta=4, Shift=8' } })],
  ['page.scroll', 'Scroll the page', object({ tabId, x: { type: 'number' }, y: { type: 'number' } })],
  ['page.evaluate', 'Evaluate JavaScript in a tab', object({ tabId, expression: string('JavaScript expression') })],
  ['page.screenshot', 'Capture an image of a tab', object({ tabId, format: { type: 'string', enum: ['png', 'jpeg'] }, quality: { type: 'integer', minimum: 0, maximum: 100 }, fullPage: { type: 'boolean' } })],
  ['cdp.send', 'Send a Chrome DevTools Protocol command', object({ tabId, method: string('CDP method, e.g. Runtime.evaluate'), params: { type: 'object', additionalProperties: true } })]
];
for (const [method, , schema] of definitions) {
  schema.properties.browser = string('Optional browser nickname or ID to select');
  const required = ['tabs.list', 'tabs.create', 'browser.info', 'browser.rename', 'browsers.list', 'recording.list', 'recording.stop'].includes(method) ? [] : ['tabId'];
  if (method === 'recording.stop') required.push('id');
  if (method === 'browser.rename') required.push('name');
  if (method === 'tabs.navigate') required.push('url');
  if (method === 'page.type') required.push('text');
  if (method === 'page.key') required.push('key');
  if (method === 'page.evaluate') required.push('expression');
  if (method === 'cdp.send') required.push('method');
  schema.required = required;
  if (method === 'page.click') schema.anyOf = [{ required: ['selector'] }, { required: ['x', 'y'] }];
}

export async function startMcp(client) {
  const server = new Server({ name: 'agent-browser-bridge', version: '0.1.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: definitions.map(([method, description, inputSchema]) => ({ name: method.replaceAll('.', '_'), description, inputSchema }))
  }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    const definition = definitions.find(([method]) => method.replaceAll('.', '_') === params.name);
    if (!definition) return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${params.name}` }] };
    try {
      const { browser, ...args } = params.arguments || {};
      const result = await client.call(definition[0], args, { browser });
      if (definition[0] === 'page.screenshot') {
        const dataUrl = typeof result === 'string' ? result : result?.dataUrl;
        const match = dataUrl?.match(/^data:(image\/[\w.+-]+);base64,([\s\S]+)$/);
        if (match) return { content: [{ type: 'image', mimeType: match[1], data: match[2] }] };
        if (result?.data) return { content: [{ type: 'image', mimeType: result.mimeType || (params.arguments?.format === 'jpeg' ? 'image/jpeg' : 'image/png'), data: result.data }] };
      }
      return { content: [{ type: 'text', text: JSON.stringify(result ?? null) }] };
    } catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
  });
  await server.connect(new StdioServerTransport());
  return server;
}
