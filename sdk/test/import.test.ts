// Import of files exported by engineering tools: SCL external sources (.scl/.db/.udt)
// and PLC tag tables (.xlsx).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import {
  compileDevice, importExternalSource, importTagTableXlsx, newProject, projectFromFiles, projectToFiles,
} from '../src/index.ts';

/** Builds a ZIP archive (deflated entries) like spreadsheet applications do. */
function zip(files: Record<string, string>): Uint8Array {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBytes = enc.encode(name);
    const data = deflateRawSync(enc.encode(content));
    const local = new Uint8Array(30 + nameBytes.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(8, 8, true);
    lv.setUint32(18, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(data, 30 + nameBytes.length);
    const cd = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(10, 8, true);
    cv.setUint32(20, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    cd.set(nameBytes, 46);
    locals.push(local);
    central.push(cd);
    offset += local.length;
  }
  const cdSize = central.reduce((s, x) => s + x.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, central.length, true);
  ev.setUint16(10, central.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + cdSize + 22);
  let p = 0;
  for (const part of [...locals, ...central, end]) {
    out.set(part, p);
    p += part.length;
  }
  return out;
}

const sheetXml = (rows: Array<Array<string | number>>, shared: string[]) => {
  const cell = (v: string | number, r: number, c: number) => {
    const ref = `${String.fromCharCode(65 + c)}${r + 1}`;
    if (typeof v === 'number') return `<c r="${ref}"><v>${v}</v></c>`;
    let i = shared.indexOf(v);
    if (i < 0) i = shared.push(v) - 1;
    return `<c r="${ref}" t="s"><v>${i}</v></c>`;
  };
  return `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${
    rows.map((row, r) => `<row r="${r + 1}">${row.map((v, c) => (v === '' ? '' : cell(v, r, c))).join('')}</row>`).join('')}</sheetData></worksheet>`;
};

function workbook(sheets: Record<string, Array<Array<string | number>>>): Uint8Array {
  const shared: string[] = [];
  const files: Record<string, string> = {};
  const names = Object.keys(sheets);
  names.forEach((n, i) => { files[`xl/worksheets/sheet${i + 1}.xml`] = sheetXml(sheets[n], shared); });
  files['xl/workbook.xml'] = `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${
    names.map((n, i) => `<sheet name="${n}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`;
  files['xl/_rels/workbook.xml.rels'] = `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${
    names.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`;
  files['xl/sharedStrings.xml'] = `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${
    shared.map((s) => `<si><t>${s.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</t></si>`).join('')}</sst>`;
  return zip(files);
}

test('imports PLC tags and user constants from an .xlsx tag table export', async () => {
  const bytes = workbook({
    'PLC Tags': [
      ['Name', 'Path', 'Data Type', 'Logical Address', 'Comment', 'Hmi Visible'],
      ['Start_Button', 'Commandes', 'Bool', '%I0.0', 'Bouton marche', 'True'],
      ['Stop_Button', 'Commandes', 'Bool', '%I0.1', '', 'True'],
      ['Motor', 'Sorties', 'Bool', '%Q0.0', 'Contacteur <KM1> & relais', 'True'],
      ['Speed', 'Sorties', 'Int', '%MW10', '', 'True'],
    ],
    'User Constants': [
      ['Name', 'Path', 'Data Type', 'Value', 'Comment'],
      ['MAX_SPEED', 'Sorties', 'Int', 1500, ''],
    ],
  });
  const tables = await importTagTableXlsx(bytes);
  assert.deepEqual(tables.map((t) => t.name), ['Commandes', 'Sorties']);
  assert.deepEqual(tables[0].tags[0], { name: 'Start_Button', dataType: 'Bool', address: '%I0.0', comment: 'Bouton marche' });
  assert.equal(tables[1].tags[0].comment, 'Contacteur <KM1> & relais');
  assert.deepEqual(tables[1].constants, [{ name: 'MAX_SPEED', dataType: 'Int', value: '1500' }]);

  // French column names
  const fr = await importTagTableXlsx(workbook({ 'Variables API': [['Nom', 'Chemin', 'Type de données', 'Adresse logique', 'Commentaire'], ['Lampe', 'Table', 'Bool', '%Q0.1', '']] }));
  assert.deepEqual(fr[0].tags, [{ name: 'Lampe', dataType: 'Bool', address: '%Q0.1' }]);

  await assert.rejects(importTagTableXlsx(workbook({ Sheet1: [['a', 'b']] })), /No tag table/);
  await assert.rejects(importTagTableXlsx(new TextEncoder().encode('not a zip')), /Not a ZIP/);
});

test('imports PLC data types (.udt), global DBs (.db) and blocks, and compiles them', () => {
  const p = newProject('Import');
  const d = p.devices[0];
  const udt = `TYPE "Axis"
VERSION : 0.1
   STRUCT
      Position : Real;   // mm
      Limits : Struct
         Low : Real := -10.0;
         High : Real := 10.0;
      END_STRUCT;
   END_STRUCT;

END_TYPE
`;
  const db = `DATA_BLOCK "Axes"
VERSION : 0.1
NON_RETAIN
   STRUCT
      X : "Axis";
      Y : "Axis";
   END_STRUCT;

BEGIN

END_DATA_BLOCK
`;
  const a = importExternalSource(d, udt, 'Axis.udt');
  assert.deepEqual(a.types.map((t) => t.name), ['Axis']);
  assert.deepEqual(a.types[0].members[1], {
    name: 'Limits', dataType: 'Struct', defaultValue: undefined,
    members: [{ name: 'Low', dataType: 'Real', defaultValue: '-10.0' }, { name: 'High', dataType: 'Real', defaultValue: '10.0' }],
  });
  d.types.push(...a.types);
  const b = importExternalSource(d, db, 'Axes.db');
  d.blocks.push(...b.blocks);
  d.blocks[0].code = '"Axes".X.Position := LIMIT(MN := "Axes".X.Limits.Low, IN := 42.0, MX := "Axes".X.Limits.High);';
  const r = compileDevice(p, d);
  assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
  const axes = r.symbols.find((s) => s.name === 'Axes');
  assert.deepEqual(axes?.children?.[0].children?.map((c) => c.name), ['Position', 'Limits']);

  // the data type survives the folder layout, and errors point to it
  const back = projectFromFiles(projectToFiles(p));
  assert.deepEqual(back.devices[0].types[0].members, JSON.parse(JSON.stringify(a.types[0].members)));
  back.devices[0].types[0].members.push({ name: 'Bad', dataType: 'Nope' });
  const bad = compileDevice(back, back.devices[0]);
  assert.equal(bad.ok, false);
  assert.equal(bad.diagnostics[0].typeId, a.types[0].id);
  assert.match(bad.diagnostics[0].message, /Unknown data type 'Nope'/);
});
