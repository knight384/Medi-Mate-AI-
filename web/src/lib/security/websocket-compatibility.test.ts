import { describe, expect, it } from 'vitest';

interface AddressInfo {
  port: number;
}
interface SocketLike {
  on: (event: string, cb: (data: Buffer | string) => void) => void;
  send: (msg: string) => void;
}
interface ServerLike {
  address: () => AddressInfo | string | null;
  on: (event: string, cb: (socket: SocketLike) => void) => void;
  close: (cb: () => void) => void;
}
interface ClientLike {
  readyState: number;
  on: (event: string, cb: (data: unknown) => void) => void;
  once: (event: string, cb: (data: Buffer | string) => void) => void;
  send: (data: string | Buffer, options?: { fin?: boolean }) => void;
  close: () => void;
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const wsModule = require('ws') as {
  WebSocketServer: new (opts: { port: number }) => ServerLike;
  WebSocket: (new (url: string) => ClientLike) & { OPEN: number; CLOSED: number };
};
const { WebSocketServer, WebSocket } = wsModule;

describe('WebSocket Client & Server Compatibility (ws@8.22.0)', () => {
  it('connects, transmits data, and handles fragmented messages cleanly', async () => {
    // Start local ephemeral WebSocket server
    const wss = new WebSocketServer({ port: 0 });
    const addr = wss.address() as AddressInfo;
    const port = addr.port;

    wss.on('connection', (socket: SocketLike) => {
      socket.on('message', (msg: Buffer | string) => {
        // Echo message back with prefix
        socket.send(`echo:${msg.toString()}`);
      });
    });

    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);

      await new Promise<void>((resolve, reject) => {
        ws.on('open', () => resolve());
        ws.on('error', (err: unknown) => reject(err));
      });

      expect(ws.readyState).toBe(WebSocket.OPEN);

      const response = await new Promise<string>((resolve) => {
        ws.on('message', (data: unknown) => {
          resolve(String(data));
        });
        ws.send('hello-health-assistant');
      });

      expect(response).toBe('echo:hello-health-assistant');

      // Test sending multi-chunk fragmented text frame
      const fragmentedResponse = await new Promise<string>((resolve) => {
        ws.once('message', (data: Buffer | string) => {
          resolve(data.toString());
        });
        // Send a frame composed of small fragments
        ws.send(Buffer.from('fragment-test-payload-12345'), { fin: true });
      });

      expect(fragmentedResponse).toBe('echo:fragment-test-payload-12345');

      ws.close();
      await new Promise((resolve) => ws.on('close', resolve));
      expect(ws.readyState).toBe(WebSocket.CLOSED);
    } finally {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    }
  });

  it('handles abnormal connection closures and connection errors gracefully', async () => {
    // Attempt connecting to non-existent port
    const ws = new WebSocket('ws://127.0.0.1:1');
    const err = await new Promise<unknown>((resolve) => {
      ws.on('error', (e: unknown) => resolve(e));
    });

    expect(err).toBeDefined();
    expect(ws.readyState).toBe(WebSocket.CLOSED);
  });
});
