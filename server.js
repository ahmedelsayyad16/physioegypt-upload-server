/**
 * سيرفر رفع ملفات بسيط -> Google Drive
 * ------------------------------------
 * - بياخد ملف من الأدمن (multipart/form-data, حقل اسمه "file")
 * - بيرفعه على Drive الشخصي باستخدام OAuth2 (Client ID + Client Secret + Refresh Token)
 *   بمعنى إن الرفع بيتم "بالنيابة عن" حسابك الشخصي، فبيستخدم مساحة التخزين بتاعتك انت
 * - بيرجع رابط الملف على Drive
 *
 * محتاج تعمل له deploy على استضافة زي Render.com (Web Service) أو Bonto.
 */

const express = require('express');
const multer = require('multer');
const { google } = require('googleapis');
const cors = require('cors');
const fs = require('fs');
const os = require('os');
const path = require('path');

const app = express();

// اسمح لأي origin يكلم السيرفر (الموقع بتاعنا بيبعت من دومين تاني)
app.use(cors());

// حد أقصى لحجم الملف (عدّله لو عايز، بالـ MB)
const MAX_FILE_SIZE_MB = Number(process.env.MAX_FILE_SIZE_MB || 100);

// بيتكتب الملف على القرص مؤقتًا بدل ما يتحمّل كامل في الذاكرة (RAM)
// ده مهم جدًا في كونتينرات مساحة الذاكرة فيها محدودة (زي Bonto) عشان
// ملفات الـ 20-50 ميجا متعملش crash للسيرفر (Out Of Memory)
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, os.tmpdir()),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${path.extname(file.originalname)}`),
  }),
  limits: { fileSize: MAX_FILE_SIZE_MB * 1024 * 1024 },
});

const PORT = process.env.PORT || 3000;

// آي دي مجلد Drive الافتراضي (لو الطلب مبعتش folderId بيستخدم ده)
const DEFAULT_DRIVE_FOLDER_ID = process.env.DRIVE_FOLDER_ID || '';

// سر بسيط لحماية السيرفر من إن أي حد غريب يستخدمه (اختياري بس متنصوح بيه)
const UPLOAD_SECRET = process.env.UPLOAD_SECRET || '';

function getDriveClient() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('MISSING_OAUTH_ENV');
  }

  const auth = new google.auth.OAuth2(clientId, clientSecret);
  auth.setCredentials({ refresh_token: refreshToken });

  // بدون timeout، أي تعطل في الاتصال بجوجل بيخلي الطلب يفضل معلق للأبد
  // من غير أي خطأ ظاهر. الـ timeout ده بيضمن إن السيرفر يطلع خطأ واضح
  // بعد 6 دقايق كحد أقصى بدل ما يقف من غير رد.
  return google.drive({ version: 'v3', auth, timeout: 360000 });
}

app.get('/', (req, res) => {
  res.send('✅ Drive upload server is running');
});

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

app.post('/upload/init', express.json(), async (req, res) => {
  try {
    if (UPLOAD_SECRET) {
      const sentSecret = req.headers['x-upload-secret'];
      if (sentSecret !== UPLOAD_SECRET) {
        return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
      }
    }

    const { fileName, mimeType, folderId } = req.body || {};
    if (!fileName) {
      return res.status(400).json({ ok: false, error: 'NO_FILENAME' });
    }

    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
    if (!clientId || !clientSecret || !refreshToken) {
      throw new Error('MISSING_OAUTH_ENV');
    }

    const auth = new google.auth.OAuth2(clientId, clientSecret);
    auth.setCredentials({ refresh_token: refreshToken });
    const { token: accessToken } = await auth.getAccessToken();

    const metadata = { name: fileName };
    const finalFolderId = folderId || DEFAULT_DRIVE_FOLDER_ID;
    if (finalFolderId) metadata.parents = [finalFolderId];

    // بنطلب من جوجل "جلسة رفع" (resumable session) — الملف نفسه هيتبعت
    // من المتصفح مباشرة على اللينك ده، مش عن طريق سيرفرنا خالص
    const initResp = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': mimeType || 'application/octet-stream',
      },
      body: JSON.stringify(metadata),
    });

    if (!initResp.ok) {
      const text = await initResp.text();
      console.error('[upload/init] فشل إنشاء الجلسة:', initResp.status, text);
      throw new Error('DRIVE_INIT_FAILED');
    }

    const uploadUrl = initResp.headers.get('location');
    return res.json({ ok: true, uploadUrl });
  } catch (err) {
    console.error('[upload/init] error:', err && err.message);
    if (err.message === 'MISSING_OAUTH_ENV') {
      return res.status(500).json({ ok: false, error: 'SERVER_MISCONFIGURED' });
    }
    return res.status(500).json({ ok: false, error: 'UPLOAD_INIT_FAILED', message: err.message });
  }
});

app.post('/upload/finish', express.json(), async (req, res) => {
  try {
    if (UPLOAD_SECRET) {
      const sentSecret = req.headers['x-upload-secret'];
      if (sentSecret !== UPLOAD_SECRET) {
        return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
      }
    }

    const { fileId } = req.body || {};
    if (!fileId) {
      return res.status(400).json({ ok: false, error: 'NO_FILE_ID' });
    }

    const drive = getDriveClient();

    // خلي أي حد معاه اللينك يقدر يشوف/يحمّل الملف
    await drive.permissions.create({
      fileId,
      requestBody: { role: 'reader', type: 'anyone' },
    });

    const directDownloadUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;
    const viewUrl = `https://drive.google.com/file/d/${fileId}/view`;

    return res.json({ ok: true, fileId, url: viewUrl, directUrl: directDownloadUrl });
  } catch (err) {
    console.error('[upload/finish] error:', err && err.message);
    return res.status(500).json({ ok: false, error: 'UPLOAD_FINISH_FAILED', message: err.message });
  }
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

    const fileMetadata = {
      name: req.file.originalname,
    };
    if (folderId) fileMetadata.parents = [folderId];

    const media = {
      mimeType: req.file.mimetype || 'application/octet-stream',
      body: fs.createReadStream(req.file.path),
    };

    console.log(`[upload] بدأ رفع "${req.file.originalname}" (${(req.file.size / 1024 / 1024).toFixed(1)} MB) إلى Drive...`);
    const uploadStartedAt = Date.now();

    let created;
    try {
      created = await drive.files.create({
        requestBody: fileMetadata,
        media,
        fields: 'id, name, webViewLink, webContentLink',
      });
    } finally {
      // امسح الملف المؤقت من القرص سواء نجح الرفع أو فشل
      fs.unlink(req.file.path, () => { });
    }

    console.log(`[upload] خلص الرفع لـ Drive بعد ${((Date.now() - uploadStartedAt) / 1000).toFixed(1)} ثانية`);

    const fileId = created.data.id;

    // خلي أي حد معاه اللينك يقدر يشوف/يحمّل الملف
    await drive.permissions.create({
      fileId,
      requestBody: { role: 'reader', type: 'anyone' },
    });
    console.log(`[upload] تم ضبط الصلاحيات، الملف جاهز: ${fileId}`);

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
    if (err.message === 'MISSING_OAUTH_ENV') {
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
