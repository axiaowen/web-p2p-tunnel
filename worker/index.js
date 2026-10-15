// web-p2p-tunnel signaling server port, based on internal/signaling/*.go.
// One SQLite-backed Durable Object per room, WebSocket Hibernation API.
const text = (body, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
const isUUID = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/rooms') {
      if (request.method !== 'POST') return text('Not Found\n', 404);
      const roomID = crypto.randomUUID();
      const room = env.ROOMS.getByName(roomID);
      const created = await room.fetch('https://room.internal/create', { method: 'POST' });
      if (!created.ok) return text('Internal Server Error\n', 500);
      // Go implementation responds with a raw UUID, not JSON.
      return text(roomID);
    }
    if (url.pathname === '/ws') {
      const role = url.searchParams.get('role');
      const roomID = url.searchParams.get('room-id');
      if ((role !== 'server' && role !== 'client') || !roomID) return text('Bad Request\n', 400);
      if (!isUUID(roomID)) return text('Not Found\n', 404);
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return text('Bad Request\n', 400);
      return env.ROOMS.getByName(roomID).fetch(request);
    }
    return text('Not Found\n', 404);
  }
};

export class SignalingRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  connections() {
    return this.state.getWebSockets().map(ws => ({ ws, meta: ws.deserializeAttachment() || {} }));
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/create') {
      if (request.method !== 'POST') return text('Not Found\n', 404);
      await this.state.storage.put('created', true);
      return text('OK');
    }
    if (url.pathname !== '/ws') return text('Not Found\n', 404);
    if (!(await this.state.storage.get('created'))) return text('Not Found\n', 404);
    const role = url.searchParams.get('role');
    if (role !== 'client' && role !== 'server') return text('Bad Request\n', 400);
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return text('Bad Request\n', 400);
    const existing = this.connections();
    if (role === 'server' && existing.some(c => c.meta.role === 'server')) {
      // Original Go server accepts the upgrade, sends an error and closes.
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.accept();
      server.send(JSON.stringify({ type: 'error', data: 'server conn already exists' }));
      server.close(1000, 'server conn already exists');
      return new Response(null, { status: 101, webSocket: client });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const clientID = role === 'client' ? crypto.randomUUID() : null;
    server.serializeAttachment({ role, clientID });
    this.state.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws, raw) {
    if (typeof raw !== 'string') { ws.close(1003, 'text JSON only'); return; }
    let msg;
    try { msg = JSON.parse(raw); } catch { ws.close(1007, 'invalid JSON'); return; }
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;
    const source = ws.deserializeAttachment() || {};
    const conns = this.connections();
    if (source.role === 'client') {
      const server = conns.find(c => c.meta.role === 'server');
      // Go closes client connection when no server is connected.
      if (!server) { ws.close(1000, 'no server'); return; }
      server.ws.send(JSON.stringify({ type: msg.type, data: msg.data ?? null, clientID: source.clientID }));
    } else if (source.role === 'server') {
      const dest = conns.find(c => c.meta.role === 'client' && c.meta.clientID === msg.clientID);
      // Go closes server connection when target client is unknown.
      if (!dest) { ws.close(1000, 'unknown client'); return; }
      dest.ws.send(JSON.stringify({ type: msg.type, data: msg.data ?? null }));
    }
  }

  webSocketClose() {}
  webSocketError(ws) { try { ws.close(1011, 'websocket error'); } catch {} }
}
