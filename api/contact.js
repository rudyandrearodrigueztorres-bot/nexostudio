// =========================================================================
// NEXO STUDIO — ENDPOINT SERVERLESS DE CONTACTO (/api/contact)
// Compatible con Vercel Serverless Functions & Node.js
// =========================================================================

const nodemailer = require('nodemailer');

// Almacén en memoria para limitación de tasa (5 envíos por hora por IP)
const ipRateLimitMap = new Map();

function isRateLimited(ip) {
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
  return str
    .replace(/[<>]/g, '') // Elimina etiquetas HTML
    .trim();
}

function validateEmail(email) {
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return re.test(String(email).toLowerCase());
}

module.exports = async function handler(req, res) {
  // Solo permitir método POST
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: 'Método no permitido. Solo se acepta POST.' });
  }

  // 1. Protección de Origen (CORS / Same-Origin)
  const host = req.headers.host || '';
  const origin = req.headers.origin || '';
  const referer = req.headers.referer || '';

  if (origin && !origin.includes(host) && !host.includes('localhost')) {
    return res.status(403).json({ error: 'Acceso no autorizado desde este origen.' });
  }

  // 2. Limitación de tasa por IP
  const forwarded = req.headers['x-forwarded-for'];
  const ip = typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : req.socket.remoteAddress || 'unknown';

  if (isRateLimited(ip)) {
    return res.status(429).json({
      error: 'Has superado el límite de 5 envíos por hora. Por favor, inténtalo más tarde.'
    });
  }

  try {
    const body = req.body || {};

    // 3. Protección Honeypot (campo trampa)
    if (body.website_url && body.website_url.trim().length > 0) {
      // Rechazo silencioso a bots
      return res.status(200).json({ success: true, message: 'Mensaje procesado' });
    }

    // 4. Tiempo mínimo de interacción (3 segundos)
    const formLoadedAt = Number(body.form_loaded_at);
    if (!formLoadedAt || (Date.now() - formLoadedAt < 3000)) {
      return res.status(400).json({
        error: 'Envío demasiado rápido. Por favor, tómate unos segundos para revisar tu mensaje.'
      });
    }

    // 5. Extracción y sanitización de datos
    const recipientId = (body.recipient || 'general').toLowerCase();
    const name = sanitizeText(body.name);
    const email = sanitizeText(body.email);
    const phone = sanitizeText(body.phone);
    const service = sanitizeText(body.service || 'Consulta General');
    const message = sanitizeText(body.message);
    const sourcePage = sanitizeText(body.source_page || 'NEXO STUDIO');
    const acceptedPrivacy = body.accepted_privacy === true || body.accepted_privacy === 'true' || body.privacy === true || body.privacy === 'true';

    // 6. Validaciones obligatorias
    if (!name || name.length > 100) {
      return res.status(400).json({ error: 'Por favor, introduce un nombre válido (máx. 100 caracteres).' });
    }
    if (!email || !validateEmail(email) || email.length > 120) {
      return res.status(400).json({ error: 'Por favor, introduce un correo electrónico válido.' });
    }
    if (phone && phone.length > 30) {
      return res.status(400).json({ error: 'El número de teléfono no debe exceder 30 caracteres.' });
    }
    if (!message || message.length > 2000) {
      return res.status(400).json({ error: 'Por favor, introduce un mensaje válido (entre 1 y 2000 caracteres).' });
    }
    if (!acceptedPrivacy) {
      return res.status(400).json({ error: 'Debes aceptar la política de privacidad para enviar el formulario.' });
    }

    // 7. Traducción de destinatario segura en servidor (no expuesta en cliente)
    const emailAndrea = process.env.CONTACT_TO_ANDREA || 'rudyandrearodrigueztorres@gmail.com';
    const emailMiguel = process.env.CONTACT_TO_MIGUEL || 'miguelangel160397@gmail.com';

    let toEmails = [];
    let recipientDisplayName = '';

    if (recipientId === 'andrea') {
      toEmails = [emailAndrea];
      recipientDisplayName = 'Andrea';
    } else if (recipientId === 'miguel') {
      toEmails = [emailMiguel];
      recipientDisplayName = 'Miguel';
    } else {
      toEmails = [emailAndrea, emailMiguel];
      recipientDisplayName = 'el equipo';
    }

    const subject = `[NEXO STUDIO] Nuevo mensaje para ${recipientDisplayName} – ${service}`;
    const formattedDate = new Date().toLocaleString('es-ES', { timeZone: 'Europe/Madrid' });

    // Contenido en texto plano
    const textBody = `
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
* Puedes responder directamente a este correo (Reply-To configurado).
    `.trim();

    // Contenido en HTML enriquecido con diseño de marca
    const htmlBody = `
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; background-color: #F3F1ED; color: #12180F; margin: 0; padding: 24px; }
    .container { max-width: 600px; margin: 0 auto; background: #FFFFFF; border-radius: 20px; overflow: hidden; border: 1px solid rgba(18,24,15,0.12); box-shadow: 0 8px 24px rgba(18,24,15,0.06); }
    .header { background-color: #12180F; padding: 24px 32px; color: #FFFFFF; }
    .badge { background-color: #E6FF00; color: #12180F; font-size: 11px; font-weight: bold; padding: 4px 10px; border-radius: 9999px; text-transform: uppercase; display: inline-block; }
    .title { font-size: 20px; font-weight: 800; margin: 12px 0 0 0; color: #FFFFFF; }
    .body-content { padding: 32px; }
    .meta-table { width: 100%; border-collapse: collapse; margin-bottom: 24px; }
    .meta-table td { padding: 8px 0; border-bottom: 1px solid #F3F1ED; font-size: 14px; }
    .label { color: #6E6B5E; font-weight: 600; width: 120px; }
    .value { color: #12180F; font-weight: 600; }
    .message-box { background-color: #F3F1ED; padding: 20px; border-radius: 14px; font-size: 15px; line-height: 1.5; color: #3B4034; white-space: pre-wrap; border-left: 4px solid #E6FF00; }
    .footer { padding: 18px 32px; background-color: #FAFAFA; font-size: 12px; color: #6E6B5E; border-top: 1px solid #EEEEEE; text-align: center; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <span class="badge">NEXO STUDIO // NUEVO CONTACTO</span>
      <h1 class="title">Mensaje para ${recipientDisplayName}</h1>
    </div>
    <div class="body-content">
      <table class="meta-table">
        <tr>
          <td class="label">Remitente:</td>
          <td class="value">${name}</td>
        </tr>
        <tr>
          <td class="label">Correo:</td>
          <td class="value"><a href="mailto:${email}" style="color: #12180F;">${email}</a></td>
        </tr>
        <tr>
          <td class="label">Teléfono:</td>
          <td class="value">${phone || 'No proporcionado'}</td>
        </tr>
        <tr>
          <td class="label">Servicio:</td>
          <td class="value">${service}</td>
        </tr>
        <tr>
          <td class="label">Página origen:</td>
          <td class="value">${sourcePage}</td>
        </tr>
        <tr>
          <td class="label">Fecha y hora:</td>
          <td class="value">${formattedDate}</td>
        </tr>
      </table>

      <h3 style="font-size: 14px; text-transform: uppercase; color: #12180F; margin: 0 0 10px 0;">Mensaje del visitante:</h3>
      <div class="message-box">${message}</div>
    </div>
    <div class="footer">
      NEXO STUDIO • Responde directamente a este correo para escribir a ${name}.
    </div>
  </div>
</body>
</html>
    `.trim();

    // 8. Envío a través de SMTP si las credenciales están configuradas
    const smtpUser = process.env.SMTP_USER;
    const smtpPass = process.env.SMTP_PASS;

    if (smtpUser && smtpPass) {
      const transporter = nodemailer.createTransporter({
        service: 'gmail',
        auth: {
          user: smtpUser,
          pass: smtpPass
        }
      });

      await transporter.sendMail({
        from: `"NEXO STUDIO Contacto" <${smtpUser}>`,
        to: toEmails,
        replyTo: `"${name}" <${email}>`,
        subject: subject,
        text: textBody,
        html: htmlBody
      });

      console.log(`[SMTP] Correo enviado a: ${toEmails.join(', ')}`);
    } else {
      // Modo desarrollo / Sin credenciales aún configuradas
      console.log('==================================================');
      console.log('[API CONTACT - MODO DEMO / SIMULACIÓN]');
      console.log(`Destinatarios calculados: ${toEmails.join(', ')}`);
      console.log(`Asunto: ${subject}`);
      console.log(`De: ${name} <${email}>`);
      console.log(`Servicio: ${service}`);
      console.log(`Mensaje: ${message}`);
      console.log('NOTA: Configura SMTP_USER y SMTP_PASS en .env para envío real.');
      console.log('==================================================');
    }

    return res.status(200).json({
      success: true,
      message: '¡Listo! Recibimos tu mensaje y te responderemos pronto.'
    });

  } catch (error) {
    console.error('[API Contact Error]:', error);
    return res.status(500).json({
      error: 'Algo salió mal en el servidor. Por favor, inténtalo de nuevo en unos minutos.'
    });
  }
};
