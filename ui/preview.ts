import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';

const status = document.getElementById('status')!;
async function start() {
  const client = new Client({ name: 'Result Store local preview', version: '0.1.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', location.href)));
  const tool = (await client.listTools()).tools.find(t => t.name === 'open_browser')!;
  const ui = tool._meta?.ui as { resourceUri?: string } | undefined;
  if (!ui?.resourceUri) throw new Error('Missing browser UI resource.');
  const resource = await client.readResource({ uri: ui.resourceUri });
  const content = resource.contents.find(c => 'text' in c);
  if (!content || !('text' in content)) throw new Error('Missing browser resource.');
  const frame = document.querySelector('iframe')!;
  const bridge = new AppBridge(client, { name: 'Result Store local preview', version: '0.1.0' }, {
    serverTools: {}, serverResources: {}, logging: {},
    updateModelContext: { text: {}, image: {} },
  }, { hostContext: { theme: 'light', displayMode: 'fullscreen', availableDisplayModes: ['inline', 'fullscreen'], locale: 'ja-JP', toolInfo: { tool } } });
  bridge.onupdatemodelcontext = async () => ({});
  bridge.oninitialized = () => void (async () => {
    await bridge.sendToolInput({ arguments: {} });
    await bridge.sendToolResult(await client.callTool({ name: 'open_browser', arguments: {} }));
    status.textContent = '';
  })().catch(error => { status.textContent = String(error); });
  await bridge.connect(new PostMessageTransport(frame.contentWindow!, frame.contentWindow!));
  frame.srcdoc = content.text;
}
void start().catch(error => { status.textContent = String(error); });
