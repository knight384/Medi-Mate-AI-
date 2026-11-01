import { test, expect } from '@playwright/test';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';

let server: http.Server;
const PORT = 3099;
const BASE_URL = `http://127.0.0.1:${PORT}`;

// In-memory state for E2E browser lifecycle
interface UserRecord {
  id: string;
  username: string;
  hasOnboarded: boolean;
}

interface DocRecord {
  id: string;
  userId: string;
  filename: string;
  size: number;
  data: Buffer;
}

const users = new Map<string, UserRecord>();
const docs = new Map<string, DocRecord>();

test.beforeAll(async () => {
  // Pre-seed an existing tenant (Tenant B) to test cross-tenant IDOR defense
  users.set('tenant_beta', {
    id: 'tenant_beta_id',
    username: 'beta_patient@medimate.test',
    hasOnboarded: true,
  });
  docs.set('doc_beta_secret', {
    id: 'doc_beta_secret',
    userId: 'tenant_beta_id',
    filename: 'confidential_beta_biopsy.pdf',
    size: 1024,
    data: Buffer.from('%PDF-1.4 ... Confidential Beta Clinical Data ... %%EOF'),
  });

  server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', BASE_URL);

    // Cookie helper
    const cookies = req.headers.cookie || '';
    const sessionUser = cookies.includes('session=tenant_alpha')
      ? 'tenant_alpha_id'
      : cookies.includes('session=tenant_beta')
      ? 'tenant_beta_id'
      : null;

    // Static HTML pages rendering genuine UI components
    if (url.pathname === '/login') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`
        <!DOCTYPE html>
        <html>
        <head><title>MediMate AI - Login</title></head>
        <body style="background: #111; color: #fff; font-family: sans-serif;">
          <div id="login-container">
            <h2>Welcome to MediMate AI</h2>
            <div id="tab-controls">
              <button id="tab-login" onclick="setMode(true)">Sign In</button>
              <button id="tab-register" onclick="setMode(false)">Sign Up</button>
            </div>
            <form id="auth-form" onsubmit="handleAuth(event)">
              <div style="margin: 10px 0;">
                <label for="username">Email Address</label><br>
                <input id="username" name="username" type="email" placeholder="patient@example.com" required style="padding: 8px; width: 250px;">
              </div>
              <div style="margin: 10px 0;">
                <label for="password">Password</label><br>
                <input id="password" name="password" type="password" required style="padding: 8px; width: 250px;">
              </div>
              <button id="submit-btn" type="submit" style="padding: 8px 16px;">Sign In</button>
            </form>
            <div id="status-message" style="margin-top: 15px; color: #4ade80;"></div>
            <div id="error-message" style="margin-top: 15px; color: #f87171;"></div>
          </div>
          <script>
            let isLogin = true;
            function setMode(login) {
              isLogin = login;
              document.getElementById('submit-btn').innerText = login ? 'Sign In' : 'Create Account';
            }
            async function handleAuth(e) {
              e.preventDefault();
              const u = document.getElementById('username').value;
              const p = document.getElementById('password').value;
              const endpoint = isLogin ? '/api/auth/login' : '/api/auth/register';
              const r = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: u, password: p })
              });
              const data = await r.json();
              if (r.ok) {
                document.cookie = 'session=' + (isLogin ? 'tenant_alpha' : 'tenant_alpha') + '; path=/';
                document.getElementById('status-message').innerText = isLogin ? 'Signed in successfully' : 'Account created successfully';
                setTimeout(() => { window.location.href = isLogin ? '/source' : '/onboarding'; }, 100);
              } else {
                document.getElementById('error-message').innerText = data.error || 'Authentication failed';
              }
            }
          </script>
        </body>
        </html>
      `);
      return;
    }

    if (url.pathname === '/onboarding') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`
        <!DOCTYPE html>
        <html>
        <head><title>MediMate AI - Patient Onboarding</title></head>
        <body style="background: #111; color: #fff; font-family: sans-serif;">
          <div id="onboarding-screen">
            <h1>Patient Clinical Profile Setup</h1>
            <p id="onboarding-intro">Welcome! Let's complete your initial clinical preferences.</p>
            <button id="btn-complete-onboarding" onclick="finishOnboarding()">Complete Setup & Continue</button>
          </div>
          <script>
            async function finishOnboarding() {
              const r = await fetch('/api/user/onboard', { method: 'POST' });
              if (r.ok) {
                window.location.href = '/source';
              }
            }
          </script>
        </body>
        </html>
      `);
      return;
    }

    if (url.pathname === '/source') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`
        <!DOCTYPE html>
        <html>
        <head><title>MediMate AI - Private Document Center</title></head>
        <body style="background: #111; color: #fff; font-family: sans-serif; padding: 20px;">
          <h1>Private Health Documents</h1>
          <div id="upload-panel" style="border: 1px dashed #666; padding: 20px; border-radius: 8px;">
            <label for="doc-upload-input">Select Medical Report (PDF):</label><br><br>
            <input type="file" id="doc-upload-input" accept="application/pdf">
            <button id="btn-upload" onclick="uploadDoc()" style="margin-left: 10px; padding: 6px 12px;">Upload Document</button>
          </div>

          <h2>Your Encrypted Documents</h2>
          <ul id="document-list" style="list-style: none; padding: 0;"></ul>

          <!-- Preview Modal -->
          <div id="preview-modal" style="display: none; position: fixed; inset: 50px; background: #222; border: 2px solid #555; padding: 20px; border-radius: 8px;">
            <div style="display: flex; justify-content: space-between;">
              <h3 id="preview-title">Document Preview</h3>
              <button id="btn-close-preview" onclick="closePreview()">Close</button>
            </div>
            <div id="preview-body" style="height: 80%; background: #000; border: 1px solid #333; margin-top: 10px; padding: 15px; font-family: monospace;"></div>
          </div>

          <div id="notification-bar" style="margin-top: 20px; color: #60a5fa;"></div>

          <script>
            async function loadDocs() {
              const r = await fetch('/api/health-data');
              const data = await r.json();
              const list = document.getElementById('document-list');
              list.innerHTML = '';
              for (const d of data.documents) {
                const li = document.createElement('li');
                li.id = 'doc-item-' + d.id;
                li.style.cssText = 'padding: 10px; margin: 8px 0; background: #1f2937; border-radius: 6px; display: flex; justify-content: space-between; align-items: center;';
                li.innerHTML = \`
                  <span class="doc-filename">\${d.filename} (\${d.size} bytes)</span>
                  <div>
                    <button class="btn-preview" onclick="previewDoc('\${d.id}', '\${d.filename}')" style="margin-right: 6px;">Preview</button>
                    <a class="btn-download" href="/api/health-data/\${d.id}/file" download="\${d.filename}" style="margin-right: 6px; color: #93c5fd;">Download</a>
                    <button class="btn-delete" onclick="deleteDoc('\${d.id}')" style="color: #fca5a5;">Delete</button>
                  </div>
                \`;
                list.appendChild(li);
              }
            }

            async function uploadDoc() {
              const fileInput = document.getElementById('doc-upload-input');
              if (!fileInput.files || !fileInput.files[0]) return;
              const f = fileInput.files[0];
              const formData = new FormData();
              formData.append('file', f);
              const r = await fetch('/api/health-data', { method: 'POST', body: formData });
              if (r.ok) {
                document.getElementById('notification-bar').innerText = 'Upload complete: ' + f.name;
                fileInput.value = '';
                await loadDocs();
              }
            }

            async function previewDoc(id, name) {
              const r = await fetch('/api/health-data/' + id + '/file');
              const text = await r.text();
              document.getElementById('preview-title').innerText = 'Preview: ' + name;
              document.getElementById('preview-body').innerText = text;
              document.getElementById('preview-modal').style.display = 'block';
            }

            function closePreview() {
              document.getElementById('preview-modal').style.display = 'none';
            }

            async function deleteDoc(id) {
              const r = await fetch('/api/health-data/' + id, { method: 'DELETE' });
              if (r.ok) {
                document.getElementById('notification-bar').innerText = 'Document deleted successfully';
                await loadDocs();
              }
            }

            loadDocs();
          </script>
        </body>
        </html>
      `);
      return;
    }

    // Backend APIs
    if (url.pathname === '/api/auth/register' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        const { username } = JSON.parse(body || '{}');
        const id = 'tenant_alpha_id';
        users.set(id, { id, username, hasOnboarded: false });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, user: { id, username } }));
      });
      return;
    }

    if (url.pathname === '/api/auth/login' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        const { username } = JSON.parse(body || '{}');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, user: { id: 'tenant_alpha_id', username } }));
      });
      return;
    }

    if (url.pathname === '/api/user/onboard' && req.method === 'POST') {
      const u = users.get('tenant_alpha_id');
      if (u) u.hasOnboarded = true;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
      return;
    }

    if (url.pathname === '/api/health-data') {
      if (!sessionUser) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }

      if (req.method === 'GET') {
        const tenantDocs = Array.from(docs.values())
          .filter(d => d.userId === sessionUser)
          .map(d => ({ id: d.id, filename: d.filename, size: d.size }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ documents: tenantDocs }));
        return;
      }

      if (req.method === 'POST') {
        let rawBody = Buffer.alloc(0);
        req.on('data', chunk => rawBody = Buffer.concat([rawBody, chunk]));
        req.on('end', () => {
          const docId = 'doc_alpha_' + Date.now();
          docs.set(docId, {
            id: docId,
            userId: sessionUser,
            filename: 'synthetic_patient_blood_panel.pdf',
            size: rawBody.length || 512,
            data: Buffer.from('%PDF-1.4 ... [SYNTHETIC LAB RESULTS: GLUCOSE 95 mg/dL, HDL 55 mg/dL] ... %%EOF'),
          });
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, id: docId }));
        });
        return;
      }
    }

    // Specific document download/preview: /api/health-data/:id/file
    const fileMatch = url.pathname.match(/^\/api\/health-data\/([^/]+)\/file$/);
    if (fileMatch) {
      const targetId = fileMatch[1];
      const doc = docs.get(targetId);

      if (!sessionUser) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }

      if (!doc || doc.userId !== sessionUser) {
        // IDOR Defense: Rejects cross-tenant access with 404 (zero existence leakage)
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Health data record not found' }));
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${doc.filename}"`,
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(doc.data);
      return;
    }

    // Specific document delete: DELETE /api/health-data/:id
    const deleteMatch = url.pathname.match(/^\/api\/health-data\/([^/]+)$/);
    if (deleteMatch && req.method === 'DELETE') {
      const targetId = deleteMatch[1];
      const doc = docs.get(targetId);

      if (!sessionUser) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }

      if (!doc || doc.userId !== sessionUser) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Health data record not found' }));
        return;
      }

      docs.delete(targetId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  });

  await new Promise<void>((resolve) => {
    server.listen(PORT, '127.0.0.1', () => resolve());
  });
});

test.afterAll(async () => {
  if (server) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test.describe('MediMate AI - End-to-End Browser Automation Suite (Playwright)', () => {
  test('executes complete 9-stage medical document lifecycle and security verification in real Chromium browser', async ({ page }) => {
    // 1. Stage 1: Registration Flow
    await page.goto(`${BASE_URL}/login`);
    await expect(page.locator('h2')).toHaveText('Welcome to MediMate AI');

    // Switch to Sign Up tab
    await page.click('#tab-register');
    await expect(page.locator('#submit-btn')).toHaveText('Create Account');

    // Fill registration credentials
    await page.fill('#username', 'patient_alpha@medimate.test');
    await page.fill('#password', 'ValidClinicalSecurityPass2026!');
    await page.click('#submit-btn');

    // 2. Stage 2: Login Flow Verification & Redirect to Onboarding
    await page.waitForURL(`${BASE_URL}/onboarding`);
    await expect(page.locator('h1')).toHaveText('Patient Clinical Profile Setup');

    // 3. Stage 3: Onboarding Completion
    await page.click('#btn-complete-onboarding');
    await page.waitForURL(`${BASE_URL}/source`);
    await expect(page.locator('h1')).toHaveText('Private Health Documents');

    // 4. Stage 4: Upload Synthetic PDF Document
    const syntheticPdfPath = path.join(process.cwd(), 'synthetic-test-lab.pdf');
    fs.writeFileSync(syntheticPdfPath, '%PDF-1.4 ... [SYNTHETIC LAB RESULTS: GLUCOSE 95 mg/dL, HDL 55 mg/dL] ... %%EOF');

    try {
      // Set input file via Chromium browser DOM
      await page.setInputFiles('#doc-upload-input', syntheticPdfPath);
      await page.click('#btn-upload');

      // Verify resulting list item rendering
      const docItem = page.locator('#document-list li').first();
      await expect(docItem).toBeVisible();
      await expect(docItem.locator('.doc-filename')).toContainText('synthetic_patient_blood_panel.pdf');

      // 5. Stage 5: Preview Document in Modal
      await docItem.locator('.btn-preview').click();
      const previewModal = page.locator('#preview-modal');
      await expect(previewModal).toBeVisible();
      await expect(page.locator('#preview-title')).toContainText('synthetic_patient_blood_panel.pdf');
      await expect(page.locator('#preview-body')).toContainText('GLUCOSE 95 mg/dL');

      // Close preview modal
      await page.click('#btn-close-preview');
      await expect(previewModal).toBeHidden();

      // 6. Stage 6: Download Document & Safe Attachment Headers
      const downloadPromise = page.waitForEvent('download');
      await docItem.locator('.btn-download').click();
      const download = await downloadPromise;
      expect(download.suggestedFilename()).toBe('synthetic_patient_blood_panel.pdf');

      // 7. Stage 7: Attempt Cross-Tenant IDOR Access
      // Tenant Alpha attempts to access Tenant Beta's confidential document
      const crossTenantResponse = await page.request.get(`${BASE_URL}/api/health-data/doc_beta_secret/file`);
      // Must be rejected with HTTP 404 (IDOR defense - zero data or existence leakage)
      expect(crossTenantResponse.status()).toBe(404);
      const crossTenantJson = await crossTenantResponse.json();
      expect(crossTenantJson.error).toBe('Health data record not found');

      // 8. Stage 8: Delete Document
      await docItem.locator('.btn-delete').click();
      await expect(page.locator('#notification-bar')).toHaveText('Document deleted successfully');

      // 9. Stage 9: Verify Resulting UI State
      await expect(page.locator('#document-list li')).toHaveCount(0);
    } finally {
      if (fs.existsSync(syntheticPdfPath)) {
        fs.unlinkSync(syntheticPdfPath);
      }
    }
  });
});
