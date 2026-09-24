# Changelog

## 2.0.0

Complete rewrite for production use.

### Added
- Composer package with PSR-4 autoloading, `bin/virtualplc` CLI (`run`, `check`, `compile`).
- Language: `CASE`, `REPEAT`, `FOR ... BY`, `EXIT`, `RETURN`, `NOT`, `XOR`, `MOD`, `<=`, `>=`,
  `(* *)` and `/* */` comments, based literals, initial values, `ABS/MIN/MAX/LIMIT`, `DEVICE_OK`.
- Static analysis with line numbers (undeclared variables, unknown functions, writes to inputs...).
- PLC scan semantics: input image per scan, outputs flushed once per scan, watchdog, cyclic FC.
- I/O reconnection with backoff and output resynchronisation.
- Modbus server: FC 15/16, exception responses, fragmented/pipelined frames, client limit.
- Runtime states (RUN/FAULT/IDLE/STOPPED), status diagnostics, graceful shutdown on SIGTERM.
- API: token authentication, CSRF protection, input validation, `validate` and `health` actions,
  build errors mapped to the edited block, automatic backups, working `write` action.
- IDE: runtime status bar, build error list, offline assets, XSS-safe rendering.
- Tests (PHPUnit, incl. end-to-end runtime tests), GitHub Actions CI, Dockerfile, systemd unit.

### Changed
- Web root is now `public/`; runtime data lives in `var/` (outside the web root).
- `daemon.php` is replaced by `bin/virtualplc run`.
- Unknown statements are now syntax errors instead of being silently skipped.
- `INT` is a 16-bit signed integer and `/` an integer division.

### Fixed
- Code injection in the JSON → SCL generator.
- Deploying no longer discards unsaved edits in the IDE.
- Runtime no longer spins/reconnects in a loop when the program ends or crashes.
