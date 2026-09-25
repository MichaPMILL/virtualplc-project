import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cfgLengths, parseGsd } from '../src/gsd.ts';

const GSD = `;
; Remote I/O station (test file)
#Profibus_DP
GSD_Revision = 3
Vendor_Name = "Example"
Model_Name = "ET-8"
Revision = "V1.2"
Ident_Number = 0x80F1
Protocol_Ident = 0
Station_Type = 0
9.6_supp = 1
187.5_supp = 1
500_supp = 1
1.5M_supp = 1
12M_supp = 0
Modular_Station = 1
Max_Module = 4
Max_User_Prm_Data_Len = 3
Ext_User_Prm_Data_Const(0) = 0x00,0x00,\\
                             0x01
Module = "8 DI" 0x10
EndModule
Module = "8 DO" 0x20
Ext_Module_Prm_Data_Len = 1
EndModule
Module = "2 AI (2 words)" 0x51
EndModule
Module = "Special 4 bytes in, 2 bytes out" 0xC0,0x01,0x03
EndModule
`;

test('GSD: identity, speeds, parameters, modules', () => {
  const g = parseGsd(GSD);
  assert.equal(g.vendor, 'Example');
  assert.equal(g.model, 'ET-8');
  assert.equal(g.identNumber, 0x80f1);
  assert.equal(g.modular, true);
  assert.equal(g.maxModules, 4);
  assert.deepEqual(g.bauds, [9600, 187500, 500000, 1500000]);
  assert.deepEqual(g.userPrm, [0, 0, 1]);
  assert.deepEqual(g.modules.map((m) => [m.name, m.inLength, m.outLength]), [
    ['8 DI', 1, 0], ['8 DO', 0, 1], ['2 AI (2 words)', 4, 0], ['Special 4 bytes in, 2 bytes out', 4, 2],
  ]);
});

test('GSD: configuration identifiers', () => {
  assert.deepEqual(cfgLengths([0x13, 0x21, 0x31, 0xe1]), { inLength: 4 + 2, outLength: 2 + 2 + 4 });
  assert.throws(() => parseGsd('Vendor_Name = "x"'), /Not a PROFIBUS GSD/);
});
