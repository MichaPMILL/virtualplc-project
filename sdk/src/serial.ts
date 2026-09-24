// Serial links (USB) to microcontroller CPUs — shared by the client and the Studio.

/** Serial port names: COM3 (Windows), /dev/ttyUSB0, /dev/ttyACM0, /dev/cu.usbserial… */
export function isSerialPort(host: string): boolean {
  return /^(COM\d+|\/dev\/.+|\\\\\.\\COM\d+)$/i.test(host.trim());
}

export const BAUD_RATES = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600, 1000000, 2000000];
export const DEFAULT_BAUD = 115200;

/** Host names that select the simulated CPU of the Studio (see simulator.ts) */
export function isSimulatorHost(host: string): boolean {
  return /^(simulation|sim|plcsim)$/i.test(host.trim());
}
