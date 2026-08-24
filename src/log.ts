import { redactVin } from "./redact";

export function logInfo(vin: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify(redactVin(fields, vin)));
}

export function logError(vin: string, fields: Record<string, unknown>): void {
  console.error(JSON.stringify(redactVin(fields, vin)));
}
