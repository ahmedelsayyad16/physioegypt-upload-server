/**
 * سيرفر رفع ملفات بسيط -> Google Drive
 * ------------------------------------
 * - بياخد ملف من الأدمن (multipart/form-data, حقل اسمه "file")
 * - بيرفعه هو بنفسه على Drive باستخدام Service Account (من غير ما الأدمن
 *   يعمل تسجيل دخول Google تاني ومن غير ما يدّي صلاحية Drive لحسابه الشخصي)
 * - بيرجع رابط الملف على Drive
 *
 * محتاج تعمل له deploy على استضافة مجانية زي Render.com (Web Service).
 */

const express = require('express');
const multer = require('multer');
const { google } = require('googleapis');
const cors = require('cors');
const stream = require('stream');

const app = express();

// اسمح لأي origin يكلم السيرفر (الموقع بتاعنا بيبعت من دومين تاني)
app.use(cors());

// حد أقصى لحجم الملف (عدّله لو عايز، بالـ MB)
const MAX_FILE_SIZE_MB = Number(process.env.MAX_FILE_SIZE_MB || 100);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE_MB * 1024 * 1024 },
});

const PORT = process.env.PORT || 3000;

// آي دي مجلد Drive الافتراضي (لو الطلب مبعتش folderId بيستخدم ده)
const DEFAULT_DRIVE_FOLDER_ID = process.env.DRIVE_FOLDER_ID || '';

// سر بسيط لحماية السيرفر من إن أي حد غريب يستخدمه (اختياري بس متنصوح بيه)
const UPLOAD_SECRET = process.env.UPLOAD_SECRET || '';

function getDriveClient() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) {
    throw new Error('MISSING_SERVICE_ACCOUNT_ENV');
  }
  let credentials;
  try {
    credentials = JSON.parse(raw);
  } catch (e) {
    throw new Error('INVALID_SERVICE_ACCOUNT_JSON');
  }
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  return google.drive({ version: 'v3', auth });
}

app.get('/', (req, res) => {
  res.send('✅ Drive upload server is running');
});

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

app.post('/upload', upload.single('file'), async (req, res) => {
  try {
    // تحقق من السر لو مفعّل
    if (UPLOAD_SECRET) {
      const sentSecret = req.headers['x-upload-secret'] || req.body.secret;
      if (sentSecret !== UPLOAD_SECRET) {
        return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
      }
    }

    if (!req.file) {
      return res.status(400).json({ ok: false, error: 'NO_FILE' });
    }

    const folderId = req.body.folderId || DEFAULT_DRIVE_FOLDER_ID;

    const drive = getDriveClient();

    const bufferStream = new stream.PassThrough();
    bufferStream.end(req.file.buffer);

    const fileMetadata = {
      name: req.file.originalname,
    };
    if (folderId) fileMetadata.parents = [folderId];

    const media = {
      mimeType: req.file.mimetype || 'application/octet-stream',
      body: bufferStream,
    };

    const created = await drive.files.create({
      requestBody: fileMetadata,
      media,
      fields: 'id, name, webViewLink, webContentLink',
      supportsAllDrives: true,
    });

    const fileId = created.data.id;

    // خلي أي حد معاه اللينك يقدر يشوف/يحمّل الملف
    await drive.permissions.create({
      fileId,
      requestBody: { role: 'reader', type: 'anyone' },
      supportsAllDrives: true,
    });

    const directDownloadUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;
    const viewUrl = created.data.webViewLink || `https://drive.google.com/file/d/${fileId}/view`;

    return res.json({
      ok: true,
      fileId,
      fileName: created.data.name,
      url: viewUrl,
      directUrl: directDownloadUrl,
    });
  } catch (err) {
    console.error('Upload error:', err && err.message, err);
    if (err.message === 'MISSING_SERVICE_ACCOUNT_ENV' || err.message === 'INVALID_SERVICE_ACCOUNT_JSON') {
      return res.status(500).json({ ok: false, error: 'SERVER_MISCONFIGURED' });
    }
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ ok: false, error: 'FILE_TOO_LARGE' });
    }
    return res.status(500).json({ ok: false, error: 'UPLOAD_FAILED', message: err.message });
  }
});

// Multer errors (زي تجاوز حجم الملف) بتتلقط هنا لو حصلت قبل الـ handler
app.use((err, req, res, next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ ok: false, error: 'FILE_TOO_LARGE' });
  }
  console.error(err);
  return res.status(500).json({ ok: false, error: 'SERVER_ERROR' });
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
