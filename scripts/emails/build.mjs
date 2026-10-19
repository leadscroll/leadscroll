import mjml2html from 'mjml';
/**
 * Compiles the committed MJML sources into static HTML. The Worker imports
 * the generated JSON and substitutes the URL placeholders at send time, so
 * neither MJML nor React ships in the runtime bundle.
 */
import { log } from 'node:console';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const templates = [
  ['newLead', 'emails/new-lead.mjml'],
  ['test', 'emails/test-email.mjml'],
];

const output = {};
for (const [key, relative] of templates) {
  const source = await readFile(join(root, relative), 'utf8');
  const { errors, html } = await mjml2html(source, {
    keepComments: true,
    minify: false,
    validationLevel: 'strict',
  });
  if (errors.length > 0) {
    throw new Error(
      `${relative}:\n${errors
        .map((error) => error.formattedMessage)
        .join('\n')}`,
    );
  }

  output[key] = html;
}

await writeFile(
  join(root, 'src/notifications/emails/templates.generated.json'),
  `${JSON.stringify(output, null, 2)}\n`,
);
log(`Built ${templates.length} email templates.`);
