import { createHash } from "node:crypto";
import { createServer } from "node:net";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function frame(opcode, payload, fin = true) {
  const first = (fin ? 0x80 : 0) | opcode;
  const size = payload.length;
  if (size < 126) return Buffer.concat([Buffer.from([first, size]), payload]);
  const head = Buffer.alloc(size < 65536 ? 4 : 10);
  head[0] = first;
  if (size < 65536) {
    head[1] = 126;
    head.writeUInt16BE(size, 2);
  } else {
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(size), 2);
  }
  return Buffer.concat([head, payload]);
}

export function createAppServer(onMessage, onPong = () => {}) {
  return createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let upgraded = false;
    const peer = {
      send: (message) => socket.write(frame(1, Buffer.from(JSON.stringify(message)))),
      sendFragmented: (message) => {
        const body = Buffer.from(JSON.stringify(message));
        const middle = Math.floor(body.length / 2);
        socket.write(frame(1, body.subarray(0, middle), false));
        socket.write(frame(0, body.subarray(middle)));
      },
      ping: (text) => socket.write(frame(9, Buffer.from(text))),
    };
    socket.on("error", () => {});
    socket.on("data", (data) => {
      buffer = Buffer.concat([buffer, data]);
      if (!upgraded) {
        const end = buffer.indexOf("\r\n\r\n");
        if (end < 0) return;
        const key = /sec-websocket-key: (.+)/i.exec(buffer.subarray(0, end).toString())[1].trim();
        const accept = createHash("sha1").update(key + GUID).digest("base64");
        socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
        buffer = buffer.subarray(end + 4);
        upgraded = true;
      }
      while (buffer.length >= 2) {
        let size = buffer[1] & 0x7f;
        let offset = 2;
        if (size === 126) { size = buffer.readUInt16BE(2); offset = 4; }
        else if (size === 127) { size = Number(buffer.readBigUInt64BE(2)); offset = 10; }
        if (buffer.length < offset + 4 + size) return;
        const mask = buffer.subarray(offset, offset + 4);
        const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + size));
        for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
        const opcode = buffer[0] & 0x0f;
        buffer = buffer.subarray(offset + 4 + size);
        if (opcode === 1) onMessage(JSON.parse(payload.toString()), peer);
        if (opcode === 10) onPong(payload.toString());
      }
    });
  });
}
