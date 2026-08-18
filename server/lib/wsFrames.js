'use strict';

// Codec minimo de frames WebSocket (RFC 6455), sin dependencias externas.
// Lo usan tanto el servidor propio (server/lib/miniWsServer.js) como
// cualquier cliente casero que lo necesite. Soporta frames de texto,
// ping/pong/close, y mensajes fragmentados en varios frames.

const OPCODE_CONTINUATION = 0x0;
const OPCODE_TEXT = 0x1;
const OPCODE_CLOSE = 0x8;
const OPCODE_PING = 0x9;
const OPCODE_PONG = 0xa;

function encodeFrame(opcode, payload, { mask = false } = {}) {
  const payloadLength = payload.length;
  let header;

  if (payloadLength < 126) {
    header = Buffer.alloc(2);
    header[1] = payloadLength;
  } else if (payloadLength < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(payloadLength, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payloadLength), 2);
  }
  header[0] = 0x80 | opcode; // FIN=1, sin fragmentar

  if (!mask) return Buffer.concat([header, payload]);

  header[1] |= 0x80;
  const maskKey = require('crypto').randomBytes(4);
  const maskedPayload = Buffer.alloc(payloadLength);
  for (let i = 0; i < payloadLength; i++) maskedPayload[i] = payload[i] ^ maskKey[i % 4];
  return Buffer.concat([header, maskKey, maskedPayload]);
}

function encodeText(text, opts) {
  return encodeFrame(OPCODE_TEXT, Buffer.from(text, 'utf8'), opts);
}
function encodePong(payload = Buffer.alloc(0), opts) {
  return encodeFrame(OPCODE_PONG, payload, opts);
}
function encodeClose(opts) {
  return encodeFrame(OPCODE_CLOSE, Buffer.alloc(0), opts);
}

/** Acumula bytes entrantes y emite mensajes completos (uniendo frames fragmentados). */
class FrameReader {
  constructor() {
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentOpcode = null;
  }

  /** Devuelve la lista de mensajes completos { opcode, payload } que ya se pueden leer. */
  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const messages = [];
    let frame;
    while ((frame = this._readOneFrame())) {
      if (frame.opcode === OPCODE_CONTINUATION) {
        this.fragments.push(frame.payload);
        if (frame.fin) {
          messages.push({ opcode: this.fragmentOpcode, payload: Buffer.concat(this.fragments) });
          this.fragments = [];
          this.fragmentOpcode = null;
        }
      } else if (frame.fin) {
        messages.push({ opcode: frame.opcode, payload: frame.payload });
      } else {
        this.fragmentOpcode = frame.opcode;
        this.fragments.push(frame.payload);
      }
    }
    return messages;
  }

  _readOneFrame() {
    const buf = this.buffer;
    if (buf.length < 2) return null;

    const fin = (buf[0] & 0x80) !== 0;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let payloadLength = buf[1] & 0x7f;
    let offset = 2;

    if (payloadLength === 126) {
      if (buf.length < offset + 2) return null;
      payloadLength = buf.readUInt16BE(offset);
      offset += 2;
    } else if (payloadLength === 127) {
      if (buf.length < offset + 8) return null;
      payloadLength = Number(buf.readBigUInt64BE(offset));
      offset += 8;
    }

    let maskKey = null;
    if (masked) {
      if (buf.length < offset + 4) return null;
      maskKey = buf.subarray(offset, offset + 4);
      offset += 4;
    }

    if (buf.length < offset + payloadLength) return null;

    let payload = buf.subarray(offset, offset + payloadLength);
    if (masked) {
      const unmasked = Buffer.alloc(payloadLength);
      for (let i = 0; i < payloadLength; i++) unmasked[i] = payload[i] ^ maskKey[i % 4];
      payload = unmasked;
    }

    this.buffer = buf.subarray(offset + payloadLength);
    return { fin, opcode, payload };
  }
}

module.exports = {
  OPCODE_TEXT,
  OPCODE_CLOSE,
  OPCODE_PING,
  OPCODE_PONG,
  encodeText,
  encodePong,
  encodeClose,
  FrameReader,
};
