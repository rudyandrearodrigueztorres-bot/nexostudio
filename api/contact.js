// =========================================================================
// NEXO STUDIO — ENDPOINT SERVERLESS DE CONTACTO (/api/contact)
// Compatible con Vercel Serverless Functions & Node.js
// =========================================================================

const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');

// Cargar variables de .env si existe en disco (desarrollo local o servidor Node)
(function loadEnvFile() {
  try {
    const envPath = path.resolve(process.cwd(), '.env');
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, 'utf8');
      content.split('\n').forEach(line => {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
          const idx = trimmed.indexOf('=');
          const key = trimmed.substring(0, idx).trim();
          let val = trimmed.substring(idx + 1).trim();
          if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.substring(1, val.length - 1);
          }
          if (key && !process.env[key]) {
            process.env[key] = val;
          }
        }
      });
    }
  } catch (err) {
    // Silencioso si no se puede leer el archivo .env
  }
})();

// Almacén en memoria para limitación de tasa (5 envíos por hora por IP)
const ipRateLimitMap = new Map();

function isRateLimited(ip) {
  // En desarrollo local no bloquear localhost / 127.0.0.1 / ::1 para permitir pruebas
  if (ip === '127.0.0.1' || ip === '::1' || ip === 'localhost' || (typeof ip === 'string' && ip.startsWith('127.'))) {
    return false;
  }
  const now = Date.now();
  const ONE_HOUR = 60 * 60 * 1000;
  const record = ipRateLimitMap.get(ip) || { count: 0, resetTime: now + ONE_HOUR };

  if (now > record.resetTime) {
    record.count = 0;
    record.resetTime = now + ONE_HOUR;
  }

  if (record.count >= 5) {
    return true;
  }

  record.count += 1;
  ipRateLimitMap.set(ip, record);
  return false;
}

function sanitizeText(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/[<>]/g, '').trim();
}

function validateEmail(email) {
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return re.test(String(email).toLowerCase());
}

function maskEmail(email) {
  if (!email || typeof email !== 'string' || !email.includes('@')) return '***';
  const parts = email.split('@');
  const user = parts[0];
  const domain = parts[1];
  const maskedUser = user.length > 2 ? user[0] + '***' + user[user.length - 1] : user[0] + '***';
  return `${maskedUser}@${domain}`;
}

async function sendMailWithRetry(transporter, mailOptions, maxRetries = 1, timeoutMs = 10000) {
  let lastErr = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const sendPromise = transporter.sendMail(mailOptions);
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Tiempo de espera SMTP agotado (10s)')), timeoutMs)
      );
      return await Promise.race([sendPromise, timeoutPromise]);
    } catch (err) {
      lastErr = err;
      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  }
  throw lastErr;
}

module.exports = async function handler(req, res) {
  // Solo permitir método POST
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ ok: false, error: 'Método no permitido. Solo se acepta POST.' });
  }

  // 1. Protección de Origen (CORS / Same-Origin)
  const host = req.headers.host || '';
  const origin = req.headers.origin || '';

  if (origin && !origin.includes(host) && !host.includes('localhost') && !origin.includes('localhost')) {
    return res.status(403).json({ ok: false, error: 'Acceso no autorizado desde este origen.' });
  }

  // 2. Limitación de tasa por IP
  const forwarded = req.headers['x-forwarded-for'];
  const ip = typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : req.socket.remoteAddress || 'unknown';

  if (isRateLimited(ip)) {
    console.warn(`[NEXO CONTACT] Límite de tasa excedido para IP ${ip.substring(0, 7)}...`);
    return res.status(429).json({
      ok: false,
      error: 'Has superado el límite de 5 envíos por hora. Por favor, inténtalo más tarde.'
    });
  }

  try {
    const body = req.body || {};

    // 3. Protección Honeypot (campo trampa)
    if (body.website_url && body.website_url.trim().length > 0) {
      console.log('[NEXO CONTACT] Honeypot activado por bot. Rechazo silencioso.');
      return res.status(200).json({ ok: true, success: true, message: 'Mensaje procesado' });
    }

    // 4. Tiempo mínimo de interacción (3 segundos)
    const formLoadedAt = Number(body.form_loaded_at);
    if (!formLoadedAt || (Date.now() - formLoadedAt < 3000)) {
      console.warn('[NEXO CONTACT] Intento de envío en menos de 3 segundos.');
      return res.status(400).json({
        ok: false,
        error: 'Envío demasiado rápido. Por favor, tómate unos segundos para revisar tu mensaje.'
      });
    }

    // 5. Extracción y sanitización de datos
    const recipientId = (body.recipient || 'general').toLowerCase();
    const name = sanitizeText(body.name);
    const email = sanitizeText(body.email);
    const phone = sanitizeText(body.phone);
    const service = sanitizeText(body.service || 'Website');
    const message = sanitizeText(body.message);
    const sourcePage = sanitizeText(body.source_page || 'NEXO STUDIO');
    const acceptedPrivacy = body.accepted_privacy === true || body.accepted_privacy === 'true' || body.privacy === true || body.privacy === 'true';

    // 6. Validaciones obligatorias
    if (!name || name.length > 100) {
      return res.status(400).json({ ok: false, error: 'Por favor, introduce un nombre válido (máx. 100 caracteres).' });
    }
    if (!email || !validateEmail(email) || email.length > 120) {
      return res.status(400).json({ ok: false, error: 'Por favor, introduce un correo electrónico válido.' });
    }
    if (phone && phone.length > 30) {
      return res.status(400).json({ ok: false, error: 'El número de teléfono no debe exceder 30 caracteres.' });
    }
    if (!message || message.length > 2000) {
      return res.status(400).json({ ok: false, error: 'Por favor, introduce un mensaje válido (entre 1 y 2000 caracteres).' });
    }
    if (!acceptedPrivacy) {
      return res.status(400).json({ ok: false, error: 'Debes aceptar la política de privacidad para enviar el formulario.' });
    }

    // 7. Traducción de destinatario en servidor
    const emailAndrea = process.env.CONTACT_TO_ANDREA || 'rudyandrearodrigueztorres@gmail.com';
    const emailMiguel = process.env.CONTACT_TO_MIGUEL || 'miguelangel160397@gmail.com';

    let toEmails = [];
    let recipientDisplayName = '';
    let visitorConfirmWho = '';
    let visitorReplyTo = '';

    if (recipientId === 'andrea') {
      toEmails = [emailAndrea];
      recipientDisplayName = 'Andrea';
      visitorConfirmWho = 'Andrea';
      visitorReplyTo = emailAndrea;
    } else if (recipientId === 'miguel') {
      toEmails = [emailMiguel];
      recipientDisplayName = 'Miguel';
      visitorConfirmWho = 'Miguel';
      visitorReplyTo = emailMiguel;
    } else {
      toEmails = [emailAndrea, emailMiguel];
      recipientDisplayName = 'el equipo';
      visitorConfirmWho = 'nuestro equipo';
      visitorReplyTo = `${emailAndrea}, ${emailMiguel}`;
    }

    const formattedDate = new Date().toLocaleString('es-ES', { timeZone: 'Europe/Madrid' });

    // 8. Verificación de credenciales SMTP
    const smtpUser = process.env.SMTP_USER;
    const smtpPass = process.env.SMTP_PASS;

    if (!smtpUser || !smtpPass) {
      console.error('[NEXO CONTACT] ERROR CRÍTICO: Faltan credenciales SMTP (SMTP_USER o SMTP_PASS no definidas).');
      return res.status(500).json({
        ok: false,
        error: 'Algo salió mal. Inténtalo de nuevo en unos minutos.'
      });
    }

    const transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true, // SSL en 465
      auth: {
        user: smtpUser,
        pass: smtpPass
      },
      connectionTimeout: 10000,
      socketTimeout: 10000
    });

    // 9. ENVÍO 1: Notificación al equipo (Obligatorio)
    const teamSubject = `[NEXO STUDIO] Nuevo mensaje para ${recipientDisplayName} – ${service}`;
    const teamTextBody = `
NEXO STUDIO — NUEVO CONTACTO
==================================================
Destinatario: ${recipientDisplayName}
Servicio:     ${service}
Fecha:        ${formattedDate} (Madrid)
Origen:       ${sourcePage}

DATOS DEL CONTACTO:
Nombre:       ${name}
Correo:       ${email}
Teléfono:     ${phone || 'No especificado'}

MENSAJE:
${message}
==================================================
* Responde directamente a este correo para contestar a ${name}.
    `.trim();

    const teamHtmlBody = `
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #F3F1ED; color: #12180F; margin: 0; padding: 24px; }
    .container { max-width: 600px; margin: 0 auto; background: #FFFFFF; border-radius: 20px; overflow: hidden; border: 1px solid rgba(18,24,15,0.12); box-shadow: 0 8px 24px rgba(18,24,15,0.06); }
    .header { background-color: #12180F; padding: 24px 32px; color: #FFFFFF; border-bottom: 3px solid #E6FF00; }
    .badge { background-color: #E6FF00; color: #12180F; font-size: 11px; font-weight: bold; padding: 4px 10px; border-radius: 9999px; text-transform: uppercase; display: inline-block; }
    .title { font-size: 20px; font-weight: 800; margin: 12px 0 0 0; color: #FFFFFF; }
    .body-content { padding: 32px; }
    .meta-table { width: 100%; border-collapse: collapse; margin-bottom: 24px; }
    .meta-table td { padding: 8px 0; border-bottom: 1px solid #F3F1ED; font-size: 14px; }
    .label { color: #6E6B5E; font-weight: 600; width: 130px; }
    .value { color: #12180F; font-weight: 600; }
    .message-box { background-color: #F8F7F4; padding: 20px; border-radius: 12px; font-size: 14px; line-height: 1.6; color: #3B4034; white-space: pre-wrap; border-left: 4px solid #E6FF00; }
    .footer { padding: 18px 32px; background-color: #FAFAFA; font-size: 12px; color: #6E6B5E; border-top: 1px solid #EEEEEE; text-align: center; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <span class="badge">NEXO STUDIO // NUEVO MENSAJE</span>
      <h1 class="title">Mensaje para ${recipientDisplayName}</h1>
    </div>
    <div class="body-content">
      <table class="meta-table">
        <tr><td class="label">Nombre:</td><td class="value">${name}</td></tr>
        <tr><td class="label">Correo:</td><td class="value">${email}</td></tr>
        <tr><td class="label">Teléfono:</td><td class="value">${phone || 'No especificado'}</td></tr>
        <tr><td class="label">Servicio:</td><td class="value">${service}</td></tr>
        <tr><td class="label">Página de origen:</td><td class="value">${sourcePage}</td></tr>
        <tr><td class="label">Fecha y hora:</td><td class="value">${formattedDate}</td></tr>
      </table>
      <div style="font-size: 12px; font-weight: 700; text-transform: uppercase; color: #6E6B5E; margin-bottom: 8px;">Mensaje recibido:</div>
      <div class="message-box">${message}</div>
    </div>
    <div class="footer">
      NEXO STUDIO • Responde a este correo para escribir directamente a ${name}.
    </div>
  </div>
</body>
</html>
    `.trim();

    try {
      await sendMailWithRetry(transporter, {
        from: `"NEXO STUDIO Contacto" <${smtpUser}>`,
        to: toEmails,
        replyTo: `"${name}" <${email}>`,
        subject: teamSubject,
        text: teamTextBody,
        html: teamHtmlBody
      });
      console.log(`[NEXO CONTACT] Notificación enviada con éxito al equipo (${recipientDisplayName}).`);
    } catch (teamMailErr) {
      console.error(`[NEXO CONTACT] Error enviando al equipo: ${teamMailErr.message || teamMailErr.code || 'Fallo SMTP'}`);
      return res.status(500).json({
        ok: false,
        error: 'Algo salió mal. Inténtalo de nuevo en unos minutos.'
      });
    }

    // 10. ENVÍO 2: Confirmación automática al visitante (Nuevo requerimiento)
    const visitorSubject = 'Recibimos tu mensaje – NEXO STUDIO';
    const visitorTextBody = `
Hola ${name}, ¡gracias por escribirnos!

${visitorConfirmWho} recibió tu mensaje y te responderá pronto.

RESUMEN DE TU MENSAJE:
----------------------------------------
Servicio de interés: ${service}
Mensaje:
${message}
----------------------------------------

Si quieres añadir algo más, responde directamente a este correo.

NEXO STUDIO
Diseño web, identidad visual y estrategia digital
    `.trim();

    const visitorHtmlBody = `
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <title>Recibimos tu mensaje – NEXO STUDIO</title>
</head>
<body style="margin: 0; padding: 32px 16px; background-color: #CFC8B8; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #12180F;">
  <div style="max-width: 560px; margin: 0 auto; background-color: #FFFFFF; border-radius: 20px; overflow: hidden; box-shadow: 0 4px 20px rgba(18,24,15,0.08); border: 1px solid rgba(18,24,15,0.1);">
    
    <!-- Cabecera de marca con acento neón -->
    <div style="background-color: #12180F; padding: 24px 32px; border-bottom: 3px solid #E6FF00;">
      <span style="font-size: 20px; font-weight: 900; letter-spacing: -0.5px; color: #FFFFFF; display: inline-block;">
        NEXO <span style="background-color: #E6FF00; color: #12180F; padding: 2px 8px; border-radius: 6px; font-size: 15px;">STUDIO</span>
      </span>
    </div>

    <!-- Cuerpo -->
    <div style="padding: 32px;">
      <h1 style="font-size: 22px; font-weight: 800; margin: 0 0 16px 0; color: #12180F; line-height: 1.25;">
        Hola ${name}, ¡gracias por escribirnos!
      </h1>
      <p style="font-size: 15px; line-height: 1.6; color: #3B4034; margin: 0 0 20px 0;">
        ${visitorConfirmWho} recibió tu mensaje y te responderá pronto.
      </p>

      <!-- Resumen del mensaje -->
      <div style="background-color: #F8F7F4; border-left: 4px solid #E6FF00; border-radius: 12px; padding: 20px; margin: 24px 0;">
        <span style="font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; color: #6E6B5E; display: block; margin-bottom: 10px;">
          Resumen de tu mensaje
        </span>
        <p style="font-size: 13px; margin: 0 0 8px 0; color: #12180F;">
          <strong>Servicio:</strong> ${service}
        </p>
        <p style="font-size: 13px; margin: 0; color: #12180F; white-space: pre-wrap; line-height: 1.5;">
          <strong>Mensaje:</strong><br>${message}
        </p>
      </div>

      <p style="font-size: 14px; line-height: 1.6; color: #3B4034; margin: 0 0 24px 0;">
        Si quieres añadir algo más, responde directamente a este correo.
      </p>

      <div style="border-top: 1px solid #EAE7E0; padding-top: 20px; margin-top: 20px;">
        <p style="font-size: 14px; font-weight: 700; color: #12180F; margin: 0;">
          NEXO STUDIO
        </p>
        <p style="font-size: 12px; color: #6E6B5E; margin: 4px 0 0 0;">
          Diseño web, identidad visual y estrategia digital
        </p>
      </div>
    </div>

  </div>
</body>
</html>
    `.trim();

    try {
      await sendMailWithRetry(transporter, {
        from: `"NEXO STUDIO" <${smtpUser}>`,
        to: email,
        replyTo: visitorReplyTo,
        subject: visitorSubject,
        text: visitorTextBody,
        html: visitorHtmlBody
      });
      console.log(`[NEXO CONTACT] Confirmación enviada con éxito al visitante (${maskEmail(email)}).`);
    } catch (visitorMailErr) {
      // Si falla solo la confirmación al visitante, se registra el fallo pero NO se rechaza al usuario
      console.warn(`[NEXO CONTACT] Aviso: Notificación al equipo enviada, pero falló confirmación a visitante (${maskEmail(email)}): ${visitorMailErr.message || 'Fallo SMTP'}`);
    }

    // 11. Respuesta exitosa confirmada
    return res.status(200).json({
      ok: true,
      success: true,
      message: `¡Listo! Recibimos tu mensaje y ${visitorConfirmWho} te responderá pronto.`
    });

  } catch (error) {
    console.error('[NEXO CONTACT] Error inesperado en el servidor:', error.message || error);
    return res.status(500).json({
      ok: false,
      error: 'Algo salió mal. Inténtalo de nuevo en unos minutos.'
    });
  }
};
