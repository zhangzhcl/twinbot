import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';

const STORE_NAME = 'machine-id.json';

/**
 * Load or create a persistent machineId under Electron userData.
 */
export function getOrCreateMachineId(): string {
  const dir = app.getPath('userData');
  const file = path.join(dir, STORE_NAME);

  try {
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, 'utf8');
      const parsed = JSON.parse(raw) as { machineId?: string };
      if (parsed.machineId && typeof parsed.machineId === 'string') {
        return parsed.machineId;
      }
    }
  } catch {
    // fall through and recreate
  }

  const machineId = uuidv4();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ machineId }, null, 2), 'utf8');
  return machineId;
}
