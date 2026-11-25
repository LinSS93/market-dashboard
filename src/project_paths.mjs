import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));
export const MARKET_DB_PATH = join(PROJECT_ROOT, 'data', 'market_data.db');
