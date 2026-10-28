#!/usr/bin/env python3
"""
NEXO STUDIO — Servidor local dual
1. Sirve los archivos estáticos del sitio (HTML, CSS, JS, imágenes).
2. Procesa solicitudes POST en /api/contact con envío real mediante SMTP de Gmail,
   notificación al equipo, confirmación automática al visitante y protecciones anti-spam.
"""

import os
import sys
import json
import time
import smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from http.server import HTTPServer, SimpleHTTPRequestHandler
from datetime import datetime

# Cargar variables de entorno desde archivo .env si existe
def load_dotenv():
    env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.env')
    if os.path.isfile(env_path):
        try:
            with open(env_path, 'r', encoding='utf-8') as f:
                for line in f:
                    line = line.strip()
                    if line and not line.startswith('#') and '=' in line:
                        idx = line.find('=')
                        key = line[:idx].strip()
                        val = line[idx+1:].strip()
                        if (val.startswith('"') and val.endswith('"')) or (val.startswith("'") and val.endswith("'")):
                            val = val[1:-1]
                        if key and key not in os.environ:
                            os.environ[key] = val
            print(f"[NEXO SERVER] Variables cargadas desde {env_path}")
        except Exception as e:
            print(f"[NEXO SERVER] Error leyendo .env: {e}")

load_dotenv()

# Almacén de rate-limiting (máx 5 peticiones por hora por IP)
IP_REQUEST_LOGS = {}

def is_rate_limited(ip):
    # En desarrollo local no bloquear localhost / 127.0.0.1 / ::1 para permitir pruebas
    if ip in ('127.0.0.1', '::1', 'localhost') or (isinstance(ip, str) and ip.startswith('127.')):
        return False
    now = time.time()
    one_hour = 3600
    if ip not in IP_REQUEST_LOGS:
        IP_REQUEST_LOGS[ip] = []
    IP_REQUEST_LOGS[ip] = [t for t in IP_REQUEST_LOGS[ip] if now - t < one_hour]
    if len(IP_REQUEST_LOGS[ip]) >= 5:
        return True
    IP_REQUEST_LOGS[ip].append(now)
    return False

def sanitize(val):
    if not isinstance(val, str):
        return ""
    return val.replace('<', '').replace('>', '').strip()

def mask_email(email):
    if not email or '@' not in email:
        return '***'
    parts = email.split('@', 1)
    user = parts[0]
    domain = parts[1]
    masked = (user[0] + '***' + user[-1]) if len(user) > 2 else (user[0] + '***')
    return f"{masked}@{domain}"

def send_smtp_message(smtp_user, smtp_pass, from_addr, to_addrs, reply_to, subject, text_content, html_content, max_retries=1):
    msg = MIMEMultipart('alternative')
    msg['Subject'] = subject
    msg['From'] = from_addr
    msg['To'] = ", ".join(to_addrs) if isinstance(to_addrs, list) else to_addrs
    msg['Reply-To'] = reply_to
    msg.attach(MIMEText(text_content, 'plain', 'utf-8'))
    msg.attach(MIMEText(html_content, 'html', 'utf-8'))

    last_err = None
    target_recipients = to_addrs if isinstance(to_addrs, list) else [to_addrs]

    for attempt in range(max_retries + 1):
        try:
            # Conexión SSL en puerto 465 con timeout de 10s
            with smtplib.SMTP_SSL('smtp.gmail.com', 465, timeout=10) as server:
                server.login(smtp_user, smtp_pass)
                server.sendmail(smtp_user, target_recipients, msg.as_string())
            return True
        except Exception as err:
            last_err = err
            if attempt < max_retries:
                time.sleep(1)

    raise last_err

class NexoStudioHandler(SimpleHTTPRequestHandler):

    def send_json_response(self, status_code, data):
        payload = json.dumps(data).encode('utf-8')
        self.send_response(status_code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(payload)))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(payload)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def do_POST(self):
        if self.path == '/api/contact' or self.path == '/api/contact/':
            self.handle_contact_api()
        else:
            self.send_error(404, "Endpoint no encontrado")

    def handle_contact_api(self):
        client_ip = self.headers.get('X-Forwarded-For', self.client_address[0])
        if ',' in client_ip:
            client_ip = client_ip.split(',')[0].strip()

        # 1. Rate limiting (máximo 5 por hora por IP)
        if is_rate_limited(client_ip):
            print(f"[NEXO CONTACT] Límite de tasa alcanzado para IP {client_ip}")
            self.send_json_response(429, {
                "ok": False,
                "error": "Has superado el límite de 5 envíos por hora. Por favor, inténtalo más tarde."
            })
            return

        # 2. Leer cuerpo de la petición
        try:
            content_length = int(self.headers.get('Content-Length', 0))
            raw_body = self.rfile.read(content_length).decode('utf-8')
            data = json.loads(raw_body)
        except Exception:
            self.send_json_response(400, {"ok": False, "error": "Cuerpo de solicitud inválido."})
            return

        # 3. Honeypot check
        if data.get('website_url', '').strip():
            print("[NEXO CONTACT] Bot detectado por honeypot. Rechazo silencioso.")
            self.send_json_response(200, {"ok": True, "success": True, "message": "Mensaje procesado"})
            return

        # 4. Tiempo mínimo (3 segundos)
        loaded_at = data.get('form_loaded_at')
        now_ms = time.time() * 1000
        try:
            if not loaded_at or (now_ms - float(loaded_at) < 3000):
                print("[NEXO CONTACT] Envío demasiado rápido (< 3s).")
                self.send_json_response(400, {
                    "ok": False,
                    "error": "Envío demasiado rápido. Por favor, espera unos segundos antes de enviar."
                })
                return
        except ValueError:
            pass

        # 5. Sanitizar y validar
        recipient = data.get('recipient', 'general').lower()
        name = sanitize(data.get('name', ''))
        email = sanitize(data.get('email', ''))
        phone = sanitize(data.get('phone', ''))
        service = sanitize(data.get('service', 'Website'))
        message = sanitize(data.get('message', ''))
        source_page = sanitize(data.get('source_page', 'NEXO STUDIO'))
        accepted_privacy = (data.get('accepted_privacy') in (True, 'true', 'on', 1)) or (data.get('privacy') in (True, 'true', 'on', 1))

        if not name or len(name) > 100:
            self.send_json_response(400, {"ok": False, "error": "Por favor, introduce un nombre válido (máx. 100 caracteres)."})
            return
        if not email or '@' not in email or len(email) > 120:
            self.send_json_response(400, {"ok": False, "error": "Por favor, introduce un correo electrónico válido."})
            return
        if phone and len(phone) > 30:
            self.send_json_response(400, {"ok": False, "error": "El número de teléfono no debe exceder 30 caracteres."})
            return
        if not message or len(message) > 2000:
            self.send_json_response(400, {"ok": False, "error": "Por favor, introduce un mensaje (entre 1 y 2000 caracteres)."})
            return
        if not accepted_privacy:
            self.send_json_response(400, {"ok": False, "error": "Debes aceptar la política de privacidad."})
            return

        # 6. Destinatarios
        email_andrea = os.environ.get('CONTACT_TO_ANDREA', 'rudyandrearodrigueztorres@gmail.com')
        email_miguel = os.environ.get('CONTACT_TO_MIGUEL', 'miguelangel160397@gmail.com')

        if recipient == 'andrea':
            to_emails = [email_andrea]
            display_name = 'Andrea'
            visitor_confirm_who = 'Andrea'
            visitor_reply_to = email_andrea
        elif recipient == 'miguel':
            to_emails = [email_miguel]
            display_name = 'Miguel'
            visitor_confirm_who = 'Miguel'
            visitor_reply_to = email_miguel
        else:
            to_emails = [email_andrea, email_miguel]
            display_name = 'el equipo'
            visitor_confirm_who = 'nuestro equipo'
            visitor_reply_to = f"{email_andrea}, {email_miguel}"

        now_str = datetime.now().strftime("%d/%m/%Y, %H:%M:%S")

        # 7. Credenciales SMTP
        smtp_user = os.environ.get('SMTP_USER')
        smtp_pass = os.environ.get('SMTP_PASS')

        if not smtp_user or not smtp_pass:
            print("[NEXO CONTACT] ERROR CRÍTICO: Variables SMTP_USER y/o SMTP_PASS no definidas en el entorno.")
            print("[NEXO CONTACT] Por favor, crea un archivo .env o define SMTP_USER y SMTP_PASS.")
            self.send_json_response(500, {
                "ok": False,
                "error": "Algo salió mal. Inténtalo de nuevo en unos minutos."
            })
            return

        # 8. ENVÍO 1: Notificación al equipo
        team_subject = f"[NEXO STUDIO] Nuevo mensaje para {display_name} – {service}"
        team_text = f"""
NEXO STUDIO — NUEVO CONTACTO
==================================================
Destinatario: {display_name}
Servicio:     {service}
Fecha:        {now_str} (Madrid)
Origen:       {source_page}

DATOS DEL CONTACTO:
Nombre:       {name}
Correo:       {email}
Teléfono:     {phone if phone else 'No especificado'}

REGISTRO DE PRIVACIDAD Y CONSENTIMIENTO (RGPD / LOPDGDD):
Consentimiento aceptado: Sí
Fecha y hora:            {now_str}
Versión de la política:  v1.0 (28 de octubre de 2026)
Base jurídica:           Consentimiento del interesado (Art. 6.1.a RGPD)

MENSAJE:
{message}
==================================================
* Responde directamente a este correo para escribir a {name}.
        """.strip()

        team_html = f"""
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <style>
    body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #F3F1ED; color: #12180F; margin: 0; padding: 24px; }}
    .container {{ max-width: 600px; margin: 0 auto; background: #FFFFFF; border-radius: 20px; overflow: hidden; border: 1px solid rgba(18,24,15,0.12); box-shadow: 0 8px 24px rgba(18,24,15,0.06); }}
    .header {{ background-color: #12180F; padding: 24px 32px; color: #FFFFFF; border-bottom: 3px solid #E6FF00; }}
    .badge {{ background-color: #E6FF00; color: #12180F; font-size: 11px; font-weight: bold; padding: 4px 10px; border-radius: 9999px; text-transform: uppercase; display: inline-block; }}
    .title {{ font-size: 20px; font-weight: 800; margin: 12px 0 0 0; color: #FFFFFF; }}
    .body-content {{ padding: 32px; }}
    .meta-table {{ width: 100%; border-collapse: collapse; margin-bottom: 24px; }}
    .meta-table td {{ padding: 8px 0; border-bottom: 1px solid #F3F1ED; font-size: 14px; }}
    .label {{ color: #6E6B5E; font-weight: 600; width: 150px; }}
    .value {{ color: #12180F; font-weight: 600; }}
    .consent-box {{ background-color: #F3F1ED; border: 1px solid rgba(18,24,15,0.12); border-radius: 12px; padding: 14px 18px; margin-bottom: 24px; font-size: 13px; }}
    .message-box {{ background-color: #F8F7F4; padding: 20px; border-radius: 12px; font-size: 14px; line-height: 1.6; color: #3B4034; white-space: pre-wrap; border-left: 4px solid #E6FF00; }}
    .footer {{ padding: 18px 32px; background-color: #FAFAFA; font-size: 12px; color: #6E6B5E; border-top: 1px solid #EEEEEE; text-align: center; }}
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <span class="badge">NEXO STUDIO // NUEVO MENSAJE</span>
      <h1 class="title">Mensaje para {display_name}</h1>
    </div>
    <div class="body-content">
      <table class="meta-table">
        <tr><td class="label">Nombre:</td><td class="value">{name}</td></tr>
        <tr><td class="label">Correo:</td><td class="value">{email}</td></tr>
        <tr><td class="label">Teléfono:</td><td class="value">{phone if phone else 'No especificado'}</td></tr>
        <tr><td class="label">Servicio:</td><td class="value">{service}</td></tr>
        <tr><td class="label">Página de origen:</td><td class="value">{source_page}</td></tr>
        <tr><td class="label">Fecha y hora:</td><td class="value">{now_str}</td></tr>
      </table>

      <div class="consent-box">
        <div style="font-weight: 700; color: #12180F; margin-bottom: 6px; text-transform: uppercase; font-size: 11px; letter-spacing: 0.05em;">Registro de Consentimiento RGPD / LOPDGDD</div>
        <div style="color: #3B4034;">• <strong>Consentimiento aceptado:</strong> <span style="color: #2e8b57; font-weight: 700;">Sí</span></div>
        <div style="color: #3B4034;">• <strong>Fecha y hora:</strong> {now_str}</div>
        <div style="color: #3B4034;">• <strong>Versión de política:</strong> v1.0 (28 de octubre de 2026)</div>
        <div style="color: #6E6B5E; font-size: 11px; margin-top: 4px;">Base jurídica: Consentimiento expreso del interesado para atender la consulta.</div>
      </div>

      <div style="font-size: 12px; font-weight: 700; text-transform: uppercase; color: #6E6B5E; margin-bottom: 8px;">Mensaje recibido:</div>
      <div class="message-box">{message}</div>
    </div>
    <div class="footer">
      NEXO STUDIO • Responde a este correo para escribir directamente a {name}.
    </div>
  </div>
</body>
</html>
        """.strip()

        try:
            send_smtp_message(
                smtp_user=smtp_user,
                smtp_pass=smtp_pass,
                from_addr=f'"NEXO STUDIO Contacto" <{smtp_user}>',
                to_addrs=to_emails,
                reply_to=f'"{name}" <{email}>',
                subject=team_subject,
                text_content=team_text,
                html_content=team_html
            )
            print(f"[NEXO CONTACT] Notificación enviada con éxito al equipo ({display_name}).")
        except Exception as e:
            print(f"[NEXO CONTACT] Error enviando al equipo: {e}")
            self.send_json_response(500, {
                "ok": False,
                "error": "Algo salió mal. Inténtalo de nuevo en unos minutos."
            })
            return

        # 9. ENVÍO 2: Confirmación automática al visitante
        visitor_subject = "Recibimos tu mensaje – NEXO STUDIO"
        visitor_text = f"""
Hola {name}, ¡gracias por escribirnos!

{visitor_confirm_who} recibió tu mensaje y te responderá pronto.

RESUMEN DE TU MENSAJE:
----------------------------------------
Servicio de interés: {service}
Mensaje:
{message}
----------------------------------------

Si quieres añadir algo más, responde directamente a este correo.

NEXO STUDIO
Diseño web, identidad visual y estrategia digital
        """.strip()

        visitor_html = f"""
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
        Hola {name}, ¡gracias por escribirnos!
      </h1>
      <p style="font-size: 15px; line-height: 1.6; color: #3B4034; margin: 0 0 20px 0;">
        {visitor_confirm_who} recibió tu mensaje y te responderá pronto.
      </p>

      <!-- Resumen del mensaje -->
      <div style="background-color: #F8F7F4; border-left: 4px solid #E6FF00; border-radius: 12px; padding: 20px; margin: 24px 0;">
        <span style="font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; color: #6E6B5E; display: block; margin-bottom: 10px;">
          Resumen de tu mensaje
        </span>
        <p style="font-size: 13px; margin: 0 0 8px 0; color: #12180F;">
          <strong>Servicio:</strong> {service}
        </p>
        <p style="font-size: 13px; margin: 0; color: #12180F; white-space: pre-wrap; line-height: 1.5;">
          <strong>Mensaje:</strong><br>{message}
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
        """.strip()

        try:
            send_smtp_message(
                smtp_user=smtp_user,
                smtp_pass=smtp_pass,
                from_addr=f'"NEXO STUDIO" <{smtp_user}>',
                to_addrs=[email],
                reply_to=visitor_reply_to,
                subject=visitor_subject,
                text_content=visitor_text,
                html_content=visitor_html
            )
            print(f"[NEXO CONTACT] Confirmación enviada con éxito al visitante ({mask_email(email)}).")
        except Exception as e:
            print(f"[NEXO CONTACT] Aviso: Notificación al equipo enviada, pero falló confirmación al visitante ({mask_email(email)}): {e}")

        # 10. Respuesta exitosa confirmada
        self.send_json_response(200, {
            "ok": True,
            "success": True,
            "message": f"¡Listo! Recibimos tu mensaje y {visitor_confirm_who} te responderá pronto."
        })

def run_server(port=3000):
    server_address = ('', port)
    httpd = HTTPServer(server_address, NexoStudioHandler)
    print(f"NEXO STUDIO server running on http://localhost:{port}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nServidor detenido.")
        httpd.server_close()

if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 3000
    run_server(port)
