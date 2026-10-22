// Decompressors for the formats used by Sonic 3 (reverse engineered from
// Kos_Decomp, Process_Kos_Module_Queue and Nem_Decomp in the original ROM).

// Kosinski: LZ77 variant with a 16-bit little-endian description field read LSB first.
// Returns { data, end } where end is the ROM offset just past the compressed stream.
export function kosinski(src, start) {
  let pos = start;
  const out = [];
  let field = src[pos] | (src[pos + 1] << 8);
  pos += 2;
  let bits = 16;
  const getBit = () => {
    const b = field & 1;
    field >>>= 1;
    if (--bits === 0) {
      field = src[pos] | (src[pos + 1] << 8);
      pos += 2;
      bits = 16;
    }
    return b;
  };
  for (;;) {
    if (getBit()) {
      out.push(src[pos++]);
      continue;
    }
    let count, offset;
    if (getBit()) {
      const lo = src[pos++];
      const hi = src[pos++];
      offset = (((hi & 0xf8) << 5) | lo) - 0x2000;
      count = hi & 7;
      if (count === 0) {
        count = src[pos++];
        if (count === 0) break; // end of stream
        if (count === 1) continue; // dummy
        count += 1;
      } else {
        count += 2;
      }
    } else {
      count = ((getBit() << 1) | getBit()) + 2;
      offset = src[pos++] - 0x100;
    }
    const from = out.length + offset;
    for (let i = 0; i < count; i++) out.push(out[from + i]);
  }
  return { data: Uint8Array.from(out), end: pos };
}

// Kosinski Moduled: header word = uncompressed size, followed by $1000 byte
// modules. Each module after the first starts on a 16-byte boundary relative
// to the start of the previous module.
export function kosinskiModuled(src, start) {
  let size = (src[start] << 8) | src[start + 1];
  if (size === 0xa000) size = 0x8000;
  const out = new Uint8Array(size);
  let pos = start + 2;
  let written = 0;
  while (written < size) {
    const { data, end } = kosinski(src, pos);
    out.set(data.subarray(0, Math.min(data.length, size - written)), written);
    written += data.length;
    pos = end + ((pos - end) & 0xf);
  }
  return out;
}

// Nemesis: Huffman-coded nybble runs, optionally XOR-delta encoded per row.
export function nemesis(src, start) {
  let pos = start;
  const header = (src[pos] << 8) | src[pos + 1];
  pos += 2;
  const xorMode = (header & 0x8000) !== 0;
  const tiles = header & 0x7fff;
  const codes = new Map(); // key: (len << 8) | code
  let nyb = 0;
  let b = src[pos++];
  while (b !== 0xff) {
    if (b & 0x80) {
      nyb = b & 0xf;
      b = src[pos++];
    }
    const rep = ((b >> 4) & 7) + 1;
    const len = b & 0xf;
    const code = src[pos++];
    codes.set((len << 8) | code, { nyb, rep });
    b = src[pos++];
  }
  // Bit reader, MSB first.
  let cur = 0, curBits = 0;
  const getBit = () => {
    if (curBits === 0) {
      cur = src[pos++];
      curBits = 8;
    }
    curBits--;
    return (cur >> curBits) & 1;
  };
  const getBits = (n) => {
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 1) | getBit();
    return v;
  };
  const total = tiles * 64; // nybbles
  const nybbles = new Uint8Array(total);
  let n = 0;
  while (n < total) {
    let code = 0, len = 0, entry = null;
    for (;;) {
      code = (code << 1) | getBit();
      len++;
      if (len === 6 && code === 0x3f) {
        entry = { rep: getBits(3) + 1, nyb: getBits(4) };
        break;
      }
      const e = codes.get((len << 8) | code);
      if (e) { entry = e; break; }
      if (len > 8) throw new Error('Nemesis: bad code at ' + pos.toString(16));
    }
    for (let i = 0; i < entry.rep && n < total; i++) nybbles[n++] = entry.nyb;
  }
  const out = new Uint8Array(tiles * 32);
  let prevRow = 0;
  for (let row = 0; row < tiles * 8; row++) {
    let v = 0;
    for (let i = 0; i < 8; i++) v = (v << 4) | nybbles[row * 8 + i];
    v >>>= 0;
    if (xorMode) { v = (v ^ prevRow) >>> 0; prevRow = v; }
    out[row * 4] = v >>> 24;
    out[row * 4 + 1] = (v >>> 16) & 0xff;
    out[row * 4 + 2] = (v >>> 8) & 0xff;
    out[row * 4 + 3] = v & 0xff;
  }
  return out;
}
