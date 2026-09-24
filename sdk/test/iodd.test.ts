import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ioLinkTags, parseIodd } from '../src/index.ts';

// Shape of a pressure sensor IODD (IO Device Description 1.1): 32-bit process data in
// (14-bit pressure value, two switching outputs), 8-bit process data out.
const IODD = `<?xml version="1.0" encoding="utf-8"?>
<IODevice xmlns="http://www.io-link.com/IODD/2010/10" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <ProfileBody>
    <DeviceIdentity vendorId="310" vendorName="Example Sensors" deviceId="1234">
      <VendorText textId="TI_VendorText"/>
      <DeviceVariantCollection>
        <DeviceVariant productId="PS-100"><Name textId="TI_Variant"/></DeviceVariant>
      </DeviceVariantCollection>
    </DeviceIdentity>
    <DeviceFunction>
      <DatatypeCollection>
        <Datatype id="DT_Out" xsi:type="RecordT" bitLength="8">
          <RecordItem subindex="1" bitOffset="0"><SimpleDatatype xsi:type="BooleanT"/><Name textId="TN_Reset"/></RecordItem>
        </Datatype>
      </DatatypeCollection>
      <ProcessDataCollection>
        <ProcessData id="PD">
          <ProcessDataIn id="PDI" bitLength="32">
            <Datatype xsi:type="RecordT" bitLength="32">
              <RecordItem subindex="1" bitOffset="16"><SimpleDatatype xsi:type="IntegerT" bitLength="16"/><Name textId="TN_Pressure"/></RecordItem>
              <RecordItem subindex="2" bitOffset="0"><SimpleDatatype xsi:type="BooleanT"/><Name textId="TN_OUT1"/></RecordItem>
              <RecordItem subindex="3" bitOffset="1"><SimpleDatatype xsi:type="BooleanT"/><Name textId="TN_OUT2"/></RecordItem>
              <RecordItem subindex="4" bitOffset="2"><SimpleDatatype xsi:type="UIntegerT" bitLength="6"/><Name textId="TN_Scale"/></RecordItem>
            </Datatype>
            <Name textId="TI_PDin"/>
          </ProcessDataIn>
          <ProcessDataOut id="PDO" bitLength="8"><DatatypeRef datatypeId="DT_Out"/><Name textId="TI_PDout"/></ProcessDataOut>
        </ProcessData>
      </ProcessDataCollection>
    </DeviceFunction>
  </ProfileBody>
  <ExternalTextCollection>
    <PrimaryLanguage xml:lang="en">
      <Text id="TI_Variant" value="Pressure sensor PS-100"/>
      <Text id="TN_Pressure" value="Pressure"/>
      <Text id="TN_OUT1" value="Switch 1"/>
      <Text id="TN_OUT2" value="Switch 2"/>
      <Text id="TN_Scale" value="Scale"/>
      <Text id="TN_Reset" value="Reset"/>
    </PrimaryLanguage>
    <Language xml:lang="fr">
      <Text id="TN_Pressure" value="Pression"/>
    </Language>
  </ExternalTextCollection>
</IODevice>`;

test('reads the process data layout of an IODD', () => {
  const d = parseIodd(IODD);
  assert.equal(d.vendor, 'Example Sensors');
  assert.equal(d.device, 'Pressure sensor PS-100');
  assert.equal(d.productId, 'PS-100');
  assert.equal(d.inLength, 4);
  assert.equal(d.outLength, 1);
  assert.deepEqual(d.inputs.map((i) => [i.name, i.bitOffset, i.bitLength, i.dataType]), [
    ['Pression', 16, 16, 'Int'], ['Switch 1', 0, 1, 'Bool'], ['Switch 2', 1, 1, 'Bool'], ['Scale', 2, 6, undefined],
  ]);
  assert.deepEqual(d.outputs.map((i) => [i.name, i.dataType]), [['Reset', 'Bool']]);
});

test('creates PLC tags at the addresses of the port (most significant octet first)', () => {
  const { tags, skipped } = ioLinkTags(parseIodd(IODD), 'IOL1_P2', 20, 8);
  assert.deepEqual(tags.map((t) => [t.name, t.dataType, t.address]), [
    ['IOL1_P2_Pression', 'Int', '%IW20'],
    ['IOL1_P2_Switch_1', 'Bool', '%I23.0'],
    ['IOL1_P2_Switch_2', 'Bool', '%I23.1'],
    ['IOL1_P2_Reset', 'Bool', '%Q8.0'],
  ]);
  assert.deepEqual(skipped, ["Scale (6 bits à l'offset 2)"]);
});

test('rejects files that are not IODDs', () => {
  assert.throws(() => parseIodd('<foo/>'), /Not an IODD/);
});
