import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';

const status = document.getElementById('status')!;
async function start() {
  const client = new Client({ name: 'Result Store local preview', version: '0.1.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', location.href)));
  const tool = (await client.listTools()).tools.find(t => t.name === 'list_schemes')!;
  const resource = await client.readResource({ uri: 'ui://result-store/browser.html' });
  const content = resource.contents.find(c => 'text' in c);
  if (!content || !('text' in content)) throw new Error('Missing browser resource.');
  const frame = document.querySelector('iframe')!;
  const bridge = new AppBridge(client, { name: 'Result Store local preview', version: '0.1.0' }, {
    serverTools: {}, serverResources: {}, logging: {},
    message: { text: {} }, updateModelContext: { text: {}, image: {} },
  }, { hostContext: { theme: 'light', displayMode: 'fullscreen', availableDisplayModes: ['inline', 'fullscreen'], locale: 'ja-JP', toolInfo: { tool } } });
  bridge.onmessage = async params => {
    (document.getElementById('draft') as HTMLTextAreaElement).value = params.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
    return {};
  };
  bridge.onupdatemodelcontext = async params => {
    const selection = params.structuredContent?.selection as { scheme: string; row_id: string; plot_name: string } | undefined;
    document.getElementById('context')!.textContent = selection ? `${selection.scheme}\nRowId ${selection.row_id}\n${selection.plot_name}\nPNG画像: ${params.content?.some(c => c.type === 'image') ? 'あり' : 'なし'}` : '未選択';
    return {};
  };
  bridge.oninitialized = () => void (async () => {
    await bridge.sendToolInput({ arguments: {} });
    await bridge.sendToolResult(await client.callTool({ name: 'list_schemes', arguments: {} }));
    status.textContent = 'MCPサーバーに接続済み';
  })().catch(error => { status.textContent = String(error); });
  await bridge.connect(new PostMessageTransport(frame.contentWindow!, frame.contentWindow!));
  frame.srcdoc = content.text;
}
void start().catch(error => { status.textContent = String(error); });
