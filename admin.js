const express = require('express');
const crypto = require('crypto');
const os = require('os');

// Página de administración /alvarogallo, protegida con el login central de unatecla
const BASE = '/alvarogallo';
const LOGIN_API = process.env.LOGIN_API_URL || 'https://apis.unatecla.com/api/login_mis_sitios';
const LOGIN_DESTINO = process.env.LOGIN_DESTINO || 'UNATECLA';
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || 'alvarogallo@hotmail.com,alvarogallo@gmail.com,alvarogallo@yahoo.com')
  .split(',')
  .map(e => e.trim().toLowerCase())
  .filter(Boolean);
const COOKIE_NAME = 'ocr_admin';
const SESSION_MAX_MS = 12 * 60 * 60 * 1000; // 12 horas (o menos si el token vence antes)

// Sesiones en memoria: se pierden al reiniciar el contenedor (hay que volver a entrar)
const sessions = new Map();

const getCookie = (req, name) => {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
};

const setSessionCookie = (req, res, value, maxAgeMs) => {
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  const attrs = [
    `${COOKIE_NAME}=${encodeURIComponent(value)}`,
    `Path=${BASE}`,
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`
  ];
  if (secure) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
};

const getSession = (req) => {
  const id = getCookie(req, COOKIE_NAME);
  const session = id && sessions.get(id);
  if (!session) return null;
  if (Date.now() > session.expiresAt) {
    sessions.delete(id);
    return null;
  }
  return { id, ...session };
};

const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const layout = (title, body) => `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="robots" content="noindex, nofollow">
  <title>${escapeHtml(title)}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      color: #333;
      padding: 40px 16px;
    }
    .card {
      max-width: 720px;
      margin: 0 auto;
      background: white;
      border-radius: 12px;
      padding: 32px;
      box-shadow: 0 10px 30px rgba(0,0,0,0.2);
    }
    .card.narrow { max-width: 400px; }
    h1 { font-size: 1.6rem; margin-bottom: 8px; }
    .sub { color: #666; margin-bottom: 24px; }
    label { display: block; font-weight: 600; margin: 16px 0 6px; }
    input {
      width: 100%;
      padding: 10px 12px;
      border: 1px solid #ccc;
      border-radius: 8px;
      font-size: 1rem;
    }
    button {
      margin-top: 24px;
      width: 100%;
      padding: 12px;
      border: none;
      border-radius: 8px;
      background: #667eea;
      color: white;
      font-size: 1rem;
      font-weight: 600;
      cursor: pointer;
    }
    button:hover { background: #5a6fd8; }
    .error {
      background: #fdecea;
      color: #b3261e;
      border-radius: 8px;
      padding: 10px 12px;
      margin-bottom: 8px;
    }
    .top { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; flex-wrap: wrap; }
    .top form button { width: auto; margin-top: 0; padding: 8px 16px; background: #888; }
    table { width: 100%; border-collapse: collapse; margin-top: 16px; }
    th, td { text-align: left; padding: 10px 8px; border-bottom: 1px solid #eee; word-break: break-word; }
    th { width: 40%; color: #555; font-weight: 600; }
  </style>
</head>
<body>
${body}
</body>
</html>`;

const loginPage = (error = '', email = '') => layout('Admin OCR - Login', `
  <div class="card narrow">
    <h1>🔐 Administración OCR</h1>
    <p class="sub">Acceso restringido</p>
    ${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}
    <form method="post" action="${BASE}/login">
      <label for="email">Email</label>
      <input id="email" name="email" type="email" autocomplete="username" required value="${escapeHtml(email)}">
      <label for="password">Contraseña</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required minlength="4" maxlength="255">
      <button type="submit">Entrar</button>
    </form>
  </div>`);

const formatBytes = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

const formatUptime = (seconds) => {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${d}d ${h}h ${m}m`;
};

const adminPage = (session, uploadsDir) => {
  const mem = process.memoryUsage();
  const rows = [
    ['Usuario', `${session.user.nombre || ''} ${session.user.apellido || ''} (${session.user.email})`],
    ['Sesión vence', new Date(session.expiresAt).toLocaleString('es-CO', { timeZone: 'America/Bogota' })],
    ['Servidor activo desde hace', formatUptime(process.uptime())],
    ['Node.js', process.version],
    ['Memoria (RSS)', formatBytes(mem.rss)],
    ['Memoria del sistema libre', `${formatBytes(os.freemem())} de ${formatBytes(os.totalmem())}`],
    ['Idioma OCR por defecto', process.env.DEFAULT_LANGUAGE || 'spa+eng'],
    ['PSM por defecto', process.env.DEFAULT_PSM || '6'],
    ['Directorio temporal', uploadsDir],
    ['Token de API configurado', process.env.API_TOKEN ? 'Sí' : 'No ⚠️']
  ];

  return layout('Admin OCR', `
  <div class="card">
    <div class="top">
      <div>
        <h1>🛠️ Administración OCR</h1>
        <p class="sub">Estado del servicio</p>
      </div>
      <form method="post" action="${BASE}/logout"><button type="submit">Salir</button></form>
    </div>
    <table>
      ${rows.map(([k, v]) => `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`).join('')}
    </table>
  </div>`);
};

const loginErrorMessage = (status, message) => {
  switch (status) {
    case 401: return 'Email o contraseña incorrectos';
    case 403: return 'Este servidor no está autorizado en la API de login (IP no registrada)';
    case 429: return 'Demasiados intentos fallidos. Espera un minuto e inténtalo de nuevo';
    case 422: return 'Datos inválidos';
    default: return message || 'No se pudo iniciar sesión';
  }
};

const createAdminRouter = ({ uploadsDir }) => {
  const router = express.Router();
  router.use(express.urlencoded({ extended: false }));

  // Nunca cachear las páginas de administración
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  router.get('/', (req, res) => {
    const session = getSession(req);
    if (!session) return res.send(loginPage());
    res.send(adminPage(session, uploadsDir));
  });

  router.post('/login', async (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');

    // Filtrar antes de llamar a la API: no gastar el límite de 5 intentos/minuto con emails no permitidos
    if (!ADMIN_EMAILS.includes(email)) {
      return res.status(403).send(loginPage('Acceso no permitido para este usuario', email));
    }
    if (password.length < 4 || password.length > 255) {
      return res.status(400).send(loginPage('La contraseña debe tener entre 4 y 255 caracteres', email));
    }

    try {
      const body = { destino: LOGIN_DESTINO, email, password };
      // Solo para desarrollo local: en producción la API valida la IP del servidor
      if (process.env.LOGIN_CLAVE_PRUEBAS) body.clave_pruebas = process.env.LOGIN_CLAVE_PRUEBAS;

      const response = await fetch(`${LOGIN_API}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000)
      });
      const json = await response.json().catch(() => ({}));

      if (!response.ok || !json.success || !json.data?.token) {
        console.warn(`Login admin fallido (${response.status}) para ${email}: ${json.message || ''}`);
        return res.status(401).send(loginPage(loginErrorMessage(response.status, json.message), email));
      }

      const { user = {}, token, expires_at: expiresAtIso } = json.data;
      // La API central puede devolver el hash de la contraseña: descartarlo
      delete user.password;

      // Verificar también el usuario que devolvió la API, no solo lo que se escribió
      if (!ADMIN_EMAILS.includes(String(user.email || '').toLowerCase())) {
        return res.status(403).send(loginPage('Acceso no permitido para este usuario', email));
      }

      const tokenExpiresAt = Date.parse(expiresAtIso) || Infinity;
      const expiresAt = Math.min(Date.now() + SESSION_MAX_MS, tokenExpiresAt);
      const id = crypto.randomBytes(32).toString('hex');
      sessions.set(id, {
        user: { id: user.id, email: user.email, nombre: user.nombre, apellido: user.apellido },
        token,
        expiresAt
      });

      console.log(`Login admin correcto: ${user.email}`);
      setSessionCookie(req, res, id, expiresAt - Date.now());
      res.redirect(303, BASE);
    } catch (error) {
      console.error('Error llamando a la API de login:', error);
      res.status(502).send(loginPage('No se pudo contactar con el servicio de login', email));
    }
  });

  router.post('/logout', async (req, res) => {
    const session = getSession(req);
    if (session) {
      sessions.delete(session.id);
      // Revocar el token en la API central (si falla, la sesión local ya está cerrada)
      fetch(`${LOGIN_API}/logout`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${session.token}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(10000)
      }).catch(error => console.error('Error revocando token:', error.message));
    }
    setSessionCookie(req, res, '', 0);
    res.redirect(303, BASE);
  });

  return router;
};

module.exports = { createAdminRouter };
