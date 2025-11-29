const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.RESUME_AI_KEY;
const ROOT_DIR = __dirname;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf'
};

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

async function handleChatProxy(req, res, body) {
  let parsedBody;
  try {
    parsedBody = body ? JSON.parse(body) : {};
  } catch (error) {
    sendJson(res, 400, { error: 'Invalid JSON body.' });
    return;
  }

  const message = typeof parsedBody.message === 'string' ? parsedBody.message.trim() : '';
  if (!message) {
    sendJson(res, 400, { error: 'Message is required.' });
    return;
  }

  if (!API_KEY) {
    sendJson(res, 503, { error: 'AI assistant is unavailable. Please configure RESUME_AI_KEY on the server.' });
    return;
  }

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${API_KEY}`
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content:
              "You are a concise assistant for Jake Biddlecome's resume site. Keep replies under 120 words and speak in a confident, helpful tone."
          },
          { role: 'user', content: message }
        ]
      })
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const errorMessage = payload?.error?.message || 'AI request failed.';
      sendJson(res, response.status, { error: errorMessage });
      return;
    }

    const reply = payload?.choices?.[0]?.message?.content;
    sendJson(res, 200, {
      message: reply || "I wasn't able to find that answer—try another question or email Jake directly."
    });
  } catch (error) {
    sendJson(res, 502, { error: 'The AI is unavailable right now. Please try again shortly.' });
  }
}

function serveStaticFile(res, filePath) {
  fs.stat(filePath, (statError, stats) => {
    if (statError || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  const { method, url } = req;
  const [pathname] = (url || '/').split('?');

  if (method === 'POST' && pathname === '/api/chat') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1e6) {
        req.socket.destroy();
      }
    });

    req.on('end', () => handleChatProxy(req, res, body));
    return;
  }

  let safePath = path.normalize(decodeURIComponent(pathname)).replace(/^\/+/, '');
  if (!safePath || safePath === '.' || safePath === '..') {
    safePath = 'index.html';
  }

  const filePath = path.join(ROOT_DIR, safePath);
  if (!filePath.startsWith(ROOT_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  serveStaticFile(res, filePath);
});

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
