const fs = require('fs');
const path = require('path');

const externalJsPath = path.resolve(__dirname, '..', 'node_modules', 'zod', 'v4', 'classic', 'external.js');
const indexCjsPath = path.resolve(__dirname, '..', 'node_modules', 'zod', 'index.cjs');

try {
  if (fs.existsSync(externalJsPath)) {
    let content = fs.readFileSync(externalJsPath, 'utf8');
    if (!content.includes('ZodSchema')) {
      content += "\nexport { ZodType as ZodSchema } from './schemas.js';\n";
      fs.writeFileSync(externalJsPath, content, 'utf8');
    }
  }

  if (fs.existsSync(indexCjsPath)) {
    let cjsContent = fs.readFileSync(indexCjsPath, 'utf8');
    if (!cjsContent.includes('ZodSchema')) {
      cjsContent += "\nexports.ZodSchema = z.ZodType;\n";
      fs.writeFileSync(indexCjsPath, cjsContent, 'utf8');
    }
  }
} catch (err) {
  // Graceful no-op if zod is not present
}
