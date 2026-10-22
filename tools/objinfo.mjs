import fs from 'fs';
const rom = fs.readFileSync(process.argv[2]);
const names = fs.readFileSync('/home/agent/s3ref/Object pointers - S3 Set.asm', 'utf8').split('\n').filter(l => l.includes('dc.l')).map(l => l.match(/dc.l\s+(\S+)/)[1]);
const r16 = a => rom.readUInt16BE(a), r32 = a => rom.readUInt32BE(a);
for (const id of process.argv.slice(3).map(Number)) {
  const code = r32(0x5cc96 + id * 4);
  const found = [];
  for (let a = code; a < code + 0x300; a += 2) {
    if (r16(a) === 0x217c && r16(a + 6) === 0x000c) found.push('map=' + r32(a + 2).toString(16));
    if (r16(a) === 0x317c && r16(a + 4) === 0x000a) found.push('art=' + r16(a + 2).toString(16));
    if (r16(a) === 0x237c && r16(a + 6) === 0x000c) found.push('a1map=' + r32(a + 2).toString(16));
  }
  console.log(id, names[id], code.toString(16), found.slice(0, 8).join(' '));
}
