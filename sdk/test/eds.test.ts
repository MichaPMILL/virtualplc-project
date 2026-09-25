import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEds } from '../src/eds.ts';

const EDS = `$ EDS of a vision sensor (test file)
[File]
        DescText = "Vision sensor";
        CreateDate = 04-01-2024;
[Device]
        VendCode = 1234;
        VendName = "Example "
                   "Vision";
        ProdType = 43;
        ProdTypeStr = "Generic Device";
        ProdCode = 17;
        MajRev = 2;
        MinRev = 3;
        ProdName = "VS-100";
        Catalog = "VS-100-E";
[Params]
        Param1 = 0, ,,0x0000, 0xC8, 4, "RPI", "Microsecond", "Requested packet interval",
                 2000, 3200000, 10000;
        Param2 = 0, ,,0x0000, 0xC7, 2, "Out size", "", "", 0, 500, 32;
[Assembly]
        Assem100 = "Result", "20 04 24 64", 64, 0x0000,,;
        Assem150 = "Command", "20 04 24 96", , 0x0000,,,
                   16, , 240, ;     $ size from the members: 32 bytes
        Assem151 = "Config", "20 04 24 97", 0, 0x0000,,;
[Connection Manager]
        Connection1 =
                0x04010002,        $ class 1, cyclic, exclusive owner
                0x44640405,        $ O->T 32-bit header, T->O modeless, P2P / multicast
                Param1, , Assem150,
                Param1, , Assem100,
                ,,
                ,,
                "Exclusive Owner",
                "Command; result",
                "20 04 24 97 2C 96 2C 64";
        Connection2 =
                0x02010002, 0x44240305,
                Param1, 0, , Param1, 64, Assem100, ,, ,,
                "Input Only", "", "20 04 24 [Param2] 2C C6 2C 64";
`;

test('EDS: identity, assemblies, connections', () => {
  const e = parseEds(EDS);
  assert.equal(e.vendorId, 1234);
  assert.equal(e.vendorName, 'Example Vision');
  assert.equal(e.productName, 'VS-100');
  assert.equal(e.productCode, 17);
  assert.equal(e.deviceType, 43);
  assert.deepEqual(e.revision, { major: 2, minor: 3 });
  assert.equal(e.assemblies.get(150)!.size, 32);
  assert.equal(e.assemblies.get(100)!.instance, 100);
  const [owner, input] = e.connections;
  assert.equal(owner.name, 'Exclusive Owner');
  assert.equal(owner.type, 'exclusive-owner');
  assert.deepEqual([owner.configInstance, owner.outInstance, owner.inInstance], [151, 150, 100]);
  assert.deepEqual([owner.outSize, owner.inSize], [32, 64]);
  assert.equal(owner.outHeader, true);
  assert.equal(owner.inHeader, false);
  assert.equal(owner.pointToPoint, true);
  assert.equal(owner.multicast, true);
  assert.deepEqual([owner.rpiMs, owner.rpiMinMs, owner.rpiMaxMs], [10, 2, 3200]);
  assert.equal(input.type, 'input-only');
  assert.deepEqual([input.configInstance, input.outInstance, input.inInstance, input.outSize, input.inSize], [32, 198, 100, 0, 64]);
  assert.equal(input.outHeader, false);
});

test('EDS: not an EDS', () => {
  assert.throws(() => parseEds('[Foo]\nA = 1;'), /no \[Device\]/);
});
