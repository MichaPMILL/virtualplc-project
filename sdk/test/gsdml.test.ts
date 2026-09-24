// GSDML: generation for the VirtualPLC IO-Device and reading of third-party files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateGsdml, parseGsdml, pnModuleIdent, pnSubmodules } from '../src/index.ts';

test('generated GSDML reads back with the CPU catalogue', () => {
  const { fileName, xml } = generateGsdml({ vendorId: 0x1234, deviceId: 7, date: new Date(2026, 8, 24) });
  assert.equal(fileName, 'GSDML-V2.35-VirtualPLC-VirtualPLCCPU-20260924.xml');
  const d = parseGsdml(xml);
  assert.equal(d.vendorId, 0x1234);
  assert.equal(d.deviceId, 7);
  const dap = d.daps[0];
  assert.deepEqual(dap.submodules.map((s) => [s.subslot, s.ident]), [[1, 1], [0x8000, 2], [0x8001, 3]]);
  const io = d.modules.get('INOUT_16')!;
  assert.equal(io.ident, pnModuleIdent('inout', 16));
  assert.deepEqual([io.submodules[0].inLength, io.submodules[0].outLength], [16, 16]);
  assert.equal(io.name, 'IN/OUT 16 octets');
  assert.equal(dap.useable.length, 24);
});

test('third-party GSDML: slots, data lengths, default parameter records', () => {
  const xml = `<?xml version="1.0"?>
<ISO15745Profile><ProfileBody>
  <DeviceIdentity VendorID="0x00AB" DeviceID="0x0102"><InfoText TextId="T_INFO"/><VendorName Value="ACME"/></DeviceIdentity>
  <DeviceFunction><Family MainFamily="I/O" ProductFamily="Blocks"/></DeviceFunction>
  <ApplicationProcess>
    <DeviceAccessPointList>
      <DeviceAccessPointItem ID="DAP" PhysicalSlots="0..4" ModuleIdentNumber="0x00010000" MinDeviceInterval="64">
        <ModuleInfo><Name TextId="T_DAP"/></ModuleInfo>
        <UseableModules>
          <ModuleItemRef ModuleItemTarget="DI8" AllowedInSlots="1..4"/>
          <ModuleItemRef ModuleItemTarget="AI2" FixedInSlots="4"/>
        </UseableModules>
        <VirtualSubmoduleList><VirtualSubmoduleItem ID="DAPS" SubmoduleIdentNumber="0x1"><IOData/></VirtualSubmoduleItem></VirtualSubmoduleList>
        <SystemDefinedSubmoduleList>
          <InterfaceSubmoduleItem ID="IF" SubmoduleIdentNumber="0x2"/>
          <PortSubmoduleItem ID="P1" SubslotNumber="32769" SubmoduleIdentNumber="0x3"/>
          <PortSubmoduleItem ID="P2" SubslotNumber="32770" SubmoduleIdentNumber="0x3"/>
        </SystemDefinedSubmoduleList>
      </DeviceAccessPointItem>
    </DeviceAccessPointList>
    <ModuleList>
      <ModuleItem ID="DI8" ModuleIdentNumber="0x100">
        <ModuleInfo><Name TextId="T_DI8"/><OrderNumber Value="DI-8"/></ModuleInfo>
        <VirtualSubmoduleList><VirtualSubmoduleItem ID="DI8S" SubmoduleIdentNumber="0x101">
          <IOData><Input><DataItem DataType="Unsigned8" TextId="x"/></Input></IOData>
        </VirtualSubmoduleItem></VirtualSubmoduleList>
      </ModuleItem>
      <ModuleItem ID="AI2" ModuleIdentNumber="0x200">
        <ModuleInfo><Name TextId="T_AI2"/></ModuleInfo>
        <VirtualSubmoduleList><VirtualSubmoduleItem ID="AI2S" SubmoduleIdentNumber="0x201">
          <IOData><Input><DataItem DataType="Integer16" TextId="a"/><DataItem DataType="Integer16" TextId="b"/></Input><Output><DataItem DataType="OctetString" Length="3" TextId="c"/></Output></IOData>
          <RecordDataList>
            <ParameterRecordDataItem Index="128" Length="6">
              <Const ByteOffset="0" Data="0x01,0x02"/>
              <Ref ByteOffset="2" DataType="Unsigned16" DefaultValue="1000"/>
              <Ref ByteOffset="4" BitOffset="3" DataType="Bit" DefaultValue="1"/>
              <Ref ByteOffset="5" BitOffset="0" DataType="BitArea" BitLength="3" DefaultValue="5"/>
            </ParameterRecordDataItem>
          </RecordDataList>
        </VirtualSubmoduleItem></VirtualSubmoduleList>
      </ModuleItem>
    </ModuleList>
    <ExternalTextList>
      <PrimaryLanguage><Text TextId="T_DAP" Value="Block head"/><Text TextId="T_DI8" Value="8 DI"/><Text TextId="T_AI2" Value="2 AI"/><Text TextId="T_INFO" Value="Remote I/O"/></PrimaryLanguage>
      <Language xml:lang="fr"><Text TextId="T_DI8" Value="8 ETOR"/></Language>
    </ExternalTextList>
  </ApplicationProcess>
</ProfileBody></ISO15745Profile>`;
  const d = parseGsdml(xml);
  assert.equal(d.vendorName, 'ACME');
  assert.equal(d.family, 'I/O / Blocks');
  const dap = d.daps[0];
  assert.deepEqual(dap.physicalSlots, [0, 1, 2, 3, 4]);
  assert.equal(dap.minDeviceIntervalMs, 2);
  assert.deepEqual(dap.useable, [
    { moduleId: 'DI8', allowedSlots: [1, 2, 3, 4], fixedInSlots: [], usedInSlots: [] },
    { moduleId: 'AI2', allowedSlots: [4], fixedInSlots: [4], usedInSlots: [] },
  ]);
  assert.deepEqual(dap.submodules.map((s) => s.subslot), [1, 0x8000, 0x8001, 0x8002]);
  const di = d.modules.get('DI8')!;
  assert.equal(di.name, '8 ETOR');
  assert.equal(di.submodules[0].inLength, 1);
  const ai = d.modules.get('AI2')!;
  assert.deepEqual([ai.submodules[0].inLength, ai.submodules[0].outLength], [4, 3]);
  assert.deepEqual(ai.submodules[0].records, [{ index: 128, data: [1, 2, 0x03, 0xE8, 0x08, 0x05] }]);
  const subs = pnSubmodules(dap, [{ slot: 4, module: ai }, { slot: 1, module: di }], 10, 20);
  assert.deepEqual(subs.map((s) => `${s.slot}.${s.subslot} I${s.inLength}@${s.inByte} Q${s.outLength}@${s.outByte}`), [
    '0.1 I0@0 Q0@0', '0.32768 I0@0 Q0@0', '0.32769 I0@0 Q0@0', '0.32770 I0@0 Q0@0', '1.1 I1@10 Q0@0', '4.1 I4@11 Q3@20',
  ]);
});
