/** A ZIP with stored (uncompressed) entries: preserves exact JSON bytes and
 * bundles public correction context without changing the report wire schema. */
export function reportExportBundle(reportJson: string, correctionsJson: string): Uint8Array {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const directory: Uint8Array[] = [];
  let offset = 0;
  for (const [filename, content] of [["report.json", reportJson], ["corrections.json", correctionsJson]]) {
    const name = encoder.encode(filename);
    const data = encoder.encode(content);
    let crc = 0xffffffff;
    for (const byte of data) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const header = new Uint8Array(30 + name.length);
    const view = new DataView(header.buffer);
    view.setUint32(0, 0x04034b50, true); view.setUint16(4, 20, true);
    view.setUint16(12, 33, true); // 1980-01-01; reproducible ZIP metadata.
    view.setUint32(14, crc, true); view.setUint32(18, data.length, true);
    view.setUint32(22, data.length, true); view.setUint16(26, name.length, true);
    header.set(name, 30);
    const central = new Uint8Array(46 + name.length);
    const entry = new DataView(central.buffer);
    entry.setUint32(0, 0x02014b50, true); entry.setUint16(4, 20, true); entry.setUint16(6, 20, true);
    entry.setUint16(14, 33, true); entry.setUint32(16, crc, true);
    entry.setUint32(20, data.length, true); entry.setUint32(24, data.length, true);
    entry.setUint16(28, name.length, true); entry.setUint32(42, offset, true);
    central.set(name, 46);
    chunks.push(header, data); directory.push(central);
    offset += header.length + data.length;
  }
  const directorySize = directory.reduce((size, part) => size + part.length, 0);
  const end = new Uint8Array(22);
  const view = new DataView(end.buffer);
  view.setUint32(0, 0x06054b50, true); view.setUint16(8, 2, true); view.setUint16(10, 2, true);
  view.setUint32(12, directorySize, true); view.setUint32(16, offset, true);
  const output = new Uint8Array(offset + directorySize + end.length);
  let cursor = 0;
  for (const part of [...chunks, ...directory, end]) { output.set(part, cursor); cursor += part.length; }
  return output;
}
