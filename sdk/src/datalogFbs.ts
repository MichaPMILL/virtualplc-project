// Data log instructions of the usual engineering tools (DataLogCreate, DataLogOpen,
// DataLogWrite, DataLogClose, DataLogNewFile, DataLogClear, DataLogDelete), with the same
// parameters. They are function blocks (single or multi-instance) added to the program when
// it uses them. DataLogCreate declares the data log at compile time: its NAME (constant) and
// its DATA (a structure, array or tag in a global data block) define the columns; the compiler
// passes the index of the log in the hidden input __INDEX. The CPU keeps the records in its
// database (see docs/traceability.md): DataLogClear / DataLogDelete do not remove records of a
// traceability log (they only answer DONE), records are immutable.

export const DATALOG_FBS = ['DATALOGCREATE', 'DATALOGOPEN', 'DATALOGWRITE', 'DATALOGCLOSE', 'DATALOGNEWFILE', 'DATALOGCLEAR', 'DATALOGDELETE'];

/** STATUS values */
export const DATALOG_STATUS = { IDLE: '16#7000', DONE: '16#0000', UNKNOWN_LOG: '16#80C0', WRITE_FAILED: '16#80B4' };

const common = (extraInputs: string, body: string, name: string) => `FUNCTION_BLOCK "${name}"
   VAR_INPUT
      REQ : Bool;${extraInputs}
   END_VAR
   VAR_OUTPUT
      DONE : Bool;
      BUSY : Bool;
      ERROR : Bool;
      STATUS : Word;
   END_VAR
   VAR_IN_OUT
      ID : DWord;
   END_VAR
   VAR
      __EDGE : Bool;
   END_VAR
BEGIN
    DONE := FALSE;
    BUSY := FALSE;
    ERROR := FALSE;
    STATUS := ${DATALOG_STATUS.IDLE};
    IF REQ AND NOT __EDGE THEN
${body}
    END_IF;
    __EDGE := REQ;
END_FUNCTION_BLOCK
`;

const byIndex = `        IF __INDEX >= 0 THEN
            ID := DINT_TO_DWORD(__INDEX + 1);
            DONE := TRUE;
            STATUS := ${DATALOG_STATUS.DONE};
        ELSE
            ERROR := TRUE;
            STATUS := ${DATALOG_STATUS.UNKNOWN_LOG};
        END_IF;`;

const byId = `        IF ID >= 1 THEN
            DONE := TRUE;
            STATUS := ${DATALOG_STATUS.DONE};
        ELSE
            ERROR := TRUE;
            STATUS := ${DATALOG_STATUS.UNKNOWN_LOG};
        END_IF;`;

export const DATALOG_FB_SOURCES: Record<string, string> = {
  DATALOGCREATE: common(`
      RECORDS : UDInt;
      FORMAT : UInt;
      TIMESTAMP : UInt;
      NAME : String[128];
      __INDEX : DInt := -1;`, byIndex, 'DataLogCreate'),
  DATALOGOPEN: common(`
      MODE : UInt;
      NAME : String[128];
      __INDEX : DInt := -1;`, byIndex, 'DataLogOpen'),
  DATALOGWRITE: common('', `        IF ID >= 1 AND DATALOG_WRITE(DWORD_TO_DINT(ID) - 1) THEN
            DONE := TRUE;
            STATUS := ${DATALOG_STATUS.DONE};
        ELSE
            ERROR := TRUE;
            STATUS := ${DATALOG_STATUS.WRITE_FAILED};
        END_IF;`, 'DataLogWrite'),
  DATALOGCLOSE: common('', byId, 'DataLogClose'),
  DATALOGNEWFILE: common(`
      RECORDS : UDInt;
      NAME : String[128];`, byId, 'DataLogNewFile'),
  DATALOGCLEAR: common('', byId, 'DataLogClear'),
  DATALOGDELETE: common(`
      NAME : String[128];
      DELFILE : Bool;`, byId, 'DataLogDelete'),
};
