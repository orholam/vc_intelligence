import pino from "pino";

export type Logger = pino.Logger;

export function makeLogger(level: string): Logger {
  return pino({ level, base: undefined });
}
