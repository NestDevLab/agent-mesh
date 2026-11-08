import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const [CONTINUATION, TEXT, CLOSE, PING, PONG] = [0, 1, 8, 9, 10];

function codexSocket() {
  if (process.env.CODEX_NO_REMOTE === "1") throw new Error("CODEX_NO_REMOTE disables app-server calls");
  if (process.env.CODEX_REMOTE_SOCK !== undefined) {
    if (!process.env.CODEX_REMOTE_SOCK) throw new Error("CODEX_REMOTE_SOCK is empty; no app-server selected");
    return process.env.CODEX_REMOTE_SOCK;
  }
  const listening = spawnSync("ss", ["-lx"], { encoding: "utf8", timeout: 5000 });
  const home = process.env.CODEX_HOME || join(homedir(), ".codex");
  for (const name of ["desktop-ssh-websocket-v0.sock", "app-server-control.sock"]) {
    const path = join(home, "app-server-control", name);
    // control socket can be a symlink, ss lists only the target
    let target;
    try { target = realpathSync(path); } catch { continue; }
    if (listening.status === 0 && listening.stdout.includes(` ${target} `)) return path;
  }
  throw new Error("no listening Codex app-server socket found; set CODEX_REMOTE_SOCK");
}

function maskedFrame(opcode, payload) {
  const size = payload.length;
  let head;
  if (size < 126) head = Buffer.from([0x80 | opcode, 0x80 | size]);
  else if (size < 65536) {
    head = Buffer.alloc(4);
    head.writeUInt16BE(size, 2);
    head[1] = 0x80 | 126;
  } else {
    head = Buffer.alloc(10);
    head.writeBigUInt64BE(BigInt(size), 2);
    head[1] = 0x80 | 127;
  }
  head[0] = 0x80 | opcode;
  const mask = randomBytes(4);
  const body = Buffer.from(payload);
  for (let i = 0; i < body.length; i += 1) body[i] ^= mask[i % 4];
  return Buffer.concat([head, mask, body]);
}

function readFrame(buffer) {
  if (buffer.length < 2) return { needed: 2 };
  let size = buffer[1] & 0x7f;
  let offset = 2;
  if (size === 126) {
    if (buffer.length < 4) return { needed: 4 };
    size = buffer.readUInt16BE(2);
    offset = 4;
  } else if (size === 127) {
    if (buffer.length < 10) return { needed: 10 };
    size = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }
  if (buffer[1] & 0x80) throw new Error("masked WebSocket frame from app-server");
  if (buffer.length < offset + size) return { needed: offset + size };
  return { fin: Boolean(buffer[0] & 0x80), opcode: buffer[0] & 0x0f, payload: buffer.subarray(offset, offset + size), end: offset + size };
}

export async function withCodexAppServer({ clientName, timeout, timeoutMessage }, work) {
  const path = codexSocket();
  const key = randomBytes(16).toString("base64");
  const accept = createHash("sha1").update(key + WS_GUID).digest("base64");
  const socket = connect(path);
  const pending = new Map();
  let nextId = 0;
  let failure;
  let upgraded = false;
  let chunks = [];
  let buffered = 0;
  let needed = 0;
  let message = [];
  const rejectAll = (error) => {
    failure ||= error;
    for (const { reject } of pending.values()) reject(failure);
    pending.clear();
  };
  const handleMessage = (text) => {
    let parsed;
    try { parsed = JSON.parse(text); }
    catch { rejectAll(new Error("invalid JSON from app-server")); return; }
    if (parsed.method) return;
    const waiter = pending.get(parsed.id);
    if (!waiter) return;
    pending.delete(parsed.id);
    if (parsed.error) waiter.reject(new Error(`app-server: ${parsed.error.message || JSON.stringify(parsed.error)}`));
    else if (Object.hasOwn(parsed, "result")) waiter.resolve(parsed.result);
    else waiter.reject(new Error("invalid app-server response"));
  };
  const handleFrame = ({ fin, opcode, payload }) => {
    if (opcode === PING) socket.write(maskedFrame(PONG, payload));
    else if (opcode === CLOSE) rejectAll(new Error("app-server closed the WebSocket"));
    else if (opcode === TEXT || opcode === CONTINUATION) {
      message.push(Buffer.from(payload));
      if (fin) {
        const text = Buffer.concat(message).toString("utf8");
        message = [];
        handleMessage(text);
      }
    }
  };
  const drain = () => {
    if (buffered < needed) return;
    let buffer = Buffer.concat(chunks, buffered);
    if (!upgraded) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) { chunks = [buffer]; return; }
      const header = buffer.subarray(0, headerEnd).toString("latin1");
      if (!/^HTTP\/1\.1 101\b/.test(header) || !header.includes(accept)) {
        throw new Error(`app-server refused the WebSocket upgrade: ${header.split("\r\n")[0]}`);
      }
      upgraded = true;
      buffer = buffer.subarray(headerEnd + 4);
      const opened = pending.get("open");
      pending.delete("open");
      opened.resolve();
    }
    for (;;) {
      const frame = readFrame(buffer);
      if (frame.needed) { needed = frame.needed; break; }
      handleFrame(frame);
      buffer = buffer.subarray(frame.end);
    }
    chunks = [buffer];
    buffered = buffer.length;
  };
  socket.on("connect", () => {
    socket.write(`GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  });
  socket.on("data", (data) => {
    chunks.push(data);
    buffered += data.length;
    try { drain(); }
    catch (error) { rejectAll(error); socket.destroy(); }
  });
  socket.on("error", rejectAll);
  socket.on("close", () => rejectAll(new Error("app-server connection closed")));
  const timer = setTimeout(() => {
    rejectAll(Object.assign(new Error(timeoutMessage), { exitCode: 124 }));
    socket.destroy();
  }, timeout);
  const sendText = (value) => socket.write(maskedFrame(TEXT, Buffer.from(JSON.stringify(value))));
  const request = (method, params) => new Promise((resolve, reject) => {
    if (failure) return reject(failure);
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    sendText({ id, method, params });
  });
  try {
    await new Promise((resolve, reject) => {
      if (failure) return reject(failure);
      pending.set("open", { resolve, reject });
    });
    await request("initialize", {
      clientInfo: { name: clientName, version: "1.0.0" },
      capabilities: { experimentalApi: true },
    });
    sendText({ method: "initialized" });
    return await work(request);
  } finally {
    clearTimeout(timer);
    socket.destroy();
  }
}
