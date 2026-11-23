import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** The phone-shell preview page: the one folder under the u5 docs that holds `preview.html`. */
const base = 'docs/ui/u5-phone-shell';
const folder = readdirSync(base, { withFileTypes: true })
  .find((entry) => entry.isDirectory() && existsSync(join(base, entry.name, 'preview.html')));
if (!folder) throw new Error(`no preview.html under ${base}`);
export const PHONE_SHELL_PREVIEW = `/${base}/${folder.name}/preview.html`;
