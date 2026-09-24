# vplc-openness-export

Exports the PLC program of an engineering project — project folder (`.ap17`, `.ap18`,
`.ap19`…) or project archive (`.zap17`, `.zap18`, `.zap19`…) — as XML files (SimaticML)
that VirtualPLC Studio imports with *Projet > Importer des fichiers*.

VirtualPLC never reads the proprietary project formats itself. This tool relies on the
**public Openness API** of the engineering software, i.e. the export interface the vendor
provides for this purpose, on a workstation where that software is installed and licensed.

## Requirements (engineering PC, Windows)

- The engineering software (V17 or newer) with its **Openness** option installed.
- The Windows user is a member of the local group created by the Openness option
  (log off / on after adding it).
- .NET SDK 6 or newer to build (the tool itself targets .NET Framework 4.8, as the API does).

## Build

```bat
cd tools\openness-export
dotnet build -c Release -p:EngineeringVersion=17
```

`EngineeringVersion` selects the installed version (17, 18, 19…). If the software is not in
its default folder, pass the folder of `Siemens.Engineering.dll` with
`-p:OpennessDir="D:\...\PublicAPI\V17"` (the DLL is referenced, never copied).

## Use

```bat
bin\Release\net48\vplc-openness-export.exe  D:\Projects\Line3.zap17  D:\Export\Line3
bin\Release\net48\vplc-openness-export.exe  D:\Projects\Line3\Line3.ap17  D:\Export\Line3 --plc PLC_1
```

| Option          | Effect                                                                  |
|-----------------|-------------------------------------------------------------------------|
| `--upgrade`     | open / retrieve a project of an older version (a copy is upgraded)      |
| `--plc NAME`    | export only this PLC                                                    |
| `--api-dir DIR` | folder of `Siemens.Engineering.dll` at run time (default: build setting) |

The first call asks, in a dialog of the engineering software, to allow the tool to access it.

Result: one folder per PLC with `Blocks/` (sub-folders = block groups), `Types/` and `Tags/`.
In the Studio, select all these `.xml` files at once: data types, tag tables and DBs are
imported first, then the blocks.

Notes:

- Archives are retrieved into a temporary folder that is deleted afterwards.
- Blocks are compiled in memory so that they can be exported; the project is **never saved**.
- Know-how protected blocks and blocks that do not compile are listed as skipped.
- LAD and SCL blocks are converted; FBD, STL and GRAPH blocks are imported empty with a
  warning (convert them to LAD or SCL in the original project first).
