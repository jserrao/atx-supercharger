import type { AppConfig } from "./types";

export function zonedClock(date: Date, timeZone: string): { hour: number; minute: number } {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "numeric",
      minute: "numeric",
      hourCycle: "h23",
    }).formatToParts(date);
    return {
      hour: Number(parts.find((part) => part.type === "hour")?.value),
      minute: Number(parts.find((part) => part.type === "minute")?.value),
    };
  } catch {
    return zonedClock(date, "UTC");
  }
}

export function isHourlyCadence(scheduledAt: Date): boolean {
  return scheduledAt.getUTCMinutes() === 0 && scheduledAt.getUTCSeconds() === 0;
}

export function inWakeHours(hour: number, startHour: number, endHour: number): boolean {
  if (!Number.isFinite(hour) || startHour === endHour) return false;
  if (startHour < endHour) return hour >= startHour && hour < endHour;
  return hour >= startHour || hour < endHour;
}

export function shouldWakeForOccupancy(
  config: AppConfig,
  scheduledAt: Date,
  forceFleet = false,
): boolean {
  if (forceFleet) return true;
  if (!config.wakeWhenAsleep) return false;
  if (!isHourlyCadence(scheduledAt)) return false;
  const { hour } = zonedClock(scheduledAt, config.wakeTimezone);
  return inWakeHours(hour, config.wakeStartHour, config.wakeEndHour);
}
