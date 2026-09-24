# Traceability (data logs)

A **data log** records the values of tags (its *columns*) each time it is triggered:

| Trigger | When |
|---|---|
| program | `DATALOG_WRITE('Name')` in the program (returns FALSE if the record could not be queued) |
| edge | rising edge of a Bool tag, checked at the end of each scan |
| period | every *n* ms |

The values are captured at the end of the scan in which the log is triggered, with the date
and time of the CPU (UTC, ns).

## Storage and forwarding (Linux CPU)

1. **Local database** — every record is first written to `<data dir>/traceability.db`
   (SQLite, WAL, `synchronous=FULL`), table `log_<name>`. Nothing is lost while the network or
   the database server is down (*store and forward*). A trigger refuses any update of a
   record. If the columns of a log change, the previous table is kept as `log_<name>_<epoch>`
   and a new chain starts.
2. **Database of the log** (optional) — a thread per log copies the pending records, 500 at a
   time in one transaction, to PostgreSQL or MySQL / MariaDB. The table is created if needed:

   | column | content |
   |---|---|
   | `plc`, `log`, `epoch`, `record_id` | primary key: a record is inserted **exactly once** (`ON CONFLICT DO NOTHING` / `INSERT IGNORE`) |
   | `ts` | time of the record (UTC) — `ts_ns`: the same in ns since 1970 |
   | *columns* | values (BOOLEAN, BIGINT, DOUBLE, TEXT / VARCHAR) |
   | `chain` | hash chain (below) |
   | `sig` | Ed25519 signature of `chain` by the CPU |

   The clients are written from the public protocol documentations (no client library):
   PostgreSQL (SCRAM-SHA-256, MD5; clear-text passwords only over TLS; extended protocol),
   MySQL / MariaDB (caching_sha2_password with TLS or the server RSA key, mysql_native_password;
   binary prepared statements). **Values are always parameters**: a PLC string cannot inject SQL.
3. **Retention** — records older than *n* days are deleted from the CPU (once copied when the
   log has a database). 0 = keep forever.

## Security

- **TLS by default**, with certificate and host name verification (system CAs, or the file
  given by `VPLC_DB_CA_FILE`); *require* (TLS without verification) and *disable* are explicit
  choices in the Studio.
- **Credentials never leave the CPU**: the Studio sends the password once (protocol command
  `SET_SECRET`, authenticated when the CPU has a password); it is stored in
  `<data dir>/secrets` (mode 0600) and is neither in the project, the program image nor Git.
- Give the database user **CREATE, INSERT and SELECT only** (no UPDATE, no DELETE).

## Hash chain and signatures (immutability, customer side)

Each record is chained to the previous one:

```
genesis   = hex(SHA-256("VirtualPLC data log|" plc "|" log "|" epoch))
canonical = record_id "|" ts_ns ( "|" value )*
            value: B0 / B1 (bool), I<decimal> (int), R<16 hex digits of the IEEE-754 double>,
                   T<UTF-8 length>:<text>, N (null)
chain(n)  = hex(SHA-256(chain(n-1) "|" canonical(n)))
sig(n)    = Ed25519(CPU key, ASCII chain(n))
```

Any record changed, removed or inserted breaks the chain; a forger who recomputes the chain
cannot produce the signatures. Each CPU creates its key on first use (`<data dir>/identity.pem`,
mode 0600); its **fingerprint** (Studio, *Traçabilité > En ligne*) is given to the customers.

**Certificates** — *Certificat de traçabilité…* in the Studio (or `DeviceClient.traceCertificate`)
exports the records with their chain values and signatures and the public key of the CPU. The
customer checks it without access to the plant:

- `tools/trace-verifier/index.html` — offline web page (drag and drop the certificate, enter
  the fingerprint);
- `vplc verify certificate.json --fingerprint "3f9a 12c0 …"` (SDK command line);
- `verifyTraceCertificate()` / `verifyTrace()` of the SDK (records read from the database).

## Simulation

The simulated CPU of the Studio keeps the last 200 records of each log in memory (no
database, no signature) so that logs can be tried without hardware.
