# EtherNet/IP (scanner) and third-party devices

The Linux CPU drives EtherNet/IP adapters (I/O blocks, drives, vision sensors, valve
terminals…) as a **scanner**. The stack is written in-house: no third-party code.

| Feature | Details |
|---|---|
| Connection | TCP 44818: RegisterSession, then Forward_Open to the Connection Manager |
| I/O | class 1, cyclic, UDP 2222, RPI from 0.5 ms; O→T with the 32-bit run/idle header (option), T→O point to point or multicast |
| Electronic key | vendor, device type, product code, revision (newer revisions accepted), checked by the device |
| Configuration data | bytes sent with the Forward_Open (configuration assembly) |
| Diagnostics | connection state, CIP errors in clear ("0x01/0x0117: invalid produced or consumed application path…"), packets, losses |
| Loss of connection | detected after RPI × multiplier, the inputs go to 0, a new Forward_Open every 1 to 30 s |
| Discovery | ListIdentity: *Rechercher des appareils EtherNet/IP* in the Studio, `vplc-cpu --enip-list` on the CPU |

Not supported yet: explicit messages from the program (CIP Get/Set Attribute), Large_Forward_Open
(assemblies above 505 bytes), CIP Safety, DLR.

## Adding a device in the Studio

*Configuration des appareils* › **+** on the rack:

- **Appareil EtherNet/IP (fichier EDS)…**: choose the EDS file from the manufacturer, then the
  connection (*Exclusive Owner* for the outputs; *Input Only* / *Listen Only* to read only).
  Instances, sizes, header formats, RPI and electronic key come from the EDS.
- **Rechercher des appareils EtherNet/IP…**: devices that answer on the network of the engineering
  station, with their identity (electronic key). Set the assemblies from the manual.
- **Appareil EtherNet/IP (scanner)**: everything by hand.

Then set the IP address, the first %I / %Q bytes, and use **Créer les variables** to get tags
`<module>_IN_n` / `<module>_OUT_n`. `DEVICE_OK(<module>)` tells the program whether the
connection is running.

EtherNet/IP data is **little endian** (CIP), the process image of the CPU is big endian (as in the
usual PLCs): read a word or a double word with `SWAP()`:

```
Count := SWAP(%ID20);          // DINT sent by the device
%QW4 := SWAP(INT#1500);        // INT expected by the device
```

## Vision sensors and cameras

Keyence (IV3 / IV4, CV-X, XG-X), Cognex (In-Sight, DataMan), SICK (Inspector), Omron (FH, FQ-M)
and most other vision systems offer the same kind of exchange, over EtherNet/IP, PROFINET or
digital I/O:

- outputs of the PLC: *Trigger*, *Result acknowledge*, program / recipe number;
- inputs: *Ready*, *Busy*, *Result valid* (or *Inspection completed*), *Total status OK/NG*,
  *Error*, then measured values.

Import the EDS (EtherNet/IP) or GSDML (PROFINET) of the camera, create the variables, and use
**VPLC_VisionTrigger** from the standard library (*Bibliothèques* › *Vision / caméras*):

```
Cam(Execute := BP_Inspect, Ready := Cam_Ready, Busy := Cam_Busy, ResultValid := Cam_Done,
    ResultOk := Cam_OK, DeviceError := Cam_Error, Timeout := T#1S,
    TriggerOut => Cam_Trigger);
IF Cam.Done AND Cam.Ng THEN
    Eject := TRUE;
END_IF;
```

The bit and assembly numbers depend on the model and on its settings (fixed or user-defined
assemblies): take them from the manual or the EDS of the device. The block also counts the
inspections (`Count`, `NgCount`) and reports a camera that is not ready (1), a timeout (2) or a
camera error (3).

## Other brands

Any device with an EDS (EtherNet/IP), a GSDML (PROFINET), an IODD (IO-Link) or a Modbus TCP
register map can be added the same way; the device catalogue is extensible without code changes.
