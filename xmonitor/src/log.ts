import { pino } from "pino";

export function makeLogger(level: string) {
  return pino({
    level,
    base: undefined,
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

export type Logger = ReturnType<typeof makeLogger>;
