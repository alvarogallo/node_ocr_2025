const express = require('express');
const multer = require('multer');
const Tesseract = require('tesseract.js');
const cors = require('cors');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
require('dotenv').config();
const { createAdminRouter } = require('./admin');

const app = express();
const PORT = process.env.PORT || 3000;
const API_TOKEN = process.env.API_TOKEN;
// Directorio temporal para las imágenes (se borran tras el OCR); /tmp siempre es escribible en el contenedor
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(os.tmpdir(), 'ocr-uploads');

// Middlewares
app.use(cors());
app.use(express.json());

// Servir archivos estáticos (incluyendo index.html)
app.use(express.static(path.join(__dirname, 'public')));

// Middleware de autenticación
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN
  
  // También permitir token en query parameter para facilidad de uso
  const queryToken = req.query.token;
  const finalToken = token || queryToken;

  if (!finalToken) {
    return res.status(401).json({ 
      error: 'Token de acceso requerido',
      message: 'Envía el token en el header Authorization: Bearer TOKEN o como query parameter ?token=TOKEN'
    });
  }

  if (finalToken !== API_TOKEN) {
    return res.status(403).json({ 
      error: 'Token inválido',
      message: 'El token proporcionado no es válido'
    });
  }

  next();
};

// Configuración de multer para subida de archivos
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    fs.ensureDirSync(UPLOADS_DIR);
    cb(null, UPLOADS_DIR);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB máximo
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif|bmp|webp|tiff/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);

    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error('Solo se permiten archivos de imagen'));
    }
  }
});

// Ruta API para información del servicio
app.get('/api', (req, res) => {
  res.json({
    message: 'Servicio OCR con Tesseract.js',
    version: '1.0.0',
    authentication: 'Requerida para endpoints de procesamiento',
    endpoints: {
      'GET /': 'Página de documentación',
      'GET /api': 'Información del servicio (público)',
      'POST /extract-text': 'Extrae texto de una imagen (requiere token)',
      'POST /extract-text-advanced': 'Extrae texto con opciones avanzadas (requiere token)',
      'GET /validate-token': 'Validar token (requiere token)'
    },
    usage: {
      'header': 'Authorization: Bearer YOUR_TOKEN',
      'query': '?token=YOUR_TOKEN'
    },
    contact: 'admin@unatecla.us'
  });
});

// Endpoint para validar token
app.get('/validate-token', authenticateToken, (req, res) => {
  res.json({
    valid: true,
    message: 'Token válido',
    timestamp: new Date().toISOString()
  });
});

// Ruta básica para extraer texto (PROTEGIDA)
app.post('/extract-text', authenticateToken, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No se proporcionó ninguna imagen' });
    }

    console.log(`Procesando imagen: ${req.file.filename}`);

    // Procesar imagen con Tesseract
    const result = await Tesseract.recognize(
      req.file.path,
      process.env.DEFAULT_LANGUAGE || 'spa+eng',
      {
        logger: m => console.log(m)
      }
    );

    // Limpiar archivo temporal
    await fs.remove(req.file.path);

    res.json({
      success: true,
      text: result.data.text,
      confidence: result.data.confidence,
      processingTime: result.data.text ? 'Completado' : 'Sin texto detectado'
    });

  } catch (error) {
    console.error('Error procesando imagen:', error);
    
    // Limpiar archivo temporal en caso de error
    if (req.file && req.file.path) {
      await fs.remove(req.file.path).catch(console.error);
    }

    res.status(500).json({
      success: false,
      error: 'Error procesando la imagen',
      details: error.message
    });
  }
});

// Ruta avanzada con más opciones (PROTEGIDA)
app.post('/extract-text-advanced', authenticateToken, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No se proporcionó ninguna imagen' });
    }

    const { language = process.env.DEFAULT_LANGUAGE || 'spa+eng', psm = process.env.DEFAULT_PSM || '6' } = req.body;

    console.log(`Procesando imagen avanzada: ${req.file.filename}`);

    const result = await Tesseract.recognize(
      req.file.path,
      language,
      {
        logger: m => console.log(m),
        tessedit_pageseg_mode: psm,
        tessedit_char_whitelist: req.body.whitelist || undefined
      }
    );

    // Limpiar archivo temporal
    await fs.remove(req.file.path);

    res.json({
      success: true,
      text: result.data.text,
      confidence: result.data.confidence,
      words: result.data.words?.length || 0,
      lines: result.data.lines?.length || 0,
      paragraphs: result.data.paragraphs?.length || 0,
      metadata: {
        language: language,
        psm: psm,
        originalFilename: req.file.originalname,
        fileSize: req.file.size
      }
    });

  } catch (error) {
    console.error('Error procesando imagen:', error);
    
    if (req.file && req.file.path) {
      await fs.remove(req.file.path).catch(console.error);
    }

    res.status(500).json({
      success: false,
      error: 'Error procesando la imagen',
      details: error.message
    });
  }
});

// Página de administración (requiere login con la API central)
app.use('/alvarogallo', createAdminRouter({ uploadsDir: UPLOADS_DIR }));

// Manejo de errores de multer
app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'El archivo es demasiado grande (máximo 10MB)' });
    }
  }
  
  if (error.message === 'Solo se permiten archivos de imagen') {
    return res.status(400).json({ error: error.message });
  }

  console.error(`Error en ${req.method} ${req.originalUrl}:`, error);
  res.status(500).json({ error: 'Error interno del servidor' });
});

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`🚀 Servidor OCR ejecutándose en http://localhost:${PORT}`);
  console.log(`📁 Directorio de uploads: ${UPLOADS_DIR}`);
  console.log(`🌐 Página principal: http://localhost:${PORT}`);
  console.log(`📡 API info: http://localhost:${PORT}/api`);
});