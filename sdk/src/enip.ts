// EtherNet/IP from the engineering station: ListIdentity (UDP 44818) finds the devices of the
// network (vendor, product, revision, serial number), to add them to the configuration.
import { createSocket } from 'node:dgram';

export interface EnipIdentity {
  address: string;
  vendorId: number;
  deviceType: number;
  productCode: number;
  revision: { major: number; minor: number };
  status: number;
  serial: number;
  productName: string;
}

/** Parses a ListIdentity reply (encapsulation header included) */
export function parseListIdentity(msg: Buffer, address: string): EnipIdentity | null {
  if (msg.length < 24 + 6 + 33 || msg.readUInt16LE(0) !== 0x63) return null;
  const count = msg.readUInt16LE(24);
  if (count < 1 || msg.readUInt16LE(26) !== 0x0c) return null;
  const len = msg.readUInt16LE(28);
  const d = msg.subarray(30, 30 + len);
  if (d.length < 33) return null;
  const nameLen = d[32];
  return {
    address,
    vendorId: d.readUInt16LE(18),
    deviceType: d.readUInt16LE(20),
    productCode: d.readUInt16LE(22),
    revision: { major: d[24], minor: d[25] },
    status: d.readUInt16LE(26),
    serial: d.readUInt32LE(28),
    productName: d.subarray(33, 33 + nameLen).toString('latin1'),
  };
}

/** Broadcasts ListIdentity and collects the answers for `timeoutMs` */
export function enipDiscover(timeoutMs = 1500, target = '255.255.255.255', port = 44818): Promise<EnipIdentity[]> {
  return new Promise((resolve) => {
    const found = new Map<string, EnipIdentity>();
    const sock = createSocket({ type: 'udp4', reuseAddr: true });
    const done = () => {
      try { sock.close(); } catch { /* closed */ }
      resolve([...found.values()].sort((a, b) => a.address.localeCompare(b.address, undefined, { numeric: true })));
    };
    sock.on('error', done);
    sock.on('message', (msg, rinfo) => {
      const id = parseListIdentity(msg, rinfo.address);
      if (id) found.set(`${id.address}/${id.serial}`, id);
    });
    sock.bind(0, () => {
      sock.setBroadcast(true);
      const req = Buffer.alloc(24);
      req.writeUInt16LE(0x63, 0);
      sock.send(req, port, target);
      setTimeout(done, timeoutMs);
    });
  });
}
