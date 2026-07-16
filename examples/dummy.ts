import { readFile } from "node:fs/promises";
import type { EventEmitter } from "node:events";

export interface UserRecord {
  id: string;
  name: string;
  email?: string;
}

export interface AdminRecord extends UserRecord {
  permissions: string[];
}

/**
 * Loads a user record from disk and parses it as JSON.
 */
export async function loadUser(id: string, retries?: number): Promise<UserRecord> {
  const raw = await readFile(`./users/${id}.json`, "utf-8");
  return JSON.parse(raw) as UserRecord;
}

export const formatUserName = (user: UserRecord, uppercase = false): string => {
  return uppercase ? user.name.toUpperCase() : user.name;
};

function internalHelper(x: number): number {
  return x * 2;
}
